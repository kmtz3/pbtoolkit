'use strict';

/**
 * Notes import tests — TDD for Bug 1 (empty PATCH payload) and Bug 2 (abort mid-row).
 *
 * v1 is retired — all note create/update goes through /v2/notes now (no separate
 * v1-create-then-v2-backfill step). Bug 2 verifies the equivalent behaviour in the
 * v2-only flow: aborting mid-row stops the hierarchy-linking step that runs after
 * the note write from firing.
 *
 * Uses a local mock PB API server to intercept outgoing pbFetch calls.
 * Set PB_API_BASE_URL env var BEFORE requiring the app so pbClient picks it up.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const request = require('supertest');

// UUIDs used in tests
const UUID_UPDATE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UUID_PREFIX  = (i) => `${i.toString().padStart(8, '0')}-0000-0000-0000-${i.toString().padStart(12, '0')}`;

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
// Recorded calls: { method, path, body }
const calls = { v1Patch: [], v2Patch: [], other: [] };
// Per-test response overrides: map of `METHOD:path` → { status, body }
const responseOverrides = new Map();

function setOverride(method, path, status, body) {
  responseOverrides.set(`${method}:${path}`, { status, body });
}
function clearOverrides() { responseOverrides.clear(); }
function clearCalls() {
  calls.v1Patch = [];
  calls.v2Patch = [];
  calls.other = [];
}

let app; // loaded after mock server is ready

before(async () => {
  // 1. Start the mock PB API server
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? (() => { try { return JSON.parse(body); } catch (_) { return {}; } })() : {};
      const key = `${req.method}:${req.url}`;

      // Record
      if (req.method === 'PATCH' && !req.url.startsWith('/v2/')) {
        calls.v1Patch.push({ path: req.url, body: parsed });
      } else if (req.method === 'PATCH' && req.url.startsWith('/v2/')) {
        calls.v2Patch.push({ path: req.url, body: parsed });
      } else {
        calls.other.push({ method: req.method, path: req.url, body: parsed });
      }

      // Check override first
      if (responseOverrides.has(key)) {
        const { status, body: respBody } = responseOverrides.get(key);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(respBody));
        return;
      }

      // Default: simulate PB API behaviour
      if (req.method === 'PATCH' && !req.url.startsWith('/v2/')) {
        // v1 PATCH: reject empty body with 422 (mimics real PB API behaviour)
        const hasContent = Object.keys(parsed).length > 0;
        if (!hasContent) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, errors: { data: ['is missing'] } }));
        } else {
          res.writeHead(204); res.end();
        }
        return;
      }

      // All other requests: 204 success
      res.writeHead(204); res.end();
    });
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  mockPort = mockServer.address().port;

  // 2. Point pbClient at the mock server BEFORE requiring the app
  process.env.PB_API_BASE_URL = `http://127.0.0.1:${mockPort}`;

  // 3. Load the app (reads PB_API_BASE_URL in createClient at request time)
  app = require('../src/server.js');
});

after(async () => {
  await new Promise((resolve) => mockServer.close(resolve));
  delete process.env.PB_API_BASE_URL;
});

// ─── Test A: Bug 1 — empty PATCH payload ────────────────────────────────────

test('Bug 1: UPDATE row with no mapped fields — PATCH not sent, skipped:1, errors:0', async () => {
  clearCalls();
  clearOverrides();

  // CSV: only pb_id column — no title, content, etc.
  const csvText = `PB Note ID\n${UUID_UPDATE}`;
  const mapping  = { pbIdColumn: 'PB Note ID' }; // nothing else mapped

  const res = await request(app)
    .post('/api/notes/import/run')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({ csvText, mapping });

  const complete = parseCompleteEvent(res.text);
  assert.ok(complete, `SSE complete event not found in response:\n${res.text}`);

  // BEFORE FIX: PATCH is sent with {} → 422 → errors:1, skipped undefined → FAIL
  // AFTER FIX:  PATCH not sent          → errors:0, skipped:1             → PASS
  assert.equal(calls.v1Patch.length, 0, `Expected 0 v1 PATCH calls, got ${calls.v1Patch.length}`);
  assert.equal(complete.skipped, 1,     `Expected skipped:1, got ${complete.skipped}`);
  assert.equal(complete.errors,  0,     `Expected errors:0, got ${complete.errors}`);
});

// ─── Test B: Bug 2 — abort mid-row stops hierarchy linking ──────────────────

test('Bug 2: aborting SSE connection mid-row stops hierarchy linking from running', (t, done) => {
  clearCalls();
  clearOverrides();

  const LINKED_ENTITY = 'ffffffff-0000-0000-0000-000000000001';
  const DELAY_MS = 300;

  // Make the mock server delay the v2 note PATCH by 300ms, so we can abort while
  // it's in flight, then record whether the hierarchy-link POST fires afterward.
  const slowMockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = body ? (() => { try { return JSON.parse(body); } catch (_) { return {}; } })() : {};

      if (req.method === 'PATCH' && req.url.startsWith(`/v2/notes/${UUID_UPDATE}`)) {
        calls.v2Patch.push({ path: req.url, body: parsed });
        setTimeout(() => { res.writeHead(204); res.end(); }, DELAY_MS);
      } else if (req.method === 'POST' && req.url.includes('/relationships')) {
        calls.other.push({ method: 'POST', path: req.url, body: parsed });
        res.writeHead(204); res.end();
      } else {
        res.writeHead(204); res.end();
      }
    });
  });

  slowMockServer.listen(0, '127.0.0.1', () => {
    const slowPort = slowMockServer.address().port;
    process.env.PB_API_BASE_URL = `http://127.0.0.1:${slowPort}`;

    // CSV: one UPDATE row with a title change + a linked entity, so hierarchy
    // linking runs after the note PATCH completes (if not aborted first).
    const csvText = `PB Note ID,Title,Linked Entities\n${UUID_UPDATE},Test Note,${LINKED_ENTITY}`;
    const mapping  = { pbIdColumn: 'PB Note ID', titleColumn: 'Title', linkedEntitiesColumn: 'Linked Entities' };
    const bodyStr  = JSON.stringify({ csvText, mapping });

    const serverForTest = app.listen(0, '127.0.0.1', () => {
      const port = serverForTest.address().port;

      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/api/notes/import/run',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-pb-token': 'test-token',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      });

      req.on('response', (res) => {
        // Destroy the SSE connection 50ms after it opens (during the 300ms PATCH delay)
        setTimeout(() => req.destroy(), 50);
      });
      req.on('error', () => {}); // ignore ECONNRESET from destroy
      req.write(bodyStr);
      req.end();
    });

    // Wait long enough for the v2 PATCH to complete (300ms) + linking if it runs (+100ms)
    setTimeout(() => {
      serverForTest.close(() => {
        slowMockServer.close(() => {
          // Restore the original mock server URL
          process.env.PB_API_BASE_URL = `http://127.0.0.1:${mockPort}`;

          try {
            assert.equal(calls.v2Patch.length, 1,
              `Expected 1 v2 PATCH (already in flight), got ${calls.v2Patch.length}`);
            assert.equal(calls.other.length, 0,
              `Expected 0 linking calls (should be skipped after abort), got ${calls.other.length}`);
            done();
          } catch (err) {
            done(err);
          }
        });
      });
    }, DELAY_MS + 150); // PATCH delay + margin
  });
});
