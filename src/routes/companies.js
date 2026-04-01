/**
 * Companies routes — unified module
 *
 * GET    /api/fields                   → custom field definitions
 * POST   /api/export                   → export all companies as CSV (SSE)
 * POST   /api/import/preview           → validate import CSV (no API calls)
 * POST   /api/import/run               → run import with SSE progress
 * POST   /api/companies/delete/by-csv  → delete companies by UUID column in CSV (SSE)
 * POST   /api/companies/delete/all     → delete every company in the workspace (SSE)
 */

const express = require('express');
const { parseCSV, generateCSVFromColumns, cell } = require('../lib/csvUtils');
const { startSSE } = require('../lib/sse');
const { parseApiError } = require('../lib/errorUtils');
const { UUID_RE } = require('../lib/constants');
const { pbAuth } = require('../middleware/pbAuth');
const { sanitizeDescription } = require('../services/entities/fieldBuilder');
const { formatFieldValue } = require('../services/entities/exporter');
const { fetchAllEntitiesPost } = require('../lib/pbClient');
const { schemaToType, normalizeSchema, EXCLUDED_FIELD_IDS, STANDARD_FIELD_IDS } = require('../services/entities/configCache');

/**
 * Parse a company configuration response into a customFields array,
 * using the same logic as fetchEntityConfigs in configCache.js.
 * Returns { customFields: [{ id, name, schema, displayType }] }
 */
