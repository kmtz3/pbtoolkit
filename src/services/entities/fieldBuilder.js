/**
 * Field builder for entity import.
 *
 * Builds CREATE and PATCH payloads from normalized rows (internal field IDs as keys).
 * Mirrors buildFieldsObject_(), buildPatchOperations_(), buildTimeframeFromDates_(),
 * normalizeCustomValue_() and related helpers from mainLogicImporter.gs.
 */

const sanitizeHtml = require('sanitize-html');
const { cell } = require('./csvParser');
const { HAS_TIMEFRAME, HEALTH_TYPES, HAS_PROGRESS } = require('./meta');
const { normalizeSchema } = require('./configCache');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CUSTOM_RE = /^custom__(.+)$/;

// Allowed HTML tags and attributes for PB rich-text fields
const SANITIZE_OPTS = {
  allowedTags: ['h1', 'h2', 'p', 'b', 'i', 'u', 's', 'code', 'pre',
                'ul', 'ol', 'li', 'a', 'hr', 'blockquote', 'span', 'br'],
  allowedAttributes: { a: ['href'] },
};

// ---------------------------------------------------------------------------
// applyMapping
// ---------------------------------------------------------------------------

/**
 * Transform CSV rows into normalized rows keyed by internal field IDs.
 * mapping.columns = { internalId: csvColumnHeader }
 *
 * Each resulting row has:
 *   - all internalId keys from the mapping (value = trimmed CSV cell string)
 *   - _type, _pbId, _extKey metadata properties
 */
function applyMapping(csvRows, entityType, mapping) {
  const cols = (mapping && mapping.columns) ? mapping.columns : {};
  return csvRows.map((csvRow) => {
    const normalized = { _type: entityType };
    for (const [internalId, csvHeader] of Object.entries(cols)) {
      normalized[internalId] = cell(csvRow, csvHeader);
    }
    // Read pb_id / ext_key only when the user actually mapped them.
    // When a field is set to "(skip)" the frontend omits it from cols entirely.
    // Falling back to the raw CSV column would silently trigger PATCH instead of POST.
    normalized._pbId   = ('pb_id'   in cols) ? (cell(csvRow, cols['pb_id'])   || '') : '';
    normalized._extKey = ('ext_key' in cols) ? (cell(csvRow, cols['ext_key']) || '') : '';
    // Relationship columns may not be in the mapping if user left them unmapped;
    // try to read them directly by their canonical column name as a fallback.
    const relCols = [
      'parent_ext_key', 'parent_feat_ext_key', 'parent_obj_ext_key', 'parent_rlgr_ext_key',
      'connected_rels_ext_key', 'connected_objs_ext_key', 'connected_inis_ext_key',
      'blocked_by_ext_key', 'blocking_ext_key',
    ];
    for (const rc of relCols) {
      if (normalized[rc] === undefined) {
        normalized[rc] = cell(csvRow, rc);
      }
    }
    return normalized;
  });
}

// ---------------------------------------------------------------------------
// buildCreatePayload / buildPatchPayload
// ---------------------------------------------------------------------------

/**
 * Build a CREATE payload.
 * Inline parent relationship is included if resolvable from idCache.
 *
 * @returns {{ data: { type, fields, relationships? } }}
 */
function buildCreatePayload(normalizedRow, entityType, config, idCache, options) {
  const fields = buildFieldsObject(normalizedRow, entityType, config, options, 'create');
  const payload = { data: { type: entityType, fields } };

  const parent = idCache.resolveParent(normalizedRow);
  if (parent) {
    payload.data.relationships = [{ type: 'parent', target: { id: parent.id } }];
    normalizedRow._parentSetInline = true;
  }

  return payload;
}

/**
 * Build a PATCH payload.
 * Uses patch-array format when multiSelectMode !== 'set' or when clear markers exist.
 *
 * @returns {{ data: { fields } } | { data: { patch: [] } }}
 */
