#!/usr/bin/env node
/**
 * create-name-only-fixtures.js
 *
 * Creates no-domain duplicate company pairs to test the "Name only" match
 * criteria (both non-fuzzy and fuzzy) in Merge Duplicate Companies.
 *
 * Run:  node test/create-name-only-fixtures.js
 *
 * Reads:  .claude/.env  (PB_TOKEN, PB_EU)
 * Writes: test/name-only-fixtures.json
 *
 * Scenarios
 * ──────────────────────────────────────────────────────────────────────────────
 *  NE1  No domain · exact match
 *       Names: "[TEST] NodomExact Alpha Co" × 2  (identical)
 *       → found by Name only (non-fuzzy) AND Name only (fuzzy)
 *
 *  NF1  No domain · fuzzy-only match
 *       Names: "[TEST] NodomFuzzy Corp"  and  "[TEST] NODOMFUZZY, CORP."
 *       Exact comparison: different (case + punctuation differ)
 *       Fuzzy comparison: same  (lowercase + strip non-alnum → "test nodomfuzzy corp")
 *       → found ONLY by Name only (fuzzy); NOT by Name only (non-fuzzy)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Each scenario: target = salesforce, dup = hubspot, NO domain field.
 * NE1 dup has 1 direct note and 1 direct-parent user for a meaningful merge.
 *
 * Scan tips:
 *   Non-fuzzy: "Name only" (fuzzy unchecked) · origin = salesforce
 *     → NE1 appears, NF1 does NOT
 *   Fuzzy:     "Name only" (fuzzy checked)   · origin = salesforce
 *     → NE1 and NF1 both appear
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
  await sleep(150);
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
function recId() { return `pbtest-nom-${Date.now()}-${_recId++}`; }

async function createCompany({ name, sourceOrigin }) {
  // Intentionally no domain field — these are no-domain companies
  const metadata = sourceOrigin
    ? { source: { system: sourceOrigin, recordId: recId() } }
    : undefined;
  const r = await pbApi('post', '/v2/entities', {
    data: {
      type: 'company',
      fields: { name },
      ...(metadata && { metadata }),
    },
  });
  await sleep(2000); // let PB index the entity as a valid note customer
  return r.data;
}

async function createNote({ name, customerId, customerType }) {
  const r = await pbApi('post', '/v2/notes', {
    data: {
      type: 'textNote',
      fields: { name, content: `Name-only fixture: ${name}` },
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

function ok(label, id)  { console.log(`    ✓ ${label.padEnd(48)} ${id}`); }
function fail(label, e) { console.error(`    ✗ ${label.padEnd(48)} ${e.message}`); }
function heading(s)     { console.log(`\n  ${s}`); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Merge Duplicate Companies — name-only fixture creator');
  console.log(`  Workspace: ${EU ? 'EU' : 'US'} · ${BASE}`);
  console.log('══════════════════════════════════════════════════════════════\n');

  const fixtures = { createdAt: new Date().toISOString(), scenarios: {} };

  // ── NE1: exact-match pair (no domain, identical names) ────────────────────
  heading('NE1 · no domain · exact match  — should appear in both fuzzy and non-fuzzy');
  {
    const s = {};
    const NAME = '[TEST] NodomExact Alpha Co';
    try {
      s.target = await createCompany({ name: NAME, sourceOrigin: 'salesforce' });
      ok(`target  "${NAME}"`, s.target.id);
    } catch (e) { fail('target', e); }
    try {
      s.dup = await createCompany({ name: NAME, sourceOrigin: 'hubspot' });
      ok(`dup     "${NAME}"`, s.dup.id);
    } catch (e) { fail('dup', e); }

    // Give NE1's dup a note and a direct-parent user so there's something real to merge
    if (s.dup?.id) {
      try {
        s.note = await createNote({ name: '[TEST] NodomExact Note', customerId: s.dup.id, customerType: 'company' });
        ok('note (customer = dup)', s.note.id);
      } catch (e) { fail('note', e); }
      try {
        s.user = await createUser({ name: '[TEST] NodomExact User' });
        await setUserParent(s.user.id, s.dup.id);
        ok('user (parent = dup)', s.user.id);
      } catch (e) { fail('user', e); }
    }

    fixtures.scenarios.NE1 = s;
  }

  // ── NF1: fuzzy-only pair (no domain, different case + punctuation) ─────────
  heading('NF1 · no domain · fuzzy-only  — should appear ONLY with fuzzy enabled');
  {
    const s = {};
    s.nameA = '[TEST] NodomFuzzy Corp';
    s.nameB = '[TEST] NODOMFUZZY, CORP.';
    // Fuzzy normalization of both:
    //   lowercase → "[test] nodomfuzzy corp"  /  "[test] nodomfuzzy, corp."
    //   strip non-alnum (keep spaces) → "test  nodomfuzzy corp"  / "test nodomfuzzy corp"
    //   collapse whitespace → "test nodomfuzzy corp"  (identical ✓)
    try {
      s.target = await createCompany({ name: s.nameA, sourceOrigin: 'salesforce' });
      ok(`target  "${s.nameA}"`, s.target.id);
    } catch (e) { fail('target', e); }
    try {
      s.dup = await createCompany({ name: s.nameB, sourceOrigin: 'hubspot' });
      ok(`dup     "${s.nameB}"`, s.dup.id);
    } catch (e) { fail('dup', e); }

    fixtures.scenarios.NF1 = s;
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  const outPath = path.join(__dirname, 'name-only-fixtures.json');
  fs.writeFileSync(outPath, JSON.stringify(fixtures, null, 2));

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Done. IDs saved to:');
  console.log(`  ${outPath}`);
  console.log('\n  Test matrix:');
  console.log('  ┌─────────────────────────────────┬──────────┬─────────────┐');
  console.log('  │ Scan mode                       │ NE1 seen │ NF1 seen    │');
  console.log('  ├─────────────────────────────────┼──────────┼─────────────┤');
  console.log('  │ Name only  (fuzzy unchecked)    │   YES    │   NO        │');
  console.log('  │ Name only  (fuzzy checked)      │   YES    │   YES       │');
  console.log('  │ Domain only (control)           │   NO     │   NO        │');
  console.log('  └─────────────────────────────────┴──────────┴─────────────┘');
  console.log('\n  For origin mode use: primary origin = salesforce');
  console.log('  NE1 dup also has 1 note + 1 direct user → verifies merge end-to-end');
  console.log('══════════════════════════════════════════════════════════════\n');
}

main().catch(e => {
  console.error('\nFATAL:', e.message);
  process.exit(1);
});
