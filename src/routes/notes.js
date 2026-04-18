/**
 * Notes routes
 *
 * POST /api/notes/export
 *   Export all notes to CSV. SSE stream.
 *   Headers: x-pb-token, x-pb-eu
 *
 * POST /api/notes/import/preview
 *   Validate CSV + mapping before import. Returns errors.
 *   Body: { csvText, mapping }
 *
 * POST /api/notes/import/run
 *   Import notes via v1 API with v2 backfill. SSE stream.
 *   Body: { csvText, mapping, migrationMode }
 *
 * POST /api/notes/delete/by-csv
 *   Delete notes by UUID column in CSV. SSE stream.
 *   Body: { csvText, uuidColumn }
 *
 * POST /api/notes/delete/all
 *   Delete every note in the workspace. SSE stream.
 *
 * POST /api/notes/migrate-prep
 *   Transform an export CSV for migration (pb_id → ext_id). No API calls.
 *   Body: { csvText, sourceOriginName }
 *   Returns: { csv, count }
 *
 * --- API conventions ---
 * v2 list:       GET  /v2/notes           cursor from response.links.next
 * v1 list:       GET  /notes              cursor from response.pageCursor
 * v1 create:     POST /notes              no wrapper
 * v1 update:     PATCH /notes/{id}        { data: { ... } }
 * v2 backfill:   PATCH /v2/notes/{id}     { data: { patch: [...] } }
 * v2 relate:     POST  /v2/notes/{id}/relationships  { data: { type, target } }
 * v2 delete:     DELETE /v2/notes/{id}    204 response
 * v2 search:     POST /v2/notes/search       { data: { filter: { ... } } }
 */

const express = require('express');
const { extractCursor, fetchAllEntitiesPost, paginateOffset } = require('../lib/pbClient');
const { parseCSV, generateCSV, cell } = require('../lib/csvUtils');
const { startSSE } = require('../lib/sse');
const { parseApiError } = require('../lib/errorUtils');
const { UUID_RE } = require('../lib/constants');
const { pbAuth } = require('../middleware/pbAuth');
const { normalizeSchema } = require('../services/entities/configCache');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// CSV column headers for export (order must match transformation in buildNoteRow)
const CSV_FIELDS = [
  'pb_id', 'type', 'title', 'content', 'display_url',
  'user_email', 'company_domain', 'owner_email', 'creator_email',
  'tags', 'source_origin', 'source_record_id', 'archived', 'processed',
  'created_at', 'updated_at', 'linked_entities',
];
const CSV_HEADERS = [
  'PB Note ID', 'Note Type', 'Title', 'Content', 'Display URL',
  'User Email', 'Company Domain', 'Owner Email', 'Creator Email',
  'Tags', 'Source Origin', 'Source Record ID', 'Archived', 'Processed',
  'Created At', 'Updated At', 'Linked Entities',
];

function isTruthy(val) {
  return val === true || val === 'TRUE' || val === 'true' || val === '1' || val === 1;
}

function normalizeUrl(url) {
  if (!url) return '';
  const s = String(url).trim();
  if (!s) return '';
  return /^https?:\/\//i.test(s) ? s : 'https://' + s;
}

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------

/** Paginate v2 notes list. Returns array of note objects (relationships inline). */
async function fetchAllNotesV2(pbFetch, withRetry, onProgress, filters = {}) {
  const notes = [];
  let cursor = null;
  let page = 0;

  do {
    const params = new URLSearchParams();
    if (filters.createdFrom) params.set('createdFrom', filters.createdFrom);
    if (filters.createdTo)   params.set('createdTo',   filters.createdTo);
    if (cursor)              params.set('pageCursor',   cursor);
    const qs = params.toString();
    const url = `/v2/notes${qs ? `?${qs}` : ''}`;
    const response = await withRetry(() => pbFetch('get', url), `fetch notes page ${page + 1}`);
    if (response.data?.length) notes.push(...response.data);
    cursor = extractCursor(response.links?.next);
    page++;
    if (onProgress) onProgress(notes.length);
  } while (cursor);

  return notes;
}

