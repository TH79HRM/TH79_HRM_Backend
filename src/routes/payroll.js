import { Router } from 'express';
import mongoose from 'mongoose';
import {
  PayrollPeriods, PayrollItems, PayrollSettings, Employees, SalaryProfiles, Companies
} from '../models/raw.js';
import { can } from '../middleware/auth.js';
import { nextId } from '../utils/id.js';
import { audit } from '../services/auditService.js';
import { enrichEmployees, employeeById } from '../services/employeeService.js';
import { idVariants } from '../utils/legacyId.js';
import { buildMonthlyTimesheet } from '../services/attendanceService.js';
import { assertValid, isValidDate, isValidNumber } from '../utils/validation.js';

const router = Router();

// Mặc định pháp lý cho kỳ tính thuế 2026. Kế toán có thể chỉnh trong UI và
// hệ thống lưu riêng tại payroll_settings để không phải sửa code khi quy định đổi.
const DEFAULT_SETTINGS = Object.freeze({
  company_id: 1,
  effective_year: 2026,
  bhxh_employee_rate: 8,
  bhyt_employee_rate: 1.5,
  bhtn_employee_rate: 1,
  personal_deduction: 15_500_000,
  dependent_deduction: 6_200_000,
  pit_brackets: [
    { up_to: 10_000_000, rate: 5 },
    { up_to: 30_000_000, rate: 10 },
    { up_to: 60_000_000, rate: 20 },
    { up_to: 100_000_000, rate: 30 },
    { up_to: null, rate: 35 }
  ],
  source_note: 'Mặc định 2026: BHXH 8%, BHYT 1,5%, BHTN 1%; giảm trừ bản thân 15,5 triệu và người phụ thuộc 6,2 triệu; PIT 5 bậc. Kế toán cần rà soát đối tượng/căn cứ đóng thực tế trước khi duyệt.'
});

router.get('/', can('payroll.view'), async (req, res, next) => {
  try {
    const periods = await PayrollPeriods.find({}).sort({ salary_year: -1, salary_month: -1, id: -1 }).lean();
    const periodIds = periods.flatMap(p => idVariants(p.id));
    const items = periodIds.length ? await PayrollItems.find({ payroll_period_id: { $in: periodIds } }).lean() : [];
    res.json({
      periods: periods.map(p => {
        const own = items.filter(x => Number(x.payroll_period_id) === Number(p.id));
        return { ...p, total_employee: own.length || Number(p.total_employee || 0), manage_id: p._id?.toString?.() };
      })
    });
  } catch (error) { next(error); }
});

router.get('/settings', can('payroll.view'), async (req, res, next) => {
  try { res.json(await getSettings()); } catch (error) { next(error); }
});

router.put('/settings', can('payroll.manage'), async (req, res, next) => {
  try {
    const current = await getSettings();
    validateSettingsInput(req.body);
    const row = sanitizeSettings(req.body, current);
    const existing = await PayrollSettings.findOne({ company_id: 1 });
    if (existing) await PayrollSettings.updateOne({ _id: existing._id }, { $set: { ...row, updated_at: new Date() } });
    else await PayrollSettings.create({ id: await nextId('payroll_settings'), company_id: 1, ...row, created_at: new Date(), updated_at: new Date() });
    await audit(req, { module: 'payroll', action: 'update_settings', recordType: 'payroll_settings', description: 'Cập nhật cấu hình khấu trừ tiền lương', newValues: row });
    res.json({ ok: true, settings: await getSettings(), message: 'Đã lưu cấu hình khấu trừ.' });
  } catch (error) { next(error); }
});

