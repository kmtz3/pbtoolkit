/**
 * Entity exporter — Phase 3
 *
 * Fetches entities from Productboard using POST /v2/entities/search + cursor pagination.
 * Relationships are inline in the search response (no separate fetch needed for most cases).
 * Falls back to GET /v2/entities/{id}/relationships if relationships.links.next is set.
 *
 * Returns { headers, rows } where:
 *   headers — ordered column header strings (same order as buildTemplateCsv)
 *   rows    — array of objects keyed by column header
 */

const Papa = require('papaparse');
const {
  SYSTEM_FIELD_ORDER,
  HAS_TIMEFRAME,
  HEALTH_TYPES,
  HAS_PROGRESS,
  syntheticColumns,
  relationshipColumns,
} = require('./meta');
const { schemaToType } = require('./configCache');
const { extractCursor } = require('../../lib/pbClient');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a custom field value for CSV output based on its schema type.
 * Schema comes from configCache (e.g. "NumberFieldValue", "SingleSelectFieldValue").
 */
function formatFieldValue(val, schema) {
  if (val == null || val === '') return '';
  const type = schemaToType(schema); // strips "FieldValue" suffix

  switch (type) {
    case 'Number':
      return String(val);
    case 'Text':
    case 'RichText':
    case 'Url':
      return String(val);
    case 'SingleSelect':
      return val?.name || '';
    case 'MultiSelect':
      return Array.isArray(val)
        ? val.map((v) => v.name || '').filter(Boolean).join(', ')
        : String(val);
    case 'Members':
      // Members field (e.g. tags) returns array of { id, name } or { id, email }
      if (Array.isArray(val)) {
        return val.map((v) => v.name || v.email || '').filter(Boolean).join(', ');
      }
      return val?.email || val?.name || String(val);
    case 'Member':
    case 'User':
      return val?.email || '';
    case 'Date':
      return typeof val === 'string' ? val : (val?.date || '');
    default:
      if (Array.isArray(val)) {
        return val.map((v) => (v && typeof v === 'object' ? v.name || v.email || '' : String(v))).filter(Boolean).join(', ');
      }
      if (typeof val === 'object') return val?.name || val?.email || '';
      return String(val);
  }
}

/**
 * Entity types that are always top-level (no parent) — hierarchy_path column is omitted for these
 * even when breadcrumb is requested. Initiatives are also excluded because they can have multiple
 * connected objectives (not a single parent chain).
 */
const ROOT_ENTITY_TYPES = new Set(['product', 'releaseGroup', 'initiative']);

/**
 * Types whose ancestors must be prefetched when they are the only type being exported,
 * so the name map can resolve the full hierarchy path.
 * Products, initiatives, and release groups are always root nodes — no extra fetches needed.
 */
const BREADCRUMB_EXTRA_TYPES = {
  product:      [],
  component:    ['product'],
  feature:      ['component', 'product'],
  subfeature:   ['feature', 'component', 'product'],
  objective:    [],
  keyResult:    ['objective'],
  initiative:   [],
  releaseGroup: [],
  release:      ['releaseGroup'],
};

/**
 * Build an id→{name, parentId} map from an array of raw entity objects.
 */
function buildNameMapFromEntities(entities) {
  const map = {};
  for (const entity of entities) {
    const parentRel = (entity.relationships?.data || []).find(r => r.type === 'parent');
    map[entity.id] = {
      name: entity.fields?.name || entity.id,
      parentId: parentRel?.target?.id || null,
    };
  }
  return map;
}

/**
 * Walk up the name map from entityId's parent to the root.
 * Returns the ancestor chain joined by ' > ', or '' if no ancestors.
 * Ancestors only — entity's own name is excluded.
 */
function resolveBreadcrumb(entityId, nameMap) {
  const parts = [];
  const seen = new Set([entityId]);
  let currentId = nameMap[entityId]?.parentId;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const entry = nameMap[currentId];
    if (!entry) break;
    parts.unshift(entry.name);
    currentId = entry.parentId;
  }

  return parts.join(' > ');
}

/**
 * Fetch all entities of the given types and return a combined name map.
 * Reuses fetchAllEntities internally (handles rel pagination).
 */
async function fetchNameMapForTypes(types, pbFetch, withRetry, onProgress) {
  const allEntities = [];
  for (const type of types) {
    const entities = await fetchAllEntities(type, pbFetch, withRetry, onProgress);
    allEntities.push(...entities);
  }
  return buildNameMapFromEntities(allEntities);
}

/**
 * Build the ordered header array for a given entity type.
 * Identical column order to buildTemplateCsv() in routes/entities.js to ensure
 * export output can be re-imported without remapping.
 */
