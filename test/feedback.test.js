'use strict';

/**
 * Feedback route tests.
 *
 * - POST /api/feedback uses the new 'textNote' type (not legacy 'simple')
 * - Input validation: non-string / oversized fields → 400 (never a crash)
 * - Module allowlist: unknown modules are mapped to "Other"
 * - Reporter email is NOT resolved/created as a PB user (body only)
 * - Per-IP rate limit (5/hour) and 100kb body cap
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');

let mockServer;
let mockPort;
const calls = { notesPost: [], entities: [] };

function clearCalls() { calls.notesPost = []; calls.entities = []; }

let app;

before(async () => {
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? (() => { try { return JSON.parse(body); } catch (_) { return {}; } })() : {};

      if (req.method === 'POST' && req.url === '/v2/notes') {
        calls.notesPost.push(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } }));
        return;
      }

      if (req.url.startsWith('/v2/entities?') || req.url === '/v2/entities') {
        calls.entities.push({ method: req.method, url: req.url });
      }

      res.writeHead(204); res.end();
    });
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = mockServer.address().port;
  process.env.PB_API_BASE_URL = `http://127.0.0.1:${mockPort}`;
  process.env.PB_FEEDBACK_TOKEN = 'test-feedback-token';
  app = require('../src/server.js');
});

// Each test gets a fresh per-IP rate-limit budget
beforeEach(async () => {
  await require('../src/routes/feedback')._feedbackRateStore.resetAll();
});

const validBody = () => ({
  module: 'Companies & Users',
  description: 'Test bug report',
  expectedBehavior: 'Should work correctly',
});

const post = (body) => request(app).post('/api/feedback').set('Content-Type', 'application/json').send(body);

after(async () => {
  await new Promise((resolve) => mockServer.close(resolve));
  delete process.env.PB_API_BASE_URL;
  delete process.env.PB_FEEDBACK_TOKEN;
});

test('POST /api/feedback: uses textNote type (not legacy simple)', async () => {
  clearCalls();

  const res = await request(app)
    .post('/api/feedback')
    .set('Content-Type', 'application/json')
    .send({
      module: 'Companies',
      description: 'Test bug report',
      expectedBehavior: 'Should work correctly',
    });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(calls.notesPost.length, 1);
  assert.equal(
    calls.notesPost[0].data.type,
    'textNote',
    'Should use new textNote type, not legacy simple',
  );
});

test('POST /api/feedback: non-string fields → 400, not a crash', async () => {
  const cases = [
    { ...validBody(), description: { $ne: 1 } },
    { ...validBody(), expectedBehavior: 42 },
    { ...validBody(), module: ['Notes'] },
    { ...validBody(), email: ['a@b.co'] },
    { ...validBody(), stepsToReproduce: { x: 1 } },
    { ...validBody(), description: '   ' },
  ];
  for (const body of cases) {
    await require('../src/routes/feedback')._feedbackRateStore.resetAll();
    clearCalls();
    const res = await post(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
    assert.ok(res.body.error);
    assert.equal(calls.notesPost.length, 0);
  }
});

test('POST /api/feedback: oversized fields → 400', async () => {
  let res = await post({ ...validBody(), module: 'x'.repeat(101) });
  assert.equal(res.status, 400);
  res = await post({ ...validBody(), description: 'x'.repeat(10001) });
  assert.equal(res.status, 400);
  res = await post({ ...validBody(), stepsToReproduce: 'x'.repeat(10001) });
  assert.equal(res.status, 400);
});

test('POST /api/feedback: body over 100kb → 413', async () => {
  const res = await post({ ...validBody(), description: 'x'.repeat(120 * 1024) });
  assert.equal(res.status, 413);
});

test('POST /api/feedback: unknown module is mapped to "Other"; known module kept', async () => {
  clearCalls();
  let res = await post({ ...validBody(), module: 'Totally Made Up <script>' });
  assert.equal(res.status, 200);
  assert.equal(calls.notesPost[0].data.fields.name, '🐞 Bug Report — Other');

  clearCalls();
  res = await post(validBody());
  assert.equal(res.status, 200);
  assert.equal(calls.notesPost[0].data.fields.name, '🐞 Bug Report — Companies & Users');
});

test('POST /api/feedback: reporter email is not looked up or created as a user', async () => {
  clearCalls();
  const res = await post({ ...validBody(), email: 'reporter@example.com' });
  assert.equal(res.status, 200);
  assert.equal(calls.entities.length, 0, `no /v2/entities calls expected, got ${JSON.stringify(calls.entities)}`);
  const note = calls.notesPost[0];
  assert.equal(note.data.relationships, undefined);
  assert.ok(note.data.fields.content.includes('reporter@example.com'), 'email should be in the note body');
});

test('POST /api/feedback: rate limited to 5 per hour per IP', async () => {
  for (let i = 0; i < 5; i++) {
    const res = await post(validBody());
    assert.equal(res.status, 200, `request ${i + 1} should pass`);
  }
  const res = await post(validBody());
  assert.equal(res.status, 429);
});
