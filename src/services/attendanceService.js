import {
  AttendanceAdjustments,
  AttendanceRecords,
  EmployeeBiometrics,
  Employees,
  LeaveRequests,
  LeaveTypes,
  PublicHolidays,
  WorkShifts
} from '../models/raw.js';
import { enrichEmployees, employeeById } from './employeeService.js';
import { nextId } from '../utils/id.js';
import { idVariants } from '../utils/legacyId.js';
import { hydrateLegacyIds } from '../utils/legacySeedIdentity.js';
import { assertValid, isValidNumber } from '../utils/validation.js';

const TZ_OFFSET_MS = 7 * 60 * 60 * 1000;

export function vnNowParts(dateInput = new Date()) {
  const d = new Date(dateInput);
  const shifted = new Date(d.getTime() + TZ_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hours = shifted.getUTCHours();
  const minutes = shifted.getUTCMinutes();
  const seconds = shifted.getUTCSeconds();
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return { year, month, day, hours, minutes, seconds, dateStr, timeStr, minutesOfDay: hours * 60 + minutes };
}

export function timeToMinutes(hhmm = '08:00') {
  const [h, m] = String(hhmm || '08:00').split(':').map(Number);
  return (Number.isFinite(h) ? h : 8) * 60 + (Number.isFinite(m) ? m : 0);
}

const DEFAULT_SHIFTS = [
  {
    shift_code: 'HC',
    shift_name: 'Ca hành chính',
    start_time: '08:00',
    end_time: '17:30',
    break_start: '12:00',
    break_end: '13:30',
    work_hours: 8,
    grace_minutes: 10,
    overtime_multiplier: 1.5,
    is_default: 1,
    status: 'active'
  },
  {
    shift_code: 'SANG',
    shift_name: 'Ca sáng',
    start_time: '07:30',
    end_time: '11:30',
    break_start: null,
    break_end: null,
    work_hours: 4,
    grace_minutes: 10,
    overtime_multiplier: 1.5,
    is_default: 0,
    status: 'active'
  },
  {
    shift_code: 'CHIEU',
    shift_name: 'Ca chiều',
    start_time: '13:30',
    end_time: '17:30',
    break_start: null,
    break_end: null,
    work_hours: 4,
    grace_minutes: 10,
    overtime_multiplier: 1.5,
    is_default: 0,
    status: 'active'
  }
];

const DEFAULT_LEAVE_TYPES = [
  { leave_code: 'ANNUAL', leave_name: 'Nghỉ phép năm', is_paid: 1, annual_quota: 12, status: 'active' },
  { leave_code: 'SICK', leave_name: 'Nghỉ ốm', is_paid: 1, annual_quota: null, status: 'active' },
  { leave_code: 'UNPAID', leave_name: 'Nghỉ không lương', is_paid: 0, annual_quota: null, status: 'active' },
  { leave_code: 'MARRIAGE', leave_name: 'Nghỉ kết hôn', is_paid: 1, annual_quota: 3, status: 'active' },
  { leave_code: 'BEREAVEMENT', leave_name: 'Nghỉ tang', is_paid: 1, annual_quota: 3, status: 'active' },
  { leave_code: 'MATERNITY', leave_name: 'Nghỉ thai sản', is_paid: 0, annual_quota: null, status: 'active' }
];

let defaultsReadyPromise = null;
export async function ensureAttendanceDefaults() {
  if (defaultsReadyPromise) return defaultsReadyPromise;
  defaultsReadyPromise = (async () => {
    const [shiftCount, leaveCount, holidayCount] = await Promise.all([
      WorkShifts.countDocuments({}),
      LeaveTypes.countDocuments({}),
      PublicHolidays.countDocuments({})
    ]);

    if (shiftCount === 0) {
      for (const s of DEFAULT_SHIFTS) {
        await WorkShifts.create({ id: await nextId('work_shifts'), company_id: 1, ...s, created_at: new Date(), updated_at: new Date() });
      }
    } else {
      await WorkShifts.updateMany({ grace_minutes: { $gt: 10 } }, { $set: { grace_minutes: 10, updated_at: new Date() } });
    }

    if (leaveCount === 0) {
      for (const lt of DEFAULT_LEAVE_TYPES) {
        await LeaveTypes.create({ id: await nextId('leave_types'), company_id: 1, ...lt, created_at: new Date(), updated_at: new Date() });
      }
    } else {
      const existingTypes = await LeaveTypes.find({}).lean();
      for (const lt of existingTypes) {
        if (lt.id === undefined || lt.id === null) {
          await LeaveTypes.updateOne({ _id: lt._id }, { $set: { id: await nextId('leave_types') } });
        }
        if (lt.leave_code === 'SICK' && Number(lt.is_paid ?? 0) === 0) {
          await LeaveTypes.updateOne({ _id: lt._id }, { $set: { is_paid: 1, updated_at: new Date() } });
        }
      }
    }

    if (holidayCount === 0) {
      const yr = vnNowParts().year;
      const defaults = [
        { holiday_date: `${yr}-01-01`, holiday_name: 'Tết Dương lịch', is_paid: 1 },
        { holiday_date: `${yr}-04-30`, holiday_name: 'Ngày Giải phóng miền Nam', is_paid: 1 },
        { holiday_date: `${yr}-05-01`, holiday_name: 'Ngày Quốc tế Lao động', is_paid: 1 },
        { holiday_date: `${yr}-09-02`, holiday_name: 'Ngày Quốc khánh', is_paid: 1 },
        { holiday_date: `${yr}-09-03`, holiday_name: 'Nghỉ Quốc khánh (liền kề)', is_paid: 1 }
      ];
      for (const h of defaults) {
        await PublicHolidays.create({ id: await nextId('public_holidays'), company_id: 1, ...h, created_at: new Date() });
      }
    }
  })().catch(err => {
    defaultsReadyPromise = null;
    throw err;
  });
  return defaultsReadyPromise;
}

export function buildBadgeCode(employee) {
  const code = String(employee?.employee_code || '').trim();
  const id = employee?.id;
  return code || `TH79-NV${String(id || 0).padStart(4, '0')}`;
}

export function buildQrPayload(employee) {
  const code = buildBadgeCode(employee);
  return `TH79|EMP|${employee?.id ?? ''}|${code}`;
}

export function parseBadgeInput(rawInput = '') {
  const raw = String(rawInput || '').trim();
  if (!raw) return { code: '', employeeId: null };
  if (raw.startsWith('TH79|EMP|')) {
    const parts = raw.split('|');
    const parsedId = Number(parts[2]);
    return {
      code: (parts[3] || '').trim(),
      employeeId: Number.isFinite(parsedId) && parsedId > 0 ? parsedId : null
    };
  }
  return { code: raw, employeeId: null };
}

export function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || !vecA.length || vecA.length !== vecB.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < vecA.length; i++) {
    const a = Number(vecA[i]) || 0;
    const b = Number(vecB[i]) || 0;
    dot += a * b;
    magA += a * a;
    magB += b * b;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

export async function getActiveEmployeesEnriched() {
  const rows = await Employees.find({
    $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }],
    employment_status: { $nin: ['resigned', 'terminated', 'inactive'] }
  }).sort({ id: 1, employee_code: 1 }).lean();
  return enrichEmployees(rows);
}