/** Build a descriptive export filename based on optional date filter bounds. */
function buildExportFilename(createdFrom, createdTo) {
  if (!createdFrom && !createdTo) {
    return `notes-export-${new Date().toISOString().slice(0, 10)}.csv`;
  }
  if (createdFrom && createdTo) {
    return `notes-export-${createdFrom.slice(0, 10)}-to-${createdTo.slice(0, 10)}.csv`;
  }
  if (createdFrom) {
    return `notes-export-from-${createdFrom.slice(0, 10)}.csv`;
  }
  return `notes-export-to-${createdTo.slice(0, 10)}.csv`;
}

/** Build UUID→email map from v1 /users endpoint. */
async function buildUserCache(pbFetch, withRetry) {
  const map = new Map();
  await paginateOffset(pbFetch, withRetry, '/users', (data) => {
    for (const u of data) {
      if (u.id && u.email) map.set(u.id, u.email);
    }
  });
  return map;
}

/** Build UUID→domain map from /companies endpoint. */
async function buildCompanyCache(pbFetch, withRetry) {
  const map = new Map();
  await paginateOffset(pbFetch, withRetry, '/companies', (data) => {
    for (const c of data) {
      if (c.id && c.domain) map.set(c.id, c.domain);
    }
  });
  return map;
}

/** Build UUID→{origin,record_id} map from v1 /notes endpoint. Used for source enrichment. */
async function buildV1SourceMap(pbFetch, withRetry) {
  const map = new Map();
  let cursor = null;
  const limit = 100;
  const MAX_PAGES = 1000;
  let page = 0;

  while (page < MAX_PAGES) {
    let url = `/notes?pageLimit=${limit}`;
    if (cursor) url += `&pageCursor=${encodeURIComponent(cursor)}`;

    const r = await withRetry(() => pbFetch('get', url), `fetch v1 notes source page ${page + 1}`);
    if (!r.data?.length) break;

    for (const note of r.data) {
      if (note.id) {
        map.set(note.id, {
          origin: note.source?.origin || null,
          record_id: note.source?.record_id || null,
        });
      }
    }

    cursor = r.pageCursor || null;
    if (!cursor) break;
    page++;
  }

  return map;
}

/** Transform a single v2 note object to a CSV row object. */
function buildNoteRow(note, userCache, companyCache, sourceMap) {
  const f = note.fields || {};
  const rels = Array.isArray(note.relationships?.data) ? note.relationships.data : [];

  // Resolve customer relationship
  const customerRel = rels.find((r) => r.type === 'customer');
  let userEmail = '';
  let companyDomain = '';
  if (customerRel?.target) {
    const { id, type } = customerRel.target;
    if (type === 'user') userEmail = userCache.get(id) || '';
    else if (type === 'company') companyDomain = companyCache.get(id) || '';
  }

  // Linked entity UUIDs
  const linkedEntities = rels
    .filter((r) => r.type === 'link' && r.target?.id)
    .map((r) => r.target.id)
    .join(',');

  // Source: prefer metadata.source (new v2), fall back to fields.source (deprecated), then v1 map
  const metaSrc = note.metadata?.source || {};
  let sourceOrigin = metaSrc.system || f.source?.origin || '';
  let sourceRecordId = metaSrc.recordId || f.source?.id || f.source?.recordId || '';
  if (!sourceOrigin && sourceMap) {
    const v1 = sourceMap.get(note.id);
    if (v1) {
      if (v1.origin) sourceOrigin = v1.origin;
      if (!sourceRecordId && v1.record_id) sourceRecordId = v1.record_id;
    }
  }

  // Content: serialize arrays as JSON (conversation / opportunity types)
  let content = f.content || '';
  if (typeof content === 'object') content = JSON.stringify(content);

  // Tags: array of {name} → comma-separated string
  const tags = (f.tags || []).map((t) => t.name).join(', ');

  return {
    pb_id: note.id || '',
    type: note.type || 'textNote',
    title: f.name || '',
    content,
    display_url: f.displayUrl || f.display_url || '',
    user_email: userEmail,
    company_domain: companyDomain,
    owner_email: f.owner?.email || '',
    creator_email: f.creator?.email || '',
    tags,
    source_origin: sourceOrigin,
    source_record_id: sourceRecordId,
    archived: isTruthy(f.archived) ? 'TRUE' : 'FALSE',
    processed: isTruthy(f.processed) ? 'TRUE' : 'FALSE',
    created_at: note.createdAt || '',
    updated_at: note.updatedAt || '',
    linked_entities: linkedEntities,
  };
}

