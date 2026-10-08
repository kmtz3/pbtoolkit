/**
 * Field value delete routes
 *
 * GET  /api/field-values/fields            → list all select-type custom fields across all entity types
 * POST /api/field-values/values            → list all values for a given field
 * POST /api/field-values/delete/all        → delete every value from a field (SSE)
 * POST /api/field-values/delete/by-csv     → delete values whose name appears in a CSV column (SSE)
 * POST /api/field-values/delete/by-diff    → delete values whose name does NOT appear in a CSV column (SSE)
 * POST /api/field-values/delete/by-ids     → delete specific values by { id, name } pairs (SSE)
 * POST /api/field-values/create            → create one or more values on a field (JSON)
 * PATCH /api/field-values/rename           → rename a single value in place (JSON)
 * POST /api/field-values/delete/one        → delete a single value without SSE (JSON, live editor)
 *
 * All deletions use ?force=true so the value is removed from the field's option list
 * AND unset from every entity that currently has it assigned.
 *
 * Supported field types: Tags, MultiSelect, SingleSelect
 * (Status fields are not supported by this endpoint — managed via status lifecycle.)
 */

const express = require('express');
const { parseCSV } = require('../lib/csvUtils');
const { startSSE } = require('../lib/sse');
const { parseApiError } = require('../lib/errorUtils');
const { UUID_RE } = require('../lib/constants');
const { pbAuth } = require('../middleware/pbAuth');
const { fetchFieldValues, createFieldValue, renameFieldValue } = require('../lib/fieldValues');
const {
  EXCLUDED_FIELD_IDS,
  STANDARD_FIELD_IDS,
  schemaToType,
  normalizeSchema,
} = require('../services/entities/configCache');

const router = express.Router();

function isSelectType(displayType) {
  const t = (displayType || '').toLowerCase();
  return t === 'tags' || t === 'multiselect' || t === 'singleselect';
}

function isValidFieldId(id) {
  return typeof id === 'string' && (UUID_RE.test(id) || id === 'tags');
}

function isValidValueId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

async function deleteValue(pbFetch, withRetry, fieldId, valueId) {
  await withRetry(
    () => pbFetch('delete', `/v2/entities/fields/${encodeURIComponent(fieldId)}/values/${encodeURIComponent(valueId)}?force=true`),
    `delete field value ${valueId}`
  );
}

/**
 * Shared SSE delete loop used by every bulk-delete route.
 * Deletes each { id, name } in `items` with force=true, honouring client abort,
 * treating 404 as a warn-and-skip, and emitting progress as
 * basePct + (i+1)/n * spanPct. Returns { deleted, errors }.
 */
async function runDeleteLoop(sse, { pbFetch, withRetry, fieldId, items, basePct = 10, spanPct = 90 }) {
  let deleted = 0, errors = 0;
  for (let i = 0; i < items.length; i++) {
    if (sse.isAborted()) break;
    const { id, name } = items[i];
    try {
      await deleteValue(pbFetch, withRetry, fieldId, id);
      deleted++;
      sse.log('success', `Deleted "${name}"`);
    } catch (err) {
      if (err.status === 404) {
        sse.log('warn', `"${name}" not found — skipped`);
      } else {
        errors++;
        sse.log('error', `Failed to delete "${name}": ${parseApiError(err)}`);
      }
    }
    sse.progress(`Deleted ${deleted} of ${items.length}…`, basePct + Math.round((i + 1) / items.length * spanPct));
  }
  return { deleted, errors };
}

