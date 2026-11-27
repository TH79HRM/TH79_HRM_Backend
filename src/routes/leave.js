import { Router } from 'express';
import { AttendanceRecords, Employees, LeaveRequests, LeaveTypes } from '../models/raw.js';
import { anyPermission } from '../middleware/auth.js';
import { hasPermission } from '../services/permissionService.js';
import { nextId } from '../utils/id.js';
import { audit } from '../services/auditService.js';
import { enrichEmployees } from '../services/employeeService.js';
import { idVariants } from '../utils/legacyId.js';
import { hydrateLegacyIds } from '../utils/legacySeedIdentity.js';
import { ensureAttendanceDefaults, getEmployeeLeaveBalance, syncApprovedPaidLeaveToAttendance, vnNowParts } from '../services/attendanceService.js';
import { assertValid, isValidDate, isValidNumber } from '../utils/validation.js';

const router = Router();

router.get('/types', async (req, res, next) => {
  try {
    await ensureAttendanceDefaults();
    const types = hydrateLegacyIds('leave_types', await LeaveTypes.find({ status: 'active' }).sort({ id: 1 }).lean());
    res.json({ items: types });
  } catch (error) { next(error); }
});

router.get('/balance', async (req, res, next) => {
  try {
    const empId = Number(req.query.employee_id || req.auth?.user?.employee_id || 0);
    if (!empId) return res.json({ year: vnNowParts().year, annual_quota: 12, used_annual: 0, remaining_annual: 12 });
    const balance = await getEmployeeLeaveBalance(empId, Number(req.query.year || vnNowParts().year));
    res.json(balance);
  } catch (error) { next(error); }
});

router.get('/requests', async (req, res, next) => {
  try {
    await ensureAttendanceDefaults();
    const canManageAll = hasPermission(req.auth, 'attendance.view') || hasPermission(req.auth, 'attendance.manage') || hasPermission(req.auth, 'employee.update');
    const filter = {};
    if (!canManageAll) {
      const empId = Number(req.auth?.user?.employee_id || 0);
      if (!empId) return res.json({ items: [] });
      filter.employee_id = { $in: idVariants(empId) };
    } else if (req.query.employee_id) {
      filter.employee_id = { $in: idVariants(req.query.employee_id) };
    }
    if (req.query.status) filter.status = req.query.status;
    if (req.query.kind) filter.request_kind = req.query.kind;

    const [items, rawTypes, rawEmps] = await Promise.all([
      LeaveRequests.find(filter).sort({ id: -1, created_at: -1 }).lean(),
      LeaveTypes.find({}).lean(),
      Employees.find({ $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] }).lean()
    ]);

    const types = hydrateLegacyIds('leave_types', rawTypes);
    const typeMap = new Map(types.map(t => [Number(t.id), t]));
    const emps = await enrichEmployees(rawEmps);
    const empMap = new Map(emps.map(e => [Number(e.id), e]));

    res.json({
      items: items.map(r => {
        const emp = empMap.get(Number(r.employee_id));
        const lt = typeMap.get(Number(r.leave_type_id));
        return {
          ...r,
          employee_name: emp?.full_name || '',
          employee_code: emp?.employee_code || '',
          branch_name: emp?.branch_name || '',
          leave_name: r.request_kind === 'overtime' ? 'Đăng ký tăng ca (OT)' : (lt?.leave_name || r.leave_name || 'Nghỉ phép'),
          is_paid: r.request_kind === 'overtime' ? 1 : (lt?.is_paid ?? r.is_paid ?? 0)
        };
      })
    });
  } catch (error) { next(error); }
});

async function resolveLeavePricing({ kind, leaveType, employee, totalDays, startDate }) {
  if (kind === 'overtime') return { isPaid: 1, leaveName: 'Tăng ca (OT)' };
  if (leaveType?.leave_code === 'MATERNITY') return { isPaid: 0, leaveName: leaveType.leave_name };
  if (employee.employment_status === 'probation') {
    return { isPaid: 0, leaveName: `${leaveType.leave_name} (Thử việc)` };
  }
  if (Number(leaveType?.is_paid ?? 0) === 1) {
    const bal = await getEmployeeLeaveBalance(Number(employee.id), Number(startDate.slice(0, 4)));
    if (bal.remaining_annual >= totalDays) {
      return { isPaid: 1, leaveName: leaveType.leave_name };
    }
    return { isPaid: 0, leaveName: `${leaveType.leave_name} (Vượt quỹ phép)` };
  }
  return { isPaid: 0, leaveName: leaveType?.leave_name || 'Nghỉ không lương' };
}

