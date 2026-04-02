'use strict';

/**
 * Users route tests.
 *
 * Covers: GET /api/users/fields, POST /api/users/export (SSE),
 *         POST /api/users/import/preview, POST /api/users/delete/by-csv (SSE)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');

const FIELD_UUID = 'cust1111-1111-1111-1111-111111111111';
const USER_UUID  = 'aaaa1111-2222-3333-4444-444444444444';
const COMP_UUID  = 'cccc1111-2222-3333-4444-444444444444';
const DOMAIN_KEY = 'dkey1111-2222-3333-4444-444444444444';

// ─── Mock PB API ─────────────────────────────────────────────────────────────

let mockServer, mockPort, app;
const calls = [];

function clearCalls() { calls.length = 0; }

const mockUserConfig = {
  data: {
    type: 'user',
    fields: {
      name:        { id: 'name',        name: 'Name',        schema: 'TextFieldValue' },
      email:       { id: 'email',       name: 'Email',       schema: 'TextFieldValue' },
      description: { id: 'description', name: 'Description', schema: 'RichTextFieldValue' },
      [FIELD_UUID]: { id: FIELD_UUID,   name: 'Score',       schema: 'NumberFieldValue' },
    },
  },
};

const mockUser = {
  id: USER_UUID,
  fields: { name: 'Alice', email: 'alice@acme.com', owner: { email: 'owner@co.com' }, [FIELD_UUID]: 42 },
  relationships: { data: [
    { type: 'parent', target: { id: COMP_UUID, type: 'company' } },
    { type: 'link', target: { id: 'feat-1', type: 'feature' } },
  ] },
  metadata: { source: { system: 'salesforce', recordId: 'sf-001', url: 'https://sf.com/001' } },
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-06-01T00:00:00Z',
};

const mockCompany = {
  id: COMP_UUID,
  fields: { name: 'Acme', [DOMAIN_KEY]: 'acme.com' },
};

before(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, body });

      // User config
      if (req.method === 'GET' && req.url.includes('/v2/entities/configurations/user')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockUserConfig));
        return;
      }

      // Company list (for domain cache)
      if (req.method === 'GET' && req.url.includes('type[]=company')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [mockCompany], links: {} }));
        return;
      }

      // Single company GET (domain key discovery)
      if (req.method === 'GET' && req.url === `/v2/entities/${COMP_UUID}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { fields: { domain: 'acme.com' } } }));
        return;
      }

      // User list
      if (req.method === 'GET' && req.url.includes('type[]=user')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [mockUser], links: {} }));
        return;
      }

      // Members list (for owner validation)
      if (req.method === 'GET' && req.url.startsWith('/v2/members')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ fields: { email: 'owner@co.com' } }], links: {} }));
        return;
      }

      // Delete entity
      if (req.method === 'DELETE' && req.url.startsWith('/v2/entities/')) {
        res.writeHead(204); res.end();
        return;
      }

      // Fallback
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
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

// ─── GET /api/users/fields ──────────────────────────────────────────────────

test('GET /api/users/fields: returns 400 without token', async () => {
  const res = await request(app).get('/api/users/fields');
  assert.equal(res.status, 400);
});

test('GET /api/users/fields: returns custom fields only (excludes system fields)', async () => {
  clearCalls();
  const res = await request(app)
    .get('/api/users/fields')
    .set('x-pb-token', 'test');

  assert.equal(res.status, 200);
  assert.equal(res.body.fields.length, 1);
  assert.equal(res.body.fields[0].id, FIELD_UUID);
  assert.equal(res.body.fields[0].name, 'Score');
  assert.equal(res.body.fields[0].type, 'number');
});

// ─── POST /api/users/export (SSE) ──────────────────────────────────────────

test('POST /api/users/export: returns SSE events ending with complete', async () => {
  clearCalls();
  const res = await request(app)
    .post('/api/users/export')
    .set('x-pb-token', 'test')
    .set('Accept', 'text/event-stream');

  assert.equal(res.status, 200);
  // Response should contain SSE events
  const text = res.text;
  assert.ok(text.includes('event: complete'), 'should contain complete event');

  // Parse the complete event data
  const completeMatch = text.match(/event: complete\ndata: (.+)\n/);
  assert.ok(completeMatch, 'should have complete event data');
  const data = JSON.parse(completeMatch[1]);
  assert.equal(data.count, 1);
  assert.ok(data.csv.includes('alice@acme.com'), 'CSV should contain user email');
  assert.ok(data.csv.includes('acme.com'), 'CSV should contain parent company domain');
  assert.ok(data.csv.includes('feat-1'), 'CSV should contain linked feature');
  assert.ok(data.csv.includes('salesforce'), 'CSV should contain source system');
});

// ─── POST /api/users/import/preview ─────────────────────────────────────────

test('POST /api/users/import/preview: returns 400 without csvText', async () => {
  const res = await request(app)
    .post('/api/users/import/preview')
    .set('x-pb-token', 'test')
    .send({ mapping: {} });

  assert.equal(res.status, 400);
});

test('POST /api/users/import/preview: validates missing name on create', async () => {
  clearCalls();
  const res = await request(app)
    .post('/api/users/import/preview')
    .set('x-pb-token', 'test')
    .send({
      csvText: 'email\nnewuser@co.com',
      mapping: {
        emailColumn: 'email',
        nameColumn: null,
        pbIdColumn: null,
      },
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.valid, false);
  assert.ok(res.body.errors.some((e) => e.message.includes('Name is required')));
  assert.equal(res.body.createCount, 1);
});

test('POST /api/users/import/preview: detects invalid email format', async () => {
  const res = await request(app)
    .post('/api/users/import/preview')
    .set('x-pb-token', 'test')
    .send({
      csvText: 'name,email\nAlice,not-an-email',
      mapping: {
        nameColumn: 'name',
        emailColumn: 'email',
        pbIdColumn: null,
      },
    });

  assert.equal(res.status, 200);
  assert.ok(res.body.errors.some((e) => e.message.includes('Invalid email')));
});

test('POST /api/users/import/preview: counts updates for UUID rows', async () => {
  const res = await request(app)
    .post('/api/users/import/preview')
    .set('x-pb-token', 'test')
    .send({
      csvText: `pb_id,name\n${USER_UUID},Updated Alice`,
      mapping: {
        pbIdColumn: 'pb_id',
        nameColumn: 'name',
        emailColumn: null,
      },
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.updateCount, 1);
  assert.equal(res.body.createCount, 0);
  assert.equal(res.body.valid, true);
});

// ─── POST /api/users/delete/by-csv (SSE) ────────────────────────────────────

test('POST /api/users/delete/by-csv: returns 400 without csvText', async () => {
  const res = await request(app)
    .post('/api/users/delete/by-csv')
    .set('x-pb-token', 'test')
    .send({ uuidColumn: 'id' });

  assert.equal(res.status, 400);
});

test('POST /api/users/delete/by-csv: deletes users by UUID column', async () => {
  clearCalls();
  const res = await request(app)
    .post('/api/users/delete/by-csv')
    .set('x-pb-token', 'test')
    .send({
      csvText: `pb_id\n${USER_UUID}`,
      uuidColumn: 'pb_id',
    });

  assert.equal(res.status, 200);
  const text = res.text;
  assert.ok(text.includes('event: complete'));

  const completeMatch = text.match(/event: complete\ndata: (.+)\n/);
  const data = JSON.parse(completeMatch[1]);
  assert.equal(data.total, 1);
  assert.equal(data.deleted, 1);
  assert.equal(data.errors, 0);

  // Verify DELETE was called
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes(USER_UUID)));
});

test('POST /api/users/delete/by-csv: skips non-UUID rows', async () => {
  clearCalls();
  const res = await request(app)
    .post('/api/users/delete/by-csv')
    .set('x-pb-token', 'test')
    .send({
      csvText: 'pb_id\nnot-a-uuid',
      uuidColumn: 'pb_id',
    });

  assert.equal(res.status, 200);
  const completeMatch = res.text.match(/event: complete\ndata: (.+)\n/);
  const data = JSON.parse(completeMatch[1]);
  assert.equal(data.total, 0); // non-UUIDs filtered out
});
