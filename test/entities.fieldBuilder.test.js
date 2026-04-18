'use strict';

/**
 * Unit tests for src/services/entities/fieldBuilder.js.
 * Pure functions — no HTTP mocking needed.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTimeframeFromDates,
  normalizeCustomValue,
  sanitizeDescription,
  buildCreatePayload,
  buildPatchPayload,
  buildFieldsObject,
} = require('../src/services/entities/fieldBuilder');

const { createIdCache } = require('../src/services/entities/idCache');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(systemFields = [], customFields = []) {
  return { systemFields, customFields };
}

function makeRow(overrides = {}) {
  return { _type: 'feature', _pbId: '', _extKey: '', name: 'Test Feature', ...overrides };
}

const EMPTY_CACHE = createIdCache();
const EMPTY_CONFIG = makeConfig();

// ---------------------------------------------------------------------------
// buildTimeframeFromDates
// ---------------------------------------------------------------------------

describe('buildTimeframeFromDates — null/invalid inputs', () => {
  test('both null → null', () => {
    assert.equal(buildTimeframeFromDates(null, null), null);
  });

  test('empty strings → null', () => {
    assert.equal(buildTimeframeFromDates('', ''), null);
  });

  test('both dates invalid format → null', () => {
    assert.equal(buildTimeframeFromDates('March 2026', 'also-bad'), null);
  });

  test('one invalid date → falls back to using the valid date for both', () => {
    // Invalid start + valid end: function uses end for both rather than returning null
    const tf = buildTimeframeFromDates('March 2026', '2026-03-31');
    assert.ok(tf !== null);
    assert.equal(tf.startDate, '2026-03-31');
    assert.equal(tf.endDate, '2026-03-31');
  });

  test('only start given → start = end (day granularity)', () => {
    const tf = buildTimeframeFromDates('2026-03-15', null);
    assert.ok(tf, 'expected non-null timeframe');
    assert.equal(tf.startDate, '2026-03-15');
    assert.equal(tf.endDate, '2026-03-15');
  });

  test('only end given → start = end', () => {
    const tf = buildTimeframeFromDates(null, '2026-06-01');
    assert.equal(tf.startDate, '2026-06-01');
    assert.equal(tf.endDate, '2026-06-01');
  });
});

describe('buildTimeframeFromDates — granularity detection', () => {
  test('arbitrary start/end → granularity: day', () => {
    const tf = buildTimeframeFromDates('2026-03-05', '2026-03-20');
    assert.equal(tf.granularity, 'day');
  });

  test('full calendar month → granularity: month', () => {
    const tf = buildTimeframeFromDates('2026-03-01', '2026-03-31');
    assert.equal(tf.granularity, 'month');
  });

  test('calendar quarter Jan–Mar (fiscal Jan) → granularity: quarter', () => {
    const tf = buildTimeframeFromDates('2026-01-01', '2026-03-31', 1);
    assert.equal(tf.granularity, 'quarter');
  });

  test('calendar year Jan–Dec → granularity: year', () => {
    const tf = buildTimeframeFromDates('2026-01-01', '2026-12-31', 1);
    assert.equal(tf.granularity, 'year');
  });

  test('start > end → auto-swapped, still valid', () => {
    const tf = buildTimeframeFromDates('2026-03-31', '2026-03-01');
    assert.equal(tf.startDate, '2026-03-01');
    assert.equal(tf.endDate, '2026-03-31');
  });

  test('returns startDate and endDate props', () => {
    const tf = buildTimeframeFromDates('2026-06-01', '2026-06-30');
    assert.equal(tf.startDate, '2026-06-01');
    assert.equal(tf.endDate, '2026-06-30');
  });
});

// ---------------------------------------------------------------------------
// normalizeCustomValue
// ---------------------------------------------------------------------------

describe('normalizeCustomValue — multiselect', () => {
  test('comma-separated string → array of {name}', () => {
    const result = normalizeCustomValue('A, B, C', 'multiselect', '');
    assert.deepEqual(result, [{ name: 'A' }, { name: 'B' }, { name: 'C' }]);
  });

  test('empty string → empty array', () => {
    const result = normalizeCustomValue('', 'multiselect', '');
    assert.deepEqual(result, []);
  });

  test('null → empty array', () => {
    const result = normalizeCustomValue(null, 'multiselect', '');
    assert.deepEqual(result, []);
  });
});

describe('normalizeCustomValue — singleselect', () => {
  test('string → { name }', () => {
    const result = normalizeCustomValue('High', 'singleselect', '');
    assert.deepEqual(result, { name: 'High' });
  });

  test('empty string → null', () => {
    assert.equal(normalizeCustomValue('', 'singleselect', ''), null);
  });
});

describe('normalizeCustomValue — member', () => {
  test('valid email → { email }', () => {
    const result = normalizeCustomValue('dev@example.com', 'member', '');
    assert.deepEqual(result, { email: 'dev@example.com' });
  });

  test('non-email string → null', () => {
    const result = normalizeCustomValue('not-an-email', 'member', '');
    assert.equal(result, null);
  });
});

describe('normalizeCustomValue — number', () => {
  test('integer string → number', () => {
    assert.equal(normalizeCustomValue('42', 'number', ''), 42);
  });

  test('decimal rounded to 2dp', () => {
    assert.equal(normalizeCustomValue('3.14159', 'number', ''), 3.14);
  });

  test('non-numeric string → null', () => {
    assert.equal(normalizeCustomValue('abc', 'number', ''), null);
  });
});

describe('normalizeCustomValue — date', () => {
  test('date string → passthrough', () => {
    assert.equal(normalizeCustomValue('2026-03-15', 'date', ''), '2026-03-15');
  });
});

describe('normalizeCustomValue — richtext', () => {
  test('plain text → sanitized (wrapped in <p>)', () => {
    const result = normalizeCustomValue('Hello world', 'richtext', '');
    assert.ok(result.includes('<p>') && result.includes('Hello world'));
  });
});

describe('normalizeCustomValue — text', () => {
  test('string → passthrough', () => {
    assert.equal(normalizeCustomValue('some text', 'text', ''), 'some text');
  });

  test('null → null', () => {
    assert.equal(normalizeCustomValue(null, 'text', ''), null);
  });
});

// ---------------------------------------------------------------------------
// sanitizeDescription
// ---------------------------------------------------------------------------

describe('sanitizeDescription', () => {
  test('null → null', () => {
    assert.equal(sanitizeDescription(null), null);
  });

  test('empty string → null', () => {
    assert.equal(sanitizeDescription(''), null);
  });

  test('plain text → wrapped in <p>', () => {
    const result = sanitizeDescription('Hello world');
    assert.equal(result, '<p>Hello world</p>');
  });

  test('newlines in plain text → <br/>', () => {
    const result = sanitizeDescription('line one\nline two');
    assert.ok(result.includes('<br/>'), `expected <br/>, got: ${result}`);
  });

  test('valid HTML → passes through (sanitized)', () => {
    const result = sanitizeDescription('<p>Hello <b>world</b></p>');
    assert.ok(result.includes('<p>') && result.includes('<b>'));
  });

  test('script tags → stripped', () => {
    const result = sanitizeDescription('<p>Safe</p><script>alert(1)</script>');
    assert.ok(!result.includes('<script>'), 'script tag not stripped');
  });
});

// ---------------------------------------------------------------------------
// buildCreatePayload
// ---------------------------------------------------------------------------

describe('buildCreatePayload — basic structure', () => {
  test('returns { data: { type, fields } }', () => {
    const row = makeRow({ name: 'My Feature' });
    const payload = buildCreatePayload(row, 'feature', EMPTY_CONFIG, EMPTY_CACHE, {});
    assert.equal(payload.data.type, 'feature');
    assert.ok(payload.data.fields);
  });

  test('name is always included on create', () => {
    const row = makeRow({ name: 'Hello' });
    const payload = buildCreatePayload(row, 'feature', EMPTY_CONFIG, EMPTY_CACHE, {});
    assert.equal(payload.data.fields.name, 'Hello');
  });

  test('empty name still sends name on create', () => {
    const row = makeRow({ name: '' });
    const payload = buildCreatePayload(row, 'feature', EMPTY_CONFIG, EMPTY_CACHE, {});
    assert.ok('name' in payload.data.fields);
  });

  test('name absent from CREATE payload when not in mapping (not a key in normalizedRow)', () => {
    // Simulate a row where the user did not map the name field — the key is absent entirely.
    // Previously the code always sent F.name = '' on create; now it requires mapped('name').
    const row = { _type: 'feature', _pbId: '', _extKey: '' };
    const payload = buildCreatePayload(row, 'feature', EMPTY_CONFIG, EMPTY_CACHE, {});
    assert.ok(!('name' in payload.data.fields), 'name must not appear in payload when not mapped');
  });

  test('name absent from PATCH payload when not in mapping', () => {
    const row = { _type: 'feature', _pbId: 'some-uuid', _extKey: '' };
    const payload = buildPatchPayload(row, 'feature', EMPTY_CONFIG, {});
    // PATCH returns { data: { fields } } in default set mode
    const fields = payload.data.fields || {};
    assert.ok(!('name' in fields), 'name must not appear in PATCH payload when not mapped');
  });

  test('owner → { email }', () => {
    const row = makeRow({ owner: 'dev@x.com' });
    const payload = buildCreatePayload(row, 'feature', EMPTY_CONFIG, EMPTY_CACHE, {});
    assert.deepEqual(payload.data.fields.owner, { email: 'dev@x.com' });
  });

  test('status → { name }', () => {
    const row = makeRow({ status: 'In Progress' });
    const payload = buildCreatePayload(row, 'feature', EMPTY_CONFIG, EMPTY_CACHE, {});
    assert.deepEqual(payload.data.fields.status, { name: 'In Progress' });
  });
});

describe('buildCreatePayload — teams singular/plural', () => {
  test('feature → teams as array', () => {
    const row = makeRow({ teams: 'Eng, PM' });
    const payload = buildCreatePayload(row, 'feature', EMPTY_CONFIG, EMPTY_CACHE, {});
    assert.ok(Array.isArray(payload.data.fields.teams));
    assert.equal(payload.data.fields.teams.length, 2);
    assert.equal(payload.data.fields.teams[0].name, 'Eng');
  });

  test('objective → teams (plural), all items included', () => {
    const row = makeRow({ _type: 'objective', name: 'My Obj', teams: 'Eng, PM' });
    const payload = buildCreatePayload(row, 'objective', EMPTY_CONFIG, EMPTY_CACHE, {});
    assert.ok(Array.isArray(payload.data.fields.teams));
    assert.equal(payload.data.fields.teams.length, 2);
    assert.equal(payload.data.fields.teams[0].name, 'Eng');
    assert.equal(payload.data.fields.teams[1].name, 'PM');
  });
});

describe('buildCreatePayload — inline parent from idCache', () => {
  test('parent resolved from idCache → included in relationships', () => {
    const cache = createIdCache();
    cache.set('feature', 'PARENT-1', 'parent-uuid-aaa');
    const row = makeRow({ _type: 'subfeature', name: 'Sub', parent_feat_ext_key: 'PARENT-1' });
    const payload = buildCreatePayload(row, 'subfeature', EMPTY_CONFIG, cache, {});
    assert.ok(Array.isArray(payload.data.relationships));
    assert.equal(payload.data.relationships[0].type, 'parent');
    assert.equal(payload.data.relationships[0].target.id, 'parent-uuid-aaa');
  });

  test('_parentSetInline flag set when parent resolved', () => {
    const cache = createIdCache();
    cache.set('feature', 'P1', 'feat-uuid');
    const row = makeRow({ _type: 'subfeature', name: 'Sub', parent_feat_ext_key: 'P1' });
    buildCreatePayload(row, 'subfeature', EMPTY_CONFIG, cache, {});
    assert.equal(row._parentSetInline, true);
  });

  test('no parent in cache → no relationships in payload', () => {
    const row = makeRow({ parent_feat_ext_key: 'MISSING-KEY' });
    const payload = buildCreatePayload(row, 'subfeature', EMPTY_CONFIG, EMPTY_CACHE, {});
    assert.equal(payload.data.relationships, undefined);
  });
});

describe('buildCreatePayload — timeframe', () => {
  test('timeframe fields build timeframe object', () => {
    const row = makeRow({
      'timeframe_start (YYYY-MM-DD)': '2026-01-01',
      'timeframe_end (YYYY-MM-DD)': '2026-03-31',
    });
    const payload = buildCreatePayload(row, 'feature', EMPTY_CONFIG, EMPTY_CACHE, {});
    assert.ok(payload.data.fields.timeframe);
    assert.equal(payload.data.fields.timeframe.startDate, '2026-01-01');
    assert.equal(payload.data.fields.timeframe.endDate, '2026-03-31');
  });

  test('product type: no timeframe field set', () => {
    const row = makeRow({
      _type: 'product', name: 'My Product',
      'timeframe_start (YYYY-MM-DD)': '2026-01-01',
    });
    const payload = buildCreatePayload(row, 'product', EMPTY_CONFIG, EMPTY_CACHE, {});
    assert.equal(payload.data.fields.timeframe, undefined);
  });
});

describe('buildCreatePayload — health', () => {
  test('health_status → health object', () => {
    const row = makeRow({ health_status: 'on_track', health_comment: 'Good' });
    const payload = buildCreatePayload(row, 'feature', EMPTY_CONFIG, EMPTY_CACHE, {});
    assert.equal(payload.data.fields.health.status, 'on_track');
    assert.equal(payload.data.fields.health.comment, 'Good');
    assert.equal(payload.data.fields.health.mode, 'manual');
  });

  test('health_updated_by (email) is ignored — PB does not accept createdBy via API', () => {
    const row = makeRow({ health_status: 'at_risk', 'health_updated_by (email)': 'pm@x.com' });
    const payload = buildCreatePayload(row, 'feature', EMPTY_CONFIG, EMPTY_CACHE, {});
    assert.equal(payload.data.fields.health.createdBy, undefined);
  });
});

// ---------------------------------------------------------------------------
// buildPatchPayload
// ---------------------------------------------------------------------------

describe('buildPatchPayload — set mode (default)', () => {
  test('returns { data: { fields } } when no clear markers', () => {
    // status must be non-empty; empty status on a PATCH generates a __clearField marker
    // which triggers patch-array format — that is correct behavior, not an error.
    const row = makeRow({ name: 'Updated', status: 'Active' });
    const payload = buildPatchPayload(row, 'feature', EMPTY_CONFIG, { multiSelectMode: 'set' });
    assert.ok(payload.data.fields, 'expected fields key');
    assert.equal(payload.data.patch, undefined);
  });

  test('name is set in fields', () => {
    const row = makeRow({ name: 'New Name', status: 'Active' }); // non-empty status avoids clear marker
    const payload = buildPatchPayload(row, 'feature', EMPTY_CONFIG, {});
    assert.equal(payload.data.fields.name, 'New Name');
  });
});

describe('buildPatchPayload — addItems mode', () => {
  test('returns { data: { patch: [...] } }', () => {
    const row = makeRow({ name: 'X' });
    const payload = buildPatchPayload(row, 'feature', EMPTY_CONFIG, { multiSelectMode: 'addItems' });
    assert.ok(Array.isArray(payload.data.patch), 'expected patch array');
    assert.equal(payload.data.fields, undefined);
  });

  test('patch ops use op: addItems for known multiselect fields', () => {
    // custom multiselect field
    const config = makeConfig(
      [],
      [{ id: 'cf-ms', name: 'Tags', displayType: 'MultiSelect', schema: 'MultiSelectFieldValue' }]
    );
    const row = makeRow({ 'custom__cf-ms': 'A, B' });
    const payload = buildPatchPayload(row, 'feature', config, { multiSelectMode: 'addItems' });
    const op = payload.data.patch.find((o) => o.path === 'cf-ms');
    assert.ok(op, 'expected patch op for cf-ms');
    assert.equal(op.op, 'addItems');
  });
});

describe('buildPatchPayload — clear markers', () => {
  test('empty status in set mode on update → __clearField marker → patch array with op: clear', () => {
    const row = makeRow({ name: 'X', status: '' });
    const payload = buildPatchPayload(row, 'feature', EMPTY_CONFIG, { multiSelectMode: 'set' });
    // clear marker is present → triggers patch array format
    assert.ok(Array.isArray(payload.data.patch));
    const clearOp = payload.data.patch.find((o) => o.path === 'status' && o.op === 'clear');
    assert.ok(clearOp, 'expected clear op for status');
  });
});

describe('buildPatchPayload — bypassEmptyCells', () => {
  test('empty description with bypassEmptyCells=true → omitted from fields', () => {
    const row = makeRow({ description: '' });
    const payload = buildPatchPayload(row, 'feature', EMPTY_CONFIG, {
      multiSelectMode: 'set',
      bypassEmptyCells: true,
    });
    // With bypassEmptyCells, empty non-status fields are skipped
    // status clear marker won't exist since status is also empty → triggers patch format
    // description should NOT appear
    const fieldsOrPatch = payload.data.fields || {};
    assert.equal(fieldsOrPatch.description, undefined);
  });
});

// ---------------------------------------------------------------------------
// buildFieldsObject — archived
// ---------------------------------------------------------------------------

describe('buildFieldsObject — archived field', () => {
  test('"TRUE" string → true boolean', () => {
    const row = makeRow({ archived: 'TRUE' });
    const fields = buildFieldsObject(row, 'feature', EMPTY_CONFIG, {}, 'create');
    assert.equal(fields.archived, true);
  });

  test('"FALSE" string → false boolean', () => {
    const row = makeRow({ archived: 'FALSE' });
    const fields = buildFieldsObject(row, 'feature', EMPTY_CONFIG, {}, 'create');
    assert.equal(fields.archived, false);
  });

  test('empty archived → not set', () => {
    const row = makeRow({ archived: '' });
    const fields = buildFieldsObject(row, 'feature', EMPTY_CONFIG, {}, 'create');
    assert.equal(fields.archived, undefined);
  });
});

// ---------------------------------------------------------------------------
// buildFieldsObject — workProgress
// ---------------------------------------------------------------------------

describe('buildFieldsObject — workProgress', () => {
  test('numeric string → { value, mode: "manual" }', () => {
    const row = makeRow({ workProgress: '75' });
    const fields = buildFieldsObject(row, 'feature', EMPTY_CONFIG, {}, 'create');
    assert.deepEqual(fields.workProgress, { value: 75, mode: 'manual' });
  });

  test('non-numeric → not set', () => {
    const row = makeRow({ workProgress: 'high' });
    const fields = buildFieldsObject(row, 'feature', EMPTY_CONFIG, {}, 'create');
    assert.equal(fields.workProgress, undefined);
  });
});
