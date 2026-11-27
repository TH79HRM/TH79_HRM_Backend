import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import multer from 'multer';
import * as XLSX from 'xlsx';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import {
  Branches, Departments, Positions, Users, Roles, Permissions, UserRoles,
  RolePermissions, UserPermissions, Employees
} from '../models/raw.js';
import { can } from '../middleware/auth.js';
import { nextId } from '../utils/id.js';
import { audit } from '../services/auditService.js';
import { escapeRegex } from '../utils/normalize.js';
import { idVariants } from '../utils/legacyId.js';
import { hydrateLegacyId, hydrateLegacyIds } from '../utils/legacySeedIdentity.js';
import { ensureOrganizationIds } from '../services/organizationService.js';
import { assertValid, isValidEmail, isValidNumber } from '../utils/validation.js';

const router = Router();
const userImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function userLookupFilter(raw) {
  const value = String(raw ?? '').trim();
  const clauses = [];
  const variants = idVariants(value);
  if (variants.length) clauses.push({ id: { $in: variants } });
  if (mongoose.isValidObjectId(value)) clauses.push({ _id: new mongoose.Types.ObjectId(value) });
  return clauses.length === 1 ? clauses[0] : clauses.length ? { $or: clauses } : { _id: null };
}

function sameUser(a, b) {
  if (!a || !b) return false;
  if (a._id && b._id && String(a._id) === String(b._id)) return true;
  if (a.id !== undefined && a.id !== null && b.id !== undefined && b.id !== null) {
    return String(a.id) === String(b.id);
  }
  return false;
}

function organizationLookupFilter(raw) {
  const value = String(raw ?? '').trim();
  if (mongoose.isValidObjectId(value)) return { _id: new mongoose.Types.ObjectId(value) };
  const variants = idVariants(value);
  return variants.length ? { id: { $in: variants } } : { _id: null };
}

function organizationPublicRow(collection, row) {
  const hydrated = hydrateLegacyId(collection, row);
  return {
    ...hydrated,
    _id: hydrated?._id ? String(hydrated._id) : hydrated?._id,
    manage_id: hydrated?._id ? String(hydrated._id) : String(hydrated?.id ?? '')
  };
}

async function assertUniqueOrganization(Model, codeKey, nameKey, body, exceptMongoId = null) {
  const code = String(body?.[codeKey] || '').trim();
  const name = String(body?.[nameKey] || '').trim();
  assertValid(/^[A-Za-z0-9._-]{2,30}$/.test(code), 'Mã phải có 2–30 ký tự chữ, số, dấu chấm, gạch ngang hoặc gạch dưới.');
  assertValid(name.length >= 2 && name.length <= 120, 'Tên phải có từ 2 đến 120 ký tự.');
  const clauses = [
    { [codeKey]: new RegExp(`^${escapeRegex(code)}$`, 'i') },
    { [nameKey]: new RegExp(`^${escapeRegex(name)}$`, 'i') }
  ];
  const filter = { $or: clauses };
  if (exceptMongoId) filter._id = { $ne: exceptMongoId };
  const duplicate = await Model.findOne(filter).lean();
  if (duplicate) {
    const sameCode = String(duplicate?.[codeKey] || '').trim().toLowerCase() === code.toLowerCase();
    const err = new Error(sameCode ? 'Mã này đã tồn tại trong hệ thống.' : 'Tên này đã tồn tại trong hệ thống.');
    err.status = 409;
    throw err;
  }
  return { code: code.toUpperCase(), name };
}

async function assertUniqueUserFields({ username, email, exceptMongoId = null }) {
  const checks = [];
  if (username) checks.push({ username: new RegExp(`^${escapeRegex(String(username).trim())}$`, 'i') });
  if (email) checks.push({ email: new RegExp(`^${escapeRegex(String(email).trim())}$`, 'i') });
  if (!checks.length) return;
  const filter = { $or: checks };
  if (exceptMongoId) filter._id = { $ne: exceptMongoId };
  const duplicate = await Users.findOne(filter).lean();
  if (duplicate) {
    const err = new Error(String(duplicate.username || '').toLowerCase() === String(username).trim().toLowerCase()
      ? 'Tên tài khoản đã tồn tại.'
      : 'Email đã được sử dụng bởi tài khoản khác.');
    err.status = 409;
    throw err;
  }
}

