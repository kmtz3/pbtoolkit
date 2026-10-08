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

// ─── Audit fixes: type / display URL / customer validation / tag warnings ───

const NEW_NOTE_ID = '99999999-0000-0000-0000-000000000001';

function parseLogEvents(text) {
  const logs = [];
  for (const chunk of text.split('\n\n')) {
    const lines = chunk.trim().split('\n');
    const dataLine = lines.find((l) => l.startsWith('data:'));
    if (lines.includes('event: log') && dataLine) logs.push(JSON.parse(dataLine.slice(5).trim()));
  }
  return logs;
}

const notePosts = () => calls.other.filter((c) => c.method === 'POST' && c.path === '/v2/notes');

async function runImport(csvText, mapping) {
  return request(app)
    .post('/api/notes/import/run')
    .set('x-pb-token', 'test-token')
    .set('Content-Type', 'application/json')
    .send({ csvText, mapping });
}

test('CREATE passes the mapped note type to POST /v2/notes (not always textNote)', async () => {
  clearCalls();
  clearOverrides();
  setOverride('POST', '/v2/notes', 200, { data: { id: NEW_NOTE_ID } });

  const content = JSON.stringify([{ externalId: '1', content: 'Hi', authorType: 'customer', timestamp: '2024-01-01T00:00:00Z' }]);
  const csvText = `Title,Type,Content\nConvo,conversationNote,"${content.replace(/"/g, '""')}"\nPlain,,hello`;
  const res = await runImport(csvText, { titleColumn: 'Title', typeColumn: 'Type', contentColumn: 'Content' });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.created, 2, res.text);
  const posts = notePosts();
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.data.type, 'conversationNote');
  assert.ok(Array.isArray(posts[0].body.data.fields.content), 'conversationNote JSON content should be sent as an array');
  assert.equal(posts[1].body.data.type, 'textNote', 'empty type cell falls back to textNote');
  assert.equal(posts[1].body.data.fields.content, 'hello');
});

test('CREATE sends display URL as metadata.source.url; UPDATE warns it is ignored', async () => {
  clearCalls();
  clearOverrides();
  setOverride('POST', '/v2/notes', 200, { data: { id: NEW_NOTE_ID } });

  const csvText = [
    'PB Note ID,Title,Display URL,Source Origin,Source Record ID',
    ',With url,https://example.com/t/1,,',
    ',With source,https://example.com/t/2,zendesk,zd-2',
    `${UUID_UPDATE},Updated,https://example.com/t/3,,`,
  ].join('\n');
  const res = await runImport(csvText, {
    pbIdColumn: 'PB Note ID', titleColumn: 'Title', displayUrlColumn: 'Display URL',
    sourceOriginColumn: 'Source Origin', sourceRecordIdColumn: 'Source Record ID',
  });

  const posts = notePosts();
  assert.equal(posts.length, 2, res.text);
  assert.deepEqual(posts[0].body.data.metadata, { source: { url: 'https://example.com/t/1' } });
  assert.deepEqual(posts[1].body.data.metadata, {
    source: { system: 'zendesk', recordId: 'zd-2', url: 'https://example.com/t/2' },
  });

  const patch = calls.v2Patch.find((p) => p.path === `/v2/notes/${UUID_UPDATE}`);
  assert.ok(patch, 'update row should still PATCH fields');
  assert.equal(patch.body.data.metadata, undefined, 'PATCH must not carry metadata');
  const logs = parseLogEvents(res.text);
  assert.ok(logs.some((l) => l.level === 'warn' && /display_url is create-only/.test(l.message)), 'expected create-only warning');
});

test('invalid user_email / company_domain: warn and skip customer, no user/company created', async () => {
  clearCalls();
  clearOverrides();
  setOverride('POST', '/v2/notes', 200, { data: { id: NEW_NOTE_ID } });
  setOverride('GET', '/v2/entities?type[]=user', 200, { data: [], links: {} });
  setOverride('GET', '/v2/entities?type[]=company', 200, { data: [], links: {} });

  const csvText = 'Title,User Email,Company Domain\nA,not-an-email,\nB,,not a domain';
  const res = await runImport(csvText, { titleColumn: 'Title', userEmailColumn: 'User Email', companyDomainColumn: 'Company Domain' });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.created, 2, res.text);
  assert.equal(complete.errors, 0);
  assert.ok(!calls.other.some((c) => c.method === 'POST' && c.path === '/v2/entities'), 'no junk user/company entity should be created');
  for (const p of notePosts()) assert.equal(p.body.data.relationships, undefined);
  const warns = parseLogEvents(res.text).filter((l) => l.level === 'warn').map((l) => l.message);
  assert.ok(warns.some((m) => /Invalid user_email/.test(m)));
  assert.ok(warns.some((m) => /Invalid company_domain/.test(m)));
});

test('tag create failure is reported as a per-row warning, note still created', async () => {
  clearCalls();
  clearOverrides();
  setOverride('POST', '/v2/notes', 200, { data: { id: NEW_NOTE_ID } });
  setOverride('GET', '/v2/entities/fields/tags/values', 200, { data: [], links: {} });
  setOverride('POST', '/v2/entities/fields/tags/values', 422, { errors: [{ detail: 'bad tag' }] });

  const res = await runImport('Title,Tags\nA,newtag', { titleColumn: 'Title', tagsColumn: 'Tags' });

  const complete = parseCompleteEvent(res.text);
  assert.equal(complete.created, 1, res.text);
  assert.equal(notePosts()[0].body.data.fields.tags, undefined);
  const warns = parseLogEvents(res.text).filter((l) => l.level === 'warn');
  assert.ok(warns.some((l) => /Could not create tag "newtag"/.test(l.message)), JSON.stringify(warns));
});

test('auto-generated source_record_id is unique per run (re-import does not collide); public_api placeholder is dropped', async () => {
  clearOverrides();
  setOverride('POST', '/v2/notes', 200, { data: { id: NEW_NOTE_ID } });

  const csvText = [
    'Title,Source Origin,Source Record ID',
    'A,zendesk,',
    'B,zendesk,',
    'C,public_api,',
  ].join('\n');
  const mapping = { titleColumn: 'Title', sourceOriginColumn: 'Source Origin', sourceRecordIdColumn: 'Source Record ID' };

  clearCalls();
  await runImport(csvText, mapping);
  const run1 = notePosts().map((p) => p.body.data.metadata?.source);
  await new Promise((r) => setTimeout(r, 5)); // ensure a different run token
  clearCalls();
  await runImport(csvText, mapping);
  const run2 = notePosts().map((p) => p.body.data.metadata?.source);

  assert.equal(run1.length, 3);
  assert.equal(run1[0].system, 'zendesk');
  assert.match(run1[0].recordId, /^zendesk-[a-z0-9]+-1$/);
  assert.match(run1[1].recordId, /^zendesk-[a-z0-9]+-2$/);
  assert.notEqual(run1[0].recordId, run2[0].recordId, 'second run must not reuse the first run\'s generated IDs');
  assert.equal(run1[2], undefined, 'public_api placeholder with no record ID should not be sent as a source');
});
