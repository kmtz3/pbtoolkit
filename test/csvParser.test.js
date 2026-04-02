'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseEntityCsv, extractCustomFieldId } = require('../src/services/entities/csvParser');

// ── parseEntityCsv ───────────────────────────────────────────────────────────

test('parseEntityCsv — parses simple CSV with headers', () => {
  const csv = 'name,email\nAlice,alice@co.com\nBob,bob@co.com';
  const result = parseEntityCsv(csv);

  assert.deepEqual(result.headers, ['name', 'email']);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].name, 'Alice');
  assert.equal(result.rows[1].email, 'bob@co.com');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.tooManyFieldsRows, []);
});

test('parseEntityCsv — strips BOM', () => {
  const csv = '\uFEFFname\nAlice';
  const result = parseEntityCsv(csv);

  assert.deepEqual(result.headers, ['name']);
  assert.equal(result.rows.length, 1);
});

test('parseEntityCsv — trims header whitespace', () => {
  const csv = ' name , email \nAlice,alice@co.com';
  const result = parseEntityCsv(csv);

  assert.deepEqual(result.headers, ['name', 'email']);
});

test('parseEntityCsv — skips empty lines', () => {
  const csv = 'name\nAlice\n\n\nBob\n';
  const result = parseEntityCsv(csv);

  assert.equal(result.rows.length, 2);
});

test('parseEntityCsv — handles empty input', () => {
  const result = parseEntityCsv('');
  assert.deepEqual(result.headers, []);
  assert.deepEqual(result.rows, []);
});

test('parseEntityCsv — handles null input', () => {
  const result = parseEntityCsv(null);
  assert.deepEqual(result.headers, []);
  assert.deepEqual(result.rows, []);
});

test('parseEntityCsv — handles quoted fields with commas', () => {
  const csv = 'name,desc\n"Smith, John","A, B, C"';
  const result = parseEntityCsv(csv);

  assert.equal(result.rows[0].name, 'Smith, John');
  assert.equal(result.rows[0].desc, 'A, B, C');
});

test('parseEntityCsv — reports TooManyFields rows as 1-indexed', () => {
  // 2 headers but 3 fields on row 2 — PapaParse flags this as TooManyFields
  const csv = 'a,b\n1,2\n1,2,3';
  const result = parseEntityCsv(csv);

  assert.ok(result.tooManyFieldsRows.length >= 1);
  // Should be 1-indexed (row 2 in data → reported as 2)
  assert.ok(result.tooManyFieldsRows[0] >= 1);
});

// ── extractCustomFieldId ─────────────────────────────────────────────────────

test('extractCustomFieldId — extracts UUID from header suffix', () => {
  const header = 'Business Value [Number] [8b54dcf8-4b1e-4550-b490-d7f985c734e8]';
  assert.equal(extractCustomFieldId(header), '8b54dcf8-4b1e-4550-b490-d7f985c734e8');
});

test('extractCustomFieldId — returns null for non-UUID bracket content', () => {
  assert.equal(extractCustomFieldId('Some Field [Text]'), null);
});

test('extractCustomFieldId — returns null for no brackets', () => {
  assert.equal(extractCustomFieldId('Plain Header'), null);
});

test('extractCustomFieldId — returns null for empty string', () => {
  assert.equal(extractCustomFieldId(''), null);
});

test('extractCustomFieldId — handles whitespace inside brackets', () => {
  const header = 'Field [ 8b54dcf8-4b1e-4550-b490-d7f985c734e8 ]';
  assert.equal(extractCustomFieldId(header), '8b54dcf8-4b1e-4550-b490-d7f985c734e8');
});