async function assertUniqueEmployeeLink(employeeId, exceptMongoId = null) {
  if (!employeeId) return;
  const filter = { employee_id: Number(employeeId) };
  if (exceptMongoId) filter._id = { $ne: exceptMongoId };
  const linkedUser = await Users.findOne(filter).select({ username: 1 }).lean();
  if (linkedUser) {
    const err = new Error('Nhân viên này đã được liên kết với một tài khoản khác.');
    err.status = 409;
    throw err;
  }
}

async function validateUserPayload({ username, email, password, status, employee_id, role_ids }, { requirePassword = false } = {}) {
  const cleanUsername = String(username || '').trim();
  assertValid(/^[A-Za-z0-9._-]{3,64}$/.test(cleanUsername), 'Tên tài khoản phải có 3–64 ký tự chữ, số, dấu chấm, gạch ngang hoặc gạch dưới.');
  if (email) assertValid(isValidEmail(String(email).trim()), 'Email không đúng định dạng.');
  if (requirePassword || password) {
    const cleanPassword = String(password || '');
    assertValid(cleanPassword.length >= 8 && cleanPassword.length <= 72, 'Mật khẩu phải có từ 8 đến 72 ký tự.');
  }
  if (status !== undefined) assertValid(['active', 'inactive', 'locked', 'disabled'].includes(status), 'Trạng thái tài khoản không hợp lệ.');
  if (employee_id) {
    assertValid(isValidNumber(employee_id, { min: 1, integer: true }), 'Mã nhân viên liên kết không hợp lệ.');
    assertValid(await Employees.findOne({ id: Number(employee_id) }).lean(), 'Không tìm thấy nhân viên được liên kết.');
  }
  if (role_ids !== undefined) {
    assertValid(Array.isArray(role_ids) && role_ids.every(id => isValidNumber(id, { min: 1, integer: true })), 'Danh sách vai trò không hợp lệ.');
    if (role_ids.length) {
      const roles = await Roles.find({ id: { $in: role_ids.map(Number) } }).select({ id: 1 }).lean();
      assertValid(roles.length === new Set(role_ids.map(Number)).size, 'Có vai trò không tồn tại hoặc bị chọn lặp.');
    }
  }
}

function importCell(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) return row[name];
  }
  return '';
}

async function validateUserImportRows(entries) {
  const [existingUsers, employees, roles] = await Promise.all([
    Users.find({}).select({ username: 1, email: 1, employee_id: 1 }).lean(),
    Employees.find({}).select({ id: 1 }).lean(),
    Roles.find({}).select({ id: 1 }).lean()
  ]);
  const usernames = new Set(existingUsers.map(user => String(user.username || '').trim().toLowerCase()).filter(Boolean));
  const emails = new Set(existingUsers.map(user => String(user.email || '').trim().toLowerCase()).filter(Boolean));
  const linkedEmployeeIds = new Set(existingUsers.map(user => String(user.employee_id ?? '')).filter(Boolean));
  const employeeIds = new Set(employees.map(employee => String(employee.id)));
  const roleIds = new Set(roles.map(role => Number(role.id)).filter(Number.isFinite));
  const seenUsernames = new Set();
  const seenEmails = new Set();
  const seenEmployeeIds = new Set();

  return entries.map(({ row, data }) => {
    const username = String(data.username || '').trim();
    const email = String(data.email || '').trim().toLowerCase();
    const employeeValue = String(data.employee_id ?? '').trim();
    const employeeId = employeeValue ? Number(employeeValue) : null;
    const rawRoleIds = Array.isArray(data.role_ids) ? data.role_ids : String(data.role_ids || '').split(/[|;,]/).filter(Boolean);
    const parsedRoleIds = rawRoleIds.map(Number);
    const errors = [];

    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) errors.push('Tên tài khoản phải có 3–64 ký tự chữ, số, dấu chấm, gạch ngang hoặc gạch dưới');
    if (email && !isValidEmail(email)) errors.push('Email không đúng định dạng');
    if (employeeValue && (!isValidNumber(employeeId, { min: 1, integer: true }) || !employeeIds.has(String(employeeId)))) {
      errors.push('Mã nhân viên liên kết không tồn tại hoặc không hợp lệ');
    }
    if (employeeId && (linkedEmployeeIds.has(String(employeeId)) || seenEmployeeIds.has(String(employeeId)))) {
      errors.push('Nhân viên đã được liên kết với tài khoản khác hoặc bị lặp trong file');
    }
    if (!parsedRoleIds.every(id => isValidNumber(id, { min: 1, integer: true }))) errors.push('Danh sách ID vai trò không hợp lệ');
    if (new Set(parsedRoleIds).size !== parsedRoleIds.length) errors.push('ID vai trò bị lặp trong dòng');
    if (parsedRoleIds.some(id => !roleIds.has(id))) errors.push('Có ID vai trò không tồn tại');

    const usernameKey = username.toLowerCase();
    const emailKey = email.toLowerCase();
    if (usernames.has(usernameKey) || seenUsernames.has(usernameKey)) errors.push('Tên tài khoản đã tồn tại hoặc bị lặp');
    if (emailKey && (emails.has(emailKey) || seenEmails.has(emailKey))) errors.push('Email đã được sử dụng hoặc bị lặp');
    if (usernameKey) seenUsernames.add(usernameKey);
    if (emailKey) seenEmails.add(emailKey);
    if (employeeId) seenEmployeeIds.add(String(employeeId));

    return {
      row,
      data: { username, email: email || null, employee_id: employeeId, role_ids: parsedRoleIds },
      errors
    };
  });
}

