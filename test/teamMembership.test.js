'use strict';

/**
 * Team Membership route tests.
 *
 * Coverage:
 *  - GET  /api/team-membership/metadata  — returns teams + memberCount; cache behaviour; no token → 400
 *  - GET  /api/team-membership/export    — format A (email/name/role/team-cols); format B (stacked);
 *                                          teamIds filter; empty workspace
 *  - POST /api/team-membership/preview   — format A diff; format B diff; mode variations;
 *                                          unresolvable emails; name resolution; hard errors
 *  - POST /api/team-membership/import    — add → PATCH /v2/teams/:id with addItems op;
 *                                          remove → PATCH /v2/teams/:id with removeItems op;
 *                                          addItems/removeItems are idempotent;
 *                                          no changes → complete with zeroes
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const request = require('supertest');

// ── Stable UUIDs ─────────────────────────────────────────────────────────────

const TEAM_A_ID  = 'aaaaaaaa-0000-0000-0000-000000000001';
const TEAM_B_ID  = 'bbbbbbbb-0000-0000-0000-000000000002';
const MEMBER_1_ID = 'cccccccc-0000-0000-0000-000000000003';
const MEMBER_2_ID = 'dddddddd-0000-0000-0000-000000000004';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse the first `event: complete` payload from a raw SSE body string. */
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

/** Parse first `event: error` payload. */
function parseErrorEvent(text) {
  for (const chunk of text.split('\n\n')) {
    const lines = chunk.trim().split('\n');
    if (lines.some((l) => l === 'event: error')) {
      const dataLine = lines.find((l) => l.startsWith('data:'));
      if (dataLine) return JSON.parse(dataLine.slice(5).trim());
    }
  }
  return null;
}

// ── Mock PB API server ────────────────────────────────────────────────────────

let mockServer;
let mockPort;
const calls = { delete: [], post: [], patch: [], get: [] };
const responseOverrides = new Map();

// Default mock data — mutated per test
let mockTeams   = [];
let mockMembers = [];
// teamId → [memberId, ...]
let mockMemberships = {};

function setOverride(method, path, status, body) {
  responseOverrides.set(`${method.toUpperCase()}:${path}`, { status, body });
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

      // Record calls (base path only, strip query string for simplicity in get[])
      const basePath = req.url.split('?')[0];
      if      (req.method === 'DELETE') calls.delete.push(basePath);
      else if (req.method === 'POST')   calls.post.push(basePath);
      else if (req.method === 'PATCH')  calls.patch.push(basePath);
      else if (req.method === 'GET')    calls.get.push(basePath);

      // Per-test override (takes priority)
      if (responseOverrides.has(key)) {
        const { status, body: rb } = responseOverrides.get(key);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rb));
        return;
      }

      // GET /v2/members — returns mockMembers
      if (req.method === 'GET' && req.url.startsWith('/v2/members')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: mockMembers, links: { next: null } }));
        return;
      }

      // GET /v2/teams/:id/members — returns mock team members
      const membersGetMatch = req.url.match(/^\/v2\/teams\/([^/]+)\/members/);
      if (req.method === 'GET' && membersGetMatch) {
        const teamId = membersGetMatch[1];
        const members = (mockMemberships[teamId] || []).map((memberId) => {
          const m = mockMembers.find((mm) => mm.id === memberId);
          return { id: memberId, fields: { name: m?.fields?.name ?? '', email: m?.fields?.email ?? '' } };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: members, links: { next: null } }));
        return;
      }

      // GET /v2/teams — returns mockTeams (must come after /members match)
      if (req.method === 'GET' && req.url.startsWith('/v2/teams')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: mockTeams, links: { next: null } }));
        return;
      }

      // PATCH /v2/teams/:id — team update (member patch operations)
      const teamPatchMatch = req.url.match(/^\/v2\/teams\/([^/]+)$/);
      if (req.method === 'PATCH' && teamPatchMatch) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { id: teamPatchMatch[1] } }));
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

// ── Helper: build Format A CSV ────────────────────────────────────────────────

function formatACsv(rows) {
  const header = `email,name,role,"Team Alpha [${TEAM_A_ID}]","Team Beta [${TEAM_B_ID}]"`;
  const lines  = rows.map((r) => `${r.email},${r.name},${r.role},${r.alpha ?? ''},${r.beta ?? ''}`);
  return [header, ...lines].join('\n');
}

