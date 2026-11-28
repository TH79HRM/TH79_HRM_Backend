import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import {
  AttendanceAdjustments,
  AttendanceRecords,
  EmployeeBiometrics,
  Employees,
  LeaveRequests,
  PublicHolidays,
  WorkShifts
} from '../models/raw.js';
import { anyPermission, can } from '../middleware/auth.js';
import { nextId } from '../utils/id.js';
import { audit } from '../services/auditService.js';
import { employeeById, enrichEmployees } from '../services/employeeService.js';
import { idVariants } from '../utils/legacyId.js';
import { assertValid, isValidDate, isValidNumber, isValidTime } from '../utils/validation.js';
import { hydrateLegacyIds } from '../utils/legacySeedIdentity.js';
import {
  buildBadgeCode,
  buildMonthlyTimesheet,
  buildQrPayload,
  enrollEmployeeBiometric,
  ensureAttendanceDefaults,
  getActiveEmployeesEnriched,
  getBiometricMap,
  getEmployeeLeaveBalance,
  recordAttendancePunch,
  resolveShift,
  timeToMinutes,
  verifyAndIdentify,
  vnNowParts
} from '../services/attendanceService.js';

const router = Router();
const attendanceImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const IMPORT_HEADERS = {
  employee_code: ['employee code', 'employee id', 'user id', 'user code', 'ma nv', 'ma nhan vien', 'pin'],
  work_date: ['work date', 'date', 'att date', 'ngay', 'ngay cong', 'ngay cham cong'],
  check_in_time: ['check in time', 'check in', 'checkin', 'first in', 'first check in', 'gio vao', 'vao ca'],
  check_out_time: ['check out time', 'check out', 'checkout', 'last out', 'last check out', 'gio ra', 'tan ca']
};

const normalizeImportHeader = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

function importValue(row, field) {
  if (row[field] !== undefined) return row[field];
  const aliases = new Set(IMPORT_HEADERS[field].map(normalizeImportHeader));
  const key = Object.keys(row).find(header => aliases.has(normalizeImportHeader(header)));
  return key ? row[key] : '';
}

function normalizeImportDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = String(value || '').trim();
  let parts = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (parts) return validImportDate(parts[1], parts[2], parts[3]);
  parts = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  return parts ? validImportDate(parts[3], parts[2], parts[1]) : null;
}

