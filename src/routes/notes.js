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
 *   Import notes via v2 API. SSE stream.
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
 * --- API conventions (v1 retired — v2 only) ---
 * v2 list:       GET  /v2/notes           cursor from response.links.next
 * v2 create:     POST /v2/notes           { data: { type, fields, metadata?, relationships? } }
 * v2 update:     PATCH /v2/notes/{id}     { data: { fields: {...} } }  or  { data: { patch: [...] } }
 * v2 customer:   PUT  /v2/notes/{id}/relationships/customer  { data: { target: { id, type } } }
 * v2 relate:     POST  /v2/notes/{id}/relationships  { data: { type, target } }
 * v2 delete:     DELETE /v2/notes/{id}    204 response
 * v2 search:     POST /v2/notes/search       { data: { filter: { ... } } }
 *
 * Tags are a shared field-value resource (field id "tags") — same create/list
 * endpoints as entity custom select fields, see lib/fieldValues.js.
 * Note relationships require a user/company UUID, not an email/domain string —
 * unknown emails/domains are resolved by creating a new user/company entity.
 */

const express = require('express');
const { extractCursor, fetchAllEntitiesPost } = require('../lib/pbClient');
const { parseCSV, generateCSV, cell } = require('../lib/csvUtils');
const { startSSE } = require('../lib/sse');
const { parseApiError } = require('../lib/errorUtils');
const { UUID_RE } = require('../lib/constants');
const { pbAuth } = require('../middleware/pbAuth');
const { normalizeSchema } = require('../services/entities/configCache');
const { buildDomainToIdMap, buildIdToDomainMap } = require('../lib/domainCache');
const { buildEmailToIdMap, buildIdToEmailMap } = require('../lib/userCache');
const { fetchFieldValues, createFieldValue } = require('../lib/fieldValues');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// CSV column headers for export (order must match transformation in buildNoteRow)
const CSV_FIELDS = [
  'pb_id', 'type', 'title', 'content', 'display_url',
  'user_email', 'company_domain', 'owner_email', 'creator_email',
  'tags', 'source_origin', 'source_record_id', 'archived', 'processed',
  'created_at', 'updated_at', 'linked_entities', 'pb_html_link',
];
const CSV_HEADERS = [
  'PB Note ID', 'Note Type', 'Title', 'Content', 'Display URL',
  'User Email', 'Company Domain', 'Owner Email', 'Creator Email',
  'Tags', 'Source Origin', 'Source Record ID', 'Archived', 'Processed',
  'Created At', 'Updated At', 'Linked Entities', 'PB HTML Link',
];

function isTruthy(val) {
  return val === true || val === 'TRUE' || val === 'true' || val === '1' || val === 1;
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

/** Transform a single v2 note object to a CSV row object. */
function buildNoteRow(note, userCache, companyCache) {
  const f = note.fields || {};
  const rels = Array.isArray(note.relationships?.data) ? note.relationships.data : [];

  // Resolve customer relationship
  const customerRel = rels.find((r) => r.type === 'customer');
  let userEmail = '';
  let companyDomain = '';
  if (customerRel?.target) {
    const { id, type } = customerRel.target;
    if (type === 'user') userEmail = userCache[id]?.email || '';
    else if (type === 'company') companyDomain = companyCache[id]?.domain || '';
  }

  // Linked entity UUIDs
  const linkedEntities = rels
    .filter((r) => r.type === 'link' && r.target?.id)
    .map((r) => r.target.id)
    .join(',');

  // Source: metadata.source (v2 native)
  const metaSrc = note.metadata?.source || {};
  const sourceOrigin   = metaSrc.system   || '';
  const sourceRecordId = metaSrc.recordId || '';

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
    display_url: '', // no v2 field for this — kept as a column for CSV/import compatibility
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
    pb_html_link: note.links?.html || '',
  };
}

// ---------------------------------------------------------------------------
// Import helpers
// ---------------------------------------------------------------------------

/**
 * Extract the failing field name from a v2 validation error's JSON body
 * (source.pointer, e.g. "/data/fields/owner" → "owner"). Returns null if
 * the error isn't a parseable field-validation error.
 */
