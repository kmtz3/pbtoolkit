'use strict';

/**
 * Companies export tests — Phase 2 (v2).
 *
 * Asserts POST /api/export:
 * - Uses POST /v2/entities/search for company list (with inline custom fields)
 * - Fetches GET /companies/{id} (v1) per company for source enrichment
 * - SSE complete event has { csv, filename, count }
 * - Old GET /companies/{id}/custom-fields/{fieldId}/value calls are NOT made
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');

const COMPANY_UUID_1 = 'cccccccc-0000-0000-0000-000000000001';
const COMPANY_UUID_2 = 'cccccccc-0000-0000-0000-000000000002';
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
const calls = { post: [], get: [] };

function clearCalls() { calls.post = []; calls.get = []; }

// v2 configurations/company response
// .data is a single object (not an array) — singular entity type endpoint
const mockV2Config = {
  data: {
    type: 'company',
    fields: {
      name:        { id: 'name',        name: 'Name',   schema: 'TextFieldValue'   },
      description: { id: 'description', name: 'Desc',   schema: 'TextFieldValue'   },
      [FIELD_UUID_MRR]:  { id: FIELD_UUID_MRR,  name: 'MRR',  schema: 'NumberFieldValue' },
      [FIELD_UUID_TIER]: { id: FIELD_UUID_TIER, name: 'Tier', schema: 'TextFieldValue'   },
    },
  },
};

// GET /v2/entities?type[]=company response — inline custom fields + v2 metadata.source
const mockV2EntitiesResponse = {
  data: [
    {
      id: COMPANY_UUID_1,
      fields: {
        name: 'Acme Corp',
        description: 'A company',
        [FIELD_UUID_MRR]:  50000,
        [FIELD_UUID_TIER]: 'enterprise',
      },
      metadata: { source: { system: 'salesforce', recordId: 'sf-001', url: null } },
    },
    {
      id: COMPANY_UUID_2,
      fields: {
        name: 'Beta Inc',
        description: '',
        [FIELD_UUID_MRR]:  12000,
        [FIELD_UUID_TIER]: 'starter',
      },
      metadata: { source: { system: null, recordId: null, url: null } },
    },
  ],
  links: { next: null },
};

// GET /companies response — v1 paginated list for source enrichment
const mockV1CompaniesList = {
  data: [
    { id: COMPANY_UUID_1, domain: 'acme.com', sourceOrigin: 'salesforce', sourceRecordId: 'sf-001' },
    { id: COMPANY_UUID_2, domain: 'beta.io',  sourceOrigin: null,         sourceRecordId: null     },
  ],
  links: { next: null },
};

let app;

before(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'POST') {
        calls.post.push(req.url);
      } else if (req.method === 'GET') {
        calls.get.push(req.url);
      }

      // v2 configurations/company (singular — returns single object)
      if (req.method === 'GET' && req.url.startsWith('/v2/entities/configurations/company')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockV2Config));
        return;
      }

      // GET /v2/entities?type[]=company — company list (fetchAllPages)
      if (req.method === 'GET' && req.url.startsWith('/v2/entities')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockV2EntitiesResponse));
        return;
      }

      // GET /companies — v1 paginated list for source enrichment
      if (req.method === 'GET' && req.url.startsWith('/companies')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockV1CompaniesList));
        return;
      }

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

test('POST /api/export: SSE complete has { csv, filename, count }', async () => {
  clearCalls();

  const res = await request(app)
    .post('/api/export')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({});

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.ok(typeof complete.csv === 'string', 'complete.csv should be a string');
  assert.ok(typeof complete.filename === 'string', 'complete.filename should be a string');
  assert.equal(complete.count, 2);
});

test('POST /api/export: uses v2 search, does NOT call old custom-field value endpoints', async () => {
  clearCalls();

  await request(app)
    .post('/api/export')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({});

  // v2 entities GET was called (not old POST /v2/entities/search)
  assert.ok(
    calls.get.some((p) => p.startsWith('/v2/entities')),
    'Should have called GET /v2/entities'
  );

  // Old N×M custom field value calls not made
  assert.ok(
    !calls.get.some((p) => p.includes('/custom-fields/')),
    'Should NOT have called GET /companies/{id}/custom-fields/{fieldId}/value'
  );
});

test('POST /api/export: fetches v1 source per company for source enrichment', async () => {
  clearCalls();

  await request(app)
    .post('/api/export')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({});

  // v1 GET /companies list called for source enrichment (paginated, not per-company)
  assert.ok(
    calls.get.some((p) => p.startsWith('/companies')),
    'Should have called GET /companies for v1 source enrichment'
  );
});

test('POST /api/export: CSV includes standard fields, custom fields, and source columns', async () => {
  clearCalls();

  const res = await request(app)
    .post('/api/export')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({});

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete?.csv, 'Should have CSV content');

  const csv = complete.csv;
  // Standard fields
  assert.ok(csv.includes('PB Company ID'), 'CSV should have PB Company ID column');
  assert.ok(csv.includes('Company Name'), 'CSV should have Company Name column');
  assert.ok(csv.includes('Domain'), 'CSV should have Domain column');
  // Source columns
  assert.ok(csv.includes('Source Origin'), 'CSV should have Source Origin column');
  assert.ok(csv.includes('Source Record ID'), 'CSV should have Source Record ID column');
  // Custom field columns
  assert.ok(csv.includes('MRR'), 'CSV should have MRR column');
  assert.ok(csv.includes('Tier'), 'CSV should have Tier column');
  // Data values
  assert.ok(csv.includes('Acme Corp'), 'CSV should include company name');
  assert.ok(csv.includes('salesforce'), 'CSV should include source origin from v1 enrichment');
});

test('POST /api/export: v2 source columns populated from metadata.source (system/recordId)', async () => {
  clearCalls();

  const res = await request(app)
    .post('/api/export')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({});

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete?.csv, 'Should have CSV content');

  const csv = complete.csv;
  // Column headers should use new naming
  assert.ok(csv.includes('Source System (v2)'), 'CSV should have Source System (v2) column');
  assert.ok(csv.includes('Source Record ID (v2)'), 'CSV should have Source Record ID (v2) column');

  // Acme Corp row should have v2 source data from metadata.source.system/recordId
  const lines = csv.split('\n');
  const acmeLine = lines.find((l) => l.includes('Acme Corp'));
  assert.ok(acmeLine, 'Should have Acme Corp row');
  assert.ok(acmeLine.includes('salesforce'), 'Acme row should include salesforce from v2 metadata.source.system');
  assert.ok(acmeLine.includes('sf-001'), 'Acme row should include sf-001 from v2 metadata.source.recordId');
});
