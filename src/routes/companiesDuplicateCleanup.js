/**
 * Duplicate Company Cleanup routes
 *
 * GET  /api/companies-duplicate-cleanup/origins  — return distinct source origin values
 * POST /api/companies-duplicate-cleanup/scan     — discover duplicate groups via API (SSE)
 * POST /api/companies-duplicate-cleanup/run      — merge duplicates into their target company (SSE)
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
 * dry-run mode: steps 1–4 are logged but no mutating calls are made.
 */

const express = require('express');
const { pbAuth } = require('../middleware/pbAuth');
const { startSSE } = require('../lib/sse');
const { parseCSV } = require('../lib/csvUtils');
const { parseApiError } = require('../lib/errorUtils');

const router = express.Router();

// UUID regex — reset lastIndex before each use (global flag)
const SF_UUID_RE  = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*\(salesforce\)/gi;
const ANY_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;

// ---------------------------------------------------------------------------
// Origins cache (per-token, 30-minute TTL — mirrors teamCache pattern)
// ---------------------------------------------------------------------------

const ORIGINS_CACHE_TTL_MS = 30 * 60 * 1000;
const originsCache = new Map();

function getCachedOrigins(token) {
  const entry = originsCache.get(token);
  if (!entry || Date.now() - entry.fetchedAt > ORIGINS_CACHE_TTL_MS) return null;
  return entry.origins;
}

