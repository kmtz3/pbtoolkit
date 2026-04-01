/**
 * Entities routes — Phase 1 + Phase 2 + Phase 3 + Phase 4
 *
 * Phase 1 — Templates
 *   GET  /api/entities/templates/:type   Download CSV template for one entity type
 *   GET  /api/entities/templates.zip     Download ZIP of all entity type templates
 *
 * Phase 2 — CSV Parser & Validator
 *   GET  /api/entities/configs           Return entity field configs as JSON (for mapping UI)
 *   POST /api/entities/preview           Validate CSVs + mappings; optionally validate owner emails against members
 *   POST /api/entities/normalize-keys    Single-file CSV transform: rewrite UUID ext_keys → WSID-TYPE-NNN
 *
 * Phase 3 — Exports + Migration
 *   POST /api/entities/export/:type      Export one entity type as CSV (SSE)
 *   POST /api/entities/export-all        Export selected (or all) types; CSV or ZIP (SSE)
 *   POST /api/entities/normalize-keys-multi  Multi-file cross-entity ext_key rewrite → ZIP (no token)
 *
 * Phase 4 — Import SSE + Relationships
 *   POST /api/entities/run               Full import run: CREATE/PATCH rows + relationship pass (SSE)
 *   POST /api/entities/relationships     Relationship-only re-pass (no upsert); same body as /run (SSE)
 *
 * All routes except normalize-keys-multi require x-pb-token header (and optional x-pb-eu).
 */

const express = require('express');
const archiver = require('archiver');
const { PassThrough } = require('stream');
const Papa = require('papaparse');

const { startSSE } = require('../lib/sse');
const { UUID_RE } = require('../lib/constants');
const { parseCSV, cell } = require('../lib/csvUtils');
const { parseApiError } = require('../lib/errorUtils');
const { pbAuth } = require('../middleware/pbAuth');
const { fetchEntityConfigs } = require('../services/entities/configCache');
const { ENTITY_ORDER, ENTITY_LABELS, SYSTEM_FIELD_ORDER, TYPE_CODE, syntheticColumns, relationshipColumns } = require('../services/entities/meta');
const { parseEntityCsv } = require('../services/entities/csvParser');
const { validateEntityRows } = require('../services/entities/validator');
const { exportEntityType, rowsToCsv } = require('../services/entities/exporter');
const { applyMigrationMode } = require('../services/entities/migrationHelper');
const { runImport } = require('../services/entities/importCoordinator');

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a single CSV template string for one entity type.
 *
 * Column order:
 *   1. pb_id, ext_key                             — synthetic tracking fields
 *   2. System fields from configurations           — PB display name as header
 *      (name, description, owner, status, phase, teams/team, archived, workProgress)
 *      sorted by SYSTEM_FIELD_ORDER; objective gets "Team" vs others "Teams" via f.name
 *   3. Synthetic composite columns                 — timeframe_start/end, health_*
 *   4. Custom UUID fields from configurations      — "Field Name [Type] [uuid]"
 *   5. Relationship columns                        — parent_ext_key, connected_*
 */
function buildTemplateCsv(entityType, configs) {
  const entityConfig = configs[entityType] || { systemFields: [], customFields: [] };

  // 1. Hardcoded prefix
  const prefixCols = ['pb_id', 'ext_key'];

  // 2. System fields from configs in preferred order, using PB display name as header
  //    (e.g. objective teams field has name "Team", others have "Teams")
  const systemHeaders = [...entityConfig.systemFields]
    .sort((a, b) => {
      const ai = SYSTEM_FIELD_ORDER.indexOf(a.id);
      const bi = SYSTEM_FIELD_ORDER.indexOf(b.id);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    })
    .map((f) => f.name);

  // 3. Synthetic composite columns (timeframe split, health split)
  const syntheticCols = syntheticColumns(entityType);

  // 4. Custom UUID fields
  const customHeaders = entityConfig.customFields.map(
    (f) => `${f.name} [${f.displayType}] [${f.id}]`
  );

  // 5. Relationship columns
  const relCols = relationshipColumns(entityType);

  const allHeaders = [...prefixCols, ...systemHeaders, ...syntheticCols, ...customHeaders, ...relCols];
  // Prepend UTF-8 BOM (\uFEFF) so Excel/Numbers render emoji and special chars correctly
  return '\uFEFF' + Papa.unparse({ fields: allHeaders, data: [] });
}