function formatBCsv(rows) {
  const header = `"Team Alpha [${TEAM_A_ID}]","Team Beta [${TEAM_B_ID}]"`;
  const lines  = rows.map((r) => `${r.alpha ?? ''},${r.beta ?? ''}`);
  return [header, ...lines].join('\n');
}

// ── Shared workspace fixture ───────────────────────────────────────────────────
//  Two teams, two members. Member 1 is in Team A, Member 2 is in Team B.

function setupWorkspace() {
  mockTeams = [
    { id: TEAM_A_ID, fields: { name: 'Team Alpha', handle: 'team-alpha' } },
    { id: TEAM_B_ID, fields: { name: 'Team Beta',  handle: 'team-beta'  } },
  ];
  mockMembers = [
    { id: MEMBER_1_ID, fields: { name: 'Alice', email: 'alice@example.com', role: 'maker'  } },
    { id: MEMBER_2_ID, fields: { name: 'Bob',   email: 'bob@example.com',   role: 'viewer' } },
  ];
  mockMemberships = {
    [TEAM_A_ID]: [MEMBER_1_ID],
    [TEAM_B_ID]: [MEMBER_2_ID],
  };
}

// ── metadata ─────────────────────────────────────────────────────────────────

test('metadata: no token → 400', async () => {
  const res = await request(app).get('/api/team-membership/metadata');
  assert.equal(res.status, 400);
});

test('metadata: returns teams list sorted alphabetically + memberCount', async () => {
  setupWorkspace();
  clearCalls();

  // Use a unique token so this test gets a fresh cache
  const res = await request(app)
    .get('/api/team-membership/metadata?refresh=true')
    .set('x-pb-token', 'meta-token-1');

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.teams));
  assert.equal(res.body.teams.length, 2);
  // Alphabetically: Team Alpha before Team Beta
  assert.equal(res.body.teams[0].name, 'Team Alpha');
  assert.equal(res.body.teams[1].name, 'Team Beta');
  assert.equal(res.body.memberCount, 2);
  assert.ok(res.body.fetchedAt); // ISO string
});

test('metadata: refresh=true forces a new API fetch (not stale cache)', async () => {
  setupWorkspace();
  clearCalls();

  const token = 'meta-token-refresh';

  // First call to warm the cache
  await request(app)
    .get('/api/team-membership/metadata?refresh=true')
    .set('x-pb-token', token);

  const callsAfterFirst = calls.get.filter((u) => u.startsWith('/v2/')).length;

  // Second call with refresh=true — should re-fetch, not use cache
  clearCalls();
  const res2 = await request(app)
    .get('/api/team-membership/metadata?refresh=true')
    .set('x-pb-token', token);

  assert.equal(res2.status, 200);
  // GET /v2/members + GET /v2/teams + 2× GET /v2/teams/:id/members
  const fetchCalls = calls.get.filter((u) => u.startsWith('/v2/'));
  assert.ok(fetchCalls.length >= 2, 'should re-fetch after refresh=true');
});

test('metadata: empty workspace → teams:[], memberCount:0', async () => {
  mockTeams   = [];
  mockMembers = [];
  mockMemberships = {};

  const res = await request(app)
    .get('/api/team-membership/metadata?refresh=true')
    .set('x-pb-token', 'meta-token-empty');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.teams, []);
  assert.equal(res.body.memberCount, 0);
});

// ── export ───────────────────────────────────────────────────────────────────

test('export: no token → 400', async () => {
  const res = await request(app).get('/api/team-membership/export');
  assert.equal(res.status, 400);
});

test('export: format A — header includes email/name/role/team-cols; ✓ for assigned', async () => {
  setupWorkspace();

  const res = await request(app)
    .get('/api/team-membership/export?format=A')
    .set('x-pb-token', 'export-token-a');

  assert.equal(res.status, 200);
  assert.ok(res.headers['content-type'].includes('text/csv'));
  assert.ok(res.headers['content-disposition'].includes('.csv'));

  const lines = res.text.replace(/^\uFEFF/, '').trim().split('\n');
  const header = lines[0];
  assert.ok(header.includes('email'), 'header should contain email');
  assert.ok(header.includes('name'),  'header should contain name');
  assert.ok(header.includes('role'),  'header should contain role');
  assert.ok(header.includes(TEAM_A_ID), 'header should include Team A UUID');
  assert.ok(header.includes(TEAM_B_ID), 'header should include Team B UUID');

  // Alice is in Team A — find her row
  const aliceRow = lines.find((l) => l.includes('alice@example.com'));
  assert.ok(aliceRow, 'Alice should appear in export');
  assert.ok(aliceRow.includes('✓'), 'Alice should have ✓ for her assigned team');
});

