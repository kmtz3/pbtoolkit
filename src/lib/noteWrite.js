/**
 * Shared v2 note-write helpers used by routes/notes.js (CSV import) and
 * routes/feedback.js (bug-report notes).
 *
 *   resolveTags()             — lookup-or-create tag values on the shared "tags" field
 *   resolveOrCreateUser()     — email  → user entity UUID (creates if unknown)
 *   resolveOrCreateCompany()  — domain → company entity UUID (creates if unknown)
 *   createNoteV2()            — POST /v2/notes with owner/creator fallback and
 *                               customer-relationship propagation-delay retry
 *
 * Do not remove the propagation-delay retry in createNoteV2: a user/company
 * entity created moments earlier can briefly 404 when referenced in a note's
 * relationships (live-reproduced — see CLAUDE.md "Do Not Touch").
 */

const { createFieldValue } = require('./fieldValues');
const { parseApiError } = require('./errorUtils');

const NOTE_TYPES = ['textNote', 'conversationNote', 'opportunityNote'];

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
 * Resolve tag names to the shared "tags" field-value set, creating any that
 * don't exist yet. tagCache is a normalised-name → { id, name } Map seeded from
 * fetchFieldValues('tags', ...) and is mutated in place.
 * A tag that cannot be created is skipped (not fatal) and reported in `failures`.
 * @returns {Promise<{ tags: Array<{name: string}>, failures: Array<{name: string, error: string}> }>}
 */
async function resolveTags(pbFetch, withRetry, tagCache, tagNames) {
  const tags = [];
  const failures = [];
  for (const name of tagNames) {
    const key = String(name).toLowerCase().trim();
    if (!key) continue;
    if (!tagCache.has(key)) {
      try {
        const created = await createFieldValue('tags', name, pbFetch, withRetry);
        tagCache.set(key, created);
      } catch (err) {
        failures.push({ name, error: parseApiError(err) });
        continue;
      }
    }
    tags.push({ name: tagCache.get(key).name });
  }
  return { tags, failures };
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
 * Build the v2 metadata.source object. None of system/recordId/url is required
 * by the spec, but system+recordId are only sent as a pair (matches the import
 * preview rule "source_record_id requires source_origin"); url is independent.
 * Returns null when nothing would be sent.
 */
function buildNoteSource({ sourceOrigin, sourceRecordId, sourceUrl }) {
  const source = {};
  if (sourceOrigin && sourceRecordId) {
    source.system = sourceOrigin;
    source.recordId = sourceRecordId;
  }
  if (sourceUrl) source.url = sourceUrl;
  return Object.keys(source).length ? source : null;
}

/**
 * POST /v2/notes. Retries with owner/creator stripped if PB rejects them
 * (the mapped email isn't an active workspace member). A customer relationship
 * pointing at a user/company entity created moments earlier can 404 briefly
 * (propagation delay) — retried with backoff (1.5s, 3s, 4.5s) before being dropped.
 * Returns { id, ownerSkipped, creatorSkipped, customerSkipped }.
 */
async function createNoteV2(pbFetch, withRetry, {
  type, fields, sourceOrigin, sourceRecordId, sourceUrl, customerRel, label = 'create note',
}) {
  let currentFields = { ...fields };
  let currentCustomerRel = customerRel;
  let ownerSkipped = false, creatorSkipped = false, customerSkipped = false;
  let propagationRetries = 0;
  const source = buildNoteSource({ sourceOrigin, sourceRecordId, sourceUrl });

  for (let attempt = 0; attempt < 6; attempt++) {
    const payload = { data: { type: type || 'textNote', fields: currentFields } };
    if (source) payload.data.metadata = { source };
    if (currentCustomerRel) payload.data.relationships = [currentCustomerRel];

    try {
      const r = await withRetry(() => pbFetch('post', '/v2/notes', payload), label);
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

module.exports = {
  NOTE_TYPES,
  extractFailedFieldPath,
  resolveTags,
  resolveOrCreateUser,
  resolveOrCreateCompany,
  buildNoteSource,
  createNoteV2,
};
