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

    const nextUrl = r.links?.next;
    if (!nextUrl) break;
    const m = String(nextUrl).match(/[?&]pageCursor=([^&]+)/);
    cursor = m ? decodeURIComponent(m[1]) : null;
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

module.exports = {
  fetchFieldValues,
  createFieldValue,
  collectCsvValues,
  findMissingValues,
  filterStatusValuesByType,
};
