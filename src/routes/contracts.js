import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { EmployeeContracts, EmployeeContractFiles, ContractTypes, Employees } from '../models/raw.js';
import { can } from '../middleware/auth.js';
import { nextId } from '../utils/id.js';
import { audit } from '../services/auditService.js';
import { env } from '../config/env.js';
import { enrichEmployees } from '../services/employeeService.js';
import { assertValid, isValidDate, isValidNumber } from '../utils/validation.js';
import {
  cloudinaryAssetFields,
  cloudinaryFolder,
  destroyCloudinaryAsset,
  privateAssetUrl,
  sanitizeAssetPart,
  uploadBuffer
} from '../services/cloudinaryService.js';

const router = Router();
const legacyDir = path.resolve(process.cwd(), env.uploadDir);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(image\/(png|jpeg|webp)|application\/pdf)$/.test(file.mimetype))
});

router.get('/types', can('contract.view'), async (req, res) => res.json({ items: await ContractTypes.find({ status: 'active' }).sort({ id: 1 }).lean() }));

router.get('/', can('contract.view'), async (req, res) => {
  const rows = await EmployeeContracts.find({}).sort({ id: -1 }).lean();
  const emps = await enrichEmployees(await Employees.find({ id: { $in: rows.map(x => x.employee_id) } }).lean());
  const types = await ContractTypes.find({}).lean();
  const em = new Map(emps.map(x => [Number(x.id), x]));
  const tm = new Map(types.map(x => [Number(x.id), x]));
  res.json({ items: rows.map(x => ({ ...x, employee: em.get(Number(x.employee_id)), contract_type_name: tm.get(Number(x.contract_type_id))?.contract_type_name })) });
});

router.post('/', can('contract.manage'), async (req, res) => {
  const employeeId = Number(req.body.employee_id);
  const contractTypeId = Number(req.body.contract_type_id);
  assertValid(Number.isSafeInteger(employeeId) && employeeId > 0, 'Vui lòng chọn nhân viên hợp lệ.');
  assertValid(Number.isSafeInteger(contractTypeId) && contractTypeId > 0, 'Vui lòng chọn loại hợp đồng hợp lệ.');
  assertValid(await Employees.findOne({ id: employeeId }).lean(), 'Không tìm thấy nhân viên.');
  assertValid(await ContractTypes.findOne({ id: contractTypeId, status: 'active' }).lean(), 'Loại hợp đồng không hợp lệ.');
  assertValid(isValidDate(req.body.start_date), 'Ngày bắt đầu hợp đồng không hợp lệ.');
  if (req.body.end_date) {
    assertValid(isValidDate(req.body.end_date), 'Ngày kết thúc hợp đồng không hợp lệ.');
    assertValid(req.body.end_date >= req.body.start_date, 'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.');
  }
  if (req.body.signed_date) {
    assertValid(isValidDate(req.body.signed_date), 'Ngày ký hợp đồng không hợp lệ.');
    assertValid(!req.body.end_date || req.body.signed_date <= req.body.end_date, 'Ngày ký không thể sau ngày kết thúc hợp đồng.');
  }
  for (const [field, label] of [['base_salary', 'Lương cơ bản'], ['allowance_amount', 'Phụ cấp']]) {
    if (req.body[field] !== undefined && req.body[field] !== '') {
      assertValid(isValidNumber(req.body[field], { min: 0, max: 1_000_000_000_000 }), `${label} phải là số không âm hợp lệ.`);
    }
  }
  assertValid(['draft', 'active', 'expired', 'terminated', 'cancelled'].includes(req.body.status || 'active'), 'Trạng thái hợp đồng không hợp lệ.');
  const contractNo = String(req.body.contract_no || '').trim();
  if (contractNo) {
    assertValid(contractNo.length <= 100, 'Số hợp đồng không được vượt quá 100 ký tự.');
    assertValid(!(await EmployeeContracts.findOne({ contract_no: contractNo }).lean()), 'Số hợp đồng đã tồn tại.', 409);
  }
  if (req.body.note !== undefined) assertValid(typeof req.body.note === 'string' && req.body.note.length <= 2000, 'Ghi chú hợp đồng không được vượt quá 2.000 ký tự.');

  const id = await nextId('employee_contracts');
  const row = {
    id,
    company_id: 1,
    employee_id: Number(req.body.employee_id),
    contract_type_id: Number(req.body.contract_type_id),
    contract_no: contractNo || null,
    start_date: req.body.start_date || null,
    end_date: req.body.end_date || null,
    signed_date: req.body.signed_date || null,
    base_salary: Number(req.body.base_salary || 0),
    allowance_amount: Number(req.body.allowance_amount || 0),
    status: req.body.status || 'active',
    note: req.body.note || null,
    created_at: new Date(),
    updated_at: new Date()
  };
  await EmployeeContracts.create(row);
  await audit(req, { module: 'contracts', action: 'create', recordType: 'contract', recordId: id, employeeId: row.employee_id, description: 'Tạo hợp đồng nhân viên', newValues: row });
  res.status(201).json({ id });
});

