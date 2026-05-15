/**
 * Duplicate Company Cleanup routes
 *
 * GET  /api/companies-duplicate-cleanup/origins     — return distinct source origin values
 * POST /api/companies-duplicate-cleanup/scan        — discover duplicate groups via API (SSE)
 * POST /api/companies-duplicate-cleanup/preview-csv — fetch company details + counts for CSV-supplied groups (SSE)
 * POST /api/companies-duplicate-cleanup/run         — merge duplicates into their target company (SSE)
 *
 * /run processing — for each duplicate company:
 *   1. POST /v2/notes/search  — find all notes linked to the duplicate
 *   2. For each note, relink its customer to the target company:
 *        user customer   → PUT /v2/entities/{user_id}/relationships/parent
 *        company/missing → PUT /v2/notes/{note_id}/relationships/customer
 *   3. POST /v2/entities/search (type=user, parent=dupId) — find users parented to the
 *        duplicate not caught via notes; relink each → PUT /v2/entities/{user_id}/relationships/parent
 *   4. DELETE /v2/entities/{dup_id}  — only if every relink for that company succeeded
 *
 * Rate limiting: pbFetch throttles via token-bucket (minDelay + remaining-based backoff).
 * Retries: withRetry wraps every mutating call — up to 6 attempts, exponential backoff,
 *          honours Retry-After on 429s.
 */

const express = require('express');
const { pbAuth } = require('../middleware/pbAuth');
const { startSSE } = require('../lib/sse');
const { parseApiError } = require('../lib/errorUtils');
const { UUID_RE } = require('../lib/constants');
const { extractCursor } = require('../lib/pbClient');

const router = express.Router();

// Stop flags — keyed by token so concurrent runs from different users don't interfere.
// POST /run clears the flag on entry; POST /run/stop sets it; finally block cleans up.
const _stopRequests = new Map();

// POST /run/stop  — signal a running merge to stop after the current duplicate
router.post('/run/stop', pbAuth, (_req, res) => {
  _stopRequests.set(res.locals.pbToken, true);
  res.sendStatus(204);
});


// ---------------------------------------------------------------------------
// Origins cache (per-token, 30-minute TTL — mirrors teamCache pattern)
// ---------------------------------------------------------------------------

const ORIGINS_CACHE_TTL_MS    = 30 * 60 * 1000;
const ORIGINS_CACHE_MAX_ENTRIES = 50;
const originsCache = new Map();

function getCachedOrigins(token) {
  const entry = originsCache.get(token);
  if (!entry || Date.now() - entry.fetchedAt > ORIGINS_CACHE_TTL_MS) return null;
  return entry.origins;
}

