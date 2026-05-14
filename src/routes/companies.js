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
const { schemaToType, normalizeSchema, EXCLUDED_FIELD_IDS } = require('../services/entities/configCache');
const { formatCustomFieldValue, isMultiType } = require('../lib/fieldFormat');
const { buildDomainToIdMap } = require('../lib/domainCache');
const {
  fetchFieldValues,
  createFieldValue,
  collectCsvValues,
  findMissingValues,
} = require('../lib/fieldValues');

const STANDARD_FIELD_IDS = new Set(['name', 'description', 'owner']);

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

// Base fields always exported.
// Labels use snake_case to match the import auto-detect hints in companies-app.js,
// so a re-imported export CSV auto-maps columns without manual intervention.
const BASE_FIELDS = [
  { key: 'id',             label: 'pb_id' },
  { key: 'name',           label: 'name' },
  { key: 'domain',         label: 'domain' },
  { key: 'description',    label: 'description' },
  { key: 'owner_email',    label: 'owner_email' },
  { key: 'archived',      label: 'archived' },
  { key: 'sourceOrigin',       label: 'source_origin' },
  { key: 'sourceRecordId',     label: 'source_record_id' },
  { key: 'sourceSystem',   label: 'source_system' },
  { key: 'sourceRecordV2', label: 'source_record_id_v2' },
  { key: 'sourceUrl',     label: 'source_url' },
  { key: 'created_at',    label: 'created_at' },
  { key: 'updated_at',    label: 'updated_at' },
  { key: 'pb_html_link',  label: 'pb_html_link' },
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
      } else if (col.key === 'sourceUrl') {
        row[col.key] = entity.metadata?.source?.url ?? '';
      } else if (col.key === 'owner_email') {
        row[col.key] = fields.owner?.email ?? '';
      } else if (col.key === 'archived') {
        row[col.key] = fields.archived === true ? 'true' : fields.archived === false ? 'false' : '';
      } else if (col.key === 'created_at') {
        row[col.key] = entity.createdAt ?? '';
      } else if (col.key === 'updated_at') {
        row[col.key] = entity.updatedAt ?? '';
      } else if (col.key === 'pb_html_link') {
        row[col.key] = entity.links?.html ?? '';
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
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  const { csvText, mapping, options = {} } = req.body;
  if (!csvText || !mapping) return res.status(400).json({ error: 'Missing csvText or mapping' });

  const { rows, errors: parseErrors } = parseCSV(csvText);

  if (parseErrors.length) {
    return res.json({ valid: false, totalRows: 0, errors: parseErrors.map((e) => ({ row: null, message: e })) });
  }

  // Fetch workspace members for owner validation when owner column is mapped
  // and skipInvalidOwner is not enabled
  let memberEmails = new Set();
  if (mapping.ownerColumn && !options.skipInvalidOwner) {
    try {
      const members = await fetchAllPages('/v2/members', 'fetch members for owner validation');
      for (const m of members) {
        const email = m.fields?.email?.toLowerCase();
        if (email) memberEmails.add(email);
      }
    } catch (_) { /* non-fatal */ }
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

    // Owner validation
    const owner = cell(row, mapping.ownerColumn)?.trim();
    if (owner && memberEmails.size > 0 && !memberEmails.has(owner.toLowerCase())) {
      errors.push({ row: rowNum, field: mapping.ownerColumn, message: `Owner '${owner}' is not a workspace member — fix the email or enable "Skip owner if member does not exist"` });
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

  // ── Field value validation ──────────────────────────────────────────────────
  const warnings = [];
  const selectFields = (mapping.customFields || []).filter(
    (cf) => cf.fieldType === 'select' || cf.fieldType === 'multiselect' || cf.fieldType === 'tags'
  );

  if (selectFields.length > 0) {
    const fieldValueResults = await Promise.allSettled(
      selectFields.map((cf) => fetchFieldValues(cf.fieldId, pbFetch, withRetry))
    );
    selectFields.forEach((cf, idx) => {
      if (fieldValueResults[idx].status !== 'fulfilled') return;
      const knownValues = fieldValueResults[idx].value;
      const isMulti = cf.fieldType === 'multiselect' || cf.fieldType === 'tags';
      const csvValues = collectCsvValues(rows, cf.csvColumn, isMulti);
      const missing = findMissingValues(csvValues, knownValues);
      if (!missing.length) return;
      const available = [...knownValues.values()].map((v) => v.name).sort();
      if (options.autoCreateFieldValues) {
        warnings.push({
          field: cf.name || cf.csvColumn,
          message: `New value(s) will be created for "${cf.name || cf.csvColumn}": ${missing.join(', ')}`,
          isInfo: true,
        });
      } else {
        warnings.push({
          field: cf.name || cf.csvColumn,
          message: `Unknown "${cf.name || cf.csvColumn}" value(s) — will be skipped: ${missing.join(', ')}. Available: ${available.join(', ')}`,
        });
      }
    });
  }

  res.json({
    valid: errors.length === 0,
    totalRows: rows.length,
    errors,
    warnings,
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
    multiSelectMode        = 'set',
    bypassEmptyCells       = false,
    bypassHtmlFormatter    = false,
    skipInvalidOwner       = false,
    autoCreateFieldValues  = false,
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

    // Pre-fetch workspace member emails for owner validation when skipInvalidOwner is on
    let memberEmails = new Set();
    if (skipInvalidOwner && mapping.ownerColumn) {
      try {
        const members = await res.locals.pbClient.fetchAllPages('/v2/members', 'fetch members for owner validation');
        for (const m of members) {
          const email = m.fields?.email?.toLowerCase();
          if (email) memberEmails.add(email);
        }
      } catch (_) { /* non-fatal */ }
    }

    // ── Field value pre-flight ──────────────────────────────────────────────
    // Fetch allowed values for every mapped select/multiselect/tags field.
    // When autoCreateFieldValues is ON, create any missing values upfront.
    // knownFieldValues is then used in createCompanyV2/patchCompanyV2 to skip unknown values.
    const knownFieldValues = new Map(); // fieldId → Map<normalised_name, {id, name}>
    const selectFields = (mapping.customFields || []).filter(
      (cf) => cf.fieldType === 'select' || cf.fieldType === 'multiselect' || cf.fieldType === 'tags'
    );

    if (selectFields.length > 0) {
      sse.progress('Fetching allowed field values…', 2);
      await Promise.all(selectFields.map(async (cf) => {
        try {
          knownFieldValues.set(cf.fieldId, await fetchFieldValues(cf.fieldId, pbFetch, withRetry));
        } catch (_) { /* non-fatal */ }
      }));

      if (autoCreateFieldValues) {
        for (const cf of selectFields) {
          const known = knownFieldValues.get(cf.fieldId);
          if (!known) continue;
          const isMulti = cf.fieldType === 'multiselect' || cf.fieldType === 'tags';
          const csvValues = collectCsvValues(rows, cf.csvColumn, isMulti);
          const missing = findMissingValues(csvValues, known);
          for (const name of missing) {
            try {
              const created = await createFieldValue(cf.fieldId, name, pbFetch, withRetry);
              known.set(name.toLowerCase().trim(), { id: created.id, name });
              sse.log('info', `Created field value "${name}" for "${cf.name || cf.csvColumn}"`);
            } catch (err) {
              sse.log('warn', `Could not create field value "${name}": ${parseApiError(err)}`);
            }
          }
        }
      }
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
    const domainCache = await buildDomainToIdMap(fetchAllPages, 'domain cache for company import');
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
            () => patchCompanyV2(pbFetch, pbId, row, mapping, { multiSelectMode, bypassEmptyCells, bypassHtmlFormatter, memberEmails, knownFieldValues }, domainFieldId),
            `patch company row ${rowNum}`
          );
          companyId = pbId;
          updated++;
          sse.log('success', `Row ${rowNum}: Updated "${label}"`, { uuid: companyId, row: rowNum });
        } else if (domain && domainCache[domain]) {
          // Domain match → v2 PATCH by cached id
          const existingId = domainCache[domain];
          await withRetry(
            () => patchCompanyV2(pbFetch, existingId, row, mapping, { multiSelectMode, bypassEmptyCells, bypassHtmlFormatter, memberEmails, knownFieldValues }, domainFieldId),
            `patch by domain row ${rowNum}`
          );
          companyId = existingId;
          updated++;
          sse.log('success', `Row ${rowNum}: Updated "${label}" by domain match`, { uuid: existingId, row: rowNum });
        } else {
          // Neither → v2 POST (create)
          const created_ = await withRetry(
            () => createCompanyV2(pbFetch, row, mapping, domainFieldId, bypassHtmlFormatter, memberEmails, knownFieldValues),
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

// Domain cache extracted to src/lib/domainCache.js — shared with users.js.

/**
 * Filter a custom field value against the allowed set when knownFieldValues is provided.
 * For select: returns the formatted value if known, undefined if unknown (caller skips).
 * For multiselect/tags: filters items to only known values; returns undefined if none remain.
 * For non-select types: always returns the formatted value unchanged.
 */
function _filterSelectValue(rawVal, cf, knownFieldValues) {
  const isSelect = cf.fieldType === 'select';
  const isMulti  = cf.fieldType === 'multiselect' || cf.fieldType === 'tags';

  if (!knownFieldValues || (!isSelect && !isMulti)) {
    return formatCustomFieldValue(rawVal, cf.fieldType);
  }

  const known = knownFieldValues.get(cf.fieldId);
  if (!known) return formatCustomFieldValue(rawVal, cf.fieldType); // no data — pass through

  if (isSelect) {
    const s = String(rawVal).trim();
    return known.has(s.toLowerCase()) ? { name: s } : undefined;
  }

  // multiselect / tags — filter items
  const parts = String(rawVal).split(',').map((x) => x.trim()).filter(Boolean);
  const knownParts = parts.filter((p) => known.has(p.toLowerCase()));
  if (!knownParts.length) return undefined;
  return knownParts.map((n) => ({ name: n }));
}

/**
 * POST /v2/entities — create a new company with all fields inline.
 * Custom fields and standard fields sent in one request.
 */
async function createCompanyV2(pbFetch, row, mapping, domainFieldId, bypassHtmlFormatter = false, memberEmails = new Set(), knownFieldValues = null) {
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

  const owner = cell(row, mapping.ownerColumn)?.trim();
  if (owner && (memberEmails.size === 0 || memberEmails.has(owner.toLowerCase()))) {
    fields.owner = { email: owner };
  }

  for (const cf of mapping.customFields || []) {
    const rawVal = cell(row, cf.csvColumn);
    if (rawVal === '' || rawVal == null) continue;
    const filteredVal = _filterSelectValue(rawVal, cf, knownFieldValues);
    if (filteredVal !== undefined) {
      fields[cf.fieldId] = filteredVal;
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
  const { multiSelectMode = 'set', bypassEmptyCells = false, bypassHtmlFormatter = false, memberEmails = new Set(), knownFieldValues = null } = options || {};
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

  const owner = cell(row, mapping.ownerColumn)?.trim();
  if (owner && (memberEmails.size === 0 || memberEmails.has(owner.toLowerCase()))) {
    ops.push({ op: 'set', path: 'owner', value: { email: owner } });
  } else if (!owner && !bypassEmptyCells) {
    ops.push({ op: 'clear', path: 'owner' });
  }

  for (const cf of mapping.customFields || []) {
    const rawVal = cell(row, cf.csvColumn);
    const isEmpty = rawVal === '' || rawVal == null;
    if (!isEmpty) {
      const filteredVal = _filterSelectValue(rawVal, cf, knownFieldValues);
      if (filteredVal === undefined) continue; // entirely unknown — skip
      const opName = isMultiType(cf.fieldType) ? multiSelectMode : 'set';
      ops.push({ op: opName, path: cf.fieldId, value: filteredVal });
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
    // Phase 1: Collect all company IDs via GET (more reliable than POST /search)
    sse.progress('Collecting all company IDs…', 5);
    const entities = await res.locals.pbClient.fetchAllPages(
      '/v2/entities?type[]=company',
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