router.get('/organization', can('organization.view'), async (req, res, next) => {
  try {
    await ensureOrganizationIds();
    const [rawBranches, rawDepartments, rawPositions] = await Promise.all([
      Branches.find({}).sort({ id: 1, branch_name: 1 }).lean(),
      Departments.find({}).sort({ id: 1, department_name: 1 }).lean(),
      Positions.find({}).sort({ id: 1, position_name: 1 }).lean()
    ]);
    res.json({
      branches: rawBranches.map(row => organizationPublicRow('branches', row)),
      departments: rawDepartments.map(row => organizationPublicRow('departments', row)),
      positions: rawPositions.map(row => organizationPublicRow('positions', row))
    });
  } catch (error) { next(error); }
});

for (const config of [
  { pathName: 'branches', Model: Branches, collection: 'branches', codeKey: 'branch_code', nameKey: 'branch_name', employeeField: 'branch_id', label: 'chi nhánh' },
  { pathName: 'departments', Model: Departments, collection: 'departments', codeKey: 'department_code', nameKey: 'department_name', employeeField: 'department_id', label: 'phòng ban' },
  { pathName: 'positions', Model: Positions, collection: 'positions', codeKey: 'position_code', nameKey: 'position_name', employeeField: 'position_id', label: 'chức vụ' }
]) {
  const { pathName, Model, collection, codeKey, nameKey, employeeField, label } = config;

  router.post(`/organization/${pathName}`, can('organization.manage'), async (req, res, next) => {
    try {
      await ensureOrganizationIds();
      assertValid(['active', 'inactive'].includes(req.body.status || 'active'), 'Trạng thái danh mục không hợp lệ.');
      const normalized = await assertUniqueOrganization(Model, codeKey, nameKey, req.body);
      const id = await nextId(collection);
      const row = {
        id,
        company_id: 1,
        [codeKey]: normalized.code,
        [nameKey]: normalized.name,
        status: req.body.status === 'inactive' ? 'inactive' : 'active',
        created_at: new Date(),
        updated_at: new Date()
      };
      const created = await Model.create(row);
      await audit(req, {
        module: 'organization', action: 'create', recordType: pathName.slice(0, -1), recordId: id,
        description: `Tạo ${label}: ${row[nameKey]}`, newValues: row
      });
      res.status(201).json(organizationPublicRow(collection, created.toObject()));
    } catch (error) { next(error); }
  });

  router.put(`/organization/${pathName}/:id`, can('organization.manage'), async (req, res, next) => {
    try {
      await ensureOrganizationIds();
      assertValid(['active', 'inactive'].includes(req.body.status || 'active'), 'Trạng thái danh mục không hợp lệ.');
      const target = await Model.findOne(organizationLookupFilter(req.params.id));
      if (!target) return res.status(404).json({ message: `Không tìm thấy ${label}.` });
      const normalized = await assertUniqueOrganization(Model, codeKey, nameKey, req.body, target._id);
      const set = {
        [codeKey]: normalized.code,
        [nameKey]: normalized.name,
        status: req.body.status === 'inactive' ? 'inactive' : 'active',
        updated_at: new Date()
      };
      await Model.updateOne({ _id: target._id }, { $set: set });
      await audit(req, {
        module: 'organization', action: 'update', recordType: pathName.slice(0, -1), recordId: target.id ?? null,
        description: `Cập nhật ${label}: ${normalized.name}`,
        oldValues: { [codeKey]: target[codeKey], [nameKey]: target[nameKey], status: target.status },
        newValues: set
      });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  router.delete(`/organization/${pathName}/:id`, can('organization.manage'), async (req, res, next) => {
    try {
      await ensureOrganizationIds();
      const target = await Model.findOne(organizationLookupFilter(req.params.id)).lean();
      if (!target) return res.status(404).json({ message: `Không tìm thấy ${label}.` });
      const publicRow = organizationPublicRow(collection, target);
      const relationId = publicRow.id;
      const inUse = await Employees.countDocuments({
        [employeeField]: { $in: idVariants(relationId) },
        $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }]
      });
      if (inUse > 0) {
        return res.status(409).json({
          message: `Không thể xóa ${label} này vì đang được ${inUse} nhân viên sử dụng. Hãy chuyển nhân viên sang ${label} khác trước.`
        });
      }
      await Model.deleteOne({ _id: target._id });
      await audit(req, {
        module: 'organization', action: 'delete', recordType: pathName.slice(0, -1), recordId: relationId ?? null,
        description: `Xóa ${label}: ${target[nameKey]}`,
        oldValues: { [codeKey]: target[codeKey], [nameKey]: target[nameKey], status: target.status }
      });
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
}

router.get('/users', can('user.view'), async (req, res, next) => {
  try {
    const rawUsers = await Users.find({}).sort({ id: 1, created_at: 1 }).lean();
    const users = hydrateLegacyIds('users', rawUsers);
    const userIds = users.flatMap(x => idVariants(x.id));
    const [links, rawRoles, rawEmployees] = await Promise.all([
      userIds.length ? UserRoles.find({ user_id: { $in: userIds } }).lean() : [],
      Roles.find({}).lean(),
      Employees.find({ $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] }).lean()
    ]);
    const roles = hydrateLegacyIds('roles', rawRoles);
    const employees = hydrateLegacyIds('employees', rawEmployees);
    const rm = new Map(roles.map(x => [Number(x.id), x]));
    const em = new Map(employees.map(x => [Number(x.id), x]));
    res.json({
      items: users.map(({ password_hash, password, passwordHash, auth_version, ...u }) => ({
        ...u,
        _id: u._id ? String(u._id) : u._id,
        // Use Mongo _id for management actions so duplicate/migrated legacy ids
        // can never make the wrong account get edited.
        manage_id: u._id ? String(u._id) : u.id,
        employee_name: em.get(Number(u.employee_id))?.full_name || null,
        roles: links
          .filter(l => String(l.user_id) === String(u.id))
          .map(l => rm.get(Number(l.role_id)))
          .filter(Boolean)
      }))
    });
  } catch (error) { next(error); }
});

router.get('/users/employee-search', can('user.view'), async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    const rx = new RegExp(escapeRegex(query), 'i');
    const numericId = /^\d+$/.test(query) ? Number(query) : null;
    const rows = await Employees.find({
      $and: [
        { $or: [{ deleted_at: null }, { deleted_at: { $exists: false } }] },
        { $or: [{ full_name: rx }, { employee_code: rx }, { phone: rx }, ...(numericId ? [{ id: numericId }] : [])] }
      ]
    }).limit(15).select({ id: 1, full_name: 1, employee_code: 1, phone: 1 }).lean();
    res.json({
      items: hydrateLegacyIds('employees', rows).map(row => ({
        id: row.id,
        full_name: row.full_name,
        employee_code: row.employee_code,
        phone: row.phone
      }))
    });
  } catch (error) { next(error); }
});

router.get('/users/import/template', can('user.manage'), (req, res) => {
  const wb = XLSX.utils.book_new();
  const template = XLSX.utils.aoa_to_sheet([['Tài khoản', 'Email', 'Mã nhân viên', 'ID vai trò (phân cách bằng |)']]);
  const instructions = XLSX.utils.aoa_to_sheet([
    ['Hướng dẫn', 'Điền mỗi tài khoản trên một dòng. Mã nhân viên và ID vai trò phải tồn tại.'],
    ['Tài khoản', 'Bắt buộc, 3–64 ký tự: chữ, số, dấu chấm, gạch ngang, gạch dưới.'],
    ['Email', 'Không bắt buộc; nếu có phải là email hợp lệ và duy nhất.'],
    ['Mã nhân viên', 'Không bắt buộc; liên kết với hồ sơ nhân viên có sẵn.'],
    ['ID vai trò', 'Không bắt buộc; tra cứu tại Hệ thống > Vai trò & phân quyền. Ví dụ: 2|3.'],
    ['Mật khẩu', 'Hệ thống tự tạo mật khẩu tạm riêng cho từng tài khoản và buộc đổi khi đăng nhập lần đầu.']
  ]);
  XLSX.utils.book_append_sheet(wb, template, 'TaiKhoan');
  XLSX.utils.book_append_sheet(wb, instructions, 'HuongDan');
  res.setHeader('Content-Disposition', 'attachment; filename="TH79_Mau_TaoTaiKhoan.xlsx"');
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .send(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
});

router.post('/users/import/preview', can('user.manage'), userImportUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Chưa chọn file danh sách tài khoản.' });

  let rows;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return res.status(400).json({ message: 'File không có trang tính dữ liệu.' });
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } catch {
    return res.status(400).json({ message: 'Không đọc được file. Hãy tải mẫu Excel và thử lại.' });
  }

  const entries = rows
    .filter(row => Object.values(row).some(value => String(value ?? '').trim() !== ''))
    .map((row, index) => ({
      row: index + 2,
      data: {
        username: importCell(row, ['Tài khoản', 'username', 'Username']),
        email: importCell(row, ['Email', 'email']),
        employee_id: importCell(row, ['Mã nhân viên', 'employee_id', 'Employee ID']),
        role_ids: importCell(row, ['ID vai trò (phân cách bằng |)', 'role_ids', 'Role IDs'])
      }
    }));

  if (!entries.length) return res.status(400).json({ message: 'File không có dòng dữ liệu.' });
  if (entries.length > 500) return res.status(400).json({ message: 'Mỗi lần chỉ được tạo tối đa 500 tài khoản.' });
  const preview = await validateUserImportRows(entries);
  res.json({
    preview,
    summary: {
      total: preview.length,
      valid: preview.filter(item => !item.errors.length).length,
      errors: preview.filter(item => item.errors.length).length
    }
  });
});