function pruneOriginsCache() {
  if (originsCache.size < ORIGINS_CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of originsCache) {
    if (Date.now() - entry.fetchedAt > ORIGINS_CACHE_TTL_MS) originsCache.delete(key);
  }
  if (originsCache.size >= ORIGINS_CACHE_MAX_ENTRIES) {
    const oldest = [...originsCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    originsCache.delete(oldest[0][0]);
  }
}

function setCachedOrigins(token, origins) {
  pruneOriginsCache();
  originsCache.set(token, { origins, fetchedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// GET /origins — return distinct non-null sourceOrigin values across v2 + v1
// ---------------------------------------------------------------------------

router.get('/origins', pbAuth, async (req, res) => {
  const token = res.locals.pbToken;
  const forceRefresh = req.query.refresh === 'true';

  if (!forceRefresh) {
    const cached = getCachedOrigins(token);
    if (cached) return res.json({ origins: cached });
  }

  const { pbFetch, withRetry } = res.locals.pbClient;
  try {
    const originsSet    = new Set();
    const missingV2Ids  = new Set(); // company IDs where v2 source is null — need v1 fallback

    // v2: metadata.source.system
    let cursor = null;
    do {
      const path = cursor
        ? `/v2/entities?type[]=company&pageCursor=${encodeURIComponent(cursor)}`
        : '/v2/entities?type[]=company';
      const r = await withRetry(() => pbFetch('get', path), 'fetch v2 companies for origins');
      for (const c of (r.data || [])) {
        const sys = c.metadata?.source?.system;
        if (sys) originsSet.add(sys);
        else if (c.id) missingV2Ids.add(c.id);
      }
      cursor = extractCursor(r.links?.next);
    } while (cursor);

    // v1 fallback: sourceOrigin for companies whose v2 source was null.
    // Stops as soon as all missing IDs have been back-filled (mirrors /scan behaviour).
    if (missingV2Ids.size > 0) {
      let offset = 0;
      let filled = 0;
      const PAGE = 100;
      while (filled < missingV2Ids.size) {
        const r = await withRetry(
          () => pbFetch('get', `/companies?pageLimit=${PAGE}&pageOffset=${offset}`),
          `fetch v1 companies for origins offset=${offset}`
        );
        const batch = r.data || [];
        for (const c of batch) {
          if (c.id && missingV2Ids.has(c.id) && c.sourceOrigin) {
            originsSet.add(c.sourceOrigin);
            filled++;
          }
        }
        if (batch.length < PAGE) break;
        offset += PAGE;
      }
    }

    const origins = [...originsSet].sort();
    setCachedOrigins(token, origins);
    res.json({ origins });
  } catch (err) {
    console.error('[companiesDuplicateCleanup/origins]', err);
    res.status(500).json({ error: parseApiError(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /scan  (SSE) — discover duplicates via API, no CSV upload required
//
// Body: { primaryOrigin?, manualMode?, matchCriteria?, fuzzyMatch?, noDomainOnly? }
//
// matchCriteria:
//   'domain'      (default) — companies are duplicates if they share the same domain
//   'domain+name' — companies are duplicates only if they share both domain AND name
//   'name'        — duplicates if they share the same name (all companies by default)
//
// fuzzyMatch (meaningful with 'domain+name' or 'name'):
//   false (default) — exact, case-sensitive name comparison after trim
//   true  — lowercase + strip non-alphanumeric (except spaces) + collapse spaces
//           e.g. 'Acme Inc' = 'ACME, INC.' but 'Acme Inc' ≠ 'Acme'
//
// noDomainOnly (only meaningful with matchCriteria='name'):
//   false (default) — match by name across all companies regardless of domain
//   true  — restrict name matching to companies that have no domain set
//
// Origin mode (default):
//   For each group with 2+ companies, exactly one must match primaryOrigin
//   (default 'salesforce') to become the target; all others become duplicates.
//   Groups with 0 or 2+ matching the origin are skipped.
//
// Manual mode:
//   All groups with 2+ companies are returned. Default target = first non-null
//   origin company (preferring 'salesforce'); if all are null, first in list.
//   The frontend allows the user to swap the target.
//
// Source origin strategy (v2-first, v1-fallback):
//   1. Fetch all companies from v2 entities → domain + id + metadata.source.system
//   2. If any company has metadata.source.system = null, fetch v1 /companies for those
//      ids only and back-fill sourceOrigin from v1 (covers the legacy metadata migration gap)
// ---------------------------------------------------------------------------

// Normalize a company name for duplicate matching.
// Non-fuzzy: exact trimmed string (case-sensitive).
// Fuzzy: lowercase, strip punctuation/special chars, collapse whitespace.
function normalizeNameForMatch(str, fuzzy) {
  if (!str) return '';
  const s = str.trim();
  if (!fuzzy) return s;
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

router.post('/scan', pbAuth, async (req, res) => {
  const sse = startSSE(res);
  const { pbFetch, withRetry } = res.locals.pbClient;
  const {
    primaryOrigin = 'salesforce',
    manualMode    = false,
    matchCriteria = 'domain',
    fuzzyMatch    = false,
    noDomainOnly  = false,
  } = req.body || {};

  try {
    // ── Step 1: Fetch all v2 companies (domain + id + source) ────────────
    sse.progress('Fetching companies from v2 API…', 5);

    const v2Companies = [];
    let cursor = null;
    do {
      if (sse.isAborted()) break;
      const path = cursor
        ? `/v2/entities?type[]=company&pageCursor=${encodeURIComponent(cursor)}`
        : '/v2/entities?type[]=company';
      const r = await withRetry(() => pbFetch('get', path), 'fetch v2 companies');
      if (r.data?.length) v2Companies.push(...r.data);
      cursor = extractCursor(r.links?.next);
    } while (cursor);

    sse.log('info', `Fetched ${v2Companies.length} compan${v2Companies.length === 1 ? 'y' : 'ies'} from v2 API`);
    if (sse.isAborted()) { sse.complete({ domainRecords: [], skippedRows: [], totalDomains: 0, totalDuplicates: 0, stopped: true }); return; }

    // Build initial source maps from v2 metadata
    // id → sourceOrigin (string | null), id → sourceRecordId (string | null)
    const sourceMap    = {};
    const recordIdMap  = {};
    for (const c of v2Companies) {
      sourceMap[c.id]   = c.metadata?.source?.system    || null;
      recordIdMap[c.id] = c.metadata?.source?.recordId  || null;
    }

    // ── Step 2: v1 fallback for ids where v2 source is null ──────────────
    const missingSourceIds = new Set(Object.entries(sourceMap).filter(([, v]) => v === null).map(([k]) => k));

    if (missingSourceIds.size > 0 && !sse.isAborted()) {
      sse.progress(`Fetching source origin from v1 API for ${missingSourceIds.size} compan${missingSourceIds.size === 1 ? 'y' : 'ies'}…`, 40);

      // v1 doesn't support filtering by id, so paginate and collect what we need
      let offset = 0;
      const PAGE = 100;
      let filled = 0;
      while (missingSourceIds.size > filled && !sse.isAborted()) {
        const r = await withRetry(
          () => pbFetch('get', `/companies?pageLimit=${PAGE}&pageOffset=${offset}`),
          `fetch v1 companies offset=${offset}`
        );
        const batch = r.data || [];
        for (const c of batch) {
          if (c.id && missingSourceIds.has(c.id)) {
            sourceMap[c.id] = c.sourceOrigin || null;
            // Only fall back to v1 sourceRecordId if v2 recordId was also null
            if (!recordIdMap[c.id]) recordIdMap[c.id] = c.sourceRecordId || null;
            filled++;
          }
        }
        if (batch.length < PAGE) break;
        offset += PAGE;
      }

      sse.log('info', `Back-filled source data for ${filled} compan${filled === 1 ? 'y' : 'ies'} from v1 API`);
    } else if (missingSourceIds.size === 0) {
      sse.log('info', 'All source origins resolved from v2 — v1 fallback not needed');
    }

    if (sse.isAborted()) { sse.complete({ domainRecords: [], skippedRows: [], totalDomains: 0, totalDuplicates: 0, stopped: true }); return; }

    // ── Step 3: Group by domain ───────────────────────────────────────────
    sse.progress('Detecting duplicates…', 75);

    // Build name map from v2 fields
    const nameMap = {};
    for (const c of v2Companies) {
      nameMap[c.id] = c.fields?.name || null;
    }

    const byDomain   = {};  // domain → [{ id, name, sourceOrigin, sourceRecordId }]
    const namePool   = [];  // for name-only mode: companies eligible for name matching
    for (const c of v2Companies) {
      const domain = (c.fields?.domain || '').trim().toLowerCase();
      const entry  = { id: c.id, name: nameMap[c.id] || null, domain: domain || null, sourceOrigin: sourceMap[c.id] || null, sourceRecordId: recordIdMap[c.id] || null };
      if (!domain) {
        if (matchCriteria === 'name') namePool.push(entry);
        continue;
      }
      if (!byDomain[domain]) byDomain[domain] = [];
      byDomain[domain].push(entry);
      // Include domain-having companies in name pool unless restricted to no-domain only
      if (matchCriteria === 'name' && !noDomainOnly) namePool.push(entry);
    }

    // ── Step 4: Build duplicate records ──────────────────────────────────────
    const domainRecords = [];
    const skippedRows   = [];

    // Helper: resolve a group of companies into a domainRecord or skippedRow entry.
    // domain    — the domain key (empty string for name-only groups)
    // companies — array of { id, name, sourceOrigin, sourceRecordId }
    // matchName — display name for sub-grouped records (domain+name or name mode)
    const resolveGroup = (domain, companies, matchName) => {
      if (companies.length < 2) return;

      if (manualMode) {
        const sorted = [...companies].sort((a, b) => {
          if (a.sourceOrigin && !b.sourceOrigin) return -1;
          if (!a.sourceOrigin && b.sourceOrigin) return 1;
          if (a.sourceOrigin === 'salesforce') return -1;
          if (b.sourceOrigin === 'salesforce') return 1;
          return 0;
        });
        const target = sorted[0];
        const rec = {
          domain,
          primaryId:             target.id,
          primaryName:           target.name || target.id,
          primaryDomain:         target.domain || null,
          primaryOrigin:         target.sourceOrigin,
          primarySourceRecordId: target.sourceRecordId || null,
          duplicates:              sorted.slice(1).map(c => ({ id: c.id, name: c.name || c.id, domain: c.domain || null, sourceOrigin: c.sourceOrigin, sourceRecordId: c.sourceRecordId || null })),
          isManualMode:            true,
        };
        if (matchName) rec.matchName = matchName;
        domainRecords.push(rec);
      } else {
        const primary = companies.filter(c => c.sourceOrigin === primaryOrigin);
        const others  = companies.filter(c => c.sourceOrigin !== primaryOrigin);

        if (primary.length === 1) {
          const rec = {
            domain,
            primaryId:             primary[0].id,
            primaryName:           primary[0].name || primary[0].id,
            primaryDomain:         primary[0].domain || null,
            primaryOrigin:         primary[0].sourceOrigin,
            primarySourceRecordId: primary[0].sourceRecordId || null,
            duplicates:              others.map(c => ({ id: c.id, name: c.name || c.id, domain: c.domain || null, sourceOrigin: c.sourceOrigin, sourceRecordId: c.sourceRecordId || null })),
            isManualMode:            false,
          };
          if (matchName) rec.matchName = matchName;
          domainRecords.push(rec);
        } else if (primary.length === 0) {
          const raw = companies.map(c => `${c.id} (${c.sourceOrigin || 'unknown'})`).join(', ');
          const row = { domain, uuidWithOrigin: raw, reason: 'no_primary_origin', primaryOrigin };
          if (matchName) row.matchName = matchName;
          skippedRows.push(row);
        } else {
          const primaryIds = primary.map(c => c.id);
          const raw        = companies.map(c => `${c.id} (${c.sourceOrigin || 'unknown'})`).join(', ');
          const row        = { domain, uuidWithOrigin: raw, reason: 'multiple_primary_origin', primaryOrigin, primaryUuids: primaryIds };
          if (matchName) row.matchName = matchName;
          skippedRows.push(row);
        }
      }
    };

    // Domain-based grouping (criteria: 'domain' or 'domain+name'; skip for 'name')
    for (const [domain, domainCompanies] of matchCriteria === 'name' ? [] : Object.entries(byDomain)) {
      // Determine sub-groups:
      //   domain-only  → one group containing all companies for this domain
      //   domain+name  → sub-groups by normalized name; only groups with 2+ companies
      let groups; // [{ companies: [...], matchName: string|null }]
      if (matchCriteria === 'domain+name') {
        const byName = {};
        for (const c of domainCompanies) {
          const key = normalizeNameForMatch(c.name || '', fuzzyMatch);
          if (!byName[key]) byName[key] = [];
          byName[key].push(c);
        }
        groups = Object.values(byName)
          .filter(grp => grp.length >= 2)
          .map(grp => ({ companies: grp, matchName: grp[0].name || null }));
      } else {
        if (domainCompanies.length < 2) continue;
        groups = [{ companies: domainCompanies, matchName: null }];
      }
      for (const { companies, matchName } of groups) resolveGroup(domain, companies, matchName);
    }

    // Name-only grouping: companies grouped by name.
    // noDomainOnly=false (default): all companies; noDomainOnly=true: no-domain companies only.
    if (matchCriteria === 'name' && namePool.length > 0) {
      const byName = {};
      for (const c of namePool) {
        const key = normalizeNameForMatch(c.name || '', fuzzyMatch);
        if (!key) continue;
        if (!byName[key]) byName[key] = [];
        byName[key].push(c);
      }
      for (const [key, nameGroup] of Object.entries(byName)) {
        // Exact match: show the original name; fuzzy: show the normalized key that was matched on
        const matchName = fuzzyMatch ? key : (nameGroup[0].name || nameGroup[0].id);
        resolveGroup('', nameGroup, matchName);
      }
    }

    const totalDuplicates = domainRecords.reduce((n, r) => n + r.duplicates.length, 0);

    sse.log('info', `Found ${domainRecords.length} group${domainRecords.length !== 1 ? 's' : ''} with duplicates · ${skippedRows.length} skipped`);

    // ── Step 5: Fetch note + user counts ─────────────────────────────────
    // Origin mode: counts for duplicates only (target is the keeper — its counts don't change).
    // Manual mode: counts for ALL companies in each group (any company may become the target).
    if (domainRecords.length > 0 && !sse.isAborted()) {
      const companiesToCount = [];
      for (const dr of domainRecords) {
        for (const dup of dr.duplicates) companiesToCount.push({ dr, obj: dup });
        if (manualMode) companiesToCount.push({ dr, obj: dr, isTarget: true });
      }

      sse.progress(`Fetching note and user counts for ${companiesToCount.length} compan${companiesToCount.length !== 1 ? 'ies' : 'y'}…`, 80);

      for (let i = 0; i < companiesToCount.length; i++) {
        if (sse.isAborted()) break;
        const { dr, obj, isTarget } = companiesToCount[i];
        const id = isTarget ? dr.primaryId : obj.id;
        const pct = 80 + Math.round((i / companiesToCount.length) * 18);
        sse.progress(`Counting notes for ${dr.matchName || dr.domain || '(no domain)'} (${i + 1}/${companiesToCount.length})…`, pct);
        try {
          const counts = await fetchNoteCounts(pbFetch, withRetry, id);
          if (isTarget) {
            dr.primaryNotesCount    = counts.notesCount;
            dr.primaryUsersCount    = counts.usersCount;
            dr.primaryEntitiesCount = counts.entitiesCount;
          } else {
            obj.notesCount    = counts.notesCount;
            obj.usersCount    = counts.usersCount;
            obj.entitiesCount = counts.entitiesCount;
          }
        } catch {
          if (isTarget) { dr.primaryNotesCount = null; dr.primaryUsersCount = null; dr.primaryEntitiesCount = null; }
          else          { obj.notesCount  = null; obj.usersCount  = null; obj.entitiesCount = null; }
        }
      }
    }

    sse.progress('Scan complete.', 100);
    sse.complete({ domainRecords, skippedRows, totalDomains: domainRecords.length, totalDuplicates, matchCriteria, fuzzyMatch });

  } catch (err) {
    console.error('[companiesDuplicateCleanup/scan]', err);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// POST /preview-csv  (SSE)
//
// Body: { rows: [{ primaryId: string, duplicateIds: [string] }] }
//
// For each group supplied in rows:
//   1. Validate UUID format of primaryId and each duplicateId.
//   2. Merge rows with the same primaryId (union their duplicateIds).
//   3. Fetch company details (name, domain, source) for every unique ID via
//      GET /v2/entities/{id}.
//   4. Fetch note + user counts for each duplicate (same as /scan).
//   5. Complete with { domainRecords, totalDomains, totalDuplicates } in the
//      same format expected by /run.
// ---------------------------------------------------------------------------

router.post('/preview-csv', pbAuth, async (req, res) => {
  const sse = startSSE(res);
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { rows = [] } = req.body || {};

  try {
    // ── Step 1: Validate input ────────────────────────────────────────────
    if (!Array.isArray(rows) || rows.length === 0) {
      sse.error('No rows provided.');
      return;
    }

    for (let i = 0; i < rows.length; i++) {
      const { primaryId, duplicateIds } = rows[i];
      const rowLabel = `Row ${i + 1}`;
      if (!primaryId || !UUID_RE.test(primaryId)) {
        sse.error(`${rowLabel}: invalid target UUID "${primaryId}".`);
        return;
      }
      if (!Array.isArray(duplicateIds) || duplicateIds.length === 0) {
        sse.error(`${rowLabel}: no duplicate IDs provided.`);
        return;
      }
      for (const id of duplicateIds) {
        if (!UUID_RE.test(id)) {
          sse.error(`${rowLabel}: invalid duplicate UUID "${id}".`);
          return;
        }
        if (id === primaryId) {
          sse.error(`${rowLabel}: target UUID "${primaryId}" appears in its own duplicates list.`);
          return;
        }
      }
    }

    // ── Step 2: Merge rows with the same primaryId ────────────────────────
    const grouped = new Map(); // primaryId → Set<duplicateId>
    for (const { primaryId, duplicateIds } of rows) {
      if (!grouped.has(primaryId)) grouped.set(primaryId, new Set());
      for (const id of duplicateIds) grouped.get(primaryId).add(id);
    }

    // ── Step 3: Fetch company details for all unique IDs ──────────────────
    const allIds = new Set(grouped.keys());
    for (const dupeSet of grouped.values()) {
      for (const id of dupeSet) allIds.add(id);
    }

    sse.progress(`Fetching details for ${allIds.size} compan${allIds.size !== 1 ? 'ies' : 'y'}…`, 5);

    const companyDetails = {}; // id → { id, name, domain, sourceOrigin, sourceRecordId, notFound? }
    let fetched = 0;
    for (const id of allIds) {
      if (sse.isAborted()) break;
      fetched++;
      const pct = 5 + Math.round((fetched / allIds.size) * 40);
      sse.progress(`Fetching company ${fetched}/${allIds.size}…`, pct);
      try {
        const r = await withRetry(() => pbFetch('get', `/v2/entities/${id}`), `fetch company ${id}`);
        const c = r.data || {};
        companyDetails[id] = {
          id,
          name:            c.fields?.name  || null,
          domain:          (c.fields?.domain || '').trim().toLowerCase() || null,
          sourceOrigin:    c.metadata?.source?.system    || null,
          sourceRecordId:  c.metadata?.source?.recordId  || null,
        };
      } catch {
        companyDetails[id] = { id, name: null, domain: null, sourceOrigin: null, sourceRecordId: null, notFound: true };
      }
    }

    if (sse.isAborted()) { sse.complete({ domainRecords: [], totalDomains: 0, totalDuplicates: 0 }); return; }

    // ── Step 3.5: v1 fallback for companies where v2 source is null ──────────
    // v2 metadata.source.system is null for companies whose source was only
    // recorded in v1 (legacy migration gap). Paginate v1 and back-fill.
    const missingSourceIds = new Set(
      Object.values(companyDetails)
        .filter(c => !c.notFound && c.sourceOrigin === null)
        .map(c => c.id)
    );

    if (missingSourceIds.size > 0 && !sse.isAborted()) {
      sse.progress(`Fetching source data from v1 API for ${missingSourceIds.size} compan${missingSourceIds.size !== 1 ? 'ies' : 'y'}…`, 45);

      // v1 doesn't support filtering by id, so paginate and collect what we need
      let offset = 0;
      const PAGE = 100;
      let filled = 0;
      while (filled < missingSourceIds.size && !sse.isAborted()) {
        const r = await withRetry(
          () => pbFetch('get', `/companies?pageLimit=${PAGE}&pageOffset=${offset}`),
          `v1 source fallback offset=${offset}`
        );
        const batch = r.data || [];
        for (const c of batch) {
          if (c.id && missingSourceIds.has(c.id)) {
            companyDetails[c.id].sourceOrigin   = c.sourceOrigin   || null;
            // Only use v1 sourceRecordId if v2 recordId was also null
            if (!companyDetails[c.id].sourceRecordId) {
              companyDetails[c.id].sourceRecordId = c.sourceRecordId || null;
            }
            filled++;
          }
        }
        if (batch.length < PAGE) break;
        offset += PAGE;
      }

      sse.log('info', `Back-filled source data for ${filled} compan${filled !== 1 ? 'ies' : 'y'} from v1 API`);
    }

    if (sse.isAborted()) { sse.complete({ domainRecords: [], totalDomains: 0, totalDuplicates: 0 }); return; }

    // ── Step 4: Fetch note + user counts for duplicates ───────────────────
    const primaryIds    = [...grouped.keys()];
    const domainRecords = [];
    let   drIdx         = 0;

    for (const primaryId of primaryIds) {
      if (sse.isAborted()) break;
      drIdx++;

      const primary = companyDetails[primaryId] || { id: primaryId };
      const dupeIds = [...grouped.get(primaryId)];

      const dr = {
        domain:                primary.domain || '',
        primaryId,
        primaryName:           primary.name           || primaryId,
        primaryDomain:         primary.domain          || null,
        primaryOrigin:         primary.sourceOrigin    || null,
        primarySourceRecordId: primary.sourceRecordId  || null,
        primaryNotFound:       primary.notFound        || false,
        primaryNotesCount:     null,
        primaryUsersCount:     null,
        duplicates: dupeIds.map(id => {
          const c = companyDetails[id] || { id };
          return {
            id,
            name:            c.name           || id,
            domain:          c.domain          || null,
            sourceOrigin:    c.sourceOrigin    || null,
            sourceRecordId:  c.sourceRecordId  || null,
            notFound:        c.notFound        || false,
            notesCount:      null,
            usersCount:      null,
            entitiesCount:   null,
          };
        }),
        isManualMode: false,
      };

      for (let di = 0; di < dr.duplicates.length; di++) {
        if (sse.isAborted()) break;
        const dup = dr.duplicates[di];
        const pct = 45 + Math.round(((drIdx - 1 + (di + 1) / dr.duplicates.length) / primaryIds.length) * 50);
        sse.progress(`Counting notes for group ${drIdx}/${primaryIds.length}…`, pct);
        try {
          const counts = await fetchNoteCounts(pbFetch, withRetry, dup.id);
          dup.notesCount    = counts.notesCount;
          dup.usersCount    = counts.usersCount;
          dup.entitiesCount = counts.entitiesCount;
        } catch {
          // leave as null
        }
      }

      domainRecords.push(dr);
    }

    const totalDuplicates = domainRecords.reduce((n, dr) => n + dr.duplicates.length, 0);
    sse.progress('Preview ready.', 100);
    sse.complete({ domainRecords, totalDomains: domainRecords.length, totalDuplicates });

  } catch (err) {
    console.error('[companiesDuplicateCleanup/preview-csv]', err);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// Note + user count helper (used by /scan and /preview-csv)
// ---------------------------------------------------------------------------

/**
 * For a single company, fetch and return:
 *   notesCount    — notes whose customer is the company directly (will be relinked)
 *   usersCount    — ALL users that will have their parent company updated:
 *                   users found via the notes search (customer = user) UNION
 *                   users parented to this company via /v2/entities/search
 *                   (covers users with no notes attributed through this company)
 *   entitiesCount — non-customer/non-user relationships on the company itself
 *                   (link / isBlockedBy / isBlocking / parent / child to features,
 *                   components, initiatives, etc.) that need to be recreated on the
 *                   target so hierarchy / linked entities don't break on merge.
 */
async function fetchNoteCounts(pbFetch, withRetry, companyId) {
  // ── Query 1: notes linked to this company ───────────────────────────────
  const notesPayload = { data: { filter: { relationships: { customer: [{ id: companyId }] } } } };
  let r = await withRetry(
    () => pbFetch('post', '/v2/notes/search', notesPayload),
    `count notes for ${companyId}`
  );

  const notes = [...(r.data || [])];
  let nextUrl = r.links?.next || null;
  while (nextUrl) {
    r = await withRetry(() => pbFetch('get', nextUrl), `paginate note counts for ${companyId}`);
    if (r.data?.length) notes.push(...r.data);
    nextUrl = r.links?.next || null;
  }

  const noteAttributedUserIds = new Set();
  let notesCount = 0;
  for (const note of notes) {
    const rels = Array.isArray(note.relationships?.data) ? note.relationships.data : [];
    const customerRel = rels.find(rel => rel.type === 'customer');
    if (customerRel?.target?.type === 'user') {
      noteAttributedUserIds.add(customerRel.target.id);
    } else {
      notesCount++;
    }
  }

  // ── Query 2: users directly parented to this company ────────────────────
  // Covers users who have no notes attributed through this company (would be
  // missed by the notes-only approach above).
  const usersPayload = {
    data: {
      filter: {
        type: ['user'],
        relationships: { parent: [{ id: companyId }] },
      },
    },
  };
  const allUserIds = new Set(noteAttributedUserIds);
  let cursor = null;
  do {
    const url = cursor
      ? `/v2/entities/search?pageCursor=${encodeURIComponent(cursor)}`
      : '/v2/entities/search';
    const ur = await withRetry(
      () => pbFetch('post', url, usersPayload),
      `count users for ${companyId}`
    );
    for (const user of (ur.data || [])) {
      allUserIds.add(user.id);
    }
    cursor = extractCursor(ur.links?.next);
  } while (cursor);

  // ── Query 3: relationships on the company itself ────────────────────────
  // Covers link / isBlockedBy / isBlocking / parent / child to other entities
  // (features, components, initiatives, etc.) that the merge must recreate on
  // the target so hierarchy and linked entities don't break.
  const entityRels = await fetchCompanyEntityRelationships(pbFetch, withRetry, companyId);

  return { notesCount, usersCount: allUserIds.size, entitiesCount: entityRels.length };
}

/**
 * List all relationships on a company entity (link / hierarchy / dependencies).
 * Returns [{ type, targetId, targetType }], deduped by (type,targetId).
 */
async function fetchCompanyEntityRelationships(pbFetch, withRetry, companyId) {
  const out = [];
  const seen = new Set();
  let cursor = null;
  do {
    const url = cursor
      ? `/v2/entities/${companyId}/relationships?pageCursor=${encodeURIComponent(cursor)}`
      : `/v2/entities/${companyId}/relationships`;
    const r = await withRetry(() => pbFetch('get', url), `list relationships ${companyId}`);
    for (const rel of (r.data || [])) {
      const targetId   = rel.target?.id;
      const targetType = rel.target?.type;
      const relType    = rel.type;
      if (!targetId || !relType) continue;
      const key = `${relType}|${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: relType, targetId, targetType });
    }
    cursor = extractCursor(r.links?.next);
  } while (cursor);
  return out;
}


// ---------------------------------------------------------------------------
// Resolve the relationship target for a note
// ---------------------------------------------------------------------------

/**
 * Given a note object, return { targetId, targetType } where:
 *   targetType 'user' → set SF company as that user's parent company
 *   targetType 'note' → relink the note's customer directly to SF company
 */
function resolveTarget(note) {
  const rels = Array.isArray(note.relationships?.data) ? note.relationships.data : [];
  for (const rel of rels) {
    if (rel.type === 'customer') {
      const target = rel.target || {};
      if (target.type === 'user')    return { targetId: target.id, targetType: 'user' };
      if (target.type === 'company') return { targetId: note.id,   targetType: 'note' };
    }
  }
  // No customer relationship found — fall back to relinking the note directly
  return { targetId: note.id, targetType: 'note' };
}


// ---------------------------------------------------------------------------
// POST /run  (SSE)
// ---------------------------------------------------------------------------

router.post('/run', pbAuth, async (req, res) => {
  const token = res.locals.pbToken;
  _stopRequests.delete(token);
  const sse = startSSE(res);
  const shouldStop = () => sse.isAborted() || _stopRequests.get(token) === true;
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { domainRecords = [], keepDuplicates = false, archiveDuplicates = false } = req.body || {};
  // Archive only applies when we're keeping the duplicate (instead of deleting it).
  const shouldArchive = keepDuplicates === true && archiveDuplicates === true;

  let notesRelinked = 0, usersRelinked = 0, entitiesRelinked = 0, deleted = 0, kept = 0, archived = 0, errors = 0;
  const actionLog = [];

  // Accept both new { duplicates: [{id}] } and legacy { duplicateIds: [string] } formats
  const getDupIds = (dr) => dr.duplicates?.map(d => d.id) ?? dr.duplicateIds ?? [];
  const total = domainRecords.reduce((n, r) => n + getDupIds(r).length, 0);
  let processed = 0;

  try {
    sse.progress(
      `Starting merge of ${domainRecords.length} domain(s)…`, 0
    );

    for (const dr of domainRecords) {
      if (shouldStop()) break;

      for (const dupId of getDupIds(dr)) {
        if (shouldStop()) break;

        const pct = total > 0 ? Math.round((processed / total) * 90) : 0;
        sse.progress(
          `[${processed + 1}/${total}] ${dr.matchName || dr.domain || '(no domain)'} — duplicate ${dupId.slice(0, 8)}…`, pct
        );

        const entry = {
          domain:             dr.domain,
          duplicateCompanyId: dupId,
          primaryId:          dr.primaryId,
          notesFound:         0,
          notesRelinked:      0,
          usersRelinked:      0,
          entitiesRelinked:   0,
          noteIds:            [],
          userIds:            [],
          entityRelinks:      [],
          deleted:            false,
          kept:               false,
          archived:           false,
          error:              null,
        };

        try {
          let relinkFailed = false;

          // ── Step 1: Find and relink all notes linked to this duplicate ───
          const notes = [];

          const payload = { data: { filter: { relationships: { customer: [{ id: dupId }] } } } };
          let r = await withRetry(
            () => pbFetch('post', '/v2/notes/search', payload),
            `search notes for ${dupId}`
          );
          if (r.data?.length) notes.push(...r.data);
          let nextUrl = r.links?.next || null;
          while (nextUrl) {
            r = await withRetry(() => pbFetch('get', nextUrl), `paginate notes for ${dupId}`);
            if (r.data?.length) notes.push(...r.data);
            nextUrl = r.links?.next || null;
          }

          entry.notesFound = notes.length;

          // ── Step 2: Relink each note's customer to the target company ────
          // Users touched here are tracked so Step 3 can skip them.
          const relinkUserIds = new Set();

          for (const note of notes) {
            if (shouldStop()) break;

            const noteId = note.id || '';
            const { targetId, targetType } = resolveTarget(note);

            try {
              if (targetType === 'user') {
                // ── WORKAROUND for PB API bug (IS-8968) — remove once PB fix ships ──────
                //
                // BUG: when a user's parent company changes, PB's notes/search index does
                // not reliably re-derive the note's company. Re-PUTting the same user as
                // customer (the intuitive fix) is a no-op — the search index ignores it.
                // Tracked in: https://productboard.atlassian.net/browse/IS-8968
                // ETA for PB fix: ~week of 2026-05-22
                //
                // REVERT INSTRUCTIONS (once IS-8968 is resolved and deployed):
                //   Delete Steps 2a, 2b, and 2c entirely and replace with these two calls:
                //
                //     // Relink user to target company
                //     if (!relinkUserIds.has(targetId)) {
                //       await withRetry(
                //         () => pbFetch('put', `/v2/entities/${targetId}/relationships/parent`, {
                //           data: { target: { id: dr.primaryId }, type: 'company' },
                //         }),
                //         `relink user ${targetId} to target company`
                //       );
                //       sse.log('success', `Relinked user ${targetId} → target company (via note ${noteId})`, { uuid: targetId });
                //       relinkUserIds.add(targetId);
                //       entry.usersRelinked++;
                //       entry.userIds.push(targetId);
                //       usersRelinked++;
                //     }
                //     // Relink note customer to same user (PB should now auto-resolve company)
                //     await withRetry(
                //       () => pbFetch('put', `/v2/notes/${noteId}/relationships/customer`, {
                //         data: { target: { type: 'user', id: targetId } },
                //       }),
                //       `refresh note ${noteId} customer attribution`
                //     );
                //     sse.log('success', `Relinked note ${noteId} → user ${targetId}`, { uuid: noteId });
                //     entry.noteIds.push(noteId);
                //     entry.notesRelinked++;
                //     notesRelinked++;
                //
                // ────────────────────────────────────────────────────────────────────────

                // Step 2a: break the stale denormalized source link FIRST, before touching
                // the user. PUT note → company must happen before the user parent moves —
                // doing the user PUT first leaves the note stuck under source even with the
                // intermediate company PUT. (Live testing 2026-05-15, IS-8968.)
                await withRetry(
                  () => pbFetch('put', `/v2/notes/${noteId}/relationships/customer`, {
                    data: { target: { type: 'company', id: dr.primaryId } },
                  }),
                  `clear stale source link on note ${noteId}`
                );
                sse.log('info', `Cleared stale source link on note ${noteId} → target company`, { uuid: noteId });

                // Step 2b: re-parent the user — once per user, even if they're the
                // customer on multiple notes attributed to this duplicate.
                if (!relinkUserIds.has(targetId)) {
                  await withRetry(
                    () => pbFetch('put', `/v2/entities/${targetId}/relationships/parent`, {
                      data: { target: { id: dr.primaryId }, type: 'company' },
                    }),
                    `relink user ${targetId} to target company`
                  );
                  sse.log('success', `Relinked user ${targetId} → target company (via note ${noteId})`, { uuid: targetId });
                  relinkUserIds.add(targetId);
                  entry.usersRelinked++;
                  entry.userIds.push(targetId);
                  usersRelinked++;
                } else {
                  sse.log('info', `User ${targetId} already relinked — re-attributing note ${noteId} only`, { uuid: targetId });
                }

                // Step 2c: reattribute note back to the user so PB re-derives company from
                // the user's current (target) parent. The note-search index lags behind the
                // user-parent update, so the note can bounce back to source on the first PUT.
                // Verify after each attempt and retry until the note clears from the source
                // index. (Live testing 2026-05-15: resolves in 1–2 attempts consistently.)
                const MAX_REATTRIB_ATTEMPTS = 3;
                let reattribDone = false;
                for (let ra = 0; ra < MAX_REATTRIB_ATTEMPTS; ra++) {
                  if (ra > 0) {
                    await new Promise(r => setTimeout(r, 500));
                    sse.log('info', `Retrying note ${noteId} reattribution (attempt ${ra + 1}/${MAX_REATTRIB_ATTEMPTS})…`, { uuid: noteId });
                  }
                  await withRetry(
                    () => pbFetch('put', `/v2/notes/${noteId}/relationships/customer`, {
                      data: { target: { type: 'user', id: targetId } },
                    }),
                    `reattribute note ${noteId} to user (attempt ${ra + 1})`
                  );
                  // 1000ms: empirically the minimum for the note-search index to reflect
                  // the user-parent change. 600ms was too short (triggered retry on ~every note).
                  await new Promise(r => setTimeout(r, 1000));
                  const verifyR = await withRetry(
                    () => pbFetch('post', '/v2/notes/search', {
                      data: { filter: { relationships: { customer: [{ id: dupId }] } } },
                    }),
                    `verify note ${noteId} cleared from source`
                  );
                  const stillOnSource = (verifyR.data || []).some(n => n.id === noteId);
                  if (!stillOnSource) { reattribDone = true; break; }
                }
                if (reattribDone) {
                  sse.log('info', `Reattributed note ${noteId} → user ${targetId} under target company`, { uuid: noteId });
                } else {
                  sse.log('warn', `Note ${noteId} reattributed to user but still visible under source after ${MAX_REATTRIB_ATTEMPTS} attempts — may resolve with time`, { uuid: noteId });
                }
                entry.noteIds.push(noteId);
                entry.notesRelinked++;
                notesRelinked++;
              } else {
                await withRetry(
                  () => pbFetch('put', `/v2/notes/${noteId}/relationships/customer`, {
                    data: { target: { type: 'company', id: dr.primaryId } },
                  }),
                  `relink note ${noteId} to target company`
                );
                sse.log('success', `Relinked note ${noteId} → target company`, { uuid: noteId });
                entry.notesRelinked++;
                entry.noteIds.push(noteId);
                notesRelinked++;
              }
            } catch (relinkErr) {
              const msg = parseApiError(relinkErr);
              sse.log('error', `Relink failed — note ${noteId}: ${msg}`, { uuid: noteId });
              relinkFailed = true;
              errors++;
              entry.error = `relink failed: ${msg}`;
            }
          }

          // ── Step 3: Relink users parented to this duplicate ──────────────
          // Fetches via POST /v2/entities/search (filter by parent relationship).
          // Skips users already relinked in Step 2 to avoid double-counting.
          if (!shouldStop()) {
            const usersPayload = {
              data: {
                filter: {
                  type: ['user'],
                  relationships: { parent: [{ id: dupId }] },
                },
              },
            };

            let cursor = null;
            do {
              const url = cursor
                ? `/v2/entities/search?pageCursor=${encodeURIComponent(cursor)}`
                : '/v2/entities/search';
              const r = await withRetry(
                () => pbFetch('post', url, usersPayload),
                `search users for duplicate ${dupId}`
              );
              for (const user of (r.data || [])) {
                if (shouldStop()) break;
                if (relinkUserIds.has(user.id)) continue; // already handled via notes path
                try {
                  await withRetry(
                    () => pbFetch('put', `/v2/entities/${user.id}/relationships/parent`, {
                      data: { target: { id: dr.primaryId }, type: 'company' },
                    }),
                    `relink user ${user.id} to target company`
                  );
                  sse.log('success', `Relinked user ${user.id} → target company (direct parent)`, { uuid: user.id });
                  relinkUserIds.add(user.id);
                  entry.usersRelinked++;
                  entry.userIds.push(user.id);
                  usersRelinked++;
                } catch (relinkErr) {
                  const msg = parseApiError(relinkErr);
                  sse.log('error', `Relink failed — user ${user.id}: ${msg}`, { uuid: user.id });
                  relinkFailed = true;
                  errors++;
                  entry.error = `relink failed: ${msg}`;
                }
              }
              cursor = r.links?.next
                ? (r.links.next.match(/pageCursor=([^&]+)/)?.[1] ?? null)
                : null;
            } while (cursor && !shouldStop());
          }

          // ── Step 3.5: Relink the duplicate's own entity relationships ────
          // Covers link / isBlockedBy / isBlocking / parent / child to features,
          // components, initiatives, etc. Done LAST (after notes/users) because
          // relinking a note attached to a feature does NOT also relink that
          // feature → without this step the feature stays linked to the deleted
          // or archived duplicate, causing the UI discrepancy users see.
          //
          // In all modes:
          //   1. POST the same relationship on the target company (409 = already
          //      linked, treated as success).
          //   2. In keep/archive mode, DELETE the relationship from the duplicate
          //      so the leftover company doesn't show stale links. In delete
          //      mode the relationship is removed when the duplicate is deleted.
          if (!shouldStop() && !relinkFailed) {
            let entityRels = [];
            try {
              entityRels = await fetchCompanyEntityRelationships(pbFetch, withRetry, dupId);
            } catch (err) {
              const msg = parseApiError(err);
              sse.log('error', `Failed to list relationships for ${dupId}: ${msg}`, { uuid: dupId });
              relinkFailed = true;
              errors++;
              entry.error = `list relationships failed: ${msg}`;
            }

            for (const rel of entityRels) {
              if (shouldStop()) break;
              const { type: relType, targetId: relTargetId, targetType: relTargetType } = rel;

              // Step 3.5a: recreate the relationship on the target side.
              // Some pairs (e.g. company ↔ feature `link`) only accept POST from
              // one direction — POSTing on the other returns
              //   validation.failed "Relationship between X and Y in direction
              //   Nondirectional is not allowed."
              // Strategy: try POST on the target company first; on a directional
              // validation error, retry by POSTing on the OTHER entity side
              // (the feature/component/etc.) pointing at the target company.
              // POSTing an already-existing link returns 201 (idempotent), so we
              // don't need special 409 handling.
              let created = false;
              // pbClient packs the response body into err.message verbatim
              // (see src/lib/pbClient.js line 108), so we can grep for the
              // exact phrase Productboard returns.
              const isDirectionalErr = (err) => /direction\s+Nondirectional\s+is not allowed/i.test(String(err?.message || ''));

              try {
                await withRetry(
                  () => pbFetch('post', `/v2/entities/${dr.primaryId}/relationships`, {
                    data: { type: relType, target: { id: relTargetId } },
                  }),
                  `relink ${relType} ${relTargetId} on target`
                );
                created = true;
                sse.log('success', `Relinked ${relType} → ${relTargetType || 'entity'} ${relTargetId} (on target company)`, { uuid: relTargetId });
              } catch (relinkErr) {
                if (relinkErr?.status === 409) {
                  // Defensive: API currently returns 201 on duplicate, but treat 409 as already-linked.
                  created = true;
                  sse.log('info', `${relType} → ${relTargetId} already linked on target, skipping create`, { uuid: relTargetId });
                } else if (isDirectionalErr(relinkErr)) {
                  // Retry from the other entity's side.
                  try {
                    await withRetry(
                      () => pbFetch('post', `/v2/entities/${relTargetId}/relationships`, {
                        data: { type: relType, target: { id: dr.primaryId } },
                      }),
                      `relink ${relType} on ${relTargetType || 'entity'} side`
                    );
                    created = true;
                    sse.log('success', `Relinked ${relType} ← ${relTargetType || 'entity'} ${relTargetId} (on ${relTargetType || 'entity'} side; company side rejected as directional)`, { uuid: relTargetId });
                  } catch (retryErr) {
                    const msg = parseApiError(retryErr);
                    sse.log('error', `Relink failed (both directions) — ${relType} ${relTargetId}: ${msg}`, { uuid: relTargetId });
                    relinkFailed = true;
                    errors++;
                    entry.error = `entity relink failed: ${msg}`;
                  }
                } else {
                  const msg = parseApiError(relinkErr);
                  sse.log('error', `Relink failed — ${relType} ${relTargetId}: ${msg}`, { uuid: relTargetId });
                  relinkFailed = true;
                  errors++;
                  entry.error = `entity relink failed: ${msg}`;
                }
              }

              if (created) {
                entry.entitiesRelinked++;
                entry.entityRelinks.push({ type: relType, targetId: relTargetId, targetType: relTargetType || null });
                entitiesRelinked++;
              }

              // Step 3.5b: in keep/archive mode, remove the relationship from
              // the duplicate so the leftover company doesn't show stale links.
              if (created && keepDuplicates) {
                try {
                  await withRetry(
                    () => pbFetch('delete', `/v2/entities/${dupId}/relationships/${encodeURIComponent(relType)}/${encodeURIComponent(relTargetId)}`),
                    `unlink ${relType} ${relTargetId} from duplicate`
                  );
                  sse.log('info', `Removed ${relType} → ${relTargetId} from duplicate`, { uuid: relTargetId });
                } catch (unlinkErr) {
                  // 404 = relationship already gone — treat as success.
                  const status = unlinkErr?.status;
                  if (status === 404 || /404/.test(String(unlinkErr?.message || ''))) {
                    // already gone, no-op
                  } else {
                    const msg = parseApiError(unlinkErr);
                    sse.log('warn', `Could not remove ${relType} → ${relTargetId} from duplicate: ${msg}`, { uuid: relTargetId });
                    // Non-fatal: the link exists on target; this is just leftover cleanup.
                  }
                }
              }
            }
          }

          // ── Step 4: Finalize — delete duplicate, or keep (and optionally archive) ─
          // Only runs when every relink for this duplicate succeeded.
          //
          // NOTE: As of 2026-05, the Productboard UI does not expose a way to archive
          // companies, but the v2 API accepts `{ op: 'set', path: 'archived', value: true }`
          // on companies (the `archived` field is a standard v2 entity field, the same
          // path used for notes and users). If a future API change removes or alters
          // this behavior for companies, this PATCH will start failing — that's the
          // signal to revisit this code path.
          if (relinkFailed) {
            sse.log('warn', `Skipping DELETE for ${dupId} — one or more relinks failed`, { uuid: dupId });
          } else if (keepDuplicates) {
            entry.kept = true;
            kept++;
            if (shouldArchive) {
              await withRetry(
                () => pbFetch('patch', `/v2/entities/${dupId}`, {
                  data: { patch: [{ op: 'set', path: 'archived', value: true }] },
                }),
                `archive duplicate ${dupId}`
              );
              entry.archived = true;
              archived++;
              sse.log('success', `Archived duplicate ${dupId} (${dr.matchName || dr.domain || 'no domain'})`, { uuid: dupId });
            } else {
              sse.log('info', `Kept duplicate ${dupId} (${dr.matchName || dr.domain || 'no domain'}) — relinks done, delete skipped`, { uuid: dupId });
            }
          } else {
            await withRetry(
              () => pbFetch('delete', `/v2/entities/${dupId}`),
              `delete company ${dupId}`
            );
            sse.log('success', `Deleted duplicate company ${dupId} (${dr.matchName || dr.domain || 'no domain'})`, { uuid: dupId });
            entry.deleted = true;
            deleted++;
          }

        } catch (err) {
          const msg = parseApiError(err);
          sse.log('error', `Error processing duplicate ${dupId} (${dr.matchName || dr.domain || 'no domain'}): ${msg}`, { uuid: dupId });
          entry.error = msg;
          errors++;
        }

        actionLog.push(entry);
        processed++;
      }
    }

    const stopped = shouldStop();
    sse.progress(stopped ? 'Stopped.' : 'Merge complete.', 100);
    sse.complete({ notesRelinked, usersRelinked, entitiesRelinked, deleted, kept, archived, errors, stopped, actionLog });

  } catch (err) {
    console.error('[companiesDuplicateCleanup/run]', err);
    sse.error(parseApiError(err));
  } finally {
    _stopRequests.delete(token);
    sse.done();
  }
});

module.exports = router;
