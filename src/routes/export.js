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
const express = require('express');
const { createClient } = require('../lib/pbClient');
const { generateCSVFromColumns } = require('../lib/csvUtils');
const { startSSE } = require('../lib/sse');

const router = express.Router();

// Base fields always exported
const BASE_FIELDS = [
  { key: 'id',             label: 'PB Company ID' },
  { key: 'name',           label: 'Company Name' },
  { key: 'domain',         label: 'Domain' },
  { key: 'description',    label: 'Description' },
  { key: 'sourceOrigin',   label: 'Source Origin' },
  { key: 'sourceRecordId', label: 'Source Record ID' },
];

router.post('/', async (req, res) => {
  const token = req.headers['x-pb-token'];
  const useEu = req.headers['x-pb-eu'] === 'true';

  if (!token) {
    return res.status(400).json({ error: 'Missing x-pb-token header' });
  }

  const sse = startSSE(res);
  const { pbFetch, withRetry } = createClient(token, useEu);

  try {
    // Step 1: Fetch custom field definitions
    sse.progress('Fetching custom field definitions…', 5);
    const customFields = await fetchAllCustomFields(pbFetch, withRetry, (fetched) => {
      sse.progress(`Fetching custom field definitions… (${fetched} found)`, 5);
    });
    sse.progress(`Found ${customFields.length} custom fields`, 10);

    // Step 2: Fetch all companies (paginated)
    sse.progress('Fetching companies…', 15);
    const { companies, total } = await fetchAllCompanies(pbFetch, withRetry, (fetched, knownTotal) => {
      const pct = 15 + Math.round((fetched / Math.max(knownTotal || fetched, 1)) * 30);
      sse.progress(`Fetched ${fetched}${knownTotal ? '/' + knownTotal : ''} companies…`, Math.min(pct, 45));
    });

    if (companies.length === 0) {
      sse.complete({ csv: '', filename: 'companies.csv', count: 0, message: 'No companies found in workspace.' });
      sse.done();
      return;
    }

    sse.progress(`Fetching custom field values for ${companies.length} companies…`, 48);

    // Step 3: Fetch custom field values per company (parallel batches)
    if (customFields.length > 0) {
      await fetchCustomFieldValues(pbFetch, companies, customFields, (done, total) => {
        const pct = 48 + Math.round((done / total) * 40);
        sse.progress(`Custom fields: ${done}/${total} values fetched…`, Math.min(pct, 88));
      });
    }

    // Step 4: Build CSV
    sse.progress('Building CSV…', 90);
    const csv = buildExportCSV(companies, customFields);

    const date = new Date().toISOString().slice(0, 10);
    const filename = `companies-${date}.csv`;

    sse.progress('Done!', 100);
    sse.complete({ csv, filename, count: companies.length });
  } catch (err) {
    console.error('export error:', err.message);
    sse.error(err.message || 'Export failed');
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------

async function fetchAllCustomFields(pbFetch, withRetry, onProgress = () => {}) {
  const fields = [];
  let offset = 0;
  const limit = 100;
  let hasMore = true;

  while (hasMore) {
    const response = await withRetry(
      () => pbFetch('get', `/companies/custom-fields?pageLimit=${limit}&pageOffset=${offset}`),
      `fetch custom fields offset ${offset}`
    );
    if (response.data?.length) fields.push(...response.data);
    onProgress(fields.length);
    hasMore = !!(response.links?.next) && fields.length < 1000;
    offset += limit;
  }
  return fields;
}

async function fetchAllCompanies(pbFetch, withRetry, onProgress) {
  const companies = [];
  let offset = 0;
  const limit = 100;
  let total = null;
  let hasMore = true;

  while (hasMore) {
    const response = await withRetry(
      () => pbFetch('get', `/companies?pageLimit=${limit}&pageOffset=${offset}`),
      `fetch companies offset ${offset}`
    );

    if (response.data?.length) {
      companies.push(...response.data);
    }

    if (response.pagination) {
      total = response.pagination.total ?? total;
      const { offset: off, limit: lim } = response.pagination;
      hasMore = (off + lim) < (total ?? Infinity);
    } else {
      hasMore = !!(response.links?.next);
    }

    offset += limit;
    onProgress(companies.length, total);

    if (companies.length >= 10000) break;
  }

  return { companies, total };
}

async function fetchCustomFieldValues(pbFetch, companies, customFields, onProgress) {
  const BATCH = 5;
  const total = companies.length * customFields.length;
  let done = 0;

  // Build flat request list
  const requests = [];
  for (const company of companies) {
    for (const field of customFields) {
      requests.push({ company, field });
    }
  }

  for (let i = 0; i < requests.length; i += BATCH) {
    const batch = requests.slice(i, i + BATCH);

    await Promise.all(
      batch.map(async ({ company, field }) => {
        try {
          const response = await pbFetch(
            'get',
            `/companies/${company.id}/custom-fields/${field.id}/value`
          );
          if (!company._customFieldValues) company._customFieldValues = {};
          company._customFieldValues[field.id] = response.data?.value ?? null;
        } catch (err) {
          if (err.status !== 404) {
            console.warn(`Custom field value fetch failed: company ${company.id}, field ${field.id}: ${err.message}`);
          }
          // 404 = not set, leave as null
        }
      })
    );

    done += batch.length;
    onProgress(done, total);

    // Small delay between batches to respect rate limits
    if (i + BATCH < requests.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function buildExportCSV(companies, customFields) {
  // Column definitions: key (for lookup) + label (CSV header)
  const cols = [
    ...BASE_FIELDS,
    ...customFields.map((f) => ({
      key: `custom__${f.id}`,
      label: f.name || f.id,
    })),
  ];

  const rows = companies.map((company) => {
    const row = {};
    for (const col of cols) {
      if (col.key.startsWith('custom__')) {
        const fieldId = col.key.slice(8);
        row[col.key] = company._customFieldValues?.[fieldId] ?? '';
      } else if (col.key === 'id') {
        row[col.key] = company.id ?? '';
      } else if (col.key === 'sourceOrigin') {
        row[col.key] = company.source?.origin ?? company.sourceOrigin ?? '';
      } else if (col.key === 'sourceRecordId') {
        row[col.key] = company.source?.record_id ?? company.sourceRecordId ?? '';
      } else {
        row[col.key] = company[col.key] ?? '';
      }
    }
    return row;
  });

  return generateCSVFromColumns(rows, cols);
}

module.exports = router;