function validImportDate(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeImportTime(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getUTCHours()).padStart(2, '0')}:${String(value.getUTCMinutes()).padStart(2, '0')}`;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1) {
    const minutes = Math.round(value * 24 * 60) % (24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  const match = String(value || '').trim().match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    : null;
}

function normalizeImportRow(row, rowNumber, employeesByCode) {
  const employee_code = String(importValue(row, 'employee_code') || '').trim().toUpperCase();
  const work_date = normalizeImportDate(importValue(row, 'work_date'));
  const check_in_time = normalizeImportTime(importValue(row, 'check_in_time'));
  const rawCheckOut = importValue(row, 'check_out_time');
  const check_out_time = rawCheckOut === '' || rawCheckOut === null || rawCheckOut === undefined
    ? null
    : normalizeImportTime(rawCheckOut);
  const employee = employeesByCode.get(employee_code);
  const errors = [];
  if (!employee_code) errors.push('Thiếu mã nhân viên');
  else if (!employee) errors.push('Không tìm thấy mã nhân viên đang hoạt động');
  if (!work_date) errors.push('Ngày công không hợp lệ');
  if (!check_in_time) errors.push('Giờ vào không hợp lệ');
  if (rawCheckOut !== '' && rawCheckOut !== null && rawCheckOut !== undefined && !check_out_time) errors.push('Giờ ra không hợp lệ');

  return {
    row: rowNumber,
    employee_code,
    employee_id: employee ? Number(employee.id) : null,
    full_name: employee?.full_name || '',
    work_date,
    check_in_time,
    check_out_time,
    errors
  };
}

router.get('/overview', can('attendance.view'), async (req, res, next) => {
  try {
    await ensureAttendanceDefaults();
    const vn = vnNowParts();
    const date = String(req.query.date || vn.dateStr);

    const [employees, todayRecords, bioRows, shifts, pendingLeaves, pendingAdjustments, approvedLeavesToday] = await Promise.all([
      getActiveEmployeesEnriched(),
      AttendanceRecords.find({ work_date: date }).sort({ updated_at: -1, id: -1 }).lean(),
      EmployeeBiometrics.find({}).lean(),
      WorkShifts.find({ status: 'active' }).sort({ id: 1 }).lean(),
      LeaveRequests.countDocuments({ status: 'pending' }),
      AttendanceAdjustments.countDocuments({ status: 'pending' }),
      LeaveRequests.find({ status: 'approved', request_kind: { $ne: 'overtime' }, start_date: { $lte: date }, end_date: { $gte: date } }).lean()
    ]);

    const empMap = new Map(employees.map(e => [Number(e.id), e]));
    const isLeaveRec = r => r.status === 'paid_leave' || r.status === 'unpaid_leave';
    const workRecords = todayRecords.filter(r => !isLeaveRec(r));
    const checkedInIds = new Set(workRecords.map(r => Number(r.employee_id)));
    const onLeaveIds = new Set([
      ...approvedLeavesToday.map(l => Number(l.employee_id)),
      ...todayRecords.filter(isLeaveRec).map(r => Number(r.employee_id))
    ]);

    const lateCount = workRecords.filter(r => r.status === 'late' || r.status === 'late_and_early' || Number(r.late_minutes || 0) > 0).length;
    const checkedOutCount = workRecords.filter(r => Boolean(r.check_out_time)).length;
    const faceEnrolled = bioRows.filter(b => b.face_enrolled).length;
    const fingerprintEnrolled = bioRows.filter(b => b.fingerprint_enrolled).length;

    const methodStats = workRecords.reduce((acc, r) => {
      const m = r.check_in_method || 'manual';
      acc[m] = (acc[m] || 0) + 1;
      return acc;
    }, { face: 0, badge: 0, fingerprint: 0, manual: 0 });

    res.json({
      date,
      stats: {
        total_employees: employees.length,
        checked_in: checkedInIds.size,
        on_time: Math.max(0, checkedInIds.size - lateCount),
        late: lateCount,
        checked_out: checkedOutCount,
        on_leave: onLeaveIds.size,
        absent_or_pending: Math.max(0, employees.length - checkedInIds.size - onLeaveIds.size),
        face_enrolled: faceEnrolled,
        fingerprint_enrolled: fingerprintEnrolled,
        badge_enrolled: employees.length,
        pending_requests: pendingLeaves + pendingAdjustments
      },
      methodStats,
      shifts: hydrateLegacyIds('work_shifts', shifts),
      recentRecords: todayRecords.slice(0, 20).map(r => ({
        ...r,
        employee: empMap.get(Number(r.employee_id)) || null
      }))
    });
  } catch (error) { next(error); }
});

// ==================== SHIFTS ====================
router.get('/shifts', can('attendance.view'), async (req, res, next) => {
  try {
    await ensureAttendanceDefaults();
    const shifts = hydrateLegacyIds('work_shifts', await WorkShifts.find({}).sort({ id: 1 }).lean());
    res.json({ items: shifts });
  } catch (error) { next(error); }
});

router.post('/shifts', can('attendance.manage'), async (req, res, next) => {
  try {
    await ensureAttendanceDefaults();
    const code = String(req.body.shift_code || '').trim().toUpperCase();
    const name = String(req.body.shift_name || '').trim();
    assertValid(/^[A-Z0-9_-]{2,30}$/.test(code), 'Mã ca phải có 2–30 ký tự chữ, số, gạch ngang hoặc gạch dưới.');
    assertValid(name.length >= 2 && name.length <= 100, 'Tên ca phải có từ 2 đến 100 ký tự.');
    validateShiftTimes(req.body);
    assertValid(['active', 'inactive'].includes(req.body.status || 'active'), 'Trạng thái ca làm việc không hợp lệ.');
    assertValid([true, false, 0, 1, '0', '1'].includes(req.body.is_default ?? false), 'Cấu hình ca mặc định không hợp lệ.');
    const dup = await WorkShifts.findOne({ shift_code: code }).lean();
    if (dup) return res.status(409).json({ message: `Mã ca "${code}" đã tồn tại.` });

    const id = await nextId('work_shifts');
    if (Number(req.body.is_default) === 1 || req.body.is_default === true) {
      await WorkShifts.updateMany({}, { $set: { is_default: 0 } });
    }
    const row = {
      id,
      company_id: 1,
      shift_code: code,
      shift_name: name,
      start_time: String(req.body.start_time || '08:00'),
      end_time: String(req.body.end_time || '17:30'),
      break_start: req.body.break_start || null,
      break_end: req.body.break_end || null,
      work_hours: Number(req.body.work_hours || 8),
      grace_minutes: Number(req.body.grace_minutes ?? 10),
      overtime_multiplier: Number(req.body.overtime_multiplier || 1.5),
      is_default: req.body.is_default ? 1 : 0,
      status: req.body.status === 'inactive' ? 'inactive' : 'active',
      created_at: new Date(),
      updated_at: new Date()
    };
    await WorkShifts.create(row);
    await audit(req, { module: 'attendance', action: 'create_shift', recordType: 'work_shift', recordId: id, description: `Tạo ca làm việc: ${name}`, newValues: row });
    res.status(201).json(row);
  } catch (error) { next(error); }
});

router.put('/shifts/:id', can('attendance.manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await WorkShifts.findOne({ id: { $in: idVariants(id) } }).lean();
    if (!existing) return res.status(404).json({ message: 'Không tìm thấy ca làm việc.' });
    validateShiftTimes({ ...existing, ...req.body });
    if (req.body.shift_name !== undefined) {
      const name = String(req.body.shift_name).trim();
      assertValid(name.length >= 2 && name.length <= 100, 'Tên ca phải có từ 2 đến 100 ký tự.');
    }
    if (req.body.status !== undefined) assertValid(['active', 'inactive'].includes(req.body.status), 'Trạng thái ca làm việc không hợp lệ.');
    if (req.body.is_default !== undefined) {
      assertValid([true, false, 0, 1, '0', '1'].includes(req.body.is_default), 'Cấu hình ca mặc định không hợp lệ.');
    }
    if (req.body.is_default) await WorkShifts.updateMany({}, { $set: { is_default: 0 } });

    const patch = {
      shift_name: String(req.body.shift_name || existing.shift_name).trim(),
      start_time: String(req.body.start_time || existing.start_time),
      end_time: String(req.body.end_time || existing.end_time),
      break_start: req.body.break_start ?? existing.break_start,
      break_end: req.body.break_end ?? existing.break_end,
      work_hours: Number(req.body.work_hours ?? existing.work_hours),
      grace_minutes: Number(req.body.grace_minutes ?? existing.grace_minutes),
      overtime_multiplier: Number(req.body.overtime_multiplier ?? existing.overtime_multiplier),
      is_default: req.body.is_default ? 1 : Number(existing.is_default || 0),
      status: req.body.status || existing.status || 'active',
      updated_at: new Date()
    };
    await WorkShifts.updateOne({ _id: existing._id }, { $set: patch });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.delete('/shifts/:id', can('attendance.manage'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await WorkShifts.deleteOne({ id: { $in: idVariants(id) } });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ==================== HOLIDAYS ====================
router.get('/holidays', can('attendance.view'), async (req, res, next) => {
  try {
    await ensureAttendanceDefaults();
    const items = await PublicHolidays.find({}).sort({ holiday_date: 1 }).lean();
    res.json({ items });
  } catch (error) { next(error); }
});

router.post('/holidays', can('attendance.manage'), async (req, res, next) => {
  try {
    const holiday_date = String(req.body.holiday_date || '').slice(0, 10);
    const holiday_name = String(req.body.holiday_name || '').trim();
    assertValid(isValidDate(holiday_date), 'Ngày lễ không hợp lệ.');
    assertValid(holiday_name.length >= 2 && holiday_name.length <= 120, 'Tên ngày lễ phải có từ 2 đến 120 ký tự.');
    assertValid([0, 1, '0', '1', false, true].includes(req.body.is_paid ?? 1), 'Chế độ lương ngày lễ không hợp lệ.');
    const dup = await PublicHolidays.findOne({ holiday_date }).lean();
    if (dup) return res.status(409).json({ message: `Ngày lễ ${holiday_date} đã tồn tại.` });
    const row = { id: await nextId('public_holidays'), company_id: 1, holiday_date, holiday_name, is_paid: req.body.is_paid === 0 ? 0 : 1, created_at: new Date() };
    await PublicHolidays.create(row);
    res.status(201).json(row);
  } catch (error) { next(error); }
});

router.delete('/holidays/:id', can('attendance.manage'), async (req, res, next) => {
  try {
    await PublicHolidays.deleteOne({ id: { $in: idVariants(req.params.id) } });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ==================== BIOMETRICS & BADGES ====================
router.get('/biometrics', can('attendance.view'), async (req, res, next) => {
  try {
    await ensureAttendanceDefaults();
    const q = String(req.query.q || '').trim().toLowerCase();
    const [employees, bioMap] = await Promise.all([getActiveEmployeesEnriched(), getBiometricMap()]);

    const items = employees
      .filter(e => !q || String(e.full_name || '').toLowerCase().includes(q) || String(e.employee_code || '').toLowerCase().includes(q))
      .map(e => {
        const bio = bioMap.get(Number(e.id));
        const badgeCode = bio?.badge_code || buildBadgeCode(e);
        return {
          employee_id: Number(e.id),
          employee_code: e.employee_code,
          full_name: e.full_name,
          branch_name: e.branch_name,
          department_name: e.department_name,
          position_name: e.position_name,
          employment_status: e.employment_status,
          face_enrolled: Boolean(bio?.face_enrolled),
          face_image: bio?.face_image || null,
          face_quality: bio?.face_quality || null,
          face_enrolled_at: bio?.face_enrolled_at || null,
          badge_enrolled: bio ? Boolean(bio.badge_enrolled ?? true) : true,
          badge_code: badgeCode,
          qr_payload: bio?.qr_payload || buildQrPayload(e),
          fingerprint_enrolled: Boolean(bio?.fingerprint_enrolled),
          fingerprint_label: bio?.fingerprint_label || null,
          fingerprint_template: bio?.fingerprint_template || null,
          webauthn_credential_id: bio?.webauthn_credential_id || null,
          fingerprint_enrolled_at: bio?.fingerprint_enrolled_at || null
        };
      });

    res.json({ items });
  } catch (error) { next(error); }
});

router.post('/biometrics/enroll', anyPermission('attendance.manage', 'employee.update'), async (req, res, next) => {
  try {
    const { employee_id, method, ...payload } = req.body || {};
    const record = await enrollEmployeeBiometric({
      employeeId: employee_id,
      method,
      payload,
      actorUserId: req.auth?.user?.id || null
    });
    await audit(req, {
      module: 'attendance',
      action: `enroll_${method}`,
      recordType: 'employee_biometric',
      employeeId: Number(employee_id),
      description: `Đăng ký ${method} cho nhân viên #${employee_id}`
    });
    res.json({ ok: true, biometric: record, message: 'Đã lưu dữ liệu sinh trắc học / bảng tên.' });
  } catch (error) { next(error); }
});

