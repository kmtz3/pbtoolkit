/**
 * CSV utilities using papaparse.
 */
const Papa = require('papaparse');

/**
 * Parse a CSV string into an array of row objects.
 * @param {string} csvString
 * @returns {{ headers: string[], rows: object[], errors: string[] }}
 */
function parseCSV(csvString) {
  const result = Papa.parse(csvString.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const errors = (result.errors || []).map((e) => e.message);
  return {
    headers: result.meta.fields || [],
    rows: result.data || [],
    errors,
  };
}

/**
 * Generate a CSV string from an array of row objects.
 * @param {object[]} rows
 * @param {string[]} fields - Ordered list of field keys to include
 * @param {string[]} headers - Human-readable header labels (same order as fields)
 * @returns {string} CSV string
 */
function generateCSV(rows, fields, headers) {
  // Build data rows as arrays
  const dataRows = rows.map((row) =>
    fields.map((f) => {
      const val = row[f];
      return val == null ? '' : String(val);
    })
  );

  return Papa.unparse({ fields: headers, data: dataRows });
}

/**
 * Generate a CSV string from row objects using column definitions.
 * Convenience wrapper around generateCSV for the common [{key, label}] pattern.
 * @param {object[]} rows
 * @param {Array<{key: string, label: string}>} colDefs
 * @returns {string} CSV string
 */
function generateCSVFromColumns(rows, colDefs) {
  return generateCSV(rows, colDefs.map((c) => c.key), colDefs.map((c) => c.label));
}

module.exports = { parseCSV, generateCSV, generateCSVFromColumns };
