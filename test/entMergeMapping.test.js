'use strict';

/**
 * Unit tests for entMergeMapping (public/entities-app.js lines 335-343).
 *
 * entMergeMapping is a pure function with no DOM or browser API dependencies,
 * but it lives in a browser-side file that references `window` at the top level,
 * making it unsuitable to require() directly in Node. The function is reproduced
 * verbatim below as a tested specification.
 *
 * SYNC RULE: if you change entMergeMapping in entities-app.js you must update
 * the copy here to match (and vice-versa).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Function under test — verbatim copy of entMergeMapping in entities-app.js
// ---------------------------------------------------------------------------
function entMergeMapping(auto, persisted, csvHeaders) {
  if (!persisted) return auto;
  const headerSet = new Set(csvHeaders);
  const valid = {};
  for (const [fieldId, csvHeader] of Object.entries(persisted.columns || {})) {
    if (headerSet.has(csvHeader)) valid[fieldId] = csvHeader;
  }
  return { columns: { ...auto.columns, ...valid } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('entMergeMapping — no persisted mapping', () => {
  test('null persisted → returns auto object unchanged', () => {
    const auto = { columns: { name: 'name', pb_id: 'pb_id' } };
    const result = entMergeMapping(auto, null, ['name', 'pb_id']);
    assert.strictEqual(result, auto);
  });

  test('undefined persisted → returns auto object unchanged', () => {
    const auto = { columns: { name: 'name' } };
    const result = entMergeMapping(auto, undefined, ['name']);
    assert.strictEqual(result, auto);
  });
});

describe('entMergeMapping — persisted column still in current CSV', () => {
  test('valid persisted entry overrides auto for the same field', () => {
    const auto      = { columns: { name: 'name', description: 'description' } };
    const persisted = { columns: { name: 'Feature Name' } };
    const result = entMergeMapping(auto, persisted, ['Feature Name', 'description']);
    assert.equal(result.columns.name, 'Feature Name');
  });

  test('auto-mapped fields not in persisted are kept as-is', () => {
    const auto      = { columns: { name: 'name', description: 'description' } };
    const persisted = { columns: { name: 'Feature Name' } };
    const result = entMergeMapping(auto, persisted, ['Feature Name', 'description']);
    assert.equal(result.columns.description, 'description');
  });

  test('persisted can map a field to a custom-named column', () => {
    const auto      = { columns: { name: 'name' } };
    const persisted = { columns: { parent_ext_key: 'My Parent Col' } };
    const result = entMergeMapping(auto, persisted, ['name', 'My Parent Col']);
    assert.equal(result.columns.parent_ext_key, 'My Parent Col');
  });
});

describe('entMergeMapping — persisted column NO LONGER in current CSV', () => {
  test('stale persisted column is filtered out; auto value survives', () => {
    // Previous CSV had column "Name" (capital N); new CSV has "name" (lowercase).
    const auto      = { columns: { name: 'name' } };
    const persisted = { columns: { name: 'Name' } };  // "Name" not in new CSV
    const result = entMergeMapping(auto, persisted, ['name', 'description']);
    // Stale persisted value dropped; auto value used
    assert.equal(result.columns.name, 'name');
  });

  test('entirely stale persisted mapping → result equals auto columns', () => {
    const auto      = { columns: { name: 'name', description: 'description' } };
    const persisted = { columns: { name: 'OldName', description: 'OldDesc' } };
    const result = entMergeMapping(auto, persisted, ['name', 'description']);
    // Neither stale column exists → both filtered; auto used for both
    assert.equal(result.columns.name, 'name');
    assert.equal(result.columns.description, 'description');
  });

  test('mixed persisted: one valid, one stale — only valid overrides', () => {
    const auto      = { columns: { name: 'name', description: 'description' } };
    const persisted = { columns: { name: 'Feature Name', description: 'OldDesc' } };
    const result = entMergeMapping(auto, persisted, ['name', 'Feature Name', 'description']);
    assert.equal(result.columns.name, 'Feature Name');   // valid persisted wins
    assert.equal(result.columns.description, 'description'); // stale filtered, auto survives
  });

  test('stale persisted field does not leak into result as an extra key', () => {
    const auto      = { columns: { name: 'name' } };
    const persisted = { columns: { parent_ext_key: 'OldParentCol' } };
    const result = entMergeMapping(auto, persisted, ['name']); // OldParentCol not in headers
    assert.ok(!('parent_ext_key' in result.columns), 'stale field must not appear in result');
  });
});

describe('entMergeMapping — edge cases', () => {
  test('empty persisted.columns → returns auto columns unchanged', () => {
    const auto      = { columns: { name: 'name' } };
    const persisted = { columns: {} };
    const result = entMergeMapping(auto, persisted, ['name']);
    assert.deepEqual(result.columns, { name: 'name' });
  });

  test('persisted with no columns key → treated as empty, auto returned', () => {
    const auto      = { columns: { name: 'name' } };
    const persisted = {};   // no .columns property
    const result = entMergeMapping(auto, persisted, ['name']);
    assert.deepEqual(result.columns, { name: 'name' });
  });

  test('auto with empty columns + valid persisted → persisted used', () => {
    const auto      = { columns: {} };
    const persisted = { columns: { name: 'Name' } };
    const result = entMergeMapping(auto, persisted, ['Name', 'Description']);
    assert.equal(result.columns.name, 'Name');
  });

  test('returns a new object — does not mutate auto', () => {
    const auto      = { columns: { name: 'name' } };
    const persisted = { columns: { name: 'Name' } };
    const result = entMergeMapping(auto, persisted, ['Name']);
    assert.notStrictEqual(result, auto);
    assert.equal(auto.columns.name, 'name', 'auto must not be mutated');
  });
});
