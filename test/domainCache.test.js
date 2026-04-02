'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchCompaniesWithDomainKey, buildDomainToIdMap, buildIdToDomainMap } = require('../src/lib/domainCache');

// ── helpers ──────────────────────────────────────────────────────────────────

const DOMAIN_UUID = 'b37b798e-aaaa-bbbb-cccc-111111111111';

const COMPANY_A = {
  id: 'comp-aaa',
  fields: { name: 'Acme', [DOMAIN_UUID]: 'acme.com' },
};
const COMPANY_B = {
  id: 'comp-bbb',
  fields: { name: 'Beta', [DOMAIN_UUID]: 'beta.io' },
};
const COMPANY_NO_DOMAIN = {
  id: 'comp-ccc',
  fields: { name: 'NoDomain' },
};

function mockPbFetch(getResponses) {
  return async (method, path) => {
    const key = `${method}:${path}`;
    for (const [pattern, response] of Object.entries(getResponses)) {
      if (key.includes(pattern)) return response;
    }
    throw new Error(`Unmocked: ${key}`);
  };
}

function mockWithRetry(fn) { return fn(); }

// ── fetchCompaniesWithDomainKey ──────────────────────────────────────────────

test('fetchCompaniesWithDomainKey — returns companies and discovers domain field key', async () => {
  const pbFetch = mockPbFetch({
    // Single-entity GET for domain discovery (first candidate)
    [`get:/v2/entities/${COMPANY_A.id}`]: { data: { fields: { domain: 'acme.com' } } },
  });

  const fetchAllPages = async () => [COMPANY_A, COMPANY_B];

  const result = await fetchCompaniesWithDomainKey(pbFetch, mockWithRetry, fetchAllPages);

  assert.equal(result.companies.length, 2);
  assert.equal(result.domainFieldKey, DOMAIN_UUID);
});

test('fetchCompaniesWithDomainKey — returns null domainFieldKey when no companies', async () => {
  const pbFetch = mockPbFetch({});
  const fetchAllPages = async () => [];

  const result = await fetchCompaniesWithDomainKey(pbFetch, mockWithRetry, fetchAllPages);

  assert.equal(result.companies.length, 0);
  assert.equal(result.domainFieldKey, null);
});

test('fetchCompaniesWithDomainKey — skips companies without domain for discovery', async () => {
  const calls = [];
  const pbFetch = async (method, path) => {
    calls.push(path);
    if (path.includes(COMPANY_NO_DOMAIN.id)) {
      return { data: { fields: { domain: null } } };
    }
    if (path.includes(COMPANY_A.id)) {
      return { data: { fields: { domain: 'acme.com' } } };
    }
    throw new Error('unexpected');
  };

  const fetchAllPages = async () => [COMPANY_NO_DOMAIN, COMPANY_A];

  const result = await fetchCompaniesWithDomainKey(pbFetch, mockWithRetry, fetchAllPages);

  assert.equal(result.domainFieldKey, DOMAIN_UUID);
  // Should have tried COMPANY_NO_DOMAIN first, then COMPANY_A
  assert.ok(calls.length >= 2);
});

test('fetchCompaniesWithDomainKey — survives individual GET errors gracefully', async () => {
  let callCount = 0;
  const pbFetch = async (method, path) => {
    callCount++;
    if (callCount === 1) throw new Error('API error');
    return { data: { fields: { domain: 'acme.com' } } };
  };

  const fetchAllPages = async () => [COMPANY_NO_DOMAIN, COMPANY_A];

  const result = await fetchCompaniesWithDomainKey(pbFetch, mockWithRetry, fetchAllPages);
  // First company errored, second discovered the key
  assert.equal(result.domainFieldKey, DOMAIN_UUID);
});

// ── buildDomainToIdMap ───────────────────────────────────────────────────────

test('buildDomainToIdMap — builds lowercase domain→id lookup', async () => {
  const pbFetch = mockPbFetch({
    [`get:/v2/entities/${COMPANY_A.id}`]: { data: { fields: { domain: 'acme.com' } } },
  });
  const fetchAllPages = async () => [COMPANY_A, COMPANY_B];

  const map = await buildDomainToIdMap(pbFetch, mockWithRetry, fetchAllPages);

  assert.equal(map['acme.com'], 'comp-aaa');
  assert.equal(map['beta.io'], 'comp-bbb');
});

test('buildDomainToIdMap — returns empty map when no domainFieldKey', async () => {
  const pbFetch = mockPbFetch({});
  const fetchAllPages = async () => [];

  const map = await buildDomainToIdMap(pbFetch, mockWithRetry, fetchAllPages);
  assert.deepEqual(map, {});
});

// ── buildIdToDomainMap ───────────────────────────────────────────────────────

test('buildIdToDomainMap — builds id→{domain} lookup', async () => {
  const pbFetch = mockPbFetch({
    [`get:/v2/entities/${COMPANY_A.id}`]: { data: { fields: { domain: 'acme.com' } } },
  });
  const fetchAllPages = async () => [COMPANY_A, COMPANY_NO_DOMAIN];

  const map = await buildIdToDomainMap(pbFetch, mockWithRetry, fetchAllPages);

  assert.equal(map['comp-aaa'].domain, 'acme.com');
  assert.equal(map['comp-ccc'].domain, ''); // no domain → empty string
});
