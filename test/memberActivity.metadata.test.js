'use strict';

/**
 * Unit tests for helpers in src/routes/memberActivity.js.
 * Pure functions and buildCache (with mock fetchAllPages/pbFetch) — no real HTTP.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createZeroCountFields,
  isCacheStale,
  filterByRole,
  filterByActiveState,
  buildFilename,
  buildCache,
  COUNT_COLS,
  CACHE_TTL_MS,
} = require('../src/routes/memberActivity');

// ---------------------------------------------------------------------------
// createZeroCountFields
// ---------------------------------------------------------------------------

describe('createZeroCountFields', () => {
  test('returns an object with every COUNT_COLS key', () => {
    const fields = createZeroCountFields();
    for (const col of COUNT_COLS) {
      assert.ok(col.key in fields, `missing key: ${col.key}`);
    }
  });

  test('all values are 0', () => {
    const fields = createZeroCountFields();
    for (const [key, val] of Object.entries(fields)) {
      assert.equal(val, 0, `expected 0 for ${key}, got ${val}`);
    }
  });

  test('key count matches COUNT_COLS length', () => {
    const fields = createZeroCountFields();
    assert.equal(Object.keys(fields).length, COUNT_COLS.length);
  });

  test('returns a new object each call (not shared reference)', () => {
    const a = createZeroCountFields();
    const b = createZeroCountFields();
    a.featureCreatedCount = 99;
    assert.equal(b.featureCreatedCount, 0);
  });
});

// ---------------------------------------------------------------------------
// isCacheStale
// ---------------------------------------------------------------------------

describe('isCacheStale', () => {
  test('null entry → stale', () => {
    assert.equal(isCacheStale(null), true);
  });

  test('undefined entry → stale', () => {
    assert.equal(isCacheStale(undefined), true);
  });

  test('fresh entry (just created) → not stale', () => {
    const entry = { fetchedAt: Date.now() };
    assert.equal(isCacheStale(entry), false);
  });

  test('entry at exactly TTL boundary → stale (> not >=)', () => {
    const entry = { fetchedAt: Date.now() - CACHE_TTL_MS - 1 };
    assert.equal(isCacheStale(entry), true);
  });

  test('entry one ms before TTL expiry → not stale', () => {
    const entry = { fetchedAt: Date.now() - CACHE_TTL_MS + 100 };
    assert.equal(isCacheStale(entry), false);
  });

  test('very old entry → stale', () => {
    const entry = { fetchedAt: Date.now() - (60 * 60 * 1000) }; // 1 hour ago
    assert.equal(isCacheStale(entry), true);
  });
});

// ---------------------------------------------------------------------------
// filterByRole
// ---------------------------------------------------------------------------

describe('filterByRole', () => {
  const rows = [
    { memberId: 'm1', role: 'admin' },
    { memberId: 'm2', role: 'maker' },
    { memberId: 'm3', role: 'viewer' },
    { memberId: 'm4', role: 'maker' },
  ];

  test('empty roles array → all rows returned', () => {
    const result = filterByRole(rows, []);
    assert.equal(result.length, 4);
  });

  test('null roles → all rows returned', () => {
    const result = filterByRole(rows, null);
    assert.equal(result.length, 4);
  });

  test('roles=["admin"] → only admin rows', () => {
    const result = filterByRole(rows, ['admin']);
    assert.equal(result.length, 1);
    assert.equal(result[0].memberId, 'm1');
  });

  test('roles=["maker"] → all maker rows', () => {
    const result = filterByRole(rows, ['maker']);
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r.role === 'maker'));
  });

  test('roles=["admin","maker"] → admin + maker rows', () => {
    const result = filterByRole(rows, ['admin', 'maker']);
    assert.equal(result.length, 3);
  });

  test('roles=["contributor"] → empty (no such role)', () => {
    const result = filterByRole(rows, ['contributor']);
    assert.equal(result.length, 0);
  });
});

// ---------------------------------------------------------------------------
// filterByActiveState
// ---------------------------------------------------------------------------

describe('filterByActiveState — summary mode', () => {
  const rows = [
    { memberId: 'm1', activeDaysCount: 5 },
    { memberId: 'm2', activeDaysCount: 0 },
    { memberId: 'm3', activeDaysCount: 1 },
    { memberId: 'm4', activeDaysCount: 0 },
  ];

  test('mode="all" → all rows', () => {
    const result = filterByActiveState(rows, 'all', 'summary');
    assert.equal(result.length, 4);
  });

  test('mode="active" → rows with activeDaysCount >= 1', () => {
    const result = filterByActiveState(rows, 'active', 'summary');
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r.activeDaysCount >= 1));
  });

  test('mode="inactive" → rows with activeDaysCount === 0', () => {
    const result = filterByActiveState(rows, 'inactive', 'summary');
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r.activeDaysCount === 0));
  });
});

describe('filterByActiveState — raw mode', () => {
  const rows = [
    { memberId: 'm1', activeFlag: true },
    { memberId: 'm2', activeFlag: false },
    { memberId: 'm3', activeFlag: true },
  ];

  test('mode="all" → all rows', () => {
    const result = filterByActiveState(rows, 'all', 'raw');
    assert.equal(result.length, 3);
  });

  test('mode="active" → rows with activeFlag === true', () => {
    const result = filterByActiveState(rows, 'active', 'raw');
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r.activeFlag === true));
  });

  test('mode="inactive" → rows with activeFlag === false', () => {
    const result = filterByActiveState(rows, 'inactive', 'raw');
    assert.equal(result.length, 1);
    assert.equal(result[0].memberId, 'm2');
  });
});

// ---------------------------------------------------------------------------
// buildFilename
// ---------------------------------------------------------------------------

describe('buildFilename — basic structure', () => {
  const emptyTeams = new Map();

  test('basic: pb-member-activity_{from}_{to}.csv', () => {
    const name = buildFilename('2026-01-01', '2026-01-31', [], [], emptyTeams, 'all', false);
    assert.equal(name, 'pb-member-activity_2026-01-01_2026-01-31.csv');
  });

  test('roles < 4 → _role-{roles} suffix', () => {
    const name = buildFilename('2026-01-01', '2026-01-31', ['admin', 'maker'], [], emptyTeams, 'all', false);
    assert.ok(name.includes('_role-admin-maker'));
  });

  test('roles = 4 → no role suffix (too many)', () => {
    const name = buildFilename('2026-01-01', '2026-01-31', ['admin', 'maker', 'viewer', 'contributor'], [], emptyTeams, 'all', false);
    assert.ok(!name.includes('_role-'), `unexpected role suffix in: ${name}`);
  });

  test('activeFilter="active" → _active suffix', () => {
    const name = buildFilename('2026-01-01', '2026-01-31', [], [], emptyTeams, 'active', false);
    assert.ok(name.includes('_active'));
  });

  test('activeFilter="inactive" → _inactive suffix', () => {
    const name = buildFilename('2026-01-01', '2026-01-31', [], [], emptyTeams, 'inactive', false);
    assert.ok(name.includes('_inactive'));
  });

  test('rawMode=true → _raw suffix', () => {
    const name = buildFilename('2026-01-01', '2026-01-31', [], [], emptyTeams, 'all', true);
    assert.ok(name.includes('_raw'));
    assert.ok(name.endsWith('.csv'));
  });

  test('always ends with .csv', () => {
    const name = buildFilename('2026-01-01', '2026-01-31', [], [], emptyTeams, 'all', false);
    assert.ok(name.endsWith('.csv'));
  });
});

describe('buildFilename — team slugs', () => {
  test('team with handle → uses handle', () => {
    const teams = new Map([['t1', { name: 'Engineering', handle: 'eng' }]]);
    const name = buildFilename('2026-01-01', '2026-01-31', [], ['t1'], teams, 'all', false);
    assert.ok(name.includes('_team-eng'), `got: ${name}`);
  });

  test('team without handle → slugifies name', () => {
    const teams = new Map([['t1', { name: 'Product Ops', handle: '' }]]);
    const name = buildFilename('2026-01-01', '2026-01-31', [], ['t1'], teams, 'all', false);
    assert.ok(name.includes('product-ops'), `got: ${name}`);
  });

  test('__none__ team → "no-team"', () => {
    const teams = new Map();
    const name = buildFilename('2026-01-01', '2026-01-31', [], ['__none__'], teams, 'all', false);
    assert.ok(name.includes('no-team'), `got: ${name}`);
  });

  test('unknown team id → first 8 chars of id', () => {
    const teams = new Map(); // id not in map
    const name = buildFilename('2026-01-01', '2026-01-31', [], ['abcdef12-xxxx'], teams, 'all', false);
    assert.ok(name.includes('abcdef12'), `got: ${name}`);
  });
});

describe('buildFilename — 200-char cap', () => {
  test('very long name is capped at 200 chars before .csv extension', () => {
    const manyTeams = new Map();
    const teamIds = [];
    for (let i = 0; i < 50; i++) {
      const id = `team-${i}-long-id-string`;
      manyTeams.set(id, { name: `Very Long Team Name Number ${i}`, handle: '' });
      teamIds.push(id);
    }
    const name = buildFilename('2026-01-01', '2026-01-31', [], teamIds, manyTeams, 'all', false);
    // stem (without .csv) should be <= 200 chars
    const stem = name.slice(0, -4);
    assert.ok(stem.length <= 200, `stem too long: ${stem.length} chars`);
  });
});

// ---------------------------------------------------------------------------
// buildCache — team membership building
// ---------------------------------------------------------------------------

describe('buildCache — member and team population', () => {
  /**
   * Build mock fetchAllPages for teams only.
   * Members are now fetched via pbFetch POST /v2/members/search, not fetchAllPages.
   * - /v2/teams/{id}/members → array of team member objects ({ id, fields })
   * - /v2/teams              → array of team objects
   */
  function makeMockFetchAllPages({ teams, teamMembers }) {
    return async function fetchAllPages(path) {
      if (/\/v2\/teams\/[^/]+\/members/.test(path)) return teamMembers;
      if (path.startsWith('/v2/teams')) return teams;
      return [];
    };
  }

  /**
   * Build mock pbFetch.
   * - POST /v2/members/search → returns { data: members } (new members endpoint)
   * - Everything else (GET pre-flight, etc.) → { data: [] }
   */
  function makeMockPbFetch(members = []) {
    return async (method, path) => {
      if (method === 'post' && path === '/v2/members/search') {
        return { data: members };
      }
      return { data: [] };
    };
  }

  test('members map populated from memberRecords', async () => {
    const fetchAllPages = makeMockFetchAllPages({ teams: [], teamMembers: [] });
    const pbFetch = makeMockPbFetch([
      { id: 'm1', fields: { name: 'Alice', email: 'alice@x.com', role: 'maker' } },
    ]);

    const entry = await buildCache('tok', fetchAllPages, pbFetch);
    assert.equal(entry.members.size, 1);
    const m = entry.members.get('m1');
    assert.equal(m.name, 'Alice');
    assert.equal(m.email, 'alice@x.com');
    assert.equal(m.role, 'maker');
  });

  test('teams map populated from teamRecords', async () => {
    const fetchAllPages = makeMockFetchAllPages({
      teams: [{ id: 't1', fields: { name: 'Eng', handle: 'eng' } }],
      teamMembers: [],
    });
    const pbFetch = makeMockPbFetch([]);

    const entry = await buildCache('tok', fetchAllPages, pbFetch);
    assert.equal(entry.teams.size, 1);
    const t = entry.teams.get('t1');
    assert.equal(t.name, 'Eng');
    assert.equal(t.handle, 'eng');
  });

  test('memberTeams built from team members list', async () => {
    const fetchAllPages = makeMockFetchAllPages({
      teams: [{ id: 't1', fields: { name: 'Engineering', handle: 'eng' } }],
      teamMembers: [{ id: 'm1', fields: { name: 'Alice', email: 'a@x.com' } }],
    });
    const pbFetch = makeMockPbFetch([
      { id: 'm1', fields: { name: 'Alice', email: 'a@x.com', role: 'maker' } },
    ]);

    const entry = await buildCache('tok', fetchAllPages, pbFetch);
    const memberTeams = entry.memberTeams.get('m1');
    assert.ok(Array.isArray(memberTeams));
    assert.ok(memberTeams.includes('Engineering'));
  });

  test('member with no team → memberTeams has no entry for them', async () => {
    const fetchAllPages = makeMockFetchAllPages({
      teams: [{ id: 't1', fields: { name: 'Eng', handle: 'eng' } }],
      teamMembers: [], // t1 has no members
    });
    const pbFetch = makeMockPbFetch([
      { id: 'm2', fields: { name: 'Bob', email: 'b@x.com', role: 'viewer' } },
    ]);

    const entry = await buildCache('tok', fetchAllPages, pbFetch);
    assert.equal(entry.memberTeams.has('m2'), false);
  });

  test('fetchedAt is set to a recent timestamp', async () => {
    const before = Date.now();
    const fetchAllPages = makeMockFetchAllPages({ teams: [], teamMembers: [] });
    const pbFetch = makeMockPbFetch([]);
    const entry = await buildCache('tok', fetchAllPages, pbFetch);
    const after = Date.now();
    assert.ok(entry.fetchedAt >= before && entry.fetchedAt <= after);
  });

  test('obfuscated=false when first member name is not "[obfuscated]"', async () => {
    const fetchAllPages = makeMockFetchAllPages({ teams: [], teamMembers: [] });
    const pbFetch = makeMockPbFetch([
      { id: 'm1', fields: { name: 'Alice', email: 'a@x.com', role: 'maker' } },
    ]);
    const entry = await buildCache('tok', fetchAllPages, pbFetch);
    assert.equal(entry.obfuscated, false);
  });

  test('obfuscated=true when first member name is "[obfuscated]"', async () => {
    const fetchAllPages = makeMockFetchAllPages({ teams: [], teamMembers: [] });
    const pbFetch = makeMockPbFetch([
      { id: 'm1', fields: { name: '[obfuscated]', email: '[obfuscated]', role: 'viewer' } },
    ]);
    const entry = await buildCache('tok', fetchAllPages, pbFetch);
    assert.equal(entry.obfuscated, true);
  });

  test('member with missing fields → defaults used', async () => {
    const fetchAllPages = makeMockFetchAllPages({ teams: [], teamMembers: [] });
    const pbFetch = makeMockPbFetch([
      { id: 'm1', fields: {} }, // all fields missing
    ]);
    const entry = await buildCache('tok', fetchAllPages, pbFetch);
    const m = entry.members.get('m1');
    assert.equal(m.name, '[unknown]');
    assert.equal(m.email, '[unknown]');
    assert.equal(m.role, 'viewer');
  });

  test('POST /v2/members/search paginated — follows links.next via GET', async () => {
    const fetchAllPages = makeMockFetchAllPages({ teams: [], teamMembers: [] });
    // Simulate two pages: first POST returns page 1 + links.next, GET returns page 2
    const page1 = [{ id: 'm1', fields: { name: 'Alice', email: 'a@x.com', role: 'maker' } }];
    const page2 = [{ id: 'm2', fields: { name: 'Bob',   email: 'b@x.com', role: 'viewer' } }];
    const pbFetch = async (method, path) => {
      if (method === 'post' && path === '/v2/members/search') {
        return { data: page1, links: { next: 'https://api.productboard.com/v2/members/search?pageCursor=cur1' } };
      }
      if (method === 'get' && path.includes('pageCursor=cur1')) {
        return { data: page2, links: {} };
      }
      return { data: [] };
    };

    const entry = await buildCache('tok', fetchAllPages, pbFetch);
    assert.equal(entry.members.size, 2);
    assert.ok(entry.members.has('m1'));
    assert.ok(entry.members.has('m2'));
  });
});