router.post('/:id/files', can('contract.upload'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Chưa chọn PDF hoặc ảnh hợp đồng.' });
    const contract = await EmployeeContracts.findOne({ id: Number(req.params.id) }).lean();
    if (!contract) return res.status(404).json({ message: 'Không tìm thấy hợp đồng.' });

    const id = await nextId('employee_contract_files');
    const originalBase = sanitizeAssetPart(path.parse(req.file.originalname).name, 'contract');
    const result = await uploadBuffer(req.file.buffer, {
      resourceType: 'image',
      deliveryType: 'authenticated',
      folder: cloudinaryFolder('contracts', `employee-${contract.employee_id}`),
      publicId: `contract-${contract.id}-${id}-${originalBase}-${Date.now()}`,
      context: `employee_id=${contract.employee_id}|contract_id=${contract.id}|file_id=${id}`,
      tags: ['th79-hrm', 'contract']
    });

    const cloud = cloudinaryAssetFields(result, { deliveryType: 'authenticated' });
    await EmployeeContractFiles.create({
      id,
      employee_contract_id: contract.id,
      original_name: req.file.originalname,
      file_path: null,
      mime_type: req.file.mimetype,
      file_size: req.file.size,
      ...cloud,
      uploaded_by: req.auth.user.id,
      created_at: new Date()
    });

    await audit(req, { module: 'contracts', action: 'upload', recordType: 'contract_file', recordId: id, employeeId: contract.employee_id, description: `Tải file hợp đồng lên Cloudinary: ${req.file.originalname}` });
    return res.status(201).json({ id, storageProvider: 'cloudinary', protected: true });
  } catch (error) { next(error); }
});

router.get('/files/:id', can('contract.view'), async (req, res, next) => {
  try {
    const file = await EmployeeContractFiles.findOne({ id: Number(req.params.id) }).lean();
    if (!file) return res.status(404).end();

    if (file.storage_provider === 'cloudinary' && file.cloudinary_public_id) {
      const url = privateAssetUrl({
        publicId: file.cloudinary_public_id,
        format: file.cloudinary_format || path.extname(file.original_name || '').slice(1),
        resourceType: file.cloudinary_resource_type || 'image',
        deliveryType: file.cloudinary_delivery_type || 'authenticated'
      }, { attachment: String(req.query.download || '') === '1' });
      return res.redirect(302, url);
    }

    if (file.file_path) {
      const p = path.join(legacyDir, path.basename(file.file_path));
      if (fs.existsSync(p)) {
        res.type(file.mime_type || 'application/octet-stream');
        return res.sendFile(p);
      }
    }

    if (file.cloudinary_secure_url) return res.redirect(302, file.cloudinary_secure_url);
    return res.status(404).json({ message: 'File hợp đồng chưa được migrate lên Cloudinary hoặc file nguồn không còn tồn tại.' });
  } catch (error) { next(error); }
});

router.delete('/files/:id', can('contract.upload'), async (req, res, next) => {
  try {
    const file = await EmployeeContractFiles.findOne({ id: Number(req.params.id) }).lean();
    if (!file) return res.status(404).json({ message: 'Không tìm thấy file hợp đồng.' });

    if (file.storage_provider === 'cloudinary' && file.cloudinary_public_id) {
      await destroyCloudinaryAsset({
        publicId: file.cloudinary_public_id,
        resourceType: file.cloudinary_resource_type || 'image',
        deliveryType: file.cloudinary_delivery_type || 'authenticated'
      });
    } else if (file.file_path) {
      const p = path.join(legacyDir, path.basename(file.file_path));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    await EmployeeContractFiles.deleteOne({ id: file.id });
    return res.json({ ok: true });
  } catch (error) { next(error); }
});

export default router;
