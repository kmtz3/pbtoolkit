#!/usr/bin/env node
/**
 * create-duplicate-company-fixtures.js
 *
 * Creates test companies, notes, and users in Productboard to exercise every
 * code path in the Merge Duplicate Companies module.
 *
 * Run:  node test/create-duplicate-company-fixtures.js
 *
 * Reads:  .claude/.env  (PB_TOKEN, PB_EU)
 * Writes: test/duplicate-company-fixtures.json  (all created IDs for reference / cleanup)
 *
 * Scenario map
 * ─────────────────────────────────────────────────────────────────────────────
 *  SCAN SCENARIOS
 *  S1  pbtest-simple.invalid      Domain-only happy path — 1 target + 1 dup
 *  S2  pbtest-multi.invalid       Domain-only — 1 target + 2 dups
 *  S3  pbtest-noprimary.invalid   Skip — no salesforce company
 *  S4  pbtest-multiprimary.invalid Skip — two salesforce companies
 *  S5  pbtest-dn-match.invalid    Domain+Name — names identical → group found
 *  S6  pbtest-dn-nomatch.invalid  Domain+Name — names differ → NO group
 *  S7  pbtest-fuzzy.invalid       Fuzzy — "Fuzzy Corp" ≈ "FUZZY, CORP." (match)
 *  S8  pbtest-fuzzymiss.invalid   Fuzzy — "Word Corp" ≠ "Word" (different words)
 *  S9  pbtest-manual.invalid      Manual mode — no primary origin, user picks target
 *
 *  MERGE SCENARIOS
 *  M1  pbtest-notes.invalid       Notes attributed directly to dup company (Step 2 note path)
 *  M2  pbtest-usernotes.invalid   Notes attributed to a user parented to dup (Step 2 user path)
 *  M3  pbtest-directusers.invalid Users parented to dup, no notes (Step 3 direct-parent path)
 * ─────────────────────────────────────────────────────────────────────────────
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
  await sleep(120); // polite rate-limit guard (~8 req/s)
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
function recId() { return `pbtest-fixture-${Date.now()}-${_recId++}`; }

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
  return r.data;
}

async function createNote({ name, customerId, customerType }) {
  const r = await pbApi('post', '/v2/notes', {
    data: {
      type: 'textNote',
      fields: { name, content: `Test fixture note: ${name}` },
      relationships: [
        { type: 'customer', target: { id: customerId, type: customerType } },
      ],
    },
  });
  return r.data;
}

async function createUser({ name }) {
  const r = await pbApi('post', '/v2/entities', {
    data: {
      type: 'user',
      fields: { name },
    },
  });
  return r.data;
}

async function setUserParent(userId, companyId) {
  await pbApi('put', `/v2/entities/${userId}/relationships/parent`, {
    data: { target: { id: companyId }, type: 'company' },
  });
}

// ── Logging helpers ───────────────────────────────────────────────────────────

function ok(label, id)  { console.log(`    ✓ ${label.padEnd(36)} ${id}`); }
function err(label, e)  { console.error(`    ✗ ${label.padEnd(36)} ${e.message}`); }
function heading(s)     { console.log(`\n  ${s}`); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Merge Duplicate Companies — fixture creator');
  console.log(`  Workspace: ${EU ? 'EU' : 'US'} · ${BASE}`);
  console.log('══════════════════════════════════════════════════════════════\n');

  const fixtures = { createdAt: new Date().toISOString(), scenarios: {} };

  // ── S1: Domain-only happy path ──────────────────────────────────────────────
  heading('S1 · Domain-only happy path  [pbtest-simple.invalid]');
  console.log('     Domain-only scan → 1 group, 1 dup. Target = salesforce company.');
  {
    const s = {};
    try {
      s.target = await createCompany({ name: '[TEST] Simple Corp',     domain: 'pbtest-simple.invalid', sourceOrigin: 'salesforce' });
      ok('target  [TEST] Simple Corp',    s.target.id);
    } catch (e) { err('target  [TEST] Simple Corp', e); }
    try {
      s.dup    = await createCompany({ name: '[TEST] Simple Corp Dup', domain: 'pbtest-simple.invalid', sourceOrigin: 'hubspot' });
      ok('dup     [TEST] Simple Corp Dup', s.dup.id);
    } catch (e) { err('dup     [TEST] Simple Corp Dup', e); }
    fixtures.scenarios.S1 = s;
  }

  // ── S2: Multiple dups ───────────────────────────────────────────────────────
  heading('S2 · Multiple dups  [pbtest-multi.invalid]');
  console.log('     Domain-only scan → 1 group, 2 dups. Target = salesforce company.');
  {
    const s = {};
    try {
      s.target = await createCompany({ name: '[TEST] Multi Target',  domain: 'pbtest-multi.invalid', sourceOrigin: 'salesforce' });
      ok('target  [TEST] Multi Target',  s.target.id);
    } catch (e) { err('target  [TEST] Multi Target', e); }
    try {
      s.dup1   = await createCompany({ name: '[TEST] Multi Dup One', domain: 'pbtest-multi.invalid', sourceOrigin: 'hubspot' });
      ok('dup 1   [TEST] Multi Dup One', s.dup1.id);
    } catch (e) { err('dup 1   [TEST] Multi Dup One', e); }
    try {
      s.dup2   = await createCompany({ name: '[TEST] Multi Dup Two', domain: 'pbtest-multi.invalid', sourceOrigin: null });
      ok('dup 2   [TEST] Multi Dup Two', s.dup2.id);
    } catch (e) { err('dup 2   [TEST] Multi Dup Two', e); }
    fixtures.scenarios.S2 = s;
  }

  // ── S3: Skip — no primary origin ────────────────────────────────────────────
  heading('S3 · Skip — no primary origin  [pbtest-noprimary.invalid]');
  console.log('     Domain-only + origin=salesforce → domain SKIPPED (no salesforce company).');
  {
    const s = {};
    try {
      s.a = await createCompany({ name: '[TEST] No Primary A', domain: 'pbtest-noprimary.invalid', sourceOrigin: 'hubspot' });
      ok('[TEST] No Primary A', s.a.id);
    } catch (e) { err('[TEST] No Primary A', e); }
    try {
      s.b = await createCompany({ name: '[TEST] No Primary B', domain: 'pbtest-noprimary.invalid', sourceOrigin: 'pipedrive' });
      ok('[TEST] No Primary B', s.b.id);
    } catch (e) { err('[TEST] No Primary B', e); }
    fixtures.scenarios.S3 = s;
  }

  // ── S4: Skip — multiple primary origins ────────────────────────────────────
  heading('S4 · Skip — multiple primary origins  [pbtest-multiprimary.invalid]');
  console.log('     Domain-only + origin=salesforce → domain SKIPPED (two salesforce companies).');
  {
    const s = {};
    try {
      s.a = await createCompany({ name: '[TEST] Multi Primary One', domain: 'pbtest-multiprimary.invalid', sourceOrigin: 'salesforce' });
      ok('[TEST] Multi Primary One', s.a.id);
    } catch (e) { err('[TEST] Multi Primary One', e); }
    try {
      s.b = await createCompany({ name: '[TEST] Multi Primary Two', domain: 'pbtest-multiprimary.invalid', sourceOrigin: 'salesforce' });
      ok('[TEST] Multi Primary Two', s.b.id);
    } catch (e) { err('[TEST] Multi Primary Two', e); }
    fixtures.scenarios.S4 = s;
  }

  // ── S5: Domain+Name — names match ──────────────────────────────────────────
  heading('S5 · Domain+Name — names match  [pbtest-dn-match.invalid]');
  console.log('     Domain-only: group found.');
  console.log('     Domain+Name: group found (identical names).');
  {
    const s = {};
    try {
      s.target = await createCompany({ name: '[TEST] DN Match Corp', domain: 'pbtest-dn-match.invalid', sourceOrigin: 'salesforce' });
      ok('target  [TEST] DN Match Corp', s.target.id);
    } catch (e) { err('target  [TEST] DN Match Corp', e); }
    try {
      s.dup    = await createCompany({ name: '[TEST] DN Match Corp', domain: 'pbtest-dn-match.invalid', sourceOrigin: 'hubspot' });
      ok('dup     [TEST] DN Match Corp', s.dup.id);
    } catch (e) { err('dup     [TEST] DN Match Corp', e); }
    fixtures.scenarios.S5 = s;
  }

  // ── S6: Domain+Name — names differ ─────────────────────────────────────────
  heading('S6 · Domain+Name — names differ  [pbtest-dn-nomatch.invalid]');
  console.log('     Domain-only: group found.');
  console.log('     Domain+Name: NO group (names are different → not duplicates).');
  {
    const s = {};
    try {
      s.a = await createCompany({ name: '[TEST] Alpha Products',  domain: 'pbtest-dn-nomatch.invalid', sourceOrigin: 'salesforce' });
      ok('[TEST] Alpha Products',  s.a.id);
    } catch (e) { err('[TEST] Alpha Products', e); }
    try {
      s.b = await createCompany({ name: '[TEST] Beta Services',   domain: 'pbtest-dn-nomatch.invalid', sourceOrigin: 'hubspot' });
      ok('[TEST] Beta Services',   s.b.id);
    } catch (e) { err('[TEST] Beta Services', e); }
    fixtures.scenarios.S6 = s;
  }

  // ── S7: Fuzzy match ─────────────────────────────────────────────────────────
  heading('S7 · Fuzzy match  [pbtest-fuzzy.invalid]');
  console.log('     Domain+Name (no fuzzy): NO group  ("Fuzzy Corp" ≠ "FUZZY, CORP." exact).');
  console.log('     Domain+Name + fuzzy:    group found  (both normalize to "fuzzy corp").');
  {
    const s = {};
    try {
      s.target = await createCompany({ name: '[TEST] Fuzzy Corp',   domain: 'pbtest-fuzzy.invalid', sourceOrigin: 'salesforce' });
      ok('target  [TEST] Fuzzy Corp',   s.target.id);
    } catch (e) { err('target  [TEST] Fuzzy Corp', e); }
    try {
      s.dup    = await createCompany({ name: '[TEST] FUZZY, CORP.', domain: 'pbtest-fuzzy.invalid', sourceOrigin: 'hubspot' });
      ok('dup     [TEST] FUZZY, CORP.', s.dup.id);
    } catch (e) { err('dup     [TEST] FUZZY, CORP.', e); }
    fixtures.scenarios.S7 = s;
  }

  // ── S8: Fuzzy non-match ─────────────────────────────────────────────────────
  heading('S8 · Fuzzy non-match  [pbtest-fuzzymiss.invalid]');
  console.log('     Domain+Name + fuzzy: NO group.');
  console.log('     "Word Corp" → "word corp" ≠ "word" — different word count, not a match.');
  {
    const s = {};
    try {
      s.a = await createCompany({ name: '[TEST] Word Corp', domain: 'pbtest-fuzzymiss.invalid', sourceOrigin: 'salesforce' });
      ok('[TEST] Word Corp', s.a.id);
    } catch (e) { err('[TEST] Word Corp', e); }
    try {
      s.b = await createCompany({ name: '[TEST] Word',      domain: 'pbtest-fuzzymiss.invalid', sourceOrigin: 'hubspot' });
      ok('[TEST] Word',      s.b.id);
    } catch (e) { err('[TEST] Word', e); }
    fixtures.scenarios.S8 = s;
  }

  // ── S9: Manual mode — no primary ────────────────────────────────────────────
  heading('S9 · Manual mode  [pbtest-manual.invalid]');
  console.log('     No salesforce company → skipped in auto mode.');
  console.log('     Manual mode: all 3 companies shown; user picks target via compare modal.');
  {
    const s = {};
    try {
      s.a = await createCompany({ name: '[TEST] Manual Option A', domain: 'pbtest-manual.invalid', sourceOrigin: 'hubspot' });
      ok('[TEST] Manual Option A', s.a.id);
    } catch (e) { err('[TEST] Manual Option A', e); }
    try {
      s.b = await createCompany({ name: '[TEST] Manual Option B', domain: 'pbtest-manual.invalid', sourceOrigin: 'pipedrive' });
      ok('[TEST] Manual Option B', s.b.id);
    } catch (e) { err('[TEST] Manual Option B', e); }
    try {
      s.c = await createCompany({ name: '[TEST] Manual Option C', domain: 'pbtest-manual.invalid', sourceOrigin: null });
      ok('[TEST] Manual Option C', s.c.id);
    } catch (e) { err('[TEST] Manual Option C', e); }
    fixtures.scenarios.S9 = s;
  }

  // ── M1: Notes — direct company customer ────────────────────────────────────
  heading('M1 · Notes attributed to dup company  [pbtest-notes.invalid]');
  console.log('     Merge Step 1+2 (note path): notes with customer=company are relinked to target.');
  {
    const s = {};
    try {
      s.target = await createCompany({ name: '[TEST] Notes Target', domain: 'pbtest-notes.invalid', sourceOrigin: 'salesforce' });
      ok('target  [TEST] Notes Target', s.target.id);
    } catch (e) { err('target  [TEST] Notes Target', e); }
    try {
      s.dup    = await createCompany({ name: '[TEST] Notes Dup',    domain: 'pbtest-notes.invalid', sourceOrigin: 'hubspot' });
      ok('dup     [TEST] Notes Dup',    s.dup.id);
    } catch (e) { err('dup     [TEST] Notes Dup', e); }

    if (s.dup?.id) {
      s.notes = [];
      for (let i = 1; i <= 2; i++) {
        try {
          const n = await createNote({
            name:        `[TEST] Note from dup company ${i}`,
            customerId:   s.dup.id,
            customerType: 'company',
          });
          ok(`note ${i}  (customer = dup company)`, n.id);
          s.notes.push(n);
        } catch (e) { err(`note ${i}`, e); }
      }
    }
    fixtures.scenarios.M1 = s;
  }

  // ── M2: Notes via user parented to dup ─────────────────────────────────────
  heading('M2 · Notes attributed to user parented to dup  [pbtest-usernotes.invalid]');
  console.log('     Merge Step 2 (user path): note customer = user → user\'s parent updated to target.');
  {
    const s = {};
    try {
      s.target = await createCompany({ name: '[TEST] UserNotes Target', domain: 'pbtest-usernotes.invalid', sourceOrigin: 'salesforce' });
      ok('target  [TEST] UserNotes Target', s.target.id);
    } catch (e) { err('target  [TEST] UserNotes Target', e); }
    try {
      s.dup    = await createCompany({ name: '[TEST] UserNotes Dup',    domain: 'pbtest-usernotes.invalid', sourceOrigin: 'hubspot' });
      ok('dup     [TEST] UserNotes Dup',    s.dup.id);
    } catch (e) { err('dup     [TEST] UserNotes Dup', e); }

    if (s.dup?.id) {
      try {
        s.user = await createUser({ name: '[TEST] User with note' });
        ok('user    [TEST] User with note', s.user.id);
        await setUserParent(s.user.id, s.dup.id);
        ok('        → parent set to dup company', s.dup.id);
      } catch (e) { err('user creation / parent set', e); }

      if (s.user?.id) {
        try {
          s.note = await createNote({
            name:        '[TEST] Note from user (parent = dup)',
            customerId:   s.user.id,
            customerType: 'user',
          });
          ok('note    (customer = user)', s.note.id);
        } catch (e) { err('note (user customer)', e); }
      }
    }
    fixtures.scenarios.M2 = s;
  }

  // ── M3: Direct-parent users — no notes ─────────────────────────────────────
  heading('M3 · Direct-parent users, no notes  [pbtest-directusers.invalid]');
  console.log('     Merge Step 3: users parented to dup but with no notes are found and relinked.');
  {
    const s = {};
    try {
      s.target = await createCompany({ name: '[TEST] DirectUsers Target', domain: 'pbtest-directusers.invalid', sourceOrigin: 'salesforce' });
      ok('target  [TEST] DirectUsers Target', s.target.id);
    } catch (e) { err('target  [TEST] DirectUsers Target', e); }
    try {
      s.dup    = await createCompany({ name: '[TEST] DirectUsers Dup',    domain: 'pbtest-directusers.invalid', sourceOrigin: 'hubspot' });
      ok('dup     [TEST] DirectUsers Dup',    s.dup.id);
    } catch (e) { err('dup     [TEST] DirectUsers Dup', e); }

    if (s.dup?.id) {
      s.users = [];
      for (let i = 1; i <= 2; i++) {
        try {
          const u = await createUser({ name: `[TEST] DirectUser ${i}` });
          await setUserParent(u.id, s.dup.id);
          ok(`user ${i}  [TEST] DirectUser ${i} → parent=dup`, u.id);
          s.users.push(u);
        } catch (e) { err(`user ${i} (direct parent)`, e); }
      }
    }
    fixtures.scenarios.M3 = s;
  }

  // ── Save fixtures ─────────────────────────────────────────────────────────
  const outPath = path.join(__dirname, 'duplicate-company-fixtures.json');
  fs.writeFileSync(outPath, JSON.stringify(fixtures, null, 2));

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  All fixtures created. IDs saved to:');
  console.log(`  ${outPath}`);
  console.log('\n  Quick-reference test matrix:\n');
  console.log('  Scenario  Domain                        Mode             Expect');
  console.log('  ────────  ────────────────────────────  ───────────────  ─────────────────────────');
  console.log('  S1        pbtest-simple.invalid         Domain-only      1 group · 1 dup');
  console.log('  S2        pbtest-multi.invalid          Domain-only      1 group · 2 dups');
  console.log('  S3        pbtest-noprimary.invalid      Domain-only      SKIPPED (no salesforce)');
  console.log('  S4        pbtest-multiprimary.invalid   Domain-only      SKIPPED (2 salesforce)');
  console.log('  S5        pbtest-dn-match.invalid       Domain+Name      1 group (names match)');
  console.log('  S6        pbtest-dn-nomatch.invalid     Domain+Name      0 groups (names differ)');
  console.log('  S7        pbtest-fuzzy.invalid          D+N + fuzzy      1 group (fuzzy match)');
  console.log('  S7        pbtest-fuzzy.invalid          D+N no fuzzy     0 groups (exact no-match)');
  console.log('  S8        pbtest-fuzzymiss.invalid      D+N + fuzzy      0 groups ("word" ≠ "word corp")');
  console.log('  S9        pbtest-manual.invalid         Manual           3 companies, user picks target');
  console.log('  M1        pbtest-notes.invalid          Domain-only      Merge → 2 notes relinked');
  console.log('  M2        pbtest-usernotes.invalid      Domain-only      Merge → user parent updated');
  console.log('  M3        pbtest-directusers.invalid    Domain-only      Merge → 2 direct-parent users relinked');
  console.log('══════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