function collectSelectFields(entry, entityType, fieldMap) {
  for (const [id, f] of Object.entries(entry.fields || {})) {
    if (id.includes('.') || EXCLUDED_FIELD_IDS.has(id) || STANDARD_FIELD_IDS.has(id)) continue;
    if (!UUID_RE.test(id) && id !== 'tags') continue;
    const schema = normalizeSchema(f.schema);
    const displayType = id === 'tags' ? 'Tags' : schemaToType(schema);
    if (!isSelectType(displayType)) continue;
    if (fieldMap.has(id)) {
      const existing = fieldMap.get(id);
      if (!existing.entityTypes.includes(entityType)) existing.entityTypes.push(entityType);
    } else {
      fieldMap.set(id, { id, name: f.name || id, displayType, entityTypes: [entityType] });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/field-values/fields
// Discovers all Tags / MultiSelect / SingleSelect custom fields across every
// entity type and company, de-duplicated by field UUID.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/fields', pbAuth, async (_req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const fieldMap = new Map();

  try {
    // Entity types (feature, objective, initiative, etc.)
    let url = '/v2/entities/configurations';
    while (url) {
      const r = await withRetry(() => pbFetch('get', url), 'fetch entity configurations');
      for (const entry of (r.data || [])) collectSelectFields(entry, entry.type, fieldMap);
      url = r.links?.next || null;
    }

    // Company (separate endpoint — not included in the paginated list).
    // A 404 here just means no company config — anything else is a real failure.
    try {
      const r = await withRetry(() => pbFetch('get', '/v2/entities/configurations/company'), 'fetch company config');
      collectSelectFields(r.data || {}, 'company', fieldMap);
    } catch (err) {
      if (err.status !== 404) throw err;
    }

    const fields = [...fieldMap.values()].sort((a, b) => {
      if (a.id === 'tags') return -1;
      if (b.id === 'tags') return 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ fields });
  } catch (err) {
    console.error('field-values/fields:', err.message);
    res.status(err.status || 500).json({ error: parseApiError(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/field-values/values
// Body: { fieldId }
// Returns all allowed values for a field as [{ id, name }], sorted by name.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/values', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { fieldId } = req.body;
  if (!isValidFieldId(fieldId)) return res.status(400).json({ error: 'Invalid or missing fieldId' });
  try {
    const valMap = await fetchFieldValues(fieldId, pbFetch, withRetry);
    const values = [...valMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    res.json({ values });
  } catch (err) {
    console.error('field-values/values:', err.message);
    res.status(err.status || 500).json({ error: parseApiError(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/field-values/delete/all
// Body: { fieldId }
// Fetches all values for the field then deletes them one-by-one with force=true.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/delete/all', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { fieldId } = req.body;
  if (!isValidFieldId(fieldId)) return res.status(400).json({ error: 'Invalid or missing fieldId' });

  const sse = startSSE(res);
  try {
    sse.progress('Fetching field values…', 5);
    const valMap = await fetchFieldValues(fieldId, pbFetch, withRetry);
    const values = [...valMap.values()];

    if (!values.length) {
      sse.complete({ total: 0, deleted: 0, errors: 0 });
      return;
    }

    sse.progress(`Found ${values.length} values. Deleting…`, 10);
    const { deleted, errors } = await runDeleteLoop(sse, { pbFetch, withRetry, fieldId, items: values });

    sse.complete({ total: values.length, deleted, errors, stopped: sse.isAborted() });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/field-values/delete/by-csv
// Body: { fieldId, csvText, column }
// Deletes values whose name (case-insensitive) appears in the given CSV column.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/delete/by-csv', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { fieldId, csvText, column } = req.body;
  if (!isValidFieldId(fieldId) || typeof csvText !== 'string' || !csvText || typeof column !== 'string' || !column) {
    return res.status(400).json({ error: 'Invalid or missing fieldId, csvText, or column' });
  }

  const sse = startSSE(res);
  try {
    const { rows } = parseCSV(csvText);
    const csvNames = new Set(
      rows.map((r) => (r[column] || '').trim().toLowerCase()).filter(Boolean)
    );

    if (!csvNames.size) {
      sse.complete({ total: 0, deleted: 0, errors: 0 });
      return;
    }

    sse.progress('Fetching field values…', 5);
    const valMap = await fetchFieldValues(fieldId, pbFetch, withRetry);
    const toDelete = [...valMap.values()].filter((v) => csvNames.has(v.name.toLowerCase().trim()));

    if (!toDelete.length) {
      sse.complete({ total: 0, deleted: 0, errors: 0, unmatched: csvNames.size });
      return;
    }

    sse.progress(`Matched ${toDelete.length} of ${csvNames.size} CSV names. Deleting…`, 10);
    const { deleted, errors } = await runDeleteLoop(sse, { pbFetch, withRetry, fieldId, items: toDelete });

    sse.complete({ total: toDelete.length, deleted, errors, stopped: sse.isAborted() });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/field-values/delete/by-diff
// Body: { fieldId, csvText, column }
// Keeps values whose name (case-insensitive) appears in the CSV column;
// deletes everything else.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/delete/by-diff', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { fieldId, csvText, column } = req.body;
  if (!isValidFieldId(fieldId) || typeof csvText !== 'string' || !csvText || typeof column !== 'string' || !column) {
    return res.status(400).json({ error: 'Invalid or missing fieldId, csvText, or column' });
  }

  const sse = startSSE(res);
  try {
    const { rows } = parseCSV(csvText);
    const keepNames = new Set(
      rows.map((r) => (r[column] || '').trim().toLowerCase()).filter(Boolean)
    );

    sse.progress('Fetching field values…', 5);
    const valMap = await fetchFieldValues(fieldId, pbFetch, withRetry);
    const all = [...valMap.values()];
    const toDelete = all.filter((v) => !keepNames.has(v.name.toLowerCase().trim()));
    const kept = all.length - toDelete.length;

    if (!toDelete.length) {
      sse.complete({ total: all.length, deleted: 0, kept, errors: 0 });
      return;
    }

    sse.progress(`Keeping ${kept}, deleting ${toDelete.length}…`, 10);
    const { deleted, errors } = await runDeleteLoop(sse, { pbFetch, withRetry, fieldId, items: toDelete });

    sse.complete({ total: all.length, deleted, kept, errors, stopped: sse.isAborted() });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/field-values/delete/by-ids
// Body: { fieldId, values: [{ id, name }] }
// Deletes the explicitly provided value IDs (from the pick-mode checklist).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/delete/by-ids', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { fieldId, values } = req.body;
  if (!isValidFieldId(fieldId) || !Array.isArray(values) || !values.length) {
    return res.status(400).json({ error: 'Invalid or missing fieldId or values' });
  }
  if (!values.every((v) => v && typeof v === 'object' && isValidValueId(v.id))) {
    return res.status(400).json({ error: 'Every value must have a valid UUID id' });
  }
  const items = values.map((v) => ({ id: v.id, name: typeof v.name === 'string' ? v.name : v.id }));

  const sse = startSSE(res);
  try {
    const { deleted, errors } = await runDeleteLoop(sse, { pbFetch, withRetry, fieldId, items, basePct: 0, spanPct: 100 });
    sse.complete({ total: items.length, deleted, errors, stopped: sse.isAborted() });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/field-values/create
// Body: { fieldId, names: string[] }
// Creates one or more new values for a select-type field.
// Returns { created: [{id, name}], errors: [{name, error}] }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/create', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { fieldId, names } = req.body;
  if (!isValidFieldId(fieldId) || !Array.isArray(names) || !names.length) {
    return res.status(400).json({ error: 'Invalid or missing fieldId or names' });
  }
  if (!names.some((n) => typeof n === 'string' && n.trim())) {
    return res.status(400).json({ error: 'names must contain at least one non-empty string' });
  }
  try {
    const created = [], errors = [];
    for (const name of names) {
      if (typeof name !== 'string') {
        errors.push({ name: String(name), error: 'Name must be a string' });
        continue;
      }
      const trimmed = name.trim();
      if (!trimmed) continue;
      try {
        const v = await createFieldValue(fieldId, trimmed, pbFetch, withRetry);
        created.push(v);
      } catch (err) {
        errors.push({ name: trimmed, error: parseApiError(err) });
      }
    }
    res.json({ created, errors });
  } catch (err) {
    console.error('field-values/create:', err.message);
    res.status(err.status || 500).json({ error: parseApiError(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/field-values/rename
// Body: { fieldId, valueId, name }
// Renames a single value in-place (assignments are preserved).
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/rename', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { fieldId, valueId, name } = req.body;
  if (!isValidFieldId(fieldId) || !isValidValueId(valueId) || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Invalid or missing fieldId, valueId, or name' });
  }
  try {
    const v = await renameFieldValue(fieldId, valueId, name.trim(), pbFetch, withRetry);
    res.json(v);
  } catch (err) {
    res.status(err.status || 500).json({ error: parseApiError(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/field-values/delete/one
// Body: { fieldId, valueId }
// Deletes a single value without SSE — used by the live editor for per-row deletion.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/delete/one', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { fieldId, valueId } = req.body;
  if (!isValidFieldId(fieldId) || !isValidValueId(valueId)) {
    return res.status(400).json({ error: 'Invalid or missing fieldId or valueId' });
  }
  try {
    await deleteValue(pbFetch, withRetry, fieldId, valueId);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: parseApiError(err) });
  }
});

module.exports = router;
module.exports.runDeleteLoop = runDeleteLoop;