export async function getBiometricMap() {
  const rows = await EmployeeBiometrics.find({}).lean();
  const map = new Map();
  for (const r of rows) {
    const empId = Number(r.employee_id);
    if (Number.isFinite(empId)) map.set(empId, r);
  }
  return map;
}

export async function enrollEmployeeBiometric({ employeeId, method, payload = {}, actorUserId = null }) {
  await ensureAttendanceDefaults();
  assertValid(isValidNumber(employeeId, { min: 1, integer: true }), 'Mã nhân viên không hợp lệ.');
  const employee = await employeeById(employeeId);
  if (!employee) {
    const err = new Error('Không tìm thấy nhân viên.');
    err.status = 404;
    throw err;
  }
  const empId = Number(employee.id);
  const existing = await EmployeeBiometrics.findOne({ employee_id: { $in: idVariants(empId) } }).lean();
  const now = new Date();
  const patch = { employee_id: empId, updated_at: now, updated_by: actorUserId };

  if (method === 'face') {
    assertValid(payload.descriptor === undefined || Array.isArray(payload.descriptor), 'Dữ liệu khuôn mặt không đúng định dạng.');
    const descriptor = Array.isArray(payload.descriptor) ? payload.descriptor : [];
    assertValid(descriptor.length <= 4096 && descriptor.every(value => typeof value === 'number' && Number.isFinite(value)), 'Vector khuôn mặt vượt giới hạn hoặc chứa dữ liệu không hợp lệ.');
    assertValid(descriptor.length >= 16 || Boolean(payload.face_image), 'Chưa thu được dữ liệu khuôn mặt hợp lệ.');
    if (payload.face_image !== undefined) assertValid(typeof payload.face_image === 'string' && payload.face_image.length <= 350000, 'Ảnh khuôn mặt vượt quá dung lượng cho phép.');
    if (payload.quality !== undefined) assertValid(isValidNumber(payload.quality, { min: 0, max: 100 }), 'Chất lượng ảnh khuôn mặt phải từ 0 đến 100.');
    patch.face_enrolled = true;
    patch.face_descriptor = descriptor;
    patch.face_image = payload.face_image ? String(payload.face_image).slice(0, 350000) : existing?.face_image || null;
    patch.face_quality = payload.quality === undefined ? 95 : Number(payload.quality);
    patch.face_enrolled_at = now;
  } else if (method === 'badge') {
    const badgeCode = String(payload.badge_code || buildBadgeCode(employee)).trim().toUpperCase();
    assertValid(/^[A-Z0-9._-]{3,40}$/.test(badgeCode), 'Mã thẻ phải có 3–40 ký tự chữ, số, dấu chấm, gạch ngang hoặc gạch dưới.');
    const duplicate = await EmployeeBiometrics.findOne({
      badge_code: badgeCode,
      employee_id: { $nin: idVariants(empId) }
    }).lean();
    if (duplicate) {
      const err = new Error(`Mã thẻ "${badgeCode}" đang được gán cho nhân viên khác.`);
      err.status = 409;
      throw err;
    }
    patch.badge_enrolled = true;
    patch.badge_code = badgeCode;
    patch.qr_payload = buildQrPayload({ ...employee, employee_code: badgeCode });
    if (payload.pin_code) {
      const pin = String(payload.pin_code).trim();
      assertValid(/^\d{4,12}$/.test(pin), 'Mã PIN phải gồm 4–12 chữ số.');
      patch.pin_code = pin;
    }
    patch.badge_enrolled_at = now;
  } else if (method === 'fingerprint') {
    const fingerLabel = String(payload.finger_label || 'Ngón trỏ phải').trim();
    const templateHash = String(payload.template_hash || `FP-${employee.employee_code}-${Date.now().toString(36)}`).trim();
    assertValid(['Ngón trỏ phải', 'Ngón cái phải', 'Ngón trỏ trái', 'Ngón cái trái'].includes(fingerLabel), 'Vị trí ngón tay không hợp lệ.');
    assertValid(templateHash.length >= 3 && templateHash.length <= 500, 'Mẫu vân tay không đúng định dạng.');
    if (payload.credential_id !== undefined) assertValid(typeof payload.credential_id === 'string' && payload.credential_id.length <= 2048, 'Mã xác thực vân tay không hợp lệ.');
    if (payload.public_key !== undefined) assertValid(typeof payload.public_key === 'string' && payload.public_key.length <= 8192, 'Khóa công khai vân tay không hợp lệ.');
    patch.fingerprint_enrolled = true;
    patch.fingerprint_label = fingerLabel;
    patch.fingerprint_template = templateHash;
    if (payload.credential_id) patch.webauthn_credential_id = String(payload.credential_id);
    if (payload.public_key) patch.webauthn_public_key = String(payload.public_key);
    patch.fingerprint_enrolled_at = now;
  } else {
    const err = new Error('Phương thức sinh trắc học không hợp lệ.');
    err.status = 400;
    throw err;
  }

  if (existing) {
    await EmployeeBiometrics.updateOne({ _id: existing._id }, { $set: patch });
  } else {
    await EmployeeBiometrics.create({
      id: await nextId('employee_biometrics'),
      badge_code: buildBadgeCode(employee),
      qr_payload: buildQrPayload(employee),
      badge_enrolled: true,
      face_enrolled: false,
      fingerprint_enrolled: false,
      ...patch,
      created_at: now
    });
  }

  return EmployeeBiometrics.findOne({ employee_id: { $in: idVariants(empId) } }).lean();
}

