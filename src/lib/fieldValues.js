/**
 * Field value management helpers.
 *
 * Supports listing and creating values for single_select, multi_select,
 * and tag custom fields (UUID-keyed). The system "status" field can be
 * listed but NOT created — its values are managed via status lifecycle.
 *
 * All name comparisons are case-insensitive + trimmed so "In Progress"
 * matches "in progress" from a CSV cell.
 */

const { formatCustomFieldValue } = require('./fieldFormat');
const { extractCursor } = require('./pbClient');
const { parseApiError } = require('./errorUtils');

/**
 * Fetch all allowed values for a field.
 * Cursor-paginated; handles any field size.
 *
 * For the "status" system field, each value carries assignedEntityTypes[].
 * For custom select fields, each value has id + name (no assignedEntityTypes).
 *
 * @param {string}   fieldId   UUID (custom field) or "status"
 * @param {Function} pbFetch
 * @param {Function} withRetry
 * @returns {Promise<Map<string, {id: string, name: string, assignedEntityTypes?: string[]}>>}
 *   Keyed by normalised name (lower + trimmed).
 */
async function fetchFieldValues(fieldId, pbFetch, withRetry) {
  const map = new Map();
  let cursor = null;

  do {
    const url = cursor
      ? `/v2/entities/fields/${encodeURIComponent(fieldId)}/values?pageCursor=${encodeURIComponent(cursor)}`
      : `/v2/entities/fields/${encodeURIComponent(fieldId)}/values`;

    const r = await withRetry(
      () => pbFetch('get', url),
      `fetch field values for ${fieldId}`
    );

    for (const item of (r.data || [])) {
      const name = item.fields?.name;
      if (!name) continue;
      const entry = { id: item.id, name };
      if (item.fields.assignedEntityTypes) {
        entry.assignedEntityTypes = item.fields.assignedEntityTypes;
      }
      map.set(name.toLowerCase().trim(), entry);
    }

    cursor = extractCursor(r.links?.next);
  } while (cursor);

  return map;
}

/**
 * Create a new value for a select-type field (not "status").
 * Color is auto-assigned by PB when omitted.
 *
 * @param {string}   fieldId   UUID of the field
 * @param {string}   name      Value name to create
 * @param {Function} pbFetch
 * @param {Function} withRetry
 * @returns {Promise<{id: string, name: string}>}
 */
async function createFieldValue(fieldId, name, pbFetch, withRetry) {
  const r = await withRetry(
    () => pbFetch('post', `/v2/entities/fields/${encodeURIComponent(fieldId)}/values`, {
      data: { fields: { name } },
    }),
    `create field value "${name}" for ${fieldId}`
  );
  return { id: r.data.id, name };
}

/**
 * Collect all distinct non-empty values from CSV rows for a given column.
 * For multi-select fields, splits each cell by comma.
 *
 * @param {object[]} rows       Parsed CSV rows (object[])
 * @param {string}   csvColumn  Column header name
 * @param {boolean}  isMulti    True for multi-select / tags fields
 * @returns {Set<string>}       Distinct, trimmed values from the CSV
 */
function collectCsvValues(rows, csvColumn, isMulti) {
  const result = new Set();
  for (const row of rows) {
    const raw = row[csvColumn];
    if (raw == null) continue;
    const s = String(raw).trim();
    if (!s) continue;
    if (isMulti) {
      for (const part of s.split(',')) {
        const v = part.trim();
        if (v) result.add(v);
      }
    } else {
      result.add(s);
    }
  }
  return result;
}

/**
 * Return the values from csvValues that are NOT present in knownValues.
 * Comparison is case-insensitive + trimmed.
 *
 * @param {Set<string>}                                csvValues
 * @param {Map<string, {id, name, assignedEntityTypes?}>} knownValues  Normalised-key map
 * @returns {string[]}  Original (un-normalised) values not found in known map
 */
function findMissingValues(csvValues, knownValues) {
  const missing = [];
  for (const v of csvValues) {
    if (!knownValues.has(v.toLowerCase().trim())) {
      missing.push(v);
    }
  }
  return missing;
}

/**
 * From a full status value map (all entity types), return only those whose
 * assignedEntityTypes includes the given entity type.
 *
 * @param {Map<string, {id, name, assignedEntityTypes}>} allStatusValues
 * @param {string} entityType  e.g. "feature"
 * @returns {Map<string, {id, name}>}
 */
function filterStatusValuesByType(allStatusValues, entityType) {
  const filtered = new Map();
  for (const [key, val] of allStatusValues) {
    if (!val.assignedEntityTypes || val.assignedEntityTypes.includes(entityType)) {
      filtered.set(key, val);
    }
  }
  return filtered;
}

/**
 * Filter a custom field value against the allowed set when knownFieldValues is provided.
 * For select: returns the formatted value if known, undefined if unknown (caller skips).
 * For multiselect/tags: filters items to only known values; returns undefined if none remain.
 * For non-select types: always returns the formatted value unchanged.
 *
 * Shared by companies.js and users.js import paths.
 */