function parseCompanyConfig(configData) {
  // r.data is a single { type, fields } object — not an array
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

/**
 * GET /api/fields
 * Returns all company custom field definitions from the PB API.
 * Used by the frontend to populate the import field mapping UI.
 */
router.get('/fields', pbAuth, async (_req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;

  try {
    const r = await withRetry(
      () => pbFetch('get', '/v2/entities/configurations/company'),
      'fetch company config'
    );
    const { customFields } = parseCompanyConfig(r.data);
    const domainField = customFields.find((f) => f.name.toLowerCase() === 'domain');
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

    res.json({ fields, domainFieldId: domainField?.id || null });
  } catch (err) {
    console.error('fields route error:', err.message);
    res.status(err.status || 500).json({ error: 'Failed to fetch custom fields.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// --- EXPORT ---
// ─────────────────────────────────────────────────────────────────────────────

// Base fields always exported
const BASE_FIELDS = [
  { key: 'id',             label: 'PB Company ID' },
  { key: 'name',           label: 'Company Name' },
  { key: 'domain',         label: 'Domain' },
  { key: 'description',    label: 'Description' },
  { key: 'sourceOrigin',       label: 'Source Origin (v1 – will be removed once engineers consolidate source fields)' },
  { key: 'sourceRecordId',     label: 'Source Record ID (v1 – will be removed once engineers consolidate source fields)' },
  { key: 'sourceSystem',   label: 'Source System (v2)' },
  { key: 'sourceRecordV2', label: 'Source Record ID (v2)' },
];

/**
 * POST /api/export
 * Exports all companies (with custom fields) from Productboard as a CSV.
 * Streams progress via SSE.
 *
 * Body: { useEu?: boolean }
 * Headers: x-pb-token
 *
 * SSE events:
 *   progress  { message, percent }
 *   complete  { csv: string, filename: string, count: number }
 *   error     { message }
 */
router.post('/export', pbAuth, async (_req, res) => {
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  const sse = startSSE(res);

  try {
    // Step 1: Fetch company config using same parsing logic as entity suite
    sse.progress('Fetching custom field definitions…', 5);
    const configR = await withRetry(
      () => pbFetch('get', '/v2/entities/configurations/company'),
      'fetch company config'
    );
    const { customFields } = parseCompanyConfig(configR.data);
    const domainFieldId = customFields.find((f) => f.name.toLowerCase() === 'domain')?.id || null;
    sse.progress(`Found ${customFields.length} custom fields`, 10);

    // Step 2: Fetch all companies via v2 GET (returns fields inline, including UUID-keyed custom fields)
    sse.progress('Fetching companies…', 15);
    const companies = await fetchAllPages('/v2/entities?type[]=company', 'fetch companies');
    sse.progress(`Fetched ${companies.length} companies`, 50);

    if (companies.length === 0) {
      sse.complete({ csv: '', filename: 'companies.csv', count: 0, message: 'No companies found in workspace.' });
      sse.done();
      return;
    }

    // Step 3: Fetch source + domain data via v1 paginated list (~N/100 calls instead of N)
    // TODO: remove v1 enrichment once PB fixes v2 metadata bug (source always null in v2)
    sse.progress('Fetching source data via v1 list…', 55);
    const v1Map = {};
    for (const c of await fetchAllPages('/companies', 'fetch v1 companies list')) {
      v1Map[c.id] = {
        domain:         c.domain         || '',
        sourceOrigin:   c.sourceOrigin   || '',
        sourceRecordId: c.sourceRecordId || '',
      };
    }
    sse.progress('Source data fetched', 85);

    // Step 5: Build CSV
    sse.progress('Building CSV…', 90);
    const csv = buildExportCSV(companies, v1Map, customFields, domainFieldId);

    const date = new Date().toISOString().slice(0, 10);
    const filename = `companies-${date}.csv`;

    sse.progress('Done!', 100);
    sse.complete({ csv, filename, count: companies.length });
  } catch (err) {
    console.error('export error:', err.message);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

function buildExportCSV(companies, v1Map, customFields, domainFieldId) {
  const customCols = customFields
    .filter((f) => f.id !== domainFieldId) // exclude domain UUID — already in BASE_FIELDS
    .map((f) => ({
      key: `custom__${f.id}`,
      label: `${f.name} [${f.displayType}] [${f.id}]`,
      id: f.id,
      schema: f.schema,
    }));

  const cols = [...BASE_FIELDS, ...customCols];

  const rows = companies.map((entity) => {
    const fields = entity.fields || {};
    const v1 = v1Map[entity.id] || {};
    const row = {};
    for (const col of cols) {
      if (col.key === 'id') {
        row[col.key] = entity.id ?? '';
      } else if (col.key === 'domain') {
        row[col.key] = v1.domain ?? '';
      } else if (col.key === 'sourceOrigin') {
        row[col.key] = v1.sourceOrigin ?? '';
      } else if (col.key === 'sourceRecordId') {
        row[col.key] = v1.sourceRecordId ?? '';
      } else if (col.key === 'sourceSystem') {
        row[col.key] = entity.metadata?.source?.system ?? '';
      } else if (col.key === 'sourceRecordV2') {
        row[col.key] = entity.metadata?.source?.recordId ?? '';
      } else if (col.key.startsWith('custom__')) {
        row[col.key] = formatFieldValue(fields[col.id], col.schema);
      } else {
        row[col.key] = fields[col.key] ?? '';  // name, description
      }
    }
    return row;
  });

  return generateCSVFromColumns(rows, cols);
}

// ─────────────────────────────────────────────────────────────────────────────
// --- IMPORT ---
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/import/preview
 * Parses the CSV and mapping, validates rows, returns errors before any API call.
 * Body: { csvText: string, mapping: Mapping, clearEmptyFields: boolean }
 */
router.post('/import/preview', pbAuth, async (req, res) => {
  const { csvText, mapping } = req.body;
  if (!csvText || !mapping) return res.status(400).json({ error: 'Missing csvText or mapping' });

  const { rows, errors: parseErrors } = parseCSV(csvText);

  if (parseErrors.length) {
    return res.json({ valid: false, totalRows: 0, errors: parseErrors.map((e) => ({ row: null, message: e })) });
  }

  const errors = [];
  const domainsSeen = new Set();

  rows.forEach((row, i) => {
    const rowNum = i + 1;
    const name   = cell(row, mapping.nameColumn);
    const domain = cell(row, mapping.domainColumn);
    const pbId   = cell(row, mapping.pbIdColumn);

    const validPbId = pbId && UUID_RE.test(pbId.trim());

    if (!name && !validPbId) errors.push({ row: rowNum, field: mapping.nameColumn, message: 'Company name is required when creating a new company' });
    if (!domain && !validPbId) errors.push({ row: rowNum, field: mapping.domainColumn, message: 'Domain is required when no pb_id is provided' });

    if (domain && !validPbId) {
      const d = domain.toLowerCase();
      if (domainsSeen.has(d)) {
        errors.push({ row: rowNum, field: mapping.domainColumn, message: `Duplicate domain '${d}' — add a UUID column to PATCH these rows individually` });
      }
      domainsSeen.add(d);
    }

    if (pbId && !UUID_RE.test(pbId.trim())) {
      errors.push({ row: rowNum, field: mapping.pbIdColumn, message: `Invalid UUID format: '${pbId}'` });
    }

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
    errors,
  });
});

/**
 * POST /api/import/run
 * Runs the import (create/patch companies via v2 + v1 source) with SSE progress.
 * Body: { csvText: string, mapping: Mapping, options: { multiSelectMode, bypassEmptyCells, bypassHtmlFormatter } }
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

    // Step 1: Resolve domain field id from config (or use frontend override)
    // Domain is a named system-ish field with id="domain" — not UUID-keyed
    let domainFieldId = mapping.domainFieldId || null;
    if (!domainFieldId) {
      try {
        const configR = await withRetry(
          () => pbFetch('get', '/v2/entities/configurations/company'),
          'fetch company config for import'
        );
        const config = configR.data || {};
        domainFieldId = Object.entries(config.fields || {})
          .find(([, f]) => f.name?.toLowerCase() === 'domain')?.[0] ?? null;
      } catch (_) { /* non-fatal — domain writes fall back to 'domain' key */ }
    }

    // Step 2: Build domain → id cache
    sse.progress('Building domain cache from Productboard…', 5);
    const domainCache = await buildDomainCache(pbFetch, withRetry, fetchAllPages);
    sse.progress(`Domain cache built (${Object.keys(domainCache).length} companies)`, 12);

    // Step 2: Process each row
    let created = 0;
    let updated = 0;
    let errorCount = 0;
    let processed = 0;

    for (let i = 0; i < rows.length; i++) {
      // Abort check — always at the top of the loop
      if (sse.isAborted()) {
        sse.log('warn', `Import stopped after ${processed} rows.`);
        break;
      }

      const row = rows[i];
      const rowNum = i + 1;
      const pct = 12 + Math.round((i / total) * 80);
      sse.progress(`Processing row ${rowNum}/${total}…`, pct);

      const pbId   = cell(row, mapping.pbIdColumn)?.trim();
      const name   = cell(row, mapping.nameColumn)?.trim();
      const domain = cell(row, mapping.domainColumn)?.trim().toLowerCase();
      const label  = name || domain || `row ${rowNum}`;

      let companyId = null;

      try {
        if (pbId && UUID_RE.test(pbId)) {
          // UUID present → v2 PATCH
          await withRetry(
            () => patchCompanyV2(pbFetch, pbId, row, mapping, { multiSelectMode, bypassEmptyCells, bypassHtmlFormatter }, domainFieldId),
            `patch company row ${rowNum}`
          );
          companyId = pbId;
          updated++;
          sse.log('success', `Row ${rowNum}: Updated "${label}"`, { uuid: companyId, row: rowNum });
        } else if (domain && domainCache[domain]) {
          // Domain match → v2 PATCH by cached id
          const existingId = domainCache[domain];
          await withRetry(
            () => patchCompanyV2(pbFetch, existingId, row, mapping, { multiSelectMode, bypassEmptyCells, bypassHtmlFormatter }, domainFieldId),
            `patch by domain row ${rowNum}`
          );
          companyId = existingId;
          updated++;
          sse.log('success', `Row ${rowNum}: Updated "${label}" by domain match`, { uuid: existingId, row: rowNum });
        } else {
          // Neither → v2 POST (create)
          const created_ = await withRetry(
            () => createCompanyV2(pbFetch, row, mapping, domainFieldId, bypassHtmlFormatter),
            `create company row ${rowNum}`
          );
          companyId = created_.id;
          domainCache[domain] = companyId;
          created++;
          sse.log('success', `Row ${rowNum}: Created "${label}"`, { uuid: companyId, row: rowNum });
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
    console.error('import/run error:', err.message);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

/**
 * Build domain → companyId map from the v2 entity list.
 *
 * The v2 list/search endpoint returns the domain field under a workspace-specific
 * UUID key (e.g. "b37b798e-...") rather than the logical "domain" string key that
 * appears in single-entity GETs and the config endpoint. The UUID is consistent
 * within a workspace but varies between workspaces and is not discoverable from
 * the config alone.
 *
 * Strategy: fetch all companies from v2 list (cursor-paginated, covers both
 * legacy v1-created companies and v2-only companies created via PBToolkit), then
 * do ONE individual GET to discover the UUID key by cross-referencing with the
 * normalised "domain" key that single-entity GETs always return.
 *
 * TODO: once PB fixes the domain field key inconsistency in list/search responses
 * (so "domain" string key is returned consistently instead of a workspace-specific
 * UUID), remove the individual GET discovery loop and read domain directly from
 * entity.fields.domain in the list response.
 */
async function buildDomainCache(pbFetch, withRetry, fetchAllPages) {
  const map = {};

  const companies = await fetchAllPages('/v2/entities?type[]=company', 'domain cache fetch');
  if (companies.length === 0) return map;

  // Discover the workspace-specific UUID key for the domain field.
  // Do individual GETs on companies until we find one with a domain set.
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

    // Find which UUID key in the list entity has the same value as the normalised domain
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
 * POST /v2/entities — create a new company with all fields inline.
 * Custom fields and standard fields sent in one request.
 */
async function createCompanyV2(pbFetch, row, mapping, domainFieldId, bypassHtmlFormatter = false) {
  const fields = {
    name: cell(row, mapping.nameColumn),
  };

  const domainValue = cell(row, mapping.domainColumn)?.trim().toLowerCase();
  if (domainValue) {
    fields[domainFieldId || 'domain'] = domainValue;
  }

  const rawDesc = cell(row, mapping.descColumn);
  const desc = rawDesc ? (bypassHtmlFormatter ? rawDesc : sanitizeDescription(rawDesc)) : null;
  if (desc) fields.description = desc;

  for (const cf of mapping.customFields || []) {
    const rawVal = cell(row, cf.csvColumn);
    if (rawVal !== '') {
      fields[cf.fieldId] = cf.fieldType === 'number' ? Number(rawVal) : rawVal;
    }
  }

  const sourceOrigin   = cell(row, mapping.sourceOriginCol);
  const sourceRecordId = cell(row, mapping.sourceRecordCol);
  const metadata = (sourceOrigin || sourceRecordId)
    ? { source: { system: sourceOrigin || null, recordId: sourceRecordId || null } }
    : undefined;

  const response = await pbFetch('post', '/v2/entities', {
    data: { type: 'company', fields, ...(metadata && { metadata }) },
  });
  return response.data;
}

/**
 * PATCH /v2/entities/{id} — update a company.
 * All set ops (non-empty fields) and clear ops (empty fields when clearEmptyFields)
 * are combined into a single PATCH request.
 */
async function patchCompanyV2(pbFetch, companyId, row, mapping, options, domainFieldId) {
  const { multiSelectMode = 'set', bypassEmptyCells = false, bypassHtmlFormatter = false } = options || {};
  const ops = [];

  const name = cell(row, mapping.nameColumn);
  if (name) ops.push({ op: 'set', path: 'name', value: name });

  const domain = cell(row, mapping.domainColumn)?.trim().toLowerCase();
  if (domain) ops.push({ op: 'set', path: domainFieldId || 'domain', value: domain });

  const rawDesc = cell(row, mapping.descColumn);
  if (rawDesc) {
    const desc = bypassHtmlFormatter ? rawDesc : sanitizeDescription(rawDesc);
    if (desc) ops.push({ op: 'set', path: 'description', value: desc });
  } else if (!bypassEmptyCells) {
    ops.push({ op: 'clear', path: 'description' });
  }

  const MULTI_TYPES = new Set(['multiselect', 'member', 'tag', 'tags']);
  for (const cf of mapping.customFields || []) {
    const rawVal = cell(row, cf.csvColumn);
    const isEmpty = rawVal === '' || rawVal == null;
    if (!isEmpty) {
      const value = cf.fieldType === 'number'                        ? Number(rawVal)
                  : cf.fieldType === 'select'                        ? { name: rawVal }
                  : cf.fieldType === 'multiselect' || cf.fieldType === 'tags'
                                                                     ? String(rawVal).split(',').map((x) => x.trim()).filter(Boolean).map((name) => ({ name }))
                  : cf.fieldType === 'member'                        ? { email: String(rawVal).trim() }
                  : cf.fieldType === 'richtext'                      ? sanitizeDescription(rawVal)
                  : rawVal;
      const opName = MULTI_TYPES.has(cf.fieldType) ? multiSelectMode : 'set';
      ops.push({ op: opName, path: cf.fieldId, value });
    } else if (!bypassEmptyCells) {
      ops.push({ op: 'clear', path: cf.fieldId });
    }
  }

  const sourceOrigin   = cell(row, mapping.sourceOriginCol);
  const sourceRecordId = cell(row, mapping.sourceRecordCol);
  const metadata = (sourceOrigin || sourceRecordId)
    ? { source: { system: sourceOrigin || null, recordId: sourceRecordId || null } }
    : undefined;

  if (ops.length || metadata) {
    await pbFetch('patch', `/v2/entities/${companyId}`, {
      data: {
        ...(ops.length && { patch: ops }),
        ...(metadata && { metadata }),
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// --- DELETE ---
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/companies/delete/by-csv
 * Delete companies by UUID column in CSV. SSE stream.
 * Body: { csvText, uuidColumn }
 */
router.post('/companies/delete/by-csv', pbAuth, async (req, res) => {
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
        await withRetry(() => pbFetch('delete', `/v2/entities/${id}`), `delete company ${id}`);
        deleted++;
        sse.log('success', `Deleted company ${id}`, { uuid: id });
      } catch (err) {
        if (err.status === 404) {
          sse.log('warn', `Company ${id} not found — skipped`, { uuid: id });
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

/**
 * POST /api/companies/delete/all
 * Delete every company in the workspace. SSE stream.
 */
router.post('/companies/delete/all', pbAuth, async (_req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const sse = startSSE(res);


  try {
    // Phase 1: Collect all company IDs via v2 cursor search
    sse.progress('Collecting all company IDs…', 5);
    const entities = await fetchAllEntitiesPost(
      pbFetch, withRetry,
      { data: { types: ['company'] } },
      'fetch all company IDs for delete'
    );
    const allIds = entities.map((e) => e.id);

    if (allIds.length === 0) {
      sse.complete({ total: 0, deleted: 0, skipped: 0, errors: 0 });
      sse.done();
      return;
    }

    // Phase 2: Delete each company sequentially via v2
    sse.progress(`Found ${allIds.length} companies. Beginning deletion…`, 10);

    let deleted = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < allIds.length; i++) {
      if (sse.isAborted()) break;
      const id = allIds[i];
      const pct = 10 + Math.round(((i + 1) / allIds.length) * 90);

      try {
        await withRetry(() => pbFetch('delete', `/v2/entities/${id}`), `delete company ${id}`);
        deleted++;
        if (deleted % 50 === 0) sse.log('info', `Deleted ${deleted}/${allIds.length} companies…`, '');
      } catch (err) {
        if (err.status === 404) {
          skipped++;
          sse.log('info', `Company ${id} not found — no need to delete`, '');
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

// ─────────────────────────────────────────────────────────────────────────────
// --- SOURCE MIGRATION ---
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/companies/source-migration/v1-to-v2
 * Copies v1 sourceOrigin + sourceRecordId into v2 metadata.source for every
 * company that has v1 source data. Overwrites any existing v2 metadata.source.
 * 404 on PATCH (company not in v2) is logged as a warning and skipped.
 */
router.post('/companies/source-migration/v1-to-v2', pbAuth, async (_req, res) => {
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  const sse = startSSE(res);

  try {
    sse.progress('Fetching companies from v1…', 5);
    const v1Companies = await fetchAllPages('/companies', 'fetch v1 companies for source migration');
    const total = v1Companies.length;
    sse.progress(`Fetched ${total} companies`, 20);

    if (total === 0) {
      sse.complete({ total: 0, migrated: 0, skippedEmpty: 0, skippedNotFound: 0, errors: 0 });
      return;
    }

    let migrated = 0;
    let skippedEmpty = 0;
    let skippedNotFound = 0;
    let errors = 0;

    for (let i = 0; i < v1Companies.length; i++) {
      if (sse.isAborted()) break;
      const c = v1Companies[i];
      const pct = 20 + Math.round(((i + 1) / total) * 78);

      const sourceOrigin   = c.sourceOrigin   || '';
      const sourceRecordId = c.sourceRecordId || '';

      if (!sourceOrigin && !sourceRecordId) {
        skippedEmpty++;
        sse.progress(`Processing ${i + 1} of ${total}…`, pct);
        continue;
      }

      try {
        await withRetry(
          () => pbFetch('patch', `/v2/entities/${c.id}`, {
            data: {
              metadata: {
                source: {
                  system:   sourceOrigin   || null,
                  recordId: sourceRecordId || null,
                },
              },
            },
          }),
          `patch company ${c.id} v2 source`
        );
        migrated++;
        sse.log('success', `Migrated ${c.id}`, `${sourceOrigin} / ${sourceRecordId}`);
      } catch (err) {
        if (err.status === 404) {
          skippedNotFound++;
          sse.log('warn', `Company ${c.id} not found in v2 — skipped`, '');
        } else {
          errors++;
          sse.log('error', `Failed to migrate ${c.id}: ${parseApiError(err)}`, '');
        }
      }

      sse.progress(`Migrated ${migrated} of ${total}…`, pct);
    }

    sse.complete({ total, migrated, skippedEmpty, skippedNotFound, errors });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

/**
 * POST /api/companies/source-migration/v2-to-v1
 * Copies v2 metadata.source.system + recordId back into
 * v1 sourceOrigin + sourceRecordId for every company that has v2 source data.
 * Note: the v1 API may treat these fields as read-only for some companies;
 * any error is logged per-company rather than failing the whole run.
 * 404 on PATCH (company not in v1) is logged as a warning and skipped.
 */
router.post('/companies/source-migration/v2-to-v1', pbAuth, async (_req, res) => {
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  const sse = startSSE(res);

  try {
    sse.progress('Fetching companies from v2…', 5);
    const v2Companies = await fetchAllPages('/v2/entities?type[]=company', 'fetch v2 companies for source migration');
    const total = v2Companies.length;
    sse.progress(`Fetched ${total} companies`, 20);

    if (total === 0) {
      sse.complete({ total: 0, migrated: 0, skippedEmpty: 0, skippedNotFound: 0, errors: 0 });
      return;
    }

    let migrated = 0;
    let skippedEmpty = 0;
    let skippedNotFound = 0;
    let errors = 0;

    for (let i = 0; i < v2Companies.length; i++) {
      if (sse.isAborted()) break;
      const entity = v2Companies[i];
      const pct = 20 + Math.round(((i + 1) / total) * 78);

      const sourceSystem   = entity.metadata?.source?.system   || '';
      const sourceRecordId = entity.metadata?.source?.recordId || '';

      if (!sourceSystem && !sourceRecordId) {
        skippedEmpty++;
        sse.progress(`Processing ${i + 1} of ${total}…`, pct);
        continue;
      }

      try {
        await withRetry(
          () => pbFetch('patch', `/companies/${entity.id}`, {
            data: {
              sourceOrigin:   sourceSystem   || null,
              sourceRecordId: sourceRecordId || null,
            },
          }),
          `patch company ${entity.id} v1 source`
        );
        migrated++;
        sse.log('success', `Migrated ${entity.id}`, `${sourceSystem} / ${sourceRecordId}`);
      } catch (err) {
        if (err.status === 404) {
          skippedNotFound++;
          sse.log('warn', `Company ${entity.id} not found in v1 — skipped`, '');
        } else {
          errors++;
          sse.log('error', `Failed to migrate ${entity.id}: ${parseApiError(err)}`, '');
        }
      }

      sse.progress(`Migrated ${migrated} of ${total}…`, pct);
    }

    sse.complete({ total, migrated, skippedEmpty, skippedNotFound, errors });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

module.exports = router;
