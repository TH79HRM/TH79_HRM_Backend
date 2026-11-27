import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import {
  Employees, Branches, Departments, Positions, ContractStatuses,
  EmployeeDocuments, EmployeeDocumentFiles, EmployeeDocumentReviews, DocumentTypes,
  EmployeeContracts, EmployeeContractFiles, ContractTypes, EmployeeStatusHistory, SalaryProfiles, EmployeeDecisions
} from '../models/raw.js';
import { can } from '../middleware/auth.js';
import { enrichEmployees, employeeById } from '../services/employeeService.js';
import { nextId } from '../utils/id.js';
import { audit } from '../services/auditService.js';
import { escapeRegex } from '../utils/normalize.js';
import { getByLegacyId, idVariants, mapByLegacyId } from '../utils/legacyId.js';
import { hydrateLegacyId, hydrateLegacyIds } from '../utils/legacySeedIdentity.js';
import { getDigitalDocumentCoverage, getRequiredDocumentTypes } from '../services/documentCoverageService.js';
import { ensureOrganizationIds } from '../services/organizationService.js';
import { hasPermission } from '../services/permissionService.js';
import { assertValid, isValidDate, isValidEmail, isValidNumber, isValidPhone } from '../utils/validation.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.get('/lookups', async (req, res, next) => {
  try {
    // Guarantees branch/department/position numeric ids are unique before they
    // are exposed as <option> values in employee forms.
    await ensureOrganizationIds();
    const [branches, departments, positions, statuses, documentTypes] = await Promise.all([
      Branches.find({ status: 'active' }).sort({ branch_name: 1 }).lean(),
      Departments.find({ status: 'active' }).sort({ department_name: 1 }).lean(),
      Positions.find({ status: 'active' }).sort({ position_name: 1 }).lean(),
      ContractStatuses.find({ is_active: 1 }).sort({ sort_order: 1 }).lean(),
      DocumentTypes.find({ status: 'active' }).sort({ id: 1 }).lean()
    ]);
    res.json({
      branches: hydrateLegacyIds('branches', branches),
      departments: hydrateLegacyIds('departments', departments),
      positions: hydrateLegacyIds('positions', positions),
      statuses: hydrateLegacyIds('contract_statuses', statuses),
      documentTypes: hydrateLegacyIds('document_types', documentTypes)
    });
  } catch (error) { next(error); }
});