function filterSelectValue(rawVal, cf, knownFieldValues) {
  const isSelect = cf.fieldType === 'select';
  const isMulti  = cf.fieldType === 'multiselect' || cf.fieldType === 'tags';

  if (!knownFieldValues || (!isSelect && !isMulti)) {
    return formatCustomFieldValue(rawVal, cf.fieldType);
  }

  const known = knownFieldValues.get(cf.fieldId);
  if (!known) return formatCustomFieldValue(rawVal, cf.fieldType); // no data — pass through

  if (isSelect) {
    const s = String(rawVal).trim();
    return known.has(s.toLowerCase()) ? { name: s } : undefined;
  }

  // multiselect / tags — filter items
  const parts = String(rawVal).split(',').map((x) => x.trim()).filter(Boolean);
  const knownParts = parts.filter((p) => known.has(p.toLowerCase()));
  if (!knownParts.length) return undefined;
  return knownParts.map((n) => ({ name: n }));
}

/**
 * Filter mapping.customFields[] down to the select/multiselect/tags entries.
 */
function getSelectFields(mapping) {
  return (mapping?.customFields || []).filter(
    (cf) => cf.fieldType === 'select' || cf.fieldType === 'multiselect' || cf.fieldType === 'tags'
  );
}

/**
 * Build warning messages for select-field values present in the CSV but not in PB.
 * Used by /preview endpoints (companies, users).
 *
 * Returns an array of { field, message, isInfo? } warnings.
 * If autoCreateFieldValues is true, missing values produce info-level warnings
 * indicating they will be created on run.
 */
async function collectFieldValueWarnings(mapping, rows, pbFetch, withRetry, { autoCreateFieldValues = false } = {}) {
  const selectFields = getSelectFields(mapping);
  const warnings = [];
  if (!selectFields.length) return warnings;

  const results = await Promise.allSettled(
    selectFields.map((cf) => fetchFieldValues(cf.fieldId, pbFetch, withRetry))
  );

  selectFields.forEach((cf, idx) => {
    if (results[idx].status !== 'fulfilled') return;
    const knownValues = results[idx].value;
    const isMulti = cf.fieldType === 'multiselect' || cf.fieldType === 'tags';
    const csvValues = collectCsvValues(rows, cf.csvColumn, isMulti);
    const missing = findMissingValues(csvValues, knownValues);
    if (!missing.length) return;
    const fieldLabel = cf.name || cf.csvColumn;
    if (autoCreateFieldValues) {
      warnings.push({
        field: fieldLabel,
        message: `New value(s) will be created for "${fieldLabel}": ${missing.join(', ')}`,
        isInfo: true,
      });
    } else {
      const available = [...knownValues.values()].map((v) => v.name).sort();
      warnings.push({
        field: fieldLabel,
        message: `Unknown "${fieldLabel}" value(s) — will be skipped: ${missing.join(', ')}. Available: ${available.join(', ')}`,
      });
    }
  });

  return warnings;
}

/**
 * Pre-fetch allowed values for every mapped select field. When autoCreateFieldValues
 * is true, create any values present in the CSV that don't yet exist in PB.
 *
 * @param {object}   mapping
 * @param {object[]} rows
 * @param {Function} pbFetch
 * @param {Function} withRetry
 * @param {object}   sse                Optional SSE helper (for progress + log)
 * @param {object}   options            { autoCreateFieldValues: boolean }
 * @returns {Promise<Map<string, Map>>} knownFieldValues: fieldId → Map<normalised_name, {id, name}>
 */
async function preflightFieldValues(mapping, rows, pbFetch, withRetry, sse, { autoCreateFieldValues = false } = {}) {
  const knownFieldValues = new Map();
  const selectFields = getSelectFields(mapping);
  if (!selectFields.length) return knownFieldValues;

  if (sse) sse.progress('Fetching allowed field values…', 2);
  await Promise.all(selectFields.map(async (cf) => {
    try {
      knownFieldValues.set(cf.fieldId, await fetchFieldValues(cf.fieldId, pbFetch, withRetry));
    } catch (_) { /* non-fatal */ }
  }));

  if (!autoCreateFieldValues) return knownFieldValues;

  for (const cf of selectFields) {
    const known = knownFieldValues.get(cf.fieldId);
    if (!known) continue;
    const isMulti = cf.fieldType === 'multiselect' || cf.fieldType === 'tags';
    const csvValues = collectCsvValues(rows, cf.csvColumn, isMulti);
    const missing = findMissingValues(csvValues, known);
    for (const name of missing) {
      try {
        const created = await createFieldValue(cf.fieldId, name, pbFetch, withRetry);
        known.set(name.toLowerCase().trim(), { id: created.id, name });
        if (sse) sse.log('info', `Created field value "${name}" for "${cf.name || cf.csvColumn}"`);
      } catch (err) {
        if (sse) sse.log('warn', `Could not create field value "${name}": ${parseApiError(err)}`);
      }
    }
  }

  return knownFieldValues;
}

module.exports = {
  fetchFieldValues,
  createFieldValue,
  collectCsvValues,
  findMissingValues,
  filterStatusValuesByType,
  filterSelectValue,
  collectFieldValueWarnings,
  preflightFieldValues,
  getSelectFields,
};