router.delete('/biometrics/:employeeId/:method', can('attendance.manage'), async (req, res, next) => {
  try {
    const empId = Number(req.params.employeeId);
    const method = req.params.method;
    const existing = await EmployeeBiometrics.findOne({ employee_id: { $in: idVariants(empId) } }).lean();
    if (!existing) return res.json({ ok: true });

    const unsetPatch = {};
    if (method === 'face') {
      Object.assign(unsetPatch, { face_enrolled: false, face_descriptor: [], face_image: null, face_quality: null });
    } else if (method === 'fingerprint') {
      Object.assign(unsetPatch, { fingerprint_enrolled: false, fingerprint_label: null, fingerprint_template: null, webauthn_credential_id: null });
    }
    await EmployeeBiometrics.updateOne({ _id: existing._id }, { $set: unsetPatch });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// ==================== MULTI-MODAL SCAN (KIOSK + SELF CHECK-IN) ====================
router.post('/scan', async (req, res, next) => {
  try {
    const {
      method = 'badge',
      descriptor,
      badge_code,
      employee_id,
      fingerprint_token,
      credential_id,
      pin_code,
      shift_id,
      action = 'auto',
      location = 'Máy chấm công Kiosk T&H 79',
      device = 'Web Kiosk Terminal',
      note = null,
      force = false
    } = req.body || {};
    assertValid([true, false, 0, 1, '0', '1'].includes(force), 'Tùy chọn xác nhận chấm công không hợp lệ.');
    assertValid(['auto', 'check_in', 'check_out'].includes(action), 'Thao tác chấm công không hợp lệ.');
    if (shift_id !== undefined && shift_id !== null && shift_id !== '') {
      assertValid(isValidNumber(shift_id, { min: 1, integer: true }), 'Ca làm việc không hợp lệ.');
      assertValid(await WorkShifts.findOne({ id: { $in: idVariants(shift_id) }, status: 'active' }).lean(), 'Không tìm thấy ca làm việc đang hoạt động.');
    }

    // Only accounts with attendance.manage (or Super Admin) can punch attendance for other employees.
    // Regular employees can only check in/out for their own linked employee_id regardless of scan method.
    const canCheckInOthers = Boolean(
      req.auth?.isSuperAdmin ||
      req.auth?.permissions?.includes('*') ||
      req.auth?.permissions?.includes('attendance.manage')
    );
    const ownEmployeeId = req.auth?.user?.employee_id ? Number(req.auth.user.employee_id) : null;
    if (!canCheckInOthers) {
      if (!ownEmployeeId) {
        return res.status(403).json({ message: 'Tài khoản chưa được liên kết hồ sơ nhân viên để tự chấm công.' });
      }
      if (employee_id !== undefined && employee_id !== null && employee_id !== '' && Number(employee_id) !== ownEmployeeId) {
        return res.status(403).json({ message: 'Bạn chỉ được phép chấm công cho chính mình. Chỉ tài khoản được phân quyền quản lý mới có thể chấm công cho người khác.' });
      }
    }
    const targetEmployeeId = !canCheckInOthers ? ownEmployeeId : employee_id;

    const identified = await verifyAndIdentify({
      method,
      descriptor,
      badge_code,
      employee_id: targetEmployeeId,
      fingerprint_token,
      credential_id,
      pin_code
    });

    if (!canCheckInOthers && Number(identified.employee?.id) !== ownEmployeeId) {
      return res.status(403).json({ message: 'Mã định danh hoặc sinh trắc học không khớp với tài khoản đang đăng nhập. Bạn không thể chấm công thay người khác.' });
    }

    const result = await recordAttendancePunch({
      employee: identified.employee,
      method,
      confidence: identified.confidence,
      shiftId: shift_id,
      action,
      location,
      device,
      note,
      force: force === true || force === 1 || force === '1'
    });

    await audit(req, {
      module: 'attendance',
      action: result.action,
      recordType: 'attendance_record',
      recordId: result.record.id,
      employeeId: identified.employee.id,
      description: `${result.action === 'check_in' ? 'Check-in' : 'Check-out'} (${method}): ${identified.employee.full_name}`
    });

    res.json({
      ok: true,
      action: result.action,
      confidence: result.confidence,
      method,
      record: result.record,
      employee: identified.employee,
      shift: result.shift,
      message: result.action === 'check_in'
        ? `Check-in thành công lúc ${result.record.check_in_label} (${result.record.late_minutes > 0 ? `Muộn ${result.record.late_minutes} phút` : 'Đúng giờ'})`
        : `Check-out thành công lúc ${result.record.check_out_label} (${result.record.worked_hours} giờ làm)`
    });
  } catch (error) { next(error); }
});

// ==================== RECORDS & TIMESHEET ====================
router.get('/import/template', can('attendance.manage'), async (req, res) => {
  const ws = XLSX.utils.json_to_sheet([{
    employee_code: 'TH79-NV0001',
    work_date: '2026-11-25',
    check_in_time: '08:00',
    check_out_time: '17:00'
  }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'MayChamCong');
  res.setHeader('Content-Disposition', 'attachment; filename="TH79_Mau_Import_ChamCong.xlsx"');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .send(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
});

router.post('/import/preview', can('attendance.manage'), attendanceImportUpload.single('file'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ message: 'Chưa chọn file CSV/Excel.' });
  let rows;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!firstSheet) return res.status(400).json({ message: 'File không có trang tính dữ liệu.' });
    rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '', raw: true });
  } catch {
    return res.status(400).json({ message: 'Không đọc được file. Hãy dùng CSV, XLS hoặc XLSX.' });
  }
  const dataRows = rows.filter(row => Object.values(row).some(value => String(value ?? '').trim() !== ''));
  if (!dataRows.length) return res.status(400).json({ message: 'File không có dòng dữ liệu.' });
  if (dataRows.length > 2000) return res.status(400).json({ message: 'Mỗi lần chỉ nhập tối đa 2.000 dòng.' });

  const headers = Object.keys(dataRows[0]).map(normalizeImportHeader);
  const requiredFields = ['employee_code', 'work_date', 'check_in_time'];
  const missingFields = requiredFields.filter(field =>
    !headers.some(header => IMPORT_HEADERS[field].some(alias => normalizeImportHeader(alias) === header))
  );
  if (missingFields.length) {
    return res.status(400).json({
      message: 'Không nhận diện được cột bắt buộc. Hãy tải file mẫu và dùng các cột employee_code, work_date, check_in_time.'
    });
  }

  try {
    await ensureAttendanceDefaults();
    const employees = await getActiveEmployeesEnriched();
    const employeesByCode = new Map(employees.map(employee => [String(employee.employee_code || '').trim().toUpperCase(), employee]));
    const seen = new Set();
    const preview = [];
    for (const [index, rawRow] of dataRows.entries()) {
      const item = normalizeImportRow(rawRow, index + 2, employeesByCode);
      if (item.employee_id && item.work_date) {
        const key = `${item.employee_id}:${item.work_date}`;
        if (seen.has(key)) item.errors.push('Trùng nhân viên và ngày công trong file');
        seen.add(key);
        const existing = await AttendanceRecords.findOne({
          employee_id: { $in: idVariants(item.employee_id) },
          work_date: item.work_date
        }).lean();
        item.action = existing ? 'update' : 'create';
      } else {
        item.action = 'invalid';
      }
      preview.push(item);
    }

    res.json({
      preview,
      summary: {
        total: preview.length,
        valid: preview.filter(item => !item.errors.length).length,
        errors: preview.filter(item => item.errors.length).length,
        create: preview.filter(item => !item.errors.length && item.action === 'create').length,
        update: preview.filter(item => !item.errors.length && item.action === 'update').length
      }
    });
  } catch (error) { next(error); }
});