router.post('/users/import/confirm', can('user.manage'), async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    assertValid(rows.length > 0 && rows.length <= 500, 'Chọn từ 1 đến 500 tài khoản để tạo.');
    assertValid(rows.every(item => item && typeof item === 'object' && item.data && typeof item.data === 'object'), 'Danh sách tài khoản không hợp lệ.');

    const checked = await validateUserImportRows(rows.map((item, index) => ({
      row: Number(item.row) || index + 2,
      data: item.data
    })));
    const invalid = checked.filter(item => item.errors.length);
    if (invalid.length) {
      return res.status(400).json({
        message: 'Danh sách có dòng không hợp lệ. Hãy sửa file và kiểm tra lại trước khi tạo.',
        preview: checked,
        summary: { total: checked.length, valid: checked.length - invalid.length, errors: invalid.length }
      });
    }

    const credentials = await Promise.all(checked.map(async item => {
      const id = await nextId('users');
      const temporaryPassword = randomBytes(18).toString('base64url');
      return {
        id,
        temporaryPassword,
        row: {
          id,
          employee_id: item.data.employee_id,
          username: item.data.username,
          email: item.data.email,
          password_hash: await bcrypt.hash(temporaryPassword, 12),
          status: 'active',
          is_super_admin: 0,
          must_change_password: true,
          auth_version: 0,
          last_login_at: null,
          created_at: new Date(),
          updated_at: new Date()
        },
        role_ids: item.data.role_ids
      };
    }));
    const legacyIds = credentials.map(item => item.id);
    const createdUsers = await Users.insertMany(credentials.map(item => item.row));
    try {
      const roleLinks = credentials.flatMap(item => item.role_ids.map(roleId => ({
        user_id: item.id, role_id: roleId
      })));
      if (roleLinks.length) await UserRoles.insertMany(roleLinks);
    } catch (error) {
      await Promise.all([
        Users.deleteMany({ id: { $in: legacyIds } }),
        UserRoles.deleteMany({ user_id: { $in: legacyIds } })
      ]);
      throw error;
    }

    for (const item of credentials) {
      await audit(req, {
        module: 'users', action: 'create', recordType: 'user', recordId: item.id,
        description: `Tạo tài khoản đăng nhập hàng loạt: ${item.row.username}`,
        newValues: { username: item.row.username, email: item.row.email, employee_id: item.row.employee_id, must_change_password: true }
      });
    }

    res.status(201).json({
      created: createdUsers.map((user, index) => ({
        username: user.username,
        employee_id: user.employee_id,
        temporary_password: credentials[index].temporaryPassword
      }))
    });
  } catch (error) { next(error); }
});

