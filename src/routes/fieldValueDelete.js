/**
 * Field value delete routes
 *
 * GET  /api/tag-values/fields            → list all select-type custom fields across all entity types
 * POST /api/tag-values/values            → list all values for a given field
 * POST /api/tag-values/delete/all        → delete every value from a field (SSE)
 * POST /api/tag-values/delete/by-csv     → delete values whose name appears in a CSV column (SSE)
 * POST /api/tag-values/delete/by-diff    → delete values whose name does NOT appear in a CSV column (SSE)
 * POST /api/tag-values/delete/by-ids     → delete specific values by { id, name } pairs (SSE)
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
const { fetchFieldValues } = require('../lib/fieldValues');
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

async function deleteValue(pbFetch, withRetry, fieldId, valueId) {
  await withRetry(
    () => pbFetch('delete', `/v2/entities/fields/${encodeURIComponent(fieldId)}/values/${encodeURIComponent(valueId)}?force=true`),
    `delete field value ${valueId}`
  );
}

function collectSelectFields(entry, entityType, fieldMap) {
  for (const [id, f] of Object.entries(entry.fields || {})) {
    if (id.includes('.') || EXCLUDED_FIELD_IDS.has(id) || STANDARD_FIELD_IDS.has(id)) continue;
    if (!UUID_RE.test(id)) continue;
    const schema = normalizeSchema(f.schema);
    const displayType = schemaToType(schema);
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
// GET /api/tag-values/fields
// Discovers all Tags / MultiSelect / SingleSelect custom fields across every
// entity type and company, de-duplicated by field UUID.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/fields', pbAuth, async (_req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const fieldMap = new Map();

  // Entity types (feature, objective, initiative, etc.)
  try {
    let url = '/v2/entities/configurations';
    while (url) {
      const r = await withRetry(() => pbFetch('get', url), 'fetch entity configurations');
      for (const entry of (r.data || [])) collectSelectFields(entry, entry.type, fieldMap);
      url = r.links?.next || null;
    }
  } catch (err) {
    console.error('tag-values/fields entity configs:', err.message);
  }

  // Company (separate endpoint — not included in the paginated list)
  try {
    const r = await withRetry(() => pbFetch('get', '/v2/entities/configurations/company'), 'fetch company config');
    collectSelectFields(r.data || {}, 'company', fieldMap);
  } catch (_) { /* non-fatal */ }

  const fields = [...fieldMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  res.json({ fields });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tag-values/values
// Body: { fieldId }
// Returns all allowed values for a field as [{ id, name }], sorted by name.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/values', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { fieldId } = req.body;
  if (!fieldId || !UUID_RE.test(fieldId)) return res.status(400).json({ error: 'Invalid or missing fieldId' });
  try {
    const valMap = await fetchFieldValues(fieldId, pbFetch, withRetry);
    const values = [...valMap.values()].sort((a, b) => a.name.localeCompare(b.name));
    res.json({ values });
  } catch (err) {
    console.error('tag-values/values:', err.message);
    res.status(err.status || 500).json({ error: parseApiError(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tag-values/delete/all
// Body: { fieldId }
// Fetches all values for the field then deletes them one-by-one with force=true.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/delete/all', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { fieldId } = req.body;
  if (!fieldId || !UUID_RE.test(fieldId)) return res.status(400).json({ error: 'Invalid or missing fieldId' });

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
    let deleted = 0, errors = 0;

    for (let i = 0; i < values.length; i++) {
      if (sse.isAborted()) break;
      const v = values[i];
      try {
        await deleteValue(pbFetch, withRetry, fieldId, v.id);
        deleted++;
        sse.log('success', `Deleted "${v.name}"`);
      } catch (err) {
        if (err.status === 404) {
          sse.log('warn', `"${v.name}" not found — skipped`);
        } else {
          errors++;
          sse.log('error', `Failed to delete "${v.name}": ${parseApiError(err)}`);
        }
      }
      sse.progress(`Deleted ${deleted} of ${values.length}…`, 10 + Math.round((i + 1) / values.length * 90));
    }

    sse.complete({ total: values.length, deleted, errors, stopped: sse.isAborted() });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tag-values/delete/by-csv
// Body: { fieldId, csvText, column }
// Deletes values whose name (case-insensitive) appears in the given CSV column.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/delete/by-csv', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { fieldId, csvText, column } = req.body;
  if (!fieldId || !UUID_RE.test(fieldId) || !csvText || !column) {
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
    let deleted = 0, errors = 0;

    for (let i = 0; i < toDelete.length; i++) {
      if (sse.isAborted()) break;
      const v = toDelete[i];
      try {
        await deleteValue(pbFetch, withRetry, fieldId, v.id);
        deleted++;
        sse.log('success', `Deleted "${v.name}"`);
      } catch (err) {
        if (err.status === 404) {
          sse.log('warn', `"${v.name}" not found — skipped`);
        } else {
          errors++;
          sse.log('error', `Failed to delete "${v.name}": ${parseApiError(err)}`);
        }
      }
      sse.progress(`Deleted ${deleted} of ${toDelete.length}…`, 10 + Math.round((i + 1) / toDelete.length * 90));
    }

    sse.complete({ total: toDelete.length, deleted, errors, stopped: sse.isAborted() });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tag-values/delete/by-diff
// Body: { fieldId, csvText, column }
// Keeps values whose name (case-insensitive) appears in the CSV column;
// deletes everything else.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/delete/by-diff', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { fieldId, csvText, column } = req.body;
  if (!fieldId || !UUID_RE.test(fieldId) || !csvText || !column) {
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
    let deleted = 0, errors = 0;

    for (let i = 0; i < toDelete.length; i++) {
      if (sse.isAborted()) break;
      const v = toDelete[i];
      try {
        await deleteValue(pbFetch, withRetry, fieldId, v.id);
        deleted++;
        sse.log('success', `Deleted "${v.name}"`);
      } catch (err) {
        if (err.status === 404) {
          sse.log('warn', `"${v.name}" not found — skipped`);
        } else {
          errors++;
          sse.log('error', `Failed to delete "${v.name}": ${parseApiError(err)}`);
        }
      }
      sse.progress(`Deleted ${deleted} of ${toDelete.length}…`, 10 + Math.round((i + 1) / toDelete.length * 90));
    }

    sse.complete({ total: all.length, deleted, kept, errors, stopped: sse.isAborted() });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/tag-values/delete/by-ids
// Body: { fieldId, values: [{ id, name }] }
// Deletes the explicitly provided value IDs (from the pick-mode checklist).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/delete/by-ids', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { fieldId, values } = req.body;
  if (!fieldId || !UUID_RE.test(fieldId) || !Array.isArray(values) || !values.length) {
    return res.status(400).json({ error: 'Invalid or missing fieldId or values' });
  }

  const sse = startSSE(res);
  try {
    let deleted = 0, errors = 0;

    for (let i = 0; i < values.length; i++) {
      if (sse.isAborted()) break;
      const { id, name } = values[i];
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
      sse.progress(`Deleted ${deleted} of ${values.length}…`, Math.round((i + 1) / values.length * 100));
    }

    sse.complete({ total: values.length, deleted, errors, stopped: sse.isAborted() });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

module.exports = router;
