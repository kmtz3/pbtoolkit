'use strict';

/**
 * Companies delete tests — Phase 4 (v2).
 *
 * Asserts:
 * - delete/by-csv uses DELETE /v2/entities/{id} (not /companies/{id})
 * - delete/all uses POST /v2/entities/search to collect IDs (not offset GET /companies)
 * - 404 on delete still treated as success (not an error)
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');

const UUID_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const UUID_B = 'bbbbbbbb-0000-0000-0000-000000000002';

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
const calls = { delete: [], post: [], get: [] };
const responseOverrides = new Map();

// Configurable company list returned by POST /v2/entities/search (for delete/all)
let mockSearchCompanies = [];

function setOverride(method, path, status, body) {
  responseOverrides.set(`${method}:${path}`, { status, body });
}
function clearOverrides() { responseOverrides.clear(); }
function clearCalls() {
  calls.delete = [];
  calls.post = [];
  calls.get = [];
}

let app;

before(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const key = `${req.method}:${req.url}`;

      // Record
      if (req.method === 'DELETE') {
        calls.delete.push(req.url);
      } else if (req.method === 'POST') {
        calls.post.push(req.url);
      } else if (req.method === 'GET') {
        calls.get.push(req.url);
      }

      // Per-test override
      if (responseOverrides.has(key)) {
        const { status, body: respBody } = responseOverrides.get(key);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(respBody));
        return;
      }

      // Default responses
      if (req.method === 'DELETE') {
        res.writeHead(204); res.end();
        return;
      }

      if (req.method === 'POST' && req.url.startsWith('/v2/entities/search')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: mockSearchCompanies, links: { next: null } }));
        return;
      }

      // GET /v2/entities?type[]=company — used by fetchAllPages for delete/all
      if (req.method === 'GET' && req.url.startsWith('/v2/entities')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: mockSearchCompanies, links: { next: null } }));
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

test('delete/by-csv: no token → 400', async () => {
  const res = await request(app)
    .post('/api/companies/delete/by-csv')
    .set('Content-Type', 'application/json')
    .send({ csvText: `Company ID\n${UUID_A}`, uuidColumn: 'Company ID' });
  assert.equal(res.status, 400);
});

test('delete/by-csv: uses DELETE /v2/entities/{id} (not /companies/{id})', async () => {
  clearCalls(); clearOverrides();

  const csvText = `Company ID\n${UUID_A}\n${UUID_B}`;

  const res = await request(app)
    .post('/api/companies/delete/by-csv')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({ csvText, uuidColumn: 'Company ID' });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.deleted, 2);
  assert.equal(complete.errors, 0);

  // Must use v2 endpoint
  assert.ok(
    calls.delete.every((p) => p.startsWith('/v2/entities/')),
    `All deletes should use /v2/entities/. Got: ${calls.delete.join(', ')}`
  );
  assert.ok(calls.delete.some((p) => p.includes(UUID_A)));
  assert.ok(calls.delete.some((p) => p.includes(UUID_B)));

  // Must NOT use old v1 endpoint
  assert.ok(
    !calls.delete.some((p) => p.startsWith('/companies/')),
    'Should NOT have called DELETE /companies/{id}'
  );
});

test('delete/all: uses POST /v2/entities/search to collect IDs, then deletes via v2', async () => {
  clearCalls(); clearOverrides();
  mockSearchCompanies = [{ id: UUID_A }, { id: UUID_B }];

  const res = await request(app)
    .post('/api/companies/delete/all')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({});

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.total, 2);
  assert.equal(complete.deleted, 2);

  // v2 GET used for collecting IDs (fetchAllPages, not offset GET /companies v1)
  assert.ok(
    calls.get.some((p) => p.startsWith('/v2/entities')),
    'Should have used GET /v2/entities?type[]=company to collect IDs'
  );
  assert.ok(
    !calls.get.some((p) => /^\/companies($|\?)/.test(p)),
    'Should NOT have used GET /companies (v1) for ID collection'
  );

  // v2 delete used
  assert.ok(
    calls.delete.every((p) => p.startsWith('/v2/entities/')),
    'All deletes should use /v2/entities/'
  );

  mockSearchCompanies = [];
});

test('delete/by-csv: 404 on delete → treated as success (not counted as error)', async () => {
  clearCalls(); clearOverrides();
  setOverride('DELETE', `/v2/entities/${UUID_A}`, 404, {});

  const csvText = `Company ID\n${UUID_A}`;

  const res = await request(app)
    .post('/api/companies/delete/by-csv')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({ csvText, uuidColumn: 'Company ID' });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found:\n${res.text}`);
  assert.equal(complete.errors, 0);   // 404 = skipped, not an error
  assert.equal(complete.deleted, 0);  // not counted as deleted either
});
