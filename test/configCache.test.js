'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSchema, schemaToType, EXCLUDED_FIELD_IDS, STANDARD_FIELD_IDS } = require('../src/services/entities/configCache');

// ── normalizeSchema ──────────────────────────────────────────────────────────

test('normalizeSchema — passes through legacy string format unchanged', () => {
  assert.equal(normalizeSchema('NumberFieldValue'), 'NumberFieldValue');
  assert.equal(normalizeSchema('TextFieldValue'), 'TextFieldValue');
  assert.equal(normalizeSchema('RichTextFieldValue'), 'RichTextFieldValue');
  assert.equal(normalizeSchema('MultiSelectFieldValue'), 'MultiSelectFieldValue');
});

test('normalizeSchema — converts JSON Schema number to NumberFieldValue', () => {
  assert.equal(normalizeSchema({ type: 'number' }), 'NumberFieldValue');
});

test('normalizeSchema — converts JSON Schema string to TextFieldValue', () => {
  assert.equal(normalizeSchema({ type: 'string' }), 'TextFieldValue');
});

test('normalizeSchema — converts JSON Schema string+date to DateFieldValue', () => {
  assert.equal(normalizeSchema({ type: 'string', format: 'date' }), 'DateFieldValue');
});

test('normalizeSchema — converts JSON Schema string+richtext to RichTextFieldValue', () => {
  assert.equal(normalizeSchema({ type: 'string', format: 'richtext' }), 'RichTextFieldValue');
});

test('normalizeSchema — converts JSON Schema string+contentMediaType to RichTextFieldValue', () => {
  assert.equal(normalizeSchema({ type: 'string', contentMediaType: 'text/html' }), 'RichTextFieldValue');
});

test('normalizeSchema — converts JSON Schema boolean to BooleanFieldValue', () => {
  assert.equal(normalizeSchema({ type: 'boolean' }), 'BooleanFieldValue');
});

test('normalizeSchema — converts JSON Schema array to MultiSelectFieldValue', () => {
  assert.equal(normalizeSchema({ type: 'array' }), 'MultiSelectFieldValue');
});

test('normalizeSchema — converts JSON Schema object with email to MemberFieldValue', () => {
  assert.equal(normalizeSchema({ type: 'object', properties: { email: { type: 'string' } } }), 'MemberFieldValue');
});

test('normalizeSchema — converts JSON Schema object (no email) to SingleSelectFieldValue', () => {
  assert.equal(normalizeSchema({ type: 'object' }), 'SingleSelectFieldValue');
});

test('normalizeSchema — returns empty string for null/undefined/empty', () => {
  assert.equal(normalizeSchema(null), '');
  assert.equal(normalizeSchema(undefined), '');
  assert.equal(normalizeSchema(''), '');
});

test('normalizeSchema — returns empty string for non-string non-object', () => {
  assert.equal(normalizeSchema(42), '');
  assert.equal(normalizeSchema(true), '');
});

// ── schemaToType ─────────────────────────────────────────────────────────────

test('schemaToType — strips FieldValue suffix', () => {
  assert.equal(schemaToType('NumberFieldValue'), 'Number');
  assert.equal(schemaToType('TextFieldValue'), 'Text');
  assert.equal(schemaToType('MultiSelectFieldValue'), 'MultiSelect');
  assert.equal(schemaToType('SingleSelectFieldValue'), 'SingleSelect');
  assert.equal(schemaToType('MemberFieldValue'), 'Member');
  assert.equal(schemaToType('RichTextFieldValue'), 'RichText');
  assert.equal(schemaToType('DateFieldValue'), 'Date');
});

test('schemaToType — handles JSON Schema objects via normalizeSchema', () => {
  assert.equal(schemaToType({ type: 'number' }), 'Number');
  assert.equal(schemaToType({ type: 'array' }), 'MultiSelect');
});

test('schemaToType — returns Unknown for unrecognized input', () => {
  assert.equal(schemaToType(null), 'Unknown');
  assert.equal(schemaToType(''), 'Unknown');
});

// ── constants ────────────────────────────────────────────────────────────────

test('EXCLUDED_FIELD_IDS contains timeframe, health, progress', () => {
  assert.ok(EXCLUDED_FIELD_IDS.has('timeframe'));
  assert.ok(EXCLUDED_FIELD_IDS.has('health'));
  assert.ok(EXCLUDED_FIELD_IDS.has('progress'));
});

test('STANDARD_FIELD_IDS contains expected system fields', () => {
  for (const id of ['name', 'description', 'owner', 'status', 'teams', 'archived']) {
    assert.ok(STANDARD_FIELD_IDS.has(id), `expected ${id}`);
  }
});