router.post('/import/confirm', can('attendance.manage'), async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ message: 'Không có dòng hợp lệ để nhập.' });
    if (rows.length > 2000) return res.status(400).json({ message: 'Mỗi lần chỉ nhập tối đa 2.000 dòng.' });

    await ensureAttendanceDefaults();
    const employees = await getActiveEmployeesEnriched();
    const employeesByCode = new Map(employees.map(employee => [String(employee.employee_code || '').trim().toUpperCase(), employee]));
    const validated = rows.map((row, index) => normalizeImportRow(row, Number(row.row) || index + 2, employeesByCode));
    const seen = new Set();
    for (const row of validated) {
      if (!row.employee_id || !row.work_date) continue;
      const key = `${row.employee_id}:${row.work_date}`;
      if (seen.has(key)) row.errors.push('Trùng nhân viên và ngày công trong file');
      seen.add(key);
    }
    if (validated.some(row => row.errors.length)) {
      return res.status(400).json({
        message: 'Dữ liệu đã thay đổi hoặc không hợp lệ. Hãy tải file lên và xem trước lại.',
        errors: validated.filter(row => row.errors.length).map(row => ({ row: row.row, errors: row.errors }))
      });
    }

    const shift = await resolveShift();
    if (!shift) return res.status(400).json({ message: 'Chưa cấu hình ca làm việc để ghi nhận dữ liệu.' });
    const shiftStart = timeToMinutes(shift.start_time);
    let shiftEnd = timeToMinutes(shift.end_time);
    if (shiftEnd <= shiftStart) shiftEnd += 24 * 60;
    let created = 0;
    let updated = 0;
    const errors = [];

    for (const row of validated) {
      try {
        const inMinutes = timeToMinutes(row.check_in_time);
        const outMinutes = row.check_out_time ? timeToMinutes(row.check_out_time) : null;
        const outElapsed = outMinutes === null ? null : (outMinutes < inMinutes ? outMinutes + 24 * 60 : outMinutes);
        const breakStart = shift.break_start ? timeToMinutes(shift.break_start) : null;
        let breakEnd = shift.break_end ? timeToMinutes(shift.break_end) : null;
        if (breakStart !== null && breakEnd !== null && breakEnd <= breakStart) breakEnd += 24 * 60;
        const breakMinutes = outElapsed !== null && breakStart !== null && breakEnd !== null
          ? Math.max(0, Math.min(outElapsed, breakEnd) - Math.max(inMinutes, breakStart))
          : 0;
        const grossMinutes = outElapsed === null ? 0 : Math.max(0, outElapsed - inMinutes);
        const workedMinutes = Math.max(0, grossMinutes - breakMinutes);
        const worked_hours = Math.round((workedMinutes / 60) * 100) / 100;
        const grace = Math.min(10, Math.max(0, Number(shift.grace_minutes ?? 10)));
        const late_minutes = Math.max(0, inMinutes - shiftStart - grace);
        const early_leave_minutes = outElapsed === null ? 0 : Math.max(0, shiftEnd - outElapsed);
        const overtime_hours = outElapsed === null
          ? 0
          : Math.round((Math.max(0, outElapsed - shiftEnd) / 60) * 100) / 100;
        const status = late_minutes && early_leave_minutes ? 'late_and_early'
          : late_minutes ? 'late'
            : early_leave_minutes ? 'early_leave' : 'present';
        const checkInDate = new Date(`${row.work_date}T${row.check_in_time}:00+07:00`);
        const checkOutDate = row.check_out_time
          ? new Date(new Date(`${row.work_date}T${row.check_out_time}:00+07:00`).getTime() + (outMinutes < inMinutes ? 24 * 60 * 60 * 1000 : 0))
          : null;
        const existing = await AttendanceRecords.findOne({
          employee_id: { $in: idVariants(row.employee_id) },
          work_date: row.work_date
        }).lean();
        const payload = {
          employee_id: row.employee_id,
          shift_id: Number(shift.id),
          shift_name: shift.shift_name,
          work_date: row.work_date,
          check_in_time: checkInDate,
          check_in_label: row.check_in_time,
          check_in_method: 'device',
          check_in_confidence: null,
          check_out_time: checkOutDate,
          check_out_label: row.check_out_time,
          check_out_method: row.check_out_time ? 'device' : null,
          check_out_confidence: null,
          late_minutes,
          early_leave_minutes,
          worked_hours,
          overtime_hours,
          work_unit: row.check_out_time ? (worked_hours >= 6 ? 1 : worked_hours >= 3 ? 0.5 : 0.25) : 0.5,
          status,
          location: 'Nhập file máy chấm công',
          note: 'Đã nhập từ file thiết bị chấm công',
          updated_at: new Date()
        };
        if (existing) {
          await AttendanceRecords.updateOne({ _id: existing._id }, { $set: payload });
          updated++;
        } else {
          await AttendanceRecords.create({
            id: await nextId('attendance_records'),
            company_id: 1,
            ...payload,
            created_at: new Date()
          });
          created++;
        }
      } catch (error) {
        errors.push({ row: row.row, message: error.message || 'Không thể ghi dòng này.' });
      }
    }

    if (created || updated) {
      await audit(req, {
        module: 'attendance',
        action: 'device_import',
        recordType: 'attendance_import',
        description: `Nhập file máy chấm công: ${created} mới, ${updated} cập nhật, ${errors.length} lỗi`,
        newValues: { created, updated, failed: errors.length }
      });
    }
    res.status(errors.length ? 207 : 200).json({ created, updated, errors });
  } catch (error) { next(error); }
});

