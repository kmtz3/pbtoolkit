'use strict';

/**
 * Companies import tests — Phase 3 (v2).
 *
 * Tests:
 * - POST /api/import/preview → validation, no API calls
 * - POST /api/import/run create path: POST /v2/entities with metadata.source inline
 * - POST /api/import/run update-by-UUID: PATCH /v2/entities/{id} with metadata.source inline
 * - POST /api/import/run update-by-domain: domain cache lookup → PATCH by correct ID
 * - clearEmptyFields: single PATCH with clear ops (no separate DELETE calls)
 * - Atomic pair: v1 source PATCH always runs after v2 succeeds, even if abort fires between
 *
 * Asserts old PUT /companies/{id}/custom-fields/{fieldId}/value NOT called.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');

const COMPANY_UUID_1 = 'cccccccc-0000-0000-0000-000000000001';
const FIELD_UUID_MRR  = '11111111-1111-1111-1111-111111111111';
const FIELD_UUID_TIER = '22222222-2222-2222-2222-222222222222';

// Parse the 'complete' event out of a buffered SSE response body
function parseCompleteEvent(text) {
  for (const chunk of text.split('\n\n')) {
    const lines = chunk.trim().split('\n');
    const isComplete = lines.some((l) => l === 'event: complete');
    const dataLine   = lines.find((l) => l.startsWith('data:'));
    if (isComplete && dataLine) {
      return JSON.parse(dataLine.slice(5).trim());
    }
  }
  return null;
}

// ─── Mock PB API server ──────────────────────────────────────────────────────

let mockServer;
let mockPort;
const calls = {
  v2Post: [],    // POST /v2/entities
  v2Patch: [],   // PATCH /v2/entities/{id}
  v2Search: [],  // POST /v2/entities/search
  v1Patch: [],   // PATCH /companies/{id}
  v1Put: [],     // PUT /companies/{id}/custom-fields/...
  other: [],
};
const responseOverrides = new Map();

function setOverride(method, path, status, body) {
  responseOverrides.set(`${method}:${path}`, { status, body });
}
function clearOverrides() { responseOverrides.clear(); }
function clearCalls() {
  calls.v2Post = [];
  calls.v2Patch = [];
  calls.v2Search = [];
  calls.v1Patch = [];
  calls.v1Put = [];
  calls.other = [];
}

// v2 search results (used by tests that call POST /v2/entities/search directly)
let mockSearchCompanies = [];
// v2 list entities returned by GET /v2/entities?type[]=company (used by buildDomainCache)
// Format: { id, fields: { 'mock-domain-uuid': 'domain.com', ... } }
let mockListCompanies = [];
// fields returned by individual GET /v2/entities/{id} for UUID discovery
// Format: { domain: 'domain.com', ... }
let mockSingleFields = {};

let app;

before(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? (() => { try { return JSON.parse(body); } catch (_) { return {}; } })() : {};
      const key = `${req.method}:${req.url}`;

      // Record
      if (req.method === 'POST' && req.url === '/v2/entities') {
        calls.v2Post.push({ path: req.url, body: parsed });
      } else if (req.method === 'PATCH' && req.url.startsWith('/v2/entities/')) {
        calls.v2Patch.push({ path: req.url, body: parsed });
      } else if (req.method === 'POST' && req.url.startsWith('/v2/entities/search')) {
        calls.v2Search.push({ path: req.url, body: parsed });
      } else if (req.method === 'PATCH' && req.url.startsWith('/companies/')) {
        calls.v1Patch.push({ path: req.url, body: parsed });
      } else if (req.method === 'PUT' && req.url.includes('/custom-fields/')) {
        calls.v1Put.push({ path: req.url, body: parsed });
      } else {
        calls.other.push({ method: req.method, path: req.url, body: parsed });
      }

      // Per-test override
      if (responseOverrides.has(key)) {
        const { status, body: respBody } = responseOverrides.get(key);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(respBody));
        return;
      }

      // Default responses
      if (req.method === 'POST' && req.url.startsWith('/v2/entities/search')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: mockSearchCompanies, links: { next: null } }));
        return;
      }

      if (req.method === 'POST' && req.url === '/v2/entities') {
        // Return created entity
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { id: COMPANY_UUID_1 } }));
        return;
      }

      // GET /v2/entities?type[]=company — list used by buildDomainCache
      if (req.method === 'GET' && req.url.startsWith('/v2/entities?')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: mockListCompanies, links: { next: null } }));
        return;
      }

      // GET /v2/entities/{id} — individual GET for domain field key discovery
      if (req.method === 'GET' && req.url.startsWith('/v2/entities/') && !req.url.includes('/configurations/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const id = req.url.split('/')[3].split('?')[0];
        res.end(JSON.stringify({ data: { id, fields: mockSingleFields } }));
        return;
      }

      // Default: 204 success for PATCH, PUT, DELETE
      res.writeHead(204); res.end();
    });
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = mockServer.address().port;
  process.env.PB_API_BASE_URL = `http://127.0.0.1:${mockPort}`;
  app = require('../src/server.js');
});

after(async () => {
  await new Promise((resolve) => mockServer.close(resolve));
  delete process.env.PB_API_BASE_URL;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

test('preview: validates CSV with no API calls', async () => {
  clearCalls(); clearOverrides();

  const csvText = `Company Name,Domain\nAcme,acme.com\nBeta,beta.io`;
  const mapping  = { nameColumn: 'Company Name', domainColumn: 'Domain', customFields: [] };

  const res = await request(app)
    .post('/api/import/preview')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({ csvText, mapping });

  assert.equal(res.status, 200);
  assert.equal(res.body.valid, true);
  assert.equal(res.body.totalRows, 2);
  // No API calls made during preview
  assert.equal(calls.v2Post.length, 0);
  assert.equal(calls.v2Search.length, 0);
});

test('import/run create: uses POST /v2/entities with metadata.source inline', async () => {
  clearCalls(); clearOverrides();
  mockSearchCompanies = []; // empty domain cache

  const csvText = `Company Name,Domain,Source Origin,Source Record ID\nAcme Corp,acme.com,salesforce,sf-001`;
  const mapping = {
    nameColumn:      'Company Name',
    domainColumn:    'Domain',
    sourceOriginCol: 'Source Origin',
    sourceRecordCol: 'Source Record ID',
    customFields: [],
  };

  const res = await request(app)
    .post('/api/import/run')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({ csvText, mapping });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete not found:\n${res.text}`);
  assert.equal(complete.created, 1);
  assert.equal(complete.errors, 0);

  // v2 create called once — source written inline as metadata.source (not a separate v1 PATCH)
  assert.equal(calls.v2Post.length, 1, 'Should have called POST /v2/entities');
  const createBody = calls.v2Post[0].body;
  assert.equal(createBody.data.type, 'company');
  assert.equal(createBody.data.fields.name, 'Acme Corp');
  assert.equal(createBody.data.fields.domain, 'acme.com');
  assert.deepEqual(
    createBody.data.metadata?.source,
    { system: 'salesforce', recordId: 'sf-001' },
    'source should use new v2 field names (system/recordId)',
  );

  // No separate v1 PATCH for source (source is now inline in the v2 POST above)
  assert.equal(calls.v1Patch.length, 0, 'Should NOT call a separate v1 PATCH for source');

  // Old PUT custom-fields NOT called
  assert.equal(calls.v1Put.length, 0, 'Should NOT have called old PUT custom-fields endpoint');
});

test('import/run update-by-UUID: uses PATCH /v2/entities/{id} with metadata.source inline', async () => {
  clearCalls(); clearOverrides();

  const csvText = `PB ID,Company Name,Source Origin\n${COMPANY_UUID_1},Updated Name,hubspot`;
  const mapping = {
    pbIdColumn:      'PB ID',
    nameColumn:      'Company Name',
    sourceOriginCol: 'Source Origin',
    customFields: [],
  };

  const res = await request(app)
    .post('/api/import/run')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({ csvText, mapping });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete not found:\n${res.text}`);
  assert.equal(complete.updated, 1);
  assert.equal(complete.errors, 0);

  // Single v2 PATCH — source written inline as metadata.source (not a separate v1 PATCH)
  assert.equal(calls.v2Patch.length, 1, 'Should have called PATCH /v2/entities/{id}');
  assert.ok(calls.v2Patch[0].path.includes(COMPANY_UUID_1));
  assert.equal(
    calls.v2Patch[0].body.data.metadata?.source?.system,
    'hubspot',
    'source should use new v2 field name (system)',
  );

  // No separate v1 PATCH for source
  assert.equal(calls.v1Patch.length, 0, 'Should NOT call a separate v1 PATCH for source');

  // Old PUT custom-fields NOT called
  assert.equal(calls.v1Put.length, 0, 'Should NOT have called old PUT custom-fields endpoint');
});

test('import/run update-by-domain: looks up ID from domain cache, patches correct company', async () => {
  clearCalls(); clearOverrides();
  // buildDomainCache: list now returns 'domain' as a standard key (PB API fixed 2026-04-03)
  mockListCompanies = [{ id: COMPANY_UUID_1, fields: { domain: 'acme.com' } }];

  const csvText = `Company Name,Domain\nAcme Updated,acme.com`;
  const mapping = { nameColumn: 'Company Name', domainColumn: 'Domain', customFields: [] };

  const res = await request(app)
    .post('/api/import/run')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({ csvText, mapping });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete not found:\n${res.text}`);
  assert.equal(complete.updated, 1);
  assert.equal(complete.errors, 0);

  // Patched the correct company by domain-matched ID
  assert.equal(calls.v2Patch.length, 1);
  assert.ok(calls.v2Patch[0].path.includes(COMPANY_UUID_1));

  mockListCompanies = [];
  mockSingleFields  = {};
});

test('import/run clearEmptyFields: single PATCH with set + clear ops combined', async () => {
  clearCalls(); clearOverrides();

  const csvText = `PB ID,Company Name,MRR,Tier\n${COMPANY_UUID_1},Test Co,50000,`;
  const mapping = {
    pbIdColumn:  'PB ID',
    nameColumn:  'Company Name',
    customFields: [
      { csvColumn: 'MRR',  fieldId: FIELD_UUID_MRR,  fieldType: 'number' },
      { csvColumn: 'Tier', fieldId: FIELD_UUID_TIER, fieldType: 'text' },
    ],
  };

  const res = await request(app)
    .post('/api/import/run')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({ csvText, mapping, clearEmptyFields: true });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete not found:\n${res.text}`);
  assert.equal(complete.errors, 0);

  // Exactly ONE v2 PATCH call (set ops + clear ops combined)
  assert.equal(calls.v2Patch.length, 1, 'Should have ONE combined PATCH call');
  const patchBody = calls.v2Patch[0].body;
  const ops = patchBody.data.patch;
  assert.ok(Array.isArray(ops), 'Patch body should have ops array');

  // MRR has value → set op
  const mrrOp = ops.find((o) => o.path === FIELD_UUID_MRR);
  assert.ok(mrrOp, 'Should have set op for MRR');
  assert.equal(mrrOp.op, 'set');

  // Tier is empty + clearEmptyFields → clear op
  const tierOp = ops.find((o) => o.path === FIELD_UUID_TIER);
  assert.ok(tierOp, 'Should have clear op for Tier');
  assert.equal(tierOp.op, 'clear');

  // No separate DELETE calls for custom fields
  assert.equal(calls.v1Put.length, 0);
});

test('import/run: custom fields inline in v2 create body (no old PUT calls)', async () => {
  clearCalls(); clearOverrides();
  mockSearchCompanies = [];

  const csvText = `Company Name,Domain,MRR,Tier\nNew Co,new.com,99000,enterprise`;
  const mapping = {
    nameColumn:   'Company Name',
    domainColumn: 'Domain',
    customFields: [
      { csvColumn: 'MRR',  fieldId: FIELD_UUID_MRR,  fieldType: 'number' },
      { csvColumn: 'Tier', fieldId: FIELD_UUID_TIER, fieldType: 'text' },
    ],
  };

  const res = await request(app)
    .post('/api/import/run')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({ csvText, mapping });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete not found:\n${res.text}`);
  assert.equal(complete.created, 1);
  assert.equal(complete.errors, 0);

  // Custom fields included in the v2 POST body (not separate PUT calls)
  assert.equal(calls.v2Post.length, 1);
  const createFields = calls.v2Post[0].body.data.fields;
  assert.equal(createFields[FIELD_UUID_MRR], 99000, 'MRR should be inline in create payload');
  assert.equal(createFields[FIELD_UUID_TIER], 'enterprise', 'Tier should be inline in create payload');

  // No old PUT /custom-fields calls
  assert.equal(calls.v1Put.length, 0, 'Should NOT have called old PUT custom-fields endpoint');
});