export async function verifyAndIdentify({ method, descriptor, badge_code, employee_id, fingerprint_token, credential_id, pin_code }) {
  await ensureAttendanceDefaults();
  assertValid(['face', 'badge', 'fingerprint', 'manual'].includes(method), 'Phương thức chấm công không hợp lệ.');
  if (employee_id !== undefined && employee_id !== null && employee_id !== '') {
    assertValid(isValidNumber(employee_id, { min: 1, integer: true }), 'Mã nhân viên không hợp lệ.');
  }
  const employees = await getActiveEmployeesEnriched();
  const empById = new Map(employees.map(e => [Number(e.id), e]));
  const bioRows = await EmployeeBiometrics.find({}).lean();
  const bioByEmpId = new Map(bioRows.map(b => [Number(b.employee_id), b]));

  if (method === 'face') {
    const enrolled = bioRows.filter(b => b.face_enrolled && Array.isArray(b.face_descriptor) && b.face_descriptor.length >= 16);
    assertValid(Array.isArray(descriptor) && descriptor.length >= 16 && descriptor.length <= 4096, 'Thiếu dữ liệu khuôn mặt hợp lệ từ camera.');
    assertValid(descriptor.every(value => typeof value === 'number' && Number.isFinite(value)), 'Vector khuôn mặt chứa giá trị không hợp lệ.');

    const compatibleTemplates = enrolled.filter(b => b.face_descriptor.length === descriptor.length);
    if (!compatibleTemplates.length) {
      const err = new Error(enrolled.length
        ? 'Mẫu khuôn mặt hiện có không tương thích. Vui lòng đăng ký lại mẫu khuôn mặt.'
        : 'Chưa có nhân viên nào đăng ký mẫu khuôn mặt. Vui lòng đăng ký mẫu khuôn mặt trước khi quét.');
      err.status = 400;
      throw err;
    }

    const targetPool = employee_id
      ? compatibleTemplates.filter(b => Number(b.employee_id) === Number(employee_id))
      : compatibleTemplates;

    let best = null;
    let bestScore = -1;
    for (const b of targetPool) {
      const sim = cosineSimilarity(descriptor, b.face_descriptor);
      if (sim > bestScore) {
        bestScore = sim;
        best = b;
      }
    }
    if (best && bestScore >= 0.78) {
      const emp = empById.get(Number(best.employee_id));
      if (emp) return { employee: emp, confidence: Math.round(Math.min(99.9, bestScore * 100) * 10) / 10, biometric: best };
    }

    const err = new Error(`Không nhận diện được khuôn mặt khớp (độ tương đồng cao nhất ${Math.max(0, Math.round(bestScore * 100))}%). Hãy thử điều chỉnh ánh sáng hoặc đăng ký lại mẫu.`);
    err.status = 404;
    throw err;
  }

  if (method === 'badge') {
    if (badge_code !== undefined && badge_code !== null) assertValid(typeof badge_code === 'string' && badge_code.length <= 250, 'Mã thẻ vượt quá độ dài cho phép.');
    if (pin_code) assertValid(/^\d{4,12}$/.test(String(pin_code)), 'Mã PIN phải gồm 4–12 chữ số.');
    const parsed = parseBadgeInput(badge_code);
    const searchCode = parsed.code.toUpperCase();
    let matchedEmp = parsed.employeeId ? empById.get(parsed.employeeId) : null;

    if (!matchedEmp && searchCode) {
      const bioMatch = bioRows.find(b =>
        String(b.badge_code || '').trim().toUpperCase() === searchCode ||
        String(b.qr_payload || '').trim().toUpperCase() === String(badge_code || '').trim().toUpperCase()
      );
      if (bioMatch) matchedEmp = empById.get(Number(bioMatch.employee_id));
    }

    if (!matchedEmp && searchCode) {
      matchedEmp = employees.find(e =>
        String(e.employee_code || '').trim().toUpperCase() === searchCode ||
        String(e.identity_number || '').trim().toUpperCase() === searchCode ||
        String(e.id) === searchCode
      );
    }

    if (!matchedEmp && employee_id) {
      matchedEmp = empById.get(Number(employee_id));
    }

    if (!matchedEmp) {
      const err = new Error('Không tìm thấy thẻ / bảng tên phù hợp trong hệ thống.');
      err.status = 404;
      throw err;
    }
    const bio = bioByEmpId.get(Number(matchedEmp.id)) || null;
    if (bio?.pin_code && pin_code && String(bio.pin_code) !== String(pin_code)) {
      const err = new Error('Mã PIN xác thực thẻ không đúng.');
      err.status = 401;
      throw err;
    }
    return { employee: matchedEmp, confidence: 100, biometric: bio };
  }

  if (method === 'fingerprint') {
    let matchedBio = null;
    if (credential_id) {
      matchedBio = bioRows.find(b => b.fingerprint_enrolled && b.webauthn_credential_id === String(credential_id));
    }
    if (!matchedBio && fingerprint_token) {
      matchedBio = bioRows.find(b => b.fingerprint_enrolled && b.fingerprint_template === String(fingerprint_token));
    }
    if (!matchedBio && employee_id) {
      matchedBio = bioRows.find(b => Number(b.employee_id) === Number(employee_id));
      if (!matchedBio || !matchedBio.fingerprint_enrolled) {
        const emp = empById.get(Number(employee_id));
        const err = new Error(`${emp?.full_name || 'Nhân viên'} chưa đăng ký mẫu dấu vân tay.`);
        err.status = 400;
        throw err;
      }
    }
    if (!matchedBio) {
      const err = new Error('Không nhận diện được dấu vân tay. Vui lòng chọn nhân viên hoặc đăng ký mẫu vân tay trước.');
      err.status = 404;
      throw err;
    }
    const emp = empById.get(Number(matchedBio.employee_id));
    if (!emp) {
      const err = new Error('Nhân viên không còn hoạt động.');
      err.status = 404;
      throw err;
    }
    return { employee: emp, confidence: 98.7, biometric: matchedBio };
  }

  if (method === 'manual') {
    const emp = empById.get(Number(employee_id));
    if (!emp) {
      const err = new Error('Không tìm thấy nhân viên.');
      err.status = 404;
      throw err;
    }
    return { employee: emp, confidence: 100, biometric: bioByEmpId.get(Number(emp.id)) || null };
  }

  const err = new Error('Phương thức chấm công không được hỗ trợ.');
  err.status = 400;
  throw err;
}