router.post('/periods', can('payroll.manage'), async (req, res, next) => {
  try {
    const month = Number(req.body.month);
    const year = Number(req.body.year);
    assertValid(isValidNumber(month, { min: 1, max: 12, integer: true }), 'Tháng kỳ lương phải là số nguyên từ 1 đến 12.');
    assertValid(isValidNumber(year, { min: 2000, max: 2200, integer: true }), 'Năm kỳ lương phải là số nguyên từ 2000 đến 2200.');
    const standardWorkDays = req.body.standard_work_days ?? 26;
    assertValid(isValidNumber(standardWorkDays, { min: 1, max: 31 }), 'Công chuẩn phải từ 1 đến 31 ngày.');
    assertValid(Number(standardWorkDays) * 2 % 1 === 0, 'Công chuẩn phải theo bước 0,5 ngày.');
    if (req.body.name) assertValid(String(req.body.name).trim().length <= 120, 'Tên kỳ lương không được vượt quá 120 ký tự.');
    if (req.body.salary_code) assertValid(/^[A-Za-z0-9._/-]{2,40}$/.test(String(req.body.salary_code).trim()), 'Mã kỳ lương chỉ được chứa chữ, số, dấu chấm, gạch chéo, gạch ngang hoặc gạch dưới.');
    assertValid(['draft', 'approved', 'paid', 'closed'].includes(req.body.status || 'draft'), 'Trạng thái kỳ lương không hợp lệ.');
    const existed = await PayrollPeriods.findOne({ salary_month: month, salary_year: year });
    if (existed) return res.status(409).json({ message: `Đã tồn tại kỳ lương ${month}/${year}.` });

    const id = await nextId('payroll_periods');
    const row = {
      id, company_id: 1,
      salary_code: req.body.salary_code || `TH79-${year}-${String(month).padStart(2, '0')}`,
      salary_month: month, salary_year: year,
      salary_name: req.body.name || `Bảng lương ${month}/${year}`,
      standard_work_days: Number(standardWorkDays),
      total_employee: 0, total_gross: 0, total_deduction: 0, total_net: 0,
      status: req.body.status || 'draft', approved_by: null, approved_at: null,
      note: req.body.note || null, created_at: new Date(), updated_at: new Date()
    };
    await PayrollPeriods.create(row);
    const sync = await syncEmployeesToPeriod(row, { refreshExisting: true });
    await recomputePeriodTotals(id);
    await audit(req, { module: 'payroll', action: 'create', recordType: 'payroll_period', recordId: id, description: row.salary_name, newValues: { ...row, auto_populated: sync.added } });
    res.status(201).json({ id, added: sync.added, refreshed: sync.refreshed, message: `Đã tạo kỳ lương và nạp ${sync.added} nhân viên.` });
  } catch (error) { next(error); }
});

router.get('/periods/:id', can('payroll.view'), async (req, res, next) => {
  try {
    const period = await findPeriod(req.params.id);
    if (!period) return res.status(404).json({ message: 'Không tìm thấy kỳ lương.' });
    const items = await PayrollItems.find({ payroll_period_id: { $in: idVariants(period.id) } }).sort({ id: 1 }).lean();
    const employeeIds = [...new Set(items.map(x => Number(x.employee_id)).filter(Number.isFinite))];
    const employees = await enrichEmployees(await Employees.find({ id: { $in: employeeIds } }).lean());
    const employeeMap = new Map(employees.map(e => [Number(e.id), e]));
    res.json({
      period: { ...period, manage_id: period._id?.toString?.() },
      items: items.map(x => ({ ...x, manage_id: x._id?.toString?.(), employee: employeeMap.get(Number(x.employee_id)) || null })),
      settings: await getSettings()
    });
  } catch (error) { next(error); }
});

router.post('/periods/:id/sync-employees', can('payroll.manage'), async (req, res, next) => {
  try {
    const period = await findPeriod(req.params.id);
    if (!period) return res.status(404).json({ message: 'Không tìm thấy kỳ lương.' });
    const sync = await syncEmployeesToPeriod(period, { refreshExisting: true });
    await recomputePeriodTotals(period.id);
    await audit(req, { module: 'payroll', action: 'sync_employees', recordType: 'payroll_period', recordId: period.id, description: `Đồng bộ kỳ lương ${period.salary_name}: ${sync.added} mới, ${sync.refreshed} cập nhật hồ sơ lương` });
    res.json({ ok: true, ...sync, message: `Đã đồng bộ: ${sync.added} nhân viên mới, ${sync.refreshed} hồ sơ lương được làm mới.` });
  } catch (error) { next(error); }
});

