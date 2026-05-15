/**
 * Import coordinator for entities.
 *
 * Orchestrates a full multi-entity import run:
 *   1. Parse + normalize all uploaded CSVs
 *   2. Preflight seed idCache from rows that already have pb_id
 *   3. Main upsert loop (CREATE / PATCH per row, in dependency order)
 *   4. Relationship pass (parent links + connected links)
 *   5. Return summary for SSE complete event
 *
 * When options.relationshipsOnly = true, step 3 is skipped — only the
 * relationship pass runs. Used by POST /api/entities/relationships.
 */

const Papa = require('papaparse');
const { ENTITY_ORDER, ENTITY_LABELS, TYPE_CODE } = require('./meta');
const { parseEntityCsv } = require('./csvParser');
const { createIdCache } = require('./idCache');
const { applyMapping, buildCreatePayload, buildPatchPayload } = require('./fieldBuilder');
const { writeRelations } = require('./relationWriter');

/** Extract a readable message from a PB API error (mirrors parseApiError in routes/import.js) */
function parseApiError(err) {
  const msg = err.message || String(err);
  const jsonMatch = msg.match(/\{[\s\S]*"errors"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const first = parsed.errors?.[0];
      if (first) return first.detail || first.title || msg;
    } catch (_) {}
  }
  return msg;
}

/**
 * Run a full entity import.
 *
 * @param {{ [entityType]: { csvText, filename } }} files
 * @param {{ [entityType]: { columns: { internalId: csvHeader } } }} mappings
 * @param {{ [entityType]: { systemFields, customFields } }} configs  — from fetchEntityConfigs()
 * @param {{
 *   multiSelectMode?: string,
 *   bypassEmptyCells?: boolean,
 *   bypassHtmlFormatter?: boolean,
 *   fiscal_year_start_month?: number,
 *   autoGenerateExtKeys?: boolean,
 *   workspaceCode?: string,
 *   relationshipsOnly?: boolean,
 * }} options
 * @param {Function} pbFetch
 * @param {Function} withRetry
 * @param {{ onProgress: Function, onLog: Function }} callbacks
 * @param {{ abortSignal: { aborted: boolean } }} signals
 *
 * @returns {{
 *   perEntity: { entityType, created, updated, errors, skipped }[],
 *   totalCreated: number,
 *   totalUpdated: number,
 *   totalErrors: number,
 *   stopped: boolean,
 *   relationCounts: { parentLinks, relationshipLinks, errors },
 *   newIdsCsv?: string,
 * }}
 */
