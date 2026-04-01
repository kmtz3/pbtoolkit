/**
 * Users routes
 *
 * GET    /api/users/fields              → custom field definitions
 * POST   /api/users/export              → export all users as CSV (SSE)
 * POST   /api/users/import/preview      → validate import CSV (no API calls)
 * POST   /api/users/import/run          → run import with SSE progress
 * POST   /api/users/delete/by-csv       → delete users by UUID column in CSV (SSE)
 * POST   /api/users/delete/all          → delete every user in the workspace (SSE)
 */

const express = require('express');
const { parseCSV, generateCSVFromColumns, cell } = require('../lib/csvUtils');
const { startSSE } = require('../lib/sse');
const { parseApiError } = require('../lib/errorUtils');
const { UUID_RE } = require('../lib/constants');
const { pbAuth } = require('../middleware/pbAuth');
const { sanitizeDescription } = require('../services/entities/fieldBuilder');
const { formatFieldValue } = require('../services/entities/exporter');
const { schemaToType, normalizeSchema, EXCLUDED_FIELD_IDS } = require('../services/entities/configCache');

const STANDARD_FIELD_IDS = new Set(['name', 'email', 'description', 'owner', 'archived']);

/**
 * Parse a user configuration response into a customFields array,
 * using the same logic as parseCompanyConfig in companies.js.
 */
function parseUserConfig(configData) {
  const entry = configData || {};
  const customFields = Object.entries(entry.fields || {})
    .filter(([id]) => !id.includes('.') && !EXCLUDED_FIELD_IDS.has(id) && !STANDARD_FIELD_IDS.has(id))
    .map(([id, f]) => {
      const schema = normalizeSchema(f.schema);
      return {
        id,
        name:        f.name || id,
        schema,
        displayType: schemaToType(schema),
      };
    });
  return { customFields };
}

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// --- FIELDS ---
// ─────────────────────────────────────────────────────────────────────────────

