/**
 * Shared team + member cache.
 *
 * Used by teamMembership.js and membersTeamsMgmt.js to avoid
 * redundant API calls when both modules need the same data.
 *
 * Cache is keyed by token string. Each entry holds:
 *   membersById      Map<id, MemberProfile>
 *   membersByEmail   Map<emailLower, MemberProfile>
 *   teamsById        Map<id, TeamMeta>
 *   memberIdsByTeamId Map<teamId, Set<memberId>>
 *   fetchedAt        timestamp (ms)
 */

'use strict';

const { listTeams, listMembers, listTeamMembers } = require('../lib/pbClient');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CACHE_TTL_MS     = 30 * 60 * 1000; // 30 min
const CACHE_MAX_ENTRIES = 200;
const BATCH            = 5;
const BATCH_DELAY_MS   = 100;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Cache store
// ---------------------------------------------------------------------------

/** @type {Map<string, CacheEntry>} token → CacheEntry */
const sessionCache = new Map();

function isCacheStale(entry) {
  return !entry || Date.now() - entry.fetchedAt > CACHE_TTL_MS;
}

function pruneCache() {
  if (sessionCache.size < CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of sessionCache) {
    if (isCacheStale(entry)) sessionCache.delete(key);
  }
  if (sessionCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = [...sessionCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    sessionCache.delete(oldest[0][0]);
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build and store the session cache for a given token.
 * Fetches members (includeDisabled:false, includeInvited:false) and teams
 * concurrently, then fans out team-member list calls in batches of 5.
 *
 * @param {string} token
 * @param {object} pbClient - from createClient()
 * @param {Function} [onProgress]
 * @returns {CacheEntry}
 */
async function buildCache(token, pbClient, onProgress = () => {}) {
  onProgress('Fetching members and teams…');

  const [memberRecords, teamRecords] = await Promise.all([
    listMembers(pbClient, { includeDisabled: false, includeInvited: false }),
    listTeams(pbClient),
  ]);

  // membersById: id → MemberProfile
  const membersById = new Map();
  // membersByEmail: email.toLowerCase() → MemberProfile
  const membersByEmail = new Map();
  for (const m of memberRecords) {
    const profile = {
      id:    m.id,
      name:  m.fields?.name     ?? '[unknown]',
      email: m.fields?.email    ?? '',
      role:  m.fields?.role     ?? 'viewer',
    };
    membersById.set(m.id, profile);
    if (profile.email) membersByEmail.set(profile.email.toLowerCase().trim(), profile);
  }

  // teamsById: id → TeamMeta
  const teamsById = new Map();
  for (const t of teamRecords) {
    teamsById.set(t.id, {
      id:          t.id,
      name:        t.fields?.name        ?? t.id,
      handle:      t.fields?.handle      ?? '',
      description: t.fields?.description ?? '',
    });
  }

  // memberIdsByTeamId: teamId → Set<memberId>
  const memberIdsByTeamId = new Map();
  const teamIds = teamRecords.map((t) => t.id);
  for (const id of teamIds) memberIdsByTeamId.set(id, new Set());

  onProgress(`Fetching team memberships (${teamRecords.length} teams)…`);

  let reqCount = 0;
  for (let i = 0; i < teamIds.length; i += BATCH) {
    const batch = teamIds.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (teamId) => {
        const members = await listTeamMembers(pbClient, teamId);
        reqCount++;
        for (const m of members) {
          if (m.id) memberIdsByTeamId.get(teamId)?.add(m.id);
        }
      })
    );
    // Inter-batch sleep: all 5 calls in a batch fire concurrently via Promise.all,
    // so rate-limit headers from one batch aren't visible to the next batch's requests
    // until after they've already started. This delay is the safety margin.
    if (i + BATCH < teamIds.length) await sleep(BATCH_DELAY_MS);
  }

  console.log(`[teamCache] built: ${membersById.size} members, ${teamsById.size} teams, ${reqCount} member-list requests`);

  const entry = { membersById, membersByEmail, teamsById, memberIdsByTeamId, fetchedAt: Date.now() };
  pruneCache();
  sessionCache.set(token, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function getCache(token) {
  return sessionCache.get(token);
}

function invalidateCache(token) {
  sessionCache.delete(token);
}

async function ensureCache(token, pbClient, onProgress) {
  let entry = sessionCache.get(token);
  if (isCacheStale(entry)) {
    entry = await buildCache(token, pbClient, onProgress);
  }
  return entry;
}

async function refreshCache(token, pbClient) {
  invalidateCache(token);
  return buildCache(token, pbClient);
}

module.exports = {
  buildCache,
  getCache,
  ensureCache,
  invalidateCache,
  refreshCache,
  isCacheStale,
  CACHE_TTL_MS,
};