router.get('/export', can('employee.view'), async (req, res) => {
  const rows = await enrichEmployees(await Employees.find({ deleted_at: null }).sort({ id: 1 }).lean());
  const data = rows.map(e => ({
    'Mã NV': e.employee_code,
    'Họ tên': e.full_name,
    'Giới tính': e.gender,
    'Ngày sinh': e.date_of_birth || '',
    'Điện thoại': e.phone || '',
    'Email': e.email || '',
    'CCCD': e.identity_number || '',
    'Chi nhánh': e.branch_name || '',
    'Phòng ban': e.department_name || '',
    'Chức vụ': e.position_name || '',
    'Ngày nhận việc': e.join_date || '',
    'Trạng thái': e.employment_status
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'NhanSu');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  res.setHeader('Content-Disposition', 'attachment; filename="TH79_NhanSu.xlsx"');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(buf);
});


router.get('/export/csv', can('employee.view'), async (req, res) => {
  const rows = await enrichEmployees(await Employees.find({ deleted_at: null }).sort({ id: 1 }).lean());
  const headers = ['Mã NV','Họ tên','Giới tính','Ngày sinh','Điện thoại','Email','CCCD','Chi nhánh','Phòng ban','Chức vụ','Ngày nhận việc','Trạng thái'];
  const escape = value => `"${String(value ?? '').replace(/"/g,'""')}"`;
  const lines = [headers.map(escape).join(',')];
  for (const e of rows) lines.push([
    e.employee_code,e.full_name,e.gender,e.date_of_birth||'',e.phone||'',e.email||'',e.identity_number||'',
    e.branch_name||'',e.department_name||'',e.position_name||'',e.join_date||'',e.employment_status
  ].map(escape).join(','));
  const csv='\uFEFF'+lines.join('\r\n');
  res.setHeader('Content-Disposition','attachment; filename="TH79_NhanSu.csv"');
  res.type('text/csv; charset=utf-8').send(csv);
});

router.get('/import/template', can('employee.import'), async (req, res) => {
  const ws = XLSX.utils.json_to_sheet([{
    'Mã NV': 'TH79-NV0065', 'Họ tên': 'Nguyễn Văn A', 'Giới tính': 'male',
    'Ngày sinh': '2000-01-01', 'Điện thoại': '0900000000', 'Email': 'a@example.com',
    'CCCD': '001200000001', 'Chi nhánh': 'Trụ sở chính', 'Phòng ban': 'Kỹ thuật',
    'Chức vụ': 'Nhân viên kỹ thuật', 'Ngày nhận việc': '2026-08-28', 'Trạng thái': 'probation'
  }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'NhanSu');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .send(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
});

router.post('/import/preview', can('employee.import'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Chưa chọn file Excel.' });
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const firstSheet = wb.Sheets[wb.SheetNames[0]];
    if (!firstSheet) return res.status(400).json({ message: 'File không có trang tính dữ liệu.' });
    rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
  } catch {
    return res.status(400).json({ message: 'Không đọc được file Excel. Hãy tải file mẫu và thử lại.' });
  }
  rows = rows.filter(row => Object.values(row).some(value => String(value ?? '').trim() !== ''));
  if (!rows.length) return res.status(400).json({ message: 'File không có dòng dữ liệu.' });
  if (rows.length > 2000) return res.status(400).json({ message: 'Mỗi lần chỉ được import tối đa 2.000 dòng.' });
  const [rawBranches, rawDepartments, rawPositions] = await Promise.all([
    Branches.find({}).lean(), Departments.find({}).lean(), Positions.find({}).lean()
  ]);
  const branches = hydrateLegacyIds('branches', rawBranches);
  const departments = hydrateLegacyIds('departments', rawDepartments);
  const positions = hydrateLegacyIds('positions', rawPositions);
  const preview = [];
  const seenCodes = new Set();
  const seenIdentities = new Set();
  for (const [i, r] of rows.entries()) {
    const code = String(r['Mã NV'] || r.employee_code || '').trim().toUpperCase();
    const name = String(r['Họ tên'] || r.full_name || '').trim();
    const rawDob = r['Ngày sinh'] || r.date_of_birth;
    const rawJoinDate = r['Ngày nhận việc'] || r.join_date;
    const existing = code ? await Employees.findOne({ employee_code: new RegExp(`^${escapeRegex(code)}$`, 'i'), deleted_at: null }).lean() : null;
    const data = {
      employee_code: code, full_name: name, gender: r['Giới tính'] || 'unknown',
      date_of_birth: toDate(rawDob), phone: String(r['Điện thoại'] || '').trim(),
      email: String(r['Email'] || '').trim().toLowerCase(), identity_number: String(r['CCCD'] || '').replace(/\s/g, ''),
      join_date: toDate(rawJoinDate), employment_status: r['Trạng thái'] || 'probation',
      branch_name: r['Chi nhánh'] || '', department_name: r['Phòng ban'] || '', position_name: r['Chức vụ'] || ''
    };
    const errors = collectEmployeeImportErrors(data);
    if (data.branch_name && !findName(branches, 'branch_name', data.branch_name)) errors.push('Chi nhánh không tồn tại');
    if (data.department_name && !findName(departments, 'department_name', data.department_name)) errors.push('Phòng ban không tồn tại');
    if (data.position_name && !findName(positions, 'position_name', data.position_name)) errors.push('Chức vụ không tồn tại');
    if (rawDob && !data.date_of_birth) errors.push('Ngày sinh không hợp lệ');
    if (rawJoinDate && !data.join_date) errors.push('Ngày nhận việc không hợp lệ');
    const normalizedCode = data.employee_code.toLowerCase();
    const normalizedIdentity = data.identity_number.replace(/\s/g, '');
    if (normalizedCode && seenCodes.has(normalizedCode)) errors.push('Mã nhân viên bị lặp trong file');
    if (normalizedIdentity && seenIdentities.has(normalizedIdentity)) errors.push('CCCD bị lặp trong file');
    if (normalizedCode) seenCodes.add(normalizedCode);
    if (normalizedIdentity) seenIdentities.add(normalizedIdentity);
    if (normalizedIdentity) {
      const filter = { identity_number: normalizedIdentity, deleted_at: null };
      if (existing) filter._id = { $ne: existing._id };
      if (await Employees.findOne(filter).lean()) errors.push('CCCD đã tồn tại trong hệ thống');
    }
    preview.push({
      row: i + 2,
      action: existing ? 'update' : 'create',
      employee_id: existing ? hydrateLegacyId('employees', existing).id : null,
      data,
      errors
    });
  }
  res.json({
    preview,
    summary: { total: preview.length, valid: preview.filter(x => !x.errors.length).length, errors: preview.filter(x => x.errors.length).length }
  });
});

router.post('/import/confirm', can('employee.import'), async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  assertValid(rows.length > 0 && rows.length <= 2000, 'Chọn từ 1 đến 2.000 dòng để import.');
  assertValid(rows.every(row => row && typeof row === 'object'), 'Danh sách dòng import không hợp lệ.');
  const [rawBranches, rawDepartments, rawPositions] = await Promise.all([
    Branches.find({}).lean(), Departments.find({}).lean(), Positions.find({}).lean()
  ]);
  const branches = hydrateLegacyIds('branches', rawBranches);
  const departments = hydrateLegacyIds('departments', rawDepartments);
  const positions = hydrateLegacyIds('positions', rawPositions);
  const prepared = [];
  const acceptedCodes = new Set();
  const acceptedIdentities = new Set();
  for (const r of rows.filter(x => !x.errors?.length)) {
    assertValid(r && r.data && typeof r.data === 'object', `Dòng ${r?.row || '?'} không có dữ liệu hợp lệ.`);
    const d = { ...r.data };
    if (typeof d.employee_code === 'string') d.employee_code = d.employee_code.trim().toUpperCase();
    if (typeof d.email === 'string') d.email = d.email.trim().toLowerCase();
    if (typeof d.identity_number === 'string') d.identity_number = d.identity_number.replace(/\s/g, '');
    d.branch_id = findName(branches, 'branch_name', d.branch_name);
    d.department_id = findName(departments, 'department_name', d.department_name);
    d.position_id = findName(positions, 'position_name', d.position_name);
    assertValid(!d.branch_name || d.branch_id, `Dòng ${r.row || '?'}: chi nhánh không tồn tại.`);
    assertValid(!d.department_name || d.department_id, `Dòng ${r.row || '?'}: phòng ban không tồn tại.`);
    assertValid(!d.position_name || d.position_id, `Dòng ${r.row || '?'}: chức vụ không tồn tại.`);
    delete d.branch_name; delete d.department_name; delete d.position_name;
    const targetByCode = d.employee_code
      ? await Employees.findOne({ employee_code: new RegExp(`^${escapeRegex(String(d.employee_code).trim())}$`, 'i'), deleted_at: null }).lean()
      : null;
    const target = targetByCode;
    const rowErrors = collectEmployeeImportErrors(d);
    assertValid(!rowErrors.length, `Dòng ${r.row || '?'}: ${rowErrors.join('; ')}.`);
    await validateEmployeePayload(d, target?._id || null);
    const code = String(d.employee_code || '').trim().toLowerCase();
    const identity = String(d.identity_number || '').replace(/\s/g, '');
    assertValid(!code || !acceptedCodes.has(code), `Dòng ${r.row || '?'}: mã nhân viên bị lặp trong file.`);
    assertValid(!identity || !acceptedIdentities.has(identity), `Dòng ${r.row || '?'}: CCCD bị lặp trong file.`);
    if (code) acceptedCodes.add(code);
    if (identity) acceptedIdentities.add(identity);
    prepared.push({ d, target, row: r.row });
  }
  assertValid(prepared.length > 0, 'Không có dòng hợp lệ để import.');
  let created = 0, updated = 0;
  for (const {d,target} of prepared) {
    if (target?._id) {
      await Employees.updateOne({ _id: target._id }, { $set: { ...d, updated_at: new Date() } });
      updated++;
    } else {
      d.id = await nextId('employees');
      d.company_id = 1;
      d.employee_code = d.employee_code || `TH79-NV${String(d.id).padStart(4, '0')}`;
      d.contract_status_id = d.employment_status === 'probation' ? 2 : 1;
      d.created_at = new Date(); d.updated_at = new Date(); d.deleted_at = null;
      await Employees.create(d); created++;
    }
  }
  await audit(req, { module: 'employees', action: 'import', description: `Import Excel: ${created} mới, ${updated} cập nhật`, newValues: { created, updated } });
  res.json({ created, updated });
});

router.get('/', can('employee.view'), async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(100, Math.max(10, Number(req.query.limit || 20)));
  const filter = { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] };
  if (req.query.status) filter.employment_status = req.query.status;
  if (req.query.branch_id) filter.branch_id = { $in: idVariants(req.query.branch_id) };
  if (req.query.department_id) filter.department_id = { $in: idVariants(req.query.department_id) };
  if (req.query.position_id) filter.position_id = { $in: idVariants(req.query.position_id) };
  if (req.query.q) {
    const rx = new RegExp(escapeRegex(req.query.q), 'i');
    filter.$and = [{ $or: [{ full_name: rx }, { employee_code: rx }, { phone: rx }, { email: rx }, { identity_number: rx }] }];
  }

  // Tình trạng hồ sơ được tính từ file số thực tế (Cloudinary hoặc file legacy),
  // không chỉ dựa vào document_status. Nhờ vậy bộ lọc phản ánh đúng file đã upload.
  const requiredTypes = await getRequiredDocumentTypes();
  const requiredIds = requiredTypes.map(x => Number(x.id)).filter(Number.isFinite);
  if (req.query.doc && requiredIds.length) {
    const candidates = await Employees.find(filter).lean();
    const coverage = await getDigitalDocumentCoverage(candidates, requiredTypes);
    const matchedMongoIds = candidates.filter(row => {
      const employee = hydrateLegacyId('employees', row);
      const count = coverage.presentByEmployee.get(String(Number(employee.id)))?.size || 0;
      return req.query.doc === 'missing' ? count < requiredIds.length
        : req.query.doc === 'complete' ? count >= requiredIds.length
        : true;
    }).map(row => row._id);
    filter._id = { $in: matchedMongoIds };
  }

  const [rows, total] = await Promise.all([
    Employees.find(filter).sort({ id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Employees.countDocuments(filter)
  ]);
  const items = await enrichEmployees(rows);
  const pageCoverage = await getDigitalDocumentCoverage(rows, requiredTypes);
  res.json({
    items: items.map(e => ({
      ...e,
      document_completed: pageCoverage.presentByEmployee.get(String(Number(e.id)))?.size || 0,
      document_total: requiredIds.length,
      document_complete: requiredIds.length > 0 && (pageCoverage.presentByEmployee.get(String(Number(e.id)))?.size || 0) >= requiredIds.length
    })),
    page, limit, total, pages: Math.ceil(total / limit)
  });
});

router.get('/:id', can('employee.view'), async (req, res) => {
  const employee = await employeeById(req.params.id);
  if (!employee) return res.status(404).json({ message: 'Không tìm thấy nhân viên.' });
  // Query related collections by the recovered legacy employee ID, not by a
  // possibly Mongo ObjectId URL. This prevents cross-employee data leaks and
  // incorrect document/history counts on migrated databases.
  const employeeIds = idVariants(employee.id);

  const [documents, contracts, history, types, contractTypes, salaryProfiles, decisions] = await Promise.all([
    EmployeeDocuments.find({ employee_id: { $in: employeeIds } }).sort({ document_type_id: 1 }).lean(),
    EmployeeContracts.find({ employee_id: { $in: employeeIds } }).sort({ id: -1 }).lean(),
    EmployeeStatusHistory.find({ employee_id: { $in: employeeIds } }).sort({ effective_date: -1, id: -1 }).lean(),
    DocumentTypes.find({}).lean(),
    ContractTypes.find({}).lean(),
    SalaryProfiles.find({ employee_id: { $in: employeeIds } }).sort({ effective_from: -1, id: -1 }).lean(),
    EmployeeDecisions.find({ employee_id: { $in: employeeIds } }).sort({ effective_date: -1, decision_date: -1, id: -1 }).lean()
  ]);

  const safeDocuments = hydrateLegacyIds('employee_documents', documents);
  const safeTypes = hydrateLegacyIds('document_types', types);
  const safeContractTypes = hydrateLegacyIds('contract_types', contractTypes);
  const docIds = safeDocuments.flatMap(d => idVariants(d.id));
  // Contracts may not have a stable legacy key in very old conversions. Keep
  // Mongo _id as a UI-safe id if needed; related files still use legacy ids
  // when they are present.
  const safeContracts = contracts.map(c => hydrateLegacyId('employee_contracts', c));
  const contractIds = safeContracts.flatMap(c => idVariants(c.id)).filter(x => !String(x).match(/^[0-9a-f]{24}$/i));
  const [reviews, docFiles, contractFiles] = await Promise.all([
    docIds.length ? EmployeeDocumentReviews.find({ employee_document_id: { $in: docIds } }).sort({ reviewed_at: -1, id: -1 }).lean() : [],
    docIds.length ? EmployeeDocumentFiles.find({ employee_document_id: { $in: docIds } }).sort({ uploaded_at: -1, id: -1 }).lean() : [],
    contractIds.length ? EmployeeContractFiles.find({ employee_contract_id: { $in: contractIds } }).sort({ uploaded_at: -1, id: -1 }).lean() : []
  ]);

  const typeMap = mapByLegacyId(safeTypes);
  const contractTypeMap = mapByLegacyId(safeContractTypes);
  const reviewsByDoc = new Map();
  for (const r of reviews) {
    const key = String(Number(r.employee_document_id));
    if (!reviewsByDoc.has(key)) reviewsByDoc.set(key, r);
  }
  const filesByDoc = groupByLegacyForeignKey(docFiles, 'employee_document_id');
  const filesByContract = groupByLegacyForeignKey(contractFiles, 'employee_contract_id');

  res.json({
    employee,
    documents: safeDocuments.map(d => {
      const review = reviewsByDoc.get(String(Number(d.id)));
      return {
        ...d,
        document_type_name: getByLegacyId(typeMap, d.document_type_id)?.document_name || '',
        verification_status: review?.review_status || d.verification_status || 'pending',
        verification_note: review?.note || null,
        files: filesByDoc.get(String(Number(d.id))) || []
      };
    }),
    contracts: safeContracts.map(c => ({
      ...c,
      contract_type_name: getByLegacyId(contractTypeMap, c.contract_type_id)?.contract_type_name || '',
      files: filesByContract.get(String(Number(c.id))) || []
    })),
    history: history.map(h => ({ ...h, id: h.id ?? h._id?.toString?.() ?? h._id })),
    contractTypes: safeContractTypes,
    salaryProfiles: salaryProfiles.map(x => ({ ...x, id: x.id ?? x._id?.toString?.() ?? x._id })),
    decisions: decisions.map(x => ({ ...x, id: x.id ?? x._id?.toString?.() ?? x._id }))
  });
});

router.post('/', can('employee.create'), async (req, res) => {
  await validateEmployeePayload(req.body);
  const id = await nextId('employees');
  const d = sanitizeEmployee(req.body);
  d.id = id; d.company_id = 1;
  d.employee_code = d.employee_code || `TH79-NV${String(id).padStart(4, '0')}`;
  d.created_at = new Date(); d.updated_at = new Date(); d.deleted_at = null;
  await Employees.create(d);
  if (hasPermission(req.auth, 'payroll.manage')) await upsertSalaryProfile(id, req.body);
  await EmployeeStatusHistory.create({ id: await nextId('employee_status_history'), employee_id: id, old_status: null, new_status: d.employment_status || 'active', effective_date: new Date().toISOString().slice(0, 10), reason: 'Tạo hồ sơ' });
  await audit(req, { module: 'employees', action: 'create', recordType: 'employee', recordId: id, employeeId: id, description: `Tạo hồ sơ nhân viên: ${d.full_name}`, newValues: d });
  res.status(201).json({ id });
});

router.put('/:id', can('employee.update'), async (req, res) => {
  const old = await employeeById(req.params.id);
  if (!old) return res.status(404).json({ message: 'Không tìm thấy nhân viên.' });
  await validateEmployeePayload(req.body, old._id);
  const d = sanitizeEmployee(req.body);
  await Employees.updateOne({ _id: old._id }, { $set: { ...d, updated_at: new Date() } });
  if (hasPermission(req.auth, 'payroll.manage')) await upsertSalaryProfile(Number(old.id), req.body);
  if (d.employment_status && d.employment_status !== old.employment_status) {
    await EmployeeStatusHistory.create({ id: await nextId('employee_status_history'), employee_id: Number(old.id), old_status: old.employment_status, new_status: d.employment_status, effective_date: new Date().toISOString().slice(0, 10), reason: 'Cập nhật hồ sơ' });
  }
  await audit(req, { module: 'employees', action: 'update', recordType: 'employee', recordId: old.id, employeeId: old.id, description: `Cập nhật hồ sơ nhân viên: ${old.full_name}`, oldValues: old, newValues: d });
  res.json({ ok: true, id: old.id });
});

// Xóa hàng loạt là xóa mềm: dữ liệu hồ sơ, hợp đồng, file Cloudinary và lịch sử
// vẫn được giữ để có thể phục hồi/đối soát khi cần.
router.post('/bulk-delete', can('employee.delete'), async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(String).filter(Boolean))];
  if (!ids.length) return res.status(400).json({ message: 'Chưa chọn nhân viên cần xóa.' });
  if (ids.length > 500) return res.status(400).json({ message: 'Mỗi lần chỉ được xóa tối đa 500 nhân viên.' });

  const mongoIds = [];
  const deleted = [];
  for (const id of ids) {
    const e = await employeeById(id);
    if (!e?._id) continue;
    mongoIds.push(e._id);
    deleted.push({ id: e.id, full_name: e.full_name, employee_code: e.employee_code });
  }
  if (!mongoIds.length) return res.status(404).json({ message: 'Không tìm thấy nhân viên hợp lệ để xóa.' });

  const now = new Date();
  await Employees.updateMany({ _id: { $in: mongoIds } }, { $set: { deleted_at: now, employment_status: 'inactive', updated_at: now } });
  await audit(req, { module: 'employees', action: 'bulk_delete', recordType: 'employee', description: `Xóa mềm hàng loạt ${deleted.length} nhân viên`, newValues: { employees: deleted } });
  res.json({ ok: true, deleted: deleted.length, message: `Đã xóa mềm ${deleted.length} nhân viên.` });
});

