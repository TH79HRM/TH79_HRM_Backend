import { Router } from 'express';
import { RecruitmentJobs, Candidates, CandidateApplications, TrainingCourses, EmployeeTraining, Employees, Branches, Departments, Positions } from '../models/raw.js';
import { can } from '../middleware/auth.js';
import { nextId } from '../utils/id.js';
import { audit } from '../services/auditService.js';
import { assertValid, isValidDate, isValidEmail, isValidNumber, isValidPhone } from '../utils/validation.js';
const router=Router();
router.get('/recruitment',can('recruitment.view'),async(req,res)=>{const [jobs,candidates,apps]=await Promise.all([RecruitmentJobs.find({}).sort({id:-1}).lean(),Candidates.find({}).sort({id:-1}).lean(),CandidateApplications.find({}).sort({id:-1}).lean()]);res.json({jobs,candidates,applications:apps});});
router.post('/recruitment/jobs',can('recruitment.manage'),async(req,res)=>{
  const jobTitle=String(req.body.job_title||'').trim();
  assertValid(jobTitle.length>=2&&jobTitle.length<=160,'Tên vị trí phải có từ 2 đến 160 ký tự.');
  assertValid(isValidNumber(req.body.headcount??1,{min:1,max:10000,integer:true}),'Số lượng tuyển phải là số nguyên từ 1 đến 10.000.');
  const status=req.body.status||'open';
  assertValid(['open','draft','paused','closed'].includes(status),'Trạng thái tuyển dụng không hợp lệ.');
  const branchId=await validateOptionalLookup(Branches,req.body.branch_id,'Chi nhánh');
  const departmentId=await validateOptionalLookup(Departments,req.body.department_id,'Phòng ban');
  const positionId=await validateOptionalLookup(Positions,req.body.position_id,'Chức vụ');
  const jobCode=String(req.body.job_code||`REC-${Date.now()}`).trim().toUpperCase();
  assertValid(/^[A-Z0-9._/-]{2,40}$/.test(jobCode),'Mã tuyển dụng chỉ được chứa chữ, số, dấu chấm, gạch chéo, gạch ngang hoặc gạch dưới.');
  assertValid(!(await RecruitmentJobs.findOne({job_code:jobCode}).lean()),'Mã tuyển dụng đã tồn tại.',409);
  if(req.body.description!==undefined)assertValid(typeof req.body.description==='string'&&req.body.description.length<=5000,'Mô tả vị trí không được vượt quá 5.000 ký tự.');
  if(req.body.open_date)assertValid(isValidDate(req.body.open_date),'Ngày mở vị trí không hợp lệ.');
  if(req.body.close_date){
    assertValid(isValidDate(req.body.close_date),'Ngày đóng vị trí không hợp lệ.');
    assertValid(Boolean(req.body.open_date)&&req.body.close_date>=req.body.open_date,'Ngày đóng phải sau hoặc bằng ngày mở.');
  }
  const id=await nextId('recruitment_jobs');
  const row={id,company_id:1,branch_id:branchId,department_id:departmentId,position_id:positionId,job_code:jobCode,job_title:jobTitle,headcount:Number(req.body.headcount||1),open_date:req.body.open_date||null,close_date:req.body.close_date||null,status,description:req.body.description||null,created_at:new Date()};
  await RecruitmentJobs.create(row);await audit(req,{module:'recruitment',action:'create',recordType:'job',recordId:id,description:`Tạo tin tuyển dụng: ${row.job_title}`});res.status(201).json({id});
});
router.post('/recruitment/candidates',can('recruitment.manage'),async(req,res)=>{
  const fullName=String(req.body.full_name||'').trim();
  assertValid(fullName.length>=2&&fullName.length<=120,'Họ tên ứng viên phải có từ 2 đến 120 ký tự.');
  if(req.body.email)assertValid(isValidEmail(String(req.body.email).trim()),'Email ứng viên không đúng định dạng.');
  if(req.body.phone)assertValid(isValidPhone(String(req.body.phone).trim()),'Số điện thoại ứng viên không đúng định dạng.');
  if(req.body.date_of_birth)assertValid(isValidDate(req.body.date_of_birth),'Ngày sinh ứng viên không hợp lệ.');
  if(req.body.date_of_birth)assertValid(req.body.date_of_birth<new Date().toISOString().slice(0,10),'Ngày sinh ứng viên phải nằm trong quá khứ.');
  assertValid(['unknown','male','female','other'].includes(req.body.gender||'unknown'),'Giới tính ứng viên không hợp lệ.');
  for(const [field,label,max] of [['address','Địa chỉ',500],['qualification','Trình độ',160],['source','Nguồn ứng viên',100],['note','Ghi chú',2000]]){
    if(req.body[field]!==undefined&&req.body[field]!==null)assertValid(typeof req.body[field]==='string'&&req.body[field].length<=max,`${label} không được vượt quá ${max} ký tự.`);
  }
  const id=await nextId('candidates');await Candidates.create({id,full_name:fullName,gender:req.body.gender||'unknown',date_of_birth:req.body.date_of_birth||null,phone:req.body.phone||null,email:req.body.email||null,address:req.body.address||null,qualification:req.body.qualification||null,source:req.body.source||null,note:req.body.note||null,created_at:new Date()});res.status(201).json({id});
});
router.get('/training',can('training.view'),async(req,res)=>{const courses=await TrainingCourses.find({}).sort({id:-1}).lean(),members=await EmployeeTraining.find({}).lean();res.json({courses:courses.map(c=>({...c,members:members.filter(m=>Number(m.training_id??m.course_id)===Number(c.id))}))});});
router.post('/training',can('training.manage'),async(req,res)=>{
  const courseName=String(req.body.course_name||req.body.training_name||'').trim();
  assertValid(courseName.length>=2&&courseName.length<=160,'Tên khóa học phải có từ 2 đến 160 ký tự.');
  if(req.body.start_date)assertValid(isValidDate(req.body.start_date),'Ngày bắt đầu khóa học không hợp lệ.');
  if(req.body.end_date){
    assertValid(isValidDate(req.body.end_date),'Ngày kết thúc khóa học không hợp lệ.');
    assertValid(Boolean(req.body.start_date)&&req.body.end_date>=req.body.start_date,'Ngày kết thúc phải sau hoặc bằng ngày bắt đầu.');
  }
  assertValid(isValidNumber(req.body.cost??0,{min:0,max:1_000_000_000_000}),'Chi phí phải là số không âm hợp lệ.');
  const status=req.body.status||'planned';
  assertValid(['planned','ongoing','completed','cancelled'].includes(status),'Trạng thái khóa học không hợp lệ.');
  const courseCode=String(req.body.training_code||req.body.course_code||`TR-${Date.now()}`).trim().toUpperCase();
  assertValid(/^[A-Z0-9._/-]{2,40}$/.test(courseCode),'Mã khóa học chỉ được chứa chữ, số, dấu chấm, gạch chéo, gạch ngang hoặc gạch dưới.');
  assertValid(!(await TrainingCourses.findOne({course_code:courseCode}).lean()),'Mã khóa học đã tồn tại.',409);
  if(req.body.provider!==undefined||req.body.trainer!==undefined)assertValid(String(req.body.provider||req.body.trainer||'').trim().length<=160,'Đơn vị đào tạo không được vượt quá 160 ký tự.');
  if(req.body.description!==undefined)assertValid(typeof req.body.description==='string'&&req.body.description.length<=5000,'Ghi chú khóa học không được vượt quá 5.000 ký tự.');
  const id=await nextId('training_courses');const row={id,course_code:courseCode,course_name:courseName,provider:req.body.trainer||req.body.provider||null,start_date:req.body.start_date||null,end_date:req.body.end_date||null,cost:Number(req.body.cost||0),status,note:[req.body.location?`Địa điểm: ${req.body.location}`:'',req.body.description||''].filter(Boolean).join(' · ')||null};await TrainingCourses.create(row);await audit(req,{module:'training',action:'create',recordType:'training',recordId:id,description:`Tạo khóa đào tạo: ${row.course_name}`});res.status(201).json({id});
});
async function validateOptionalLookup(Model,value,label){
  if(value===undefined||value===null||value==='')return null;
  assertValid(isValidNumber(value,{min:1,integer:true}),`${label} không hợp lệ.`);
  assertValid(await Model.findOne({id:Number(value)}).lean(),`Không tìm thấy ${label.toLowerCase()}.`);
  return Number(value);
}
export default router;
