/**
 * Entity row validator.
 *
 * Validates a set of CSV rows for one entity type against a column mapping.
 *
 * Rules applied:
 *   - Duplicate ext_key within a CSV                        → hard error
 *   - CREATE row (no pb_id) with missing name               → hard error
 *   - release CREATE row missing parent_rlgr_ext_key        → hard error
 *   - timeframe_start/end cell not matching YYYY-MM-DD      → hard error
 *   - health_updated_by (email) cell not a valid email      → hard error
 *
 * Rules NOT applied (deferred):
 *   - Status / phase / select option value validation
 *     (v2 configurations returns no option values; PB returns 4xx at import time)
 */

const { cell } = require('./csvParser');

const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE    = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE   = /<?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})>?/i;

/**
 * Validate rows for one entity type.
 *
 * @param {string}   entityType  — e.g. 'feature'
 * @param {object[]} rows        — parsed CSV rows (column header as key, cell value as value)
 * @param {object}   mapping     — { columns: { internalFieldId: csvColumnHeader } }
 *                                 Falls back to standard column names if a mapping key is absent.
 * @returns {{ errors: Array<{row,field,message}>, warnings: Array<{row,field,message}> }}
 */
function validateEntityRows(entityType, rows, mapping) {
  const errors   = [];
  const warnings = [];
  const cols     = (mapping && mapping.columns) ? mapping.columns : {};

  // Resolve column headers, falling back to template defaults
  const hasMapping    = Object.keys(cols).length > 0;
  const pbIdCol       = cols['pb_id']                  || 'pb_id';
  const extKeyCol     = cols['ext_key']                || 'ext_key';
  const nameCol       = cols['name']                   || null; // set by mapping or stays null
  const parentRlgrCol = cols['parent_rlgr_ext_key']    || 'parent_rlgr_ext_key';
  // Format-validated fields: only validate if explicitly mapped, or if no mapping is configured.
  // When a mapping exists but the field is absent, the user chose "skip" — don't validate it.
  const tfStartCol    = 'timeframe_start' in cols         ? cols['timeframe_start']
                      : (hasMapping ? null : 'timeframe_start (YYYY-MM-DD)');
  const tfEndCol      = 'timeframe_end' in cols           ? cols['timeframe_end']
                      : (hasMapping ? null : 'timeframe_end (YYYY-MM-DD)');
  const healthByCol   = 'health_updated_by_email' in cols ? cols['health_updated_by_email']
                      : (hasMapping ? null : 'health_updated_by (email)');

  const seenExtKeys = new Set();

  rows.forEach((row, i) => {
    const rowNum = i + 2; // 1-indexed; row 1 is the header
    const pbId   = cell(row, pbIdCol);
    const extKey = cell(row, extKeyCol);
    const isCreate = !pbId || !UUID_RE.test(pbId);

    // ── Duplicate ext_key ────────────────────────────────────────────────────
    if (extKey) {
      if (seenExtKeys.has(extKey)) {
        errors.push({
          row:     rowNum,
          field:   extKeyCol,
          message: `Duplicate ext_key '${extKey}' — each row must have a unique ext_key`,
        });
      }
      seenExtKeys.add(extKey);
    }

    // ── CREATE-only checks ───────────────────────────────────────────────────
    if (isCreate) {
      // Name is required on CREATE
      const effectiveNameCol = nameCol || 'Name';
      const name = cell(row, effectiveNameCol);
      if (!name) {
        errors.push({
          row:     rowNum,
          field:   effectiveNameCol,
          message: 'Name is required for new entities (rows without a valid pb_id)',
        });
      }

      // release must have a parent release group
      if (entityType === 'release') {
        const rlgr = cell(row, parentRlgrCol);
        if (!rlgr) {
          errors.push({
            row:     rowNum,
            field:   parentRlgrCol,
            message: 'parent_rlgr_ext_key is required — releases cannot be created without a parent release group',
          });
        }
      }
    }

    // ── Date format (applies to both CREATE and PATCH rows) ──────────────────
    if (tfStartCol) {
      const tfStart = cell(row, tfStartCol);
      if (tfStart && !DATE_RE.test(tfStart)) {
        errors.push({
          row:     rowNum,
          field:   tfStartCol,
          message: `timeframe_start must be YYYY-MM-DD (got '${tfStart}')`,
        });
      }
    }

    if (tfEndCol) {
      const tfEnd = cell(row, tfEndCol);
      if (tfEnd && !DATE_RE.test(tfEnd)) {
        errors.push({
          row:     rowNum,
          field:   tfEndCol,
          message: `timeframe_end must be YYYY-MM-DD (got '${tfEnd}')`,
        });
      }
    }

    // ── Email format for health updated-by ───────────────────────────────────
    if (healthByCol) {
      const healthBy = cell(row, healthByCol);
      if (healthBy && !healthBy.match(EMAIL_RE)) {
        errors.push({
          row:     rowNum,
          field:   healthByCol,
          message: `health_updated_by (email) must be a valid email address (got '${healthBy}')`,
        });
      }
    }
  });

  return { errors, warnings };
}

module.exports = { validateEntityRows };