router.post('/delete-all', can('employee.delete'), async (req, res) => {
  if (!req.auth?.isSuperAdmin) return res.status(403).json({ message: 'Chỉ Super Admin được phép xóa toàn bộ nhân sự.' });
  const confirmation = String(req.body.confirmation || '').trim().toUpperCase();
  if (confirmation !== 'XOA TAT CA NHAN SU') {
    return res.status(400).json({ message: 'Xác nhận không đúng. Hãy nhập chính xác: XOA TAT CA NHAN SU' });
  }
  const filter = { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] };
  const count = await Employees.countDocuments(filter);
  if (!count) return res.json({ ok: true, deleted: 0, message: 'Không còn nhân viên đang hoạt động để xóa.' });
  const now = new Date();
  await Employees.updateMany(filter, { $set: { deleted_at: now, employment_status: 'inactive', updated_at: now } });
  await audit(req, { module: 'employees', action: 'delete_all', recordType: 'employee', description: `Xóa mềm toàn bộ ${count} nhân viên`, newValues: { count } });
  res.json({ ok: true, deleted: count, message: `Đã xóa mềm toàn bộ ${count} nhân viên.` });
});

router.delete('/:id', can('employee.delete'), async (req, res) => {
  const e = await employeeById(req.params.id);
  if (!e) return res.status(404).json({ message: 'Không tìm thấy nhân viên.' });
  await Employees.updateOne({ _id: e._id }, { $set: { deleted_at: new Date(), employment_status: 'inactive', updated_at: new Date() } });
  await audit(req, { module: 'employees', action: 'delete', recordType: 'employee', recordId: e.id, employeeId: e.id, description: `Xóa mềm hồ sơ: ${e.full_name}` });
  res.json({ ok: true, message: `Đã xóa mềm hồ sơ ${e.full_name}.` });
});

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    const p = XLSX.SSF.parse_date_code(v);
    return p ? `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` : null;
  }
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return isValidDate(v) ? v : null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function findName(rows, key, value) {
  const n = String(value || '').trim().toLowerCase();
  return rows.find(x => String(x[key] || '').trim().toLowerCase() === n)?.id || null;
}

