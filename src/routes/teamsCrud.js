/**
 * Teams CRUD module
 *
 * GET  /api/teams-crud/export        — direct CSV download of all teams
 * POST /api/teams-crud/preview       — parse CSV + mapping → diff JSON (no writes)
 * POST /api/teams-crud/import        — SSE: upsert (create + patch)
 * POST /api/teams-crud/delete/by-csv — SSE: delete teams identified by UUID and/or handle
 * POST /api/teams-crud/delete/all    — SSE: delete every team in workspace
 *
 * Headers: x-pb-token (required), x-pb-eu (optional)
 */

'use strict';

const express = require('express');
const { listTeams } = require('../lib/pbClient');
const { parseCSV, generateCSV, cell } = require('../lib/csvUtils');
const { startSSE } = require('../lib/sse');
const { pbAuth } = require('../middleware/pbAuth');
const { parseApiError } = require('../lib/errorUtils');
const { UUID_RE } = require('../lib/constants');

const router = express.Router();

const HANDLE_RE = /^[a-z0-9]+$/;
const EXPORT_COLUMNS = ['id', 'name', 'handle', 'description', 'createdAt', 'avatarUrl'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeTeams(rawTeams) {
  return rawTeams.map((t) => ({
    id:          t.id,
    name:        t.fields?.name        ?? '',
    handle:      t.fields?.handle      ?? '',
    description: t.fields?.description ?? '',
    createdAt:   t.createdAt           ?? '',
    avatarUrl:   t.fields?.avatarUrl   ?? '',
  }));
}

function buildTeamMaps(teams) {
  const byId     = new Map(teams.map((t) => [t.id, t]));
  const byHandle = new Map(teams.map((t) => [t.handle.toLowerCase(), t]));
  return { byId, byHandle };
}

function sanitizeHandle(raw) {
  const clean = (raw ?? '').toString().toLowerCase().replace(/[^a-z0-9]/g, '');
  return { handle: clean, sanitized: clean !== (raw ?? '').toString() };
}

/**
 * Parse a teams import CSV against current team state.
 * @param {string} csvText
 * @param {{ idCol, nameCol, handleCol, descCol }} mapping — each is a column header string or null
 * @param {object[]} teams — normalised team objects
 * @returns {{ hardErrors, warnings, toCreate, toUpdate, unchanged }}
 */
function parseImportCSV(csvText, mapping, teams) {
  const { headers, rows, errors: parseErrors } = parseCSV(csvText);

  if (parseErrors && parseErrors.length > 0) {
    return { hardErrors: [`Malformed CSV: ${parseErrors[0]}`], warnings: [], toCreate: [], toUpdate: [], unchanged: [] };
  }
  if (!headers || headers.length === 0) {
    return { hardErrors: ['CSV has no headers.'], warnings: [], toCreate: [], toUpdate: [], unchanged: [] };
  }
  if (!mapping.idCol && !mapping.nameCol && !mapping.handleCol) {
    return { hardErrors: ['At least one of "id", "name", or "handle" must be mapped.'], warnings: [], toCreate: [], toUpdate: [], unchanged: [] };
  }

  const { byId, byHandle } = buildTeamMaps(teams);
  const hardErrors = [];
  const warnings   = [];
  const toCreate   = [];
  const toUpdate   = [];
  const unchanged  = [];

  for (let i = 0; i < rows.length; i++) {
    const row      = rows[i];
    const rowNum   = i + 2; // 1-indexed + header row

    const rawId     = mapping.idCol     ? cell(row, mapping.idCol).trim()     : '';
    const rawName   = mapping.nameCol   ? cell(row, mapping.nameCol).trim()   : '';
    const rawHandle = mapping.handleCol ? cell(row, mapping.handleCol).trim() : '';
    const rawDesc   = mapping.descCol   ? cell(row, mapping.descCol)          : undefined;

    // Skip completely empty rows
    if (!rawId && !rawName && !rawHandle) continue;

    // Handle sanitization
    let finalHandle = rawHandle;
    if (rawHandle) {
      const { handle, sanitized } = sanitizeHandle(rawHandle);
      if (sanitized) {
        if (!handle) {
          hardErrors.push(`Row ${rowNum}: handle '${rawHandle}' produces empty handle after sanitization.`);
          continue;
        }
        warnings.push(`Row ${rowNum}: handle sanitized from '${rawHandle}' to '${handle}'.`);
      }
      finalHandle = handle;
    }

    // Classify row
    const hasValidId = rawId && UUID_RE.test(rawId);

    if (hasValidId) {
      const existing = byId.get(rawId);
      if (!existing) {
        hardErrors.push(`Row ${rowNum}: UUID ${rawId} not found in workspace.`);
        continue;
      }
      // Compute changed fields
      const changes = {};
      if (rawName && rawName !== existing.name)           changes.name        = rawName;
      if (finalHandle && finalHandle !== existing.handle) changes.handle      = finalHandle;
      if (rawDesc !== undefined && rawDesc !== existing.description) changes.description = rawDesc;

      if (Object.keys(changes).length === 0) {
        unchanged.push({ id: existing.id, name: existing.name, handle: existing.handle });
      } else {
        toUpdate.push({
          id:          existing.id,
          matchedBy:   'id',
          currentName: existing.name,
          changes,
          rowIndex:    i,
          ...changes,
        });
      }

    } else if (finalHandle) {
      const existing = byHandle.get(finalHandle.toLowerCase());
      if (existing) {
        // PATCH_BY_HANDLE
        const changes = {};
        if (rawName && rawName !== existing.name)                       changes.name        = rawName;
        if (rawDesc !== undefined && rawDesc !== existing.description)  changes.description = rawDesc;
        // handle itself won't change (we matched by it)

        if (Object.keys(changes).length === 0) {
          unchanged.push({ id: existing.id, name: existing.name, handle: existing.handle });
        } else {
          toUpdate.push({
            id:          existing.id,
            matchedBy:   'handle',
            currentName: existing.name,
            changes,
            rowIndex:    i,
            ...changes,
          });
        }
      } else {
        // CREATE
        if (!rawName) {
          hardErrors.push(`Row ${rowNum}: cannot create team — 'name' is required for new teams.`);
          continue;
        }
        toCreate.push({
          name:        rawName,
          handle:      finalHandle,
          description: rawDesc ?? '',
          rowIndex:    i,
        });
      }

    } else {
      hardErrors.push(`Row ${rowNum}: no id or handle — cannot import.`);
    }
  }

  return { hardErrors, warnings, toCreate, toUpdate, unchanged };
}

// ---------------------------------------------------------------------------
// GET /api/teams-crud/export
// ---------------------------------------------------------------------------

router.get('/export', pbAuth, async (req, res) => {
  const { pbClient } = res.locals;
  try {
    const raw   = await listTeams(pbClient);
    const teams = normalizeTeams(raw).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );

    const csvString = generateCSV(teams, EXPORT_COLUMNS, EXPORT_COLUMNS);
    const today     = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Disposition', `attachment; filename="pb-teams_${today}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(csvString);
  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    console.error('[teams-crud] export error:', err.message);
    res.status(500).json({ error: err.message || 'Export failed.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/teams-crud/preview
// ---------------------------------------------------------------------------

router.post('/preview', pbAuth, async (req, res) => {
  const { csvText, mapping } = req.body || {};

  if (!csvText)  return res.status(400).json({ error: 'csvText is required.' });
  if (!mapping)  return res.status(400).json({ error: 'mapping is required.' });

  const { pbClient } = res.locals;
  try {
    const raw   = await listTeams(pbClient);
    const teams = normalizeTeams(raw);
    const { hardErrors, warnings, toCreate, toUpdate, unchanged } = parseImportCSV(csvText, mapping, teams);

    if (hardErrors.length > 0) {
      return res.json({ hardErrors, warnings, diff: null });
    }

    return res.json({
      hardErrors: [],
      warnings,
      diff: {
        toCreate:  toCreate.map(({ name, handle, description, rowIndex }) => ({ name, handle, description, rowIndex })),
        toUpdate:  toUpdate.map(({ id, matchedBy, currentName, changes, rowIndex }) => ({ id, matchedBy, currentName, changes, rowIndex })),
        unchanged: unchanged.map(({ id, name, handle }) => ({ id, name, handle })),
      },
    });
  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    console.error('[teams-crud] preview error:', err.message);
    res.status(500).json({ error: err.message || 'Preview failed.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/teams-crud/import  (SSE)
// ---------------------------------------------------------------------------

router.post('/import', pbAuth, async (req, res) => {
  const { csvText, mapping } = req.body || {};
  const sse = startSSE(res);

  try {
    if (!csvText || !mapping) {
      sse.error('csvText and mapping are required.');
      return;
    }

    sse.progress('Fetching current teams…', 5);
    const { pbClient } = res.locals;
    const raw   = await listTeams(pbClient);
    const teams = normalizeTeams(raw);

    if (sse.isAborted()) return;

    const { hardErrors, warnings, toCreate, toUpdate, unchanged } = parseImportCSV(csvText, mapping, teams);

    if (hardErrors.length > 0) {
      sse.error(hardErrors[0]);
      return;
    }

    for (const w of warnings) {
      sse.log('warn', w);
    }

    const totalOps = toCreate.length + toUpdate.length;

    if (totalOps === 0) {
      sse.progress('No changes.', 100);
      sse.complete({ created: 0, updated: 0, unchanged: unchanged.length, errors: 0 });
      return;
    }

    let created = 0, updated = 0, errors = 0, doneOps = 0;

    // Process creates
    for (const t of toCreate) {
      if (sse.isAborted()) break;
      const rowNum = t.rowIndex + 2;
      try {
        const result = await pbClient.withRetry(
          () => pbClient.pbFetch('post', '/v2/teams', {
            data: { type: 'team', fields: { name: t.name, handle: t.handle, description: t.description } },
          }),
          `create team ${t.handle}`
        );
        created++;
        const newId = result?.data?.id;
        sse.log('success', `Created: ${t.name} [${t.handle}]`, { uuid: newId, row: rowNum });
      } catch (err) {
        if (err.status === 409) {
          sse.log('warn', `Handle '${t.handle}' already exists — skipped`, { row: rowNum });
        } else {
          errors++;
          sse.log('error', `Failed to create ${t.name}: ${parseApiError(err)}`, { row: rowNum });
        }
      }
      doneOps++;
      sse.progress(`${doneOps}/${totalOps}`, Math.round(5 + (doneOps / totalOps) * 90));
    }

    // Process updates
    for (const t of toUpdate) {
      if (sse.isAborted()) break;
      const rowNum = t.rowIndex + 2;
      try {
        await pbClient.withRetry(
          () => pbClient.pbFetch('patch', `/v2/teams/${t.id}`, {
            data: { fields: { ...t.changes } },
          }),
          `patch team ${t.id}`
        );
        updated++;
        sse.log('success', `Updated: ${t.currentName}${t.changes.name ? ` → ${t.changes.name}` : ''}`, { uuid: t.id, row: rowNum });
      } catch (err) {
        if (err.status === 404) {
          sse.log('warn', `Team ${t.id} not found — skipped`, { uuid: t.id, row: rowNum });
        } else {
          errors++;
          sse.log('error', `Failed to update ${t.currentName}: ${parseApiError(err)}`, { uuid: t.id, row: rowNum });
        }
      }
      doneOps++;
      sse.progress(`${doneOps}/${totalOps}`, Math.round(5 + (doneOps / totalOps) * 90));
    }

    sse.progress('Done!', 100);
    sse.complete({ created, updated, unchanged: unchanged.length, errors });

  } catch (err) {
    console.error('[teams-crud] import error:', err.message);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// POST /api/teams-crud/delete/preview
// ---------------------------------------------------------------------------

router.post('/delete/preview', pbAuth, async (req, res) => {
  const { csvText, idCol, handleCol, fallbackToHandle } = req.body || {};

  if (!csvText) return res.status(400).json({ error: 'csvText is required.' });

  const { pbClient } = res.locals;
  try {
    const raw   = await listTeams(pbClient);
    const teams = normalizeTeams(raw);
    const { byId, byHandle } = buildTeamMaps(teams);

    const { rows, errors: parseErrors } = parseCSV(csvText);

    if (parseErrors && parseErrors.length > 0) {
      return res.status(400).json({ error: `Malformed CSV: ${parseErrors[0]}` });
    }
    if (!rows || rows.length === 0) {
      return res.json({ toDelete: [], notFound: [] });
    }

    const toDelete = [];
    const notFound = [];
    const seenIds  = new Set(); // deduplicate rows that resolve to the same team

    for (let i = 0; i < rows.length; i++) {
      const row       = rows[i];
      const idVal     = idCol     ? cell(row, idCol).trim()     : '';
      const handleVal = handleCol ? cell(row, handleCol).trim() : '';

      if (!idVal && !handleVal) {
        notFound.push({ row: i + 2, value: '(empty)', reason: 'no id or handle' });
        continue;
      }

      let found      = null;
      let resolvedVia = null;

      if (idVal && UUID_RE.test(idVal)) {
        const team = byId.get(idVal);
        if (team) {
          found       = team;
          resolvedVia = 'id';
        } else if (fallbackToHandle && handleVal) {
          const teamByHandle = byHandle.get(handleVal.toLowerCase());
          if (teamByHandle) {
            found       = teamByHandle;
            resolvedVia = 'handle (fallback)';
          }
        }
      } else if (handleVal) {
        const teamByHandle = byHandle.get(handleVal.toLowerCase());
        if (teamByHandle) {
          found       = teamByHandle;
          resolvedVia = 'handle';
        }
      }

      if (found) {
        if (!seenIds.has(found.id)) {
          seenIds.add(found.id);
          toDelete.push({ id: found.id, name: found.name, handle: found.handle, resolvedVia });
        }
      } else {
        notFound.push({ row: i + 2, value: idVal || handleVal, reason: 'not found in workspace' });
      }
    }

    return res.json({ toDelete, notFound });

  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    console.error('[teams-crud] delete/preview error:', err.message);
    res.status(500).json({ error: err.message || 'Preview failed.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/teams-crud/delete/by-csv  (SSE)
// ---------------------------------------------------------------------------

router.post('/delete/by-csv', pbAuth, async (req, res) => {
  const { csvText, idCol, handleCol, fallbackToHandle } = req.body || {};
  const sse = startSSE(res);

  try {
    if (!csvText) {
      sse.error('csvText is required.');
      return;
    }

    sse.progress('Loading teams…', 5);
    const { pbClient } = res.locals;
    const raw   = await listTeams(pbClient);
    const teams = normalizeTeams(raw);
    const { byHandle } = buildTeamMaps(teams);

    if (sse.isAborted()) return;

    const { rows, errors: parseErrors } = parseCSV(csvText);

    if (parseErrors && parseErrors.length > 0) {
      sse.error(`Malformed CSV: ${parseErrors[0]}`);
      return;
    }
    if (!rows || rows.length === 0) {
      sse.complete({ total: 0, deleted: 0, skipped: 0, errors: 0 });
      return;
    }

    let deleted = 0, skipped = 0, errors = 0;

    for (let i = 0; i < rows.length; i++) {
      if (sse.isAborted()) break;

      const row       = rows[i];
      const idVal     = idCol     ? cell(row, idCol).trim()     : '';
      const handleVal = handleCol ? cell(row, handleCol).trim() : '';

      let targetId = null;
      let resolvedVia = 'id';

      if (idVal && UUID_RE.test(idVal)) {
        targetId = idVal;
      } else if (handleVal) {
        const found = byHandle.get(handleVal.toLowerCase());
        if (found) {
          targetId = found.id;
          resolvedVia = 'handle';
        } else {
          sse.log('warn', `Row ${i + 2}: handle '${handleVal}' not found — skipped`);
          skipped++;
          continue;
        }
      } else {
        sse.log('warn', `Row ${i + 2}: no id or handle — skipped`);
        skipped++;
        continue;
      }

      try {
        await pbClient.withRetry(
          () => pbClient.pbFetch('delete', `/v2/teams/${targetId}`),
          `delete team ${targetId}`
        );
        deleted++;
        sse.log('success', `Deleted ${targetId}`);
      } catch (err) {
        if (err.status === 404) {
          // Try handle fallback if we originally used a UUID
          if (fallbackToHandle && resolvedVia === 'id' && handleVal) {
            const found = byHandle.get(handleVal.toLowerCase());
            if (found && found.id !== targetId) {
              try {
                await pbClient.withRetry(
                  () => pbClient.pbFetch('delete', `/v2/teams/${found.id}`),
                  `delete team ${found.id} (handle fallback)`
                );
                deleted++;
                sse.log('success', `Deleted ${found.id} (via handle fallback)`);
                continue;
              } catch (err2) {
                if (err2.status !== 404) {
                  errors++;
                  sse.log('error', `Failed to delete (handle fallback): ${parseApiError(err2)}`);
                  continue;
                }
              }
            }
          }
          skipped++;
          sse.log('warn', `Not found — skipped (${targetId})`);
        } else {
          errors++;
          sse.log('error', `Failed to delete ${targetId}: ${parseApiError(err)}`);
        }
      }

      sse.progress(`Deleted ${deleted} of ${rows.length}…`, Math.round(5 + ((i + 1) / rows.length) * 90));
    }

    sse.complete({ total: rows.length, deleted, skipped, errors });

  } catch (err) {
    console.error('[teams-crud] delete/by-csv error:', err.message);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// POST /api/teams-crud/delete/all  (SSE)
// ---------------------------------------------------------------------------

router.post('/delete/all', pbAuth, async (req, res) => {
  const sse = startSSE(res);

  try {
    sse.progress('Fetching all teams…', 5);
    const { pbClient } = res.locals;
    const raw    = await listTeams(pbClient);
    const teams  = normalizeTeams(raw);
    const allIds = teams.map((t) => t.id);

    if (allIds.length === 0) {
      sse.complete({ total: 0, deleted: 0, skipped: 0, errors: 0 });
      return;
    }

    sse.progress(`Found ${allIds.length} teams. Deleting…`, 10);

    let deleted = 0, skipped = 0, errors = 0;

    for (let i = 0; i < allIds.length; i++) {
      if (sse.isAborted()) break;

      const id = allIds[i];
      try {
        await pbClient.withRetry(
          () => pbClient.pbFetch('delete', `/v2/teams/${id}`),
          `delete team ${id}`
        );
        deleted++;
      } catch (err) {
        if (err.status === 404) {
          skipped++;
        } else {
          errors++;
          sse.log('error', `Failed to delete ${id}: ${parseApiError(err)}`);
        }
      }

      if ((i + 1) % 10 === 0 || i === allIds.length - 1) {
        sse.log('info', `Deleted ${deleted}/${allIds.length}…`);
      }
      sse.progress(
        `Deleted ${deleted} of ${allIds.length}…`,
        10 + Math.round(((i + 1) / allIds.length) * 90)
      );
    }

    sse.complete({ total: allIds.length, deleted, skipped, errors });

  } catch (err) {
    console.error('[teams-crud] delete/all error:', err.message);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

module.exports = router;
