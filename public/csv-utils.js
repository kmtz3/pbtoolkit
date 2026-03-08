/**
 * Shared CSV utilities — loaded before app.js and entities-app.js.
 * No module system: all functions are global.
 */

/** Strip BOM and normalise CRLF → LF. */
function cleanCSVText(csvText) {
  return csvText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Parse header columns from the first line of a CSV string.
 * Handles quoted commas correctly via lookahead regex.
 */
function parseCSVHeaders(csvText) {
  const firstLine = cleanCSVText(csvText).split('\n')[0];
  return firstLine
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((h) => h.replace(/^"|"$/g, '').trim());
}

/**
 * Count data rows in a CSV string, correctly skipping the header and
 * handling quoted multi-line values (embedded newlines inside "…").
 */
function countCSVDataRows(csvText) {
  const text = cleanCSVText(csvText).trim();
  let rows = 0;
  let inQuotes = false;
  let firstRow = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { i++; } // escaped quote
      else inQuotes = !inQuotes;
    } else if (ch === '\n' && !inQuotes) {
      if (firstRow) firstRow = false;
      else rows++;
    }
  }
  if (!firstRow) rows++; // last row has no trailing newline
  return rows;
}