test('export: format B — one column per team, member emails stacked', async () => {
  setupWorkspace();

  const res = await request(app)
    .get('/api/team-membership/export?format=B')
    .set('x-pb-token', 'export-token-b');

  assert.equal(res.status, 200);

  const lines = res.text.replace(/^\uFEFF/, '').trim().split('\n');
  const header = lines[0];
  // Format B has no email/name/role columns — just team columns
  assert.ok(!header.startsWith('email'), 'Format B should not start with email');
  assert.ok(header.includes(TEAM_A_ID));
  assert.ok(header.includes(TEAM_B_ID));

  // Data rows should contain member emails (not IDs)
  const dataRows = lines.slice(1).join('\n');
  assert.ok(dataRows.includes('alice@example.com'));
  assert.ok(dataRows.includes('bob@example.com'));
});

test('export: teamIds filter — only requested teams appear in CSV', async () => {
  setupWorkspace();

  const res = await request(app)
    .get(`/api/team-membership/export?format=A&teamIds=${TEAM_A_ID}`)
    .set('x-pb-token', 'export-token-filter');

  assert.equal(res.status, 200);

  const header = res.text.replace(/^\uFEFF/, '').split('\n')[0];
  assert.ok(header.includes(TEAM_A_ID),  'filtered team should be present');
  assert.ok(!header.includes(TEAM_B_ID), 'excluded team should not be present');
});

test('export: empty workspace → format A with header only (no data rows)', async () => {
  mockTeams   = [];
  mockMembers = [];
  mockMemberships = {};

  const res = await request(app)
    .get('/api/team-membership/export?format=A')
    .set('x-pb-token', 'export-token-empty');

  assert.equal(res.status, 200);
  const lines = res.text.replace(/^\uFEFF/, '').trim().split('\n').filter(Boolean);
  // Only the header row (email,name,role) — no team columns since no teams
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('email'));
});

// ── preview ───────────────────────────────────────────────────────────────────

test('preview: no token → 400', async () => {
  const res = await request(app)
    .post('/api/team-membership/preview')
    .send({ csvText: 'x', mode: 'add' });
  assert.equal(res.status, 400);
});

test('preview: missing csvText → 400', async () => {
  const res = await request(app)
    .post('/api/team-membership/preview')
    .set('x-pb-token', 'preview-token')
    .send({ mode: 'add' });
  assert.equal(res.status, 400);
});

test('preview: invalid mode → 400', async () => {
  const res = await request(app)
    .post('/api/team-membership/preview')
    .set('x-pb-token', 'preview-token')
    .send({ csvText: 'email\nalice@example.com', mode: 'overwrite' });
  assert.equal(res.status, 400);
});

