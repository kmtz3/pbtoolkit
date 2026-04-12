/**
 * Entity configuration cache.
 *
 * Fetches GET /v2/entities/configurations once per request (no in-memory TTL —
 * Cloud Run safe).
 *
 * Actual response shape (confirmed from live API):
 *   {
 *     "data": [
 *       {
 *         "type": "objective",
 *         "fields": {
 *           "name":        { "id": "name",    "name": "Name",    "schema": "TextFieldValue",   ... },
 *           "description": { "id": "description", ...schema: "RichTextFieldValue" },
 *           "teams":       { "id": "teams",   "name": "Team",   "schema": "MembersFieldValue", ... },
 *           "<uuid>":      { "id": "<uuid>",  "name": "Custom Field", "schema": "NumberFieldValue", ... },
 *           "timeframe.startDate": { ... }  // sub-field — excluded
 *         },
 *         "links": { "self": "..." }
 *       }
 *     ],
 *     "links": { "next": null }
 *   }
 *
 * Field classification:
 *   EXCLUDED_FIELD_IDS  — composite fields handled via synthetic split columns (timeframe,
 *                         health) or out of scope (progress). Always filtered out.
 *   STANDARD_FIELD_IDS  — stable system field IDs (non-UUID) returned as systemFields[].
 *                         Column header uses f.name from PB (e.g. "Team" vs "Teams" per type).
 *   everything else     — UUID custom fields, returned as customFields[].
 *                         'tags' falls here — workspace-scoped MultiSelect with a UUID id.
 */

// Composite/special fields — handled with custom synthetic split columns or out of scope.
// Never passed through to systemFields or customFields.
const EXCLUDED_FIELD_IDS = new Set([
  'timeframe', // → timeframe_start (YYYY-MM-DD) / timeframe_end (YYYY-MM-DD)
  'health',    // → health_status / health_comment / health_updated_by (email)
  'progress',  // → progress_start / progress_current / progress_target (synthetic columns)
]);

// Stable system field IDs that come through configurations as plain (non-UUID) keys.
// These become systemFields[] in the returned config, ordered by SYSTEM_FIELD_ORDER in meta.js.
const STANDARD_FIELD_IDS = new Set([
  'name', 'description', 'owner', 'status', 'phase', 'teams', 'archived', 'workProgress',
]);

/**
 * Normalize a schema value from the PB config API to a canonical entity-style string.
 *
 * The v2 configurations endpoint now returns JSON Schema objects for some entity types
 * (e.g. { "type": "string" }) instead of the legacy string format ("TextFieldValue").
 * This function converts both formats to the legacy string so downstream code
 * (formatFieldValue, schemaToToken, etc.) can rely on a single format.
 */
function normalizeSchema(schema) {
  if (!schema) return '';
  if (typeof schema === 'string') return schema;
  if (typeof schema !== 'object') return '';
  if (schema.type === 'number')  return 'NumberFieldValue';
  if (schema.type === 'string' && schema.format === 'date') return 'DateFieldValue';
  if (schema.type === 'string' && (schema.format === 'richtext' || schema.contentMediaType)) return 'RichTextFieldValue';
  if (schema.type === 'string')  return 'TextFieldValue';
  if (schema.type === 'boolean') return 'BooleanFieldValue';
  if (schema.type === 'array')   return 'MultiSelectFieldValue';
  if (schema.type === 'object' && schema.properties?.email) return 'MemberFieldValue';
  if (schema.type === 'object')  return 'SingleSelectFieldValue';
  return '';
}

/**
 * Strip "FieldValue" suffix from a schema name for clean display in headers.
 * e.g. "NumberFieldValue" → "Number", "SingleSelectFieldValue" → "SingleSelect"
 */
function schemaToType(schema) {
  const s = normalizeSchema(schema);
  return s ? s.replace('FieldValue', '') : 'Unknown';
}

/**
 * @param {Function} pbFetch   - bound pbFetch from createClient
 * @param {Function} withRetry - bound withRetry from createClient
 * @returns {Promise<Object>} configs keyed by entity type string
 *   e.g. {
 *     feature: {
 *       type: 'feature',
 *       systemFields: [{ id, name, schema, displayType }],  // name/description/owner/status/…
 *       customFields: [{ id, name, schema, displayType }],  // UUID fields (tags, custom)
 *     }
 *   }
 */
async function fetchEntityConfigs(pbFetch, withRetry) {
  const configs = {};

  let url = '/v2/entities/configurations';
  while (url) {
    const r = await withRetry(
      () => pbFetch('get', url),
      'fetch entity configurations'
    );

    for (const entry of (r.data || [])) {
      // entry.fields is an object (field id → field def), convert to array
      // then strip sub-field paths (id contains '.') and excluded composites
      const eligible = Object.values(entry.fields || {})
        .filter((f) => !f.id.includes('.') && !EXCLUDED_FIELD_IDS.has(f.id))
        .map((f) => {
          const schema = normalizeSchema(f.schema);
          return {
            id:          f.id,
            name:        f.name,
            schema,
            displayType: schemaToType(schema),
          };
        });

      configs[entry.type] = {
        type:         entry.type,
        systemFields: eligible.filter((f) =>  STANDARD_FIELD_IDS.has(f.id)),
        customFields: eligible.filter((f) => !STANDARD_FIELD_IDS.has(f.id)),
      };
    }

    url = r.links?.next || null;
  }

  return configs;
}

module.exports = { fetchEntityConfigs, EXCLUDED_FIELD_IDS, STANDARD_FIELD_IDS, schemaToType, normalizeSchema };
