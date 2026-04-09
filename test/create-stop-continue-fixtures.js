#!/usr/bin/env node
/**
 * create-stop-continue-fixtures.js
 *
 * Creates 6 duplicate groups (7 total dups) each loaded with notes and users,
 * specifically to test the Stop / Continue run flow in Merge Duplicate Companies.
 *
 * Run:  node test/create-stop-continue-fixtures.js
 *
 * Reads:  .claude/.env  (PB_TOKEN, PB_EU)
 * Writes: test/stop-continue-fixtures.json
 *
 * Groups created
 * ──────────────────────────────────────────────────────────────────────────────
 *  P1  pbtest-stop1.invalid   1 dup · 2 direct notes + 1 user via note
 *  P2  pbtest-stop2.invalid   1 dup · 3 direct notes
 *  P3  pbtest-stop3.invalid   1 dup · 2 direct-parent users (no notes)
 *  P4  pbtest-stop4.invalid   1 dup · 1 note + 2 direct users
 *  P5  pbtest-stop5.invalid   2 dups · dup-A has 1 note, dup-B has 1 direct user
 *  P6  pbtest-stop6.invalid   1 dup · 2 users via notes
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Scan tip: use "Domain only" mode, origin = salesforce
 * All targets are salesforce-sourced; all dups are hubspot-sourced.
 *
 * Stop/continue test:
 *   1. Scan — should show 6 groups, 7 dups total
 *   2. Start merge
 *   3. Click Stop after 2–3 log lines appear
 *   4. Verify partial recap with "N left undone" and "Continue merge" button
 *   5. Click Continue — remaining groups should complete
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

function parseEnv(filepath) {
  return Object.fromEntries(
    fs.readFileSync(filepath, 'utf8')
      .split('\n')
      .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
      .map(l => {
        const eq = l.indexOf('=');
        return [l.slice(0, eq).trim(), l.slice(eq + 1).trim()];
      })
  );
}

const envPath = path.join(__dirname, '../.claude/.env');
if (!fs.existsSync(envPath)) {
  console.error('ERROR: .claude/.env not found — run from the project root.');
  process.exit(1);
}

const env   = parseEnv(envPath);
const TOKEN = env.PB_TOKEN;
const EU    = env.PB_EU === 'true';
const BASE  = EU ? 'https://api.eu.productboard.com' : 'https://api.productboard.com';

if (!TOKEN) { console.error('ERROR: PB_TOKEN not set in .claude/.env'); process.exit(1); }

// ── API helpers ───────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function pbApi(method, endpoint, body) {
  await sleep(150); // polite rate-limit guard
  const isV2 = endpoint.startsWith('/v2/');
  const res = await fetch(`${BASE}${endpoint}`, {
    method: method.toUpperCase(),
    headers: {
      Authorization:  `Bearer ${TOKEN}`,
      Accept:         'application/json',
      'Content-Type': 'application/json',
      ...(!isV2 && { 'X-Version': '1' }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method.toUpperCase()} ${endpoint} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

let _recId = 1;
function recId() { return `pbtest-sc-${Date.now()}-${_recId++}`; }

async function createCompany({ name, domain, sourceOrigin }) {
  const metadata = sourceOrigin
    ? { source: { system: sourceOrigin, recordId: recId() } }
    : undefined;
  const r = await pbApi('post', '/v2/entities', {
    data: {
      type: 'company',
      fields: { name, domain },
      ...(metadata && { metadata }),
    },
  });
  // PB needs a moment to index a freshly created v2 entity as a valid note customer
  await sleep(2000);
  return r.data;
}

async function createNote({ name, customerId, customerType }) {
  const r = await pbApi('post', '/v2/notes', {
    data: {
      type: 'textNote',
      fields: { name, content: `Stop/continue fixture: ${name}` },
      relationships: [
        { type: 'customer', target: { id: customerId, type: customerType } },
      ],
    },
  });
  return r.data;
}

async function createUser({ name }) {
  const r = await pbApi('post', '/v2/entities', {
    data: { type: 'user', fields: { name } },
  });
  return r.data;
}

async function setUserParent(userId, companyId) {
  await pbApi('put', `/v2/entities/${userId}/relationships/parent`, {
    data: { target: { id: companyId }, type: 'company' },
  });
}

// ── Logging helpers ───────────────────────────────────────────────────────────

function ok(label, id)  { console.log(`    ✓ ${label.padEnd(44)} ${id}`); }
function fail(label, e) { console.error(`    ✗ ${label.padEnd(44)} ${e.message}`); }
function heading(s)     { console.log(`\n  ${s}`); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Merge Duplicate Companies — stop/continue fixture creator');
  console.log(`  Workspace: ${EU ? 'EU' : 'US'} · ${BASE}`);
  console.log('══════════════════════════════════════════════════════════════\n');

  const fixtures = { createdAt: new Date().toISOString(), scenarios: {} };

  // ── P1: 2 direct notes + 1 user-via-note ──────────────────────────────────
  heading('P1 · pbtest-stop1.invalid  — 2 direct notes + 1 user via note');
  {
    const s = {};
    try {
      s.target = await createCompany({ name: '[TEST] Stop1 Target', domain: 'pbtest-stop1.invalid', sourceOrigin: 'salesforce' });
      ok('target  [TEST] Stop1 Target', s.target.id);
    } catch (e) { fail('target', e); }
    try {
      s.dup = await createCompany({ name: '[TEST] Stop1 Dup', domain: 'pbtest-stop1.invalid', sourceOrigin: 'hubspot' });
      ok('dup     [TEST] Stop1 Dup', s.dup.id);
    } catch (e) { fail('dup', e); }

    if (s.dup?.id) {
      s.notes = [];
      for (let i = 1; i <= 2; i++) {
        try {
          const n = await createNote({ name: `[TEST] Stop1 Note ${i}`, customerId: s.dup.id, customerType: 'company' });
          ok(`note ${i} (customer = dup)`, n.id);
          s.notes.push(n);
        } catch (e) { fail(`note ${i}`, e); }
      }
      try {
        s.userViaNote = await createUser({ name: '[TEST] Stop1 UserViaNote' });
        await setUserParent(s.userViaNote.id, s.dup.id);
        ok('user (parent = dup)', s.userViaNote.id);
        const n = await createNote({ name: '[TEST] Stop1 UserNote', customerId: s.userViaNote.id, customerType: 'user' });
        ok('note (customer = user)', n.id);
        s.userNote = n;
      } catch (e) { fail('user-via-note', e); }
    }
    fixtures.scenarios.P1 = s;
  }

  // ── P2: 3 direct notes ────────────────────────────────────────────────────
  heading('P2 · pbtest-stop2.invalid  — 3 direct notes on dup');
  {
    const s = {};
    try {
      s.target = await createCompany({ name: '[TEST] Stop2 Target', domain: 'pbtest-stop2.invalid', sourceOrigin: 'salesforce' });
      ok('target  [TEST] Stop2 Target', s.target.id);
    } catch (e) { fail('target', e); }
    try {
      s.dup = await createCompany({ name: '[TEST] Stop2 Dup', domain: 'pbtest-stop2.invalid', sourceOrigin: 'hubspot' });
      ok('dup     [TEST] Stop2 Dup', s.dup.id);
    } catch (e) { fail('dup', e); }

    if (s.dup?.id) {
      s.notes = [];
      for (let i = 1; i <= 3; i++) {
        try {
          const n = await createNote({ name: `[TEST] Stop2 Note ${i}`, customerId: s.dup.id, customerType: 'company' });
          ok(`note ${i} (customer = dup)`, n.id);
          s.notes.push(n);
        } catch (e) { fail(`note ${i}`, e); }
      }
    }
    fixtures.scenarios.P2 = s;
  }

  // ── P3: 2 direct-parent users, no notes ───────────────────────────────────
  heading('P3 · pbtest-stop3.invalid  — 2 direct-parent users, no notes');
  {
    const s = {};
    try {
      s.target = await createCompany({ name: '[TEST] Stop3 Target', domain: 'pbtest-stop3.invalid', sourceOrigin: 'salesforce' });
      ok('target  [TEST] Stop3 Target', s.target.id);
    } catch (e) { fail('target', e); }
    try {
      s.dup = await createCompany({ name: '[TEST] Stop3 Dup', domain: 'pbtest-stop3.invalid', sourceOrigin: 'hubspot' });
      ok('dup     [TEST] Stop3 Dup', s.dup.id);
    } catch (e) { fail('dup', e); }

    if (s.dup?.id) {
      s.users = [];
      for (let i = 1; i <= 2; i++) {
        try {
          const u = await createUser({ name: `[TEST] Stop3 User ${i}` });
          await setUserParent(u.id, s.dup.id);
          ok(`user ${i} (parent = dup)`, u.id);
          s.users.push(u);
        } catch (e) { fail(`user ${i}`, e); }
      }
    }
    fixtures.scenarios.P3 = s;
  }

  // ── P4: 1 direct note + 2 direct-parent users ─────────────────────────────
  heading('P4 · pbtest-stop4.invalid  — 1 note + 2 direct-parent users');
  {
    const s = {};
    try {
      s.target = await createCompany({ name: '[TEST] Stop4 Target', domain: 'pbtest-stop4.invalid', sourceOrigin: 'salesforce' });
      ok('target  [TEST] Stop4 Target', s.target.id);
    } catch (e) { fail('target', e); }
    try {
      s.dup = await createCompany({ name: '[TEST] Stop4 Dup', domain: 'pbtest-stop4.invalid', sourceOrigin: 'hubspot' });
      ok('dup     [TEST] Stop4 Dup', s.dup.id);
    } catch (e) { fail('dup', e); }

    if (s.dup?.id) {
      try {
        s.note = await createNote({ name: '[TEST] Stop4 Note', customerId: s.dup.id, customerType: 'company' });
        ok('note (customer = dup)', s.note.id);
      } catch (e) { fail('note', e); }
      s.users = [];
      for (let i = 1; i <= 2; i++) {
        try {
          const u = await createUser({ name: `[TEST] Stop4 User ${i}` });
          await setUserParent(u.id, s.dup.id);
          ok(`user ${i} (parent = dup)`, u.id);
          s.users.push(u);
        } catch (e) { fail(`user ${i}`, e); }
      }
    }
    fixtures.scenarios.P4 = s;
  }

  // ── P5: 2 dups — dup-A has 1 note, dup-B has 1 direct user ───────────────
  heading('P5 · pbtest-stop5.invalid  — 2 dups (note on A, user on B)');
  {
    const s = {};
    try {
      s.target = await createCompany({ name: '[TEST] Stop5 Target', domain: 'pbtest-stop5.invalid', sourceOrigin: 'salesforce' });
      ok('target  [TEST] Stop5 Target', s.target.id);
    } catch (e) { fail('target', e); }
    try {
      s.dupA = await createCompany({ name: '[TEST] Stop5 Dup A', domain: 'pbtest-stop5.invalid', sourceOrigin: 'hubspot' });
      ok('dup A   [TEST] Stop5 Dup A', s.dupA.id);
    } catch (e) { fail('dup A', e); }
    try {
      s.dupB = await createCompany({ name: '[TEST] Stop5 Dup B', domain: 'pbtest-stop5.invalid', sourceOrigin: 'pipedrive' });
      ok('dup B   [TEST] Stop5 Dup B', s.dupB.id);
    } catch (e) { fail('dup B', e); }

    if (s.dupA?.id) {
      try {
        s.noteA = await createNote({ name: '[TEST] Stop5 Note on A', customerId: s.dupA.id, customerType: 'company' });
        ok('note on dup A', s.noteA.id);
      } catch (e) { fail('note on dup A', e); }
    }
    if (s.dupB?.id) {
      try {
        s.userB = await createUser({ name: '[TEST] Stop5 User on B' });
        await setUserParent(s.userB.id, s.dupB.id);
        ok('user on dup B (parent = dup B)', s.userB.id);
      } catch (e) { fail('user on dup B', e); }
    }
    fixtures.scenarios.P5 = s;
  }

  // ── P6: 2 users-via-notes ──────────────────────────────────────────────────
  heading('P6 · pbtest-stop6.invalid  — 2 users with notes (user path)');
  {
    const s = {};
    try {
      s.target = await createCompany({ name: '[TEST] Stop6 Target', domain: 'pbtest-stop6.invalid', sourceOrigin: 'salesforce' });
      ok('target  [TEST] Stop6 Target', s.target.id);
    } catch (e) { fail('target', e); }
    try {
      s.dup = await createCompany({ name: '[TEST] Stop6 Dup', domain: 'pbtest-stop6.invalid', sourceOrigin: 'hubspot' });
      ok('dup     [TEST] Stop6 Dup', s.dup.id);
    } catch (e) { fail('dup', e); }

    if (s.dup?.id) {
      s.users = [];
      for (let i = 1; i <= 2; i++) {
        try {
          const u = await createUser({ name: `[TEST] Stop6 User ${i}` });
          await setUserParent(u.id, s.dup.id);
          const n = await createNote({ name: `[TEST] Stop6 UserNote ${i}`, customerId: u.id, customerType: 'user' });
          ok(`user ${i} + note (parent=dup, note customer=user)`, u.id);
          s.users.push({ user: u, note: n });
        } catch (e) { fail(`user ${i} via note`, e); }
      }
    }
    fixtures.scenarios.P6 = s;
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const outPath = path.join(__dirname, 'stop-continue-fixtures.json');
  fs.writeFileSync(outPath, JSON.stringify(fixtures, null, 2));

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Done. IDs saved to:');
  console.log(`  ${outPath}`);
  console.log('\n  To test stop/continue:');
  console.log('  1. Scan: "Domain only" · origin = salesforce');
  console.log('     → should find 6 groups, 7 dups total');
  console.log('  2. Merge all groups');
  console.log('  3. Click Stop after a few log lines appear');
  console.log('  4. Verify summary shows partial counts + "N left undone"');
  console.log('  5. Click "Continue merge" → remaining groups complete');
  console.log('\n  Group overview:');
  console.log('  P1  pbtest-stop1.invalid   1 dup · 2 notes + 1 user-via-note');
  console.log('  P2  pbtest-stop2.invalid   1 dup · 3 notes');
  console.log('  P3  pbtest-stop3.invalid   1 dup · 2 direct users');
  console.log('  P4  pbtest-stop4.invalid   1 dup · 1 note + 2 direct users');
  console.log('  P5  pbtest-stop5.invalid   2 dups · note on A, user on B');
  console.log('  P6  pbtest-stop6.invalid   1 dup · 2 users via notes');
  console.log('══════════════════════════════════════════════════════════════\n');
}

main().catch(e => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
