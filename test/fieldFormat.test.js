'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDate, formatCustomFieldValue, isMultiType, MULTI_TYPES } = require('../src/lib/fieldFormat');

// ── normalizeDate ────────────────────────────────────────────────────────────

test('normalizeDate — passes through valid ISO date', () => {
  assert.equal(normalizeDate('2025-03-15'), '2025-03-15');
});

test('normalizeDate — strips trailing T from truncated ISO timestamp', () => {
  assert.equal(normalizeDate('2025-02-21T'), '2025-02-21');
});

test('normalizeDate — trims whitespace', () => {
  assert.equal(normalizeDate('  2025-01-01  '), '2025-01-01');
});

test('normalizeDate — returns original on unparseable string', () => {
  assert.equal(normalizeDate('not-a-date'), 'not-a-date');
});

test('normalizeDate — returns original on empty string', () => {
  assert.equal(normalizeDate(''), '');
});

test('normalizeDate — parses US-style date (M/D/YYYY)', () => {
  const result = normalizeDate('3/15/2025');
  assert.equal(result, '2025-03-15');
});

test('normalizeDate — parses full ISO timestamp and returns date portion', () => {
  const result = normalizeDate('2025-06-01T12:30:00Z');
  assert.equal(result, '2025-06-01');
});

// ── formatCustomFieldValue ───────────────────────────────────────────────────

test('formatCustomFieldValue — number type returns Number', () => {
  assert.equal(formatCustomFieldValue('42.5', 'number'), 42.5);
});

test('formatCustomFieldValue — NaN number returns NaN', () => {
  assert.ok(Number.isNaN(formatCustomFieldValue('abc', 'number')));
});

test('formatCustomFieldValue — select returns { name }', () => {
  assert.deepEqual(formatCustomFieldValue('High', 'select'), { name: 'High' });
});

test('formatCustomFieldValue — multiselect splits on comma', () => {
  const result = formatCustomFieldValue('A, B, C', 'multiselect');
  assert.deepEqual(result, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
});

test('formatCustomFieldValue — multiselect filters empty tokens', () => {
  const result = formatCustomFieldValue('A,,B,', 'multiselect');
  assert.deepEqual(result, [{ name: 'A' }, { name: 'B' }]);
});

test('formatCustomFieldValue — tags splits on comma like multiselect', () => {
  const result = formatCustomFieldValue('tag1,tag2', 'tags');
  assert.deepEqual(result, [{ name: 'tag1' }, { name: 'tag2' }]);
});

test('formatCustomFieldValue — member returns { email }', () => {
  assert.deepEqual(formatCustomFieldValue(' alice@co.com ', 'member'), { email: 'alice@co.com' });
});

test('formatCustomFieldValue — date normalises the value', () => {
  assert.equal(formatCustomFieldValue('2025-03-15', 'date'), '2025-03-15');
});

test('formatCustomFieldValue — text returns raw value', () => {
  assert.equal(formatCustomFieldValue('hello world', 'text'), 'hello world');
});

test('formatCustomFieldValue — unknown type returns raw value', () => {
  assert.equal(formatCustomFieldValue('raw', 'unknown_type'), 'raw');
});

// ── isMultiType ──────────────────────────────────────────────────────────────

test('isMultiType — returns true for multiselect, member, tag, tags', () => {
  assert.equal(isMultiType('multiselect'), true);
  assert.equal(isMultiType('member'), true);
  assert.equal(isMultiType('tag'), true);
  assert.equal(isMultiType('tags'), true);
});

test('isMultiType — returns false for other types', () => {
  assert.equal(isMultiType('number'), false);
  assert.equal(isMultiType('text'), false);
  assert.equal(isMultiType('select'), false);
  assert.equal(isMultiType('date'), false);
});

test('MULTI_TYPES — is a Set with expected values', () => {
  assert.ok(MULTI_TYPES instanceof Set);
  assert.equal(MULTI_TYPES.size, 4);
});
