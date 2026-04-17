'use strict';

/**
 * Integration tests for src/services/entities/importCoordinator.js.
 * pbFetch and withRetry are provided as mocks so no real HTTP is needed.
 */

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { runImport } = require('../src/services/entities/importCoordinator');

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a stateful mock pbFetch that:
 *   POST /v2/entities               → { data: { id: 'mock-uuid-{N}' } }
 *   PATCH /v2/entities/{id}         → { data: {} }
 *   PUT /v2/entities/{id}/...       → {}
 *   POST /v2/entities/{id}/...      → {}
 *
 * Returns { pbFetch, calls } where calls is the recorded call list.
 */
function makeMockPbFetch() {
  let counter = 0;
  const calls = [];

  async function pbFetch(method, path, body) {
    calls.push({ method, path, body });
    if (method === 'post' && path === '/v2/entities') {
      counter++;
      return { data: { id: `mock-uuid-${counter}` } };
    }
    // PATCH, PUT, POST to relationship endpoints, etc.
    return { data: {} };
  }

  return { pbFetch, calls };
}

/** withRetry that just calls fn() directly */
async function mockWithRetry(fn) {
  return fn();
}

/** No-op callbacks */
function makeCallbacks() {
  const progress = [];
  const logs = [];
  return {
    onProgress: (msg, pct) => progress.push({ msg, pct }),
    onLog: (level, msg, detail) => logs.push({ level, msg, detail }),
    progress,
    logs,
  };
}

function makeSignal(aborted = false) {
  return { abortSignal: { aborted } };
}

// ---------------------------------------------------------------------------
// Minimal CSV helpers
// ---------------------------------------------------------------------------

function featureCsv(rows) {
  const header = 'pb_id,ext_key,Name\n';
  const data = rows.map((r) => `${r.pbId || ''},${r.extKey || ''},${r.name || ''}`).join('\n');
  return header + data;
}

function featureMapping() {
  return {
    columns: {
      pb_id:   'pb_id',
      ext_key: 'ext_key',
      name:    'Name',
    },
  };
}

// ---------------------------------------------------------------------------
// Basic CREATE flow
// ---------------------------------------------------------------------------

describe('runImport — basic CREATE', () => {
  test('2 feature rows with no pb_id → 2 POST /v2/entities calls', async () => {
    const { pbFetch, calls } = makeMockPbFetch();
    const cb = makeCallbacks();

    const result = await runImport(
      { feature: { csvText: featureCsv([{ name: 'F1' }, { name: 'F2' }]) } },
      { feature: featureMapping() },
      {},
      {},
      pbFetch, mockWithRetry,
      cb,
      makeSignal(),
    );

    const createCalls = calls.filter((c) => c.method === 'post' && c.path === '/v2/entities');
    assert.equal(createCalls.length, 2);
    assert.equal(result.totalCreated, 2);
    assert.equal(result.totalUpdated, 0);
    assert.equal(result.totalErrors, 0);
  });

  test('result perEntity entry has correct entityType and counts', async () => {
    const { pbFetch } = makeMockPbFetch();
    const cb = makeCallbacks();

    const result = await runImport(
      { feature: { csvText: featureCsv([{ name: 'F1' }]) } },
      { feature: featureMapping() },
      {}, {},
      pbFetch, mockWithRetry, cb, makeSignal(),
    );

    assert.equal(result.perEntity.length, 1);
    assert.equal(result.perEntity[0].entityType, 'feature');
    assert.equal(result.perEntity[0].created, 1);
  });

  test('idCache updated after successful CREATE', async () => {
    // Verify by running a second type that references the first via ext_key
    // We do this indirectly: if idCache is updated, a subfeature with
    // parent_feat_ext_key should have its parent resolved inline.
    const { pbFetch, calls } = makeMockPbFetch();
    const cb = makeCallbacks();

    const featureRows = [{ name: 'Parent', extKey: 'FEAT-1' }];
    const subFeatureRows = [{ name: 'Child', extKey: 'SUB-1' }];

    const subCsv = 'pb_id,ext_key,Name,parent_feat_ext_key\n,,Child,FEAT-1';
    const subMapping = {
      // parent_feat_ext_key must be explicitly mapped — fallback no longer reads it
      columns: { pb_id: 'pb_id', ext_key: 'ext_key', name: 'Name', parent_feat_ext_key: 'parent_feat_ext_key' },
    };

    const result = await runImport(
      {
        feature:    { csvText: featureCsv(featureRows) },
        subfeature: { csvText: subCsv },
      },
      {
        feature:    featureMapping(),
        subfeature: subMapping,
      },
      {}, {},
      pbFetch, mockWithRetry, cb, makeSignal(),
    );

    assert.equal(result.totalCreated, 2);

    // The subfeature CREATE payload should contain an inline parent relationship
    const subCreateCall = calls.find(
      (c) => c.method === 'post' && c.path === '/v2/entities' &&
             c.body?.data?.type === 'subfeature'
    );
    assert.ok(subCreateCall, 'subfeature CREATE call not found');
    assert.ok(
      subCreateCall.body?.data?.relationships?.[0]?.type === 'parent',
      'expected inline parent relationship in subfeature CREATE payload'
    );
  });
});