router.post('/periods/:id/sync-attendance', can('payroll.manage'), async (req, res, next) => {
  try {
    const period = await findPeriod(req.params.id);
    if (!period) return res.status(404).json({ message: 'Không tìm thấy kỳ lương.' });
    await syncEmployeesToPeriod(period, { refreshExisting: false });
    const sheet = await buildMonthlyTimesheet({ month: period.salary_month, year: period.salary_year });
    const sheetByEmp = new Map(sheet.items.map(x => [Number(x.employee_id), x]));
    const settings = await getSettings();
    const items = await PayrollItems.find({ payroll_period_id: { $in: idVariants(period.id) } }).lean();
    const employees = await enrichEmployees(await Employees.find({ id: { $in: items.map(x => Number(x.employee_id)).filter(Number.isFinite) } }).lean());
    const em = new Map(employees.map(x => [Number(x.id), x]));

    let updatedCount = 0;
    for (const item of items) {
      const ts = sheetByEmp.get(Number(item.employee_id));
      if (!ts) continue;
      const employee = em.get(Number(item.employee_id));
      const standard = positive(item.standard_work_days, period.standard_work_days || 26);
      const applied = nonNegative(item.applied_salary) || nonNegative(item.base_salary);
      const hourlyRate = applied > 0 ? applied / (standard * 8) : 0;
      const otHours = nonNegative(ts.overtime_hours);
      const otPay = roundMoney(otHours * hourlyRate * 1.5);
      const patch = {
        ...item,
        actual_work_days: ts.payable_work_days,
        overtime_hours: otHours,
        overtime_pay: otPay
      };
      const calculated = calculateItem(patch, employee, settings, false);
      await PayrollItems.updateOne({ _id: item._id }, { $set: { ...calculated, updated_at: new Date() } });
      updatedCount++;
    }
    await recomputePeriodTotals(period.id);
    await audit(req, { module: 'payroll', action: 'sync_attendance', recordType: 'payroll_period', recordId: period.id, description: `Đồng bộ bảng công tháng ${period.salary_month}/${period.salary_year} vào kỳ lương (${updatedCount} NV)` });
    res.json({ ok: true, updated: updatedCount, message: `Đã đồng bộ ngày công & OT từ Chấm công cho ${updatedCount} nhân viên.` });
  } catch (error) { next(error); }
});

router.post('/periods/:id/recalculate', can('payroll.manage'), async (req, res, next) => {
  try {
    const period = await findPeriod(req.params.id);
    if (!period) return res.status(404).json({ message: 'Không tìm thấy kỳ lương.' });
    const settings = await getSettings();
    const items = await PayrollItems.find({ payroll_period_id: { $in: idVariants(period.id) } }).lean();
    const employees = await enrichEmployees(await Employees.find({ id: { $in: items.map(x => Number(x.employee_id)).filter(Number.isFinite) } }).lean());
    const em = new Map(employees.map(x => [Number(x.id), x]));
    for (const item of items) {
      const employee = em.get(Number(item.employee_id));
      const calculated = calculateItem({ ...item, manual_deductions: false }, employee, settings, true);
      await PayrollItems.updateOne({ _id: item._id }, { $set: { ...calculated, manual_deductions: false, updated_at: new Date() } });
    }
    await recomputePeriodTotals(period.id);
    await audit(req, { module: 'payroll', action: 'recalculate', recordType: 'payroll_period', recordId: period.id, description: `Tính lại toàn bộ kỳ lương ${period.salary_name}` });
    res.json({ ok: true, message: 'Đã tính lại toàn bộ bảng lương theo cấu hình hiện tại.' });
  } catch (error) { next(error); }
});