// ---------------------------------------------------------------------------
// Import helpers
// ---------------------------------------------------------------------------

/** Build v1 create/update payload from a CSV row (using mapping). */
function buildV1Payload(row, mapping, isCreate) {
  const get = (col) => cell(row, col);

  const title = get(mapping.titleColumn);
  const content = get(mapping.contentColumn);
  const displayUrl = normalizeUrl(get(mapping.displayUrlColumn));
  const userEmail = get(mapping.userEmailColumn);
  const companyDomain = get(mapping.companyDomainColumn);
  const ownerEmail = get(mapping.ownerEmailColumn);
  const tagsRaw = get(mapping.tagsColumn);
  const sourceOrigin = get(mapping.sourceOriginColumn);
  const sourceRecordId = get(mapping.sourceRecordIdColumn);

  const payload = {};
  if (title) payload.title = title;
  if (content) payload.content = content;
  if (displayUrl) payload.display_url = displayUrl;

  // Customer relationship (user takes priority over company)
  if (userEmail) payload.user = { email: userEmail };
  else if (companyDomain) payload.company = { domain: companyDomain };

  if (ownerEmail) payload.owner = { email: ownerEmail };

  if (tagsRaw) {
    payload.tags = tagsRaw.split(',').map((t) => t.trim()).filter(Boolean);
  }

  // Source is immutable — only set on create
  if (isCreate && sourceOrigin && sourceRecordId) {
    payload.source = { origin: sourceOrigin, record_id: sourceRecordId };
  }

  return payload;
}

/**
 * Create a note via v1 API. Retries without owner if rejected.
 * Returns { id, ownerRejected }.
 */
async function createNote(pbFetch, withRetry, payload) {
  let ownerRejected = false;

  const tryCreate = async (p) => {
    const r = await withRetry(() => pbFetch('post', '/notes', p), 'create note');
    return r.id || r.data?.id;
  };

  let noteId;
  try {
    noteId = await tryCreate(payload);
  } catch (err) {
    const msg = parseApiError(err);
    if (payload.owner && (msg.toLowerCase().includes('owner') || msg.includes('User does not exist'))) {
      const p2 = { ...payload };
      delete p2.owner;
      ownerRejected = true;
      noteId = await tryCreate(p2);
    } else {
      throw err;
    }
  }

  if (!noteId) throw new Error('API did not return a note ID');
  return { id: noteId, ownerRejected };
}

/**
 * Update a note via v1 PATCH. Retries without owner if rejected.
 * Returns { ownerRejected }.
 */
async function updateNote(pbFetch, withRetry, noteId, payload) {
  let ownerRejected = false;

  const tryUpdate = async (p) => {
    await withRetry(() => pbFetch('patch', `/notes/${noteId}`, { data: p }), `update note ${noteId}`);
  };

  try {
    await tryUpdate(payload);
  } catch (err) {
    const msg = parseApiError(err);
    if (payload.owner && (msg.toLowerCase().includes('owner') || msg.includes('User does not exist'))) {
      const p2 = { ...payload };
      delete p2.owner;
      ownerRejected = true;
      await tryUpdate(p2);
    } else {
      throw err;
    }
  }

  return { ownerRejected };
}

/**
 * Backfill archived, processed, creator, owner via v2 PATCH.
 * Retries on 404 (v1→v2 propagation delay), then falls back to status-only.
 */