router.post('/requests', async (req, res, next) => {
  try {
    await ensureAttendanceDefaults();
    const canManage = hasPermission(req.auth, 'attendance.manage') || hasPermission(req.auth, 'employee.update');
    const employeeId = Number((canManage && req.body.employee_id) ? req.body.employee_id : (req.auth?.user?.employee_id || 0));
    assertValid(Number.isSafeInteger(employeeId) && employeeId > 0, 'Vui lòng chọn nhân viên hoặc liên kết hồ sơ nhân viên.');
    const employee = await Employees.findOne({ id: { $in: idVariants(employeeId) }, deleted_at: null }).lean();
    assertValid(employee && ['probation', 'active'].includes(employee.employment_status), 'Nhân viên không tồn tại hoặc không còn làm việc.');

    const kind = req.body.request_kind;
    assertValid(['leave', 'overtime'].includes(kind), 'Loại yêu cầu không hợp lệ.');
    const start_date = String(req.body.start_date || '');
    const end_date = kind === 'overtime' ? start_date : String(req.body.end_date || '');
    assertValid(isValidDate(start_date), 'Ngày bắt đầu không hợp lệ.');
    assertValid(isValidDate(end_date), 'Ngày kết thúc không hợp lệ.');
    assertValid(start_date >= vnNowParts().dateStr, 'Không thể tạo đơn cho ngày trong quá khứ.');
    assertValid(end_date >= start_date, 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.');

    const types = hydrateLegacyIds('leave_types', await LeaveTypes.find({}).lean());
    const leaveType = kind === 'leave'
      ? types.find(t => Number(t.id) === Number(req.body.leave_type_id))
      : null;
    if (kind === 'leave') assertValid(Boolean(leaveType), 'Vui lòng chọn loại nghỉ phép hợp lệ.');

    const reason = String(req.body.reason || '').trim();
    assertValid(reason.length >= 3 && reason.length <= 1000, 'Lý do phải có từ 3 đến 1.000 ký tự.');
    if (kind === 'overtime') {
      assertValid(isValidNumber(req.body.hours, { min: 0.5, max: 12 }), 'Số giờ OT phải từ 0,5 đến 12 giờ.');
      assertValid(Number(req.body.hours) * 2 % 1 === 0, 'Số giờ OT phải theo bước 0,5 giờ.');
    }

    const totalDays = kind === 'overtime' ? 0
      : Math.round((new Date(`${end_date}T00:00:00Z`).getTime() - new Date(`${start_date}T00:00:00Z`).getTime()) / 86400000) + 1;

    const { isPaid: computedIsPaid, leaveName: computedLeaveName } = await resolveLeavePricing({
      kind, leaveType, employee, totalDays, startDate: start_date
    });

    const id = await nextId('leave_requests');
    const row = {
      id,
      company_id: 1,
      employee_id: employeeId,
      user_id: req.auth?.user?.id || null,
      request_kind: kind,
      leave_type_id: kind === 'overtime' ? null : Number(leaveType?.id || 1),
      leave_code: kind === 'overtime' ? 'OVERTIME' : (leaveType?.leave_code || 'ANNUAL'),
      leave_name: computedLeaveName,
      is_paid: computedIsPaid,
      start_date,
      end_date,
      total_days: kind === 'overtime' ? 0 : totalDays,
      hours: kind === 'overtime' ? Math.max(0.5, Number(req.body.hours || 2)) : 0,
      reason,
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
      created_at: new Date(),
      updated_at: new Date()
    };

    await LeaveRequests.create(row);
    await audit(req, {
      module: 'leave',
      action: 'create',
      recordType: 'leave_request',
      recordId: id,
      employeeId,
      description: `${kind === 'overtime' ? 'Đăng ký OT' : 'Đơn nghỉ phép'} (${start_date}${end_date !== start_date ? ' → ' + end_date : ''})`
    });

    res.status(201).json(row);
  } catch (error) { next(error); }
});

router.post('/requests/:id/review', anyPermission('attendance.manage', 'employee.update'), async (req, res, next) => {
  try {
    assertValid(['approved', 'rejected'].includes(req.body.status), 'Trạng thái duyệt không hợp lệ.');
    const id = Number(req.params.id);
    const existing = await LeaveRequests.findOne({ id: { $in: idVariants(id) }, status: 'pending' }).lean();
    if (!existing) return res.status(404).json({ message: 'Đơn không tồn tại hoặc đã được xử lý.' });

    const status = req.body.status;
    await LeaveRequests.updateOne({ _id: existing._id }, {
      $set: {
        status,
        reviewed_by: req.auth?.user?.id || null,
        reviewed_at: new Date(),
        review_note: req.body.review_note || null,
        updated_at: new Date()
      }
    });

    if (status === 'approved') {
      await syncApprovedPaidLeaveToAttendance(existing, req.auth?.user?.id || null);
    }

    await audit(req, {
      module: 'leave',
      action: 'review',
      recordType: 'leave_request',
      recordId: id,
      employeeId: existing.employee_id,
      description: `${status === 'approved' ? 'Duyệt' : 'Từ chối'} đơn ${existing.request_kind === 'overtime' ? 'tăng ca' : 'nghỉ phép'} #${id}`
    });

    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.put('/requests/:id', async (req, res, next) => {
  try {
    await ensureAttendanceDefaults();
    const id = Number(req.params.id);
    const existing = await LeaveRequests.findOne({ id: { $in: idVariants(id) } }).lean();
    if (!existing) return res.status(404).json({ message: 'Đơn không tồn tại.' });
    assertValid(existing.status === 'pending', 'Chỉ có thể chỉnh sửa đơn đang chờ duyệt.');

    const canManage = hasPermission(req.auth, 'attendance.manage') || hasPermission(req.auth, 'employee.update');
    const currentEmpId = Number(req.auth?.user?.employee_id || 0);
    assertValid(canManage || Number(existing.employee_id) === currentEmpId, 'Bạn không có quyền sửa đơn này.');

    const employee = await Employees.findOne({ id: { $in: idVariants(existing.employee_id) }, deleted_at: null }).lean();
    assertValid(employee && ['probation', 'active'].includes(employee.employment_status), 'Nhân viên không tồn tại hoặc không còn làm việc.');

    const kind = req.body.request_kind || existing.request_kind;
    assertValid(['leave', 'overtime'].includes(kind), 'Loại yêu cầu không hợp lệ.');
    const start_date = String(req.body.start_date || existing.start_date);
    const end_date = kind === 'overtime' ? start_date : String(req.body.end_date || existing.end_date);
    assertValid(isValidDate(start_date), 'Ngày bắt đầu không hợp lệ.');
    assertValid(isValidDate(end_date), 'Ngày kết thúc không hợp lệ.');
    assertValid(start_date >= vnNowParts().dateStr, 'Không thể chọn ngày trong quá khứ.');
    assertValid(end_date >= start_date, 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.');

    const types = hydrateLegacyIds('leave_types', await LeaveTypes.find({}).lean());
    const leaveType = kind === 'leave'
      ? types.find(t => Number(t.id) === Number(req.body.leave_type_id ?? existing.leave_type_id))
      : null;
    if (kind === 'leave') assertValid(Boolean(leaveType), 'Vui lòng chọn loại nghỉ phép hợp lệ.');

    const reason = String(req.body.reason ?? existing.reason ?? '').trim();
    assertValid(reason.length >= 3 && reason.length <= 1000, 'Lý do phải có từ 3 đến 1.000 ký tự.');
    if (kind === 'overtime') {
      assertValid(isValidNumber(req.body.hours, { min: 0.5, max: 12 }), 'Số giờ OT phải từ 0,5 đến 12 giờ.');
      assertValid(Number(req.body.hours) * 2 % 1 === 0, 'Số giờ OT phải theo bước 0,5 giờ.');
    }

    const totalDays = kind === 'overtime' ? 0
      : Math.round((new Date(`${end_date}T00:00:00Z`).getTime() - new Date(`${start_date}T00:00:00Z`).getTime()) / 86400000) + 1;

    const { isPaid, leaveName } = await resolveLeavePricing({
      kind, leaveType, employee, totalDays, startDate: start_date
    });

    const patch = {
      request_kind: kind,
      leave_type_id: kind === 'overtime' ? null : Number(leaveType?.id || 1),
      leave_code: kind === 'overtime' ? 'OVERTIME' : (leaveType?.leave_code || 'ANNUAL'),
      leave_name: leaveName,
      is_paid: isPaid,
      start_date,
      end_date,
      total_days: totalDays,
      hours: kind === 'overtime' ? Math.max(0.5, Number(req.body.hours || 2)) : 0,
      reason,
      updated_at: new Date()
    };

    await LeaveRequests.updateOne({ _id: existing._id }, { $set: patch });
    await audit(req, {
      module: 'leave',
      action: 'update',
      recordType: 'leave_request',
      recordId: id,
      employeeId: existing.employee_id,
      description: `Cập nhật đơn #${id} (${start_date}${end_date !== start_date ? ' → ' + end_date : ''})`
    });

    res.json({ ok: true, item: { ...existing, ...patch } });
  } catch (error) { next(error); }
});

router.delete('/requests/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await LeaveRequests.findOne({ id: { $in: idVariants(id) } }).lean();
    if (!existing) return res.status(404).json({ message: 'Đơn không tồn tại.' });

    const canManage = hasPermission(req.auth, 'attendance.manage') || hasPermission(req.auth, 'employee.update');
    const currentEmpId = Number(req.auth?.user?.employee_id || 0);
    assertValid(canManage || (Number(existing.employee_id) === currentEmpId && existing.status === 'pending'), 'Bạn không có quyền xóa đơn này.');

    await LeaveRequests.deleteOne({ _id: existing._id });
    await AttendanceRecords.deleteMany({ leave_request_id: { $in: idVariants(id) } });

    await audit(req, {
      module: 'leave',
      action: 'delete',
      recordType: 'leave_request',
      recordId: id,
      employeeId: existing.employee_id,
      description: `Xóa đơn ${existing.request_kind === 'overtime' ? 'tăng ca' : 'nghỉ phép'} #${id}`
    });

    res.json({ ok: true });
  } catch (error) { next(error); }
});

export default router;
