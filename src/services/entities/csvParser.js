/**
 * Entity CSV parser.
 *
 * Wraps PapaParse with entity-specific handling:
 * - BOM stripping
 * - Header trimming
 * - UUID extraction utility for custom field column headers
 */
const Papa = require('papaparse');
const { cell } = require('../../lib/csvUtils');
const { UUID_RE } = require('../../lib/constants');

/**
 * Parse an entity CSV string.
 * @param {string} csvText
 * @returns {{
 *   headers: string[],
 *   rows: object[],
 *   errors: string[],
 *   tooManyFieldsRows: number[],  // 1-indexed row numbers with TooManyFields errors
 * }}
 */
function parseEntityCsv(csvText) {
  const text = String(csvText || '').replace(/^\uFEFF/, '').trim();
  const result = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const tooManyFieldsRows = [];
  const otherErrors = [];
  for (const e of (result.errors || [])) {
    if (e.code === 'TooManyFields' && e.row != null) {
      tooManyFieldsRows.push(e.row + 1); // convert to 1-indexed
    } else {
      otherErrors.push(e.message);
    }
  }

  return {
    headers:           result.meta.fields || [],
    rows:              result.data || [],
    errors:            otherErrors,
    tooManyFieldsRows,
  };
}

/**
 * Extract the UUID from a custom field column header.
 * e.g. "Business Value [Number] [8b54dcf8-4b1e-4550-b490-d7f985c734e8]" → "8b54dcf8-..."
 * Returns null if no UUID suffix is found.
 */
function extractCustomFieldId(header) {
  const m = String(header).match(/\[([^\]]+)\]$/);
  if (!m) return null;
  return UUID_RE.test(m[1].trim()) ? m[1].trim() : null;
}

module.exports = { parseEntityCsv, extractCustomFieldId, cell };