function groupByLegacyForeignKey(rows, key) {
  const out = new Map();
  for (const row of rows) {
    const k = String(Number(row[key]));
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(row);
  }
  return out;
}

function sanitizeEmployee(b) {
  const keys = [
    'branch_id','department_id','position_id','contract_status_id','employee_code','full_name','gender',
    'date_of_birth','professional_qualification','identity_number','permanent_address','current_address','phone','email',
    'social_insurance_number','social_insurance_status','social_insurance_raw','join_date','probation_end_date',
    'recruitment_decision_no','employment_status','bank_account_number','bank_name','tax_dependents','note'
  ];
  const o = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k];
  for (const k of [
    'employee_code','full_name','professional_qualification','identity_number','permanent_address','current_address',
    'phone','email','social_insurance_number','social_insurance_raw','recruitment_decision_no',
    'bank_account_number','bank_name','note'
  ]) {
    if (typeof o[k] === 'string') o[k] = o[k].trim();
  }
  if (typeof o.employee_code === 'string') o.employee_code = o.employee_code.toUpperCase();
  if (typeof o.email === 'string') o.email = o.email.toLowerCase();
  for (const k of ['identity_number','social_insurance_number','bank_account_number']) {
    if (typeof o[k] === 'string') o[k] = o[k].replace(/\s/g, '');
  }
  for (const k of ['branch_id','department_id','position_id','contract_status_id']) o[k] = o[k] ? Number(o[k]) : null;
  if (Object.prototype.hasOwnProperty.call(o, 'tax_dependents')) o.tax_dependents = Math.max(0, Math.floor(Number(o.tax_dependents) || 0));
  return o;
}

