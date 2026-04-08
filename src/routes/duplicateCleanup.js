/**
 * Duplicate Company Cleanup routes
 *
 * POST /api/duplicate-cleanup/preview  — parse uploaded CSV, return domain records + skipped rows (no API calls)
 * POST /api/duplicate-cleanup/run      — relink notes from duplicate companies to their Salesforce
 *                                        equivalent, then delete the duplicates (SSE)
 *
 * Input CSV columns:
 *   domain           — company domain (e.g. "acme.com")
 *   uuid_with_origin — all UUIDs for that domain, each tagged with source in parens:
 *                      e.g. "66c80e99-... (manual_or_csv), df3a7053-... (salesforce)"
 *
 * Processing rules (mirrors pb_duplicate_cleanup.py):
 *   Exactly 1 (salesforce) UUID → processed
 *   0 (salesforce) UUIDs        → row skipped
 *   2+ (salesforce) UUIDs       → row skipped
 *
 * For each non-Salesforce company UUID in a processed row:
 *   1. POST /v2/notes/search  — find all notes linked to the duplicate company
 *   2. For each note, relink its customer relationship to the SF company:
 *        user customer   → PUT /v2/entities/{user_id}/relationships/parent
 *        company/missing → PUT /v2/notes/{note_id}/relationships/customer
 *   3. DELETE /companies/{dup_id}  — only if every relink for that company succeeded
 *
 * dry-run mode (default): steps 1–3 are logged but no mutating calls are made.
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
  const { domainRecords = [], dryRun = true } = req.body || {};

  let relinked = 0, deleted = 0, errors = 0;
  const actionLog = [];

  const total = domainRecords.reduce((n, r) => n + r.duplicateIds.length, 0);
  let processed = 0;

  try {
    sse.progress(
      `Starting cleanup of ${domainRecords.length} domain(s)${dryRun ? ' [dry run]' : ''}…`, 0
    );

    for (const dr of domainRecords) {
      if (sse.isAborted()) break;

      for (const dupId of dr.duplicateIds) {
        if (sse.isAborted()) break;

        const pct = total > 0 ? Math.round((processed / total) * 90) : 0;
        sse.progress(
          `[${processed + 1}/${total}] ${dr.domain} — duplicate ${dupId.slice(0, 8)}…`, pct
        );

        const entry = {
          domain:            dr.domain,
          duplicateCompanyId: dupId,
          sfCompanyId:       dr.sfCompanyId,
          notesFound:        0,
          relinked:          0,
          deleted:           false,
          error:             null,
        };

        try {
          // ── Step 1: Find all notes linked to this duplicate company ──────
          const notes = [];

          if (dryRun) {
            sse.log('info', `[DRY RUN] Would search notes for duplicate company ${dupId.slice(0, 8)}…`);
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

          // ── Step 2: Relink each note's customer to the SF company ────────
          let relinkFailed = false;

          for (const note of notes) {
            if (sse.isAborted()) break;

            const noteId = note.id || '';
            const { targetId, targetType } = resolveTarget(note);

            try {
              if (targetType === 'user') {
                // Note's customer is a user — set the SF company as that user's parent company
                await withRetry(
                  () => pbFetch('put', `/v2/entities/${targetId}/relationships/parent`, {
                    data: { target: { id: dr.sfCompanyId }, type: 'company' },
                  }),
                  `relink user ${targetId} to SF company`
                );
                sse.log('success', `Relinked user ${targetId} → SF company (via note ${noteId.slice(0, 8)})`);
              } else {
                // Note's customer is a company (or absent) — relink the note directly
                await withRetry(
                  () => pbFetch('put', `/v2/notes/${noteId}/relationships/customer`, {
                    data: { target: { type: 'company', id: dr.sfCompanyId } },
                  }),
                  `relink note ${noteId} to SF company`
                );
                sse.log('success', `Relinked note ${noteId.slice(0, 8)} → SF company`);
              }
              entry.relinked++;
              relinked++;
            } catch (relinkErr) {
              const msg = parseApiError(relinkErr);
              sse.log('error', `Relink failed — note ${noteId.slice(0, 8)}: ${msg}`);
              relinkFailed = true;
              errors++;
              entry.error = `relink failed: ${msg}`;
            }
          }

          // ── Step 3: Delete duplicate only if every relink succeeded ──────
          if (relinkFailed) {
            sse.log('warn', `Skipping DELETE for ${dupId.slice(0, 8)} — one or more relinks failed`);
          } else if (dryRun) {
            sse.log('info', `[DRY RUN] Would delete company ${dupId.slice(0, 8)} (${dr.domain})`);
          } else {
            await withRetry(
              () => pbFetch('delete', `/companies/${dupId}`),
              `delete company ${dupId}`
            );
            sse.log('success', `Deleted duplicate company ${dupId.slice(0, 8)} (${dr.domain})`);
            entry.deleted = true;
            deleted++;
          }

        } catch (err) {
          const msg = parseApiError(err);
          sse.log('error', `Error processing duplicate ${dupId.slice(0, 8)} (${dr.domain}): ${msg}`);
          entry.error = msg;
          errors++;
        }

        actionLog.push(entry);
        processed++;
      }
    }

    const stopped = sse.isAborted();
    sse.progress(
      stopped ? 'Stopped.' : dryRun ? 'Dry run complete.' : 'Cleanup complete.', 100
    );
    sse.complete({ relinked, deleted, errors, stopped, dryRun, actionLog });

  } catch (err) {
    console.error('[duplicateCleanup/run]', err);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

module.exports = router;