function setCachedOrigins(token, origins) {
  originsCache.set(token, { origins, fetchedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// GET /origins — return distinct non-null sourceOrigin values across v2 + v1
// ---------------------------------------------------------------------------

router.get('/origins', pbAuth, async (req, res) => {
  const token = req.session?.pbToken || req.headers['x-pb-token'];
  const forceRefresh = req.query.refresh === 'true';

  if (!forceRefresh) {
    const cached = getCachedOrigins(token);
    if (cached) return res.json({ origins: cached });
  }

  const { pbFetch, withRetry } = res.locals.pbClient;
  try {
    const originsSet = new Set();

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
      }
      const next = r.links?.next || null;
      cursor = next ? (next.match(/[?&]pageCursor=([^&]+)/)?.[1] ?? null) : null;
    } while (cursor);

    // v1 fallback: sourceOrigin (covers companies not yet migrated to v2 source)
    let offset = 0;
    const PAGE = 100;
    while (true) {
      const r = await withRetry(
        () => pbFetch('get', `/companies?pageLimit=${PAGE}&pageOffset=${offset}`),
        `fetch v1 companies for origins offset=${offset}`
      );
      const batch = r.data || [];
      for (const c of batch) {
        if (c.sourceOrigin) originsSet.add(c.sourceOrigin);
      }
      if (batch.length < PAGE) break;
      offset += PAGE;
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
// Body: { primaryOrigin?: string, manualMode?: boolean }
//
// Origin mode (default):
//   Group companies by domain. For each group with 2+ companies, exactly one
//   company matching primaryOrigin (default 'salesforce') becomes the target;
//   all others become duplicates. Groups with 0 or 2+ matching the origin are skipped.
//
// Manual mode:
//   All domains with 2+ companies are returned. Default target = first non-null
//   origin company (preferring 'salesforce'); if all are null, first in list.
//   The frontend allows the user to swap the target.
//
// Source origin strategy (v2-first, v1-fallback):
//   1. Fetch all companies from v2 entities → domain + id + metadata.source.system
//   2. If any company has metadata.source.system = null, fetch v1 /companies for those
//      ids only and back-fill sourceOrigin from v1 (covers the legacy metadata migration gap)
// ---------------------------------------------------------------------------

router.post('/scan', pbAuth, async (req, res) => {
  const sse = startSSE(res);
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { primaryOrigin = 'salesforce', manualMode = false } = req.body || {};

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
      const next = r.links?.next || null;
      cursor = next ? (next.match(/[?&]pageCursor=([^&]+)/)?.[1] ?? null) : null;
    } while (cursor);

    sse.log('info', `Fetched ${v2Companies.length} compan${v2Companies.length === 1 ? 'y' : 'ies'} from v2 API`);
    if (sse.isAborted()) { sse.complete({ domainRecords: [], skippedRows: [], totalDomains: 0, totalDuplicates: 0, stopped: true }); return; }

    // Build initial source map from v2 metadata.source.system
    // id → sourceOrigin (string | null)
    const sourceMap = {};
    for (const c of v2Companies) {
      sourceMap[c.id] = c.metadata?.source?.system || null;
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

    const byDomain = {};  // domain → [{ id, name, sourceOrigin }]
    for (const c of v2Companies) {
      const domain = (c.fields?.domain || '').trim().toLowerCase();
      if (!domain) continue;
      if (!byDomain[domain]) byDomain[domain] = [];
      byDomain[domain].push({ id: c.id, name: nameMap[c.id] || null, sourceOrigin: sourceMap[c.id] || null });
    }

    // ── Step 4: Build domain records ──────────────────────────────────────
    const domainRecords = [];
    const skippedRows   = [];

    for (const [domain, companies] of Object.entries(byDomain)) {
      if (companies.length < 2) continue;

      if (manualMode) {
        // Manual mode: all duplicate domains included; default target = best available
        const sorted = [...companies].sort((a, b) => {
          // Non-null origin before null
          if (a.sourceOrigin && !b.sourceOrigin) return -1;
          if (!a.sourceOrigin && b.sourceOrigin) return 1;
          // Prefer salesforce among non-null
          if (a.sourceOrigin === 'salesforce') return -1;
          if (b.sourceOrigin === 'salesforce') return 1;
          return 0;
        });
        const target = sorted[0];
        domainRecords.push({
          domain,
          sfCompanyId:     target.id,
          sfCompanyName:   target.name || target.id,
          sfCompanyOrigin: target.sourceOrigin,
          duplicates:      sorted.slice(1).map(c => ({ id: c.id, name: c.name || c.id, sourceOrigin: c.sourceOrigin })),
          isManualMode:    true,
        });
      } else {
        // Origin mode: exactly 1 company must match primaryOrigin
        const primary = companies.filter(c => c.sourceOrigin === primaryOrigin);
        const others  = companies.filter(c => c.sourceOrigin !== primaryOrigin);

        if (primary.length === 1) {
          domainRecords.push({
            domain,
            sfCompanyId:     primary[0].id,
            sfCompanyName:   primary[0].name || primary[0].id,
            sfCompanyOrigin: primary[0].sourceOrigin,
            duplicates:      others.map(c => ({ id: c.id, name: c.name || c.id, sourceOrigin: c.sourceOrigin })),
            isManualMode:    false,
          });
        } else if (primary.length === 0) {
          const raw = companies.map(c => `${c.id} (${c.sourceOrigin || 'unknown'})`).join(', ');
          skippedRows.push({ domain, uuidWithOrigin: raw, reason: 'no_primary_origin', primaryOrigin });
        } else {
          const primaryIds = primary.map(c => c.id);
          const raw        = companies.map(c => `${c.id} (${c.sourceOrigin || 'unknown'})`).join(', ');
          skippedRows.push({ domain, uuidWithOrigin: raw, reason: 'multiple_primary_origin', primaryOrigin, sfUuids: primaryIds });
        }
      }
    }

    const totalDuplicates = domainRecords.reduce((n, r) => n + r.duplicates.length, 0);

    sse.log('info', `Found ${domainRecords.length} domain(s) with duplicates · ${skippedRows.length} skipped`);

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
        const id = isTarget ? dr.sfCompanyId : obj.id;
        const pct = 80 + Math.round((i / companiesToCount.length) * 18);
        sse.progress(`Counting notes for ${dr.domain} (${i + 1}/${companiesToCount.length})…`, pct);
        try {
          const counts = await fetchNoteCounts(pbFetch, withRetry, id);
          if (isTarget) {
            dr.sfNotesCount = counts.notesCount;
            dr.sfUsersCount = counts.usersCount;
          } else {
            obj.notesCount = counts.notesCount;
            obj.usersCount = counts.usersCount;
          }
        } catch {
          if (isTarget) { dr.sfNotesCount = null; dr.sfUsersCount = null; }
          else          { obj.notesCount  = null; obj.usersCount  = null; }
        }
      }
    }

    sse.progress('Scan complete.', 100);
    sse.complete({ domainRecords, skippedRows, totalDomains: domainRecords.length, totalDuplicates });

  } catch (err) {
    console.error('[companiesDuplicateCleanup/scan]', err);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// Note + user count helper (used by /scan)
// ---------------------------------------------------------------------------

/**
 * For a single company, fetch and return:
 *   notesCount — notes whose customer is the company directly (will be relinked)
 *   usersCount — ALL users that will have their parent company updated:
 *                users found via the notes search (customer = user) UNION
 *                users parented to this company via /v2/entities/search
 *                (covers users with no notes attributed through this company)
 */
async function fetchNoteCounts(pbFetch, withRetry, companyId) {
  // ── Query 1: notes linked to this company ───────────────────────────────
  const notesPayload = { data: { relationships: { customer: { ids: [companyId] } } } };
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
    cursor = ur.links?.next
      ? (ur.links.next.match(/pageCursor=([^&]+)/)?.[1] ?? null)
      : null;
  } while (cursor);

  return { notesCount, usersCount: allUserIds.size };
}

// ---------------------------------------------------------------------------
// CSV parser
// ---------------------------------------------------------------------------

/**
 * Parse the companies CSV.
 * Returns { domainRecords, skippedRows }.
 * Rows with 0 or 2+ Salesforce UUIDs land in skippedRows.
 */
function parseDuplicatesCsv(csvText) {
  const { rows, errors } = parseCSV(csvText);
  if (errors.length) throw new Error(`CSV parse error: ${errors[0]}`);
  if (!rows.length)  throw new Error('CSV is empty or has no data rows.');

  // Column lookup — case-insensitive
  const firstRow = rows[0];
  const colMap   = Object.keys(firstRow).reduce((m, k) => { m[k.toLowerCase()] = k; return m; }, {});
  if (!colMap['domain'] || !colMap['uuid_with_origin']) {
    throw new Error(
      `CSV must have 'domain' and 'uuid_with_origin' columns. Found: ${Object.keys(firstRow).join(', ')}`
    );
  }
  const domainCol = colMap['domain'];
  const uuidCol   = colMap['uuid_with_origin'];

  const domainRecords = [];
  const skippedRows   = [];

  for (const row of rows) {
    const domain = (row[domainCol] || '').trim().toLowerCase();
    const raw    = (row[uuidCol]   || '').trim();
    if (!domain) continue;

    SF_UUID_RE.lastIndex  = 0;
    ANY_UUID_RE.lastIndex = 0;

    const sfUuids  = [...raw.matchAll(SF_UUID_RE)].map(m => m[1].toLowerCase());
    const allUuids = [...raw.matchAll(ANY_UUID_RE)].map(m => m[1].toLowerCase());
    const sfSet    = new Set(sfUuids);
    const dups     = allUuids.filter(u => !sfSet.has(u));

    if (sfUuids.length === 1) {
      domainRecords.push({ domain, sfCompanyId: sfUuids[0], duplicateIds: dups });
    } else if (sfUuids.length === 0) {
      skippedRows.push({ domain, uuidWithOrigin: raw, reason: 'no_salesforce_uuid' });
    } else {
      skippedRows.push({ domain, uuidWithOrigin: raw, reason: 'multiple_salesforce_uuids', sfUuids });
    }
  }

  return { domainRecords, skippedRows };
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
// POST /preview
// ---------------------------------------------------------------------------

router.post('/preview', pbAuth, (req, res) => {
  try {
    const { csvText } = req.body;
    if (!csvText) return res.status(400).json({ error: 'csvText is required.' });

    const { domainRecords, skippedRows } = parseDuplicatesCsv(csvText);
    const totalDuplicates = domainRecords.reduce((n, r) => n + r.duplicateIds.length, 0);

    res.json({
      domainRecords,
      skippedRows,
      totalDomains:    domainRecords.length,
      totalDuplicates,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /run  (SSE)
// ---------------------------------------------------------------------------

router.post('/run', pbAuth, async (req, res) => {
  const sse = startSSE(res);
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { domainRecords = [], dryRun = false } = req.body || {};

  let notesRelinked = 0, usersRelinked = 0, deleted = 0, errors = 0;
  const actionLog = [];

  // Accept both new { duplicates: [{id}] } and legacy { duplicateIds: [string] } formats
  const getDupIds = (dr) => dr.duplicates?.map(d => d.id) ?? dr.duplicateIds ?? [];
  const total = domainRecords.reduce((n, r) => n + getDupIds(r).length, 0);
  let processed = 0;

  try {
    sse.progress(
      `Starting merge of ${domainRecords.length} domain(s)${dryRun ? ' [dry run]' : ''}…`, 0
    );

    for (const dr of domainRecords) {
      if (sse.isAborted()) break;

      for (const dupId of getDupIds(dr)) {
        if (sse.isAborted()) break;

        const pct = total > 0 ? Math.round((processed / total) * 90) : 0;
        sse.progress(
          `[${processed + 1}/${total}] ${dr.domain} — duplicate ${dupId.slice(0, 8)}…`, pct
        );

        const entry = {
          domain:             dr.domain,
          duplicateCompanyId: dupId,
          sfCompanyId:        dr.sfCompanyId,
          notesFound:         0,
          notesRelinked:      0,
          usersRelinked:      0,
          noteIds:            [],
          userIds:            [],
          deleted:            false,
          error:              null,
        };

        try {
          let relinkFailed = false;

          // ── Step 1: Find and relink all notes linked to this duplicate ───
          const notes = [];

          if (dryRun) {
            sse.log('info', `[DRY RUN] Would search notes for duplicate company ${dupId}…`, { uuid: dupId });
          } else {
            const payload = { data: { relationships: { customer: { ids: [dupId] } } } };
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
          }

          entry.notesFound = notes.length;

          // ── Step 2: Relink each note's customer to the target company ────
          // Users touched here are tracked so Step 3 can skip them.
          const relinkUserIds = new Set();

          for (const note of notes) {
            if (sse.isAborted()) break;

            const noteId = note.id || '';
            const { targetId, targetType } = resolveTarget(note);

            try {
              if (targetType === 'user') {
                if (!dryRun) {
                  await withRetry(
                    () => pbFetch('put', `/v2/entities/${targetId}/relationships/parent`, {
                      data: { target: { id: dr.sfCompanyId }, type: 'company' },
                    }),
                    `relink user ${targetId} to target company`
                  );
                }
                sse.log('success', `Relinked user ${targetId} → target company (via note ${noteId})${dryRun ? ' [DRY RUN]' : ''}`, { uuid: targetId });
                relinkUserIds.add(targetId);
                entry.usersRelinked++;
                entry.userIds.push(targetId);
                usersRelinked++;
              } else {
                if (!dryRun) {
                  await withRetry(
                    () => pbFetch('put', `/v2/notes/${noteId}/relationships/customer`, {
                      data: { target: { type: 'company', id: dr.sfCompanyId } },
                    }),
                    `relink note ${noteId} to target company`
                  );
                }
                sse.log('success', `Relinked note ${noteId} → target company${dryRun ? ' [DRY RUN]' : ''}`, { uuid: noteId });
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
          if (!sse.isAborted()) {
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
                if (sse.isAborted()) break;
                if (relinkUserIds.has(user.id)) continue; // already handled via notes path
                try {
                  if (!dryRun) {
                    await withRetry(
                      () => pbFetch('put', `/v2/entities/${user.id}/relationships/parent`, {
                        data: { target: { id: dr.sfCompanyId }, type: 'company' },
                      }),
                      `relink user ${user.id} to target company`
                    );
                  }
                  sse.log('success', `Relinked user ${user.id} → target company (direct parent)${dryRun ? ' [DRY RUN]' : ''}`, { uuid: user.id });
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
            } while (cursor && !sse.isAborted());
          }

          // ── Step 4: Delete duplicate (v2) — only if all relinks succeeded ─
          if (relinkFailed) {
            sse.log('warn', `Skipping DELETE for ${dupId} — one or more relinks failed`, { uuid: dupId });
          } else if (dryRun) {
            sse.log('info', `[DRY RUN] Would delete company ${dupId} (${dr.domain})`, { uuid: dupId });
          } else {
            await withRetry(
              () => pbFetch('delete', `/v2/entities/${dupId}`),
              `delete company ${dupId}`
            );
            sse.log('success', `Deleted duplicate company ${dupId} (${dr.domain})`, { uuid: dupId });
            entry.deleted = true;
            deleted++;
          }

        } catch (err) {
          const msg = parseApiError(err);
          sse.log('error', `Error processing duplicate ${dupId} (${dr.domain}): ${msg}`, { uuid: dupId });
          entry.error = msg;
          errors++;
        }

        actionLog.push(entry);
        processed++;
      }
    }

    const stopped = sse.isAborted();
    sse.progress(stopped ? 'Stopped.' : 'Merge complete.', 100);
    sse.complete({ notesRelinked, usersRelinked, deleted, errors, stopped, dryRun, actionLog });

  } catch (err) {
    console.error('[companiesDuplicateCleanup/run]', err);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

module.exports = router;
