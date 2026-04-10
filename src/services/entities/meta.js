/**
 * Entity metadata: ordering, abbreviation codes, column helpers per type.
 * Mirrors the ENT registry and TYPE_CODE map from the Apps Script implementation.
 */

// Dependency-safe processing order (parents before children)
const ENTITY_ORDER = [
  'objective',
  'keyResult',
  'initiative',
  'product',
  'component',
  'feature',
  'subfeature',
  'releaseGroup',
  'release',
];

// Short codes for ext_key auto-generation (format: WSID-CODE-N)
// Sourced from TYPE_CODE in Apps Script mainLogic.gs
const TYPE_CODE = {
  objective:    'OBJT',
  keyResult:    'KRES',
  initiative:   'INIT',
  product:      'PROD',
  component:    'COMP',
  feature:      'FEAT',
  subfeature:   'SUBF',
  releaseGroup: 'RLGR',
  release:      'RELS',
};

// Human-readable labels for UI display
const ENTITY_LABELS = {
  objective:    'Objectives',
  keyResult:    'Key Results',
  initiative:   'Initiatives',
  product:      'Products',
  component:    'Components',
  feature:      'Features',
  subfeature:   'Subfeatures',
  releaseGroup: 'Release Groups',
  release:      'Releases',
};

// ---------------------------------------------------------------------------
// Sets used by import phase (fieldBuilder, validator, importCoordinator)
// ---------------------------------------------------------------------------

// Entity types where status values are workspace-configurable
// (status validation skipped — values fetched from API at runtime)
const SKIP_STATUS_VALIDATION = new Set([
  'objective', 'keyResult', 'initiative', 'release',
]);

// Entity types that support timeframe — drives synthetic timeframe_start/end columns
const HAS_TIMEFRAME = new Set([
  'objective', 'keyResult', 'initiative', 'feature', 'subfeature', 'release',
]);

// Entity types that support the health field — drives synthetic health_* columns
const HEALTH_TYPES = new Set([
  'objective', 'keyResult', 'initiative', 'feature', 'subfeature',
]);

// ---------------------------------------------------------------------------
// Preferred ordering for system fields sourced from configurations.
// buildTemplateCsv sorts systemFields[] by this order before writing headers.
// Fields not in this list (shouldn't happen) sort to the end.
// ---------------------------------------------------------------------------
const SYSTEM_FIELD_ORDER = [
  'name', 'description', 'owner', 'status', 'phase', 'teams', 'archived', 'workProgress',
];

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

/**
 * Synthetic columns that expand composite PB fields into multiple CSV columns.
 * These are always hardcoded (not sourced from configurations).
 */
function syntheticColumns(entityType) {
  const cols = [];
  if (HAS_TIMEFRAME.has(entityType)) {
    cols.push('timeframe_start (YYYY-MM-DD)', 'timeframe_end (YYYY-MM-DD)');
  }
  if (HEALTH_TYPES.has(entityType)) {
    cols.push('health_status', 'health_comment', 'health_updated_by (email)', 'health_last_updated', 'health_previous_status');
  }
  return cols;
}

/**
 * Relationship columns (parent links + connected links).
 * These are always hardcoded — they reference other entities by ext_key.
 */
function relationshipColumns(entityType) {
  const cols = [];

  // Parent relationship
  if (['component', 'feature'].includes(entityType)) cols.push('parent_ext_key');
  if (entityType === 'subfeature')                    cols.push('parent_feat_ext_key');
  if (['objective', 'keyResult'].includes(entityType)) cols.push('parent_obj_ext_key');
  if (entityType === 'release')                        cols.push('parent_rlgr_ext_key');

  // Connected-link relationships (post-create writes)
  if (['initiative', 'feature', 'subfeature'].includes(entityType)) cols.push('connected_rels_ext_key');
  if (['initiative', 'feature'].includes(entityType))                cols.push('connected_objs_ext_key');
  if (entityType === 'feature')                                       cols.push('connected_inis_ext_key');

  // Dependencies (isBlockedBy / isBlocking) — feature, subfeature, initiative; target = feature|subfeature|initiative
  if (['feature', 'subfeature', 'initiative'].includes(entityType)) {
    cols.push('blocked_by_ext_key', 'blocking_ext_key');
  }

  return cols;
}

module.exports = {
  ENTITY_ORDER,
  TYPE_CODE,
  ENTITY_LABELS,
  SKIP_STATUS_VALIDATION,
  HAS_TIMEFRAME,
  HEALTH_TYPES,
  SYSTEM_FIELD_ORDER,
  syntheticColumns,
  relationshipColumns,
};