test('preview: format A, add mode — unassigned member shows in toAdd', async () => {
  setupWorkspace();

  // Bob is NOT currently in Team Alpha — adding him should appear as toAdd
  const csv = formatACsv([
    { email: 'bob@example.com', name: 'Bob', role: 'viewer', alpha: '✓', beta: '' },
  ]);

  const res = await request(app)
    .post('/api/team-membership/preview')
    .set('x-pb-token', 'preview-add-1')
    .send({ csvText: csv, mode: 'add' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.hardErrors, []);
  const alphaDiff = res.body.diffs.find((d) => d.teamId === TEAM_A_ID);
  assert.ok(alphaDiff, 'diff for Team Alpha should exist');
  assert.equal(alphaDiff.toAdd.length, 1);
  assert.equal(alphaDiff.toAdd[0].email, 'bob@example.com');
  assert.equal(alphaDiff.toRemove.length, 0);
});

test('preview: format A, set mode — member not in CSV shows in toRemove when team is in scope', async () => {
  setupWorkspace();

  // In set mode a team only enters "scope" when it has at least one ✓ assignment.
  // Bob (✓ for Alpha) puts Alpha in scope. Alice IS currently in Alpha but is NOT
  // listed in the CSV → she appears in toRemove.
  const csv = formatACsv([
    { email: 'bob@example.com', name: 'Bob', role: 'viewer', alpha: '✓', beta: '' },
  ]);

  const res = await request(app)
    .post('/api/team-membership/preview')
    .set('x-pb-token', 'preview-set-1')
    .send({ csvText: csv, mode: 'set' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.hardErrors, []);
  const alphaDiff = res.body.diffs.find((d) => d.teamId === TEAM_A_ID);
  assert.ok(alphaDiff, 'Team Alpha should be in scope because Bob has ✓');
  // Bob is added, Alice is removed
  assert.equal(alphaDiff.toAdd.length, 1, 'Bob should be added');
  assert.equal(alphaDiff.toAdd[0].email, 'bob@example.com');
  assert.equal(alphaDiff.toRemove.length, 1, 'Alice should be removed');
  assert.equal(alphaDiff.toRemove[0].email, 'alice@example.com');
});

test('preview: format A, remove mode — only toRemove populated', async () => {
  setupWorkspace();

  // Alice is in Team Alpha; request to remove her
  const csv = formatACsv([
    { email: 'alice@example.com', name: 'Alice', role: 'maker', alpha: '✓', beta: '' },
  ]);

  const res = await request(app)
    .post('/api/team-membership/preview')
    .set('x-pb-token', 'preview-remove-1')
    .send({ csvText: csv, mode: 'remove' });

  assert.equal(res.status, 200);
  const alphaDiff = res.body.diffs.find((d) => d.teamId === TEAM_A_ID);
  assert.ok(alphaDiff);
  assert.equal(alphaDiff.toRemove.length, 1);
  assert.equal(alphaDiff.toAdd.length, 0);
});

test('preview: format B CSV parsed correctly', async () => {
  setupWorkspace();

  // Format B: Bob in Team Alpha column
  const csv = formatBCsv([{ alpha: 'bob@example.com', beta: '' }]);

  const res = await request(app)
    .post('/api/team-membership/preview')
    .set('x-pb-token', 'preview-format-b')
    .send({ csvText: csv, mode: 'add' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.hardErrors, []);
  const alphaDiff = res.body.diffs.find((d) => d.teamId === TEAM_A_ID);
  assert.ok(alphaDiff);
  assert.equal(alphaDiff.toAdd.length, 1);
  assert.equal(alphaDiff.toAdd[0].email, 'bob@example.com');
});

test('preview: unresolvable email → reported in unresolvableEmails, not hardError', async () => {
  setupWorkspace();

  const csv = formatACsv([
    { email: 'ghost@example.com', name: 'Ghost', role: 'viewer', alpha: '✓', beta: '' },
  ]);

  const res = await request(app)
    .post('/api/team-membership/preview')
    .set('x-pb-token', 'preview-unresolvable')
    .send({ csvText: csv, mode: 'add' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.hardErrors, []);
  assert.ok(res.body.unresolvableEmails.length >= 1);
  assert.equal(res.body.unresolvableEmails[0].email, 'ghost@example.com');
});

test('preview: unknown teamId in header → hardError', async () => {
  setupWorkspace();

  const unknownId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const csv = `email,name,role,"Ghost Team [${unknownId}]"\nalice@example.com,Alice,maker,✓`;

  const res = await request(app)
    .post('/api/team-membership/preview')
    .set('x-pb-token', 'preview-unknown-team')
    .send({ csvText: csv, mode: 'add' });

  assert.equal(res.status, 200);
  assert.ok(res.body.hardErrors.length > 0, 'should have a hardError for unknown team');
  assert.ok(res.body.hardErrors[0].includes('not found'));
});

test('preview: undetectable CSV format → hardError', async () => {
  setupWorkspace();

  // First column is neither "email" nor a "Name [uuid]" pattern
  const csv = 'first_name,last_name\nAlice,Smith';

  const res = await request(app)
    .post('/api/team-membership/preview')
    .set('x-pb-token', 'preview-bad-format')
    .send({ csvText: csv, mode: 'add' });

  assert.equal(res.status, 200);
  assert.ok(res.body.hardErrors.length > 0, 'should have a hardError for unknown format');
});

test('preview: name-resolved teams reported in nameResolvedTeams', async () => {
  setupWorkspace();

  // Header has no UUID — just the name; should resolve by name match
  const csv = `email,name,role,"Team Alpha"\nalice@example.com,Alice,maker,✓`;

  const res = await request(app)
    .post('/api/team-membership/preview')
    .set('x-pb-token', 'preview-name-resolve')
    .send({ csvText: csv, mode: 'add' });

  assert.equal(res.status, 200);
  // No hardError — resolved by name
  assert.deepEqual(res.body.hardErrors, []);
  assert.ok(res.body.nameResolvedTeams.length >= 1);
  assert.equal(res.body.nameResolvedTeams[0].resolvedId, TEAM_A_ID);
});

// ── import (SSE) ─────────────────────────────────────────────────────────────

test('import: no token → 400', async () => {
  const res = await request(app)
    .post('/api/team-membership/import')
    .send({ csvText: 'x', mode: 'add' });
  assert.equal(res.status, 400);
});

test('import: missing csvText → 400', async () => {
  const res = await request(app)
    .post('/api/team-membership/import')
    .set('x-pb-token', 'import-token')
    .send({ mode: 'add' });
  assert.equal(res.status, 400);
});

test('import: add mode — PATCH /v2/teams/:id with addItems called for new assignment', async () => {
  setupWorkspace();
  clearCalls();

  // Bob is NOT in Team Alpha — add mode should PATCH to add him
  const csv = formatACsv([
    { email: 'bob@example.com', name: 'Bob', role: 'viewer', alpha: '✓', beta: '' },
  ]);

  const res = await request(app)
    .post('/api/team-membership/import')
    .set('x-pb-token', 'import-add-1')
    .buffer(true).parse((res, cb) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => cb(null, data));
    })
    .send({ csvText: csv, mode: 'add' });

  const complete = parseCompleteEvent(res.body);
  assert.ok(complete, 'should receive a complete event');
  assert.equal(complete.added, 1);
  assert.equal(complete.errors.length, 0);

  // Verify the PATCH was made to the team endpoint
  const teamPatch = calls.patch.find((u) => u.includes(`/v2/teams/${TEAM_A_ID}`));
  assert.ok(teamPatch, 'should call PATCH /v2/teams/:id with addItems');
});

test('import: remove mode — PATCH /v2/teams/:id with removeItems called', async () => {
  setupWorkspace();
  clearCalls();

  // Alice is in Team Alpha — remove mode should PATCH to remove her
  const csv = formatACsv([
    { email: 'alice@example.com', name: 'Alice', role: 'maker', alpha: '✓', beta: '' },
  ]);

  const res = await request(app)
    .post('/api/team-membership/import')
    .set('x-pb-token', 'import-remove-1')
    .buffer(true).parse((res, cb) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => cb(null, data));
    })
    .send({ csvText: csv, mode: 'remove' });

  const complete = parseCompleteEvent(res.body);
  assert.ok(complete, 'should receive a complete event');
  assert.equal(complete.removed, 1);
  assert.equal(complete.errors.length, 0);

  const teamPatch = calls.patch.find((u) => u.includes(`/v2/teams/${TEAM_A_ID}`));
  assert.ok(teamPatch, 'should call PATCH /v2/teams/:id with removeItems');
});

