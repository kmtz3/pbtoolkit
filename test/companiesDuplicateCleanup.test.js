'use strict';

/**
 * Merge Duplicate Companies route tests.
 *
 * Covers:
 *   GET  /api/companies-duplicate-cleanup/origins
 *     - merges v2 metadata.source.system + v1 sourceOrigin, deduplicates, sorts
 *     - serves from cache on second call with same token
 *     - ?refresh=true forces re-fetch
 *     - missing token → 400
 *
 *   POST /api/companies-duplicate-cleanup/scan  (SSE)
 *     - origin mode: exactly 1 primary origin → domain record created
 *     - origin mode: no primary origin → skipped (no_primary_origin)
 *     - origin mode: multiple primary origins → skipped (multiple_primary_origin)
 *     - manual mode: all groups returned with isManualMode: true
 *     - domain+name match criteria: sub-groups by name
 *     - fuzzy match: normalises names before grouping
 *     - v1 fallback fills null v2 source origins
 *     - missing token → 400
 *     - name-only: groups no-domain companies with identical names
 *     - name-only: exact mode does not group differently-cased/punctuated names
 *     - name-only: fuzzy mode groups differently-cased/punctuated names
 *     - name-only: companies with a domain are unaffected
 *     - name-only: skips group with no primary origin (no_primary_origin)
 *     - name-only: manual mode returns all name groups with isManualMode: true
 *     - name-only: singleton no-domain companies are not grouped
 *
 *   POST /api/companies-duplicate-cleanup/run   (SSE) [additional]
 *     - no-domain (name-only) record with empty domain completes successfully
 *
 *   POST /api/companies-duplicate-cleanup/run   (SSE)
 *     - note with company customer → PUT /v2/notes/{id}/relationships/customer
 *     - note with user customer → PUT /v2/entities/{userId}/relationships/parent
 *     - user directly parented to duplicate (Step 3) → relinked via entities/search
 *     - relink failure → DELETE skipped, error counted
 *     - empty domainRecords → completes with zero counts
 *     - missing token → 400
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const request = require('supertest');

// ── Reusable IDs ──────────────────────────────────────────────────────────────

const SF_ID    = 'aaaaaaaa-0001-0000-0000-000000000000'; // salesforce company
const HB_ID    = 'bbbbbbbb-0002-0000-0000-000000000000'; // hubspot company
const HB2_ID   = 'cccccccc-0003-0000-0000-000000000000'; // second hubspot company
const NOTE_ID  = 'dddddddd-0004-0000-0000-000000000000';
const USER_ID  = 'eeeeeeee-0005-0000-0000-000000000000';

// ── SSE helpers ───────────────────────────────────────────────────────────────

function parseCompleteEvent(text) {
  for (const chunk of text.split('\n\n')) {
    const lines = chunk.trim().split('\n');
    if (lines.some(l => l === 'event: complete')) {
      const dl = lines.find(l => l.startsWith('data:'));
      if (dl) return JSON.parse(dl.slice(5).trim());
    }
  }
  return null;
}

function parseLogEvents(text) {
  const events = [];
  for (const chunk of text.split('\n\n')) {
    const lines = chunk.trim().split('\n');
    if (lines.some(l => l === 'event: log')) {
      const dl = lines.find(l => l.startsWith('data:'));
      if (dl) events.push(JSON.parse(dl.slice(5).trim()));
    }
  }
  return events;
}

// ── Mock PB API server ────────────────────────────────────────────────────────

let mockServer, mockPort, app;
let mockState = {}; // configured per-test
let mockCalls = []; // { method, path, url } — reset per-test

before(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const method  = req.method;
      const fullUrl = req.url;
      const path    = fullUrl.split('?')[0];
      mockCalls.push({ method, path, url: fullUrl });

      // v2 company list  (GET /v2/entities?type[]=company...)
      if (method === 'GET' && path === '/v2/entities') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: mockState.v2Companies || [], links: { next: null } }));
        return;
      }

      // v1 company list  (GET /companies?pageLimit=...)
      if (method === 'GET' && path === '/companies') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: mockState.v1Companies || [] }));
        return;
      }

      // notes search  (POST /v2/notes/search)
      if (method === 'POST' && path === '/v2/notes/search') {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        const ids   = parsed.data?.relationships?.customer?.ids || [];
        const notes = (mockState.notesByCompany || {})[ids[0]] || [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: notes, links: { next: null } }));
        return;
      }

      // entities search  (POST /v2/entities/search — users by parent)
      if (method === 'POST' && path === '/v2/entities/search') {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        const parentIds = (parsed.data?.filter?.relationships?.parent || []).map(p => p.id);
        const users     = (mockState.usersByParent || {})[parentIds[0]] || [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: users, links: { next: null } }));
        return;
      }

      // note customer relink  (PUT /v2/notes/{id}/relationships/customer)
      if (method === 'PUT' && path.includes('/relationships/customer')) {
        if (mockState.relinkError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ errors: [{ detail: 'relink failed' }] }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: {} }));
        }
        return;
      }

      // user parent relink  (PUT /v2/entities/{id}/relationships/parent)
      if (method === 'PUT' && path.includes('/relationships/parent')) {
        if (mockState.relinkError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ errors: [{ detail: 'relink failed' }] }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: {} }));
        }
        return;
      }

      // company delete  (DELETE /v2/entities/{id})
      if (method === 'DELETE' && path.startsWith('/v2/entities/')) {
        res.writeHead(204); res.end();
        return;
      }

      res.writeHead(204); res.end();
    });
  });

  await new Promise(r => mockServer.listen(0, '127.0.0.1', r));
  mockPort = mockServer.address().port;
  process.env.PB_API_BASE_URL = `http://127.0.0.1:${mockPort}`;
  app = require('../src/server.js');
});

after(async () => {
  await new Promise(r => mockServer.close(r));
  delete process.env.PB_API_BASE_URL;
});

/** Replace mock state and clear call log before each test. */
function reset(state = {}) {
  mockState = state;
  mockCalls = [];
}