// ---------------------------------------------------------------------------
// PATCH flow
// ---------------------------------------------------------------------------

describe('runImport — PATCH (rows with pb_id)', () => {
  test('rows with pb_id → PATCH /v2/entities/{id}', async () => {
    const { pbFetch, calls } = makeMockPbFetch();
    const cb = makeCallbacks();

    const csv = 'pb_id,ext_key,Name\naabbccdd-0000-0000-0000-000000000001,,Updated Name';
    const result = await runImport(
      { feature: { csvText: csv } },
      { feature: featureMapping() },
      {}, {},
      pbFetch, mockWithRetry, cb, makeSignal(),
    );

    const patchCalls = calls.filter((c) => c.method === 'patch');
    assert.equal(patchCalls.length, 1);
    assert.ok(patchCalls[0].path.includes('aabbccdd-0000-0000-0000-000000000001'));
    assert.equal(result.totalUpdated, 1);
    assert.equal(result.totalCreated, 0);
  });
});

// ---------------------------------------------------------------------------
// Mixed CREATE + PATCH
// ---------------------------------------------------------------------------

describe('runImport — mixed CREATE + PATCH', () => {
  test('one row with pb_id + one without → 1 PATCH + 1 POST', async () => {
    const { pbFetch, calls } = makeMockPbFetch();
    const cb = makeCallbacks();

    const csv = [
      'pb_id,ext_key,Name',
      'aabbccdd-0000-0000-0000-000000000001,,Existing',
      ',,New One',
    ].join('\n');

    const result = await runImport(
      { feature: { csvText: csv } },
      { feature: featureMapping() },
      {}, {},
      pbFetch, mockWithRetry, cb, makeSignal(),
    );

    assert.equal(result.totalCreated, 1);
    assert.equal(result.totalUpdated, 1);
    assert.equal(result.totalErrors, 0);

    const creates = calls.filter((c) => c.method === 'post' && c.path === '/v2/entities');
    const patches = calls.filter((c) => c.method === 'patch');
    assert.equal(creates.length, 1);
    assert.equal(patches.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Abort signal
// ---------------------------------------------------------------------------

describe('runImport — abort signal', () => {
  test('pre-aborted signal → stopped=true, no API calls', async () => {
    const { pbFetch, calls } = makeMockPbFetch();
    const cb = makeCallbacks();

    const result = await runImport(
      { feature: { csvText: featureCsv([{ name: 'F1' }, { name: 'F2' }]) } },
      { feature: featureMapping() },
      {}, {},
      pbFetch, mockWithRetry, cb,
      { abortSignal: { aborted: true } },
    );

    assert.equal(result.stopped, true);
    const createCalls = calls.filter((c) => c.method === 'post' && c.path === '/v2/entities');
    assert.equal(createCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// relationshipsOnly mode
// ---------------------------------------------------------------------------

describe('runImport — relationshipsOnly', () => {
  test('no CREATE/PATCH calls, perEntity stubs present', async () => {
    const { pbFetch, calls } = makeMockPbFetch();
    const cb = makeCallbacks();

    // Pre-seed rows that have pb_id so relationship pass has something to work with
    const csv = 'pb_id,ext_key,Name\naabbccdd-0000-0000-0000-000000000001,FEAT-1,My Feature';

    const result = await runImport(
      { feature: { csvText: csv } },
      { feature: featureMapping() },
      {},
      { relationshipsOnly: true },
      pbFetch, mockWithRetry, cb, makeSignal(),
    );

    const createOrPatchCalls = calls.filter(
      (c) => (c.method === 'post' && c.path === '/v2/entities') || c.method === 'patch'
    );
    assert.equal(createOrPatchCalls.length, 0);
    assert.ok(result.perEntity.length >= 1);
    assert.equal(result.perEntity[0].created, 0);
    assert.equal(result.perEntity[0].updated, 0);
  });
});

// ---------------------------------------------------------------------------
// autoGenerateExtKeys
// ---------------------------------------------------------------------------

describe('runImport — autoGenerateExtKeys', () => {
  test('rows without ext_key get auto-assigned keys with TYPE_CODE', async () => {
    const { pbFetch } = makeMockPbFetch();
    const cb = makeCallbacks();

    const csv = 'pb_id,ext_key,Name\n,,Alpha\n,,Beta';

    const result = await runImport(
      { feature: { csvText: csv } },
      { feature: featureMapping() },
      {},
      { autoGenerateExtKeys: true, workspaceCode: 'ACME' },
      pbFetch, mockWithRetry, cb, makeSignal(),
    );

    assert.ok(result.newIdsCsv, 'expected newIdsCsv to be present');
    assert.ok(result.newIdsCsv.includes('ACME-FEAT-1'));
    assert.ok(result.newIdsCsv.includes('ACME-FEAT-2'));
  });

  test('newIdsCsv includes pb_id returned from API', async () => {
    const { pbFetch } = makeMockPbFetch();
    const cb = makeCallbacks();

    const csv = 'pb_id,ext_key,Name\n,,Alpha';

    const result = await runImport(
      { feature: { csvText: csv } },
      { feature: featureMapping() },
      {},
      { autoGenerateExtKeys: true, workspaceCode: 'WS' },
      pbFetch, mockWithRetry, cb, makeSignal(),
    );

    assert.ok(result.newIdsCsv.includes('mock-uuid-1'));
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('runImport — API error handling', () => {
  test('API error on CREATE → counted in totalErrors, not thrown', async () => {
    let counter = 0;
    async function failingPbFetch(method, path) {
      if (method === 'post' && path === '/v2/entities') {
        throw Object.assign(new Error('Validation failed'), { status: 422 });
      }
      return { data: {} };
    }
    const cb = makeCallbacks();

    const result = await runImport(
      { feature: { csvText: featureCsv([{ name: 'Bad Feature' }]) } },
      { feature: featureMapping() },
      {}, {},
      failingPbFetch, mockWithRetry, cb, makeSignal(),
    );

    assert.equal(result.totalErrors, 1);
    assert.equal(result.totalCreated, 0);
    const errorLog = cb.logs.find((l) => l.level === 'error');
    assert.ok(errorLog, 'expected error log entry');
  });
});

// ---------------------------------------------------------------------------
// Empty CSV
// ---------------------------------------------------------------------------

describe('runImport — empty CSV', () => {
  test('header-only CSV → 0 created, 0 errors, warning logged', async () => {
    const { pbFetch } = makeMockPbFetch();
    const cb = makeCallbacks();

    const result = await runImport(
      { feature: { csvText: 'pb_id,ext_key,Name' } }, // header only, no data rows
      { feature: featureMapping() },
      {}, {},
      pbFetch, mockWithRetry, cb, makeSignal(),
    );

    assert.equal(result.totalCreated, 0);
    assert.equal(result.totalErrors, 0);
    const warnLog = cb.logs.find((l) => l.level === 'warn');
    assert.ok(warnLog, 'expected warning about no data rows');
  });
});