function buildExportHeaders(entityType, entityConfig, options = {}) {
  const { breadcrumb = false } = options;
  const addBreadcrumb = breadcrumb && !ROOT_ENTITY_TYPES.has(entityType);
  const prefixCols = addBreadcrumb
    ? ['pb_id', 'ext_key', 'created_at', 'updated_at', 'hierarchy_path']
    : ['pb_id', 'ext_key', 'created_at', 'updated_at'];

  const systemHeaders = [...entityConfig.systemFields]
    .sort((a, b) => {
      const ai = SYSTEM_FIELD_ORDER.indexOf(a.id);
      const bi = SYSTEM_FIELD_ORDER.indexOf(b.id);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    })
    .map((f) => f.name); // PB display name (e.g. "Team" for objective, "Teams" for others)

  const syntheticCols = syntheticColumns(entityType);

  const customHeaders = entityConfig.customFields.map(
    (f) => `${f.name} [${f.displayType}] [${f.id}]`
  );

  const relCols = relationshipColumns(entityType);

  return [...prefixCols, ...systemHeaders, ...syntheticCols, ...customHeaders, ...relCols, 'pb_html_link'];
}

/**
 * Transform a single entity API object to a plain row object keyed by column header.
 * @param {object} [options]          Optional. Pass { nameMap } to include hierarchy_path.
 */
function entityToRow(entity, entityType, entityConfig, options = {}) {
  const { nameMap = null } = options;
  const fields = entity.fields || {};
  const rels = (entity.relationships && entity.relationships.data) || [];
  const row = {};

  // 1. Tracking columns
  row['pb_id'] = entity.id || '';
  row['ext_key'] = fields.externalKey || '';
  row['created_at'] = entity.createdAt || '';
  row['updated_at'] = entity.updatedAt || '';
  row['pb_html_link'] = entity.links?.html || '';
  if (nameMap && !ROOT_ENTITY_TYPES.has(entityType)) {
    row['hierarchy_path'] = resolveBreadcrumb(entity.id, nameMap);
  }

  // 2. System fields (identified by f.id; use f.name as column header)
  for (const f of entityConfig.systemFields) {
    const col = f.name; // PB display name is the column header

    switch (f.id) {
      case 'name':
        row[col] = fields.name || '';
        break;
      case 'description':
        row[col] = fields.description || '';
        break;
      case 'owner':
        row[col] = fields.owner?.email || '';
        break;
      case 'status':
        row[col] = fields.status?.name || '';
        break;
      case 'phase':
        row[col] = fields.phase?.name || '';
        break;
      case 'teams': {
        const teamData = fields.teams;
        if (Array.isArray(teamData)) {
          row[col] = teamData.map((t) => t.name).filter(Boolean).join(', ');
        } else {
          row[col] = '';
        }
        break;
      }
      case 'archived':
        // Export as TRUE/FALSE string for clarity
        row[col] = fields.archived === true ? 'TRUE' : fields.archived === false ? 'FALSE' : '';
        break;
      case 'workProgress':
        row[col] =
          fields.workProgress?.value !== undefined && fields.workProgress?.value !== null
            ? String(fields.workProgress.value)
            : '';
        break;
      default:
        row[col] = '';
    }
  }

  // 3. Synthetic timeframe columns
  if (HAS_TIMEFRAME.has(entityType)) {
    row['timeframe_start (YYYY-MM-DD)'] = fields.timeframe?.startDate || '';
    row['timeframe_end (YYYY-MM-DD)'] = fields.timeframe?.endDate || '';
  }

  // 4. Synthetic health columns
  if (HEALTH_TYPES.has(entityType)) {
    row['health_status'] = fields.health?.status || '';
    row['health_comment'] = fields.health?.comment || '';
    row['health_updated_by (email)'] = fields.health?.createdBy?.email || '';
    row['health_last_updated'] = fields.health?.lastUpdatedAt || '';
    row['health_previous_status'] = fields.health?.previousStatus || '';
  }

  // 4b. Synthetic progress columns (keyResult only)
  if (HAS_PROGRESS.has(entityType)) {
    const p = fields.progress;
    row['progress_start']   = p?.startValue   != null ? String(p.startValue)   : '';
    row['progress_current'] = p?.currentValue != null ? String(p.currentValue) : '';
    row['progress_target']  = p?.targetValue  != null ? String(p.targetValue)  : '';
  }

  // 5. Custom UUID fields
  for (const f of entityConfig.customFields) {
    const col = `${f.name} [${f.displayType}] [${f.id}]`;
    row[col] = formatFieldValue(fields[f.id], f.schema);
  }

  // 6. Relationship columns (use PB UUID in normal mode; migrationHelper rewrites in migration mode)

  // Parent relationship: find the first rel with type === 'parent'
  const parentRel = rels.find((r) => r.type === 'parent');
  if (parentRel) {
    const parentId = parentRel.target?.id || '';
    const parentType = parentRel.target?.type || '';

    // Match column name to parent type (mirrors validator.js / ENTITY_IMPORTER_PLAN §9.4)
    if (parentType === 'feature') {
      row['parent_feat_ext_key'] = parentId;
    } else if (parentType === 'objective') {
      row['parent_obj_ext_key'] = parentId;
    } else if (parentType === 'releaseGroup') {
      row['parent_rlgr_ext_key'] = parentId;
    } else {
      // component/product parents → parent_ext_key
      row['parent_ext_key'] = parentId;
    }
  }

  // Connected-link relationships
  const linkRels = rels.filter((r) => r.type === 'link');

  const objLinks = linkRels.filter((l) => l.target?.type === 'objective');
  if (objLinks.length) {
    row['connected_objs_ext_key'] = objLinks.map((l) => l.target.id).filter(Boolean).join(', ');
  }

  const iniLinks = linkRels.filter((l) => l.target?.type === 'initiative');
  if (iniLinks.length) {
    row['connected_inis_ext_key'] = iniLinks.map((l) => l.target.id).filter(Boolean).join(', ');
  }

  const relLinks = linkRels.filter((l) => l.target?.type === 'release');
  if (relLinks.length) {
    row['connected_rels_ext_key'] = relLinks.map((l) => l.target.id).filter(Boolean).join(', ');
  }

  const blockedByRels = rels.filter((r) => r.type === 'isBlockedBy');
  if (blockedByRels.length) {
    row['blocked_by_ext_key'] = blockedByRels.map((r) => r.target.id).filter(Boolean).join(', ');
  }

  const blockingRels = rels.filter((r) => r.type === 'isBlocking');
  if (blockingRels.length) {
    row['blocking_ext_key'] = blockingRels.map((r) => r.target.id).filter(Boolean).join(', ');
  }

  return row;
}