/** Build a minimal v2 company object for /scan tests. */
function company(id, domain, sourceSystem, name) {
  return {
    id,
    type: 'company',
    fields: { name: name || `Co-${id.slice(0, 4)}`, domain },
    metadata: { source: sourceSystem ? { system: sourceSystem } : {} },
  };
}

/** Build a note with a specific customer relationship type. */
function noteWithCustomer(id, customerType, customerId) {
  return {
    id,
    relationships: {
      data: [{ type: 'customer', target: { type: customerType, id: customerId } }],
    },
  };
}

// ── GET /origins ──────────────────────────────────────────────────────────────

test('origins: returns merged v2 + v1 sources, deduplicated and sorted', async () => {
  reset({
    v2Companies: [
      company(SF_ID,  'acme.com', 'salesforce'),
      company(HB_ID,  'beta.com', null),          // v2 source null — v1 fallback needed
      company(HB2_ID, 'beta.com', 'salesforce'),  // already has v2 source
    ],
    v1Companies: [
      { id: HB_ID, sourceOrigin: 'hubspot' },     // back-fills HB_ID
    ],
  });

  const res = await request(app)
    .get('/api/companies-duplicate-cleanup/origins')
    .set('x-pb-token', 'token-origins-merge');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.origins, ['hubspot', 'salesforce']);
});

test('origins: second call with same token is served from cache (no extra API calls)', async () => {
  reset({
    v2Companies: [company(SF_ID, 'acme.com', 'salesforce')],
    v1Companies: [],
  });

  // First call — populates cache
  await request(app)
    .get('/api/companies-duplicate-cleanup/origins')
    .set('x-pb-token', 'token-origins-cache');

  const v2CallsFirst = mockCalls.filter(c => c.path === '/v2/entities').length;
  assert.ok(v2CallsFirst >= 1, 'First call should hit the v2 API');

  // Clear call log but leave mockState (cache entry persists in the module)
  mockCalls = [];

  // Second call — should hit cache
  const res = await request(app)
    .get('/api/companies-duplicate-cleanup/origins')
    .set('x-pb-token', 'token-origins-cache');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.origins, ['salesforce']);
  const v2CallsSecond = mockCalls.filter(c => c.path === '/v2/entities').length;
  assert.equal(v2CallsSecond, 0, 'Second call must not hit the API');
});