async function backfillV2(pbFetch, withRetry, noteId, { archived, processed, creatorEmail, ownerEmail }) {
  const ops = [];
  if (archived !== undefined) ops.push({ op: 'set', path: 'archived', value: archived });
  if (processed !== undefined) ops.push({ op: 'set', path: 'processed', value: processed });
  if (creatorEmail) ops.push({ op: 'set', path: 'creator', value: { email: creatorEmail } });
  if (ownerEmail) ops.push({ op: 'set', path: 'owner', value: { email: ownerEmail } });
  if (!ops.length) return;

  const patch = async (patchOps) => {
    await pbFetch('patch', `/v2/notes/${noteId}`, { data: { patch: patchOps } });
  };

  // Retry up to 3× on 404 (propagation delay from v1 to v2)
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      await patch(ops);
      return;
    } catch (err) {
      const msg = String(err.message || err);
      if ((err.status === 404 || msg.includes('404')) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      // If creator/owner caused the failure, retry with status-only ops
      if (creatorEmail || ownerEmail) {
        const statusOps = ops.filter((o) => o.path === 'archived' || o.path === 'processed');
        if (statusOps.length) {
          try { await patch(statusOps); } catch (_) {}
        }
      }
      return; // Non-fatal — log but don't throw
    }
  }
}

/**
 * Link a note to a hierarchy entity via v2.
 * 422 "already linked" is silently skipped.
 */
async function linkNoteToEntity(pbFetch, withRetry, noteId, entityId) {
  try {
    await withRetry(
      () => pbFetch('post', `/v2/notes/${noteId}/relationships`, {
        data: { type: 'link', target: { id: entityId, type: 'link' } },
      }),
      `link note ${noteId} → entity ${entityId}`
    );
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.includes('422') && msg.toLowerCase().includes('already')) return; // already linked — ok
    throw err;
  }
}

/**
 * Look up the custom field ID for a given field name on hierarchy entities.
 * Returns { fieldId, fieldName } or null if not found.
 */
async function findMigrationFieldId(pbFetch, withRetry, fieldName) {
  try {
    const r = await withRetry(
      () => pbFetch('get', '/v2/entities/configurations/feature'),
      'fetch entity config'
    );
    const fields = Object.values((r?.data?.fields) || {});
    const f = fields.find((f) => f.name === fieldName && normalizeSchema(f.schema) === 'TextFieldValue');
    return f ? f.id : null;
  } catch (_) {
    return null;
  }
}

/**
 * Build a cache mapping original UUIDs → new UUIDs by reading a custom text field
 * from all hierarchy entities in the target workspace.
 * @param {Function} pbFetch
 * @param {Function} withRetry
 * @param {string} fieldName - Name of the custom text field holding the original UUID (default: 'original_uuid')
 */
async function buildMigrationCache(pbFetch, withRetry, fieldName = 'original_uuid') {
  const cache = new Map();
  const types = ['feature', 'component', 'product', 'subfeature'];

  const fieldId = await findMigrationFieldId(pbFetch, withRetry, fieldName);

  if (!fieldId) return cache; // No migration field configured — empty cache

  for (const type of types) {
    const entities = await fetchAllEntitiesPost(
      pbFetch, withRetry,
      { data: { types: [type] } },
      `fetch ${type} for migration cache`
    );
    for (const entity of entities) {
      const originalUuid = (entity.fields || {})[fieldId];
      if (originalUuid && UUID_RE.test(originalUuid)) {
        cache.set(originalUuid, entity.id);
      }
    }
  }

  return cache;
}

// ---------------------------------------------------------------------------
// Route 1: Export
// ---------------------------------------------------------------------------