function extractFailedFieldPath(err) {
  const msg = err.message || '';
  const jsonMatch = msg.match(/\{[\s\S]*"errors"[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const pointer = parsed.errors?.[0]?.source?.pointer || '';
    return pointer.split('/').pop() || null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve a user's email to a v2 user entity UUID, creating the user if not
 * already known. Mutates emailToId in place so repeat emails within the same
 * import reuse the cached id instead of creating duplicates.
 */
async function resolveOrCreateUser(pbFetch, withRetry, emailToId, email) {
  const key = email.toLowerCase().trim();
  if (emailToId[key]) return emailToId[key];
  const r = await withRetry(
    () => pbFetch('post', '/v2/entities', { data: { type: 'user', fields: { email, name: email } } }),
    `create user ${email}`
  );
  const id = r.data?.id || r.id;
  emailToId[key] = id;
  return id;
}

/** Resolve a company domain to a v2 company entity UUID, creating it if not already known. */
async function resolveOrCreateCompany(pbFetch, withRetry, domainToId, domain) {
  const key = domain.toLowerCase().trim();
  if (domainToId[key]) return domainToId[key];
  const r = await withRetry(
    () => pbFetch('post', '/v2/entities', { data: { type: 'company', fields: { domain, name: domain } } }),
    `create company ${domain}`
  );
  const id = r.data?.id || r.id;
  domainToId[key] = id;
  return id;
}

/**
 * Resolve tag names to the shared "tags" field-value set, creating any that
 * don't exist yet. tagCache is a normalised-name → { id, name } Map seeded from
 * lib/fieldValues.js's fetchFieldValues('tags', ...).
 */
async function resolveTags(pbFetch, withRetry, tagCache, tagNames) {
  const result = [];
  for (const name of tagNames) {
    const key = name.toLowerCase().trim();
    if (!key) continue;
    if (!tagCache.has(key)) {
      try {
        const created = await createFieldValue('tags', name, pbFetch, withRetry);
        tagCache.set(key, created);
      } catch (_) {
        continue; // could not create — skip this tag rather than fail the whole row
      }
    }
    result.push({ name: tagCache.get(key).name });
  }
  return result;
}

/** Build the v2 `fields` object (name/content/owner/creator/archived/processed/tags) from a CSV row. */
function buildNoteFieldsV2(row, mapping, resolvedTags) {
  const get = (col) => cell(row, col);

  const title       = get(mapping.titleColumn);
  const content      = get(mapping.contentColumn);
  const ownerEmail   = get(mapping.ownerEmailColumn);
  const creatorEmail = get(mapping.creatorEmailColumn);
  const archivedVal  = get(mapping.archivedColumn);
  const processedVal = get(mapping.processedColumn);

  const fields = {};
  if (title)   fields.name    = title;
  if (content) fields.content = content;
  if (ownerEmail)   fields.owner   = { email: ownerEmail };
  if (creatorEmail) fields.creator = { email: creatorEmail };
  if (archivedVal !== '')  fields.archived  = isTruthy(archivedVal);
  if (processedVal !== '') fields.processed = isTruthy(processedVal);
  if (resolvedTags.length) fields.tags = resolvedTags;

  return fields;
}

/**
 * POST /v2/notes. Retries with owner/creator stripped if PB rejects them
 * (the mapped email isn't an active workspace member). A customer relationship
 * pointing at a user/company entity created moments earlier in this same import
 * can 404 briefly (propagation delay) — retried with backoff before being dropped.
 * Returns { id, ownerSkipped, creatorSkipped, customerSkipped }.
 */
async function createNoteV2(pbFetch, withRetry, { type, fields, sourceOrigin, sourceRecordId, customerRel }) {
  let currentFields = { ...fields };
  let currentCustomerRel = customerRel;
  let ownerSkipped = false, creatorSkipped = false, customerSkipped = false;
  let propagationRetries = 0;

  for (let attempt = 0; attempt < 6; attempt++) {
    const payload = { data: { type: type || 'textNote', fields: currentFields } };
    if (sourceOrigin && sourceRecordId) {
      payload.data.metadata = { source: { system: sourceOrigin, recordId: sourceRecordId } };
    }
    if (currentCustomerRel) payload.data.relationships = [currentCustomerRel];

    try {
      const r = await withRetry(() => pbFetch('post', '/v2/notes', payload), 'create note');
      const id = r.data?.id || r.id;
      if (!id) throw new Error('API did not return a note ID');
      return { id, ownerSkipped, creatorSkipped, customerSkipped };
    } catch (err) {
      const field = extractFailedFieldPath(err);
      const msg = String(err.message || '');

      if (field === 'owner' && currentFields.owner) {
        const { owner, ...rest } = currentFields; currentFields = rest; ownerSkipped = true; continue;
      }
      if (field === 'creator' && currentFields.creator) {
        const { creator, ...rest } = currentFields; currentFields = rest; creatorSkipped = true; continue;
      }
      if (currentCustomerRel && /not found/i.test(msg)) {
        if (propagationRetries < 3) {
          propagationRetries++;
          await new Promise((r) => setTimeout(r, 1500 * propagationRetries));
          continue;
        }
        currentCustomerRel = null;
        customerSkipped = true;
        continue;
      }
      throw err;
    }
  }
  throw new Error('Note create failed after owner/creator/customer fallback retries');
}

/**
 * PATCH /v2/notes/{id} with the same owner/creator fallback as create.
 * The customer relationship (if resolved) is written separately via
 * setNoteCustomer — it isn't part of the fields PATCH body.
 * Returns { ownerSkipped, creatorSkipped }.
 */
async function updateNoteV2(pbFetch, withRetry, noteId, fields) {
  let currentFields = { ...fields };
  let ownerSkipped = false, creatorSkipped = false;

  if (!Object.keys(currentFields).length) return { ownerSkipped, creatorSkipped };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await withRetry(
        () => pbFetch('patch', `/v2/notes/${noteId}`, { data: { fields: currentFields } }),
        `update note ${noteId}`
      );
      return { ownerSkipped, creatorSkipped };
    } catch (err) {
      const field = extractFailedFieldPath(err);
      if (field === 'owner' && currentFields.owner) {
        const { owner, ...rest } = currentFields; currentFields = rest; ownerSkipped = true; continue;
      }
      if (field === 'creator' && currentFields.creator) {
        const { creator, ...rest } = currentFields; currentFields = rest; creatorSkipped = true; continue;
      }
      throw err;
    }
  }
  throw new Error('Note update failed after owner/creator fallback retries');
}

/**
 * PUT the customer relationship (user or company target) on an existing note.
 * Retries with backoff on "not found" — the target may have been created
 * moments earlier in this same import and not yet be referenceable.
 */
async function setNoteCustomer(pbFetch, withRetry, noteId, target) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await withRetry(
        () => pbFetch('put', `/v2/notes/${noteId}/relationships/customer`, { data: { target } }),
        `set customer on note ${noteId}`
      );
      return;
    } catch (err) {
      if (/not found/i.test(String(err.message || '')) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw err;
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
      { data: { filter: { type: [type] } } },
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
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
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
    const userCache = await buildIdToEmailMap(fetchAllPages, 'fetch users for note export');

    sse.progress(`User cache: ${Object.keys(userCache).length} users. Building company cache…`, 55);
    const companyCache = await buildIdToDomainMap(fetchAllPages, 'fetch companies for note export');

    sse.progress(`Company cache: ${Object.keys(companyCache).length} companies. Building CSV…`, 85);
    const rows = notes.map((note) => buildNoteRow(note, userCache, companyCache));

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
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;

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

    // Resolve caches for customer relationships + tags (only fetched when the relevant column is mapped)
    let userEmailToId = {};
    let companyDomainToId = {};
    let tagCache = new Map();

    if (mapping.userEmailColumn) {
      sse.progress('Fetching users for customer lookup…', 6);
      userEmailToId = await buildEmailToIdMap(fetchAllPages, 'fetch users for note import');
    }
    if (mapping.companyDomainColumn) {
      sse.progress('Fetching companies for customer lookup…', 7);
      companyDomainToId = await buildDomainToIdMap(fetchAllPages, 'fetch companies for note import');
    }
    if (mapping.tagsColumn) {
      sse.progress('Fetching known tag values…', 8);
      tagCache = await fetchFieldValues('tags', pbFetch, withRetry);
    }

    // Auto-generate source_record_ids for rows that need them (create only — source is immutable)
    const sourceCounters = {};

    for (let i = 0; i < rows.length; i++) {
      if (sse.isAborted()) { result.stopped = true; break; }

      const row = rows[i];
      const rowNum = i + 1;
      const pct = 8 + Math.round((i / rows.length) * 87);
      sse.progress(`Processing row ${rowNum}/${rows.length}…`, pct);

      try {
        const pbId = cell(row, mapping.pbIdColumn);
        let sourceOrigin = cell(row, mapping.sourceOriginColumn);
        let sourceRecordId = cell(row, mapping.sourceRecordIdColumn);

        // Auto-generate source_record_id if origin is set but record_id is missing
        if (sourceOrigin && !sourceRecordId) {
          sourceCounters[sourceOrigin] = (sourceCounters[sourceOrigin] || 0) + 1;
          sourceRecordId = `${sourceOrigin}-${sourceCounters[sourceOrigin]}`;
        }

        // Determine action
        let action = 'CREATE';
        let targetNoteId = null;

        if (pbId && UUID_RE.test(pbId)) {
          action = 'UPDATE';
          targetNoteId = pbId;
        }

        // Resolve customer relationship (user email takes priority over company domain),
        // creating the user/company entity if the email/domain isn't known yet.
        const userEmail     = cell(row, mapping.userEmailColumn);
        const companyDomain = cell(row, mapping.companyDomainColumn);
        let customerTarget = null;
        if (userEmail) {
          const id = await resolveOrCreateUser(pbFetch, withRetry, userEmailToId, userEmail);
          customerTarget = { id, type: 'user' };
        } else if (companyDomain) {
          const id = await resolveOrCreateCompany(pbFetch, withRetry, companyDomainToId, companyDomain);
          customerTarget = { id, type: 'company' };
        }

        // Resolve tags, creating any that don't exist yet
        const tagsRaw = cell(row, mapping.tagsColumn);
        const tagNames = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];
        const resolvedTags = tagNames.length ? await resolveTags(pbFetch, withRetry, tagCache, tagNames) : [];

        const fields = buildNoteFieldsV2(row, mapping, resolvedTags);
        const title = fields.name || '';

        let noteId;
        let ownerSkipped = false, creatorSkipped = false, customerSkipped = false;

        if (action === 'CREATE') {
          const r = await createNoteV2(pbFetch, withRetry, {
            fields,
            sourceOrigin, sourceRecordId,
            customerRel: customerTarget ? { type: 'customer', target: customerTarget } : null,
          });
          noteId = r.id;
          ownerSkipped = r.ownerSkipped;
          creatorSkipped = r.creatorSkipped;
          customerSkipped = r.customerSkipped;
          result.created++;
          sse.log('success', `Row ${rowNum}: Created note "${title}"`, { uuid: noteId, row: rowNum });
        } else {
          noteId = targetNoteId;
          if (!Object.keys(fields).length && !customerTarget) {
            result.skipped++;
            sse.log('warn', `Row ${rowNum}: No updatable fields mapped — update skipped`, { uuid: noteId, row: rowNum });
          } else {
            if (Object.keys(fields).length) {
              const r = await updateNoteV2(pbFetch, withRetry, targetNoteId, fields);
              ownerSkipped = r.ownerSkipped;
              creatorSkipped = r.creatorSkipped;
            }
            if (customerTarget) {
              try {
                await setNoteCustomer(pbFetch, withRetry, targetNoteId, customerTarget);
              } catch (custErr) {
                customerSkipped = true;
                sse.log('warn', `Row ${rowNum}: Could not set customer — ${parseApiError(custErr)}`, { uuid: noteId, row: rowNum });
              }
            }
            result.updated++;
            sse.log('success', `Row ${rowNum}: Updated note "${title || noteId}"`, { uuid: noteId, row: rowNum });
          }
        }

        if (ownerSkipped)    sse.log('warn', `Row ${rowNum}: Owner email is not an active workspace member — owner skipped`, { uuid: noteId, row: rowNum });
        if (creatorSkipped)  sse.log('warn', `Row ${rowNum}: Creator email is not an active workspace member — creator skipped`, { uuid: noteId, row: rowNum });
        if (customerSkipped) sse.log('warn', `Row ${rowNum}: Customer relationship could not be attached — skipped`, { uuid: noteId, row: rowNum });

        if (sse.isAborted()) { result.stopped = true; break; }

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