router.get('/records', can('attendance.view'), async (req, res, next) => {
  try {
    await ensureAttendanceDefaults();
    const date = req.query.date ? String(req.query.date).slice(0, 10) : null;
    const month = req.query.month ? Number(req.query.month) : null;
    const year = req.query.year ? Number(req.query.year) : null;

    const filter = {};
    if (date) filter.work_date = date;
    else if (month && year) {
      const prefix = `${year}-${String(month).padStart(2, '0')}`;
      filter.work_date = { $gte: `${prefix}-01`, $lte: `${prefix}-31` };
    }
    if (req.query.employee_id) filter.employee_id = { $in: idVariants(req.query.employee_id) };
    if (req.query.method) filter.check_in_method = req.query.method;
    if (req.query.status) filter.status = req.query.status;

    const records = await AttendanceRecords.find(filter).sort({ work_date: -1, check_in_time: -1, id: -1 }).limit(300).lean();
    const employees = await getActiveEmployeesEnriched();
    const empMap = new Map(employees.map(e => [Number(e.id), e]));

    res.json({
      items: records.map(r => ({
        ...r,
        manage_id: r._id?.toString?.(),
        employee: empMap.get(Number(r.employee_id)) || null
      }))
    });
  } catch (error) { next(error); }
});

router.post('/records', can('attendance.manage'), async (req, res, next) => {
  try {
    await ensureAttendanceDefaults();
    const emp = await employeeById(req.body.employee_id);
    if (!emp) return res.status(404).json({ message: 'Không tìm thấy nhân viên.' });
    const work_date = String(req.body.work_date || '');
    const check_in_label = String(req.body.check_in_label || '');
    const check_out_label = req.body.check_out_label ? String(req.body.check_out_label) : null;
    assertValid(isValidDate(work_date), 'Ngày chấm công không hợp lệ.');
    assertValid(isValidTime(check_in_label), 'Giờ vào không hợp lệ.');
    if (check_out_label) {
      assertValid(isValidTime(check_out_label), 'Giờ ra không hợp lệ.');
      assertValid(check_out_label > check_in_label, 'Giờ ra phải sau giờ vào.');
    }
    const shiftId = Number(req.body.shift_id || 1);
    assertValid(Number.isSafeInteger(shiftId) && shiftId > 0, 'Ca làm việc không hợp lệ.');
    assertValid(await WorkShifts.findOne({ id: { $in: idVariants(shiftId) } }).lean(), 'Không tìm thấy ca làm việc.');
    if (req.body.status !== undefined) {
      assertValid(['present', 'late', 'early_leave', 'late_and_early', 'absent', 'leave', 'holiday'].includes(req.body.status), 'Trạng thái chấm công không hợp lệ.');
    }

    const inMin = timeToMinutes(check_in_label);
    const outMin = check_out_label ? timeToMinutes(check_out_label) : null;
    const late_minutes = Math.max(0, inMin - (8 * 60 + 10));
    const early_leave_minutes = outMin !== null ? Math.max(0, (17 * 60 + 30) - outMin) : 0;
    const grossMins = outMin !== null ? Math.max(0, outMin - inMin) : 0;
    const netMins = Math.max(0, grossMins - (grossMins > 300 ? 90 : 0));
    const worked_hours = Math.round((netMins / 60) * 100) / 100;
    const overtime_hours = outMin !== null && outMin > 18 * 60 ? Math.round(((outMin - (17 * 60 + 30)) / 60) * 100) / 100 : 0;
    const work_unit = check_out_label ? (worked_hours >= 6 ? 1 : worked_hours >= 3 ? 0.5 : 0.25) : 0.5;
    const status = req.body.status || (late_minutes > 0 ? (early_leave_minutes > 0 ? 'late_and_early' : 'late') : (early_leave_minutes > 0 ? 'early_leave' : 'present'));

    const empId = Number(emp.id);
    const existing = await AttendanceRecords.findOne({ employee_id: { $in: idVariants(empId) }, work_date }).lean();
    const payload = {
      employee_id: empId,
      shift_id: shiftId,
      shift_name: req.body.shift_name || 'Ca hành chính',
      work_date,
      check_in_time: new Date(`${work_date}T${check_in_label}:00+07:00`),
      check_in_label,
      check_in_method: req.body.method || 'manual',
      check_in_confidence: 100,
      check_out_time: check_out_label ? new Date(`${work_date}T${check_out_label}:00+07:00`) : null,
      check_out_label,
      check_out_method: check_out_label ? (req.body.method || 'manual') : null,
      check_out_confidence: check_out_label ? 100 : null,
      late_minutes,
      early_leave_minutes,
      worked_hours,
      overtime_hours,
      work_unit,
      status,
      location: req.body.location || 'Chấm công thủ công HR',
      note: req.body.note || null,
      updated_at: new Date()
    };

    if (existing) {
      await AttendanceRecords.updateOne({ _id: existing._id }, { $set: payload });
      await audit(req, { module: 'attendance', action: 'manual_update', recordType: 'attendance_record', recordId: existing.id, employeeId: empId, description: `Cập nhật công ngày ${work_date}: ${emp.full_name}` });
      return res.json({ ok: true, id: existing.id });
    }

    const id = await nextId('attendance_records');
    await AttendanceRecords.create({ id, company_id: 1, ...payload, created_at: new Date() });
    await audit(req, { module: 'attendance', action: 'manual_create', recordType: 'attendance_record', recordId: id, employeeId: empId, description: `Bổ sung công ngày ${work_date}: ${emp.full_name}` });
    res.status(201).json({ ok: true, id });
  } catch (error) { next(error); }
});

