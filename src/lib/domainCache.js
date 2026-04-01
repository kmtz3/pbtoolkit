/**
 * Shared company domain cache utilities.
 *
 * The v2 list/search endpoint returns the domain field under a workspace-specific
 * UUID key (e.g. "b37b798e-...") rather than the logical "domain" string key that
 * appears in single-entity GETs and the config endpoint. The UUID is consistent
 * within a workspace but varies between workspaces and is not discoverable from
 * the config alone.
 *
 * Strategy: fetch all companies from v2 list (cursor-paginated, covers both
 * legacy v1-created companies and v2-only companies created via PBToolkit), then
 * do ONE individual GET to discover the UUID key by cross-referencing with the
 * normalised "domain" key that single-entity GETs always return.
 *
 * TODO: once PB fixes the domain field key inconsistency in list/search responses
 * (so "domain" string key is returned consistently instead of a workspace-specific
 * UUID), remove the individual GET discovery loop and read domain directly from
 * entity.fields.domain in the list response.
 */

/**
 * Fetch all companies and discover the workspace-specific domain field key.
 * Returns { companies, domainFieldKey } where domainFieldKey may be null
 * if no company has a domain set.
 */
async function fetchCompaniesWithDomainKey(pbFetch, withRetry, fetchAllPages, label) {
  const companies = await fetchAllPages('/v2/entities?type[]=company', label || 'fetch companies for domain cache');
  if (companies.length === 0) return { companies, domainFieldKey: null };

  let domainFieldKey = null;
  for (const candidate of companies) {
    let singleDomain;
    try {
      const r = await withRetry(
        () => pbFetch('get', `/v2/entities/${candidate.id}`),
        'domain field key discovery'
      );
      singleDomain = r.data?.fields?.domain;
    } catch (_) { continue; }

    if (!singleDomain) continue;

    for (const [key, val] of Object.entries(candidate.fields || {})) {
      if (typeof val === 'string' && val.toLowerCase() === singleDomain.toLowerCase()) {
        domainFieldKey = key;
        break;
      }
    }
    if (domainFieldKey) break;
  }

  return { companies, domainFieldKey };
}

/**
 * Build a domain → companyId lookup.
 * Used by import flows to resolve domain strings to company UUIDs.
 */
async function buildDomainToIdMap(pbFetch, withRetry, fetchAllPages, label) {
  const { companies, domainFieldKey } = await fetchCompaniesWithDomainKey(pbFetch, withRetry, fetchAllPages, label);
  const map = {};
  if (!domainFieldKey) return map;

  for (const entity of companies) {
    const domain = entity.fields?.[domainFieldKey];
    if (domain && typeof domain === 'string') {
      map[domain.toLowerCase()] = entity.id;
    }
  }
  return map;
}

/**
 * Build a companyId → { domain } lookup.
 * Used by user export to resolve parent company IDs to domain strings.
 */
async function buildIdToDomainMap(pbFetch, withRetry, fetchAllPages, label) {
  const { companies, domainFieldKey } = await fetchCompaniesWithDomainKey(pbFetch, withRetry, fetchAllPages, label);
  const map = {};

  for (const entity of companies) {
    const domain = domainFieldKey ? entity.fields?.[domainFieldKey] : null;
    map[entity.id] = { domain: domain || '' };
  }
  return map;
}

module.exports = { fetchCompaniesWithDomainKey, buildDomainToIdMap, buildIdToDomainMap };