/**
 * Fetch all entities of a given type using cursor pagination on POST /v2/entities/search.
 * Handles relationship pagination edge case (when entity.relationships.links.next is set).
 *
 * @param {string}   entityType
 * @param {Function} pbFetch
 * @param {Function} withRetry
 * @param {Function} [onProgress]  called with (totalFetched) after each page
 * @returns {Promise<Array>}       raw entity objects from the API
 */
async function fetchAllEntities(entityType, pbFetch, withRetry, onProgress) {
  const entities = [];
  let cursor = null;
  let page = 0;

  do {
    page++;
    const path = cursor
      ? `/v2/entities?type[]=${entityType}&pageCursor=${encodeURIComponent(cursor)}`
      : `/v2/entities?type[]=${entityType}`;

    const response = await withRetry(
      () => pbFetch('get', path),
      `export ${entityType} page ${page}`
    );

    const items = response.data || [];

    // Handle entities that have paginated relationship data
    for (const entity of items) {
      if (entity.relationships?.links?.next) {
        // Rare: very many relationships — fetch additional pages
        const allRelData = [...(entity.relationships.data || [])];
        let relNext = entity.relationships.links.next;

        while (relNext) {
          const relCursor = extractCursor(relNext);
          if (!relCursor) break;
          const relResp = await withRetry(
            () => pbFetch('get', `/v2/entities/${entity.id}/relationships?pageCursor=${encodeURIComponent(relCursor)}`),
            `fetch relationships ${entity.id}`
          );
          allRelData.push(...(relResp.data || []));
          relNext = relResp.links?.next || null;
        }

        entity.relationships = { data: allRelData };
      }
      entities.push(entity);
    }

    if (onProgress) onProgress(entities.length);

    cursor = extractCursor(response.links?.next);

    if (entities.length >= 50000) break; // safety cap
  } while (cursor);

  return entities;
}

/**
 * Export a single entity type.
 * Fetches from the API and transforms to rows ready for Papa.unparse().
 *
 * @param {string}   entityType
 * @param {object}   configs       result of fetchEntityConfigs()
 * @param {Function} pbFetch
 * @param {Function} withRetry
 * @param {Function} [onProgress]  called with (fetched) after each page
 * @param {object}   [options]     { breadcrumb: false, nameMap: null }
 * @returns {Promise<{ headers: string[], rows: object[], count: number, rawEntities: Array }>}
 */
async function exportEntityType(entityType, configs, pbFetch, withRetry, onProgress, options = {}) {
  const { breadcrumb = false, nameMap = null } = options;
  const entityConfig = configs[entityType] || { systemFields: [], customFields: [] };
  const headers = buildExportHeaders(entityType, entityConfig, { breadcrumb });

  const entities = await fetchAllEntities(entityType, pbFetch, withRetry, onProgress);
  const rows = entities.map((e) => entityToRow(e, entityType, entityConfig, nameMap ? { nameMap } : {}));

  return { headers, rows, count: entities.length, rawEntities: entities };
}

/**
 * Serialize rows to CSV string (UTF-8 BOM prepended for Excel compatibility).
 *
 * @param {string[]} headers   ordered column headers
 * @param {object[]} rows      row objects
 * @returns {string}           CSV text with BOM
 */
function rowsToCsv(headers, rows) {
  const data = rows.map((row) =>
    headers.map((h) => (row[h] == null ? '' : String(row[h])))
  );
  return '\uFEFF' + Papa.unparse({ fields: headers, data });
}

module.exports = {
  exportEntityType,
  buildExportHeaders,
  rowsToCsv,
  formatFieldValue,
  entityToRow,
  buildNameMapFromEntities,
  resolveBreadcrumb,
  fetchNameMapForTypes,
  BREADCRUMB_EXTRA_TYPES,
  ROOT_ENTITY_TYPES,
};