router.get('/fields', pbAuth, async (_req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;

  try {
    const r = await withRetry(
      () => pbFetch('get', '/v2/entities/configurations/user'),
      'fetch user config'
    );
    const { customFields } = parseUserConfig(r.data);
    const fields = customFields.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.displayType === 'Number'                            ? 'number'
          : f.displayType?.toLowerCase().includes('multiselect') ? 'multiselect'
          : f.displayType?.toLowerCase() === 'tags'              ? 'tags'
          : f.displayType?.toLowerCase().includes('select')      ? 'select'
          : f.displayType?.toLowerCase() === 'member'            ? 'member'
          : f.displayType?.toLowerCase() === 'richtext'          ? 'richtext'
          : f.displayType?.toLowerCase() === 'date'              ? 'date'
          : 'text',
      displayType: f.displayType,
    }));

    res.json({ fields });
  } catch (err) {
    console.error('users fields route error:', err.message);
    res.status(err.status || 500).json({ error: 'Failed to fetch user custom fields.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// --- EXPORT ---
// ─────────────────────────────────────────────────────────────────────────────

const BASE_FIELDS = [
  { key: 'id',                      label: 'pb_id' },
  { key: 'name',                    label: 'name' },
  { key: 'email',                   label: 'email' },
  { key: 'description',             label: 'description' },
  { key: 'owner_email',             label: 'owner_email' },
  { key: 'archived',                label: 'archived' },
  { key: 'parent_company_id',       label: 'parent_company_id' },
  { key: 'parent_company_domain',   label: 'parent_company_domain' },
  { key: 'linked_features',         label: 'linked_features' },
  { key: 'linked_components',       label: 'linked_components' },
  { key: 'linked_products',         label: 'linked_products' },
  { key: 'linked_subfeatures',      label: 'linked_subfeatures' },
  { key: 'created_at',              label: 'created_at' },
  { key: 'updated_at',              label: 'updated_at' },
];

router.post('/export', pbAuth, async (_req, res) => {
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  const sse = startSSE(res);

  try {
    // Step 1: Fetch user config → discover custom fields
    sse.progress('Fetching custom field definitions…', 5);
    const configR = await withRetry(
      () => pbFetch('get', '/v2/entities/configurations/user'),
      'fetch user config'
    );
    const { customFields } = parseUserConfig(configR.data);
    sse.progress(`Found ${customFields.length} custom fields`, 10);

    // Step 2: Fetch all companies → build id→domain lookup
    sse.progress('Fetching companies for parent lookup…', 12);
    const companyDomainMap = await buildCompanyDomainMap(pbFetch, withRetry, fetchAllPages);
    sse.progress(`Company lookup built (${Object.keys(companyDomainMap).length} companies)`, 15);

    // Step 3: Fetch all users
    sse.progress('Fetching users…', 18);
    const users = await fetchAllPages('/v2/entities?type[]=user', 'fetch users');
    sse.progress(`Fetched ${users.length} users`, 50);

    if (users.length === 0) {
      sse.complete({ csv: '', filename: 'users.csv', count: 0, message: 'No users found in workspace.' });
      sse.done();
      return;
    }

    // Step 4: For users with many relationships, follow pagination
    sse.progress('Resolving relationships…', 55);
    for (let i = 0; i < users.length; i++) {
      if (sse.isAborted()) break;
      const user = users[i];
      if (user.relationships?.links?.next) {
        user.relationships.data = await fetchAllRelationships(pbFetch, withRetry, user.id, user.relationships);
      }
    }
    sse.progress('Relationships resolved', 80);

    // Step 5: Build CSV
    sse.progress('Building CSV…', 85);
    const csv = buildExportCSV(users, customFields, companyDomainMap);
    const date = new Date().toISOString().slice(0, 10);
    const filename = `users-${date}.csv`;

    sse.progress('Done!', 100);
    sse.complete({ csv, filename, count: users.length });
  } catch (err) {
    console.error('users export error:', err.message);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

/**
 * Build companyId → { domain } lookup using the same domain discovery trick
 * as buildDomainCache in companies.js (workspace-specific UUID key).
 */
async function buildCompanyDomainMap(pbFetch, withRetry, fetchAllPages) {
  const map = {};
  const companies = await fetchAllPages('/v2/entities?type[]=company', 'fetch companies for user export');
  if (companies.length === 0) return map;

  // Discover the workspace-specific UUID key for the domain field
  let domainFieldKey = null;
  for (const candidate of companies) {
    let singleDomain;
    try {
      const r = await withRetry(
        () => pbFetch('get', `/v2/entities/${candidate.id}`),
        'domain field key discovery'
      );
      singleDomain = r.data?.fields?.domain;
    } catch (_) { continue; }

    if (!singleDomain) continue;

    for (const [key, val] of Object.entries(candidate.fields || {})) {
      if (typeof val === 'string' && val.toLowerCase() === singleDomain.toLowerCase()) {
        domainFieldKey = key;
        break;
      }
    }
    if (domainFieldKey) break;
  }

  for (const entity of companies) {
    const domain = domainFieldKey ? entity.fields?.[domainFieldKey] : null;
    map[entity.id] = { domain: domain || '' };
  }
  return map;
}

/**
 * Follow relationship pagination for a user entity.
 * Returns the full array of relationship data objects.
 */
async function fetchAllRelationships(pbFetch, withRetry, entityId, initialRels) {
  const allData = [...(initialRels.data || [])];
  let nextUrl = initialRels.links?.next;

  while (nextUrl) {
    const r = await withRetry(
      () => pbFetch('get', nextUrl),
      `fetch relationships page for ${entityId}`
    );
    if (r.data) allData.push(...r.data);
    nextUrl = r.links?.next || null;
  }

  return allData;
}

function buildExportCSV(users, customFields, companyDomainMap) {
  const customCols = customFields.map((f) => ({
    key: `custom__${f.id}`,
    label: `${f.name} [${f.displayType}] [${f.id}]`,
    id: f.id,
    schema: f.schema,
  }));

  const cols = [...BASE_FIELDS, ...customCols];

  const rows = users.map((entity) => {
    const fields = entity.fields || {};
    const rels = entity.relationships?.data || [];

    // Extract parent company
    const parentRel = rels.find((r) => r.type === 'parent' && r.target?.type === 'company');
    const parentId = parentRel?.target?.id || '';
    const parentDomain = parentId && companyDomainMap[parentId] ? companyDomainMap[parentId].domain : '';

    // Group linked entities by type
    const linksByType = {};
    for (const r of rels) {
      if (r.type === 'link' && r.target) {
        const t = r.target.type;
        if (!linksByType[t]) linksByType[t] = [];
        linksByType[t].push(r.target.id);
      }
    }

    const row = {};
    for (const col of cols) {
      if (col.key === 'id')                     row[col.key] = entity.id ?? '';
      else if (col.key === 'name')              row[col.key] = fields.name ?? '';
      else if (col.key === 'email')             row[col.key] = fields.email ?? '';
      else if (col.key === 'description')       row[col.key] = fields.description ?? '';
      else if (col.key === 'owner_email')       row[col.key] = fields.owner?.email ?? '';
      else if (col.key === 'archived')          row[col.key] = fields.archived === true ? 'true' : fields.archived === false ? 'false' : '';
      else if (col.key === 'parent_company_id') row[col.key] = parentId;
      else if (col.key === 'parent_company_domain') row[col.key] = parentDomain;
      else if (col.key === 'linked_features')      row[col.key] = (linksByType.feature || []).join(', ');
      else if (col.key === 'linked_components')    row[col.key] = (linksByType.component || []).join(', ');
      else if (col.key === 'linked_products')      row[col.key] = (linksByType.product || []).join(', ');
      else if (col.key === 'linked_subfeatures')   row[col.key] = (linksByType.subfeature || []).join(', ');
      else if (col.key === 'created_at')        row[col.key] = entity.createdAt ?? '';
      else if (col.key === 'updated_at')        row[col.key] = entity.updatedAt ?? '';
      else if (col.key.startsWith('custom__'))  row[col.key] = formatFieldValue(fields[col.id], col.schema);
      else                                      row[col.key] = '';
    }
    return row;
  });

  return generateCSVFromColumns(rows, cols);
}

// ─────────────────────────────────────────────────────────────────────────────
// --- IMPORT ---
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/users/import/preview
 * Validate CSV before importing.
 */
router.post('/import/preview', pbAuth, async (req, res) => {
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  const { csvText, mapping } = req.body;
  if (!csvText || !mapping) return res.status(400).json({ error: 'Missing csvText or mapping' });

  const { rows, errors: parseErrors } = parseCSV(csvText);
  if (parseErrors.length) {
    return res.json({ valid: false, totalRows: 0, errors: parseErrors.map((e) => ({ row: null, message: e })) });
  }

  const errors = [];
  const warnings = [];

  // Build email cache from existing users for PATCH-by-email detection
  let emailCache = {};
  try {
    const existingUsers = await fetchAllPages('/v2/entities?type[]=user', 'fetch users for email cache');
    for (const u of existingUsers) {
      const email = u.fields?.email?.toLowerCase();
      if (email && !emailCache[email]) emailCache[email] = u.id;
    }
  } catch (_) { /* non-fatal — email dedup won't work */ }

  // Build member email set for owner validation
  let memberEmails = new Set();
  if (mapping.ownerColumn) {
    try {
      const members = await fetchAllPages('/v2/members', 'fetch members for owner validation');
      for (const m of members) {
        const email = m.fields?.email?.toLowerCase();
        if (email) memberEmails.add(email);
      }
    } catch (_) { /* non-fatal */ }
  }

  let createCount = 0;
  let updateCount = 0;
  const emailsSeen = new Set();

  rows.forEach((row, i) => {
    const rowNum = i + 1;
    const pbId  = cell(row, mapping.pbIdColumn)?.trim();
    const name  = cell(row, mapping.nameColumn)?.trim();
    const email = cell(row, mapping.emailColumn)?.trim();

    const validPbId = pbId && UUID_RE.test(pbId);
    const emailMatch = email && emailCache[email.toLowerCase()];

    if (validPbId || emailMatch) {
      updateCount++;
    } else {
      createCount++;
      if (!name) errors.push({ row: rowNum, field: mapping.nameColumn, message: 'Name is required when creating a new user' });
    }

    if (pbId && !UUID_RE.test(pbId)) {
      errors.push({ row: rowNum, field: mapping.pbIdColumn, message: `Invalid UUID format: '${pbId}'` });
    }

    // Email format validation
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ row: rowNum, field: mapping.emailColumn, message: `Invalid email format: '${email}'` });
    }

    // Duplicate email within CSV
    if (email) {
      const lower = email.toLowerCase();
      if (emailsSeen.has(lower)) {
        warnings.push({ row: rowNum, field: mapping.emailColumn, message: `Duplicate email '${email}' in CSV` });
      }
      emailsSeen.add(lower);
    }

    // Owner validation
    const owner = cell(row, mapping.ownerColumn)?.trim();
    if (owner && memberEmails.size > 0 && !memberEmails.has(owner.toLowerCase())) {
      warnings.push({ row: rowNum, field: mapping.ownerColumn, message: `Owner '${owner}' not found as a workspace member` });
    }

    // Custom field validation
    for (const cf of mapping.customFields || []) {
      const val = cell(row, cf.csvColumn);
      if (val && cf.fieldType === 'number' && isNaN(Number(val))) {
        errors.push({ row: rowNum, field: cf.csvColumn, message: `'${cf.csvColumn}' must be a number (got '${val}')` });
      }
      if (val && cf.fieldType === 'text' && val.length > 1024) {
        errors.push({ row: rowNum, field: cf.csvColumn, message: `'${cf.csvColumn}' exceeds 1024 characters` });
      }
    }
  });

  res.json({
    valid: errors.length === 0,
    totalRows: rows.length,
    createCount,
    updateCount,
    errors,
    warnings,
  });
});

/**
 * POST /api/users/import/run
 * Run import with SSE progress.
 */
router.post('/import/run', pbAuth, async (req, res) => {
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  const { csvText, mapping, options = {} } = req.body;
  const {
    multiSelectMode     = 'set',
    bypassEmptyCells    = false,
    bypassHtmlFormatter = false,
  } = options;
  if (!csvText || !mapping) return res.status(400).json({ error: 'Missing csvText or mapping' });

  const sse = startSSE(res);

  try {
    const { rows } = parseCSV(csvText);
    const total = rows.length;

    if (total === 0) {
      sse.complete({ created: 0, updated: 0, errors: 0, total: 0, stopped: false });
      sse.done();
      return;
    }

    // Step 1: Build email → userId cache
    sse.progress('Building email cache…', 5);
    const emailCache = {};
    const existingUsers = await fetchAllPages('/v2/entities?type[]=user', 'fetch users for email cache');
    let dupeEmailCount = 0;
    for (const u of existingUsers) {
      const email = u.fields?.email?.toLowerCase();
      if (email) {
        if (emailCache[email]) dupeEmailCount++;
        else emailCache[email] = u.id;
      }
    }
    if (dupeEmailCount > 0) {
      sse.log('warn', `Found ${dupeEmailCount} duplicate email(s) in workspace — first-seen used for matching`);
    }
    sse.progress(`Email cache built (${Object.keys(emailCache).length} users)`, 10);

    // Step 2: Build company lookup if parent columns mapped
    let companyDomainCache = {};
    if (mapping.parentCompanyIdColumn || mapping.parentCompanyDomainColumn) {
      sse.progress('Building company lookup…', 12);
      companyDomainCache = await buildDomainToIdCache(pbFetch, withRetry, fetchAllPages);
      sse.progress(`Company lookup built (${Object.keys(companyDomainCache).length} domains)`, 15);
    }

    // Step 3: Process each row
    let created = 0;
    let updated = 0;
    let errorCount = 0;
    let processed = 0;

    for (let i = 0; i < rows.length; i++) {
      if (sse.isAborted()) {
        sse.log('warn', `Import stopped after ${processed} rows.`);
        break;
      }

      const row = rows[i];
      const rowNum = i + 1;
      const pct = 15 + Math.round((i / total) * 80);
      sse.progress(`Processing row ${rowNum}/${total}…`, pct);

      const pbId  = cell(row, mapping.pbIdColumn)?.trim();
      const name  = cell(row, mapping.nameColumn)?.trim();
      const email = cell(row, mapping.emailColumn)?.trim();
      const label = name || email || `row ${rowNum}`;

      try {
        if (pbId && UUID_RE.test(pbId)) {
          // UUID present → PATCH
          await withRetry(
            () => patchUser(pbFetch, pbId, row, mapping, { multiSelectMode, bypassEmptyCells, bypassHtmlFormatter }),
            `patch user row ${rowNum}`
          );
          // Set parent if mapped
          await maybeSetParent(pbFetch, withRetry, pbId, row, mapping, companyDomainCache);
          updated++;
          sse.log('success', `Row ${rowNum}: Updated "${label}"`, { uuid: pbId, row: rowNum });
        } else if (email && emailCache[email.toLowerCase()]) {
          // Email match → PATCH
          const existingId = emailCache[email.toLowerCase()];
          await withRetry(
            () => patchUser(pbFetch, existingId, row, mapping, { multiSelectMode, bypassEmptyCells, bypassHtmlFormatter }),
            `patch by email row ${rowNum}`
          );
          await maybeSetParent(pbFetch, withRetry, existingId, row, mapping, companyDomainCache);
          updated++;
          sse.log('success', `Row ${rowNum}: Updated "${label}" by email match`, { uuid: existingId, row: rowNum });
        } else {
          // CREATE
          const newUser = await withRetry(
            () => createUser(pbFetch, row, mapping, bypassHtmlFormatter, companyDomainCache),
            `create user row ${rowNum}`
          );
          const newId = newUser.id;
          if (email) emailCache[email.toLowerCase()] = newId;
          created++;
          sse.log('success', `Row ${rowNum}: Created "${label}"`, { uuid: newId, row: rowNum });
        }
      } catch (err) {
        errorCount++;
        const detail = parseApiError(err);
        sse.log('error', `Row ${rowNum}: Failed for "${label}" — ${detail}`, { row: rowNum });
        console.error(`Row ${rowNum} error: ${err.message}`);
      }

      processed++;
    }

    const stopped = sse.isAborted();
    if (!stopped) sse.progress('Import complete!', 100);

    sse.complete({
      total,
      processed,
      created,
      updated,
      errors: errorCount,
      stopped,
    });
  } catch (err) {
    console.error('users import/run error:', err.message);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

/**
 * Build domain → companyId cache using the same domain discovery trick
 * as buildDomainCache in companies.js.
 */
async function buildDomainToIdCache(pbFetch, withRetry, fetchAllPages) {
  const map = {};
  const companies = await fetchAllPages('/v2/entities?type[]=company', 'domain cache for user import');
  if (companies.length === 0) return map;

  let domainFieldKey = null;
  for (const candidate of companies) {
    let singleDomain;
    try {
      const r = await withRetry(
        () => pbFetch('get', `/v2/entities/${candidate.id}`),
        'domain field key discovery'
      );
      singleDomain = r.data?.fields?.domain;
    } catch (_) { continue; }

    if (!singleDomain) continue;

    for (const [key, val] of Object.entries(candidate.fields || {})) {
      if (typeof val === 'string' && val.toLowerCase() === singleDomain.toLowerCase()) {
        domainFieldKey = key;
        break;
      }
    }
    if (domainFieldKey) break;
  }

  if (!domainFieldKey) return map;

  for (const entity of companies) {
    const domain = entity.fields?.[domainFieldKey];
    if (domain && typeof domain === 'string') {
      map[domain.toLowerCase()] = entity.id;
    }
  }
  return map;
}

/**
 * Create a new user via POST /v2/entities.
 * Note: `archived` is NOT included on create (API rejects it).
 */
async function createUser(pbFetch, row, mapping, bypassHtmlFormatter, companyDomainCache) {
  const fields = {};

  const name = cell(row, mapping.nameColumn)?.trim();
  if (name) fields.name = name;

  const email = cell(row, mapping.emailColumn)?.trim();
  if (email) fields.email = email;

  const rawDesc = cell(row, mapping.descColumn)?.trim();
  if (rawDesc) fields.description = bypassHtmlFormatter ? rawDesc : sanitizeDescription(rawDesc);

  const owner = cell(row, mapping.ownerColumn)?.trim();
  if (owner) fields.owner = { email: owner };

  // Custom fields
  for (const cf of mapping.customFields || []) {
    const rawVal = cell(row, cf.csvColumn);
    if (rawVal !== '' && rawVal != null) {
      fields[cf.fieldId] = cf.fieldType === 'number'                                  ? Number(rawVal)
                         : cf.fieldType === 'select'                                  ? { name: rawVal }
                         : cf.fieldType === 'multiselect' || cf.fieldType === 'tags'  ? String(rawVal).split(',').map((x) => x.trim()).filter(Boolean).map((n) => ({ name: n }))
                         : cf.fieldType === 'member'                                  ? { email: String(rawVal).trim() }
                         : cf.fieldType === 'richtext'                                ? sanitizeDescription(rawVal)
                         : rawVal;
    }
  }

  // Resolve parent company
  const relationships = [];
  const parentId = resolveParentCompanyId(row, mapping, companyDomainCache);
  if (parentId) {
    relationships.push({ type: 'parent', target: { id: parentId } });
  }

  const payload = {
    data: {
      type: 'user',
      fields,
      ...(relationships.length && { relationships }),
    },
  };

  const response = await pbFetch('post', '/v2/entities', payload);
  return response.data;
}

/**
 * PATCH an existing user via PATCH /v2/entities/{id}.
 */
async function patchUser(pbFetch, userId, row, mapping, options) {
  const { multiSelectMode = 'set', bypassEmptyCells = false, bypassHtmlFormatter = false } = options || {};
  const ops = [];

  const name = cell(row, mapping.nameColumn)?.trim();
  if (name) ops.push({ op: 'set', path: 'name', value: name });

  const email = cell(row, mapping.emailColumn)?.trim();
  if (email) ops.push({ op: 'set', path: 'email', value: email });
  else if (!bypassEmptyCells) ops.push({ op: 'clear', path: 'email' });

  const rawDesc = cell(row, mapping.descColumn)?.trim();
  if (rawDesc) {
    const desc = bypassHtmlFormatter ? rawDesc : sanitizeDescription(rawDesc);
    if (desc) ops.push({ op: 'set', path: 'description', value: desc });
  } else if (!bypassEmptyCells) {
    ops.push({ op: 'clear', path: 'description' });
  }

  const owner = cell(row, mapping.ownerColumn)?.trim();
  if (owner) ops.push({ op: 'set', path: 'owner', value: { email: owner } });
  else if (!bypassEmptyCells) ops.push({ op: 'clear', path: 'owner' });

  const archived = cell(row, mapping.archivedColumn)?.trim().toLowerCase();
  if (archived === 'true') ops.push({ op: 'set', path: 'archived', value: true });
  else if (archived === 'false') ops.push({ op: 'set', path: 'archived', value: false });

  // Custom fields
  const MULTI_TYPES = new Set(['multiselect', 'member', 'tag', 'tags']);
  for (const cf of mapping.customFields || []) {
    const rawVal = cell(row, cf.csvColumn);
    const isEmpty = rawVal === '' || rawVal == null;
    if (!isEmpty) {
      const value = cf.fieldType === 'number'                                  ? Number(rawVal)
                  : cf.fieldType === 'select'                                  ? { name: rawVal }
                  : cf.fieldType === 'multiselect' || cf.fieldType === 'tags'  ? String(rawVal).split(',').map((x) => x.trim()).filter(Boolean).map((n) => ({ name: n }))
                  : cf.fieldType === 'member'                                  ? { email: String(rawVal).trim() }
                  : cf.fieldType === 'richtext'                                ? sanitizeDescription(rawVal)
                  : rawVal;
      const opName = MULTI_TYPES.has(cf.fieldType) ? multiSelectMode : 'set';
      ops.push({ op: opName, path: cf.fieldId, value });
    } else if (!bypassEmptyCells) {
      ops.push({ op: 'clear', path: cf.fieldId });
    }
  }

  if (ops.length) {
    await pbFetch('patch', `/v2/entities/${userId}`, {
      data: { patch: ops },
    });
  }
}

/**
 * Resolve parent company UUID from row data (by UUID or domain).
 */
function resolveParentCompanyId(row, mapping, companyDomainCache) {
  const directId = cell(row, mapping.parentCompanyIdColumn)?.trim();
  if (directId && UUID_RE.test(directId)) return directId;

  const domain = cell(row, mapping.parentCompanyDomainColumn)?.trim().toLowerCase();
  if (domain && companyDomainCache[domain]) return companyDomainCache[domain];

  return null;
}

/**
 * Set parent company relationship on an existing user (PATCH path).
 */
async function maybeSetParent(pbFetch, withRetry, userId, row, mapping, companyDomainCache) {
  const parentId = resolveParentCompanyId(row, mapping, companyDomainCache);
  if (!parentId) return;

  await withRetry(
    () => pbFetch('put', `/v2/entities/${userId}/relationships/parent`, {
      data: { target: { id: parentId } },
    }),
    `set parent for user ${userId}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// --- DELETE ---
// ─────────────────────────────────────────────────────────────────────────────

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
        await withRetry(() => pbFetch('delete', `/v2/entities/${id}`), `delete user ${id}`);
        deleted++;
        sse.log('success', `Deleted user ${id}`, { uuid: id });
      } catch (err) {
        if (err.status === 404) {
          sse.log('warn', `User ${id} not found — skipped`, { uuid: id });
        } else {
          errors++;
          sse.log('error', `Failed to delete ${id}: ${parseApiError(err)}`, { uuid: id });
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

router.post('/delete/all', pbAuth, async (_req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const sse = startSSE(res);

  try {
    sse.progress('Collecting all user IDs…', 5);
    const users = await res.locals.pbClient.fetchAllPages('/v2/entities?type[]=user', 'fetch all user IDs for delete');
    const allIds = users.map((e) => e.id);

    if (allIds.length === 0) {
      sse.complete({ total: 0, deleted: 0, skipped: 0, errors: 0 });
      sse.done();
      return;
    }

    sse.progress(`Found ${allIds.length} users. Beginning deletion…`, 10);

    let deleted = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < allIds.length; i++) {
      if (sse.isAborted()) break;
      const id = allIds[i];
      const pct = 10 + Math.round(((i + 1) / allIds.length) * 90);

      try {
        await withRetry(() => pbFetch('delete', `/v2/entities/${id}`), `delete user ${id}`);
        deleted++;
        if (deleted % 50 === 0) sse.log('info', `Deleted ${deleted}/${allIds.length} users…`, '');
      } catch (err) {
        if (err.status === 404) {
          skipped++;
          sse.log('info', `User ${id} not found — no need to delete`, '');
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

module.exports = router;