router.put('/periods/:periodId/items/:itemId', can('payroll.manage'), async (req, res, next) => {
  try {
    const period = await findPeriod(req.params.periodId);
    if (!period) return res.status(404).json({ message: 'Không tìm thấy kỳ lương.' });
    const item = await findItem(req.params.itemId, period.id);
    if (!item) return res.status(404).json({ message: 'Không tìm thấy dòng lương.' });
    const employee = await employeeById(item.employee_id);
    const settings = await getSettings();

    const patch = { ...item };
    const numericFields = [
      'actual_work_days','overtime_hours','overtime_pay','bonus','allowance_total','other_income',
      'social_insurance_employee','health_insurance_employee','unemployment_insurance_employee',
      'personal_income_tax','other_deduction','tax_dependents'
    ];
    for (const k of numericFields) {
      if (!Object.prototype.hasOwnProperty.call(req.body, k)) continue;
      const max = k === 'overtime_hours' ? 744 : 1_000_000_000_000;
      assertValid(isValidNumber(req.body[k], { min: 0, max }), `${k} phải là số không âm hợp lệ${k === 'overtime_hours' ? ' và không vượt 744 giờ' : ''}.`);
      patch[k] = Number(req.body[k]);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'actual_work_days')) {
      assertValid(Number(req.body.actual_work_days) <= Number(item.standard_work_days || period.standard_work_days || 26) * 2, 'Ngày công không được vượt quá 2 lần công chuẩn.');
      assertValid(Number(req.body.actual_work_days) * 2 % 1 === 0, 'Ngày công phải theo bước 0,5 ngày.');
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'overtime_hours')) {
      assertValid(Number(req.body.overtime_hours) * 2 % 1 === 0, 'Giờ OT phải theo bước 0,5 giờ.');
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'tax_dependents')) {
      assertValid(isValidNumber(req.body.tax_dependents, { min: 0, max: 100, integer: true }), 'Số người phụ thuộc phải là số nguyên từ 0 đến 100.');
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'note')) {
      assertValid(req.body.note === null || typeof req.body.note === 'string' && req.body.note.length <= 2000, 'Ghi chú không được vượt quá 2.000 ký tự.');
      patch.note = req.body.note || null;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'manual_deductions')) {
      assertValid(typeof req.body.manual_deductions === 'boolean', 'Chế độ khấu trừ không hợp lệ.');
      patch.manual_deductions = req.body.manual_deductions;
    }

    // Khi người dùng trực tiếp sửa một khoản khấu trừ, giữ các số đó cho tới
    // khi họ bấm "Tính lại theo quy định".
    const touchedDeduction = ['social_insurance_employee','health_insurance_employee','unemployment_insurance_employee','personal_income_tax','other_deduction']
      .some(k => Object.prototype.hasOwnProperty.call(req.body, k));
    if (touchedDeduction) patch.manual_deductions = true;

    const calculated = calculateItem(patch, employee, settings, Boolean(req.body.force_auto));
    if (touchedDeduction) {
      const deductions = ['social_insurance_employee','health_insurance_employee','unemployment_insurance_employee','personal_income_tax','other_deduction']
        .reduce((sum, key) => sum + Number(calculated[key] || 0), 0);
      assertValid(deductions <= Number(calculated.gross_salary || 0), 'Tổng khấu trừ không được vượt quá lương Gross.');
    }
    await PayrollItems.updateOne({ _id: item._id }, { $set: { ...calculated, updated_at: new Date() } });
    await recomputePeriodTotals(period.id);
    const updated = await PayrollItems.findById(item._id).lean();
    res.json({ ok: true, item: { ...updated, manage_id: updated._id?.toString?.() }, message: 'Đã cập nhật dòng lương.' });
  } catch (error) { next(error); }
});

router.get('/periods/:periodId/items/:itemId/payslip', can('payroll.view'), async (req, res, next) => {
  try {
    const period = await findPeriod(req.params.periodId);
    if (!period) return res.status(404).json({ message: 'Không tìm thấy kỳ lương.' });
    const item = await findItem(req.params.itemId, period.id);
    if (!item) return res.status(404).json({ message: 'Không tìm thấy phiếu lương.' });
    const employee = await employeeById(item.employee_id);
    const company = await Companies.findOne({ $or: [{ id: 1 }, { company_id: 1 }] }).lean() || await Companies.findOne({}).lean() || {};
    res.json({
      period,
      item: { ...item, manage_id: item._id?.toString?.() },
      employee,
      company: {
        company_name: company.company_name || company.name || 'CÔNG TY TNHH ĐẦU TƯ T&H 79',
        tax_code: company.tax_code || company.mst || '0319573421',
        address: company.address || '33 Đường A8, P. Bình Tân, TP.HCM',
        phone: company.phone || '',
        email: company.email || '',
        website: company.website || 'daututh79.com'
      }
    });
  } catch (error) { next(error); }
});