function buildPatchPayload(normalizedRow, entityType, config, options) {
  const fields = buildFieldsObject(normalizedRow, entityType, config, options, 'update');
  const { multiSelectMode = 'set' } = options || {};

  const hasClearMarkers = Object.values(fields).some(
    (v) => v && typeof v === 'object' && v.__clearField === true
  );

  if (multiSelectMode !== 'set' || hasClearMarkers) {
    const configById = _indexConfigById(config);
    const patchOps = buildPatchOperations(fields, configById, multiSelectMode);
    return { data: { patch: patchOps } };
  }

  // Strip clear markers that were only used for detection
  for (const k of Object.keys(fields)) {
    if (fields[k] && typeof fields[k] === 'object' && fields[k].__clearField) {
      delete fields[k];
    }
  }
  return { data: { fields } };
}

// ---------------------------------------------------------------------------
// buildFieldsObject
// ---------------------------------------------------------------------------

/**
 * Build the fields map from a normalized row.
 * op = 'create' | 'update'
 */
function buildFieldsObject(normalizedRow, entityType, config, options, op) {
  const {
    multiSelectMode    = 'set',
    bypassEmptyCells   = false,
    bypassHtmlFormatter = false,
    fiscal_year_start_month = 1,
  } = options || {};

  const isCreate = op === 'create';
  const configById = _indexConfigById(config);
  const F = {};

  function isEmpty(v) { return v === null || v === undefined || String(v).trim() === ''; }
  function skip(v)    { return bypassEmptyCells && !isCreate && isEmpty(v); }
  /** True when a system field key was actually mapped in the user's column mapping. */
  function mapped(key) { return key in normalizedRow; }

  // --- name (always sent on create to prevent "Unnamed …") ---
  const nameVal = normalizedRow['name'] || '';
  if (nameVal || isCreate) F.name = nameVal;

  // --- description ---
  const descVal = normalizedRow['description'] || '';
  if (!skip(descVal)) {
    if (descVal) {
      F.description = bypassHtmlFormatter ? descVal : sanitizeDescription(descVal);
    }
  }

  // --- owner ---
  const ownerVal = normalizedRow['owner'] || '';
  if (!skip(ownerVal) && ownerVal) {
    const ownerMatch = ownerVal.match(EMAIL_RE);
    if (!ownerMatch) {
      // Invalid email format — skip silently (logged as warning by caller if needed)
    } else {
      const ownerEmail = ownerMatch[1];
      // If skipInvalidOwner is enabled and the email isn't in the workspace members set, skip it
      const skipOwner = options?.skipInvalidOwner && options?._memberEmails instanceof Set
        && !options._memberEmails.has(ownerEmail.toLowerCase());
      if (!skipOwner) {
        F.owner = { email: ownerEmail };
      }
    }
  }

  // --- status (only process if user actually mapped it) ---
  if (mapped('status')) {
    const statusVal = normalizedRow['status'] || '';
    if (!skip(statusVal)) {
      if (multiSelectMode === 'set') {
        if (statusVal) {
          F.status = { name: statusVal };
        } else if (!isCreate) {
          F.status = { __clearField: true };
        }
      } else if (multiSelectMode === 'addItems' && statusVal) {
        F.status = { name: statusVal };
      } else if (multiSelectMode === 'removeItems' && statusVal && !isCreate) {
        F.status = { __clearField: true };
      }
    }
  }

  // --- phase (initiatives only) ---
  if (entityType === 'initiative') {
    const phaseVal = normalizedRow['phase'] || '';
    if (!skip(phaseVal) && phaseVal) {
      F.phase = { name: phaseVal };
    }
  }

  // --- timeframe ---
  if (HAS_TIMEFRAME.has(entityType)) {
    const startVal = normalizedRow['timeframe_start'] || normalizedRow['timeframe_start (YYYY-MM-DD)'] || '';
    const endVal   = normalizedRow['timeframe_end']   || normalizedRow['timeframe_end (YYYY-MM-DD)']   || '';
    if (startVal || endVal) {
      const tf = buildTimeframeFromDates(startVal || null, endVal || null, fiscal_year_start_month);
      if (tf) F.timeframe = tf;
    }
  }

  // --- teams ---
  // All entity types (including objectives) now use 'teams' (plural) and accept multiple values.
  // Note: before 2026-04, objectives used 'team' (singular) and only accepted one value.
  // The PB UI may still limit objectives to 1 team even though the API accepts multiple.
  {
    const teamsVal = normalizedRow['teams'] || normalizedRow['team'] || '';
    if (!skip(teamsVal) && teamsVal) {
      const items = teamsVal.split(',').map((s) => ({ name: _sanitizeTeamName(s) })).filter((t) => t.name);
      if (items.length) {
        F.teams = items;
      }
    }
  }

  // --- archived ---
  const archivedVal = normalizedRow['archived'] || '';
  if (archivedVal !== '' && archivedVal != null) {
    const s = String(archivedVal).trim();
    if (s) F.archived = /^true$/i.test(s) ? true : /^false$/i.test(s) ? false : undefined;
    if (F.archived === undefined) delete F.archived;
  }

  // --- health ---
  if (HEALTH_TYPES.has(entityType)) {
    const healthStatus = normalizedRow['health_status'] || '';
    if (healthStatus) {
      const healthObj = { mode: 'manual', status: healthStatus };
      const healthComment = normalizedRow['health_comment'] || '';
      if (healthComment) healthObj.comment = healthComment;
      F.health = healthObj;
    }
  }

  // --- progress (keyResult only) ---
  if (HAS_PROGRESS.has(entityType)) {
    const startVal   = normalizedRow['progress_start']   ?? '';
    const currentVal = normalizedRow['progress_current'] ?? '';
    const targetVal  = normalizedRow['progress_target']  ?? '';
    if (startVal !== '' || currentVal !== '' || targetVal !== '') {
      const progressObj = {};
      const ps = parseFloat(startVal);
      const pc = parseFloat(currentVal);
      const pt = parseFloat(targetVal);
      if (!isNaN(ps)) progressObj.startValue   = ps;
      if (!isNaN(pc)) progressObj.currentValue = pc;
      if (!isNaN(pt)) progressObj.targetValue  = pt;
      if (Object.keys(progressObj).length > 0) F.progress = progressObj;
    }
  }

  // --- workProgress ---
  const wpVal = normalizedRow['workProgress'] || '';
  if (wpVal) {
    const wpNum = parseFloat(wpVal);
    if (!isNaN(wpNum)) F.workProgress = { value: Math.round(wpNum), mode: 'manual' };
  }

  // --- custom__ fields ---
  for (const [k, rawVal] of Object.entries(normalizedRow)) {
    const m = CUSTOM_RE.exec(k);
    if (!m) continue;
    const fieldId = m[1];
    if (!fieldId || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(fieldId)) continue;

    const fieldConfig = configById[fieldId];
    const typeToken   = schemaToToken(fieldConfig?.schema || '');
    const isEmpty_    = rawVal === null || rawVal === undefined || String(rawVal).trim() === '';

    if (isEmpty_) {
      if (bypassEmptyCells && !isCreate) continue; // skip on update
      if (typeToken === 'multiselect') {
        // explicit clear for multi-select (empty = wipe all)
        F[fieldId] = [];
      }
      continue;
    }

    const isMulti = typeToken === 'multiselect';
    if (isMulti) {
      const val = normalizeCustomValue(rawVal, typeToken, fieldConfig?.schema || '');
      if (val !== null && val !== undefined) F[fieldId] = val;
      continue;
    }

    // single-select respects multiSelectMode
    if (typeToken === 'singleselect') {
      const sVal = String(rawVal || '').trim();
      if (multiSelectMode === 'set') {
        if (sVal) {
          F[fieldId] = { name: sVal };
        } else if (!isCreate) {
          F[fieldId] = { __clearField: true };
        }
      } else if (multiSelectMode === 'addItems' && sVal) {
        F[fieldId] = { name: sVal };
      } else if (multiSelectMode === 'removeItems' && sVal && !isCreate) {
        F[fieldId] = { __clearField: true };
      }
      continue;
    }

    const val = normalizeCustomValue(rawVal, typeToken, fieldConfig?.schema || '');
    if (val !== null && val !== undefined) F[fieldId] = val;
  }

  // Drop empty/malformed keys
  for (const k of Object.keys(F)) {
    if (!k || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(k)) delete F[k];
  }

  return F;
}

