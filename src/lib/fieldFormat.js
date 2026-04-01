/**
 * Shared custom-field formatting for v2 entity imports (companies, users, etc.).
 *
 * These helpers normalise raw CSV values into the shapes the Productboard
 * v2 entities API expects.  Both create (POST fields object) and patch
 * (PATCH ops array) code paths should call formatCustomFieldValue() so
 * the formatting lives in one place.
 */

const { sanitizeDescription } = require('../services/entities/fieldBuilder');

// ── Date normalisation ──────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalise a date string to YYYY-MM-DD.
 * Handles M/D/YY, M/D/YYYY, DD-MM-YYYY, and ISO pass-through.
 * Returns the original string unchanged if parsing fails.
 */
function normalizeDate(raw) {
  const s = String(raw).trim();
  if (ISO_DATE_RE.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const yyyy = d.getFullYear() < 100 ? d.getFullYear() + 2000 : d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ── Custom field value formatter ────────────────────────────────────────────

const MULTI_TYPES = new Set(['multiselect', 'member', 'tag', 'tags']);

/**
 * Convert a raw CSV string into the value shape expected by the PB v2 API
 * for the given field type.
 *
 * @param {string}  rawVal    The raw cell value (never empty — caller filters).
 * @param {string}  fieldType One of: number, select, multiselect, tags, member, richtext, date, text.
 * @returns {*}               The API-ready value.
 */
function formatCustomFieldValue(rawVal, fieldType) {
  if (fieldType === 'number')                              return Number(rawVal);
  if (fieldType === 'select')                              return { name: rawVal };
  if (fieldType === 'multiselect' || fieldType === 'tags') return String(rawVal).split(',').map((x) => x.trim()).filter(Boolean).map((n) => ({ name: n }));
  if (fieldType === 'member')                              return { email: String(rawVal).trim() };
  if (fieldType === 'richtext')                            return sanitizeDescription(rawVal);
  if (fieldType === 'date')                                return normalizeDate(rawVal);
  return rawVal;
}

/**
 * Is this field type a multi-value type (for choosing add/remove/set op)?
 */
function isMultiType(fieldType) {
  return MULTI_TYPES.has(fieldType);
}

module.exports = { normalizeDate, formatCustomFieldValue, isMultiType, MULTI_TYPES };