router.post('/users', can('user.manage'), async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim() || null;
    await validateUserPayload({ ...req.body, username, email }, { requirePassword: true });
    await assertUniqueUserFields({ username, email });
    await assertUniqueEmployeeLink(req.body.employee_id);

    const id = await nextId('users');
    const password = String(req.body.password);
    const hash = await bcrypt.hash(password, 12);
    const row = {
      id,
      employee_id: req.body.employee_id ? Number(req.body.employee_id) : null,
      username,
      email,
      password_hash: hash,
      status: req.body.status || 'active',
      is_super_admin: req.auth?.isSuperAdmin && req.body.is_super_admin ? 1 : 0,
      must_change_password: true,
      auth_version: 0,
      last_login_at: null,
      created_at: new Date(),
      updated_at: new Date()
    };
    await Users.create(row);
    if (req.body.role_ids?.length) {
      await UserRoles.insertMany(req.body.role_ids.map(r => ({ user_id: id, role_id: Number(r) })));
    }
    await audit(req, { module: 'users', action: 'create', recordType: 'user', recordId: id, description: `Tạo tài khoản đăng nhập: ${username}`, newValues: { ...row, password_hash: '***' } });
    res.status(201).json({ id });
  } catch (error) { next(error); }
});

router.put('/users/:id', can('user.manage'), async (req, res, next) => {
  try {
    const target = await Users.findOne(userLookupFilter(req.params.id));
    if (!target) return res.status(404).json({ message: 'Không tìm thấy tài khoản.' });

    const username = String(req.body.username || target.username || '').trim();
    const email = String(req.body.email || '').trim() || null;
    await validateUserPayload({ ...req.body, username, email });
    await assertUniqueUserFields({ username, email, exceptMongoId: target._id });
    await assertUniqueEmployeeLink(req.body.employee_id, target._id);

    const isSelf = sameUser(target, req.auth?.user);
    const requestedStatus = req.body.status || target.status || 'active';
    if (isSelf && requestedStatus !== 'active') {
      return res.status(400).json({ message: 'Không thể khóa hoặc ngưng chính tài khoản đang đăng nhập.' });
    }
    if (Number(target.is_super_admin) === 1 && requestedStatus !== 'active') {
      const activeAdmins = await Users.countDocuments({ is_super_admin: 1, status: 'active' });
      if (activeAdmins <= 1) return res.status(400).json({ message: 'Không thể ngưng Super Admin cuối cùng của hệ thống.' });
    }

    let legacyId = target.id;
    if (legacyId === undefined || legacyId === null || legacyId === '') {
      legacyId = await nextId('users');
    }

    const set = {
      id: legacyId,
      employee_id: req.body.employee_id ? Number(req.body.employee_id) : null,
      username,
      email,
      status: requestedStatus,
      updated_at: new Date()
    };
    if (req.body.password) {
      const password = String(req.body.password);
      set.password_hash = await bcrypt.hash(password, 12);
      set.must_change_password = true;
      set.auth_version = Number(target.auth_version || 0) + 1;
    }

    await Users.updateOne({ _id: target._id }, { $set: set });
    if (Array.isArray(req.body.role_ids)) {
      await UserRoles.deleteMany({ user_id: { $in: idVariants(legacyId) } });
      if (req.body.role_ids.length) {
        await UserRoles.insertMany(req.body.role_ids.map(r => ({ user_id: legacyId, role_id: Number(r) })));
      }
    }
    if (req.body.permission_overrides !== undefined) {
      assertValid(req.body.permission_overrides && typeof req.body.permission_overrides === 'object' && !Array.isArray(req.body.permission_overrides), 'Quyền tùy chỉnh không hợp lệ.');
      const entries = Object.entries(req.body.permission_overrides);
      assertValid(entries.every(([permissionId, mode]) => isValidNumber(permissionId, { min: 1, integer: true }) && ['allow', 'deny'].includes(mode)), 'Có quyền tùy chỉnh không hợp lệ.');
      const permissionIds = entries.map(([permissionId]) => Number(permissionId));
      const permissions = permissionIds.length ? await Permissions.find({ id: { $in: permissionIds } }).select({ id: 1 }).lean() : [];
      assertValid(permissions.length === new Set(permissionIds).size, 'Có quyền không tồn tại hoặc bị chọn lặp.');
      await UserPermissions.deleteMany({ user_id: { $in: idVariants(legacyId) } });
      const docs = entries.map(([permission_id, access_mode]) => ({ user_id: legacyId, permission_id: Number(permission_id), access_mode, created_at: new Date() }));
      if (docs.length) await UserPermissions.insertMany(docs);
    }

    await audit(req, {
      module: 'users', action: 'update', recordType: 'user', recordId: legacyId,
      description: `Cập nhật tài khoản: ${username}`,
      oldValues: { username: target.username, email: target.email, employee_id: target.employee_id, status: target.status },
      newValues: { username, email, employee_id: set.employee_id, status: requestedStatus, password_changed: Boolean(req.body.password) }
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.post('/users/:id/reset-password', can('user.manage'), async (req, res, next) => {
  try {
    const target = await Users.findOne(userLookupFilter(req.params.id));
    if (!target) return res.status(404).json({ message: 'Không tìm thấy tài khoản.' });
    if (sameUser(target, req.auth?.user)) {
      return res.status(400).json({ message: 'Hãy dùng chức năng đổi mật khẩu cá nhân để thay đổi mật khẩu của chính bạn.' });
    }

    const temporaryPassword = randomBytes(18).toString('base64url');
    const authVersion = Number(target.auth_version || 0) + 1;
    await Users.updateOne(
      { _id: target._id },
      {
        $set: {
          password_hash: await bcrypt.hash(temporaryPassword, 12),
          must_change_password: true,
          auth_version: authVersion,
          password_changed_at: new Date(),
          updated_at: new Date()
        },
        $unset: { password: 1, passwordHash: 1 }
      }
    );
    await audit(req, {
      module: 'users', action: 'password_reset', recordType: 'user', recordId: target.id ?? null,
      description: `Quản trị viên đặt lại mật khẩu: ${target.username}`,
      oldValues: { username: target.username },
      newValues: { username: target.username, must_change_password: true, active_sessions_revoked: true }
    });
    res.json({ username: target.username, temporary_password: temporaryPassword });
  } catch (error) { next(error); }
});

router.delete('/users/:id', can('user.manage'), async (req, res, next) => {
  try {
    const target = await Users.findOne(userLookupFilter(req.params.id));
    if (!target) return res.status(404).json({ message: 'Không tìm thấy tài khoản.' });
    if (sameUser(target, req.auth?.user)) {
      return res.status(400).json({ message: 'Không thể xóa tài khoản đang đăng nhập.' });
    }
    if (Number(target.is_super_admin) === 1) {
      const activeAdmins = await Users.countDocuments({ is_super_admin: 1, status: 'active' });
      if (activeAdmins <= 1) return res.status(400).json({ message: 'Không thể xóa Super Admin cuối cùng của hệ thống.' });
    }

    const legacyId = target.id;
    if (legacyId !== undefined && legacyId !== null && legacyId !== '') {
      const variants = idVariants(legacyId);
      await Promise.all([
        UserRoles.deleteMany({ user_id: { $in: variants } }),
        UserPermissions.deleteMany({ user_id: { $in: variants } })
      ]);
    }
    await Users.deleteOne({ _id: target._id });
    await audit(req, {
      module: 'users', action: 'delete', recordType: 'user', recordId: legacyId ?? null,
      description: `Xóa tài khoản đăng nhập: ${target.username}`,
      oldValues: { username: target.username, email: target.email, employee_id: target.employee_id, status: target.status }
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.get('/roles', can('role.view'), async (req, res, next) => {
  try {
    const [rawRoles, rawPermissions, rp] = await Promise.all([
      Roles.find({}).sort({ id: 1, role_name: 1 }).lean(),
      Permissions.find({}).sort({ module: 1, id: 1 }).lean(),
      RolePermissions.find({}).lean()
    ]);
    const roles = hydrateLegacyIds('roles', rawRoles).map(row => ({ ...row, _id: row._id ? String(row._id) : row._id }));
    const permissions = hydrateLegacyIds('permissions', rawPermissions).map(row => ({ ...row, _id: row._id ? String(row._id) : row._id }));
    res.json({
      roles: roles.map(r => ({
        ...r,
        permission_ids: rp.filter(x => Number(x.role_id) === Number(r.id)).map(x => Number(x.permission_id)).filter(Number.isFinite)
      })),
      permissions
    });
  } catch (error) { next(error); }
});

router.post('/roles', can('role.manage'), async (req, res) => {
  const roleCode = String(req.body.role_code || '').trim().toUpperCase();
  const roleName = String(req.body.role_name || '').trim();
  assertValid(/^[A-Z0-9._-]{2,40}$/.test(roleCode), 'Mã vai trò phải có 2–40 ký tự chữ, số, dấu chấm, gạch ngang hoặc gạch dưới.');
  assertValid(roleName.length >= 2 && roleName.length <= 120, 'Tên vai trò phải có từ 2 đến 120 ký tự.');
  assertValid(!(await Roles.findOne({ role_code: new RegExp(`^${escapeRegex(roleCode)}$`, 'i') }).lean()), 'Mã vai trò đã tồn tại.', 409);
  assertValid(Array.isArray(req.body.permission_ids || []), 'Danh sách quyền không hợp lệ.');
  const permissionIds = (req.body.permission_ids || []).map(Number);
  assertValid(permissionIds.every(id => isValidNumber(id, { min: 1, integer: true })), 'Có mã quyền không hợp lệ.');
  if (permissionIds.length) {
    const permissions = await Permissions.find({ id: { $in: permissionIds } }).select({ id: 1 }).lean();
    assertValid(permissions.length === new Set(permissionIds).size, 'Có quyền không tồn tại hoặc bị chọn lặp.');
  }
  const id = await nextId('roles');
  await Roles.create({ id, role_code: roleCode, role_name: roleName, description: req.body.description || null, is_system: 0 });
  if (permissionIds.length) await RolePermissions.insertMany(permissionIds.map(permission_id => ({ role_id: id, permission_id })));
  res.status(201).json({ id });
});

router.put('/roles/:id', can('role.manage'), async (req, res) => {
  const id = Number(req.params.id);
  assertValid(Number.isSafeInteger(id) && id > 0, 'Mã vai trò không hợp lệ.');
  const role = await Roles.findOne({ id }).lean();
  assertValid(role, 'Không tìm thấy vai trò.', 404);
  const roleName = String(req.body.role_name || '').trim();
  assertValid(roleName.length >= 2 && roleName.length <= 120, 'Tên vai trò phải có từ 2 đến 120 ký tự.');
  await Roles.updateOne({ id }, { $set: { role_name: roleName, description: req.body.description || null } });
  if (Array.isArray(req.body.permission_ids)) {
    assertValid(req.body.permission_ids.every(permissionId => isValidNumber(permissionId, { min: 1, integer: true })), 'Có mã quyền không hợp lệ.');
    const permissionIds = req.body.permission_ids.map(Number);
    const permissions = permissionIds.length ? await Permissions.find({ id: { $in: permissionIds } }).select({ id: 1 }).lean() : [];
    assertValid(permissions.length === new Set(permissionIds).size, 'Có quyền không tồn tại hoặc bị chọn lặp.');
    await RolePermissions.deleteMany({ role_id: id });
    if (permissionIds.length) await RolePermissions.insertMany(permissionIds.map(permission_id => ({ role_id: id, permission_id })));
  }
  res.json({ ok: true });
});

export default router;