function collectEmployeeImportErrors(data) {
  const errors = [];
  const name = String(data.full_name || '').trim();
  if (name.length < 2 || name.length > 120) errors.push('Họ tên phải có từ 2 đến 120 ký tự');
  if (data.employee_code && !/^[A-Za-z0-9._-]{2,30}$/.test(String(data.employee_code).trim())) errors.push('Mã nhân viên không đúng định dạng');
  if (data.email && !isValidEmail(String(data.email).trim())) errors.push('Email không đúng định dạng');
  if (data.phone && !isValidPhone(String(data.phone).trim())) errors.push('Số điện thoại không đúng định dạng');
  const identity = String(data.identity_number || '').replace(/\s/g, '');
  if (identity && !/^(?:\d{9}|\d{12})$/.test(identity)) errors.push('CCCD phải gồm 9 hoặc 12 chữ số');
  if (data.date_of_birth && (!isValidDate(String(data.date_of_birth).slice(0, 10)) || String(data.date_of_birth).slice(0, 10) >= new Date().toISOString().slice(0, 10))) errors.push('Ngày sinh không hợp lệ');
  if (data.join_date && !isValidDate(String(data.join_date).slice(0, 10))) errors.push('Ngày nhận việc không hợp lệ');
  if (data.probation_end_date && !isValidDate(String(data.probation_end_date).slice(0, 10))) errors.push('Ngày kết thúc thử việc không hợp lệ');
  if (data.join_date && data.probation_end_date && String(data.probation_end_date).slice(0, 10) < String(data.join_date).slice(0, 10)) errors.push('Ngày thử việc phải sau hoặc bằng ngày nhận việc');
  if (data.gender && !['unknown', 'male', 'female', 'other'].includes(data.gender)) errors.push('Giới tính không hợp lệ');
  if (data.employment_status && !['probation', 'active', 'on_leave', 'resigned', 'inactive', 'terminated'].includes(data.employment_status)) errors.push('Trạng thái nhân viên không hợp lệ');
  return errors;
}