export async function resolveShift(shiftId = null) {
  await ensureAttendanceDefaults();
  const shifts = hydrateLegacyIds('work_shifts', await WorkShifts.find({ status: 'active' }).sort({ id: 1 }).lean());
  if (shiftId) {
    const found = shifts.find(s => Number(s.id) === Number(shiftId));
    if (found) return found;
  }
  return shifts.find(s => Number(s.is_default) === 1) || shifts[0];
}

export async function recordAttendancePunch({
  employee,
  method,
  confidence = 100,
  shiftId = null,
  action = 'auto',
  location = 'Văn phòng T&H 79',
  device = 'Web Kiosk',
  note = null,
  timestamp = new Date(),
  force = false
}) {
  assertValid(['auto', 'check_in', 'check_out'].includes(action), 'Thao tác chấm công không hợp lệ.');
  assertValid(['face', 'badge', 'fingerprint', 'manual'].includes(method), 'Phương thức chấm công không hợp lệ.');
  assertValid(typeof location === 'string' && location.length <= 160, 'Địa điểm chấm công không hợp lệ.');
  assertValid(typeof device === 'string' && device.length <= 120, 'Tên thiết bị chấm công không hợp lệ.');
  assertValid(note === null || typeof note === 'string' && note.length <= 1000, 'Ghi chú chấm công không được vượt quá 1.000 ký tự.');
  const shift = await resolveShift(shiftId);
  const punchDate = new Date(timestamp);
  const vn = vnNowParts(punchDate);
  const empId = Number(employee.id);

  const existing = await AttendanceRecords.findOne({
    employee_id: { $in: idVariants(empId) },
    work_date: vn.dateStr
  }).lean();

  const shiftStartMin = timeToMinutes(shift.start_time);
  const shiftEndMin = timeToMinutes(shift.end_time);
  const grace = Math.min(10, Math.max(0, Number(shift.grace_minutes ?? 10)));
  const shiftWorkHours = Number(shift.work_hours || 8);

  if (!existing && action !== 'check_out') {
    const lateMinutes = Math.max(0, vn.minutesOfDay - (shiftStartMin + grace));
    const status = lateMinutes > 0 ? 'late' : 'present';
    const id = await nextId('attendance_records');
    const row = {
      id,
      company_id: 1,
      employee_id: empId,
      shift_id: Number(shift.id),
      shift_name: shift.shift_name,
      work_date: vn.dateStr,
      check_in_time: punchDate,
      check_in_label: vn.timeStr.slice(0, 5),
      check_in_method: method,
      check_in_confidence: confidence,
      check_out_time: null,
      check_out_label: null,
      check_out_method: null,
      check_out_confidence: null,
      late_minutes: lateMinutes,
      early_leave_minutes: 0,
      worked_hours: 0,
      overtime_hours: 0,
      work_unit: 0.5,
      status,
      location,
      device,
      note,
      created_at: new Date(),
      updated_at: new Date()
    };
    await AttendanceRecords.create(row);
    return { action: 'check_in', record: row, shift, employee, confidence };
  }

  if (!existing && action === 'check_out') {
    const err = new Error(`${employee.full_name} chưa có lượt Check-in hôm nay.`);
    err.status = 400;
    throw err;
  }

  // Existing record today -> handle check_out (or check_in cooldown warning)
  if (action === 'check_in' && existing.check_in_time && !force) {
    const err = new Error(`${employee.full_name} đã Check-in lúc ${existing.check_in_label || vnNowParts(existing.check_in_time).timeStr.slice(0, 5)}.`);
    err.status = 409;
    throw err;
  }

  const lastPunch = existing.check_out_time || existing.check_in_time;
  if (!force && lastPunch && Math.abs(punchDate.getTime() - new Date(lastPunch).getTime()) < 30 * 1000) {
    const err = new Error(`${employee.full_name} vừa chấm công cách đây ít giây (${vnNowParts(lastPunch).timeStr.slice(0, 5)}).`);
    err.status = 409;
    throw err;
  }

  const checkInDate = existing.check_in_time ? new Date(existing.check_in_time) : punchDate;
  const breakMins = (shift.break_start && shift.break_end)
    ? Math.max(0, timeToMinutes(shift.break_end) - timeToMinutes(shift.break_start))
    : 0;
  const grossMins = Math.max(0, Math.round((punchDate.getTime() - checkInDate.getTime()) / 60000));
  const netMins = Math.max(0, grossMins - (grossMins > 300 ? breakMins : 0));
  const workedHours = Math.round((netMins / 60) * 100) / 100;

  const earlyLeaveMinutes = Math.max(0, shiftEndMin - vn.minutesOfDay);
  const overtimeHours = vn.minutesOfDay > shiftEndMin + 30
    ? Math.round(((vn.minutesOfDay - shiftEndMin) / 60) * 100) / 100
    : 0;

  let workUnit = 0;
  if (workedHours >= shiftWorkHours * 0.75) workUnit = 1;
  else if (workedHours >= shiftWorkHours * 0.35) workUnit = 0.5;
  else if (workedHours > 0) workUnit = 0.25;

  const isLate = Number(existing.late_minutes || 0) > 0;
  let status = 'present';
  if (isLate && earlyLeaveMinutes > 0) status = 'late_and_early';
  else if (isLate) status = 'late';
  else if (earlyLeaveMinutes > 0) status = 'early_leave';

  const patch = {
    check_out_time: punchDate,
    check_out_label: vn.timeStr.slice(0, 5),
    check_out_method: method,
    check_out_confidence: confidence,
    early_leave_minutes: earlyLeaveMinutes,
    worked_hours: workedHours,
    overtime_hours: overtimeHours,
    work_unit: workUnit,
    status,
    location,
    device,
    note: note || existing.note || null,
    updated_at: new Date()
  };

  await AttendanceRecords.updateOne({ _id: existing._id }, { $set: patch });
  const updated = { ...existing, ...patch };
  return { action: 'check_out', record: updated, shift, employee, confidence };
}