router.get('/timesheet', can('attendance.view'), async (req, res, next) => {
  try {
    const vn = vnNowParts();
    const result = await buildMonthlyTimesheet({
      month: req.query.month || vn.month,
      year: req.query.year || vn.year,
      branch_id: req.query.branch_id || '',
      department_id: req.query.department_id || '',
      q: req.query.q || ''
    });
    res.json(result);
  } catch (error) { next(error); }
});

router.get('/timesheet/export', can('attendance.view'), async (req, res, next) => {
  try {
    const vn = vnNowParts();
    const sheet = await buildMonthlyTimesheet({
      month: req.query.month || vn.month,
      year: req.query.year || vn.year,
      branch_id: req.query.branch_id || '',
      department_id: req.query.department_id || '',
      q: req.query.q || ''
    });
    const exportRows = sheet.items.map(r => {
      const base = {
        'Mã NV': r.employee_code,
        'Họ tên': r.full_name,
        'Chi nhánh': r.branch_name || '',
        'Chức vụ': r.position_name || '',
        'Ngày đi làm': r.present_days,
        'Nghỉ phép hưởng lương': r.paid_leave_days,
        'Nghỉ không lương': r.unpaid_leave_days,
        'Nghỉ lễ': r.holiday_days,
        'Số lần đi muộn': r.late_count,
        'Tổng phút muộn': r.late_minutes_total,
        'Giờ làm việc': r.worked_hours,
        'Giờ tăng ca (OT)': r.overtime_hours,
        'Tổng công tính lương': r.payable_work_days
      };
      for (let d = 1; d <= sheet.daysInMonth; d++) {
        const cell = r.days[d];
        base[`N${d}`] = cell?.unit ? (cell.check_in ? `${cell.unit} (${cell.check_in}-${cell.check_out || '?'})` : cell.unit) : (cell?.type === 'weekend' ? 'CN' : '');
      }
      return base;
    });
    const ws = XLSX.utils.json_to_sheet(exportRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Cong_${sheet.month}_${sheet.year}`);
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.setHeader('Content-Disposition', `attachment; filename="TH79_BangCong_${String(sheet.month).padStart(2, '0')}_${sheet.year}.xlsx"`);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
  } catch (error) { next(error); }
});

// ==================== EMPLOYEE SELF ATTENDANCE & ADJUSTMENTS ====================
router.get('/my', async (req, res, next) => {
  try {
    await ensureAttendanceDefaults();
    const empId = Number(req.auth?.user?.employee_id || 0);
    if (!empId) return res.status(404).json({ message: 'Tài khoản chưa liên kết hồ sơ nhân viên.' });

    const vn = vnNowParts();
    const month = Number(req.query.month || vn.month);
    const year = Number(req.query.year || vn.year);
    const prefix = `${year}-${String(month).padStart(2, '0')}`;

    const [employee, records, todayRecord, biometric, adjustments, leaveBalance, shifts] = await Promise.all([
      employeeById(empId),
      AttendanceRecords.find({ employee_id: { $in: idVariants(empId) }, work_date: { $gte: `${prefix}-01`, $lte: `${prefix}-31` } }).sort({ work_date: -1 }).lean(),
      AttendanceRecords.findOne({ employee_id: { $in: idVariants(empId) }, work_date: vn.dateStr }).lean(),
      EmployeeBiometrics.findOne({ employee_id: { $in: idVariants(empId) } }).lean(),
      AttendanceAdjustments.find({ employee_id: { $in: idVariants(empId) } }).sort({ id: -1 }).lean(),
      getEmployeeLeaveBalance(empId, year),
      WorkShifts.find({ status: 'active' }).sort({ id: 1 }).lean()
    ]);

    res.json({
      today: vn.dateStr,
      month,
      year,
      employee,
      todayRecord,
      records,
      biometric: biometric ? {
        ...biometric,
        badge_code: biometric.badge_code || buildBadgeCode(employee),
        qr_payload: biometric.qr_payload || buildQrPayload(employee)
      } : {
        face_enrolled: false,
        fingerprint_enrolled: false,
        badge_enrolled: true,
        badge_code: buildBadgeCode(employee),
        qr_payload: buildQrPayload(employee)
      },
      adjustments,
      leaveBalance,
      shifts: hydrateLegacyIds('work_shifts', shifts)
    });
  } catch (error) { next(error); }
});

router.get('/adjustments', anyPermission('attendance.view', 'employee.update'), async (req, res, next) => {
  try {
    const items = await AttendanceAdjustments.find({}).sort({ id: -1 }).lean();
    const emps = await enrichEmployees(await Employees.find({}).lean());
    const em = new Map(emps.map(e => [Number(e.id), e]));
    res.json({
      items: items.map(x => ({
        ...x,
        employee_name: em.get(Number(x.employee_id))?.full_name || '',
        employee_code: em.get(Number(x.employee_id))?.employee_code || ''
      }))
    });
  } catch (error) { next(error); }
});

router.post('/adjustments', async (req, res, next) => {
  try {
    const empId = Number(req.auth?.user?.employee_id || req.body.employee_id || 0);
    if (!empId) return res.status(400).json({ message: 'Tài khoản chưa liên kết nhân viên.' });
    const work_date = String(req.body.work_date || '');
    const requestedCheckIn = String(req.body.requested_check_in || '');
    const requestedCheckOut = String(req.body.requested_check_out || '');
    const reason = String(req.body.reason || '').trim();
    assertValid(isValidDate(work_date), 'Ngày cần giải trình không hợp lệ.');
    assertValid(isValidTime(requestedCheckIn), 'Giờ vào không hợp lệ.');
    assertValid(isValidTime(requestedCheckOut), 'Giờ ra không hợp lệ.');
    assertValid(requestedCheckOut > requestedCheckIn, 'Giờ ra phải sau giờ vào.');
    assertValid(reason.length >= 3 && reason.length <= 1000, 'Lý do phải có từ 3 đến 1.000 ký tự.');
    if (req.body.reason_type !== undefined) {
      assertValid(['forgot_checkin', 'forgot_checkout', 'device_error', 'business_trip', 'other'].includes(req.body.reason_type), 'Loại giải trình không hợp lệ.');
    }
    const id = await nextId('attendance_adjustments');
    const row = {
      id,
      company_id: 1,
      employee_id: empId,
      work_date,
      requested_check_in: requestedCheckIn,
      requested_check_out: requestedCheckOut,
      reason_type: req.body.reason_type || 'forgot_checkin',
      reason,
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
      created_at: new Date(),
      updated_at: new Date()
    };
    await AttendanceAdjustments.create(row);
    await audit(req, { module: 'attendance', action: 'adjustment_request', recordType: 'attendance_adjustment', recordId: id, employeeId: empId, description: `Gửi giải trình công ngày ${work_date}` });
    res.status(201).json(row);
  } catch (error) { next(error); }
});

router.post('/adjustments/:id/review', anyPermission('attendance.manage', 'employee.update'), async (req, res, next) => {
  try {
    assertValid(['approved', 'rejected'].includes(req.body.status), 'Trạng thái duyệt không hợp lệ.');
    const id = Number(req.params.id);
    const item = await AttendanceAdjustments.findOne({ id: { $in: idVariants(id) }, status: 'pending' }).lean();
    if (!item) return res.status(404).json({ message: 'Đơn giải trình không còn chờ duyệt.' });

    const status = req.body.status === 'approved' ? 'approved' : 'rejected';
    await AttendanceAdjustments.updateOne({ _id: item._id }, {
      $set: {
        status,
        reviewed_by: req.auth?.user?.id || null,
        reviewed_at: new Date(),
        review_note: req.body.review_note || null,
        updated_at: new Date()
      }
    });

    if (status === 'approved') {
      const empId = Number(item.employee_id);
      const checkIn = String(item.requested_check_in || '08:00').slice(0, 5);
      const checkOut = String(item.requested_check_out || '17:30').slice(0, 5);
      const existing = await AttendanceRecords.findOne({ employee_id: { $in: idVariants(empId) }, work_date: item.work_date }).lean();
      const inMin = timeToMinutes(checkIn);
      const outMin = timeToMinutes(checkOut);
      const grossMins = Math.max(0, outMin - inMin);
      const netMins = Math.max(0, grossMins - (grossMins > 300 ? 90 : 0));
      const worked_hours = Math.round((netMins / 60) * 100) / 100;
      const patch = {
        employee_id: empId,
        shift_id: 1,
        shift_name: 'Ca hành chính',
        work_date: item.work_date,
        check_in_time: new Date(`${item.work_date}T${checkIn}:00+07:00`),
        check_in_label: checkIn,
        check_in_method: 'adjustment',
        check_in_confidence: 100,
        check_out_time: new Date(`${item.work_date}T${checkOut}:00+07:00`),
        check_out_label: checkOut,
        check_out_method: 'adjustment',
        check_out_confidence: 100,
        late_minutes: 0,
        early_leave_minutes: 0,
        worked_hours,
        overtime_hours: 0,
        work_unit: worked_hours >= 6 ? 1 : 0.5,
        status: 'present',
        note: `Đã duyệt giải trình: ${item.reason}`,
        updated_at: new Date()
      };
      if (existing) await AttendanceRecords.updateOne({ _id: existing._id }, { $set: patch });
      else await AttendanceRecords.create({ id: await nextId('attendance_records'), company_id: 1, ...patch, created_at: new Date() });
    }

    await audit(req, { module: 'attendance', action: 'review_adjustment', recordType: 'attendance_adjustment', recordId: id, employeeId: item.employee_id, description: `${status === 'approved' ? 'Duyệt' : 'Từ chối'} giải trình công ngày ${item.work_date}` });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

function validateShiftTimes(shift) {
  assertValid(isValidTime(String(shift.start_time || '')), 'Giờ bắt đầu ca không hợp lệ.');
  assertValid(isValidTime(String(shift.end_time || '')), 'Giờ kết thúc ca không hợp lệ.');
  assertValid(shift.start_time !== shift.end_time, 'Giờ kết thúc phải khác giờ bắt đầu.');
  const hasBreakStart = Boolean(shift.break_start);
  const hasBreakEnd = Boolean(shift.break_end);
  assertValid(hasBreakStart === hasBreakEnd, 'Cần nhập cả giờ bắt đầu và kết thúc nghỉ giữa ca.');
  if (hasBreakStart) {
    assertValid(isValidTime(String(shift.break_start)), 'Giờ bắt đầu nghỉ giữa ca không hợp lệ.');
    assertValid(isValidTime(String(shift.break_end)), 'Giờ kết thúc nghỉ giữa ca không hợp lệ.');
    assertValid(shift.break_start !== shift.break_end, 'Giờ nghỉ giữa ca phải có khoảng thời gian hợp lệ.');
  }
  assertValid(isValidNumber(shift.work_hours, { min: 0.5, max: 24 }), 'Số giờ công phải từ 0,5 đến 24.');
  assertValid(Number(shift.work_hours) * 2 % 1 === 0, 'Số giờ công phải theo bước 0,5 giờ.');
  assertValid(isValidNumber(shift.grace_minutes, { min: 0, max: 10, integer: true }), 'Thời gian cho phép đi muộn tối đa 10 phút (0–10 phút).');
  assertValid(isValidNumber(shift.overtime_multiplier, { min: 1, max: 5 }), 'Hệ số OT phải từ 1 đến 5.');
}

export default router;