router.post('/export', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const sse = startSSE(res);
  const { createdFrom, createdTo } = req.body || {};

  try {
    // Step 1: Fetch notes (with optional created-at filter)
    const filterDesc = createdFrom || createdTo
      ? ` (filtered by date)`
      : '';
    sse.progress(`Fetching notes from Productboard${filterDesc}…`, 5);
    const notes = await fetchAllNotesV2(pbFetch, withRetry, (count) => {
      sse.progress(`Fetched ${count} notes…`, Math.min(5 + Math.round(count / 100), 35));
    }, { createdFrom, createdTo });

    if (notes.length === 0) {
      sse.complete({ csv: '', filename: 'notes-export.csv', count: 0 });
      sse.done();
      return;
    }

    sse.progress(`Fetched ${notes.length} notes. Building user cache…`, 40);
    const userCache = await buildUserCache(pbFetch, withRetry);

    sse.progress(`User cache: ${userCache.size} users. Building company cache…`, 50);
    const companyCache = await buildCompanyCache(pbFetch, withRetry);

    sse.progress(`Company cache: ${companyCache.size} companies. Enriching source data from v1…`, 60);
    let sourceMap = null;
    try {
      sourceMap = await buildV1SourceMap(pbFetch, withRetry);
    } catch (err) {
      sse.progress('Warning: v1 source enrichment failed, source fields may be incomplete.', 75);
    }

    sse.progress('Building CSV…', 85);
    const rows = notes.map((note) => buildNoteRow(note, userCache, companyCache, sourceMap));

    const csv = generateCSV(rows, CSV_FIELDS, CSV_FIELDS);
    const filename = buildExportFilename(createdFrom, createdTo);

    sse.complete({ csv, filename, count: notes.length });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// Route 2: Import preview (validation, no API calls)
// ---------------------------------------------------------------------------

router.post('/import/preview', pbAuth, async (req, res) => {
  const { csvText, mapping } = req.body;
  if (!csvText || !mapping) return res.status(400).json({ error: 'Missing csvText or mapping' });

  const { rows, errors: parseErrors } = parseCSV(csvText);
  if (parseErrors.length) {
    return res.json({ valid: false, totalRows: 0, errors: parseErrors.map((e) => ({ row: null, field: null, message: e })) });
  }

  const errors = [];
  const warnings = [];
  const pbIdsSeen = new Set();

  rows.forEach((row, i) => {
    const rowNum = i + 1;
    const err = (field, message) => errors.push({ row: rowNum, field, message });
    const warn = (field, message) => warnings.push({ row: rowNum, field, message });

    const title = cell(row, mapping.titleColumn);
    const content = cell(row, mapping.contentColumn);
    const pbId = cell(row, mapping.pbIdColumn);
    const userEmail = cell(row, mapping.userEmailColumn);
    const ownerEmail = cell(row, mapping.ownerEmailColumn);
    const creatorEmail = cell(row, mapping.creatorEmailColumn);
    const companyDomain = cell(row, mapping.companyDomainColumn);
    const noteType = cell(row, mapping.typeColumn);
    const sourceOrigin = cell(row, mapping.sourceOriginColumn);
    const sourceRecordId = cell(row, mapping.sourceRecordIdColumn);
    const linkedEntities = cell(row, mapping.linkedEntitiesColumn);

    // Required only on CREATE
    const validPbId = pbId && UUID_RE.test(pbId);
    if (!title && !validPbId) err('title', 'Title is required when creating a new note');

    // UUID format
    if (pbId && !UUID_RE.test(pbId)) err('pb_id', 'pb_id must be a valid UUID');
    if (pbId && UUID_RE.test(pbId)) {
      if (pbIdsSeen.has(pbId)) err('pb_id', `Duplicate pb_id: ${pbId}`);
      else pbIdsSeen.add(pbId);
    }

    // Email format
    if (userEmail && !EMAIL_RE.test(userEmail)) err('user_email', 'Invalid email format');
    if (ownerEmail && !EMAIL_RE.test(ownerEmail)) err('owner_email', 'Invalid email format');
    if (creatorEmail && !EMAIL_RE.test(creatorEmail)) err('creator_email', 'Invalid email format');

    // Domain format
    if (companyDomain && !DOMAIN_RE.test(companyDomain)) err('company_domain', 'Invalid domain format');

    // Note type
    if (noteType && !['textNote', 'conversationNote', 'opportunityNote'].includes(noteType)) {
      err('type', 'Type must be "textNote", "conversationNote", or "opportunityNote"');
    }

    // Source consistency
    if (sourceRecordId && !sourceOrigin) err('source_record_id', 'source_record_id requires source_origin');
    if (sourceOrigin && !sourceRecordId) warn('source_origin', 'source_record_id missing — will be auto-generated on import');

    // Linked entity UUID format
    if (linkedEntities) {
      const uuids = linkedEntities.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = uuids.filter((u) => !UUID_RE.test(u));
      if (bad.length) err('linked_entities', `Invalid UUID(s) in linked_entities: ${bad.join(', ')}`);
    }

    // Warnings
    if (userEmail && companyDomain) {
      warn('user_email', 'Both user_email and company_domain provided — user_email takes priority');
    }
  });

  res.json({
    valid: errors.length === 0,
    totalRows: rows.length,
    errors,
    warnings,
  });
});

// ---------------------------------------------------------------------------
// Route 3: Import run (SSE)
// ---------------------------------------------------------------------------

router.post('/import/run', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;

  const { csvText, mapping, migrationMode, migrationFieldName } = req.body;
  if (!csvText || !mapping) return res.status(400).json({ error: 'Missing csvText or mapping' });

  const sse = startSSE(res);


  const result = { total: 0, created: 0, updated: 0, skipped: 0, errors: 0, stopped: false };

  try {
    const { rows } = parseCSV(csvText);
    result.total = rows.length;

    // Build migration cache if needed (maps old entity UUIDs → new entity UUIDs)
    let migrationCache = null;
    if (migrationMode && mapping.linkedEntitiesColumn) {
      sse.progress('Building migration entity cache…', 2);
      try {
        migrationCache = await buildMigrationCache(pbFetch, withRetry, migrationFieldName || 'original_uuid');
        sse.progress(`Migration cache: ${migrationCache.size} entity mappings found.`, 5);
      } catch (err) {
        sse.log('warn', 'Migration cache build failed — hierarchy links will use original UUIDs', parseApiError(err));
      }
    }

    // Auto-generate source_record_ids for rows that need them
    const sourceCounters = {};

    for (let i = 0; i < rows.length; i++) {
      if (sse.isAborted()) { result.stopped = true; break; }

      const row = rows[i];
      const rowNum = i + 1;
      const pct = 5 + Math.round((i / rows.length) * 90);
      sse.progress(`Processing row ${rowNum}/${rows.length}…`, pct);

      try {
        const pbId = cell(row, mapping.pbIdColumn);
        let sourceOrigin = cell(row, mapping.sourceOriginColumn);
        let sourceRecordId = cell(row, mapping.sourceRecordIdColumn);

        // Auto-generate source_record_id if origin is set but record_id is missing
        if (sourceOrigin && !sourceRecordId) {
          sourceCounters[sourceOrigin] = (sourceCounters[sourceOrigin] || 0) + 1;
          sourceRecordId = `${sourceOrigin}-${sourceCounters[sourceOrigin]}`;
          // Inject back into row for payload building
          if (mapping.sourceRecordIdColumn) row[mapping.sourceRecordIdColumn] = sourceRecordId;
        }

        // Determine action
        let action = 'CREATE';
        let targetNoteId = null;

        if (pbId && UUID_RE.test(pbId)) {
          action = 'UPDATE';
          targetNoteId = pbId;
        }

        const payload = buildV1Payload(row, mapping, action === 'CREATE');
        let noteId;
        let ownerRejected = false;

        if (action === 'CREATE') {
          const r = await createNote(pbFetch, withRetry, payload);
          noteId = r.id;
          ownerRejected = r.ownerRejected;
          result.created++;
          sse.log('success', `Row ${rowNum}: Created note "${payload.title}"`, { uuid: noteId, row: rowNum });
        } else {
          if (Object.keys(payload).length === 0) {
            result.skipped++;
            noteId = targetNoteId;
            sse.log('warn', `Row ${rowNum}: No updatable fields mapped — v1 PATCH skipped`, { uuid: noteId, row: rowNum });
          } else {
            const r = await updateNote(pbFetch, withRetry, targetNoteId, payload);
            noteId = targetNoteId;
            ownerRejected = r.ownerRejected;
            result.updated++;
            sse.log('success', `Row ${rowNum}: Updated note "${payload.title || noteId}"`, { uuid: noteId, row: rowNum });
          }
        }

        if (sse.isAborted()) { result.stopped = true; break; }

        // v2 backfill (archived, processed, creator, owner if rejected by v1)
        const archivedVal = cell(row, mapping.archivedColumn);
        const processedVal = cell(row, mapping.processedColumn);
        const creatorEmail = cell(row, mapping.creatorEmailColumn);
        const ownerEmail = cell(row, mapping.ownerEmailColumn);

        const needsBackfill =
          archivedVal !== '' ||
          processedVal !== '' ||
          creatorEmail ||
          (ownerRejected && ownerEmail);

        if (needsBackfill) {
          await backfillV2(pbFetch, withRetry, noteId, {
            archived: archivedVal !== '' ? isTruthy(archivedVal) : undefined,
            processed: processedVal !== '' ? isTruthy(processedVal) : undefined,
            creatorEmail: creatorEmail || null,
            ownerEmail: ownerRejected && ownerEmail ? ownerEmail : null,
          });
          if (sse.isAborted()) { result.stopped = true; break; }
        }

        // Hierarchy linking
        const linkedEntitiesRaw = cell(row, mapping.linkedEntitiesColumn);
        if (linkedEntitiesRaw) {
          const uuids = linkedEntitiesRaw.split(',').map((s) => s.trim()).filter((s) => UUID_RE.test(s));
          for (const originalUuid of uuids) {
            if (sse.isAborted()) break;
            const targetUuid = migrationCache ? (migrationCache.get(originalUuid) || null) : originalUuid;
            if (!targetUuid) {
              sse.log('warn', `Row ${rowNum}: Entity ${originalUuid} not found in migration cache — skipped`, { row: rowNum });
              continue;
            }
            try {
              await linkNoteToEntity(pbFetch, withRetry, noteId, targetUuid);
            } catch (linkErr) {
              sse.log('warn', `Row ${rowNum}: Failed to link entity ${targetUuid} — ${parseApiError(linkErr)}`, { row: rowNum });
            }
          }
        }

      } catch (err) {
        result.errors++;
        sse.log('error', `Row ${rowNum}: ${parseApiError(err)}`, { row: rowNum });
      }
    }

    sse.complete(result);
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// Route 4: Delete by CSV (SSE)
// ---------------------------------------------------------------------------

router.post('/delete/by-csv', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;

  const { csvText, uuidColumn } = req.body;
  if (!csvText || !uuidColumn) return res.status(400).json({ error: 'Missing csvText or uuidColumn' });

  const sse = startSSE(res);


  try {
    const { rows } = parseCSV(csvText);

    const uuids = rows
      .map((r) => cell(r, uuidColumn))
      .filter((id) => UUID_RE.test(id));

    if (uuids.length === 0) {
      sse.complete({ total: 0, deleted: 0, errors: 0 });
      sse.done();
      return;
    }

    let deleted = 0;
    let errors = 0;

    for (let i = 0; i < uuids.length; i++) {
      if (sse.isAborted()) break;
      const id = uuids[i];
      const pct = Math.round(((i + 1) / uuids.length) * 100);

      try {
        await withRetry(() => pbFetch('delete', `/v2/notes/${id}`), `delete note ${id}`);
        deleted++;
        sse.log('success', `Deleted note ${id}`, '');
      } catch (err) {
        if (err.status === 404) {
          sse.log('warn', `Note ${id} not found — skipped`, '');
        } else {
          errors++;
          sse.log('error', `Failed to delete ${id}: ${parseApiError(err)}`, '');
        }
      }

      sse.progress(`Deleted ${deleted} of ${uuids.length}…`, pct);
    }

    sse.complete({ total: uuids.length, deleted, errors });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// Route 5: Delete all (SSE)
// ---------------------------------------------------------------------------

router.post('/delete/all', pbAuth, async (_req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const sse = startSSE(res);


  try {
    sse.progress('Collecting all note IDs…', 5);
    const allIds = [];
    let cursor = null;

    do {
      const url = `/v2/notes${cursor ? `?pageCursor=${encodeURIComponent(cursor)}` : ''}`;
      const r = await withRetry(() => pbFetch('get', url), 'fetch notes for deletion');
      if (r.data?.length) allIds.push(...r.data.map((n) => n.id));
      cursor = extractCursor(r.links?.next);
    } while (cursor);

    if (allIds.length === 0) {
      sse.complete({ total: 0, deleted: 0, skipped: 0, errors: 0 });
      sse.done();
      return;
    }

    sse.progress(`Found ${allIds.length} notes. Beginning deletion…`, 10);

    let deleted = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < allIds.length; i++) {
      if (sse.isAborted()) break;
      const id = allIds[i];
      const pct = 10 + Math.round(((i + 1) / allIds.length) * 90);

      try {
        await withRetry(() => pbFetch('delete', `/v2/notes/${id}`), `delete note ${id}`);
        deleted++;
        if (deleted % 50 === 0) sse.log('info', `Deleted ${deleted}/${allIds.length} notes…`, '');
      } catch (err) {
        if (err.status === 404) {
          skipped++;
          sse.log('info', `Note ${id} not found — no need to delete`, '');
        } else {
          errors++;
          sse.log('error', `Failed to delete ${id}: ${parseApiError(err)}`, '');
        }
      }

      sse.progress(`Deleted ${deleted} of ${allIds.length}…`, pct);
    }

    sse.complete({ total: allIds.length, deleted, skipped, errors });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// Route 6: Migration prep (no API calls — pure CSV transform)
// ---------------------------------------------------------------------------

router.post('/migrate-prep', async (req, res) => {
  const { csvText, sourceOriginName } = req.body;
  if (!csvText) return res.status(400).json({ error: 'Missing csvText' });
  if (!sourceOriginName?.trim()) return res.status(400).json({ error: 'Missing sourceOriginName' });

  const { rows, headers } = parseCSV(csvText);

  if (!rows.length) return res.json({ csv: '', count: 0 });

  // Ensure source_origin column exists in the output
  const hasSourceOrigin = headers.includes('source_origin');

  let processed = 0;

  const transformed = rows.map((row) => {
    const out = { ...row };
    const pbId = (out['pb_id'] || '').trim();

    if (pbId) {
      // Move pb_id → source_record_id (becomes the stable ID for deduplication on re-import)
      out['source_record_id'] = pbId;
      // Set source_origin to migration name
      out['source_origin'] = sourceOriginName.trim();
      // Clear pb_id (will be a fresh create in the target workspace)
      out['pb_id'] = '';
      processed++;
    }

    return out;
  });

  // Build output header list — ensure source_origin is present
  const outHeaders = [...headers];
  if (!hasSourceOrigin) {
    const soIdx = outHeaders.indexOf('source_record_id');
    outHeaders.splice(soIdx >= 0 ? soIdx : outHeaders.length, 0, 'source_origin');
  }

  const csv = generateCSV(transformed, outHeaders, outHeaders);

  res.json({ csv, count: processed });
});

// ---------------------------------------------------------------------------
// Route 7: Detect migration custom field
// ---------------------------------------------------------------------------

/**
 * POST /api/notes/detect-migration-field
 * Check whether a custom text field with the given name exists on entities.
 * Body: { fieldName }
 * Returns: { found: boolean, fieldName }
 * No API token header required — but we do need it to query PB.
 */
router.post('/detect-migration-field', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;

  const { fieldName } = req.body;
  if (!fieldName?.trim()) return res.status(400).json({ error: 'Missing fieldName' });
  const fieldId = await findMigrationFieldId(pbFetch, withRetry, fieldName.trim());

  res.json({ found: fieldId !== null, fieldName: fieldName.trim() });
});

module.exports = router;
