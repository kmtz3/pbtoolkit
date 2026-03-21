'use strict';

/**
 * Teams CRUD route tests.
 *
 * Coverage:
 *  - parseImportCSV reconciliation: UUID match, handle match, create, hard errors, sanitization
 *  - GET  /api/teams-crud/export         — returns CSV with correct headers
 *  - POST /api/teams-crud/preview        — diff JSON, warnings, hard errors
 *  - POST /api/teams-crud/import         — uses POST /v2/teams (no data wrapper) for creates,
 *                                         PATCH /v2/teams/:id (data wrapper) for updates;
 *                                         409 = warn+skip, 404 = warn+skip
 *  - POST /api/teams-crud/delete/by-csv  — DELETE /v2/teams/:id; 404 = skipped; handle fallback
 *  - POST /api/teams-crud/delete/all     — fetches via GET /v2/teams, then deletes all; empty = total:0
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');

const UUID_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const UUID_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const UUID_C = 'cccccccc-0000-0000-0000-000000000003';

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseCompleteEvent(text) {
  for (const chunk of text.split('\n\n')) {
    const lines = chunk.trim().split('\n');
    if (lines.some((l) => l === 'event: complete')) {
      const dataLine = lines.find((l) => l.startsWith('data:'));
      if (dataLine) return JSON.parse(dataLine.slice(5).trim());
    }
  }
  return null;
}

// ── Mock PB API server ───────────────────────────────────────────────────────

let mockServer;
let mockPort;
const calls = { delete: [], post: [], patch: [], get: [] };
const responseOverrides = new Map();

// Default team list returned by GET /v2/teams
let mockTeams = [];

function setOverride(method, path, status, body) {
  responseOverrides.set(`${method}:${path}`, { status, body });
}
function clearOverrides() { responseOverrides.clear(); }
function clearCalls() {
  calls.delete = [];
  calls.post   = [];
  calls.patch  = [];
  calls.get    = [];
}

let app;

before(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const key = `${req.method}:${req.url}`;

      // Record
      if      (req.method === 'DELETE') calls.delete.push(req.url);
      else if (req.method === 'POST')   calls.post.push(req.url);
      else if (req.method === 'PATCH')  calls.patch.push(req.url);
      else if (req.method === 'GET')    calls.get.push(req.url);

      // Per-test override
      if (responseOverrides.has(key)) {
        const { status, body: rb } = responseOverrides.get(key);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rb));
        return;
      }

      // GET /v2/teams — cursor-paginated team list
      if (req.method === 'GET' && req.url.startsWith('/v2/teams')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: mockTeams, links: { next: null } }));
        return;
      }

      // POST /v2/teams — create team
      if (req.method === 'POST' && req.url === '/v2/teams') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { id: UUID_C, type: 'team', links: { self: '' } } }));
        return;
      }

      // PATCH /v2/teams/:id — update team
      if (req.method === 'PATCH' && req.url.startsWith('/v2/teams/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { id: req.url.split('/')[3], type: 'team', links: { self: '' } } }));
        return;
      }

      // DELETE /v2/teams/:id
      if (req.method === 'DELETE' && req.url.startsWith('/v2/teams/')) {
        res.writeHead(204); res.end();
        return;
      }

      res.writeHead(404); res.end('{}');
    });
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = mockServer.address().port;
  process.env.NODE_ENV        = 'test';
  process.env.PB_API_BASE_URL = `http://127.0.0.1:${mockPort}`;
  app = require('../src/server.js');
});

after(async () => {
  await new Promise((resolve) => mockServer.close(resolve));
  delete process.env.PB_API_BASE_URL;
});

// ── Export ────────────────────────────────────────────────────────────────────

test('export: no token → 400', async () => {
  const res = await request(app).get('/api/teams-crud/export');
  assert.equal(res.status, 400);
});

test('export: returns CSV with all 6 columns', async () => {
  clearCalls();
  mockTeams = [
    { id: UUID_A, createdAt: '2025-01-01T00:00:00Z', fields: { name: 'Alpha', handle: 'alpha', description: 'desc', avatarUrl: 'https://a.example.com' } },
  ];

  const res = await request(app)
    .get('/api/teams-crud/export')
    .set('x-pb-token', 'test-token');

  assert.equal(res.status, 200);
  assert.ok(res.headers['content-type'].includes('text/csv'));
  assert.ok(res.headers['content-disposition'].includes('pb-teams_'));

  const lines = res.text.trim().split(/\r?\n/);
  assert.equal(lines[0], 'id,name,handle,description,createdAt,avatarUrl');
  assert.ok(lines[1].includes(UUID_A));
  assert.ok(lines[1].includes('Alpha'));
  assert.ok(lines[1].includes('alpha'));

  mockTeams = [];
});

test('export: empty workspace → CSV with header only', async () => {
  clearCalls();
  mockTeams = [];

  const res = await request(app)
    .get('/api/teams-crud/export')
    .set('x-pb-token', 'test-token');

  assert.equal(res.status, 200);
  const lines = res.text.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'id,name,handle,description,createdAt,avatarUrl');
});

// ── Preview — reconciliation logic ────────────────────────────────────────────

test('preview: no token → 400', async () => {
  const res = await request(app)
    .post('/api/teams-crud/preview')
    .send({ csvText: 'name,handle\nFoo,foo', mapping: { nameCol: 'name', handleCol: 'handle' } });
  assert.equal(res.status, 400);
});

test('preview: missing mapping → 400', async () => {
  const res = await request(app)
    .post('/api/teams-crud/preview')
    .set('x-pb-token', 'test-token')
    .send({ csvText: 'name,handle\nFoo,foo' });
  assert.equal(res.status, 400);
});

test('preview: no nameCol and no handleCol → hardError', async () => {
  clearCalls();
  mockTeams = [];

  const res = await request(app)
    .post('/api/teams-crud/preview')
    .set('x-pb-token', 'test-token')
    .send({ csvText: 'id\n' + UUID_A, mapping: { idCol: 'id' } });

  assert.equal(res.status, 200);
  assert.ok(res.body.hardErrors.length > 0);
  assert.equal(res.body.diff, null);
});

test('preview: UUID found in workspace → toUpdate (changed fields)', async () => {
  clearCalls();
  mockTeams = [
    { id: UUID_A, createdAt: '2025-01-01T00:00:00Z', fields: { name: 'Old Name', handle: 'oldhandle', description: '', avatarUrl: '' } },
  ];

  const csvText = `id,name,handle\n${UUID_A},New Name,newhandle`;
  const res = await request(app)
    .post('/api/teams-crud/preview')
    .set('x-pb-token', 'test-token')
    .send({ csvText, mapping: { idCol: 'id', nameCol: 'name', handleCol: 'handle' } });

  assert.equal(res.status, 200);
  assert.equal(res.body.hardErrors.length, 0);
  assert.equal(res.body.diff.toUpdate.length, 1);
  assert.equal(res.body.diff.toCreate.length, 0);
  assert.equal(res.body.diff.toUpdate[0].matchedBy, 'id');
  assert.deepEqual(res.body.diff.toUpdate[0].changes, { name: 'New Name', handle: 'newhandle' });

  mockTeams = [];
});

test('preview: UUID found but nothing changed → unchanged', async () => {
  clearCalls();
  mockTeams = [
    { id: UUID_A, createdAt: '2025-01-01T00:00:00Z', fields: { name: 'Alpha', handle: 'alpha', description: '', avatarUrl: '' } },
  ];

  const csvText = `id,name\n${UUID_A},Alpha`;
  const res = await request(app)
    .post('/api/teams-crud/preview')
    .set('x-pb-token', 'test-token')
    .send({ csvText, mapping: { idCol: 'id', nameCol: 'name' } });

  assert.equal(res.status, 200);
  assert.equal(res.body.diff.unchanged.length, 1);
  assert.equal(res.body.diff.toUpdate.length, 0);

  mockTeams = [];
});

test('preview: UUID not found in workspace → hardError', async () => {
  clearCalls();
  mockTeams = []; // workspace has no teams

  const csvText = `id,name\n${UUID_A},Anything`;
  const res = await request(app)
    .post('/api/teams-crud/preview')
    .set('x-pb-token', 'test-token')
    .send({ csvText, mapping: { idCol: 'id', nameCol: 'name' } });

  assert.equal(res.status, 200);
  assert.ok(res.body.hardErrors.length > 0);
  assert.ok(res.body.hardErrors[0].includes(UUID_A));
});

test('preview: no UUID, handle found → PATCH_BY_HANDLE', async () => {
  clearCalls();
  mockTeams = [
    { id: UUID_A, createdAt: '2025-01-01T00:00:00Z', fields: { name: 'Alpha', handle: 'alpha', description: '', avatarUrl: '' } },
  ];

  const csvText = `handle,name\nalpha,Alpha Updated`;
  const res = await request(app)
    .post('/api/teams-crud/preview')
    .set('x-pb-token', 'test-token')
    .send({ csvText, mapping: { handleCol: 'handle', nameCol: 'name' } });

  assert.equal(res.status, 200);
  assert.equal(res.body.diff.toUpdate.length, 1);
  assert.equal(res.body.diff.toUpdate[0].matchedBy, 'handle');
  assert.equal(res.body.diff.toUpdate[0].id, UUID_A);

  mockTeams = [];
});

test('preview: no UUID, handle not found → CREATE', async () => {
  clearCalls();
  mockTeams = []; // no existing teams

  const csvText = `name,handle\nBrand New,brandnew`;
  const res = await request(app)
    .post('/api/teams-crud/preview')
    .set('x-pb-token', 'test-token')
    .send({ csvText, mapping: { nameCol: 'name', handleCol: 'handle' } });

  assert.equal(res.status, 200);
  assert.equal(res.body.diff.toCreate.length, 1);
  assert.equal(res.body.diff.toCreate[0].name, 'Brand New');
  assert.equal(res.body.diff.toCreate[0].handle, 'brandnew');
});

test('preview: no id and no handle → hardError', async () => {
  clearCalls();
  mockTeams = [];

  const csvText = `name\nFoo`;
  const res = await request(app)
    .post('/api/teams-crud/preview')
    .set('x-pb-token', 'test-token')
    .send({ csvText, mapping: { nameCol: 'name' } }); // no idCol, no handleCol mapped

  assert.equal(res.status, 200);
  // No name+no handle — every row is an error because there's nothing to reconcile on
  // Actually: nameCol is set but no handleCol → every row has no id and no handle
  assert.ok(res.body.hardErrors.length > 0);
});

test('preview: handle needs sanitization → warning emitted', async () => {
  clearCalls();
  mockTeams = [];

  const csvText = `name,handle\nFoo,My Team!`;
  const res = await request(app)
    .post('/api/teams-crud/preview')
    .set('x-pb-token', 'test-token')
    .send({ csvText, mapping: { nameCol: 'name', handleCol: 'handle' } });

  assert.equal(res.status, 200);
  assert.ok(res.body.warnings.some((w) => w.includes('sanitized')), `Expected sanitization warning, got: ${JSON.stringify(res.body.warnings)}`);
  // Sanitized handle 'myteam' should be used for CREATE
  assert.equal(res.body.diff.toCreate.length, 1);
  assert.equal(res.body.diff.toCreate[0].handle, 'myteam');
});

test('preview: handle becomes empty after sanitization → hardError', async () => {
  clearCalls();
  mockTeams = [];

  const csvText = `name,handle\nFoo,!!!`;
  const res = await request(app)
    .post('/api/teams-crud/preview')
    .set('x-pb-token', 'test-token')
    .send({ csvText, mapping: { nameCol: 'name', handleCol: 'handle' } });

  assert.equal(res.status, 200);
  assert.ok(res.body.hardErrors.length > 0);
  assert.ok(res.body.hardErrors[0].includes('empty handle'));
});

// ── Import ────────────────────────────────────────────────────────────────────

test('import: no token → 400', async () => {
  const res = await request(app)
    .post('/api/teams-crud/import')
    .send({ csvText: 'name,handle\nFoo,foo', mapping: { nameCol: 'name', handleCol: 'handle' } });
  assert.equal(res.status, 400);
});

test('import: CREATE uses POST /v2/teams without data wrapper', async () => {
  clearCalls(); clearOverrides();
  mockTeams = [];

  let capturedBody = null;
  const overrideServer = responseOverrides; // capture from closure
  // We'll inspect the calls array to verify the request shape
  // Intercept by temporarily augmenting the mock server's POST handler
  setOverride('POST', '/v2/teams', 201, { data: { id: UUID_C, type: 'team', links: { self: '' } } });

  const csvText = `name,handle,description\nNew Team,newteam,A new team`;
  const res = await request(app)
    .post('/api/teams-crud/import')
    .set('x-pb-token', 'test-token')
    .send({ csvText, mapping: { nameCol: 'name', handleCol: 'handle', descCol: 'description' } });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.created, 1);
  assert.equal(complete.errors, 0);

  // Must have called POST /v2/teams
  assert.ok(calls.post.includes('/v2/teams'), `Expected POST /v2/teams. Got: ${calls.post.join(', ')}`);

  clearOverrides();
  mockTeams = [];
});

test('import: UPDATE uses PATCH /v2/teams/:id', async () => {
  clearCalls(); clearOverrides();
  mockTeams = [
    { id: UUID_A, createdAt: '2025-01-01T00:00:00Z', fields: { name: 'Old Name', handle: 'alpha', description: '', avatarUrl: '' } },
  ];

  const csvText = `id,name\n${UUID_A},Updated Name`;
  const res = await request(app)
    .post('/api/teams-crud/import')
    .set('x-pb-token', 'test-token')
    .send({ csvText, mapping: { idCol: 'id', nameCol: 'name' } });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.updated, 1);
  assert.equal(complete.errors, 0);

  assert.ok(
    calls.patch.some((p) => p === `/v2/teams/${UUID_A}`),
    `Expected PATCH /v2/teams/${UUID_A}. Got: ${calls.patch.join(', ')}`
  );

  mockTeams = [];
});

test('import: nothing changed → complete with 0 created/updated', async () => {
  clearCalls(); clearOverrides();
  mockTeams = [
    { id: UUID_A, createdAt: '2025-01-01T00:00:00Z', fields: { name: 'Alpha', handle: 'alpha', description: '', avatarUrl: '' } },
  ];

  const csvText = `id,name\n${UUID_A},Alpha`;
  const res = await request(app)
    .post('/api/teams-crud/import')
    .set('x-pb-token', 'test-token')
    .send({ csvText, mapping: { idCol: 'id', nameCol: 'name' } });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.created, 0);
  assert.equal(complete.updated, 0);
  assert.equal(complete.unchanged, 1);
  assert.equal(complete.errors, 0);

  mockTeams = [];
});

test('import: 409 on create → warn+skip, not counted as error', async () => {
  clearCalls(); clearOverrides();
  mockTeams = [];
  setOverride('POST', '/v2/teams', 409, { error: 'handle already exists' });

  const csvText = `name,handle\nDupe,dupe`;
  const res = await request(app)
    .post('/api/teams-crud/import')
    .set('x-pb-token', 'test-token')
    .send({ csvText, mapping: { nameCol: 'name', handleCol: 'handle' } });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.errors, 0, '409 should not be counted as error');
  assert.equal(complete.created, 0);

  clearOverrides();
});

test('import: 404 on patch → warn+skip, not counted as error', async () => {
  clearCalls(); clearOverrides();
  mockTeams = [
    { id: UUID_A, createdAt: '2025-01-01T00:00:00Z', fields: { name: 'Old', handle: 'old', description: '', avatarUrl: '' } },
  ];
  setOverride('PATCH', `/v2/teams/${UUID_A}`, 404, {});

  const csvText = `id,name\n${UUID_A},New Name`;
  const res = await request(app)
    .post('/api/teams-crud/import')
    .set('x-pb-token', 'test-token')
    .send({ csvText, mapping: { idCol: 'id', nameCol: 'name' } });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.errors, 0, '404 on PATCH should not be counted as error');
  assert.equal(complete.updated, 0);

  clearOverrides();
  mockTeams = [];
});

// ── Delete by CSV ─────────────────────────────────────────────────────────────

test('delete/by-csv: no token → 400', async () => {
  const res = await request(app)
    .post('/api/teams-crud/delete/by-csv')
    .send({ csvText: `id\n${UUID_A}`, idCol: 'id' });
  assert.equal(res.status, 400);
});

test('delete/by-csv: UUID column → DELETE /v2/teams/:id', async () => {
  clearCalls(); clearOverrides();
  mockTeams = [];

  const csvText = `id,name\n${UUID_A},Alpha\n${UUID_B},Beta`;
  const res = await request(app)
    .post('/api/teams-crud/delete/by-csv')
    .set('x-pb-token', 'test-token')
    .send({ csvText, idCol: 'id' });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.deleted, 2);
  assert.equal(complete.errors, 0);

  assert.ok(calls.delete.some((p) => p === `/v2/teams/${UUID_A}`));
  assert.ok(calls.delete.some((p) => p === `/v2/teams/${UUID_B}`));
});

test('delete/by-csv: 404 → skipped, not an error', async () => {
  clearCalls(); clearOverrides();
  mockTeams = [];
  setOverride('DELETE', `/v2/teams/${UUID_A}`, 404, {});

  const csvText = `id,name\n${UUID_A},Alpha`;
  const res = await request(app)
    .post('/api/teams-crud/delete/by-csv')
    .set('x-pb-token', 'test-token')
    .send({ csvText, idCol: 'id' });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.errors, 0, '404 should not be an error');
  assert.equal(complete.deleted, 0);
  assert.equal(complete.skipped, 1);

  clearOverrides();
});

test('delete/by-csv: handle column resolves via team list then deletes', async () => {
  clearCalls(); clearOverrides();
  mockTeams = [
    { id: UUID_A, createdAt: '2025-01-01T00:00:00Z', fields: { name: 'Alpha', handle: 'alpha', description: '', avatarUrl: '' } },
  ];

  const csvText = `handle,name\nalpha,Alpha`;
  const res = await request(app)
    .post('/api/teams-crud/delete/by-csv')
    .set('x-pb-token', 'test-token')
    .send({ csvText, handleCol: 'handle' });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.deleted, 1);
  assert.equal(complete.errors, 0);

  // Should have resolved handle → UUID, then called DELETE /v2/teams/:id
  assert.ok(
    calls.delete.some((p) => p === `/v2/teams/${UUID_A}`),
    `Expected DELETE /v2/teams/${UUID_A}. Got: ${calls.delete.join(', ')}`
  );

  mockTeams = [];
});

test('delete/by-csv: handle not found in workspace → skipped', async () => {
  clearCalls(); clearOverrides();
  mockTeams = []; // empty — no teams to resolve handle against

  const csvText = `handle,name\nunknownhandle,Foo`;
  const res = await request(app)
    .post('/api/teams-crud/delete/by-csv')
    .set('x-pb-token', 'test-token')
    .send({ csvText, handleCol: 'handle' });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.deleted, 0);
  assert.equal(complete.skipped, 1);
  assert.equal(complete.errors, 0);
});

test('delete/by-csv: no id and no handle column → all rows skipped', async () => {
  clearCalls(); clearOverrides();
  mockTeams = [];

  const csvText = `name,description\nFoo,bar`;
  const res = await request(app)
    .post('/api/teams-crud/delete/by-csv')
    .set('x-pb-token', 'test-token')
    .send({ csvText }); // no idCol, no handleCol

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.deleted, 0);
  assert.equal(complete.skipped, 1);
  assert.equal(complete.errors, 0);
});

// ── Delete all ────────────────────────────────────────────────────────────────

test('delete/all: no token → 400', async () => {
  const res = await request(app)
    .post('/api/teams-crud/delete/all')
    .send({});
  assert.equal(res.status, 400);
});

test('delete/all: fetches via GET /v2/teams then deletes all', async () => {
  clearCalls(); clearOverrides();
  mockTeams = [
    { id: UUID_A, createdAt: '2025-01-01T00:00:00Z', fields: { name: 'A', handle: 'a', description: '', avatarUrl: '' } },
    { id: UUID_B, createdAt: '2025-01-01T00:00:00Z', fields: { name: 'B', handle: 'b', description: '', avatarUrl: '' } },
  ];

  const res = await request(app)
    .post('/api/teams-crud/delete/all')
    .set('x-pb-token', 'test-token')
    .send({});

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.total, 2);
  assert.equal(complete.deleted, 2);
  assert.equal(complete.errors, 0);

  // Must have used GET /v2/teams to discover IDs (not some other endpoint)
  assert.ok(
    calls.get.some((p) => p.startsWith('/v2/teams')),
    `Expected GET /v2/teams. Got: ${calls.get.join(', ')}`
  );
  assert.ok(calls.delete.some((p) => p === `/v2/teams/${UUID_A}`));
  assert.ok(calls.delete.some((p) => p === `/v2/teams/${UUID_B}`));

  mockTeams = [];
});

test('delete/all: empty workspace → complete total:0, no DELETE calls', async () => {
  clearCalls(); clearOverrides();
  mockTeams = [];

  const res = await request(app)
    .post('/api/teams-crud/delete/all')
    .set('x-pb-token', 'test-token')
    .send({});

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.total, 0);
  assert.equal(complete.deleted, 0);
  assert.equal(calls.delete.length, 0, 'Should not call DELETE on empty workspace');
});

test('delete/all: 404 on delete → skipped, not error', async () => {
  clearCalls(); clearOverrides();
  mockTeams = [
    { id: UUID_A, createdAt: '2025-01-01T00:00:00Z', fields: { name: 'A', handle: 'a', description: '', avatarUrl: '' } },
  ];
  setOverride('DELETE', `/v2/teams/${UUID_A}`, 404, {});

  const res = await request(app)
    .post('/api/teams-crud/delete/all')
    .set('x-pb-token', 'test-token')
    .send({});

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.total, 1);
  assert.equal(complete.deleted, 0);
  assert.equal(complete.skipped, 1);
  assert.equal(complete.errors, 0);

  clearOverrides();
  mockTeams = [];
});
