'use strict';

/**
 * Unit tests for dependency relationship support (isBlockedBy / isBlocking).
 * Covers all 5 files changed: meta.js, exporter.js, migrationHelper.js,
 * fieldBuilder.js, and relationWriter.js.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { relationshipColumns }   = require('../src/services/entities/meta');
const { entityToRow }           = require('../src/services/entities/exporter');
const { applyMigrationMode }    = require('../src/services/entities/migrationHelper');
const { applyMapping }          = require('../src/services/entities/fieldBuilder');
const { writeRelations }        = require('../src/services/entities/relationWriter');
const { createIdCache }         = require('../src/services/entities/idCache');

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const UUID_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const UUID_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const UUID_C = 'cccccccc-0000-0000-0000-000000000003';
const UUID_SELF = 'eeeeeeee-0000-0000-0000-000000000099';

// Minimal entity config accepted by entityToRow / buildExportHeaders
const minConfig = { systemFields: [{ id: 'name', name: 'Name' }], customFields: [] };

// Minimal idCache backed by a plain store object
function makeIdCache(storeInit = {}) {
  const cache = createIdCache();
  for (const [type, map] of Object.entries(storeInit)) {
    for (const [key, id] of Object.entries(map)) {
      cache.set(type, key, id);
    }
  }
  return cache;
}

// pbFetch that records calls and returns empty success by default
function makePbFetch(calls) {
  return async (method, path, body) => {
    calls.push({ method, path, body });
    return {};
  };
}

// withRetry that just calls the fn directly (no actual retry)
async function withRetry(fn) { return fn(); }

const noLog = () => {};

// ─── 1. meta.js — relationshipColumns() ──────────────────────────────────────

describe('relationshipColumns — dep columns present for supported types', () => {
  test('feature includes blocked_by_ext_key and blocking_ext_key', () => {
    const cols = relationshipColumns('feature');
    assert.ok(cols.includes('blocked_by_ext_key'), 'missing blocked_by_ext_key');
    assert.ok(cols.includes('blocking_ext_key'),   'missing blocking_ext_key');
  });

  test('subfeature includes blocked_by_ext_key and blocking_ext_key', () => {
    const cols = relationshipColumns('subfeature');
    assert.ok(cols.includes('blocked_by_ext_key'));
    assert.ok(cols.includes('blocking_ext_key'));
  });

  test('initiative includes blocked_by_ext_key and blocking_ext_key', () => {
    const cols = relationshipColumns('initiative');
    assert.ok(cols.includes('blocked_by_ext_key'));
    assert.ok(cols.includes('blocking_ext_key'));
  });

  test('objective does NOT include dep columns', () => {
    const cols = relationshipColumns('objective');
    assert.ok(!cols.includes('blocked_by_ext_key'));
    assert.ok(!cols.includes('blocking_ext_key'));
  });

  test('keyResult does NOT include dep columns', () => {
    const cols = relationshipColumns('keyResult');
    assert.ok(!cols.includes('blocked_by_ext_key'));
    assert.ok(!cols.includes('blocking_ext_key'));
  });

  test('product does NOT include dep columns', () => {
    const cols = relationshipColumns('product');
    assert.ok(!cols.includes('blocked_by_ext_key'));
    assert.ok(!cols.includes('blocking_ext_key'));
  });

  test('release does NOT include dep columns', () => {
    const cols = relationshipColumns('release');
    assert.ok(!cols.includes('blocked_by_ext_key'));
    assert.ok(!cols.includes('blocking_ext_key'));
  });

  test('dep columns appear after connected_inis_ext_key', () => {
    const cols = relationshipColumns('feature');
    const iniIdx = cols.indexOf('connected_inis_ext_key');
    const bbyIdx = cols.indexOf('blocked_by_ext_key');
    assert.ok(iniIdx !== -1, 'connected_inis_ext_key missing');
    assert.ok(bbyIdx > iniIdx, 'blocked_by_ext_key should come after connected_inis_ext_key');
  });
});

// ─── 2. exporter.js — entityToRow() ──────────────────────────────────────────

describe('entityToRow — dep columns populated from API relationships', () => {
  function makeEntity(rels) {
    return {
      id: UUID_SELF,
      fields: { externalKey: 'FEAT-1', name: 'My Feature' },
      relationships: { data: rels },
    };
  }

  test('sets blocked_by_ext_key to target UUID when isBlockedBy rel present', () => {
    const entity = makeEntity([{ type: 'isBlockedBy', target: { id: UUID_A } }]);
    const row = entityToRow(entity, 'feature', minConfig);
    assert.equal(row['blocked_by_ext_key'], UUID_A);
  });

  test('sets blocking_ext_key to target UUID when isBlocking rel present', () => {
    const entity = makeEntity([{ type: 'isBlocking', target: { id: UUID_B } }]);
    const row = entityToRow(entity, 'feature', minConfig);
    assert.equal(row['blocking_ext_key'], UUID_B);
  });

  test('joins multiple isBlockedBy targets with ", "', () => {
    const entity = makeEntity([
      { type: 'isBlockedBy', target: { id: UUID_A } },
      { type: 'isBlockedBy', target: { id: UUID_B } },
    ]);
    const row = entityToRow(entity, 'feature', minConfig);
    assert.equal(row['blocked_by_ext_key'], `${UUID_A}, ${UUID_B}`);
  });

  test('joins multiple isBlocking targets with ", "', () => {
    const entity = makeEntity([
      { type: 'isBlocking', target: { id: UUID_A } },
      { type: 'isBlocking', target: { id: UUID_C } },
    ]);
    const row = entityToRow(entity, 'feature', minConfig);
    assert.equal(row['blocking_ext_key'], `${UUID_A}, ${UUID_C}`);
  });

  test('both dep columns populated when entity has both rel types', () => {
    const entity = makeEntity([
      { type: 'isBlockedBy', target: { id: UUID_A } },
      { type: 'isBlocking',  target: { id: UUID_B } },
    ]);
    const row = entityToRow(entity, 'feature', minConfig);
    assert.equal(row['blocked_by_ext_key'], UUID_A);
    assert.equal(row['blocking_ext_key'],   UUID_B);
  });

  test('dep columns absent when no dep rels present', () => {
    const entity = makeEntity([{ type: 'link', target: { id: UUID_A, type: 'release' } }]);
    const row = entityToRow(entity, 'feature', minConfig);
    assert.ok(!('blocked_by_ext_key' in row), 'blocked_by_ext_key should not be set');
    assert.ok(!('blocking_ext_key'   in row), 'blocking_ext_key should not be set');
  });

  test('dep columns absent when relationships array is empty', () => {
    const entity = makeEntity([]);
    const row = entityToRow(entity, 'feature', minConfig);
    assert.ok(!('blocked_by_ext_key' in row));
    assert.ok(!('blocking_ext_key'   in row));
  });

  test('initiative dep columns populated correctly', () => {
    const entity = makeEntity([{ type: 'isBlocking', target: { id: UUID_B } }]);
    const row = entityToRow(entity, 'initiative', minConfig);
    assert.equal(row['blocking_ext_key'], UUID_B);
  });

  test('link rels do not bleed into dep columns', () => {
    const entity = makeEntity([
      { type: 'link',       target: { id: UUID_A, type: 'objective' } },
      { type: 'isBlocking', target: { id: UUID_B } },
    ]);
    const row = entityToRow(entity, 'feature', minConfig);
    // The link rel should NOT appear in blocking_ext_key
    assert.equal(row['blocking_ext_key'], UUID_B);
    assert.ok(!row['blocking_ext_key'].includes(UUID_A));
  });
});

// ─── 3. migrationHelper.js — applyMigrationMode() ────────────────────────────

describe('applyMigrationMode — rewrites dep columns', () => {
  function runMigration(rows) {
    return applyMigrationMode({ feature: rows }, 'ACME');
  }

  test('rewrites UUID in blocked_by_ext_key to new ext_key', () => {
    const rows = [
      { pb_id: UUID_A, ext_key: UUID_A, blocked_by_ext_key: UUID_B },
      { pb_id: UUID_B, ext_key: UUID_B, blocked_by_ext_key: '' },
    ];
    const result = runMigration(rows);
    // UUID_B maps to ACME-FEAT-2 (second row in order)
    assert.equal(result.feature[0]['blocked_by_ext_key'], 'ACME-FEAT-2');
  });

  test('rewrites UUID in blocking_ext_key to new ext_key', () => {
    const rows = [
      { pb_id: UUID_A, ext_key: UUID_A, blocking_ext_key: UUID_B },
      { pb_id: UUID_B, ext_key: UUID_B, blocking_ext_key: '' },
    ];
    const result = runMigration(rows);
    assert.equal(result.feature[0]['blocking_ext_key'], 'ACME-FEAT-2');
  });

  test('rewrites multiple comma-separated UUIDs in blocked_by_ext_key', () => {
    const rows = [
      { pb_id: UUID_A, ext_key: UUID_A, blocked_by_ext_key: `${UUID_B}, ${UUID_C}` },
      { pb_id: UUID_B, ext_key: UUID_B, blocked_by_ext_key: '' },
      { pb_id: UUID_C, ext_key: UUID_C, blocked_by_ext_key: '' },
    ];
    const result = runMigration(rows);
    assert.equal(result.feature[0]['blocked_by_ext_key'], 'ACME-FEAT-2, ACME-FEAT-3');
  });

  test('preserves non-UUID values in dep columns unchanged', () => {
    const rows = [
      { pb_id: UUID_A, ext_key: UUID_A, blocked_by_ext_key: 'EXISTING-KEY' },
    ];
    const result = runMigration(rows);
    assert.equal(result.feature[0]['blocked_by_ext_key'], 'EXISTING-KEY');
  });

  test('leaves empty dep columns empty', () => {
    const rows = [{ pb_id: UUID_A, ext_key: UUID_A, blocked_by_ext_key: '', blocking_ext_key: '' }];
    const result = runMigration(rows);
    assert.equal(result.feature[0]['blocked_by_ext_key'], '');
    assert.equal(result.feature[0]['blocking_ext_key'], '');
  });
});

// ─── 4. fieldBuilder.js — applyMapping() fallback ────────────────────────────

describe('applyMapping — reads dep columns as fallback', () => {
  const emptyMapping = { columns: {} };

  test('reads blocked_by_ext_key from CSV row when not in mapping', () => {
    const csvRows = [{ blocked_by_ext_key: UUID_A, Name: 'Test' }];
    const [row] = applyMapping(csvRows, 'feature', emptyMapping);
    assert.equal(row['blocked_by_ext_key'], UUID_A);
  });

  test('reads blocking_ext_key from CSV row when not in mapping', () => {
    const csvRows = [{ blocking_ext_key: UUID_B, Name: 'Test' }];
    const [row] = applyMapping(csvRows, 'feature', emptyMapping);
    assert.equal(row['blocking_ext_key'], UUID_B);
  });

  test('returns empty string for dep columns absent from CSV row', () => {
    const csvRows = [{ Name: 'Test' }];
    const [row] = applyMapping(csvRows, 'feature', emptyMapping);
    assert.equal(row['blocked_by_ext_key'], '');
    assert.equal(row['blocking_ext_key'],   '');
  });

  test('mapped dep column takes precedence over fallback', () => {
    const mapping = { columns: { blocked_by_ext_key: 'My Dep Column' } };
    const csvRows = [{ 'My Dep Column': UUID_A, blocked_by_ext_key: 'should-be-ignored', Name: 'Test' }];
    const [row] = applyMapping(csvRows, 'feature', mapping);
    assert.equal(row['blocked_by_ext_key'], UUID_A);
  });
});

// ─── 5. relationWriter.js — writeRelations() passes 6 + 7 ────────────────────

describe('writeRelations — isBlockedBy pass (pass 6)', () => {
  test('posts isBlockedBy relationship using UUID token', async () => {
    const calls = [];
    const cache = makeIdCache();
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      blocked_by_ext_key: UUID_A,
    }];

    await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);

    const depCall = calls.find((c) => c.path.includes(UUID_SELF) && c.body?.data?.type === 'isBlockedBy');
    assert.ok(depCall, 'expected isBlockedBy POST call');
    assert.equal(depCall.method, 'post');
    assert.equal(depCall.body.data.target.id, UUID_A);
  });

  test('resolves ext_key target across feature type', async () => {
    const calls = [];
    const cache = makeIdCache({ feature: { 'TARGET-FEAT': UUID_B } });
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      blocked_by_ext_key: 'TARGET-FEAT',
    }];

    await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);

    const depCall = calls.find((c) => c.body?.data?.type === 'isBlockedBy');
    assert.ok(depCall);
    assert.equal(depCall.body.data.target.id, UUID_B);
  });

  test('resolves ext_key target across subfeature type', async () => {
    const calls = [];
    const cache = makeIdCache({ subfeature: { 'TARGET-SF': UUID_B } });
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      blocked_by_ext_key: 'TARGET-SF',
    }];

    await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);

    const depCall = calls.find((c) => c.body?.data?.type === 'isBlockedBy');
    assert.ok(depCall, 'should resolve target from subfeature cache');
    assert.equal(depCall.body.data.target.id, UUID_B);
  });

  test('resolves ext_key target across initiative type', async () => {
    const calls = [];
    const cache = makeIdCache({ initiative: { 'TARGET-INI': UUID_C } });
    const rows = [{
      _type: 'initiative', _pbId: UUID_SELF, _extKey: 'INI-1',
      blocked_by_ext_key: 'TARGET-INI',
    }];

    await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);

    const depCall = calls.find((c) => c.body?.data?.type === 'isBlockedBy');
    assert.ok(depCall, 'should resolve target from initiative cache');
    assert.equal(depCall.body.data.target.id, UUID_C);
  });

  test('skips unresolvable target and does not increment errors', async () => {
    const calls = [];
    const cache = makeIdCache();
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      blocked_by_ext_key: 'UNKNOWN-KEY',
    }];

    const result = await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);

    assert.equal(calls.filter((c) => c.body?.data?.type === 'isBlockedBy').length, 0);
    assert.equal(result.errors, 0);
  });

  test('skips self-link (selfId === targetId)', async () => {
    const calls = [];
    const cache = makeIdCache();
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      blocked_by_ext_key: UUID_SELF, // points at itself
    }];

    await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);

    assert.equal(calls.filter((c) => c.body?.data?.type === 'isBlockedBy').length, 0);
  });

  test('deduplicates repeated target tokens in same row', async () => {
    const calls = [];
    const cache = makeIdCache();
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      blocked_by_ext_key: `${UUID_A}, ${UUID_A}`,
    }];

    await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);

    const depCalls = calls.filter((c) => c.body?.data?.type === 'isBlockedBy');
    assert.equal(depCalls.length, 1, 'duplicate target should only be written once');
  });

  test('counts successful isBlockedBy writes in relationshipLinks', async () => {
    const calls = [];
    const cache = makeIdCache();
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      blocked_by_ext_key: `${UUID_A}, ${UUID_B}`,
    }];

    const result = await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);
    assert.equal(result.relationshipLinks, 2);
    assert.equal(result.errors, 0);
  });

  test('treats 409 as idempotent success (no error increment)', async () => {
    const cache = makeIdCache();
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      blocked_by_ext_key: UUID_A,
    }];
    const pbFetch409 = async () => { const e = new Error('409'); e.status = 409; throw e; };

    const result = await writeRelations(rows, cache, pbFetch409, withRetry, noLog);

    assert.equal(result.errors, 0);
    assert.equal(result.relationshipLinks, 1, '409 should count as success');
  });

  test('increments errors on non-409 failure', async () => {
    const cache = makeIdCache();
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      blocked_by_ext_key: UUID_A,
    }];
    const pbFetchFail = async () => { throw new Error('500 Server Error'); };

    const result = await writeRelations(rows, cache, pbFetchFail, withRetry, noLog);

    assert.equal(result.errors, 1);
  });
});

describe('writeRelations — isBlocking pass (pass 7)', () => {
  // Temporary API hotfix: blocking_ext_key is currently written by posting
  // isBlockedBy from the target side because the direct isBlocking route can
  // return 500 for already-existing pairs.
  test('posts reverse isBlockedBy relationship for the temporary API hotfix', async () => {
    const calls = [];
    const cache = makeIdCache();
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      blocking_ext_key: UUID_A,
    }];

    await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);

    const depCall = calls.find((c) => c.path.includes(UUID_A) && c.body?.data?.type === 'isBlockedBy');
    assert.ok(depCall, 'expected reversed isBlockedBy POST call');
    assert.equal(depCall.body.data.target.id, UUID_SELF);
  });

  test('subfeature rows are processed for the temporary hotfix path', async () => {
    const calls = [];
    const cache = makeIdCache();
    const rows = [{
      _type: 'subfeature', _pbId: UUID_SELF, _extKey: 'SF-1',
      blocking_ext_key: UUID_B,
    }];

    await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);

    const depCall = calls.find((c) => c.path.includes(UUID_B) && c.body?.data?.type === 'isBlockedBy');
    assert.ok(depCall);
    assert.equal(depCall.body.data.target.id, UUID_SELF);
  });

  test('initiative rows are processed for the temporary hotfix path', async () => {
    const calls = [];
    const cache = makeIdCache();
    const rows = [{
      _type: 'initiative', _pbId: UUID_SELF, _extKey: 'INI-1',
      blocking_ext_key: UUID_C,
    }];

    await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);

    const depCall = calls.find((c) => c.path.includes(UUID_C) && c.body?.data?.type === 'isBlockedBy');
    assert.ok(depCall);
    assert.equal(depCall.body.data.target.id, UUID_SELF);
  });

  test('both dependency directions are written in the same run under the hotfix', async () => {
    const calls = [];
    const cache = makeIdCache();
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      blocked_by_ext_key: UUID_A,
      blocking_ext_key:   UUID_B,
    }];

    const result = await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);

    const bby = calls.find((c) => c.path.includes(UUID_SELF) && c.body?.data?.type === 'isBlockedBy' && c.body.data.target.id === UUID_A);
    const blk = calls.find((c) => c.path.includes(UUID_B) && c.body?.data?.type === 'isBlockedBy' && c.body.data.target.id === UUID_SELF);
    assert.ok(bby, 'isBlockedBy call missing');
    assert.ok(blk, 'reversed isBlockedBy hotfix call missing');
    assert.equal(result.relationshipLinks, 2);
  });

  test('treats 409 as idempotent success for the temporary hotfix path', async () => {
    const cache = makeIdCache();
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      blocking_ext_key: UUID_A,
    }];
    const pbFetch409 = async () => { const e = new Error('409'); e.status = 409; throw e; };

    const result = await writeRelations(rows, cache, pbFetch409, withRetry, noLog);

    assert.equal(result.errors, 0);
    assert.equal(result.relationshipLinks, 1);
  });
});

describe('writeRelations — dep columns do not affect other passes', () => {
  test('rows without dep columns produce no dep API calls', async () => {
    const calls = [];
    const cache = makeIdCache();
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      connected_inis_ext_key: UUID_A, // non-dep column
    }];

    await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);

    assert.ok(!calls.some((c) => c.body?.data?.type === 'isBlockedBy'));
    assert.ok(!calls.some((c) => c.body?.data?.type === 'isBlocking'));
  });

  test('dep relationship URL uses encoded selfId', async () => {
    const calls = [];
    const cache = makeIdCache();
    const rows = [{
      _type: 'feature', _pbId: UUID_SELF, _extKey: 'FEAT-1',
      blocked_by_ext_key: UUID_A,
    }];

    await writeRelations(rows, cache, makePbFetch(calls), withRetry, noLog);

    const depCall = calls.find((c) => c.body?.data?.type === 'isBlockedBy');
    assert.ok(depCall.path.includes(encodeURIComponent(UUID_SELF)));
    assert.ok(depCall.path.endsWith('/relationships'));
  });
});
