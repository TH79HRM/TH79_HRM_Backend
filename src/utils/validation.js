export function assertValid(condition, message, status = 400) {
  if (condition) return;
  const error = new Error(message);
  error.status = status;
  throw error;
}

export function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isValidTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export function isValidPhone(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/[\s().-]/g, '');
  return /^\+?\d{9,15}$/.test(normalized);
}

export function isValidNumber(value, { min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value === '' || value === null || value === undefined || typeof value === 'boolean') return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max && (!integer || Number.isInteger(number));
}

export function validateDateRange(start, end, startLabel = 'Ngày bắt đầu', endLabel = 'Ngày kết thúc') {
  assertValid(isValidDate(start), `${startLabel} không hợp lệ.`);
  assertValid(isValidDate(end), `${endLabel} không hợp lệ.`);
  assertValid(end >= start, `${endLabel} phải sau hoặc bằng ${startLabel.toLowerCase()}.`);
}