// ---------------------------------------------------------------------------
// buildPatchOperations
// ---------------------------------------------------------------------------

function buildPatchOperations(fields, configById, multiSelectMode) {
  const ops = [];
  for (const [fieldId, value] of Object.entries(fields)) {
    if (value && typeof value === 'object' && value.__clearField === true) {
      ops.push({ op: 'clear', path: fieldId });
      continue;
    }
    const fieldConfig = configById[fieldId];
    const typeToken   = schemaToToken(fieldConfig?.schema || '');
    const isMulti     = typeToken === 'multiselect' || typeToken === 'tags';

    if (isMulti) {
      ops.push({ op: multiSelectMode, path: fieldId, value });
    } else {
      ops.push({ op: 'set', path: fieldId, value });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// buildTimeframeFromDates
// ---------------------------------------------------------------------------

/**
 * Pure JS port of buildTimeframeFromDates_() from mainLogicImporter.gs.
 * fiscalStartMonth: 1–12 (default 1 = January)
 */
function buildTimeframeFromDates(startDate, endDate, fiscalStartMonth = 1) {
  const normalize = (d) => {
    if (!d) return null;
    const s = String(d).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };

  let start = normalize(startDate);
  let end   = normalize(endDate);
  if (!start && end)   start = end;
  if (!end   && start) end   = start;
  if (!start || !end)  return null;

  if (start > end) { const tmp = start; start = end; end = tmp; }

  const sd = new Date(start + 'T00:00:00Z');
  const ed = new Date(end   + 'T00:00:00Z');

  const pad         = (n) => String(n).padStart(2, '0');
  const firstOfMonth = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-01`;
  const lastOfMonth  = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).toISOString().slice(0, 10);

  const monthAligned =
    start === firstOfMonth(sd) &&
    end   === lastOfMonth(ed.getUTCFullYear(), ed.getUTCMonth()) &&
    sd.getUTCFullYear() === ed.getUTCFullYear() &&
    sd.getUTCMonth() === ed.getUTCMonth();

  const f0      = (fiscalStartMonth - 1 + 12) % 12;
  const qStarts = [f0, (f0 + 3) % 12, (f0 + 6) % 12, (f0 + 9) % 12];
  const isQStart = sd.getUTCDate() === 1 && qStarts.includes(sd.getUTCMonth());
  let quarterAligned = false;
  if (isQStart) {
    const endM0 = (sd.getUTCMonth() + 2) % 12;
    const endY  = sd.getUTCFullYear() + (endM0 < sd.getUTCMonth() ? 1 : 0);
    quarterAligned = end === lastOfMonth(endY, endM0);
  }

  const isYStart = sd.getUTCDate() === 1 && sd.getUTCMonth() === f0;
  let yearAligned = false;
  if (isYStart) {
    const endM0 = (f0 + 11) % 12;
    const endY  = endM0 < f0 ? sd.getUTCFullYear() + 1 : sd.getUTCFullYear();
    yearAligned = end === lastOfMonth(endY, endM0);
  }

  let granularity = 'day';
  if (yearAligned)    granularity = 'year';
  else if (quarterAligned) granularity = 'quarter';
  else if (monthAligned)   granularity = 'month';

  return { startDate: start, endDate: end, granularity };
}

// ---------------------------------------------------------------------------
// normalizeCustomValue
// ---------------------------------------------------------------------------

function normalizeCustomValue(val, typeToken, schema) {
  const tt = String(typeToken || '').toLowerCase().replace(/\./g, '');

  if (tt === 'multiselect') {
    if (val === '' || val == null) return [];
    const s = String(val).trim();
    if (!s) return [];
    return s.split(',').map((x) => x.trim()).filter(Boolean).map((name) => ({ name }));
  }

  if (val === '' || val == null) return null;
  const s = String(val).trim();

  if (tt.includes('richtext') || normalizeSchema(schema).includes('RichText')) {
    return sanitizeDescription(s);
  }
  if (tt === 'singleselect') return { name: s };
  if (tt === 'member') {
    const m = s.match(EMAIL_RE);
    return m ? { email: m[1] } : null;
  }
  if (tt === 'team')   return _sanitizeTeamName(s) ? { name: _sanitizeTeamName(s) } : null;
  if (tt === 'number') {
    const n = Number(s);
    return isNaN(n) ? null : Math.round(n * 100) / 100;
  }
  if (tt === 'date')   return _normalizeDate(s);
  if (/^(true|false)$/i.test(s)) return /^true$/i.test(s);
  return s;
}

// ---------------------------------------------------------------------------
// sanitizeDescription
// ---------------------------------------------------------------------------

function sanitizeDescription(html) {
  if (!html) return null;
  const s = String(html).trim();
  if (!s) return null;
  // If no HTML tags, wrap plain text in a paragraph.
  // Escape HTML special chars first so e.g. "Foo & Bar" becomes valid XML.
  if (!/<\/?[a-z][\s\S]*>/i.test(s)) {
    const escaped = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<p>${escaped.replace(/\n/g, '<br/>')}</p>`;
  }
  // Escape bare & that aren't already part of an HTML entity reference,
  // so sanitize-html doesn't pass invalid XML to the PB API.
  const preEscaped = s.replace(/&(?![a-zA-Z#][a-zA-Z0-9]*;)/g, '&amp;');
  return sanitizeHtml(preEscaped, SANITIZE_OPTS) || null;
}

// ---------------------------------------------------------------------------
// schemaToToken
// ---------------------------------------------------------------------------

function schemaToToken(schema) {
  const s = normalizeSchema(schema).toLowerCase();
  if (s.includes('richtext'))    return 'richtext';
  if (s.includes('singleselect') || s.includes('status')) return 'singleselect';
  if (s.includes('multiselect')) return 'multiselect';
  if (s.includes('member'))      return 'member';
  if (s.includes('team'))        return 'team';
  if (s.includes('date'))        return 'date';
  if (s.includes('number'))      return 'number';
  return 'text';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _indexConfigById(config) {
  const byId = {};
  for (const f of [...(config?.systemFields || []), ...(config?.customFields || [])]) {
    byId[f.id] = f;
  }
  return byId;
}

function _sanitizeTeamName(name) {
  if (name == null) return '';
  return String(name).trim();
}

/** Normalise a date string to YYYY-MM-DD. Duplicated from fieldFormat.js to avoid circular dep. */
function _normalizeDate(raw) {
  const s = String(raw).trim();
  if (ISO_DATE_RE.test(s)) return s;
  const cleaned = s.replace(/T$/, '');
  if (ISO_DATE_RE.test(cleaned)) return cleaned;
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return s;
  const yyyy = d.getFullYear() < 100 ? d.getFullYear() + 2000 : d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

module.exports = {
  applyMapping,
  buildCreatePayload,
  buildPatchPayload,
  buildFieldsObject,
  buildPatchOperations,
  buildTimeframeFromDates,
  normalizeCustomValue,
  sanitizeDescription,
  schemaToToken,
};