/**
 * Format current timestamp as YYYY-MM-DD-HHmm for filenames.
 */
function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

// ---------------------------------------------------------------------------
// GET /templates/:type  — single entity template CSV
// ---------------------------------------------------------------------------

router.get('/templates/:type', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;

  const { type } = req.params;
  if (!ENTITY_ORDER.includes(type)) {
    return res.status(400).json({ error: `Unknown entity type: ${type}. Valid types: ${ENTITY_ORDER.join(', ')}` });
  }

  try {
    const configs = await fetchEntityConfigs(pbFetch, withRetry);
    const csv = buildTemplateCsv(type, configs);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="entities-template-${type}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(`entities template ${type}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /templates.zip  — ZIP of all entity templates
// ---------------------------------------------------------------------------

router.get('/templates.zip', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;

  // Optional ?types=objective,keyResult filter; defaults to all types
  let typesToInclude = ENTITY_ORDER;
  if (req.query.types) {
    const requested = req.query.types.split(',').map((t) => t.trim()).filter(Boolean);
    const invalid = requested.filter((t) => !ENTITY_ORDER.includes(t));
    if (invalid.length) {
      return res.status(400).json({ error: `Unknown entity type(s): ${invalid.join(', ')}. Valid types: ${ENTITY_ORDER.join(', ')}` });
    }
    typesToInclude = ENTITY_ORDER.filter((t) => requested.includes(t));
  }

  try {
    const configs = await fetchEntityConfigs(pbFetch, withRetry);

    const filename = `pbtoolkit-entities-templates-${nowStamp()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (err) => {
      console.error('archiver error:', err);
      // Headers already sent; best we can do is end the response
      res.end();
    });
    archive.pipe(res);

    for (const type of typesToInclude) {
      const csv = buildTemplateCsv(type, configs);
      archive.append(csv, { name: `entities-template-${type}.csv` });
    }

    await archive.finalize();
  } catch (err) {
    console.error('entities templates.zip:', err.message);
    // Only send JSON error if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
});

// ---------------------------------------------------------------------------
// GET /configs  — entity field configs as JSON (for mapping UI)
// ---------------------------------------------------------------------------

router.get('/configs', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  try {
    const configs = await fetchEntityConfigs(pbFetch, withRetry);
    res.json(configs);
  } catch (err) {
    console.error('entities/configs:', err.message);
    res.status(err.status || 500).json({ error: parseApiError(err) });
  }
});

// ---------------------------------------------------------------------------
// POST /preview  — validate CSVs + mappings; optionally fetches members for owner validation
// ---------------------------------------------------------------------------

router.post('/preview', pbAuth, async (req, res) => {
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  const { files, mappings = {}, options = {} } = req.body;
  if (!files || typeof files !== 'object') {
    return res.status(400).json({ error: 'Missing files object' });
  }

  // If skipInvalidOwner is enabled, fetch workspace members for owner validation
  let memberEmails = null;
  if (options.skipInvalidOwner) {
    try {
      const members = await fetchAllPages('/v2/members', 'fetch members for owner validation');
      memberEmails = new Set(members.map((m) => (m.fields?.email || '').toLowerCase()).filter(Boolean));
    } catch (err) {
      console.error('entities/preview: failed to fetch members for owner validation:', err.message);
      return res.status(500).json({ error: `Failed to fetch workspace members: ${parseApiError(err)}` });
    }
  }

  const results = {};
  let totalErrors = 0;

  for (const [entityType, fileData] of Object.entries(files)) {
    if (!ENTITY_ORDER.includes(entityType)) {
      results[entityType] = { error: `Unknown entity type: ${entityType}` };
      continue;
    }

    const csvText = fileData && fileData.csvText;
    if (!csvText) {
      results[entityType] = { rowCount: 0, headers: [], errors: [], warnings: [] };
      continue;
    }

    const { headers, rows, errors: parseErrors } = parseEntityCsv(csvText);
    if (parseErrors.length) {
      results[entityType] = { rowCount: 0, headers, parseErrors, errors: [], warnings: [] };
      totalErrors += parseErrors.length;
      continue;
    }

    if (rows.length > 50000) {
      // Warn — don't block
      results[entityType] = {
        rowCount: rows.length,
        headers,
        errors: [],
        warnings: [{ row: null, field: null, message: `${rows.length.toLocaleString()} rows exceeds the recommended limit of 50,000 — import may be slow` }],
      };
    } else {
      results[entityType] = { rowCount: rows.length, headers, errors: [], warnings: [] };
    }

    const mapping = mappings[entityType] || {};
    const { errors, warnings } = validateEntityRows(entityType, rows, mapping);
    results[entityType].errors.push(...errors);
    results[entityType].warnings.push(...warnings);
    totalErrors += errors.length;

    // Owner email validation against workspace members
    if (memberEmails) {
      const cols = (mapping && mapping.columns) ? mapping.columns : {};
      const ownerCol = cols['owner'] || 'Owner';
      rows.forEach((row, i) => {
        const ownerVal = (cell(row, ownerCol) || '').trim().toLowerCase();
        if (ownerVal && !memberEmails.has(ownerVal)) {
          results[entityType].warnings.push({
            row: i + 2, // 1-indexed, row 1 is header
            field: ownerCol,
            message: `Owner email '${ownerVal}' does not match any workspace member — owner will be skipped during import`,
          });
        }
      });
    }
  }

  res.json({ valid: totalErrors === 0, results });
});

// ---------------------------------------------------------------------------
// POST /normalize-keys  — pure CSV transform; rewrite UUID ext_keys → WSID-TYPE-NNN
// ---------------------------------------------------------------------------

router.post('/normalize-keys', (req, res) => {
  const { csvText, entityType, workspaceCode } = req.body;
  if (!csvText)      return res.status(400).json({ error: 'Missing csvText' });
  if (!workspaceCode) return res.status(400).json({ error: 'Missing workspaceCode' });
  if (!entityType || !ENTITY_ORDER.includes(entityType)) {
    return res.status(400).json({ error: `Unknown entity type: ${entityType || '(none)'}. Valid types: ${ENTITY_ORDER.join(', ')}` });
  }

  const { headers, rows, errors: parseErrors } = parseEntityCsv(csvText);
  if (parseErrors.length) {
    return res.status(400).json({ error: `CSV parse error: ${parseErrors[0]}` });
  }

  const code     = String(workspaceCode).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const typeCode = TYPE_CODE[entityType];
  let counter    = 1;

  const transformed = rows.map((row) => {
    const extKey = String(row['ext_key'] || '').trim();
    if (extKey && UUID_RE.test(extKey)) {
      return { ...row, ext_key: `${code}-${typeCode}-${counter++}` };
    }
    return { ...row };
  });

  const data = transformed.map((r) => headers.map((h) => (r[h] == null ? '' : String(r[h]))));
  const csv  = '\uFEFF' + Papa.unparse({ fields: headers, data });

  res.json({ csv, transformedCount: counter - 1 });
});

// ---------------------------------------------------------------------------
// POST /export/:type  — export one entity type as CSV (SSE)
// ---------------------------------------------------------------------------

router.post('/export/:type', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;

  const { type } = req.params;
  if (!ENTITY_ORDER.includes(type)) {
    return res.status(400).json({ error: `Unknown entity type: ${type}` });
  }

  const { migrationMode = false, workspaceCode = '' } = req.body || {};

  if (migrationMode && !workspaceCode) {
    return res.status(400).json({ error: 'workspaceCode is required when migrationMode is enabled' });
  }

  const sse = startSSE(res);

  try {
    sse.progress(`Fetching ${ENTITY_LABELS[type] || type} configuration…`, 5);
    const configs = await fetchEntityConfigs(pbFetch, withRetry);

    sse.progress(`Fetching ${ENTITY_LABELS[type] || type}…`, 15);

    const { headers, rows, count } = await exportEntityType(
      type,
      configs,
      pbFetch,
      withRetry,
      (fetched) => sse.progress(`Fetching ${ENTITY_LABELS[type] || type}… (${fetched} so far)`, 15 + Math.min(60, Math.floor(fetched / 10)))
    );

    if (count >= 50000) {
      sse.log('warn', `${count.toLocaleString()} entities fetched — safety cap reached. Export may be incomplete.`);
    }

    let finalRows = rows;
    if (migrationMode) {
      sse.progress('Applying migration mode…', 80);
      const rowsByType = { [type]: rows };
      applyMigrationMode(rowsByType, workspaceCode);
      finalRows = rowsByType[type];
    }

    sse.progress('Generating CSV…', migrationMode ? 92 : 85);
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${type}-export-${date}.csv`;
    const csv = finalRows.length > 0 ? rowsToCsv(headers, finalRows) : null;

    sse.complete({ csv, filename, entityType: type, count: finalRows.length });
  } catch (err) {
    console.error(`entities/export/${type}:`, err.message);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// POST /export-all  — export selected (or all) entity types; ZIP or CSV (SSE)
// ---------------------------------------------------------------------------

router.post('/export-all', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;

  const { migrationMode = false, workspaceCode = '', types: selectedTypes } = req.body || {};

  if (migrationMode && !workspaceCode) {
    return res.status(400).json({ error: 'workspaceCode is required when migrationMode is enabled' });
  }

  // Respect caller's selection; default to all types in dependency order
  const typesToExport = Array.isArray(selectedTypes) && selectedTypes.length
    ? ENTITY_ORDER.filter((t) => selectedTypes.includes(t))
    : ENTITY_ORDER;

  const sse = startSSE(res);

  try {
    sse.progress('Fetching entity configurations…', 3);
    const configs = await fetchEntityConfigs(pbFetch, withRetry);

    const rowsByType = {};
    const headersByType = {};
    const perEntity = [];
    const total = typesToExport.length;

    for (let i = 0; i < total; i++) {
      const entityType = typesToExport[i];
      const label = ENTITY_LABELS[entityType] || entityType;
      const basePercent = 5 + Math.floor((i / total) * 80);

      sse.progress(`Exporting ${label}…`, basePercent);

      try {
        const { headers, rows, count } = await exportEntityType(
          entityType,
          configs,
          pbFetch,
          withRetry,
          (fetched) => sse.progress(`Exporting ${label}… (${fetched})`, basePercent)
        );

        rowsByType[entityType] = rows;
        headersByType[entityType] = headers;
        perEntity.push({ entityType, label, count });

        if (count >= 50000) {
          sse.log('warn', `${label}: safety cap reached at ${count.toLocaleString()} — export may be incomplete.`);
        }

        sse.log('success', `${label}: ${count} exported`);
      } catch (err) {
        sse.log('error', `${label}: failed — ${err.message}`);
        perEntity.push({ entityType, label, count: 0, error: err.message });
        rowsByType[entityType] = [];
        headersByType[entityType] = [];
      }
    }

    if (migrationMode) {
      sse.progress('Applying migration mode…', 87);
      applyMigrationMode(rowsByType, workspaceCode);
    }

    // Single type → return plain CSV; multiple → ZIP
    if (typesToExport.length === 1) {
      sse.progress('Generating CSV…', 92);
      const onlyType = typesToExport[0];
      const onlyRows = rowsByType[onlyType] || [];
      const date = new Date().toISOString().slice(0, 10);
      const csv = onlyRows.length > 0 ? rowsToCsv(headersByType[onlyType], onlyRows) : null;
      sse.complete({
        csv,
        filename: `${onlyType}-export-${date}.csv`,
        entityType: onlyType,
        count: onlyRows.length,
        perEntity,
      });
    } else {
      sse.progress('Building ZIP…', 92);

      const zipBuffer = await new Promise((resolve, reject) => {
        const chunks = [];
        const pass = new PassThrough();
        pass.on('data', (chunk) => chunks.push(chunk));
        pass.on('end', () => resolve(Buffer.concat(chunks)));
        pass.on('error', reject);

        const archive = archiver('zip', { zlib: { level: 6 } });
        archive.on('error', reject);
        archive.pipe(pass);

        for (const entityType of typesToExport) {
          const rows = rowsByType[entityType];
          const headers = headersByType[entityType];
          if (!headers || !headers.length) continue;
          const csv = rowsToCsv(headers, rows || []);
          const date = new Date().toISOString().slice(0, 10);
          archive.append(csv, { name: `${entityType}-export-${date}.csv` });
        }

        archive.finalize();
      });

      const zipBase64 = zipBuffer.toString('base64');
      const filename = `pbtoolkit-entities-export-${nowStamp()}.zip`;

      sse.complete({
        zipBase64,
        filename,
        perEntity,
        migrationMode: migrationMode || undefined,
        totalEntities: perEntity.reduce((s, e) => s + e.count, 0),
      });
    }
  } catch (err) {
    console.error('entities/export-all:', err.message);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// POST /normalize-keys-multi  — multi-file cross-entity ext_key rewrite; no token required
// ---------------------------------------------------------------------------

router.post('/normalize-keys-multi', async (req, res) => {
  const { files, workspaceCode } = req.body || {};

  if (!workspaceCode) {
    return res.status(400).json({ error: 'Missing workspaceCode' });
  }
  if (!files || typeof files !== 'object' || !Object.keys(files).length) {
    return res.status(400).json({ error: 'Missing files object' });
  }

  const unknownTypes = Object.keys(files).filter((t) => !ENTITY_ORDER.includes(t));
  if (unknownTypes.length) {
    return res.status(400).json({ error: `Unknown entity types: ${unknownTypes.join(', ')}` });
  }

  const rowsByType = {};
  const headersByType = {};
  const summary = {};

  for (const [entityType, fileData] of Object.entries(files)) {
    const csvText = fileData && fileData.csvText;
    if (!csvText) continue;

    const { headers, rows, errors: parseErrors } = parseEntityCsv(csvText);
    if (parseErrors.length) {
      return res.status(400).json({ error: `Parse error in ${entityType}: ${parseErrors[0]}` });
    }

    rowsByType[entityType] = rows;
    headersByType[entityType] = headers;
    summary[entityType] = { rows: rows.length, noPbId: !headers.includes('pb_id') };
  }

  if (!Object.keys(rowsByType).length) {
    return res.status(400).json({ error: 'No valid CSV data provided' });
  }

  applyMigrationMode(rowsByType, workspaceCode);

  try {
    const zipBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      const pass = new PassThrough();
      pass.on('data', (chunk) => chunks.push(chunk));
      pass.on('end', () => resolve(Buffer.concat(chunks)));
      pass.on('error', reject);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', reject);
      archive.pipe(pass);

      for (const entityType of ENTITY_ORDER) {
        if (!rowsByType[entityType]) continue;
        const csv = rowsToCsv(headersByType[entityType], rowsByType[entityType]);
        archive.append(csv, { name: `${entityType}-normalized.csv` });
      }

      archive.finalize();
    });

    const zipBase64 = zipBuffer.toString('base64');
    const filename = `pbtoolkit-normalized-${nowStamp()}.zip`;

    res.json({ zipBase64, filename, summary });
  } catch (err) {
    console.error('normalize-keys-multi:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Phase 4 — Import SSE
// ---------------------------------------------------------------------------

/**
 * POST /api/entities/run
 * Full import: CREATE/PATCH rows in dependency order, then relationship pass.
 * Body: { files, mappings, options }
 */
router.post('/run', pbAuth, async (req, res) => {
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  const sse = startSSE(res);
  const { files, mappings, options } = req.body || {};

  // If skipInvalidOwner is enabled, pre-fetch workspace members and inject the email set into options
  let resolvedOptions = options || {};
  if (resolvedOptions.skipInvalidOwner) {
    try {
      const members = await fetchAllPages('/v2/members', 'fetch members for owner validation');
      const memberEmails = new Set(members.map((m) => (m.fields?.email || '').toLowerCase()).filter(Boolean));
      resolvedOptions = { ...resolvedOptions, _memberEmails: memberEmails };
    } catch (err) {
      console.error('entities/run: failed to fetch members for owner validation:', err.message);
      sse.error(`Failed to fetch workspace members: ${parseApiError(err)}`);
      sse.done();
      return;
    }
  }

  try {
    const configs = await fetchEntityConfigs(pbFetch, withRetry);
    const result = await runImport(
      files    || {},
      mappings || {},
      configs,
      resolvedOptions,
      pbFetch,
      withRetry,
      {
        onProgress: (msg, pct) => sse.progress(msg, pct),
        onLog: (level, msg, detail) => sse.log(level, msg, detail),
      },
      { abortSignal: { get aborted() { return sse.isAborted(); } } },
    );
    sse.complete(result);
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

/**
 * POST /api/entities/relationships
 * Relationship-only re-pass — no CREATE/PATCH. Same body as /run.
 * Used by "Fix relationships" button to re-run link writes idempotently.
 */
router.post('/relationships', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const sse = startSSE(res);
  const { files, mappings, options } = req.body || {};


  try {
    const configs = await fetchEntityConfigs(pbFetch, withRetry);
    const result = await runImport(
      files    || {},
      mappings || {},
      configs,
      { ...(options || {}), relationshipsOnly: true },
      pbFetch,
      withRetry,
      {
        onProgress: (msg, pct) => sse.progress(msg, pct),
        onLog: (level, msg, detail) => sse.log(level, msg, detail),
      },
      { abortSignal: { get aborted() { return sse.isAborted(); } } },
    );
    sse.complete(result);
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// POST /delete/by-csv  — delete entities from uploaded CSVs (SSE)
// Phase 5 — Delete
//
// Body: {
//   files: { [entityType]: { csvText, uuidColumn } },
//   options: { safeMode: true }
// }
//
// Algorithm:
//   1. Parse all CSVs; build allTargetIds Set (all UUIDs to delete across all types).
//   2. Process types in reverse ENTITY_ORDER (children first, parents last).
//   3. For each UUID:
//      - Skip if already removed from allTargetIds (cascade-deleted by a parent earlier).
//      - In safeMode: fetch children via GET /v2/entities/{id}/relationships?type=child.
//        If any child is NOT in allTargetIds → skip entity (has untargeted children).
//        If all children ARE in allTargetIds → remove them (PB will cascade; avoids 404).
//      - DELETE /v2/entities/{id}
//      - 404 → warn + skip (not an error).
// ---------------------------------------------------------------------------

/** Extract pageCursor from a PB API next URL. */
function extractDeleteCursor(nextUrl) {
  if (!nextUrl) return null;
  const m = String(nextUrl).match(/[?&]pageCursor=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

router.post('/delete/by-csv', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { files = {}, options = {} } = req.body || {};
  const safeMode = options.safeMode !== false; // default true

  const sse = startSSE(res);

  try {
    // Validate entity types
    const unknownTypes = Object.keys(files).filter((t) => !ENTITY_ORDER.includes(t));
    if (unknownTypes.length) {
      sse.error(`Unknown entity types: ${unknownTypes.join(', ')}`);
      return;
    }

    // Build uuidMap and allTargetIds
    const uuidMap = {};
    const allTargetIds = new Set();

    for (const entityType of ENTITY_ORDER) {
      const fileData = files[entityType];
      if (!fileData?.csvText || !fileData?.uuidColumn) continue;

      const { rows } = parseCSV(fileData.csvText);
      const uuids = rows
        .map((r) => cell(r, fileData.uuidColumn))
        .filter((id) => UUID_RE.test(id));

      if (uuids.length) {
        uuidMap[entityType] = uuids;
        uuids.forEach((id) => allTargetIds.add(id));
      }
    }

    const totalCount = allTargetIds.size;
    if (totalCount === 0) {
      sse.complete({ perType: [], total: 0, deleted: 0, skipped: 0, errors: 0 });
      return;
    }

    sse.progress(
      `Preparing to delete ${totalCount} entities across ${Object.keys(uuidMap).length} type(s)…`,
      2
    );

    let totalDeleted = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let processed = 0;
    const perType = [];

    // Process in reverse ENTITY_ORDER (releases → … → objectives)
    const deleteOrder = [...ENTITY_ORDER].reverse();

    for (const entityType of deleteOrder) {
      if (sse.isAborted()) break;
      if (!uuidMap[entityType]) continue;

      const uuids = uuidMap[entityType];
      const label = ENTITY_LABELS[entityType] || entityType;
      let typeDeleted = 0;
      let typeSkipped = 0;
      let typeErrors = 0;

      sse.log('info', `Processing ${label} (${uuids.length})…`);

      for (const uuid of uuids) {
        if (sse.isAborted()) break;

        // Already removed from allTargetIds — was cascade-deleted by a parent earlier in this run
        if (!allTargetIds.has(uuid)) {
          typeSkipped++;
          totalSkipped++;
          processed++;
          sse.progress(
            `Deleted ${totalDeleted} of ${totalCount}…`,
            Math.round((processed / totalCount) * 100)
          );
          continue;
        }

        if (safeMode) {
          // Fetch all direct children via GET /v2/entities?parent[id]={uuid}
          // (Using parent[id] filter rather than the relationships endpoint because
          //  key results store a 'parent' relationship on their own side pointing to the
          //  objective — the objective does not get a corresponding 'child' relationship
          //  entry, so ?type=child on the relationships endpoint misses them.)
          const childIds = [];
          let cursor = null;
          let entityMissing = false;
          do {
            const url =
              `/v2/entities?parent%5Bid%5D=${encodeURIComponent(uuid)}&fields[]=id` +
              (cursor ? `&pageCursor=${encodeURIComponent(cursor)}` : '');
            let childResp;
            try {
              childResp = await withRetry(
                () => pbFetch('get', url),
                `check children of ${entityType} ${uuid}`
              );
            } catch (childErr) {
              // 404: entity gone; 400/422: parent[id] invalid because entity doesn't exist
              if (childErr.status === 404 || childErr.status === 400 || childErr.status === 422) {
                entityMissing = true;
                break;
              }
              throw childErr;
            }
            (childResp.data || []).forEach((e) => {
              if (e.id) childIds.push(e.id);
            });
            cursor = extractDeleteCursor(childResp.links?.next);
          } while (cursor);

          if (entityMissing) {
            typeSkipped++;
            totalSkipped++;
            processed++;
            sse.log('warn', `${label} ${uuid} not found — skipped`, { uuid, entityType });
            sse.progress(
              `Deleted ${totalDeleted} of ${totalCount}…`,
              Math.round((processed / totalCount) * 100)
            );
            continue;
          }

          if (childIds.length > 0) {
            const untargeted = childIds.filter((id) => !allTargetIds.has(id));
            if (untargeted.length > 0) {
              typeSkipped++;
              totalSkipped++;
              processed++;
              sse.log(
                'warn',
                `Skipped ${label} ${uuid} — has ${untargeted.length} child(ren) not in uploaded files`,
                { uuid, entityType }
              );
              sse.progress(
                `Deleted ${totalDeleted} of ${totalCount}…`,
                Math.round((processed / totalCount) * 100)
              );
              continue;
            }
            // All children are targeted — PB will cascade; remove from Set to avoid 404 later
            childIds.forEach((id) => allTargetIds.delete(id));
          }
        }

        try {
          await withRetry(
            () => pbFetch('delete', `/v2/entities/${uuid}`),
            `delete ${entityType} ${uuid}`
          );
          allTargetIds.delete(uuid);
          typeDeleted++;
          totalDeleted++;
          sse.log('success', `Deleted ${label} ${uuid}`, { uuid, entityType });
        } catch (err) {
          if (err.status === 404) {
            sse.log('warn', `${label} ${uuid} not found — skipped`, { uuid, entityType });
          } else {
            typeErrors++;
            totalErrors++;
            sse.log('error', `Failed to delete ${entityType} ${uuid}: ${parseApiError(err)}`, { uuid, entityType });
          }
        }

        processed++;
        sse.progress(
          `Deleted ${totalDeleted} of ${totalCount}…`,
          Math.round((processed / totalCount) * 100)
        );
      }

      perType.push({
        type: entityType,
        total: uuids.length,
        deleted: typeDeleted,
        skipped: typeSkipped,
        errors: typeErrors,
      });
      sse.log(
        typeErrors > 0 ? 'warn' : 'success',
        `${label}: ${typeDeleted} deleted · ${typeSkipped} skipped · ${typeErrors} error(s)`
      );
    }

    sse.complete({
      perType,
      total: totalCount,
      deleted: totalDeleted,
      skipped: totalSkipped,
      errors: totalErrors,
    });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

module.exports = router;
