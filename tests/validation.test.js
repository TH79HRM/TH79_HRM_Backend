import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValid,
  isValidDate,
  isValidEmail,
  isValidNumber,
  isValidPhone,
  isValidTime,
  validateDateRange
} from '../src/utils/validation.js';

test('date validation rejects impossible dates and accepts leap days', () => {
  assert.equal(isValidDate('2024-02-29'), true);
  assert.equal(isValidDate('2025-02-29'), false);
  assert.equal(isValidDate('2025-13-01'), false);
  assert.equal(isValidDate('01/02/2025'), false);
});

test('time, email, phone and numeric validators enforce field formats', () => {
  assert.equal(isValidTime('23:59'), true);
  assert.equal(isValidTime('24:00'), false);
  assert.equal(isValidEmail('person@example.vn'), true);
  assert.equal(isValidEmail('not-an-email'), false);
  assert.equal(isValidPhone('+84 912 345 678'), true);
  assert.equal(isValidPhone('abc'), false);
  assert.equal(isValidNumber('12.5', { min: 0, max: 24 }), true);
  assert.equal(isValidNumber('12.5', { integer: true }), false);
  assert.equal(isValidNumber('Infinity'), false);
});

test('range and assertion helpers return useful validation errors', () => {
  assert.doesNotThrow(() => validateDateRange('2025-01-01', '2025-01-02'));
  assert.throws(() => validateDateRange('2025-01-02', '2025-01-01'), /Ngày kết thúc/);
  assert.throws(() => assertValid(false, 'Invalid input.', 422), error => error.message === 'Invalid input.' && error.status === 422);
});