export async function buildMonthlyTimesheet({ month, year, branch_id = '', department_id = '', q = '' }) {
  await ensureAttendanceDefaults();
  const m = Math.max(1, Math.min(12, Number(month || vnNowParts().month)));
  const y = Number(year || vnNowParts().year);
  const daysInMonth = new Date(y, m, 0).getDate();
  const prefix = `${y}-${String(m).padStart(2, '0')}`;
  const startDateStr = `${prefix}-01`;
  const endDateStr = `${prefix}-${String(daysInMonth).padStart(2, '0')}`;

  let employees = await getActiveEmployeesEnriched();
  if (branch_id) employees = employees.filter(e => Number(e.branch_id) === Number(branch_id));
  if (department_id) employees = employees.filter(e => Number(e.department_id) === Number(department_id));
  if (q) {
    const needle = String(q).trim().toLowerCase();
    employees = employees.filter(e =>
      String(e.full_name || '').toLowerCase().includes(needle) ||
      String(e.employee_code || '').toLowerCase().includes(needle)
    );
  }

  const [initialRecords, approvedLeaves, holidays, leaveTypes] = await Promise.all([
    AttendanceRecords.find({ work_date: { $gte: startDateStr, $lte: endDateStr } }).lean(),
    LeaveRequests.find({
      status: 'approved',
      start_date: { $lte: endDateStr },
      end_date: { $gte: startDateStr }
    }).lean(),
    PublicHolidays.find({ holiday_date: { $gte: startDateStr, $lte: endDateStr } }).lean(),
    LeaveTypes.find({}).lean()
  ]);

  let syncedAny = 0;
  for (const leave of approvedLeaves) {
    if (leave.request_kind !== 'overtime') {
      syncedAny += await syncApprovedLeaveToAttendance(leave, leave.reviewed_by || null);
    }
  }
  const records = syncedAny > 0
    ? await AttendanceRecords.find({ work_date: { $gte: startDateStr, $lte: endDateStr } }).lean()
    : initialRecords;

  const leaveTypeMap = new Map(hydrateLegacyIds('leave_types', leaveTypes).map(t => [Number(t.id), t]));
  const holidayMap = new Map(holidays.map(h => [h.holiday_date, h]));

  // Count working weekdays (Mon-Sat excluding Sunday; Vietnam standard 26 days)
  let standardWorkDays = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow !== 0) standardWorkDays++;
  }

  const rows = employees.map(emp => {
    const empId = Number(emp.id);
    const empRecords = records.filter(r => Number(r.employee_id) === empId);
    const recByDate = new Map(empRecords.map(r => [r.work_date, r]));
    const empLeaves = approvedLeaves.filter(l => Number(l.employee_id) === empId);

    const days = {};
    let presentDays = 0;
    let paidLeaveDays = 0;
    let unpaidLeaveDays = 0;
    let holidayDays = 0;
    let lateCount = 0;
    let lateMinutesTotal = 0;
    let totalWorkUnits = 0;
    let overtimeHours = 0;
    let workedHoursTotal = 0;

    // Approved OT requests in month
    const approvedOtHours = empLeaves
      .filter(l => l.request_kind === 'overtime')
      .reduce((sum, l) => sum + (Number(l.hours) || 0), 0);

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${prefix}-${String(d).padStart(2, '0')}`;
      const dow = new Date(y, m - 1, d).getDay();
      const rec = recByDate.get(dateStr);
      const holiday = holidayMap.get(dateStr);
      const leave = empLeaves.find(l => l.request_kind !== 'overtime' && l.start_date <= dateStr && l.end_date >= dateStr);

      if (rec) {
        if (rec.status === 'paid_leave' || rec.status === 'unpaid_leave') {
          const isPaid = rec.status === 'paid_leave';
          const unit = isPaid ? Number(rec.work_unit ?? 1) : 0;
          if (isPaid) {
            paidLeaveDays++;
            totalWorkUnits += unit;
          } else {
            unpaidLeaveDays++;
          }
          days[d] = { type: rec.status, label: rec.check_out_label || (isPaid ? 'Nghỉ phép hưởng lương' : 'Nghỉ không lương'), unit };
        } else {
          const unit = Number(rec.work_unit ?? (rec.check_out_time ? 1 : 0.5));
          totalWorkUnits += unit;
          workedHoursTotal += Number(rec.worked_hours || 0);
          overtimeHours += Number(rec.overtime_hours || 0);
          if (rec.status === 'late' || rec.status === 'late_and_early' || Number(rec.late_minutes || 0) > 0) {
            lateCount++;
            lateMinutesTotal += Number(rec.late_minutes || 0);
          }
          presentDays++;
          days[d] = {
            type: rec.status || 'present',
            unit,
            check_in: rec.check_in_label,
            check_out: rec.check_out_label,
            late_minutes: rec.late_minutes || 0,
            overtime_hours: rec.overtime_hours || 0,
            method: rec.check_in_method
          };
        }
      } else if (holiday && dow !== 0 && Number(holiday.is_paid ?? 1) === 1) {
        holidayDays++;
        totalWorkUnits += 1;
        days[d] = { type: 'holiday', label: holiday.holiday_name, unit: 1 };
      } else if (leave && dow !== 0) {
        const lt = leaveTypeMap.get(Number(leave.leave_type_id));
        const isPaid = Number(lt?.is_paid ?? leave.is_paid ?? 0) === 1;
        if (isPaid) {
          paidLeaveDays++;
          totalWorkUnits += 1;
        } else {
          unpaidLeaveDays++;
        }
        days[d] = { type: isPaid ? 'paid_leave' : 'unpaid_leave', label: lt?.leave_name || 'Nghỉ phép', unit: isPaid ? 1 : 0 };
      } else if (dow === 0) {
        days[d] = { type: 'weekend', unit: 0 };
      } else {
        days[d] = { type: 'empty', unit: 0 };
      }
    }

    const totalOt = Math.round((overtimeHours + approvedOtHours) * 100) / 100;
    return {
      employee_id: empId,
      employee_code: emp.employee_code,
      full_name: emp.full_name,
      branch_name: emp.branch_name,
      department_name: emp.department_name,
      position_name: emp.position_name,
      employment_status: emp.employment_status,
      present_days: presentDays,
      paid_leave_days: paidLeaveDays,
      unpaid_leave_days: unpaidLeaveDays,
      holiday_days: holidayDays,
      late_count: lateCount,
      late_minutes_total: lateMinutesTotal,
      worked_hours: Math.round(workedHoursTotal * 100) / 100,
      overtime_hours: totalOt,
      payable_work_days: Math.round(totalWorkUnits * 100) / 100,
      days
    };
  });

  return { month: m, year: y, daysInMonth, standardWorkDays, items: rows };
}

export async function getEmployeeLeaveBalance(employeeId, year = vnNowParts().year) {
  await ensureAttendanceDefaults();
  const types = hydrateLegacyIds('leave_types', await LeaveTypes.find({ status: 'active' }).lean());
  const annualType = types.find(t => t.leave_code === 'ANNUAL') || types[0];
  const baseQuota = Number(annualType?.annual_quota || 12);
  const employee = await Employees.findOne({ id: { $in: idVariants(employeeId) }, deleted_at: null }).lean();

  let accruedMonths = baseQuota;
  if (employee?.join_date) {
    const jd = new Date(employee.join_date);
    if (!Number.isNaN(jd.getTime())) {
      const jy = jd.getUTCFullYear();
      const jm = jd.getUTCMonth() + 1;
      if (jy < year) accruedMonths = baseQuota;
      else if (jy === year) accruedMonths = Math.max(1, Math.min(baseQuota, 12 - jm + 1));
      else accruedMonths = 0;
    }
  }

  const isProbation = employee?.employment_status === 'probation';
  const quota = isProbation ? 0 : Math.min(baseQuota, accruedMonths);

  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const approved = await LeaveRequests.find({
    employee_id: { $in: idVariants(employeeId) },
    request_kind: { $ne: 'overtime' },
    status: 'approved',
    start_date: { $gte: start, $lte: end }
  }).lean();

  const usedAnnual = approved
    .filter(r => r.leave_code !== 'MATERNITY' && Number(r.is_paid ?? 0) === 1)
    .reduce((sum, r) => sum + (Number(r.total_days) || 0), 0);

  return {
    year,
    is_probation: isProbation,
    employment_status: employee?.employment_status || 'active',
    accrued_during_probation: isProbation ? accruedMonths : 0,
    annual_quota: quota,
    used_annual: usedAnnual,
    remaining_annual: Math.max(0, quota - usedAnnual),
    total_approved_requests: approved.length
  };
}

export async function syncApprovedLeaveToAttendance(leaveRequest, reviewerUserId = null) {
  if (!leaveRequest || leaveRequest.request_kind === 'overtime') return 0;
  await ensureAttendanceDefaults();
  const types = hydrateLegacyIds('leave_types', await LeaveTypes.find({}).lean());
  const lt = types.find(t => Number(t.id) === Number(leaveRequest.leave_type_id));
  const rawPaid = (leaveRequest.is_paid !== undefined && leaveRequest.is_paid !== null)
    ? leaveRequest.is_paid
    : (lt?.is_paid ?? 0);
  const isPaid = rawPaid === true || Number(rawPaid) === 1;

  const empId = Number(leaveRequest.employee_id);
  const toYmd = v => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
  const startStr = toYmd(leaveRequest.start_date);
  const endStr = toYmd(leaveRequest.end_date);
  const start = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T00:00:00Z`);
  if (!empId || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;

  const leaveLabel = lt?.leave_name || leaveRequest.leave_name || (isPaid ? 'Nghỉ phép hưởng lương' : 'Nghỉ không lương');
  let synced = 0;

  for (let cur = new Date(start); cur <= end; cur.setUTCDate(cur.getUTCDate() + 1)) {
    if (cur.getUTCDay() === 0) continue; // Skip Sunday
    const dateStr = cur.toISOString().slice(0, 10);
    const existing = await AttendanceRecords.findOne({
      employee_id: { $in: idVariants(empId) },
      work_date: dateStr
    }).lean();
    if (existing) continue;

    await AttendanceRecords.create({
      id: await nextId('attendance_records'),
      company_id: 1,
      employee_id: empId,
      work_date: dateStr,
      shift_id: null,
      check_in_time: null,
      check_out_time: null,
      check_in_label: 'Nghỉ phép',
      check_out_label: leaveLabel,
      check_in_method: 'leave',
      check_out_method: 'leave',
      check_in_confidence: null,
      worked_hours: isPaid ? 8 : 0,
      work_unit: isPaid ? 1 : 0,
      late_minutes: 0,
      early_leave_minutes: 0,
      overtime_hours: 0,
      status: isPaid ? 'paid_leave' : 'unpaid_leave',
      leave_request_id: Number(leaveRequest.id),
      notes: `Đơn nghỉ phép đã duyệt (#${leaveRequest.id}): ${leaveLabel}`,
      created_by: reviewerUserId || null,
      created_at: new Date(),
      updated_at: new Date()
    });
    synced++;
  }

  return synced;
}

export const syncApprovedPaidLeaveToAttendance = syncApprovedLeaveToAttendance;