async function runImport(files, mappings, configs, options, pbFetch, withRetry, { onProgress, onLog }, { abortSignal }) {
  const {
    multiSelectMode          = 'set',
    bypassEmptyCells         = false,
    bypassHtmlFormatter      = false,
    skipInvalidOwner         = false,
    _memberEmails            = null,
    fiscal_year_start_month  = 1,
    autoGenerateExtKeys      = false,
    workspaceCode            = '',
    relationshipsOnly        = false,
    knownFieldValues         = null, // Map<fieldId, Map<normalised_name, {id,name}>> — passed by /run
  } = options || {};

  const idCache   = createIdCache();
  const perEntity = [];
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalErrors  = 0;
  let stopped      = false;
  const autoGenRows = []; // { entityType, ext_key, pb_id } for newIdsCsv

  // ── Step 1: Parse + normalize all files ───────────────────────────────────
  const normalizedByType = {};
  for (const type of ENTITY_ORDER) {
    if (!files[type]) continue;
    const { rows, errors, tooManyFieldsRows } = parseEntityCsv(files[type].csvText);
    if (errors.length) {
      onLog('warn', `CSV parse warnings for ${ENTITY_LABELS[type]}: ${errors.join('; ')}`);
    }
    if (tooManyFieldsRows.length) {
      onLog('error', `${ENTITY_LABELS[type]}: ${tooManyFieldsRows.length} row(s) have too many columns — row(s) ${tooManyFieldsRows.join(', ')}. Multi-value relationship cells (e.g. blocked_by_ext_key, connected_objs_ext_key) must be wrapped in double quotes when they contain commas. Example: "OBJ-1,OBJ-2". Fix these rows and re-upload.`, { entityType: type });
      continue;
    }
    const mapping = mappings[type] || { columns: {} };
    normalizedByType[type] = applyMapping(rows, type, mapping);
    const rowCount = normalizedByType[type].length;
    if (rowCount === 0) {
      onLog('warn', `${ENTITY_LABELS[type]}: no data rows found — skipped`, { entityType: type });
    } else if (rowCount > 50000) {
      onLog('warn', `${ENTITY_LABELS[type]}: ${rowCount.toLocaleString()} rows — large file, this may take a while`, { entityType: type });
    }
  }

  // ── Step 1.5: Filter unknown custom select values ────────────────────────
  // When knownFieldValues is provided, remove or trim any custom select/multiselect
  // values in normalized rows that aren't in the allowed set. This prevents the
  // PB API from rejecting rows (unknown values would cause a 422) while still
  // importing the rest of the row's data. Applies after auto-create, so with
  // autoCreateFieldValues ON all values should be known and nothing is stripped.
  if (knownFieldValues && knownFieldValues.size > 0) {
    for (const type of Object.keys(normalizedByType)) {
      const config = configs[type] || { customFields: [] };
      for (const row of normalizedByType[type]) {
        for (const [key, rawVal] of Object.entries(row)) {
          if (!key.startsWith('custom__')) continue;
          const fieldId = key.slice(8);
          const known = knownFieldValues.get(fieldId);
          if (!known) continue;
          const fc = config.customFields.find((f) => f.id === fieldId);
          if (!fc) continue;
          const isMulti = fc.displayType === 'MultiSelect';

          if (rawVal == null || String(rawVal).trim() === '') continue;

          if (isMulti) {
            const parts = String(rawVal).split(',').map((s) => s.trim()).filter(Boolean);
            const knownParts = parts.filter((p) => known.has(p.toLowerCase()));
            const skipped = parts.filter((p) => !known.has(p.toLowerCase()));
            if (skipped.length) {
              onLog('warn', `Skipping unknown "${fc.name}" value(s): ${skipped.join(', ')}`, { entityType: type });
              row[key] = knownParts.join(', ') || null;
            }
          } else {
            if (!known.has(String(rawVal).toLowerCase().trim())) {
              onLog('warn', `Skipping unknown "${fc.name}" value "${rawVal}"`, { entityType: type });
              row[key] = null;
            }
          }
        }
      }
    }
  }

  // ── Step 2: Preflight seed idCache ────────────────────────────────────────
  idCache.seed(normalizedByType);

  // ── Step 3: Main upsert loop ──────────────────────────────────────────────
  if (!relationshipsOnly) {
    const types = ENTITY_ORDER.filter((t) => normalizedByType[t]);
    for (let ti = 0; ti < types.length; ti++) {
      if (abortSignal.aborted) { stopped = true; break; }

      const type  = types[ti];
      const rows  = normalizedByType[type];
      const config = configs[type] || { systemFields: [], customFields: [] };
      const pctBase = 5 + Math.round((ti / types.length) * 80);

      onProgress(`Importing ${ENTITY_LABELS[type]}…`, pctBase);

      let typeCreated = 0;
      let typeUpdated = 0;
      let typeErrors  = 0;
      let typeSkipped = 0;
      let autoCounter = 1; // per-type counter for ext_key auto-generation

      for (let i = 0; i < rows.length; i++) {
        if (abortSignal.aborted) { stopped = true; break; }

        const row    = rows[i];
        const rowNum = i + 1;
        const pct    = pctBase + Math.round(((i + 1) / rows.length) * (80 / types.length));
        onProgress(`${ENTITY_LABELS[type]} — row ${rowNum}/${rows.length}`, pct);

        try {
          if (row._pbId) {
            // ── PATCH ──────────────────────────────────────────────────────
            const payload = buildPatchPayload(row, type, config, { multiSelectMode, bypassEmptyCells, bypassHtmlFormatter, skipInvalidOwner, _memberEmails, fiscal_year_start_month });
            if (process.env.DEBUG_MODE === 'true') console.log(`[IMPORT PAYLOAD] PATCH ${type} row ${rowNum} id=${row._pbId}`, JSON.stringify(payload));
            await withRetry(
              () => pbFetch('patch', `/v2/entities/${encodeURIComponent(row._pbId)}`, payload),
              `patch:${type}`,
            );
            typeUpdated++;
            onLog('success', `Row ${rowNum}: Updated ${type} ${row._pbId}`, { entityType: type, uuid: row._pbId, row: rowNum });
          } else {
            // ── CREATE ─────────────────────────────────────────────────────
            // Auto-generate ext_key if requested and not already set
            if (autoGenerateExtKeys && !row._extKey) {
              const code = TYPE_CODE[type] || type.slice(0, 4).toUpperCase();
              row._extKey = `${workspaceCode}-${code}-${autoCounter}`;
              autoCounter++;
            }

            const payload = buildCreatePayload(row, type, config, idCache, { multiSelectMode, bypassEmptyCells, bypassHtmlFormatter, skipInvalidOwner, _memberEmails, fiscal_year_start_month });
            if (process.env.DEBUG_MODE === 'true') console.log(`[IMPORT PAYLOAD] CREATE ${type} row ${rowNum}`, JSON.stringify(payload));
            const resp = await withRetry(
              () => pbFetch('post', '/v2/entities', payload),
              `create:${type}`,
            );

            const newPbId = resp?.data?.id;
            if (!newPbId) throw new Error('API response missing data.id');

            row._pbId = newPbId;
            if (row._extKey) {
              idCache.set(type, row._extKey, newPbId);
            }
            if (autoGenerateExtKeys && row._extKey) {
              autoGenRows.push({ entityType: type, ext_key: row._extKey, pb_id: newPbId });
            }

            typeCreated++;
            onLog('success', `Row ${rowNum}: Created ${type} → ${newPbId}${row._extKey ? ` (${row._extKey})` : ''}`, { entityType: type, uuid: newPbId, row: rowNum });
          }
        } catch (err) {
          typeErrors++;
          const msg = parseApiError(err);
          const statusInfo = err.status ? ` (HTTP ${err.status})` : '';
          onLog('error', `Row ${rowNum}: ${msg}${statusInfo}`, { entityType: type, row: rowNum });
        }
      }

      perEntity.push({ entityType: type, created: typeCreated, updated: typeUpdated, errors: typeErrors, skipped: typeSkipped });
      totalCreated += typeCreated;
      totalUpdated += typeUpdated;
      totalErrors  += typeErrors;
    }
  } else {
    // relationshipsOnly: populate perEntity stubs so the complete summary is consistent
    for (const type of ENTITY_ORDER.filter((t) => normalizedByType[t])) {
      perEntity.push({ entityType: type, created: 0, updated: 0, errors: 0, skipped: 0 });
    }
  }

  // ── Step 4: Relationship pass ─────────────────────────────────────────────
  if (!stopped) {
    onProgress('Writing relationships…', 93);
    const allRows = ENTITY_ORDER.flatMap((t) => normalizedByType[t] || []);
    const relationCounts = await writeRelations(allRows, idCache, pbFetch, withRetry, onLog);
    totalErrors += relationCounts.errors;

    onProgress('Done', 100);

    // ── Step 5: newIdsCsv ──────────────────────────────────────────────────
    let newIdsCsv;
    if (autoGenerateExtKeys && autoGenRows.length) {
      newIdsCsv = Papa.unparse(autoGenRows, { header: true, columns: ['entityType', 'ext_key', 'pb_id'] });
    }

    return { perEntity, totalCreated, totalUpdated, totalErrors, stopped, relationCounts, newIdsCsv };
  }

  return { perEntity, totalCreated, totalUpdated, totalErrors, stopped, relationCounts: { parentLinks: 0, relationshipLinks: 0, errors: 0 } };
}

module.exports = { runImport };
