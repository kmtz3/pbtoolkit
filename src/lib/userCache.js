/**
 * Shared user (customer) cache utilities.
 *
 * Fetches all user entities from the v2 list endpoint (cursor-paginated).
 * Mirrors domainCache.js's pattern for companies.
 */

/**
 * Build an email → userId lookup.
 * Used by import flows to resolve email strings to user UUIDs.
 */
async function buildEmailToIdMap(fetchAllPages, label) {
  const users = await fetchAllPages('/v2/entities?type[]=user', label || 'fetch users for email cache');
  const map = {};
  for (const entity of users) {
    const email = entity.fields?.email;
    if (email && typeof email === 'string') map[email.toLowerCase()] = entity.id;
  }
  return map;
}

/**
 * Build a userId → { email } lookup.
 * Used by note export to resolve customer relationship IDs to email strings.
 */
async function buildIdToEmailMap(fetchAllPages, label) {
  const users = await fetchAllPages('/v2/entities?type[]=user', label || 'fetch users for email cache');
  const map = {};
  for (const entity of users) {
    map[entity.id] = { email: entity.fields?.email || '' };
  }
  return map;
}

module.exports = { buildEmailToIdMap, buildIdToEmailMap };