router.get('/my', async (req, res, next) => {
  try {
    if (!req.auth.user.employee_id) return res.json({ items: [] });
    const items = await PayrollItems.find({ employee_id: { $in: idVariants(req.auth.user.employee_id) } }).sort({ id: -1 }).lean();
    res.json({ items });
  } catch (error) { next(error); }
});

async function syncEmployeesToPeriod(period, { refreshExisting = false } = {}) {
  const filter = {
    $and: [
      { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
      { employment_status: { $nin: ['inactive', 'resigned', 'terminated'] } }
    ]
  };
  const employees = await enrichEmployees(await Employees.find(filter).sort({ id: 1 }).lean());
  const existing = await PayrollItems.find({ payroll_period_id: { $in: idVariants(period.id) } }).lean();
  const existingByEmployee = new Map(existing.map(x => [Number(x.employee_id), x]));
  const profiles = await SalaryProfiles.find({}).sort({ effective_from: -1, id: -1 }).lean();
  const profileMap = new Map();
  for (const p of profiles) {
    const key = Number(p.employee_id);
    if (Number.isFinite(key) && !profileMap.has(key)) profileMap.set(key, p);
  }
  const settings = await getSettings();
  let added = 0, refreshed = 0;

  for (const employee of employees) {
    const employeeId = Number(employee.id);
    if (!Number.isFinite(employeeId)) continue;
    const profile = profileMap.get(employeeId) || {};
    const base = nonNegative(profile.base_salary);
    const probation = nonNegative(profile.probation_salary);
    const applied = employee.employment_status === 'probation' ? (probation || base) : base;
    const allowances = ['lunch_allowance','fuel_allowance','phone_allowance','attendance_allowance','other_allowance']
      .reduce((sum, k) => sum + nonNegative(profile[k]), 0);
    const salarySnapshot = {
      base_salary: base,
      probation_salary: probation,
      applied_salary: applied,
      insurance_salary: Object.prototype.hasOwnProperty.call(profile, 'insurance_salary')
        ? nonNegative(profile.insurance_salary)
        : base,
      allowance_total: allowances,
      tax_dependents: nonNegative(employee.tax_dependents)
    };

    const current = existingByEmployee.get(employeeId);
    if (current) {
      if (!refreshExisting) continue;
      const next = calculateItem({ ...current, ...salarySnapshot }, employee, settings, false);
      await PayrollItems.updateOne({ _id: current._id }, { $set: { ...salarySnapshot, ...next, updated_at: new Date() } });
      refreshed++;
      continue;
    }

    const row = {
      id: await nextId('payroll_items'), payroll_period_id: Number(period.id), employee_id: employeeId,
      standard_work_days: positive(period.standard_work_days, 26), actual_work_days: 0,
      overtime_hours: 0, overtime_pay: 0, bonus: 0, other_income: 0,
      ...salarySnapshot,
      salary_by_work_days: 0, gross_salary: 0,
      social_insurance_employee: 0, health_insurance_employee: 0, unemployment_insurance_employee: 0,
      personal_income_tax: 0, other_deduction: 0, total_deduction: 0, net_salary: 0,
      manual_deductions: false, note: null, created_at: new Date(), updated_at: new Date()
    };
    Object.assign(row, calculateItem(row, employee, settings, true));
    await PayrollItems.create(row);
    added++;
  }
  return { added, refreshed };
}

function calculateItem(item, employee, settings, forceAuto = false) {
  const standard = positive(item.standard_work_days, 26);
  const actual = Math.min(standard * 2, nonNegative(item.actual_work_days));
  const base = nonNegative(item.base_salary);
  const probation = nonNegative(item.probation_salary);
  const applied = nonNegative(item.applied_salary) || (employee?.employment_status === 'probation' ? (probation || base) : base);
  const salaryByDays = roundMoney(applied * actual / standard);
  const allowance = nonNegative(item.allowance_total);
  const overtimePay = nonNegative(item.overtime_pay);
  const bonus = nonNegative(item.bonus);
  const otherIncome = nonNegative(item.other_income);
  const gross = roundMoney(salaryByDays + allowance + overtimePay + bonus + otherIncome);
  const insuranceBase = nonNegative(item.insurance_salary) || base || applied;

  const preserveManual = Boolean(item.manual_deductions) && !forceAuto;
  let bhxh = nonNegative(item.social_insurance_employee);
  let bhyt = nonNegative(item.health_insurance_employee);
  let bhtn = nonNegative(item.unemployment_insurance_employee);
  let pit = nonNegative(item.personal_income_tax);
  const otherDeduction = nonNegative(item.other_deduction);
  const dependents = Math.floor(nonNegative(item.tax_dependents ?? employee?.tax_dependents));

  if (!preserveManual) {
    // Không tự trừ bảo hiểm khi kỳ này chưa nhập công. Đây là mặc định vận hành,
    // kế toán vẫn có thể nhập tay trong các trường hợp nghỉ không lương/truy thu.
    const hasWork = actual > 0;
    bhxh = hasWork ? roundMoney(insuranceBase * nonNegative(settings.bhxh_employee_rate) / 100) : 0;
    bhyt = hasWork ? roundMoney(insuranceBase * nonNegative(settings.bhyt_employee_rate) / 100) : 0;
    bhtn = hasWork ? roundMoney(insuranceBase * nonNegative(settings.bhtn_employee_rate) / 100) : 0;
    const taxable = Math.max(0, gross - bhxh - bhyt - bhtn - nonNegative(settings.personal_deduction) - dependents * nonNegative(settings.dependent_deduction));
    pit = calculatePit(taxable, settings.pit_brackets);
  }

  const totalDeduction = roundMoney(bhxh + bhyt + bhtn + pit + otherDeduction);
  const net = roundMoney(gross - totalDeduction);
  return {
    standard_work_days: standard, actual_work_days: actual,
    base_salary: base, probation_salary: probation, applied_salary: applied,
    insurance_salary: insuranceBase, salary_by_work_days: salaryByDays,
    allowance_total: allowance, overtime_pay: overtimePay, bonus, other_income: otherIncome,
    gross_salary: gross, social_insurance_employee: bhxh, health_insurance_employee: bhyt,
    unemployment_insurance_employee: bhtn, personal_income_tax: pit, other_deduction: otherDeduction,
    total_deduction: totalDeduction, net_salary: net, tax_dependents: dependents,
    manual_deductions: preserveManual
  };
}

function calculatePit(taxable, brackets = DEFAULT_SETTINGS.pit_brackets) {
  let tax = 0;
  let previous = 0;
  for (const b of brackets || []) {
    const upper = b.up_to === null || b.up_to === undefined || b.up_to === '' ? Infinity : nonNegative(b.up_to);
    const portion = Math.max(0, Math.min(taxable, upper) - previous);
    tax += portion * nonNegative(b.rate) / 100;
    if (taxable <= upper) break;
    previous = upper;
  }
  return roundMoney(tax);
}

async function recomputePeriodTotals(periodId) {
  const items = await PayrollItems.find({ payroll_period_id: { $in: idVariants(periodId) } }).lean();
  const totals = items.reduce((a, x) => {
    a.total_gross += nonNegative(x.gross_salary);
    a.total_deduction += nonNegative(x.total_deduction);
    a.total_net += nonNegative(x.net_salary);
    return a;
  }, { total_gross: 0, total_deduction: 0, total_net: 0 });
  await PayrollPeriods.updateOne({ id: { $in: idVariants(periodId) } }, { $set: {
    total_employee: items.length,
    total_gross: roundMoney(totals.total_gross), total_deduction: roundMoney(totals.total_deduction), total_net: roundMoney(totals.total_net), updated_at: new Date()
  } });
}

async function getSettings() {
  const row = await PayrollSettings.findOne({ company_id: 1 }).lean();
  return sanitizeSettings(row || {}, DEFAULT_SETTINGS);
}

function validateSettingsInput(body = {}) {
  for (const [field, label] of [
    ['bhxh_employee_rate', 'Tỷ lệ BHXH'], ['bhyt_employee_rate', 'Tỷ lệ BHYT'],
    ['bhtn_employee_rate', 'Tỷ lệ BHTN']
  ]) {
    if (body[field] !== undefined) assertValid(isValidNumber(body[field], { min: 0, max: 100 }), `${label} phải từ 0 đến 100%.`);
  }
  for (const [field, label] of [
    ['personal_deduction', 'Mức giảm trừ bản thân'], ['dependent_deduction', 'Mức giảm trừ người phụ thuộc']
  ]) {
    if (body[field] !== undefined) assertValid(isValidNumber(body[field], { min: 0, max: 1_000_000_000_000 }), `${label} phải là số không âm hợp lệ.`);
  }
  if (body.effective_year !== undefined) {
    assertValid(isValidNumber(body.effective_year, { min: 2000, max: 2200, integer: true }), 'Năm hiệu lực phải là số nguyên từ 2000 đến 2200.');
  }
  if (body.effective_from !== undefined) assertValid(isValidDate(body.effective_from), 'Ngày hiệu lực không hợp lệ.');
  if (body.version !== undefined) {
    const version = String(body.version).trim();
    assertValid(version.length >= 2 && version.length <= 60, 'Mã phiên bản phải có từ 2 đến 60 ký tự.');
  }
  if (body.pit_brackets !== undefined) {
    const brackets = body.pit_brackets;
    assertValid(Array.isArray(brackets) && brackets.length > 0 && brackets.length <= 10, 'Biểu thuế phải có từ 1 đến 10 bậc.');
    let previousLimit = 0;
    for (const [index, bracket] of brackets.entries()) {
      assertValid(isValidNumber(bracket?.rate, { min: 0, max: 100 }), `Thuế suất bậc ${index + 1} phải từ 0 đến 100%.`);
      if (index === brackets.length - 1) {
        assertValid(bracket.up_to === null || bracket.up_to === undefined || bracket.up_to === '', 'Bậc cuối của biểu thuế phải không giới hạn mức thu nhập.');
      } else {
        assertValid(isValidNumber(bracket?.up_to, { min: 1, max: 1_000_000_000_000 }), `Mức thu nhập bậc ${index + 1} không hợp lệ.`);
        assertValid(Number(bracket.up_to) > previousLimit, 'Các ngưỡng thu nhập trong biểu thuế phải tăng dần.');
        previousLimit = Number(bracket.up_to);
      }
    }
  }
}

function sanitizeSettings(body = {}, base = DEFAULT_SETTINGS) {
  const out = {
    company_id: 1,
    effective_year: Number(body.effective_year || base.effective_year || 2026),
    bhxh_employee_rate: nonNegative(body.bhxh_employee_rate ?? base.bhxh_employee_rate),
    bhyt_employee_rate: nonNegative(body.bhyt_employee_rate ?? base.bhyt_employee_rate),
    bhtn_employee_rate: nonNegative(body.bhtn_employee_rate ?? base.bhtn_employee_rate),
    personal_deduction: nonNegative(body.personal_deduction ?? base.personal_deduction),
    dependent_deduction: nonNegative(body.dependent_deduction ?? base.dependent_deduction),
    source_note: String(body.source_note || base.source_note || '').slice(0, 1000)
  };
  const inputBrackets = Array.isArray(body.pit_brackets) && body.pit_brackets.length ? body.pit_brackets : base.pit_brackets;
  out.pit_brackets = (inputBrackets || DEFAULT_SETTINGS.pit_brackets).slice(0, 10).map((b, index, arr) => ({
    up_to: b.up_to === null || b.up_to === undefined || b.up_to === '' || index === arr.length - 1 ? null : nonNegative(b.up_to),
    rate: nonNegative(b.rate)
  }));
  return out;
}

async function findPeriod(value) {
  if (mongoose.isValidObjectId(String(value))) {
    const byMongo = await PayrollPeriods.findById(value).lean();
    if (byMongo) return byMongo;
  }
  return PayrollPeriods.findOne({ id: { $in: idVariants(value) } }).lean();
}

async function findItem(value, periodId) {
  const periodFilter = { payroll_period_id: { $in: idVariants(periodId) } };
  if (mongoose.isValidObjectId(String(value))) {
    const byMongo = await PayrollItems.findOne({ _id: value, ...periodFilter }).lean();
    if (byMongo) return byMongo;
  }
  return PayrollItems.findOne({ id: { $in: idVariants(value) }, ...periodFilter }).lean();
}

function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function positive(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function roundMoney(value) { return Math.round(Number(value || 0)); }

export default router;