test('import: no changes to apply → complete with zeroes, no API relationship calls', async () => {
  setupWorkspace();
  clearCalls();

  // Alice is already in Team Alpha — add mode with same assignment = no-op
  const csv = formatACsv([
    { email: 'alice@example.com', name: 'Alice', role: 'maker', alpha: '✓', beta: '' },
  ]);

  const res = await request(app)
    .post('/api/team-membership/import')
    .set('x-pb-token', 'import-noop-1')
    .buffer(true).parse((res, cb) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => cb(null, data));
    })
    .send({ csvText: csv, mode: 'add' });

  const complete = parseCompleteEvent(res.body);
  assert.ok(complete, 'should receive a complete event');
  assert.equal(complete.added,   0);
  assert.equal(complete.removed, 0);
  assert.equal(complete.errors.length, 0);

  // No PATCH calls for member changes
  const teamPatches = calls.patch.filter((u) => u.startsWith('/v2/teams/'));
  assert.equal(teamPatches.length, 0, 'no PATCH calls for no-op import');
});

test('import: PATCH error on team → all members counted as errors', async () => {
  setupWorkspace();
  clearCalls();

  // Force PATCH /v2/teams/:id to return 500
  setOverride('PATCH', `/v2/teams/${TEAM_A_ID}`, 500, { errors: [{ detail: 'Internal error' }] });

  const csv = formatACsv([
    { email: 'bob@example.com', name: 'Bob', role: 'viewer', alpha: '✓', beta: '' },
  ]);

  const res = await request(app)
    .post('/api/team-membership/import')
    .set('x-pb-token', 'import-err')
    .buffer(true).parse((res, cb) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => cb(null, data));
    })
    .send({ csvText: csv, mode: 'add' });

  clearOverrides();

  const complete = parseCompleteEvent(res.body);
  assert.ok(complete, 'should receive complete');
  assert.equal(complete.added, 0);
  assert.equal(complete.errors.length, 1, 'PATCH failure should count as error');
});
