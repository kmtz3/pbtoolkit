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
const {
  exportEntityType,
  rowsToCsv,
  buildNameMapFromEntities,
  entityToRow,
  buildExportHeaders,
  fetchNameMapForTypes,
  BREADCRUMB_EXTRA_TYPES,
  ROOT_ENTITY_TYPES,
} = require('../services/entities/exporter');
const { applyMigrationMode } = require('../services/entities/migrationHelper');
const { runImport } = require('../services/entities/importCoordinator');
const {
  fetchFieldValues,
  createFieldValue,
  collectCsvValues,
  findMissingValues,
  filterStatusValuesByType,
} = require('../lib/fieldValues');

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
 *   3. Synthetic composite columns (writable only)  — timeframe_start/end, health_status/comment, progress_*
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

  // 3. Synthetic composite columns (timeframe, health writable-only, progress)
  const syntheticCols = syntheticColumns(entityType, { forTemplate: true });

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

  // Fetch member emails (owner validation) and entity configs in parallel.
  // Configs are needed to identify which mapped fields are select-type.
  let memberEmails = null;
  let configs = {};
  try {
    const fetchMembers = options.skipInvalidOwner
      ? Promise.resolve(null)
      : fetchAllPages('/v2/members', 'fetch members for owner validation')
          .then((ms) => new Set(ms.map((m) => (m.fields?.email || '').toLowerCase()).filter(Boolean)));

    [memberEmails, configs] = await Promise.all([
      fetchMembers,
      fetchEntityConfigs(pbFetch, withRetry),
    ]);
  } catch (err) {
    console.error('entities/preview: failed to fetch members or configs:', err.message);
    return res.status(500).json({ error: `Failed to fetch workspace members: ${parseApiError(err)}` });
  }

  // ── Pass 1: collect all select field IDs referenced by any mapping ──────────
  // Identifies which field values to fetch before running per-type validation.
  const selectFieldIds = new Set(); // field IDs (UUID or "status") to fetch values for
  for (const [entityType, fileData] of Object.entries(files)) {
    if (!ENTITY_ORDER.includes(entityType) || !fileData?.csvText) continue;
    const cols = (mappings[entityType]?.columns) || {};
    const config = configs[entityType];
    for (const internalId of Object.keys(cols)) {
      if (internalId === 'status') {
        selectFieldIds.add('status');
      } else if (internalId.startsWith('custom__')) {
        const fieldId = internalId.slice(8);
        const fc = config?.customFields?.find((f) => f.id === fieldId);
        if (fc && (fc.displayType === 'SingleSelect' || fc.displayType === 'MultiSelect')) {
          selectFieldIds.add(fieldId);
        }
      }
    }
  }

  // ── Fetch all needed field values in parallel ─────────────────────────────
  const fieldValuesMap = new Map(); // fieldId → Map<normalised_name, {id, name, ...}>
  await Promise.all([...selectFieldIds].map(async (fieldId) => {
    try {
      fieldValuesMap.set(fieldId, await fetchFieldValues(fieldId, pbFetch, withRetry));
    } catch (_) { /* non-fatal — skip validation for this field if fetch fails */ }
  }));

  // ── Pass 2: per-type CSV parsing + validation ─────────────────────────────
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

    // Owner email validation
    if (memberEmails) {
      const cols = (mapping && mapping.columns) ? mapping.columns : {};
      const hasMapping = Object.keys(cols).length > 0;
      const ownerCol = 'owner' in cols ? cols['owner'] : (hasMapping ? null : 'Owner');
      if (ownerCol) {
        rows.forEach((row, i) => {
          const ownerVal = (cell(row, ownerCol) || '').trim().toLowerCase();
          if (ownerVal && !memberEmails.has(ownerVal)) {
            results[entityType].errors.push({
              row: i + 2,
              field: ownerCol,
              message: `Owner '${ownerVal}' is not a workspace member — fix the email or enable "Skip owner if member does not exist"`,
            });
            totalErrors++;
          }
        });
      }
    }

    // ── Field value validation ────────────────────────────────────────────────
    const cols = mapping.columns || {};
    const config = configs[entityType];

    for (const [internalId, csvHeader] of Object.entries(cols)) {
      if (internalId === 'status') {
        // Status: validate against type-filtered values; always a hard error if unknown
        const allStatusValues = fieldValuesMap.get('status');
        if (!allStatusValues) continue;
        const typeStatusValues = filterStatusValuesByType(allStatusValues, entityType);
        const csvValues = collectCsvValues(rows, csvHeader, false);
        const missing = findMissingValues(csvValues, typeStatusValues);
        if (missing.length) {
          const available = [...typeStatusValues.values()].map((v) => v.name).sort();
          results[entityType].errors.push({
            row: null,
            field: 'Status',
            message: `Unknown Status value(s): ${missing.join(', ')}. Available values: ${available.join(', ')}`,
          });
          totalErrors++;
        }

      } else if (internalId.startsWith('custom__')) {
        const fieldId = internalId.slice(8);
        const fc = config?.customFields?.find((f) => f.id === fieldId);
        if (!fc || (fc.displayType !== 'SingleSelect' && fc.displayType !== 'MultiSelect')) continue;

        const isMulti = fc.displayType === 'MultiSelect';
        const knownValues = fieldValuesMap.get(fieldId);
        if (!knownValues) continue;

        const csvValues = collectCsvValues(rows, csvHeader, isMulti);
        const missing = findMissingValues(csvValues, knownValues);
        if (missing.length) {
          const available = [...knownValues.values()].map((v) => v.name).sort();
          if (options.autoCreateFieldValues) {
            results[entityType].warnings.push({
              row: null,
              field: fc.name,
              message: `New value(s) will be created for "${fc.name}": ${missing.join(', ')}`,
              isInfo: true,
            });
          } else {
            results[entityType].warnings.push({
              row: null,
              field: fc.name,
              message: `Unknown "${fc.name}" value(s) — will be skipped: ${missing.join(', ')}. Available: ${available.join(', ')}`,
            });
          }
        }
      }
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

  const { migrationMode = false, workspaceCode = '', breadcrumb = false } = req.body || {};

  if (migrationMode && !workspaceCode) {
    return res.status(400).json({ error: 'workspaceCode is required when migrationMode is enabled' });
  }

  const sse = startSSE(res);

  try {
    sse.progress(`Fetching ${ENTITY_LABELS[type] || type} configuration…`, 5);
    const configs = await fetchEntityConfigs(pbFetch, withRetry);

    let nameMap = null;
    if (breadcrumb && !ROOT_ENTITY_TYPES.has(type)) {
      sse.progress('Building hierarchy map…', 12);
      const extraTypes = BREADCRUMB_EXTRA_TYPES[type] || [];
      nameMap = await fetchNameMapForTypes(
        [type, ...extraTypes],
        pbFetch,
        withRetry,
        (n) => sse.progress(`Building hierarchy map… (${n})`, 12)
      );
    }

    sse.progress(`Fetching ${ENTITY_LABELS[type] || type}…`, 15);

    const { headers, rows, count } = await exportEntityType(
      type,
      configs,
      pbFetch,
      withRetry,
      (fetched) => sse.progress(`Fetching ${ENTITY_LABELS[type] || type}… (${fetched} so far)`, 15 + Math.min(60, Math.floor(fetched / 10))),
      { breadcrumb, nameMap }
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

  const { migrationMode = false, workspaceCode = '', types: selectedTypes, breadcrumb = false } = req.body || {};

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
    const rawEntitiesByType = {};
    const perEntity = [];
    const total = typesToExport.length;

    for (let i = 0; i < total; i++) {
      const entityType = typesToExport[i];
      const label = ENTITY_LABELS[entityType] || entityType;
      const basePercent = 5 + Math.floor((i / total) * 80);

      sse.progress(`Exporting ${label}…`, basePercent);

      try {
        const { headers, rows, count, rawEntities } = await exportEntityType(
          entityType,
          configs,
          pbFetch,
          withRetry,
          (fetched) => sse.progress(`Exporting ${label}… (${fetched})`, basePercent)
        );

        rowsByType[entityType] = rows;
        headersByType[entityType] = headers;
        rawEntitiesByType[entityType] = rawEntities;
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

    if (breadcrumb) {
      sse.progress('Building hierarchy map…', 85);

      const allRaw = Object.values(rawEntitiesByType).flat();

      // Check if any ancestor types were not exported — prefetch them silently for the name map
      const exportedTypeSet = new Set(typesToExport);
      const missingAncestors = new Set();
      for (const type of typesToExport) {
        for (const ancestor of (BREADCRUMB_EXTRA_TYPES[type] || [])) {
          if (!exportedTypeSet.has(ancestor)) missingAncestors.add(ancestor);
        }
      }

      let nameMap;
      if (missingAncestors.size > 0) {
        const extraMap = await fetchNameMapForTypes([...missingAncestors], pbFetch, withRetry);
        nameMap = { ...buildNameMapFromEntities(allRaw), ...extraMap };
      } else {
        nameMap = buildNameMapFromEntities(allRaw);
      }

      // Re-build rows with hierarchy_path for each exported type
      for (const entityType of typesToExport) {
        const entityConfig = configs[entityType] || { systemFields: [], customFields: [] };
        rowsByType[entityType] = (rawEntitiesByType[entityType] || [])
          .map((e) => entityToRow(e, entityType, entityConfig, { nameMap }));
        headersByType[entityType] = buildExportHeaders(entityType, entityConfig, { breadcrumb: true });
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

  let resolvedOptions = options || {};

  // Pre-fetch workspace members when skipInvalidOwner is enabled
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

    // ── Field value pre-flight ────────────────────────────────────────────────
    // Collect all select field IDs referenced across all uploaded entity types,
    // fetch their current allowed values, optionally auto-create missing ones,
    // and pass knownFieldValues into importCoordinator so it can skip unknowns.
    const knownFieldValues = new Map(); // fieldId → Map<normalised_name, {id, name}>
    const selectFieldIds = new Map();   // fieldId → { isMulti, canAutoCreate }

    for (const [entityType, fileData] of Object.entries(files || {})) {
      if (!fileData?.csvText) continue;
      const config = configs[entityType];
      const cols = (mappings?.[entityType]?.columns) || {};
      for (const internalId of Object.keys(cols)) {
        if (internalId.startsWith('custom__')) {
          const fieldId = internalId.slice(8);
          const fc = config?.customFields?.find((f) => f.id === fieldId);
          if (fc && (fc.displayType === 'SingleSelect' || fc.displayType === 'MultiSelect')) {
            selectFieldIds.set(fieldId, { isMulti: fc.displayType === 'MultiSelect', canAutoCreate: true });
          }
        }
        // Note: status is not included here — status can't be auto-created and
        // unknown status values are caught as hard errors in /preview.
      }
    }

    if (selectFieldIds.size > 0) {
      sse.progress('Fetching allowed field values…', 2);
      await Promise.all([...selectFieldIds.keys()].map(async (fieldId) => {
        try {
          knownFieldValues.set(fieldId, await fetchFieldValues(fieldId, pbFetch, withRetry));
        } catch (_) { /* non-fatal */ }
      }));

      // Auto-create missing values pre-flight (before any row is processed)
      if (resolvedOptions.autoCreateFieldValues) {
        // Parse each entity-type CSV at most once, no matter how many select fields reference it.
        const rowsByType = new Map();
        const getRows = (entityType, csvText) => {
          if (!rowsByType.has(entityType)) {
            rowsByType.set(entityType, parseEntityCsv(csvText).rows);
          }
          return rowsByType.get(entityType);
        };

        for (const [fieldId, { isMulti }] of selectFieldIds) {
          const known = knownFieldValues.get(fieldId);
          if (!known) continue;

          for (const [entityType, fileData] of Object.entries(files || {})) {
            if (!fileData?.csvText) continue;
            const cols = (mappings?.[entityType]?.columns) || {};
            const csvHeader = cols[`custom__${fieldId}`];
            if (!csvHeader) continue;

            const rows = getRows(entityType, fileData.csvText);
            const csvValues = collectCsvValues(rows, csvHeader, isMulti);
            const missing = findMissingValues(csvValues, known);

            for (const name of missing) {
              try {
                const created = await createFieldValue(fieldId, name, pbFetch, withRetry);
                known.set(name.toLowerCase().trim(), { id: created.id, name });
                sse.log('info', `Created field value "${name}"`, { fieldId });
              } catch (err) {
                sse.log('warn', `Could not create field value "${name}": ${parseApiError(err)}`, { fieldId });
              }
            }
          }
        }
      }
    }

    resolvedOptions = { ...resolvedOptions, knownFieldValues };

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
// POST /delete/by-type  — delete all entities of selected types (SSE)
//
// Body: {
//   types: string[],   // entity type keys, e.g. ['product', 'releaseGroup']
// }
//
// Algorithm:
//   1. Validate types.
//   2. Compute "effective types" = types whose ancestor is NOT also in types.
//      (If product is selected, component/feature/subfeature are cascade-deleted —
//       no need to DELETE them explicitly; PB handles it.)
//   3. For each effective type in ENTITY_ORDER: fetch all IDs, delete each via
//      DELETE /v2/entities/{id}. PB cascade-deletes descendants automatically.
// ---------------------------------------------------------------------------

// Cascade-ancestor map: for each type, which types (if selected) would cascade-delete it.
const ENTITY_CASCADE_ANCESTORS = {
  keyResult:  ['objective'],
  component:  ['product'],
  feature:    ['component', 'product'],
  subfeature: ['feature', 'component', 'product'],
  release:    ['releaseGroup'],
};

router.post('/delete/by-type', pbAuth, async (req, res) => {
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  const { types = [] } = req.body || {};

  const sse = startSSE(res);

  try {
    const unknownTypes = types.filter((t) => !ENTITY_ORDER.includes(t));
    if (unknownTypes.length) {
      sse.error(`Unknown entity types: ${unknownTypes.join(', ')}`);
      return;
    }
    if (!types.length) {
      sse.error('No entity types selected');
      return;
    }

    const typeSet = new Set(types);

    // Only delete types whose ancestor is not also being deleted (PB cascades the rest)
    const effectiveTypes = ENTITY_ORDER.filter((t) => {
      if (!typeSet.has(t)) return false;
      const ancestors = ENTITY_CASCADE_ANCESTORS[t] || [];
      return !ancestors.some((a) => typeSet.has(a));
    });

    const cascadedTypes = types.filter((t) => !effectiveTypes.includes(t));

    sse.progress(`Fetching entity counts for ${effectiveTypes.length} type(s)…`, 2);

    // Phase 1: Fetch all IDs per effective type
    const idsByType = {};
    let totalCount = 0;

    for (let i = 0; i < effectiveTypes.length; i++) {
      if (sse.isAborted()) break;
      const entityType = effectiveTypes[i];
      const label = ENTITY_LABELS[entityType] || entityType;
      sse.progress(`Fetching ${label}…`, 2 + Math.floor((i / effectiveTypes.length) * 16));
      const entities = await fetchAllPages(
        `/v2/entities?type[]=${entityType}`,
        `fetch ${entityType} IDs for delete-by-type`
      );
      idsByType[entityType] = entities.map((e) => e.id);
      totalCount += idsByType[entityType].length;
      sse.log('info', `${label}: ${idsByType[entityType].length} found`);
    }

    if (totalCount === 0) {
      sse.complete({
        perType: effectiveTypes.map((t) => ({ type: t, total: 0, deleted: 0, skipped: 0, errors: 0 })),
        total: 0, deleted: 0, skipped: 0, errors: 0,
        cascadedTypes,
      });
      return;
    }

    sse.progress(`Found ${totalCount} entities across ${effectiveTypes.length} type(s). Starting deletion…`, 18);

    // Phase 2: Delete
    let totalDeleted = 0;
    let totalSkipped = 0;
    let totalErrors  = 0;
    let processed    = 0;
    const perType    = [];

    for (const entityType of effectiveTypes) {
      if (sse.isAborted()) break;
      const ids   = idsByType[entityType];
      const label = ENTITY_LABELS[entityType] || entityType;
      let typeDeleted = 0, typeSkipped = 0, typeErrors = 0;

      sse.log('info', `Deleting ${label} (${ids.length})…`);

      for (const id of ids) {
        if (sse.isAborted()) break;
        try {
          await withRetry(
            () => pbFetch('delete', `/v2/entities/${id}`),
            `delete ${entityType} ${id}`
          );
          typeDeleted++;
          totalDeleted++;
          if (typeDeleted % 50 === 0) sse.log('info', `Deleted ${typeDeleted}/${ids.length} ${label}…`);
        } catch (err) {
          if (err.status === 404) {
            typeSkipped++;
            totalSkipped++;
          } else {
            typeErrors++;
            totalErrors++;
            sse.log('error', `Failed to delete ${entityType} ${id}: ${parseApiError(err)}`, { id, entityType });
          }
        }
        processed++;
        sse.progress(
          `Deleted ${totalDeleted} of ${totalCount}…`,
          18 + Math.round((processed / totalCount) * 82)
        );
      }

      perType.push({ type: entityType, total: ids.length, deleted: typeDeleted, skipped: typeSkipped, errors: typeErrors });
      sse.log(
        typeErrors > 0 ? 'warn' : 'success',
        `${label}: ${typeDeleted} deleted · ${typeSkipped} skipped · ${typeErrors} error(s)`
      );
    }

    sse.complete({ perType, total: totalCount, deleted: totalDeleted, skipped: totalSkipped, errors: totalErrors, cascadedTypes });
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
            if (sse.isAborted()) break;
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