async function validateEmployeePayload(body = {}, exceptMongoId = null) {
  const required = ['full_name'];
  for (const key of required) {
    if (Object.prototype.hasOwnProperty.call(body, key) || !exceptMongoId) {
      assertValid(typeof body[key] === 'string' && body[key].trim().length >= 2 && body[key].trim().length <= 120,
        'Họ và tên phải có từ 2 đến 120 ký tự.');
    }
  }

  if (body.employee_code !== undefined && String(body.employee_code).trim()) {
    const code = String(body.employee_code).trim();
    assertValid(/^[A-Za-z0-9._-]{2,30}$/.test(code), 'Mã nhân viên chỉ được dùng chữ, số, dấu chấm, gạch ngang hoặc gạch dưới (2–30 ký tự).');
    const filter = { employee_code: new RegExp(`^${escapeRegex(code)}$`, 'i'), deleted_at: null };
    if (exceptMongoId) filter._id = { $ne: exceptMongoId };
    assertValid(!(await Employees.findOne(filter).lean()), 'Mã nhân viên đã tồn tại.', 409);
  }

  for (const [key, label] of [['email', 'Email'], ['phone', 'Số điện thoại']]) {
    const value = String(body[key] || '').trim();
    if (!value) continue;
    assertValid(key === 'email' ? isValidEmail(value) : isValidPhone(value), `${label} không đúng định dạng.`);
  }
  for (const [key, label, max] of [
    ['professional_qualification', 'Trình độ chuyên môn', 160],
    ['permanent_address', 'Địa chỉ thường trú', 500],
    ['current_address', 'Địa chỉ hiện tại', 500],
    ['recruitment_decision_no', 'Số quyết định tuyển dụng', 100],
    ['bank_name', 'Tên ngân hàng', 120],
    ['note', 'Ghi chú', 2000]
  ]) {
    if (body[key] !== undefined && body[key] !== null) {
      assertValid(typeof body[key] === 'string' && body[key].length <= max, `${label} không được vượt quá ${max} ký tự.`);
    }
  }

  const identity = String(body.identity_number || '').replace(/\s/g, '');
  if (identity) {
    assertValid(/^(?:\d{9}|\d{12})$/.test(identity), 'CMND/CCCD phải gồm 9 hoặc 12 chữ số.');
    const filter = { identity_number: identity, deleted_at: null };
    if (exceptMongoId) filter._id = { $ne: exceptMongoId };
    assertValid(!(await Employees.findOne(filter).lean()), 'Số CMND/CCCD đã được sử dụng.', 409);
  }

  for (const [key, label] of [
    ['date_of_birth', 'Ngày sinh'], ['join_date', 'Ngày nhận việc'],
    ['probation_end_date', 'Ngày kết thúc thử việc'], ['salary_effective_from', 'Ngày hiệu lực lương']
  ]) {
    const value = body[key];
    if (value) assertValid(isValidDate(String(value).slice(0, 10)), `${label} không hợp lệ.`);
  }
  if (body.date_of_birth) {
    assertValid(String(body.date_of_birth).slice(0, 10) < new Date().toISOString().slice(0, 10), 'Ngày sinh phải nằm trong quá khứ.');
  }
  if (body.join_date && body.probation_end_date) {
    assertValid(String(body.probation_end_date).slice(0, 10) >= String(body.join_date).slice(0, 10),
      'Ngày kết thúc thử việc phải sau hoặc bằng ngày nhận việc.');
  }

  const enums = {
    gender: ['unknown', 'male', 'female', 'other'],
    employment_status: ['probation', 'active', 'on_leave', 'resigned', 'inactive', 'terminated'],
    social_insurance_status: ['unknown', 'has_number', 'not_yet', 'external_company']
  };
  for (const [key, values] of Object.entries(enums)) {
    if (body[key] !== undefined) assertValid(values.includes(body[key]), `Giá trị ${key} không hợp lệ.`);
  }

  for (const [key, Model, label] of [
    ['branch_id', Branches, 'Chi nhánh'],
    ['department_id', Departments, 'Phòng ban'],
    ['position_id', Positions, 'Chức vụ'],
    ['contract_status_id', ContractStatuses, 'Trạng thái hợp đồng']
  ]) {
    const value = body[key];
    if (value === undefined || value === null || value === '') continue;
    assertValid(isValidNumber(value, { min: 1, integer: true }), `${label} không hợp lệ.`);
    assertValid(await Model.findOne({ id: { $in: idVariants(value) } }).lean(), `Không tìm thấy ${label.toLowerCase()}.`);
  }

  for (const key of [
    'base_salary', 'probation_salary', 'insurance_salary', 'lunch_allowance', 'fuel_allowance',
    'phone_allowance', 'attendance_allowance', 'other_allowance'
  ]) {
    if (body[key] !== undefined && body[key] !== '') {
      assertValid(isValidNumber(body[key], { min: 0, max: 1_000_000_000_000 }), `${key} phải là số không âm hợp lệ.`);
    }
  }
  if (body.tax_dependents !== undefined && body.tax_dependents !== '') {
    assertValid(isValidNumber(body.tax_dependents, { min: 0, max: 100, integer: true }), 'Số người phụ thuộc phải là số nguyên từ 0 đến 100.');
  }
  if (body.bank_account_number) {
    assertValid(/^[0-9]{5,30}$/.test(String(body.bank_account_number).replace(/\s/g, '')), 'Số tài khoản ngân hàng phải gồm 5–30 chữ số.');
  }
  if (body.social_insurance_number) {
    assertValid(/^\d{10}$/.test(String(body.social_insurance_number).replace(/\s/g, '')), 'Số BHXH phải gồm 10 chữ số.');
  }
}


function salaryNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function upsertSalaryProfile(employeeId, body = {}) {
  const salaryKeys = [
    'base_salary','probation_salary','insurance_salary','lunch_allowance','fuel_allowance',
    'phone_allowance','attendance_allowance','other_allowance','salary_effective_from'
  ];
  if (!salaryKeys.some(k => Object.prototype.hasOwnProperty.call(body, k))) return;

  const payload = {
    base_salary: salaryNumber(body.base_salary),
    probation_salary: salaryNumber(body.probation_salary),
    insurance_salary: salaryNumber(body.insurance_salary || body.base_salary),
    lunch_allowance: salaryNumber(body.lunch_allowance),
    fuel_allowance: salaryNumber(body.fuel_allowance),
    phone_allowance: salaryNumber(body.phone_allowance),
    attendance_allowance: salaryNumber(body.attendance_allowance),
    other_allowance: salaryNumber(body.other_allowance),
    effective_from: body.salary_effective_from || body.join_date || new Date().toISOString().slice(0, 10),
    updated_at: new Date()
  };

  const existing = await SalaryProfiles.findOne({ employee_id: { $in: idVariants(employeeId) } }).sort({ effective_from: -1, id: -1 });
  if (existing) {
    await SalaryProfiles.updateOne({ _id: existing._id }, { $set: payload });
  } else {
    await SalaryProfiles.create({
      id: await nextId('salary_profiles'), company_id: 1, employee_id: Number(employeeId),
      ...payload, created_at: new Date()
    });
  }
}

export default router;
