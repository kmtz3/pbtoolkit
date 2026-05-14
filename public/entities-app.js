/* =========================================================
   PBToolkit — Entities module frontend
   Phase 1: Templates view
   ========================================================= */

// Entity type ordering and labels (mirrors src/services/entities/meta.js)
const ENT_ORDER = [
  'objective', 'keyResult', 'initiative', 'product', 'component',
  'feature', 'subfeature', 'releaseGroup', 'release',
];

const ENT_LABELS = {
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

// Types that never have a parent — hierarchy_path not applicable for these alone
const ENT_ROOT_TYPES = new Set(['product', 'releaseGroup', 'initiative']);

// ── Utilities ──────────────────────────────────────────────

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

// ── Templates view ─────────────────────────────────────────

function initEntitiesTemplatesView() {
  const grid = document.getElementById('ent-templates-checkboxes');
  const btnDownload = document.getElementById('btn-ent-templates-download');
  if (!grid) return;

  ENT_ORDER.forEach((type) => {
    const label = document.createElement('label');
    label.className = 'checkbox-row';
    label.innerHTML = `<input type="checkbox" data-template-type="${type}" checked />${ENT_LABELS[type]}`;
    grid.appendChild(label);
  });

  const syncBtn = () => {
    if (btnDownload) btnDownload.disabled = entTemplatesGetSelected().length === 0;
  };

  document.getElementById('btn-ent-templates-select-all')?.addEventListener('click', () => {
    grid.querySelectorAll('input').forEach((cb) => { cb.checked = true; });
    syncBtn();
  });
  document.getElementById('btn-ent-templates-clear-all')?.addEventListener('click', () => {
    grid.querySelectorAll('input').forEach((cb) => { cb.checked = false; });
    syncBtn();
  });
  grid.addEventListener('change', syncBtn);
  syncBtn();
}

function entTemplatesGetSelected() {
  const grid = document.getElementById('ent-templates-checkboxes');
  if (!grid) return [];
  return [...grid.querySelectorAll('input[type=checkbox]:checked')]
    .map((cb) => cb.dataset.templateType);
}

async function downloadSelectedTemplates() {
  const types = entTemplatesGetSelected();
  if (!types.length) return;

  requireToken(async () => {
    const btn = document.getElementById('btn-ent-templates-download');
    if (btn) { btn.disabled = true; btn.textContent = 'Downloading…'; }
    hideEntitiesTemplatesError();

    try {
      let res;
      let filename;

      if (types.length === 1) {
        res = await fetch(`/api/entities/templates/${types[0]}`, { headers: buildHeaders() });
        filename = `entities-template-${types[0]}.csv`;
      } else {
        const qs = new URLSearchParams({ types: types.join(',') });
        res = await fetch(`/api/entities/templates.zip?${qs}`, { headers: buildHeaders() });
        filename = `pbtoolkit-entities-templates-${nowStamp()}.zip`;
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        showEntitiesTemplatesError(err.error || `Failed to download (${res.status})`);
        return;
      }

      const blob = await res.blob();
      triggerDownload(blob, filename);
    } catch (e) {
      showEntitiesTemplatesError(`Could not download templates: ${e.message}`);
    } finally {
      if (btn) { btn.disabled = entTemplatesGetSelected().length === 0; btn.textContent = 'Download selected'; }
    }
  });
}

function showEntitiesTemplatesError(msg) {
  const el = document.getElementById('entities-templates-error');
  const msgEl = document.getElementById('entities-templates-error-msg');
  if (el && msgEl) { msgEl.textContent = msg; el.classList.remove('hidden'); }
}

function hideEntitiesTemplatesError() {
  const el = document.getElementById('entities-templates-error');
  if (el) el.classList.add('hidden');
}

// ── Import view ────────────────────────────────────────────

// Alias map for auto-mapping CSV column headers to internal field IDs.
// Each entry lists lowercase candidate strings that should map to that field.
// Mirrors the NOTES_AUTODETECT pattern used in app.js for notes/companies.
const ENT_FIELD_ALIASES = {
  'pb_id':                   ['pb_id', 'pb id', 'entity id', 'id', 'uuid'],
  'ext_key':                 ['ext_key', 'ext key', 'external key', 'external_key'],
  'name':                    ['name', 'title', 'entity name', 'feature name', 'objective name', 'initiative name'],
  'description':             ['description', 'desc', 'details', 'body'],
  'owner':                   ['owner', 'owner_email', 'owner email'],
  'status':                  ['status'],
  'phase':                   ['phase'],
  'teams':                   ['teams', 'team'],
  'archived':                ['archived'],
  'workprogress':            ['workprogress', 'work_progress', 'work progress', 'progress'],  // normalised key
  'timeframe_start':         ['timeframe_start', 'timeframe_start (yyyy-mm-dd)', 'timeframe start', 'start_date', 'start date'],
  'timeframe_end':           ['timeframe_end', 'timeframe_end (yyyy-mm-dd)', 'timeframe end', 'end_date', 'end date'],
  'health_status':           ['health_status', 'health status'],
  'health_comment':          ['health_comment', 'health comment'],
  'progress_start':          ['progress_start', 'progress start', 'start value', 'start_value'],
  'progress_current':        ['progress_current', 'progress current', 'current value', 'current_value', 'current state'],
  'progress_target':         ['progress_target', 'progress target', 'target value', 'target_value', 'goal', 'progress_goal'],
  'parent_ext_key':          ['parent_ext_key', 'parent ext key', 'parent'],
  'parent_feat_ext_key':     ['parent_feat_ext_key', 'parent feat ext key', 'parent feature'],
  'parent_obj_ext_key':      ['parent_obj_ext_key', 'parent obj ext key', 'parent objective'],
  'parent_rlgr_ext_key':     ['parent_rlgr_ext_key', 'parent rlgr ext key', 'parent release group'],
  'connected_rels_ext_key':  ['connected_rels_ext_key', 'connected releases'],
  'connected_objs_ext_key':  ['connected_objs_ext_key', 'connected objectives'],
  'connected_feats_ext_key': ['connected_feats_ext_key', 'connected features'],
  'connected_inis_ext_key':  ['connected_inis_ext_key', 'connected initiatives'],
};

// Entity types that have timeframe (mirrors HAS_TIMEFRAME in meta.js)
const ENT_HAS_TIMEFRAME = new Set([
  'objective', 'keyResult', 'initiative', 'feature', 'subfeature', 'release',
]);

// Entity types that have health (mirrors HEALTH_TYPES in meta.js)
const ENT_HEALTH_TYPES = new Set([
  'objective', 'keyResult', 'initiative', 'feature', 'subfeature',
]);

// Entity types that have progress tracking (mirrors HAS_PROGRESS in meta.js)
const ENT_HAS_PROGRESS = new Set(['keyResult']);

// Preferred order for system fields in mapping table (mirrors SYSTEM_FIELD_ORDER in meta.js)
const ENT_SYSTEM_FIELD_ORDER = [
  'name', 'description', 'owner', 'status', 'phase', 'teams', 'archived', 'workProgress',
];

// Relationship field definitions per entity type (mirrors relationshipColumns() in meta.js)
function entRelFieldDefs(entityType) {
  const defs = [];
  if (['component', 'feature'].includes(entityType))
    defs.push({ id: 'parent_ext_key', label: 'Parent (ext_key or UUID)', required: false, defaultHeader: 'parent_ext_key' });
  if (entityType === 'subfeature')
    defs.push({ id: 'parent_feat_ext_key', label: 'Parent feature (ext_key or UUID)', required: false, defaultHeader: 'parent_feat_ext_key' });
  if (['objective', 'keyResult'].includes(entityType))
    defs.push({ id: 'parent_obj_ext_key', label: 'Parent objective (ext_key or UUID)', required: false, defaultHeader: 'parent_obj_ext_key' });
  if (entityType === 'release')
    defs.push({ id: 'parent_rlgr_ext_key', label: 'Parent release group (ext_key or UUID) *', required: true, defaultHeader: 'parent_rlgr_ext_key' });
  if (['initiative', 'feature', 'subfeature'].includes(entityType))
    defs.push({ id: 'connected_rels_ext_key', label: 'Connected releases (comma-sep.)', required: false, defaultHeader: 'connected_rels_ext_key' });
  if (['initiative', 'feature'].includes(entityType))
    defs.push({ id: 'connected_objs_ext_key', label: 'Connected objectives (comma-sep.)', required: false, defaultHeader: 'connected_objs_ext_key' });
  if (entityType === 'initiative')
    defs.push({ id: 'connected_feats_ext_key', label: 'Connected features (comma-sep.)', required: false, defaultHeader: 'connected_feats_ext_key' });
  if (entityType === 'feature')
    defs.push({ id: 'connected_inis_ext_key', label: 'Connected initiatives (comma-sep.)', required: false, defaultHeader: 'connected_inis_ext_key' });
  return defs;
}

// Build the ordered list of field definitions for the mapping table
function entGetFieldDefs(entityType, configs) {
  const entityConfig = (configs && configs[entityType]) || { systemFields: [], customFields: [] };
  const defs = [];

  // 1. Tracking columns
  defs.push({ id: 'pb_id',   label: 'pb_id',   required: false, group: 'tracking', defaultHeader: 'pb_id', hint: 'Present → update existing · empty → create new' });
  defs.push({ id: 'ext_key', label: 'ext_key', required: false, group: 'tracking', defaultHeader: 'ext_key' });

  // 2. System fields from configs, in preferred order
  const sorted = [...entityConfig.systemFields].sort((a, b) => {
    const ai = ENT_SYSTEM_FIELD_ORDER.indexOf(a.id);
    const bi = ENT_SYSTEM_FIELD_ORDER.indexOf(b.id);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  sorted.forEach((f) => {
    defs.push({ id: f.id, label: f.name, required: false, hint: f.id === 'name' ? 'Required when creating new entities (rows without a pb_id)' : undefined, group: 'system', defaultHeader: f.name, displayType: f.displayType });
  });

  // 3. Synthetic timeframe columns (grouped under Default fields)
  if (ENT_HAS_TIMEFRAME.has(entityType)) {
    defs.push({ id: 'timeframe_start', label: 'Timeframe start (YYYY-MM-DD)', required: false, group: 'system', badge: 'timeframe', defaultHeader: 'timeframe_start (YYYY-MM-DD)' });
    defs.push({ id: 'timeframe_end',   label: 'Timeframe end (YYYY-MM-DD)',   required: false, group: 'system', badge: 'timeframe', defaultHeader: 'timeframe_end (YYYY-MM-DD)' });
  }

  // 4. Synthetic health columns (grouped under Default fields)
  if (ENT_HEALTH_TYPES.has(entityType)) {
    defs.push({ id: 'health_status',  label: 'Health status',  required: false, group: 'system', badge: 'health', defaultHeader: 'health_status' });
    defs.push({ id: 'health_comment', label: 'Health comment', required: false, group: 'system', badge: 'health', defaultHeader: 'health_comment' });
  }

  // 4b. Synthetic progress columns (keyResult only)
  if (ENT_HAS_PROGRESS.has(entityType)) {
    defs.push({ id: 'progress_start',   label: 'Progress start',   required: false, group: 'system', badge: 'progress', defaultHeader: 'progress_start' });
    defs.push({ id: 'progress_current', label: 'Progress current', required: false, group: 'system', badge: 'progress', defaultHeader: 'progress_current' });
    defs.push({ id: 'progress_target',  label: 'Progress target',  required: false, group: 'system', badge: 'progress', defaultHeader: 'progress_target' });
  }

  // 5. Custom UUID fields from configs
  entityConfig.customFields.forEach((f) => {
    defs.push({
      id:            `custom__${f.id}`,
      label:         f.name,
      required:      false,
      group:         'custom',
      defaultHeader: `${f.name} [${f.displayType}] [${f.id}]`,
      displayType:   f.displayType,
    });
  });

  // 6. Relationship columns
  defs.push(...entRelFieldDefs(entityType));

  return defs;
}

// Auto-map CSV headers to internal field IDs.
//
// Resolution order per header (first match wins):
//   1. Exact match on defaultHeader (template-format headers always land here)
//   2. Case-insensitive match on defaultHeader
//   3. Case-insensitive match on PB system field display name (e.g. "Name", "Teams")
//   4. Alias map lookup (ENT_FIELD_ALIASES) — case-insensitive, normalised
//   5. Custom field UUID suffix match: "Field Name [Type] [uuid]"
function entBuildAutoMapping(entityType, csvHeaders, configs) {
  const entityConfig = (configs && configs[entityType]) || { systemFields: [], customFields: [] };
  const allDefs      = entGetFieldDefs(entityType, configs);
  const validIds     = new Set(allDefs.map((d) => d.id));
  const columns      = {};

  // Lookup: exact defaultHeader → field id
  const byDefaultHeader = {};
  // Lookup: lowercased defaultHeader → field id
  const byDefaultHeaderLower = {};
  allDefs.forEach((def) => {
    byDefaultHeader[def.defaultHeader]               = def.id;
    byDefaultHeaderLower[def.defaultHeader.toLowerCase()] = def.id;
  });

  // Lookup: lowercased PB display name → field id (system fields only)
  const bySystemNameLower = {};
  entityConfig.systemFields.forEach((f) => {
    bySystemNameLower[f.name.toLowerCase()] = f.id;
  });

  // Build inverted alias map: lowercase candidate → field id
  // Only include fields that are valid for this entity type
  const byAlias = {};
  for (const [fieldId, aliases] of Object.entries(ENT_FIELD_ALIASES)) {
    // workprogress alias key normalises away camelCase — resolve back to actual id
    const actualId = fieldId === 'workprogress' ? 'workProgress' : fieldId;
    if (!validIds.has(actualId)) continue;
    for (const alias of aliases) {
      if (!byAlias[alias]) byAlias[alias] = actualId; // first writer wins
    }
  }

  // Lookup: custom UUID → field def id
  const byCustomUuid = {};
  entityConfig.customFields.forEach((f) => { byCustomUuid[f.id] = `custom__${f.id}`; });

  // Track which field IDs have already been claimed so we don't double-map
  const claimed = new Set();

  csvHeaders.forEach((header) => {
    const lc = header.toLowerCase().trim();

    let match = null;

    // 1. Exact defaultHeader
    if (!match && byDefaultHeader[header])      match = byDefaultHeader[header];
    // 2. Case-insensitive defaultHeader
    if (!match && byDefaultHeaderLower[lc])     match = byDefaultHeaderLower[lc];
    // 3. System field display name (case-insensitive)
    if (!match && bySystemNameLower[lc])        match = bySystemNameLower[lc];
    // 4. Alias map
    if (!match && byAlias[lc])                  match = byAlias[lc];
    // 5. Custom field UUID suffix
    if (!match) {
      const uuidM = header.match(/\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]$/i);
      if (uuidM && byCustomUuid[uuidM[1]])      match = byCustomUuid[uuidM[1]];
    }

    if (match && !claimed.has(match)) {
      columns[match] = header;
      claimed.add(match);
    }
  });

  return { columns };
}

// Merge auto-mapped columns with a persisted mapping from localStorage.
// Persisted values only override auto when they reference a column that still
// exists in the current CSV — mirrors the guard used by notes and companies.
// Without this check, a stale persisted column name silently overrides auto,
// and the dropdown falls through to "(⇢ skip)" because the column isn't in
// the options list.
function entMergeMapping(auto, persisted, csvHeaders) {
  if (!persisted) return auto;
  const headerSet = new Set(csvHeaders);
  const valid = {};
  for (const [fieldId, csvHeader] of Object.entries(persisted.columns || {})) {
    if (headerSet.has(csvHeader)) valid[fieldId] = csvHeader;
  }
  return { columns: { ...auto.columns, ...valid } };
}

// Import state
const entImport = {
  files:     {},    // entityType → { filename, csvText, headers, rowCount, valid? }
  configs:   null,  // loaded from GET /api/entities/configs
  mappings:  {},    // entityType → { columns: { internalId: csvColHeader } }
  activeTab: null,
};

function entSaveMapping(entityType) {
  const mapping = entImport.mappings[entityType];
  if (mapping) {
    try { localStorage.setItem(`ent-mapping-${entityType}`, JSON.stringify(mapping)); } catch (_) {}
  }
}

function entLoadSavedMapping(entityType) {
  try {
    const raw = localStorage.getItem(`ent-mapping-${entityType}`);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

// Read current mapping from the mapping table dropdowns
function entReadMappingFromUI(entityType) {
  const container = document.getElementById(`ent-mapping-table-${entityType}`);
  if (!container) return entImport.mappings[entityType] || { columns: {} };
  const columns = {};
  container.querySelectorAll('select[data-field-id]').forEach((sel) => {
    if (sel.value) columns[sel.dataset.fieldId] = sel.value;
  });
  return { columns };
}

// Render the mapping table for one entity type into a container element
function renderMappingTable(container, entityType, csvHeaders, configs, savedMapping) {
  const defs    = entGetFieldDefs(entityType, configs);
  const mapping = savedMapping || entBuildAutoMapping(entityType, csvHeaders, configs);

  let lastGroup = null;
  const rows = defs.map((def) => {
    let groupHeader = '';
    if (def.group !== lastGroup) {
      lastGroup = def.group;
      const labels = { tracking: 'Tracking', system: 'Default fields', custom: 'Custom fields' };
      const groupName = labels[def.group] || 'Relationships';
      groupHeader = `<tr class="mapping-group-row"><td colspan="3" class="mapping-group-label">${groupName}</td></tr>`;
    }

    const currentVal    = (mapping.columns && mapping.columns[def.id]) || '';
    const headerOptions = csvHeaders.map((h) => `<option value="${esc(h)}"${h === currentVal ? ' selected' : ''}>${esc(h)}</option>`).join('');
    const typeBadge = def.displayType
      ? `<span class="badge badge-muted">${esc(def.displayType)}</span>`
      : def.badge
        ? `<span class="badge badge-muted">${esc(def.badge)}</span>`
        : '';
    const reqBadge = def.required ? ' <span class="badge badge-danger">required</span>' : '';

    const hintHtml = def.hint ? ` <span class="info-icon" data-tip="${esc(def.hint)}">i</span>` : '';
    return `${groupHeader}<tr>
      <td>${esc(def.label)}${reqBadge}${hintHtml}</td>
      <td>${typeBadge}</td>
      <td><select data-field-id="${esc(def.id)}"><option value="">(⇢ skip)</option>${headerOptions}</select></td>
    </tr>`;
  }).join('');

  container.innerHTML = `<div class="flex justify-end mb-8">
    <button class="btn btn-ghost btn-sm" id="ent-btn-skip-all-${entityType}">↕ Skip all</button>
  </div>
  <table class="mapping-table">
    <thead><tr><th>PB field</th><th>Type</th><th>CSV column</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  container.addEventListener('change', () => {
    entImport.mappings[entityType] = entReadMappingFromUI(entityType);
    entSaveMapping(entityType);
  });

  const skipAllBtn = document.getElementById(`ent-btn-skip-all-${entityType}`);
  if (skipAllBtn) {
    skipAllBtn.addEventListener('click', () => {
      container.querySelectorAll('select[data-field-id]').forEach((sel) => { sel.value = ''; });
      entImport.mappings[entityType] = entReadMappingFromUI(entityType);
      entSaveMapping(entityType);
    });
  }
}

// Render tabs and active tab's mapping table
function entRenderTabs() {
  const tabBar  = document.getElementById('ent-import-tab-bar');
  const content = document.getElementById('ent-import-tab-content');
  if (!tabBar || !content) return;

  const types = ENT_ORDER.filter((t) => entImport.files[t]);
  if (!types.length) return;

  if (!entImport.activeTab || !entImport.files[entImport.activeTab]) {
    entImport.activeTab = types[0];
  }

  tabBar.innerHTML = types.map((t) => {
    const f = entImport.files[t];
    const pillClass = f.valid === false ? ' pill-error' : f.valid === true ? ' pill-ok' : '';
    return `<button class="ent-tab-btn${t === entImport.activeTab ? ' active' : ''}" data-tab="${t}">
      ${ENT_LABELS[t]}<span class="ent-tab-pill${pillClass}">${f.rowCount} rows</span>
    </button>`;
  }).join('');

  tabBar.querySelectorAll('.ent-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (entImport.activeTab) {
        entImport.mappings[entImport.activeTab] = entReadMappingFromUI(entImport.activeTab);
      }
      entImport.activeTab = btn.dataset.tab;
      entRenderTabs();
    });
  });

  const activeType    = entImport.activeTab;
  const mapContainerId = `ent-mapping-table-${activeType}`;
  const saved = entImport.mappings[activeType] || entLoadSavedMapping(activeType) || null;

  content.innerHTML = `<div id="${mapContainerId}"></div>`;
  renderMappingTable(
    document.getElementById(mapContainerId),
    activeType,
    entImport.files[activeType].headers,
    entImport.configs,
    saved,
  );
  entImport.mappings[activeType] = entReadMappingFromUI(activeType);
}

// Load entity field configs from the API (cached for the session)
async function entLoadConfigs() {
  if (entImport.configs) return;
  const loading = document.getElementById('ent-import-configs-loading');
  if (loading) loading.classList.remove('hidden');

  try {
    const res = await fetch('/api/entities/configs', { headers: buildHeaders() });
    if (res.ok) {
      entImport.configs = await res.json();
    } else {
      console.warn('entity configs fetch failed:', res.status);
    }
  } catch (e) {
    console.warn('entity configs error:', e.message);
  } finally {
    if (loading) loading.classList.add('hidden');
  }
}

// Show/hide the mapping and options panels when files are loaded.
// The log panel (#ent-import-step-log) is only shown when import starts.
function entUpdatePanelVisibility() {
  const hasFiles = Object.keys(entImport.files).length > 0;
  ['ent-import-step-map', 'ent-import-step-options'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !hasFiles);
  });

  if (hasFiles) {
    entCheckParentWarning();
    entRenderTabs();
  }
}

// Warn if a required parent entity type is not uploaded
function entCheckParentWarning() {
  const warnEl  = document.getElementById('ent-import-parent-warn');
  const warnMsg = document.getElementById('ent-import-parent-warn-msg');
  if (!warnEl || !warnMsg) return;

  const uploaded = new Set(Object.keys(entImport.files));
  const missing  = [];

  if ((uploaded.has('component') || uploaded.has('feature')) && !uploaded.has('product') && !uploaded.has('component')) {
    missing.push('Upload Products or Components for parent resolution, or use existing pb_id/ext_key values');
  }
  if (uploaded.has('subfeature') && !uploaded.has('feature')) {
    missing.push('Subfeatures → upload Features too, or use existing feature pb_id/ext_key in parent_feat_ext_key');
  }
  if (uploaded.has('keyResult') && !uploaded.has('objective')) {
    missing.push('Key Results → upload Objectives too, or use existing objective pb_id/ext_key in parent_obj_ext_key');
  }
  if (uploaded.has('release') && !uploaded.has('releaseGroup')) {
    missing.push('Releases → upload Release Groups too, or use existing releaseGroup pb_id/ext_key in parent_rlgr_ext_key');
  }

  if (missing.length) {
    warnMsg.innerHTML = 'Missing parent files:<ul>' + missing.map((m) => `<li>${esc(m)}</li>`).join('') + '</ul>';
    warnEl.classList.remove('hidden');
  } else {
    warnEl.classList.add('hidden');
  }
}

// Handle a file selection/drop for an entity type
async function entHandleFile(entityType, file) {
  const tile = document.getElementById(`ent-tile-${entityType}`);
  if (tile) {
    tile.querySelector('.ent-tile-status').textContent = 'Reading…';
    tile.classList.add('has-file');
  }

  const csvText = await readFileText(file);

  // Quick row count + header parse (client-side, for UI display)
  const rowCount = countCSVDataRows(csvText);
  const headers  = parseCSVHeaders(csvText);

  entImport.files[entityType] = { filename: file.name, csvText, headers, rowCount };

  if (tile) {
    tile.querySelector('.ent-tile-status').textContent = `${file.name} · ${rowCount.toLocaleString()} rows`;
    tile.querySelector('.ent-tile-remove').classList.remove('hidden');
  }

  // Load configs on first file drop (requires token), then auto-map
  if (!entImport.configs) {
    requireToken(async () => {
      await entLoadConfigs();
      // Re-map ALL uploaded files now that configs are available
      Object.entries(entImport.files).forEach(([type, f]) => {
        const persisted = entLoadSavedMapping(type);
        const auto = entBuildAutoMapping(type, f.headers, entImport.configs);
        entImport.mappings[type] = entMergeMapping(auto, persisted, f.headers);
      });
      entUpdatePanelVisibility();
    });
  } else {
    // Configs already loaded — auto-map immediately
    const saved = entLoadSavedMapping(entityType);
    const auto  = entBuildAutoMapping(entityType, headers, entImport.configs);
    entImport.mappings[entityType] = entMergeMapping(auto, saved, headers);
    entUpdatePanelVisibility();
  }
}

function entRemoveFile(entityType) {
  delete entImport.files[entityType];
  delete entImport.mappings[entityType];

  const tile = document.getElementById(`ent-tile-${entityType}`);
  if (tile) {
    tile.classList.remove('has-file');
    tile.querySelector('.ent-tile-status').textContent = 'No file selected';
    tile.querySelector('.ent-tile-remove').classList.add('hidden');
  }

  if (entImport.activeTab === entityType) {
    const remaining = ENT_ORDER.filter((t) => entImport.files[t]);
    entImport.activeTab = remaining[0] || null;
  }

  entUpdatePanelVisibility();
}

// Initialize the 9-tile file picker grid
function initEntitiesImportView() {
  const grid = document.getElementById('ent-import-file-grid');
  if (!grid || grid.dataset.init) return;
  grid.dataset.init = '1';

  grid.innerHTML = ENT_ORDER.map((type) => `
    <div class="ent-file-tile" id="ent-tile-${type}">
      <div class="ent-tile-header">
        <span class="ent-tile-name">${ENT_LABELS[type]}</span>
        <button class="ent-tile-remove hidden" data-remove="${type}" title="Remove">✕</button>
      </div>
      <div class="ent-tile-drop" data-drop="${type}">
        <span class="ent-tile-icon">📄</span>
        <span class="ent-tile-status">No file selected</span>
      </div>
      <input type="file" accept=".csv,text/csv" class="hidden" id="ent-file-input-${type}" />
    </div>
  `).join('');

  ENT_ORDER.forEach((type) => {
    const dropZone  = grid.querySelector(`[data-drop="${type}"]`);
    const fileInput = document.getElementById(`ent-file-input-${type}`);

    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) entHandleFile(type, fileInput.files[0]);
      fileInput.value = '';
    });
    dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) entHandleFile(type, e.dataTransfer.files[0]);
    });
  });

  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove]');
    if (btn) { e.stopPropagation(); entRemoveFile(btn.dataset.remove); }
  });

  // Auto-generate ext_keys toggle
  const autogenCb = document.getElementById('ent-autogen-extkeys');
  const wsWrap    = document.getElementById('ent-workspace-code-wrap');
  if (autogenCb && wsWrap) {
    autogenCb.addEventListener('change', () => wsWrap.classList.toggle('hidden', !autogenCb.checked));
  }
}

// Build /preview request body from current state
function entBuildPreviewPayload() {
  if (entImport.activeTab) {
    entImport.mappings[entImport.activeTab] = entReadMappingFromUI(entImport.activeTab);
  }
  const files    = {};
  const mappings = {};
  Object.entries(entImport.files).forEach(([type, f]) => {
    files[type]    = { filename: f.filename, csvText: f.csvText };
    mappings[type] = entImport.mappings[type] || { columns: {} };
  });
  const msMode = document.querySelector('input[name="ent-ms-mode"]:checked');
  return {
    files,
    mappings,
    options: {
      multiSelectMode:          msMode ? msMode.value : 'set',
      bypassEmptyCells:         document.getElementById('ent-bypass-empty')?.checked  || false,
      bypassHtmlFormatter:      document.getElementById('ent-bypass-html')?.checked   || false,
      skipInvalidOwner:         document.getElementById('ent-skip-invalid-owner')?.checked || false,
      fiscal_year_start_month:  parseInt(document.getElementById('ent-fiscal-month')?.value || '1', 10),
      autoGenerateExtKeys:      document.getElementById('ent-autogen-extkeys')?.checked     || false,
      autoCreateFieldValues:    document.getElementById('ent-auto-create-values')?.checked  || false,
      workspaceCode:            (document.getElementById('ent-workspace-code')?.value || '').trim().toUpperCase(),
    },
  };
}

async function runEntityValidation() {
  const btn      = document.getElementById('btn-ent-validate');
  const statusEl = document.getElementById('ent-validate-status');
  if (!btn || !Object.keys(entImport.files).length) return;

  btn.disabled = true;
  if (statusEl) statusEl.textContent = 'Validating…';
  document.getElementById('ent-validate-results')?.classList.add('hidden');

  try {
    const payload = entBuildPreviewPayload();
    const res = await fetch('/api/entities/preview', {
      method: 'POST',
      headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderValidationResults(data);
  } catch (e) {
    if (statusEl) statusEl.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

function renderValidationResults(data) {
  const summaryEl  = document.getElementById('ent-validate-summary-alert');
  const panelsEl   = document.getElementById('ent-validate-error-panels');
  const resultsEl  = document.getElementById('ent-validate-results');
  const statusEl   = document.getElementById('ent-validate-status');
  if (!resultsEl) return;

  const allResults = data.results || {};
  let totalErrors = 0, totalWarnings = 0;
  Object.values(allResults).forEach((r) => {
    totalErrors   += (r.errors   || []).length;
    totalWarnings += (r.warnings || []).length;
  });

  // Stamp validation state on in-memory files (used by tab pills)
  Object.entries(allResults).forEach(([type, r]) => {
    if (entImport.files[type]) entImport.files[type].valid = (r.errors || []).length === 0;
  });
  entRenderTabs();

  if (data.valid) {
    const counts = ENT_ORDER.filter((t) => allResults[t])
      .map((t) => `${(allResults[t].rowCount || 0).toLocaleString()} ${ENT_LABELS[t]}`).join(', ');
    summaryEl.innerHTML = `<div class="alert alert-ok"><span class="alert-icon">✅</span><span>All rows valid — ${counts}. Ready to import.</span></div>`;
    if (statusEl) statusEl.textContent = 'Validation passed';
  } else {
    summaryEl.innerHTML = `<div class="alert alert-error"><span class="alert-icon">❌</span><span>${totalErrors} error${totalErrors !== 1 ? 's' : ''}${totalWarnings ? ` · ${totalWarnings} warning${totalWarnings !== 1 ? 's' : ''}` : ''} — fix before importing.</span></div>`;
    if (statusEl) statusEl.textContent = `${totalErrors} error${totalErrors !== 1 ? 's' : ''}`;
  }

  panelsEl.innerHTML = ENT_ORDER
    .filter((t) => allResults[t] && ((allResults[t].errors || []).length || (allResults[t].warnings || []).length))
    .map((type) => {
      const r = allResults[type];
      const rows = [
        ...(r.errors   || []).map((e) => `<tr><td>${e.row || '—'}</td><td class="col-tag">${esc(e.field || '')}</td><td style="color:var(--c-danger)">${esc(e.message)}</td></tr>`),
        ...(r.warnings || []).map((w) => `<tr><td>${w.row || '—'}</td><td class="col-tag">${esc(w.field || '')}</td><td ${w.isInfo ? 'class="text-info"' : 'style="color:var(--c-warn)"'}>${esc(w.message)}</td></tr>`),
      ].join('');
      const errCount  = (r.errors   || []).length;
      const warnCount = (r.warnings || []).length;
      return `<div class="ent-error-panel mt-12">
        <div class="ent-error-panel-title">${ENT_LABELS[type]} — ${errCount} error${errCount !== 1 ? 's' : ''}${warnCount ? ` · ${warnCount} warning${warnCount !== 1 ? 's' : ''}` : ''}</div>
        <table class="mapping-table"><thead><tr><th>Row</th><th>Field</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
    }).join('');

  resultsEl.classList.remove('hidden');
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Import run ────────────────────────────────────────────

let entImportCtrl = null; // AbortController for in-flight import SSE

// Log appender for entities import — bound to entities log DOM IDs.
// Uses shared makeLogAppender() defined in app.js (loaded first, same page scope).
// Entities SSE events include detail.entityType; we append it as a suffix to message.
const _entLogAppendBase = makeLogAppender('ent-import-log', 'ent-import-log-entries', 'ent-import-log-counts');
function entImportAppendLog(level, message, detail) {
  // detail is the full SSE event object { level, message, detail: { entityType, uuid, row }, ts }
  // Extract the inner detail sub-object for entityType suffix and CSV buffer capture.
  const innerDetail = detail && typeof detail === 'object' ? (detail.detail ?? detail) : null;
  const entitySuffix = innerDetail && innerDetail.entityType ? ` [${innerDetail.entityType}]` : '';
  _entLogAppendBase({ level, message: message + entitySuffix, detail: innerDetail, ts: detail?.ts });
}
// Expose reset/getCounts for entImportSetRunning and stop handler
entImportAppendLog.reset     = () => _entLogAppendBase.reset();
entImportAppendLog.getCounts = () => _entLogAppendBase.getCounts();

function entImportSetRunning(running) {
  const btnRun      = document.getElementById('btn-ent-run');
  const btnStop     = document.getElementById('btn-ent-stop');
  const btnValidate = document.getElementById('btn-ent-validate');
  const btnFixRels  = document.getElementById('btn-ent-fix-rels');
  if (btnRun)      btnRun.disabled      = running;
  if (btnStop)     btnStop.classList.toggle('hidden', !running);
  if (btnValidate) btnValidate.disabled = running;
  if (btnFixRels && running) btnFixRels.classList.add('hidden');

  if (running) {
    // Reset log for fresh run (fixes innerHTML='' bug — only clears entries, not DOM structure)
    entImportAppendLog.reset();
    document.getElementById('btn-ent-import-download-log')?.classList.add('hidden');
    // Hide validate results, error, and previous summary; show log panel
    document.getElementById('ent-validate-results')?.classList.add('hidden');
    document.getElementById('ent-import-error')?.classList.add('hidden');
    document.getElementById('ent-import-summary-box')?.classList.add('hidden');
    // Show the log panel and restore progress track
    document.getElementById('ent-import-step-log')?.classList.remove('hidden');
    document.getElementById('ent-import-step-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('ent-import-progress-track')?.classList.remove('hidden');
    document.getElementById('ent-import-status')?.classList.remove('hidden');
    entImportSetProgress(0, '');
    setText('ent-import-run-title', 'Importing…');
  } else {
    // After import: hide progress bar + status; keep log panel + log visible for review
    document.getElementById('ent-import-progress-track')?.classList.add('hidden');
    document.getElementById('ent-import-status')?.classList.add('hidden');
    document.getElementById('btn-ent-import-download-log')?.classList.remove('hidden');
  }
}

function entImportSetProgress(pct, msg) {
  const bar = document.getElementById('ent-import-progress-bar');
  if (bar) bar.style.width = `${Math.min(100, pct)}%`;
  const status = document.getElementById('ent-import-status');
  if (status) status.textContent = msg || '';
}

function entImportShowError(msg) {
  // Show error in the alert banner
  const el    = document.getElementById('ent-import-error');
  const msgEl = document.getElementById('ent-import-error-msg');
  if (el && msgEl) { msgEl.textContent = msg; el.classList.remove('hidden'); }
  // Also append the fatal error to the log so it's visible in context
  entImportAppendLog('error', msg);
  // Update run title
  setText('ent-import-run-title', 'Import failed');
}

function entImportShowComplete(data) {
  const summaryEl = document.getElementById('ent-import-summary-box');
  if (!summaryEl) return;

  const { perEntity = [], totalCreated = 0, totalUpdated = 0, totalErrors = 0,
          stopped, relationCounts, newIdsCsv } = data;

  const { parentLinks = 0, relationshipLinks = 0, skippedLinks = 0 } = relationCounts || {};

  // Per-entity breakdown table
  const rows = perEntity.map((e) =>
    `<tr><td>${ENT_LABELS[e.entityType] || e.entityType}</td>` +
    `<td>${e.created}</td><td>${e.updated}</td><td>${e.errors}</td></tr>`
  ).join('');

  let extraHtml = '';
  if (rows) {
    extraHtml += `<table class="mapping-table mt-12">
      <thead><tr><th>Entity type</th><th>Created</th><th>Updated</th><th>Errors</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }
  if (newIdsCsv) {
    extraHtml += `<div class="mt-8">
      <button class="btn btn-ghost btn-sm" id="btn-ent-import-download-ids">
        ⬇ Download new ext_keys CSV
      </button></div>`;
  }

  // Use shared renderImportComplete for styled alert-ok/warn summary + extra table
  renderImportComplete(summaryEl, {
    created:   totalCreated,
    updated:   totalUpdated,
    errors:    totalErrors,
    stopped,
    extraText: `${parentLinks} parent links · ${relationshipLinks} connected links` +
               (skippedLinks > 0 ? ` · ${skippedLinks} skipped (target not resolved)` : ''),
    extraHtml,
  });

  if (newIdsCsv) {
    document.getElementById('btn-ent-import-download-ids')?.addEventListener('click', () => {
      const blob = new Blob([newIdsCsv], { type: 'text/csv' });
      const date = new Date().toISOString().slice(0, 10);
      triggerDownload(blob, `new-ext-keys-${date}.csv`);
    });
  }

  setText('ent-import-run-title', stopped ? 'Import stopped' : 'Import complete');
  // Show fix-relationships button
  document.getElementById('btn-ent-fix-rels')?.classList.remove('hidden');
}

function runEntityImport() {
  if (!Object.keys(entImport.files).length) return;
  const payload = entBuildPreviewPayload();
  entImportSetRunning(true);
  entImportCtrl = subscribeSSE('/api/entities/run', payload, {
    onProgress: ({ message, percent }) => entImportSetProgress(percent || 0, message || ''),
    onLog:      (e) => entImportAppendLog(e.level, e.message, e),
    onComplete: (data) => { entImportSetRunning(false); entImportShowComplete(data); },
    onError:    (msg) => { entImportSetRunning(false); entImportShowError(msg); },
    onAbort:    () => {
      entImportAppendLog('warn', 'Import stopped by user');
      entImportSetRunning(false);
      const c = entImportAppendLog.getCounts();
      renderImportComplete(document.getElementById('ent-import-summary-box'), {
        stopped: true, created: c.success, updated: 0,
        errors: c.error, extraText: '',
      });
      setText('ent-import-run-title', 'Import stopped');
    },
  });
}

function runEntityFixRelationships() {
  if (!Object.keys(entImport.files).length) return;
  const payload = entBuildPreviewPayload();
  document.getElementById('btn-ent-fix-rels')?.classList.add('hidden');
  entImportSetRunning(true);
  entImportCtrl = subscribeSSE('/api/entities/relationships', payload, {
    onProgress: ({ message, percent }) => entImportSetProgress(percent || 0, message || ''),
    onLog:      (e) => entImportAppendLog(e.level, e.message, e),
    onComplete: (data) => { entImportSetRunning(false); entImportShowComplete(data); },
    onError:    (msg) => { entImportSetRunning(false); entImportShowError(msg); },
    onAbort:    () => {
      entImportAppendLog('warn', 'Import stopped by user');
      entImportSetRunning(false);
    },
  });
}

// ── Export view ───────────────────────────────────────────

let entExportCtrl = null; // AbortController for in-flight export SSE
let entLastExportBlob = null;
let entLastExportFilename = null;

function entExportMigrationMode() {
  return document.getElementById('ent-export-migration-mode')?.checked || false;
}

function entExportBreadcrumb() {
  return document.getElementById('ent-export-breadcrumb')?.checked || false;
}

function entExportWorkspaceCode() {
  return (document.getElementById('ent-export-workspace-code')?.value || '').trim().toUpperCase();
}

function entExportSetRunning(running) {
  const btn = document.getElementById('btn-ent-export-selected');
  if (btn) btn.disabled = running || (entExportGetSelected().length === 0);
}

function entExportShowProgress(visible) {
  const wrap = document.getElementById('ent-export-progress-wrap');
  if (wrap) wrap.classList.toggle('hidden', !visible);
}

function entExportSetProgress(pct, msg) {
  const bar = document.getElementById('ent-export-progress-bar');
  if (bar) bar.style.width = `${Math.min(100, pct)}%`;
  const status = document.getElementById('ent-export-status');
  if (status) status.textContent = msg || '';
}

function entExportShowError(msg) {
  const el = document.getElementById('ent-export-error');
  const msgEl = document.getElementById('ent-export-error-msg');
  if (el && msgEl) { msgEl.textContent = msg; el.classList.remove('hidden'); }
}

function entExportHideError() {
  const el = document.getElementById('ent-export-error');
  if (el) el.classList.add('hidden');
}

function entExportShowDone(msg) {
  setText('ent-export-done-msg', msg);
  show('ent-export-done');
}

function entExportHideDone() {
  hide('ent-export-done');
}

function entExportAppendLog(level, message) {
  const log = document.getElementById('ent-export-log');
  if (!log) return;
  log.classList.remove('hidden');
  const entry = document.createElement('div');
  entry.className = `log-entry log-${level}`;
  entry.textContent = message;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function entExportClearLog() {
  const log = document.getElementById('ent-export-log');
  if (log) { log.innerHTML = ''; log.classList.add('hidden'); }
}

/**
 * Get the currently checked entity types from the checkbox grid.
 */
function entExportGetSelected() {
  const grid = document.getElementById('ent-export-checkboxes');
  if (!grid) return [];
  return [...grid.querySelectorAll('input[type=checkbox]:checked')]
    .map((cb) => cb.dataset.exportType);
}

/**
 * Run export for selected entity types via export-all SSE.
 * Returns a plain CSV for single type; ZIP for multiple.
 */
function runEntityExportSelected(types) {
  if (!token) { requireToken(() => runEntityExportSelected(types)); return; }

  const migMode = entExportMigrationMode();
  const wsCode  = entExportWorkspaceCode();

  hide('ent-export-idle');

  if (migMode && !wsCode) {
    entExportShowProgress(false);
    entExportClearLog();
    entExportShowError('Enter a workspace code to use migration mode.');
    return;
  }

  entExportHideError();
  entExportHideDone();
  hide('ent-export-stopped');
  entExportClearLog();
  entExportShowProgress(true);
  entExportSetProgress(0, 'Starting export…');
  entExportSetRunning(true);

  entExportCtrl = subscribeSSE(
    '/api/entities/export-all',
    { migrationMode: migMode, workspaceCode: wsCode, breadcrumb: entExportBreadcrumb(), types },
    {
      onProgress: ({ message, percent }) => entExportSetProgress(percent || 0, message),
      onLog: (entry) => entExportAppendLog(entry.level, entry.message),
      onComplete: (data) => {
        entExportSetRunning(false);
        entExportShowProgress(false);
        if (data.csv) {
          // Single type — plain CSV
          const count = data.count || 0;
          const filename = data.filename || `export.csv`;
          const blob = new Blob([data.csv], { type: 'text/csv;charset=utf-8;' });
          entLastExportBlob = blob;
          entLastExportFilename = filename;
          triggerDownload(blob, filename);
          const typeLabel = ENT_LABELS[data.entityType] || 'Entities';
          entExportShowDone(`Exported ${count.toLocaleString()} ${typeLabel}. Download started.`);
        } else if (data.count === 0 && !data.zipBase64) {
          entExportShowDone('No entities found for the selected type.');
        } else if (data.zipBase64) {
          // Multiple types — ZIP
          const total = data.totalEntities || 0;
          const filename = data.filename || `pbtoolkit-entities-export.zip`;
          const binary = atob(data.zipBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: 'application/zip' });
          entLastExportBlob = blob;
          entLastExportFilename = filename;
          triggerDownload(blob, filename);
          entExportShowDone(`Exported ${total.toLocaleString()} entities across all selected types. Download started.`);
        }
      },
      onError: (msg) => {
        entExportSetRunning(false);
        entExportSetProgress(0, '');
        entExportShowError(msg || 'Export failed');
      },
      onAbort: () => {
        entExportSetRunning(false);
        entExportShowProgress(false);
        entExportSetProgress(0, '');
        show('ent-export-stopped');
        entExportCtrl = null;
      },
    }
  );
}

/**
 * Build the checkbox export grid and wire up normalize-keys-multi.
 */
function initEntitiesExportView() {
  // ── Checkbox export grid ──────────────────────────────────

  const checkGrid = document.getElementById('ent-export-checkboxes');
  const btnSelected = document.getElementById('btn-ent-export-selected');

  if (checkGrid) {
    ENT_ORDER.forEach((type) => {
      const label = document.createElement('label');
      label.className = 'checkbox-row';
      label.innerHTML = `<input type="checkbox" data-export-type="${type}" checked />${ENT_LABELS[type]}`;
      checkGrid.appendChild(label);
    });

    const updateExportBtn = () => {
      const selected = entExportGetSelected();
      if (btnSelected) btnSelected.disabled = selected.length === 0;

      // Disable the breadcrumb checkbox when every selected type is a root type
      // (no hierarchy path is possible). Re-enable as soon as any non-root type is selected.
      const bcCb = document.getElementById('ent-export-breadcrumb');
      if (bcCb) {
        const allRoot = selected.length > 0 && selected.every((t) => ENT_ROOT_TYPES.has(t));
        bcCb.disabled = allRoot;
        if (allRoot) bcCb.checked = false;
      }
    };

    document.getElementById('btn-ent-export-select-all')?.addEventListener('click', () => {
      checkGrid.querySelectorAll('input').forEach((cb) => { cb.checked = true; });
      updateExportBtn();
    });
    document.getElementById('btn-ent-export-clear-all')?.addEventListener('click', () => {
      checkGrid.querySelectorAll('input').forEach((cb) => { cb.checked = false; });
      updateExportBtn();
    });
    checkGrid.addEventListener('change', updateExportBtn);
    updateExportBtn(); // sync initial state (all pre-checked)
  }

  if (btnSelected) {
    btnSelected.addEventListener('click', () => {
      const selected = entExportGetSelected();
      if (!selected.length) return;
      runEntityExportSelected(selected);
    });
  }

  document.getElementById('btn-ent-export-download-again')?.addEventListener('click', () => {
    if (!entLastExportBlob) return;
    triggerDownload(entLastExportBlob, entLastExportFilename);
  });

  const resetEntExport = () => {
    entExportHideDone();
    entExportHideError();
    hide('ent-export-stopped');
    entExportShowProgress(false);
    entExportSetProgress(0, '');
    show('ent-export-idle');
  };

  document.getElementById('btn-ent-export-again')?.addEventListener('click', resetEntExport);
  document.getElementById('btn-ent-export-stopped-again')?.addEventListener('click', resetEntExport);
  document.getElementById('btn-ent-export-retry')?.addEventListener('click', resetEntExport);
  document.getElementById('btn-ent-export-stop')?.addEventListener('click', () => {
    entExportCtrl?.abort();
    entExportCtrl = null;
  });

  // Tab switching
  document.getElementById('ent-export-tab-bar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-export-tab]');
    if (!btn) return;
    const tab = btn.dataset.exportTab;
    document.querySelectorAll('#ent-export-tab-bar .ent-tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.getElementById('ent-export-tab-export').classList.toggle('hidden', tab !== 'export');
    document.getElementById('ent-export-tab-normalize').classList.toggle('hidden', tab !== 'normalize');
  });

  // Migration mode toggle — show/hide workspace code field
  const migToggle = document.getElementById('ent-export-migration-mode');
  const wsRow     = document.getElementById('ent-export-workspace-row');
  if (migToggle) {
    migToggle.addEventListener('change', () => {
      wsRow?.classList.toggle('hidden', !migToggle.checked);
    });
  }

  // ── Multi-file normalize-keys ─────────────────────────────

  const normGrid    = document.getElementById('ent-norm-multi-grid');
  const normRunBtn  = document.getElementById('btn-ent-norm-multi-run');
  const normError   = document.getElementById('ent-norm-multi-error');
  const normErrMsg  = document.getElementById('ent-norm-multi-error-msg');
  const normFiles   = {}; // entityType → csvText

  const showNormErr = (m) => {
    if (normError && normErrMsg) { normErrMsg.textContent = m; normError.classList.remove('hidden'); }
  };
  const hideNormErr = () => normError?.classList.add('hidden');

  function updateNormRunBtn() {
    const wsCode = (document.getElementById('ent-norm-multi-workspace')?.value || '').trim();
    if (normRunBtn) normRunBtn.disabled = !wsCode || Object.keys(normFiles).length === 0;
  }

  document.getElementById('ent-norm-multi-workspace')?.addEventListener('input', updateNormRunBtn);

  if (normGrid) {
    ENT_ORDER.forEach((type) => {
      const tile = document.createElement('div');
      tile.className = 'ent-file-tile';
      tile.id = `ent-norm-tile-${type}`;
      tile.innerHTML = `
        <div class="ent-tile-header">
          <span class="ent-tile-name">${ENT_LABELS[type]}</span>
          <button class="ent-tile-remove hidden" data-norm-remove="${type}" title="Remove">✕</button>
        </div>
        <div class="ent-tile-drop" data-norm-drop="${type}">
          <span class="ent-tile-icon">📄</span>
          <span class="ent-tile-status">No file selected</span>
        </div>
        <input type="file" accept=".csv,text/csv" class="hidden" id="ent-norm-file-${type}" />
      `;
      normGrid.appendChild(tile);

      const dropZone  = tile.querySelector(`[data-norm-drop="${type}"]`);
      const fileInput = document.getElementById(`ent-norm-file-${type}`);
      const statusEl  = tile.querySelector('.ent-tile-status');
      const removeBtn = tile.querySelector(`[data-norm-remove="${type}"]`);

      const loadFile = (file) => {
        if (!file) return;
        statusEl.textContent = 'Reading…';
        tile.classList.add('has-file');
        const reader = new FileReader();
        reader.onload = (ev) => {
          normFiles[type] = ev.target.result;
          statusEl.textContent = file.name;
          removeBtn.classList.remove('hidden');
          updateNormRunBtn();
        };
        reader.readAsText(file);
      };

      dropZone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ''; });
      dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
      dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
      });
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        delete normFiles[type];
        tile.classList.remove('has-file');
        statusEl.textContent = 'No file selected';
        removeBtn.classList.add('hidden');
        updateNormRunBtn();
      });
    });
  }

  if (normRunBtn) {
    normRunBtn.addEventListener('click', async () => {
      const wsCode = (document.getElementById('ent-norm-multi-workspace')?.value || '').trim();
      if (!wsCode || !Object.keys(normFiles).length) return;

      hideNormErr();
      normRunBtn.disabled = true;
      normRunBtn.textContent = 'Normalizing…';

      const files = {};
      Object.entries(normFiles).forEach(([t, csvText]) => { files[t] = { csvText }; });

      try {
        const res = await fetch('/api/entities/normalize-keys-multi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files, workspaceCode: wsCode }),
        });
        const json = await res.json();
        if (!res.ok) { showNormErr(json.error || `Failed (${res.status})`); return; }

        const binary = atob(json.zipBase64);
        const bytes  = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'application/zip' });
        triggerDownload(blob, json.filename || 'pbtoolkit-normalized.zip');
      } catch (e) {
        showNormErr(e.message || 'Request failed');
      } finally {
        normRunBtn.textContent = 'Normalize & download ZIP';
        updateNormRunBtn();
      }
    });
  }
}

// ── Delete view ───────────────────────────────────────────

// Delete state
const entDelete = {
  files:      {},    // entityType → { filename, csvText, headers, rowCount, uuidColumn }
  controller: null,  // subscribeSSE controller for abort
};

// Log appender for entities delete — bound to delete log DOM IDs.
const _entDelLogBase = makeLogAppender('ent-delete-log', 'ent-delete-log-entries', 'ent-delete-log-counts');
function entDelAppendLog(level, message, detail) {
  _entDelLogBase({ level, message, detail });
}
entDelAppendLog.reset     = () => _entDelLogBase.reset();
entDelAppendLog.getCounts = () => _entDelLogBase.getCounts();

/** Auto-select the best UUID column from CSV headers (same priority as notes/companies). */
function entDelAutoSelectColumn(headers) {
  const candidates = ['pb_id', 'id', 'uuid'];
  const lc = headers.map((h) => h.toLowerCase());
  for (const c of candidates) {
    const idx = lc.indexOf(c);
    if (idx !== -1) return headers[idx];
  }
  return headers[0] || '';
}

/** Update the preview table and show/hide the preview panel. */
function entDelUpdatePreview() {
  const tbody   = document.getElementById('ent-delete-preview-tbody');
  const preview = document.getElementById('ent-delete-step-preview');
  if (!tbody || !preview) return;

  const uploaded = ENT_ORDER.filter((t) => entDelete.files[t]);

  if (!uploaded.length) {
    preview.classList.add('hidden');
    return;
  }

  tbody.innerHTML = uploaded.map((type) => {
    const f   = entDelete.files[type];
    const sel = document.getElementById(`ent-del-sel-${type}`);
    const col = sel ? sel.value : f.uuidColumn;
    return `<tr>
      <td>${ENT_LABELS[type]}</td>
      <td>${f.rowCount.toLocaleString()}</td>
      <td><code>${esc(col)}</code></td>
    </tr>`;
  }).join('');

  preview.classList.remove('hidden');
}

/** Handle a file drop/select for a delete tile. */
async function entDelHandleFile(entityType, file) {
  const tile = document.getElementById(`ent-del-tile-${entityType}`);
  if (tile) {
    tile.querySelector('.ent-tile-status').textContent = 'Reading…';
    tile.classList.add('has-file');
  }

  const csvText  = await file.text();
  const rowCount = countCSVDataRows(csvText);
  const headers  = parseCSVHeaders(csvText);
  const colAuto  = entDelAutoSelectColumn(headers);

  entDelete.files[entityType] = { filename: file.name, csvText, headers, rowCount, uuidColumn: colAuto };

  if (tile) {
    tile.querySelector('.ent-tile-status').textContent = `${file.name} · ${rowCount.toLocaleString()} rows`;
    tile.querySelector('.ent-tile-remove').classList.remove('hidden');

    // Populate column picker
    const colPick = document.getElementById(`ent-del-col-${entityType}`);
    const sel     = document.getElementById(`ent-del-sel-${entityType}`);
    if (colPick && sel) {
      sel.innerHTML = headers.map((h) => `<option value="${esc(h)}"${h === colAuto ? ' selected' : ''}>${esc(h)}</option>`).join('');
      colPick.classList.remove('hidden');
    }
  }

  entDelUpdatePreview();
}

/** Remove a file from a delete tile. */
function entDelRemoveFile(entityType) {
  delete entDelete.files[entityType];

  const tile = document.getElementById(`ent-del-tile-${entityType}`);
  if (tile) {
    tile.classList.remove('has-file');
    tile.querySelector('.ent-tile-status').textContent = 'No file selected';
    tile.querySelector('.ent-tile-remove').classList.add('hidden');
    const colPick = document.getElementById(`ent-del-col-${entityType}`);
    if (colPick) colPick.classList.add('hidden');
  }

  entDelUpdatePreview();
}

/** Toggle button/progress states while delete SSE is running. */
function entDelSetRunning(running) {
  const btnRun  = document.getElementById('btn-ent-delete-run');
  const btnStop = document.getElementById('btn-ent-delete-stop');
  if (btnRun)  btnRun.disabled = running;
  if (btnStop) btnStop.classList.toggle('hidden', !running);

  if (running) {
    entDelAppendLog.reset();
    document.getElementById('btn-ent-delete-download-log')?.classList.add('hidden');
    document.getElementById('ent-delete-results')?.classList.add('hidden');
    document.getElementById('ent-delete-step-run')?.classList.remove('hidden');
    document.getElementById('ent-delete-step-run')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    entDelSetProgress(0, '');
    setText('ent-delete-run-title', 'Deleting…');
  } else {
    document.getElementById('btn-ent-delete-download-log')?.classList.remove('hidden');
  }
}

function entDelSetProgress(pct, msg) {
  const bar = document.getElementById('ent-delete-progress-bar');
  if (bar) bar.style.width = `${Math.min(100, pct)}%`;
  const status = document.getElementById('ent-delete-status');
  if (status) status.textContent = msg || '';
}

/** Render the results summary table on completion. */
function entDelShowComplete(data) {
  const resultsEl = document.getElementById('ent-delete-results');
  if (!resultsEl) return;

  const { perType = [], total = 0, deleted = 0, skipped = 0, errors = 0 } = data;
  const hasErrors = errors > 0;
  const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
  const icon = hasErrors ? '⚠️' : '✅';

  const rows = perType.map((e) =>
    `<tr>
      <td>${ENT_LABELS[e.type] || e.type}</td>
      <td>${e.total}</td>
      <td>${e.deleted}</td>
      <td>${e.skipped}</td>
      <td>${e.errors}</td>
    </tr>`
  ).join('');

  resultsEl.innerHTML = `
    <div class="alert ${alertClass}">
      <span class="alert-icon">${icon}</span>
      <span>${deleted} deleted · ${skipped} skipped · ${errors} error(s) · ${total} in files</span>
    </div>
    ${rows ? `<table class="mapping-table mt-12">
      <thead><tr><th>Entity type</th><th>Total</th><th>Deleted</th><th>Skipped</th><th>Errors</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` : ''}
  `;
  resultsEl.classList.remove('hidden');
  setText('ent-delete-run-title', hasErrors ? 'Deletion complete (with errors)' : 'Deletion complete');
}

/** Build the request payload from current entDelete state. */
function entDelBuildPayload() {
  const files = {};
  for (const [type, f] of Object.entries(entDelete.files)) {
    const sel = document.getElementById(`ent-del-sel-${type}`);
    const uuidColumn = sel ? sel.value : f.uuidColumn;
    files[type] = { csvText: f.csvText, uuidColumn };
  }
  const safeMode = document.getElementById('ent-delete-safe-mode')?.checked !== false;
  return { files, options: { safeMode } };
}

/** Run the delete via SSE. */
function runEntityDelete() {
  if (!Object.keys(entDelete.files).length) return;
  const payload = entDelBuildPayload();
  entDelSetRunning(true);
  entDelete.controller = subscribeSSE('/api/entities/delete/by-csv', payload, {
    onProgress: ({ message, percent }) => entDelSetProgress(percent || 0, message || ''),
    onLog:      (e) => entDelAppendLog(e.level, e.message, e.detail),
    onComplete: (data) => { entDelSetRunning(false); entDelShowComplete(data); },
    onError:    (msg) => {
      entDelSetRunning(false);
      const resultsEl = document.getElementById('ent-delete-results');
      if (resultsEl) {
        resultsEl.innerHTML = `<div class="alert alert-danger"><span class="alert-icon">❌</span><span>${esc(msg)}</span></div>`;
        resultsEl.classList.remove('hidden');
      }
      setText('ent-delete-run-title', 'Deletion failed');
    },
    onAbort: () => {
      entDelAppendLog('warn', 'Deletion stopped by user');
      entDelSetRunning(false);
      setText('ent-delete-run-title', 'Deletion stopped');
    },
  });
}

/** Initialize the 9-tile delete file picker grid. */
function initEntitiesDeleteView() {
  const grid = document.getElementById('ent-delete-file-grid');
  if (!grid || grid.dataset.init) return;
  grid.dataset.init = '1';

  grid.innerHTML = ENT_ORDER.map((type) => `
    <div class="ent-file-tile" id="ent-del-tile-${type}">
      <div class="ent-tile-header">
        <span class="ent-tile-name">${ENT_LABELS[type]}</span>
        <button class="ent-tile-remove hidden" data-del-remove="${type}" title="Remove">✕</button>
      </div>
      <div class="ent-tile-drop" data-del-drop="${type}">
        <span class="ent-tile-icon">📄</span>
        <span class="ent-tile-status">No file selected</span>
      </div>
      <div class="ent-del-col-pick hidden" id="ent-del-col-${type}">
        <span class="ent-del-col-label">ID column</span>
        <select id="ent-del-sel-${type}"></select>
      </div>
      <input type="file" accept=".csv,text/csv" class="hidden" id="ent-del-file-${type}" />
    </div>
  `).join('');

  ENT_ORDER.forEach((type) => {
    const dropZone  = grid.querySelector(`[data-del-drop="${type}"]`);
    const fileInput = document.getElementById(`ent-del-file-${type}`);
    const sel       = document.getElementById(`ent-del-sel-${type}`);

    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0]) entDelHandleFile(type, fileInput.files[0]);
      fileInput.value = '';
    });
    dropZone.addEventListener('dragover',  (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      if (e.dataTransfer.files[0]) entDelHandleFile(type, e.dataTransfer.files[0]);
    });

    // Update uuidColumn in state when column picker changes; refresh preview table
    if (sel) {
      sel.addEventListener('change', () => {
        if (entDelete.files[type]) entDelete.files[type].uuidColumn = sel.value;
        entDelUpdatePreview();
      });
    }
  });

  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-del-remove]');
    if (btn) { e.stopPropagation(); entDelRemoveFile(btn.dataset.delRemove); }
  });
}

// ── Delete all view ───────────────────────────────────────

// Cascade-children map: selecting a parent auto-checks these types (PB cascade-deletes them)
const ENT_DA_CASCADE_CHILDREN = {
  objective:    ['keyResult'],
  product:      ['component', 'feature', 'subfeature'],
  component:    ['feature', 'subfeature'],
  feature:      ['subfeature'],
  releaseGroup: ['release'],
};

const entDelAll = {
  controller: null,  // subscribeSSE abort controller
};

const _entDALogBase = makeLogAppender('ent-da-live-log', 'ent-da-log-entries', 'ent-da-log-counts');
function entDAAppendLog(level, message, detail) { _entDALogBase({ level, message, detail }); }
entDAAppendLog.reset     = () => _entDALogBase.reset();
entDAAppendLog.getCounts = () => _entDALogBase.getCounts();

/** Recompute which types are cascade-locked based on currently explicit (non-locked) checks. */
function entDAUpdateCheckboxes() {
  // Collect explicitly-checked types (enabled checkboxes that are checked)
  const explicit = new Set();
  for (const type of ENT_ORDER) {
    const cb = document.getElementById(`ent-da-cb-${type}`);
    if (cb && cb.checked && !cb.disabled) explicit.add(type);
  }

  // Expand to all cascade-covered descendants
  const cascaded = new Set();
  for (const type of explicit) {
    for (const child of (ENT_DA_CASCADE_CHILDREN[type] || [])) cascaded.add(child);
  }

  // Update each checkbox
  for (const type of ENT_ORDER) {
    const cb  = document.getElementById(`ent-da-cb-${type}`);
    const lbl = document.getElementById(`ent-da-lbl-${type}`);
    if (!cb) continue;
    if (cascaded.has(type)) {
      cb.checked  = true;
      cb.disabled = true;
      if (lbl) lbl.style.opacity = '0.6';
    } else {
      cb.disabled = false;
      if (lbl) lbl.style.opacity = '';
    }
  }

  // Show/hide cascade info banner
  const cascadeInfo = document.getElementById('ent-da-cascade-info');
  const cascadeMsg  = document.getElementById('ent-da-cascade-msg');
  if (cascadeInfo) {
    if (cascaded.size > 0) {
      cascadeInfo.classList.remove('hidden');
      const labels = [...cascaded].map((t) => ENT_LABELS[t] || t).join(', ');
      if (cascadeMsg) cascadeMsg.textContent =
        `${labels} will be cascade-deleted by Productboard — no direct API call needed for those types.`;
    } else {
      cascadeInfo.classList.add('hidden');
    }
  }

  entDASyncRunBtn();
}

/** Enable run button only when ≥1 type is checked and confirm text equals "DELETE". */
function entDASyncRunBtn() {
  const anyChecked  = ENT_ORDER.some((t) => { const cb = document.getElementById(`ent-da-cb-${t}`); return cb && cb.checked; });
  const confirmVal  = (document.getElementById('ent-da-confirm-input')?.value || '').trim();
  const btn         = document.getElementById('btn-ent-da-run');
  if (btn) btn.disabled = !(anyChecked && confirmVal === 'DELETE');
}

/** Switch to/from running state. */
function entDASetRunning(running) {
  const idle    = document.getElementById('ent-da-idle');
  const runEl   = document.getElementById('ent-da-running');
  const results = document.getElementById('ent-da-results');

  if (running) {
    idle?.classList.add('hidden');
    runEl?.classList.remove('hidden');
    results?.classList.add('hidden');
    entDAAppendLog.reset();
    document.getElementById('btn-ent-da-download-log')?.classList.add('hidden');
    entDASetProgress(0, '');
    runEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    document.getElementById('btn-ent-da-download-log')?.classList.remove('hidden');
  }
}

function entDASetProgress(pct, msg) {
  const bar   = document.getElementById('ent-da-progress-bar');
  const msgEl = document.getElementById('ent-da-progress-msg');
  const pctEl = document.getElementById('ent-da-progress-pct');
  if (bar)   bar.style.width      = `${Math.min(100, pct)}%`;
  if (msgEl) msgEl.textContent    = msg || '';
  if (pctEl) pctEl.textContent    = `${Math.min(100, Math.round(pct))}%`;
}

function entDAShowResults(data) {
  const { perType = [], total = 0, deleted = 0, skipped = 0, errors = 0, cascadedTypes = [] } = data;
  const hasErrors  = errors > 0;
  const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
  const icon       = hasErrors ? '⚠️' : '✅';

  let cascadeNote = '';
  if (cascadedTypes.length) {
    const labels = cascadedTypes.map((t) => ENT_LABELS[t] || t).join(', ');
    cascadeNote  = `<p class="text-sm text-muted mt-8">${esc(labels)} were cascade-deleted by their parent types.</p>`;
  }

  const rows = perType.map((e) =>
    `<tr>
      <td>${ENT_LABELS[e.type] || esc(e.type)}</td>
      <td>${e.total}</td>
      <td>${e.deleted}</td>
      <td>${e.skipped}</td>
      <td>${e.errors}</td>
    </tr>`
  ).join('');

  const summaryEl = document.getElementById('ent-da-summary-alert');
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="alert ${alertClass}">
        <span class="alert-icon">${icon}</span>
        <span>${deleted} deleted · ${skipped} skipped · ${errors} error(s) · ${total} in workspace</span>
      </div>
      ${cascadeNote}
      ${rows ? `<table class="mapping-table mt-12">
        <thead><tr><th>Entity type</th><th>Found</th><th>Deleted</th><th>Skipped</th><th>Errors</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : ''}`;
  }

  const results = document.getElementById('ent-da-results');
  if (results) results.classList.remove('hidden');
}

/** Collect all currently-checked entity types (explicit + cascade-locked). */
function entDAGetSelectedTypes() {
  return ENT_ORDER.filter((type) => {
    const cb = document.getElementById(`ent-da-cb-${type}`);
    return cb && cb.checked;
  });
}

/** Run the delete-by-type SSE operation. */
function runEntityDeleteAll() {
  const types = entDAGetSelectedTypes();
  if (!types.length) return;

  entDASetRunning(true);
  entDelAll.controller = subscribeSSE('/api/entities/delete/by-type', { types }, {
    onProgress: ({ message, percent }) => {
      entDASetProgress(percent || 0, message || '');
      if (message) {
        const liveLog = document.getElementById('ent-da-live-log');
        if (liveLog && liveLog.classList.contains('hidden')) liveLog.classList.remove('hidden');
      }
    },
    onLog: (e) => {
      entDAAppendLog(e.level, e.message, e.detail);
      document.getElementById('ent-da-live-log')?.classList.remove('hidden');
    },
    onComplete: (data) => {
      entDASetRunning(false);
      entDAShowResults(data);
      document.getElementById('ent-da-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    onError: (msg) => {
      entDASetRunning(false);
      const summaryEl = document.getElementById('ent-da-summary-alert');
      if (summaryEl) summaryEl.innerHTML =
        `<div class="alert alert-danger"><span class="alert-icon">❌</span><span>${esc(msg)}</span></div>`;
      document.getElementById('ent-da-results')?.classList.remove('hidden');
    },
    onAbort: () => {
      entDASetRunning(false);
      entDAAppendLog('warn', 'Deletion stopped by user');
      const summaryEl = document.getElementById('ent-da-summary-alert');
      if (summaryEl) summaryEl.innerHTML =
        `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Deletion stopped by user.</span></div>`;
      document.getElementById('ent-da-results')?.classList.remove('hidden');
    },
  });
}

/** Initialize the delete-all view checkboxes and event listeners. */
function initEntitiesDeleteAllView() {
  const grid = document.getElementById('ent-da-checkboxes');
  if (!grid || grid.dataset.init) return;
  grid.dataset.init = '1';

  // Render one labeled checkbox per entity type
  grid.innerHTML = ENT_ORDER.map((type) => {
    const isCascadeChild = Object.values(ENT_DA_CASCADE_CHILDREN).some((children) => children.includes(type));
    const hint = isCascadeChild ? ' <span class="text-muted" style="font-size:11px">(cascade)</span>' : '';
    return `<label class="checkbox-row" id="ent-da-lbl-${type}">
      <input type="checkbox" id="ent-da-cb-${type}" data-da-type="${type}" />
      ${esc(ENT_LABELS[type])}${hint}
    </label>`;
  }).join('');

  grid.addEventListener('change', () => entDAUpdateCheckboxes());

  document.getElementById('btn-ent-da-select-all')?.addEventListener('click', () => {
    ENT_ORDER.forEach((t) => { const cb = document.getElementById(`ent-da-cb-${t}`); if (cb && !cb.disabled) cb.checked = true; });
    entDAUpdateCheckboxes();
  });
  document.getElementById('btn-ent-da-clear-all')?.addEventListener('click', () => {
    ENT_ORDER.forEach((t) => { const cb = document.getElementById(`ent-da-cb-${t}`); if (cb) { cb.checked = false; cb.disabled = false; } });
    entDAUpdateCheckboxes();
  });

  document.getElementById('ent-da-confirm-input')?.addEventListener('input', () => entDASyncRunBtn());

  document.getElementById('btn-ent-da-run')?.addEventListener('click', () => requireToken(runEntityDeleteAll));
  document.getElementById('btn-ent-da-stop')?.addEventListener('click', () => entDelAll.controller?.abort());
  document.getElementById('btn-ent-da-download-log')?.addEventListener('click', () =>
    downloadLogCsv(_entDALogBase, 'entities-delete-all')
  );
  document.getElementById('btn-ent-da-again')?.addEventListener('click', () => {
    document.getElementById('ent-da-running')?.classList.add('hidden');
    document.getElementById('ent-da-results')?.classList.add('hidden');
    const summaryEl = document.getElementById('ent-da-summary-alert');
    if (summaryEl) summaryEl.innerHTML = '';
    document.getElementById('ent-da-idle')?.classList.remove('hidden');
    const input = document.getElementById('ent-da-confirm-input');
    if (input) input.value = '';
    entDASyncRunBtn();
  });
}

// ── Navigation ────────────────────────────────────────────

function setupEntitiesNav() {
  const navMap = {
    'nav-entities-templates':     'entities-templates',
    'nav-entities-export':        'entities-export',
    'nav-entities-import':        'entities-import',
    'nav-entities-delete':        'entities-delete',
    'nav-entities-delete-all':    'entities-delete-all',
  };

  Object.entries(navMap).forEach(([btnId, viewName]) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      showView(viewName, { updateUrl: true });
    });
  });
}

// ── Event listeners ───────────────────────────────────────

let _entitiesInitDone = false;
function initEntitiesModule() {
  if (_entitiesInitDone) return;
  _entitiesInitDone = true;

  initEntitiesTemplatesView();
  initEntitiesImportView();
  initEntitiesDeleteView();
  initEntitiesDeleteAllView();
  setupEntitiesNav();

  // Templates: download selected button
  const btnTemplatesDownload = document.getElementById('btn-ent-templates-download');
  if (btnTemplatesDownload) btnTemplatesDownload.addEventListener('click', downloadSelectedTemplates);

  // Import: Validate button
  const btnValidate = document.getElementById('btn-ent-validate');
  if (btnValidate) {
    btnValidate.addEventListener('click', () => requireToken(runEntityValidation));
  }

  // Import: Run import button
  const btnRun = document.getElementById('btn-ent-run');
  if (btnRun) {
    btnRun.addEventListener('click', () => requireToken(runEntityImport));
  }

  // Import: Stop button
  const btnStop = document.getElementById('btn-ent-stop');
  if (btnStop) {
    btnStop.addEventListener('click', () => entImportCtrl?.abort());
  }

  // Import: Fix relationships button
  const btnFixRels = document.getElementById('btn-ent-fix-rels');
  if (btnFixRels) {
    btnFixRels.addEventListener('click', () => requireToken(runEntityFixRelationships));
  }

  // Delete: Run deletion button
  const btnDelRun = document.getElementById('btn-ent-delete-run');
  if (btnDelRun) {
    btnDelRun.addEventListener('click', () => requireToken(runEntityDelete));
  }

  // Delete: Stop button
  const btnDelStop = document.getElementById('btn-ent-delete-stop');
  if (btnDelStop) {
    btnDelStop.addEventListener('click', () => entDelete.controller?.abort());
  }

  // Import: Download log button
  const btnImportDownloadLog = document.getElementById('btn-ent-import-download-log');
  if (btnImportDownloadLog) {
    btnImportDownloadLog.addEventListener('click', () => {
      downloadLogCsv(_entLogAppendBase, 'entities-import');
    });
  }

  // Delete: Download log button
  const btnDeleteDownloadLog = document.getElementById('btn-ent-delete-download-log');
  if (btnDeleteDownloadLog) {
    btnDeleteDownloadLog.addEventListener('click', () => {
      downloadLogCsv(_entDelLogBase, 'entities-delete');
    });
  }

  initEntitiesExportView();

  window.addEventListener('pb:disconnect', () => {
    // Reset all uploaded file tiles
    ENT_ORDER.forEach((type) => {
      if (!entImport.files[type]) return;
      const tile = document.getElementById(`ent-tile-${type}`);
      if (tile) {
        tile.classList.remove('has-file');
        tile.querySelector('.ent-tile-status').textContent = 'No file selected';
        tile.querySelector('.ent-tile-remove').classList.add('hidden');
      }
      const fileInput = document.getElementById(`ent-file-input-${type}`);
      if (fileInput) fileInput.value = '';
    });
    // Clear in-memory import state
    entImport.files = {};
    entImport.configs = null;
    entImport.mappings = {};
    entImport.activeTab = null;
    // Hide mapping/options/log panels
    ['ent-import-step-map', 'ent-import-step-options', 'ent-import-step-log',
     'ent-import-error', 'ent-import-summary-box', 'ent-validate-results'].forEach((id) => {
      const el = document.getElementById(id); if (el) el.classList.add('hidden');
    });
    const tabBar  = document.getElementById('ent-import-tab-bar');
    const content = document.getElementById('ent-import-tab-content');
    if (tabBar)  tabBar.innerHTML  = '';
    if (content) content.innerHTML = '';
    // Reset export panel
    resetEntExport();
  });

  window.addEventListener('pb:connected', async () => {
    // If files were uploaded before disconnect, reload configs and re-map
    if (Object.keys(entImport.files).length && !entImport.configs) {
      await entLoadConfigs();
      Object.entries(entImport.files).forEach(([type, f]) => {
        const persisted = entLoadSavedMapping(type);
        entAutoMap(type, f.headers, persisted);
      });
    }
  });
}
window.initEntitiesModule = initEntitiesModule;