test('origins: ?refresh=true bypasses cache and re-fetches', async () => {
  reset({
    v2Companies: [company(SF_ID, 'acme.com', 'salesforce')],
    v1Companies: [],
  });

  // Warm cache
  await request(app)
    .get('/api/companies-duplicate-cleanup/origins')
    .set('x-pb-token', 'token-origins-refresh');
  mockCalls = [];

  // Refresh — should re-fetch
  const res = await request(app)
    .get('/api/companies-duplicate-cleanup/origins?refresh=true')
    .set('x-pb-token', 'token-origins-refresh');

  assert.equal(res.status, 200);
  const v2Calls = mockCalls.filter(c => c.path === '/v2/entities').length;
  assert.ok(v2Calls >= 1, '?refresh=true must bypass cache and hit the API');
});

test('origins: missing token returns 400', async () => {
  reset({});
  const res = await request(app)
    .get('/api/companies-duplicate-cleanup/origins');
  assert.equal(res.status, 400);
});

// ── POST /scan ────────────────────────────────────────────────────────────────

test('scan: origin mode — creates domain record when exactly 1 primary origin found', async () => {
  reset({
    v2Companies: [
      company(SF_ID, 'acme.com', 'salesforce'),
      company(HB_ID, 'acme.com', 'hubspot'),
    ],
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-origin')
    .send({ primaryOrigin: 'salesforce' });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, 'Should emit complete event');
  assert.equal(complete.totalDomains,    1, 'Should have 1 domain record');
  assert.equal(complete.totalDuplicates, 1, 'Should have 1 duplicate');
  assert.equal(complete.skippedRows.length, 0);

  const dr = complete.domainRecords[0];
  assert.equal(dr.domain,       'acme.com');
  assert.equal(dr.sfCompanyId,  SF_ID);
  assert.equal(dr.duplicates.length, 1);
  assert.equal(dr.duplicates[0].id, HB_ID);
  assert.equal(dr.isManualMode, false);
});

test('scan: origin mode — skips group with no primary origin (no_primary_origin)', async () => {
  reset({
    v2Companies: [
      company(HB_ID,  'acme.com', 'hubspot'),
      company(HB2_ID, 'acme.com', 'intercom'),
    ],
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-no-primary')
    .send({ primaryOrigin: 'salesforce' });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.domainRecords.length, 0);
  assert.equal(complete.skippedRows.length, 1);
  assert.equal(complete.skippedRows[0].reason, 'no_primary_origin');
  assert.equal(complete.skippedRows[0].domain, 'acme.com');
});

test('scan: origin mode — skips group with multiple primary origins (multiple_primary_origin)', async () => {
  reset({
    v2Companies: [
      company(SF_ID,  'acme.com', 'salesforce'),
      company(HB_ID,  'acme.com', 'salesforce'), // two SF companies → ambiguous
      company(HB2_ID, 'acme.com', 'hubspot'),
    ],
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-multi-primary')
    .send({ primaryOrigin: 'salesforce' });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.domainRecords.length, 0);
  assert.equal(complete.skippedRows.length, 1);
  assert.equal(complete.skippedRows[0].reason, 'multiple_primary_origin');
  assert.deepEqual(complete.skippedRows[0].sfUuids.sort(), [SF_ID, HB_ID].sort());
});

test('scan: manual mode — includes all groups with isManualMode: true', async () => {
  reset({
    v2Companies: [
      company(SF_ID, 'acme.com', 'salesforce'),
      company(HB_ID, 'acme.com', 'hubspot'),
    ],
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-manual')
    .send({ manualMode: true });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.domainRecords.length, 1);
  assert.equal(complete.domainRecords[0].isManualMode, true);
  // salesforce company is preferred as default target
  assert.equal(complete.domainRecords[0].sfCompanyId, SF_ID);
  assert.equal(complete.skippedRows.length, 0);
});

test('scan: domain+name — sub-groups by name, singleton name groups excluded', async () => {
  // acme.com has 3 companies: 2 with name 'Acme' (one SF, one HB) + 1 with name 'Acme Corp'
  // With domain+name: only the 2 'Acme' companies form a duplicate group
  // 'Acme Corp' is alone in its name group → not a duplicate
  reset({
    v2Companies: [
      company(SF_ID,  'acme.com', 'salesforce', 'Acme'),
      company(HB_ID,  'acme.com', 'hubspot',    'Acme'),
      company(HB2_ID, 'acme.com', 'hubspot',    'Acme Corp'),
    ],
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-domain-name')
    .send({ primaryOrigin: 'salesforce', matchCriteria: 'domain+name' });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.domainRecords.length, 1, 'Only the Acme/Acme pair should match');
  assert.equal(complete.domainRecords[0].matchName, 'Acme');
  assert.equal(complete.domainRecords[0].duplicates.length, 1);
  assert.equal(complete.domainRecords[0].duplicates[0].id, HB_ID);
});

test('scan: domain+name — fuzzy match groups Acme Inc and ACME, INC.', async () => {
  reset({
    v2Companies: [
      company(SF_ID, 'acme.com', 'salesforce', 'Acme Inc'),
      company(HB_ID, 'acme.com', 'hubspot',    'ACME, INC.'),
    ],
  });

  // Exact match: names differ → no duplicate group
  const resExact = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-fuzzy-exact')
    .send({ primaryOrigin: 'salesforce', matchCriteria: 'domain+name', fuzzyMatch: false });
  const completeExact = parseCompleteEvent(resExact.text);
  assert.equal(completeExact.domainRecords.length, 0, 'Exact match should not group differently-cased names');

  // Fuzzy match: names normalise to same → duplicate found
  const resFuzzy = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-fuzzy-fuzzy')
    .send({ primaryOrigin: 'salesforce', matchCriteria: 'domain+name', fuzzyMatch: true });
  const completeFuzzy = parseCompleteEvent(resFuzzy.text);
  assert.equal(completeFuzzy.domainRecords.length, 1, 'Fuzzy match should group Acme Inc / ACME, INC.');
  assert.equal(completeFuzzy.domainRecords[0].sfCompanyId, SF_ID);
});

test('scan: v1 fallback fills null v2 source origins', async () => {
  // HB_ID has null v2 source — v1 back-fills it as hubspot
  // Combined with SF_ID (salesforce) they form a valid duplicate pair
  reset({
    v2Companies: [
      company(SF_ID, 'acme.com', 'salesforce'),
      company(HB_ID, 'acme.com', null),
    ],
    v1Companies: [
      { id: HB_ID, sourceOrigin: 'hubspot' },
    ],
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-v1-fallback')
    .send({ primaryOrigin: 'salesforce' });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.domainRecords.length, 1);
  assert.equal(complete.domainRecords[0].sfCompanyId,  SF_ID);
  assert.equal(complete.domainRecords[0].duplicates[0].id, HB_ID);
  assert.equal(complete.domainRecords[0].duplicates[0].sourceOrigin, 'hubspot',
    'v1-back-filled sourceOrigin should appear in the duplicate entry');

  // Verify v1 API was called
  const v1Calls = mockCalls.filter(c => c.path === '/companies');
  assert.ok(v1Calls.length >= 1, 'Should have called v1 API for fallback');
});

test('scan: missing token returns 400', async () => {
  reset({});
  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .send({});
  assert.equal(res.status, 400);
});

// ── POST /run ─────────────────────────────────────────────────────────────────

test('run: relinks note with company customer and deletes duplicate', async () => {
  // Note whose customer is the company itself → relink via PUT /v2/notes/{id}/relationships/customer
  reset({
    notesByCompany: {
      [HB_ID]: [noteWithCustomer(NOTE_ID, 'company', HB_ID)],
    },
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/run')
    .set('x-pb-token', 'token-run-note-company')
    .send({
      domainRecords: [{
        domain:      'acme.com',
        sfCompanyId: SF_ID,
        duplicates:  [{ id: HB_ID }],
      }],
    });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, 'Should emit complete event');
  assert.equal(complete.notesRelinked, 1);
  assert.equal(complete.usersRelinked, 0);
  assert.equal(complete.deleted,  1);
  assert.equal(complete.errors,   0);

  const relinkedNote = mockCalls.find(
    c => c.method === 'PUT' && c.path === `/v2/notes/${NOTE_ID}/relationships/customer`
  );
  assert.ok(relinkedNote, 'Should PUT note customer relink');

  const deleted = mockCalls.find(
    c => c.method === 'DELETE' && c.path === `/v2/entities/${HB_ID}`
  );
  assert.ok(deleted, 'Should DELETE the duplicate company');
});

test('run: relinks note with user customer via user parent relationship', async () => {
  // Note whose customer is a user → relink via PUT /v2/entities/{userId}/relationships/parent
  reset({
    notesByCompany: {
      [HB_ID]: [noteWithCustomer(NOTE_ID, 'user', USER_ID)],
    },
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/run')
    .set('x-pb-token', 'token-run-note-user')
    .send({
      domainRecords: [{
        domain:      'acme.com',
        sfCompanyId: SF_ID,
        duplicates:  [{ id: HB_ID }],
      }],
    });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.notesRelinked, 0, 'User-type customer does not count as a relinked note');
  assert.equal(complete.usersRelinked, 1);
  assert.equal(complete.deleted, 1);
  assert.equal(complete.errors,  0);

  const relinkedUser = mockCalls.find(
    c => c.method === 'PUT' && c.path === `/v2/entities/${USER_ID}/relationships/parent`
  );
  assert.ok(relinkedUser, 'Should PUT user parent relink');
});

test('run: relinks users directly parented to duplicate via entities/search (Step 3)', async () => {
  // No notes, but a user is directly parented to the duplicate
  reset({
    notesByCompany: { [HB_ID]: [] },
    usersByParent:  { [HB_ID]: [{ id: USER_ID }] },
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/run')
    .set('x-pb-token', 'token-run-step3')
    .send({
      domainRecords: [{
        domain:      'acme.com',
        sfCompanyId: SF_ID,
        duplicates:  [{ id: HB_ID }],
      }],
    });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.usersRelinked, 1);
  assert.equal(complete.deleted,  1);
  assert.equal(complete.errors,   0);

  const entitiesSearch = mockCalls.find(c => c.method === 'POST' && c.path === '/v2/entities/search');
  assert.ok(entitiesSearch, 'Should POST entities/search to find directly-parented users');

  const relinkedUser = mockCalls.find(
    c => c.method === 'PUT' && c.path === `/v2/entities/${USER_ID}/relationships/parent`
  );
  assert.ok(relinkedUser, 'Should PUT user parent relink for directly-parented user');
});

test('run: skips DELETE when a relink fails, increments error count', async () => {
  reset({
    notesByCompany: {
      [HB_ID]: [noteWithCustomer(NOTE_ID, 'company', HB_ID)],
    },
    relinkError: true, // PUT endpoints return 400
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/run')
    .set('x-pb-token', 'token-run-relink-fail')
    .send({
      domainRecords: [{
        domain:      'acme.com',
        sfCompanyId: SF_ID,
        duplicates:  [{ id: HB_ID }],
      }],
    });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.errors,   1, 'Relink failure should increment error count');
  assert.equal(complete.deleted,  0, 'DELETE must be skipped when a relink failed');
  assert.equal(complete.notesRelinked, 0);

  const deleteCalls = mockCalls.filter(c => c.method === 'DELETE');
  assert.equal(deleteCalls.length, 0, 'No DELETE should be issued when relink failed');

  const logs = parseLogEvents(res.text);
  const warnLog = logs.find(l => l.level === 'warn' && l.message.includes('Skipping DELETE'));
  assert.ok(warnLog, 'Should log a warning that DELETE was skipped');
});

test('run: empty domainRecords completes cleanly with zero counts', async () => {
  reset({});

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/run')
    .set('x-pb-token', 'token-run-empty')
    .send({ domainRecords: [] });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, 'Should emit complete event');
  assert.equal(complete.notesRelinked, 0);
  assert.equal(complete.usersRelinked, 0);
  assert.equal(complete.deleted,  0);
  assert.equal(complete.errors,   0);
  assert.equal(complete.stopped,  false);
});

test('run: missing token returns 400', async () => {
  reset({});
  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/run')
    .send({ domainRecords: [] });
  assert.equal(res.status, 400);
});

// ── POST /scan — name-only matchCriteria ──────────────────────────────────────

const ND_SF_ID  = 'ffffffff-0010-0000-0000-000000000000'; // no-domain salesforce co
const ND_HB_ID  = 'ffffffff-0011-0000-0000-000000000000'; // no-domain hubspot co
const ND_HB2_ID = 'ffffffff-0012-0000-0000-000000000000'; // no-domain hubspot co (2)

/** Minimal v2 company with no domain. */
function noDomainCompany(id, sourceSystem, name) {
  return {
    id,
    type: 'company',
    fields: { name: name || `NoCo-${id.slice(0, 4)}`, domain: null },
    metadata: { source: sourceSystem ? { system: sourceSystem } : {} },
  };
}

test('scan: name-only — groups no-domain companies with identical names (origin mode)', async () => {
  reset({
    v2Companies: [
      noDomainCompany(ND_SF_ID,  'salesforce', 'Acme Corp'),
      noDomainCompany(ND_HB_ID,  'hubspot',    'Acme Corp'), // exact match → forms group
      noDomainCompany(ND_HB2_ID, 'hubspot',    'Beta Inc'),  // different name → singleton
    ],
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-nameonly-basic')
    .send({ primaryOrigin: 'salesforce', matchCriteria: 'name' });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.domainRecords.length, 1, 'Only the Acme Corp pair should form a group');
  const dr = complete.domainRecords[0];
  assert.equal(dr.domain,           '',           'domain is empty string for name-only groups');
  assert.equal(dr.matchName,        'Acme Corp',  'matchName set to the shared company name');
  assert.equal(dr.sfCompanyId,      ND_SF_ID);
  assert.equal(dr.duplicates.length, 1);
  assert.equal(dr.duplicates[0].id,  ND_HB_ID);
  assert.equal(dr.isManualMode,      false);
});

test('scan: name-only — exact mode does not group differently-cased/punctuated names', async () => {
  reset({
    v2Companies: [
      noDomainCompany(ND_SF_ID, 'salesforce', 'Acme Corp'),
      noDomainCompany(ND_HB_ID, 'hubspot',    'ACME, CORP.'),
    ],
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-nameonly-exact-miss')
    .send({ primaryOrigin: 'salesforce', matchCriteria: 'name', fuzzyMatch: false });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.domainRecords.length, 0,
    'Exact name-only must not group differently-cased names');
  assert.equal(complete.skippedRows.length, 0);
});

test('scan: name-only — fuzzy mode groups differently-cased/punctuated names', async () => {
  reset({
    v2Companies: [
      noDomainCompany(ND_SF_ID, 'salesforce', 'Acme Corp'),
      noDomainCompany(ND_HB_ID, 'hubspot',    'ACME, CORP.'),
    ],
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-nameonly-fuzzy')
    .send({ primaryOrigin: 'salesforce', matchCriteria: 'name', fuzzyMatch: true });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.domainRecords.length, 1,
    'Fuzzy name-only must group Acme Corp / ACME, CORP.');
  assert.equal(complete.domainRecords[0].sfCompanyId,       ND_SF_ID);
  assert.equal(complete.domainRecords[0].duplicates[0].id,  ND_HB_ID);
});

test('scan: name-only — companies with a domain are not grouped', async () => {
  // Two companies share the same name but both have a domain — should be skipped in name-only mode
  reset({
    v2Companies: [
      company(SF_ID, 'acme.com', 'salesforce', 'Acme Corp'), // has domain → ignored
      company(HB_ID, 'acme.com', 'hubspot',    'Acme Corp'), // has domain → ignored
      noDomainCompany(ND_HB2_ID, 'hubspot', 'Solo Inc'),     // no domain but unique → no group
    ],
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-nameonly-domain-ignored')
    .send({ primaryOrigin: 'salesforce', matchCriteria: 'name' });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.domainRecords.length, 0,
    'Domain-having companies must not appear in name-only results');
});

test('scan: name-only — skips group with no primary origin', async () => {
  reset({
    v2Companies: [
      noDomainCompany(ND_SF_ID, 'hubspot',  'Acme Corp'),
      noDomainCompany(ND_HB_ID, 'intercom', 'Acme Corp'),
    ],
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-nameonly-no-primary')
    .send({ primaryOrigin: 'salesforce', matchCriteria: 'name' });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.domainRecords.length, 0);
  assert.equal(complete.skippedRows.length,   1);
  assert.equal(complete.skippedRows[0].reason,    'no_primary_origin');
  assert.equal(complete.skippedRows[0].domain,    '');
  assert.equal(complete.skippedRows[0].matchName, 'Acme Corp');
});

test('scan: name-only — manual mode returns all name groups with isManualMode: true', async () => {
  reset({
    v2Companies: [
      noDomainCompany(ND_SF_ID, 'salesforce', 'Acme Corp'),
      noDomainCompany(ND_HB_ID, 'hubspot',    'Acme Corp'),
    ],
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-nameonly-manual')
    .send({ manualMode: true, matchCriteria: 'name' });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.domainRecords.length, 1);
  assert.equal(complete.domainRecords[0].isManualMode, true);
  assert.equal(complete.domainRecords[0].matchName,    'Acme Corp');
  // salesforce-sourced company preferred as default target
  assert.equal(complete.domainRecords[0].sfCompanyId, ND_SF_ID);
});

test('scan: name-only — singleton no-domain companies are not grouped', async () => {
  reset({
    v2Companies: [
      noDomainCompany(ND_SF_ID, 'salesforce', 'Acme Corp'),
      noDomainCompany(ND_HB_ID, 'hubspot',    'Beta Inc'),  // different name
    ],
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/scan')
    .set('x-pb-token', 'token-scan-nameonly-singleton')
    .send({ primaryOrigin: 'salesforce', matchCriteria: 'name' });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.domainRecords.length, 0,
    'Companies with unique names should not form any group');
  assert.equal(complete.skippedRows.length, 0);
});

// ── POST /run — name-only (empty domain) record ───────────────────────────────

test('run: no-domain (name-only) record — completes successfully with empty domain', async () => {
  // Verifies that /run works correctly when dr.domain is '' (name-only group with matchName set)
  reset({
    notesByCompany: {
      [HB_ID]: [noteWithCustomer(NOTE_ID, 'company', HB_ID)],
    },
  });

  const res = await request(app)
    .post('/api/companies-duplicate-cleanup/run')
    .set('x-pb-token', 'token-run-no-domain')
    .send({
      domainRecords: [{
        domain:      '',
        matchName:   'Acme Corp',
        sfCompanyId: SF_ID,
        duplicates:  [{ id: HB_ID }],
      }],
    });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, 'Should emit complete event');
  assert.equal(complete.notesRelinked, 1);
  assert.equal(complete.deleted,       1);
  assert.equal(complete.errors,        0);

  const deleted = mockCalls.find(c => c.method === 'DELETE' && c.path === `/v2/entities/${HB_ID}`);
  assert.ok(deleted, 'Should DELETE the duplicate company');
});
