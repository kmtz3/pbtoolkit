/**
 * Notes Merge routes
 *
 * POST /api/notes-merge/scan  — fetch all notes, detect duplicates, return preview (SSE)
 * POST /api/notes-merge/run   — execute merge on confirmed preview groups (SSE)
 *
 * Matching logic:
 *   Exact: content + customer-entity-id + title
 *   Loose: content + customer-entity-id only (--loose / UI checkbox)
 *
 * Notes with no content or no customer relationship are excluded from matching.
 * Groups of 100+ notes are flagged but not auto-merged.
 *
 * Data consolidation order (per group):
 *   1. Validate target still exists
 *   2. Merge tags (addItems — idempotent)
 *   3. Merge product hierarchy links (POST relationships, 422 skip)
 *   4. Reconcile state (processed > unprocessed > archived)
 *   5. Add secondary owners as followers on the target (owner-cycling — see below)
 *   6. Preserve user relationship if target only has company and a secondary has user
 *   7. Delete secondary notes
 *
 * Follower transfer (step 5) — v1 retired, no v2 follower-write API exists.
 * Verified workaround: PATCH the target's `owner` field to each new follower's email in
 * turn (3s apart), then restore the target's real owner (or clear it) as the final step.
 * Confirmed live: cycling owner through N members adds each as a permanent follower
 * without removing previously-added ones, and clearing/changing owner afterward does
 * NOT remove them as a follower. There is no v2 API to read a note's existing follower
 * list at all, so only secondary owners (not secondaries' other followers) can be
 * transferred — that's a hard capability loss from the v1 followers endpoint.
 */

const express = require('express');
const { extractCursor } = require('../lib/pbClient');
const { startSSE } = require('../lib/sse');
const { parseApiError } = require('../lib/errorUtils');
const { pbAuth } = require('../middleware/pbAuth');
const { buildIdToDomainMap } = require('../lib/domainCache');
const { buildIdToEmailMap } = require('../lib/userCache');

const router = express.Router();

// State priority: lower number = higher priority
const STATE_PRIORITY = { processed: 0, unprocessed: 1, archived: 2 };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function getNoteState(note) {
  const f = note.fields || {};
  if (f.processed === true || f.processed === 'true') return 'processed';
  if (f.archived  === true || f.archived  === 'true') return 'archived';
  return 'unprocessed';
}

function getNoteTags(note) {
  return (note.fields?.tags || []).map(t => t.name);
}

function getNoteLinks(note) {
  const rels = Array.isArray(note.relationships?.data) ? note.relationships.data : [];
  return rels.filter(r => r.type === 'link' && r.target?.id).map(r => r.target.id);
}

function getNoteCustomerRel(note) {
  const rels = Array.isArray(note.relationships?.data) ? note.relationships.data : [];
  return rels.find(r => r.type === 'customer') || null;
}

/**
 * Build the matching key for a note.
 * Returns null if the note has no content or no customer relationship.
 */
function buildGroupKey(note, looseMatch) {
  const f = note.fields || {};
  const raw = typeof f.content === 'object' ? JSON.stringify(f.content) : (f.content || '');
  if (!raw) return null;

  const customerRel = getNoteCustomerRel(note);
  const customerId  = customerRel?.target?.id || null;
  if (!customerId) return null;

  const name = looseMatch ? '' : (f.name || '');
  // Use null-byte as a separator that cannot appear in normal text
  return `${name}\x00${raw}\x00${customerId}`;
}

/**
 * Select the target (note to keep) from a group based on the chosen strategy.
 * Tiebreaker: highest note ID (lexicographic) for determinism.
 */
function selectTarget(notes, targetMode) {
  return notes.reduce((best, n) => {
    if (!best) return n;
    if (targetMode === 'oldest') {
      if ((n.createdAt || '') < (best.createdAt || '')) return n;
      if ((n.createdAt || '') === (best.createdAt || '') && (n.id || '') > (best.id || '')) return n;
      return best;
    }
    if (targetMode === 'most-metadata') {
      const scoreN    = getNoteTags(n).length    + getNoteLinks(n).length;
      const scoreBest = getNoteTags(best).length + getNoteLinks(best).length;
      if (scoreN > scoreBest) return n;
      if (scoreN === scoreBest && (n.id || '') > (best.id || '')) return n;
      return best;
    }
    // default: newest
    if ((n.createdAt || '') > (best.createdAt || '')) return n;
    if ((n.createdAt || '') === (best.createdAt || '') && (n.id || '') > (best.id || '')) return n;
    return best;
  }, null);
}

// ---------------------------------------------------------------------------
// Cache builders
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Preview builder
// ---------------------------------------------------------------------------

function buildNotePreview(note, userMap, companyMap) {
  const f   = note.fields || {};
  const rel = getNoteCustomerRel(note);

  let customerEmail   = '';
  let customerCompany = '';
  if (rel?.target) {
    const { id, type } = rel.target;
    if (type === 'user')    customerEmail   = userMap[id]?.email  || id;
    if (type === 'company') customerCompany = companyMap[id]?.domain || id;
  }

  const metaSrc = note.metadata?.source || {};
  const sourceOrigin   = metaSrc.system   || '';
  const sourceRecordId = metaSrc.recordId || '';

  const rawContent = typeof f.content === 'object' ? JSON.stringify(f.content) : (f.content || '');

  return {
    id:               note.id          || '',
    title:            f.name           || '',
    content_preview:  rawContent.slice(0, 100),
    customer_email:   customerEmail,
    customer_company: customerCompany,
    customer_type:    rel?.target?.type || '',
    customer_id:      rel?.target?.id  || '',
    owner_email:      f.owner?.email   || '',
    tags:             getNoteTags(note),
    product_links:    getNoteLinks(note),
    source_origin:    sourceOrigin,
    source_record_id: sourceRecordId,
    state:            getNoteState(note),
    created_at:       note.createdAt   || '',
  };
}

// ---------------------------------------------------------------------------
// POST /scan
// ---------------------------------------------------------------------------

router.post('/scan', pbAuth, async (req, res) => {
  const sse = startSSE(res);
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  const { createdFrom, createdTo, looseMatch = false, targetMode = 'newest' } = req.body || {};

  try {
    // Phase 1: Fetch all v2 notes
    sse.progress('Fetching notes…', 5);
    const notes = [];
    let cursor = null;
    let page   = 0;
    do {
      const params = new URLSearchParams();
      if (createdFrom) params.set('createdFrom', createdFrom);
      if (createdTo)   params.set('createdTo',   createdTo);
      if (cursor)      params.set('pageCursor',   cursor);
      const qs  = params.toString();
      const url = `/v2/notes${qs ? `?${qs}` : ''}`;
      const r   = await withRetry(() => pbFetch('get', url), `fetch notes page ${page + 1}`);
      if (r.data?.length) notes.push(...r.data);
      cursor = extractCursor(r.links?.next);
      page++;
      sse.progress(`Fetching notes… (${notes.length} so far)`, Math.min(30, 5 + page));
    } while (cursor);

    sse.progress(`Fetched ${notes.length} notes. Building lookup caches…`, 35);

    // Phase 2: Build caches in parallel
    const [userMap, companyMap] = await Promise.all([
      buildIdToEmailMap(fetchAllPages, 'fetch users for notes-merge scan'),
      buildIdToDomainMap(fetchAllPages, 'fetch companies for notes-merge scan'),
    ]);

    sse.progress('Detecting duplicates…', 75);

    // Phase 3: Group notes by matching key
    const keyToNotes = new Map();
    for (const note of notes) {
      const key = buildGroupKey(note, looseMatch);
      if (!key) continue; // no content or no customer — excluded
      if (!keyToNotes.has(key)) keyToNotes.set(key, []);
      keyToNotes.get(key).push(note);
    }

    // Phase 4: Find partial matches (loose key matches that aren't exact matches)
    // Only relevant when looseMatch=false — shows notes that share content+customer but differ in title
    const partialMatchGroups = [];
    if (!looseMatch) {
      const looseKeyToNotes = new Map();
      for (const note of notes) {
        const key = buildGroupKey(note, true);
        if (!key) continue;
        if (!looseKeyToNotes.has(key)) looseKeyToNotes.set(key, []);
        looseKeyToNotes.get(key).push(note);
      }
      for (const looseNotes of looseKeyToNotes.values()) {
        if (looseNotes.length < 2) continue;
        // Check if all notes in this loose group share the same exact key
        const firstExact = buildGroupKey(looseNotes[0], false);
        const allSameExact = looseNotes.every(n => buildGroupKey(n, false) === firstExact);
        if (!allSameExact) {
          // Different titles — partial matches, show for information only
          partialMatchGroups.push(looseNotes.map(n => buildNotePreview(n, userMap, companyMap)));
        }
      }
    }

    // Phase 5: Build duplicate groups (2+ notes with same exact key)
    const groups = [];
    let totalToDelete = 0;
    let oversizedGroupCount = 0;

    for (const groupNotes of keyToNotes.values()) {
      if (groupNotes.length < 2) continue;
      if (groupNotes.length >= 100) {
        oversizedGroupCount++;
        continue;
      }
      const target     = selectTarget(groupNotes, targetMode);
      const secondaries = groupNotes.filter(n => n.id !== target.id);
      totalToDelete   += secondaries.length;

      groups.push({
        groupId:     `g-${target.id}`,
        target:      buildNotePreview(target,    userMap, companyMap),
        secondaries: secondaries.map(n => buildNotePreview(n, userMap, companyMap)),
      });
    }

    sse.progress(`Found ${groups.length} duplicate group(s).`, 100);
    sse.complete({
      groups,
      partialMatchGroups,
      stats: {
        totalNotes:        notes.length,
        groupsFound:       groups.length,
        notesInGroups:     groups.reduce((s, g) => s + 1 + g.secondaries.length, 0),
        notesToDelete:     totalToDelete,
        partialMatchGroups: partialMatchGroups.length,
        oversizedGroups:   oversizedGroupCount,
      },
    });
  } catch (err) {
    console.error('[notesMerge/scan]', err);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// POST /run
// ---------------------------------------------------------------------------

router.post('/run', pbAuth, async (req, res) => {
  const sse = startSSE(res);
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { groups = [] } = req.body || {};

  const runId    = `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  const auditLog = [];
  let merged = 0, skipped = 0, deleted = 0, errors = 0;

  try {
    sse.progress(`Starting merge of ${groups.length} group(s)…`, 0);

    for (let i = 0; i < groups.length; i++) {
      if (sse.isAborted()) break;

      const { target, secondaries } = groups[i];
      const pct = Math.round((i / groups.length) * 90);
      sse.progress(`Merging group ${i + 1} of ${groups.length}…`, pct);

      const auditEntry = {
        runId,
        timestamp:       new Date().toISOString(),
        op:              'merge_group',
        targetNoteId:    target.id,
        secondaryNoteIds: secondaries.map(s => s.id),
        tagsAdded:       [],
        linksAdded:      [],
        followersAdded:  [],
        stateChange:     null,
        sourcesDiscarded: secondaries
          .filter(s => s.source_origin)
          .map(s => ({ noteId: s.id, origin: s.source_origin, recordId: s.source_record_id })),
        deleted: [],
        errors:  [],
      };

      try {
        // Step 1: Validate target still exists
        await withRetry(() => pbFetch('get', `/v2/notes/${target.id}`), `validate target ${target.id}`);

        // Step 2: Merge tags from all secondaries
        const newTags = [...new Set(secondaries.flatMap(s => s.tags || []))]
          .filter(t => !(target.tags || []).includes(t));
        if (newTags.length > 0) {
          await withRetry(() => pbFetch('patch', `/v2/notes/${target.id}`, {
            data: { patch: [{ op: 'addItems', path: 'tags', value: newTags.map(n => ({ name: n })) }] },
          }), `add tags to ${target.id}`);
          auditEntry.tagsAdded = newTags;
        }

        // Step 3: Merge product hierarchy links
        const targetLinkSet = new Set(target.product_links || []);
        const newLinks = [...new Set(secondaries.flatMap(s => s.product_links || []))]
          .filter(id => !targetLinkSet.has(id));
        for (const entityId of newLinks) {
          try {
            await withRetry(() => pbFetch('post', `/v2/notes/${target.id}/relationships`, {
              data: { type: 'link', target: { id: entityId, type: 'link' } },
            }), `link ${entityId} to ${target.id}`);
            auditEntry.linksAdded.push(entityId);
          } catch (linkErr) {
            if (linkErr.status !== 422) {
              // 422 = already linked, silently skip; other errors are logged
              sse.log('warn', `Link ${entityId} to ${target.id} failed: ${parseApiError(linkErr)}`);
            }
          }
        }

        // Step 4: Reconcile state (highest priority wins)
        const allStates   = [target, ...secondaries].map(n => n.state || 'unprocessed');
        const highestState = allStates.reduce((best, s) =>
          (STATE_PRIORITY[s] ?? 99) < (STATE_PRIORITY[best] ?? 99) ? s : best
        );
        if (highestState !== (target.state || 'unprocessed')) {
          const patch = highestState === 'processed'
            ? [{ op: 'set', path: 'processed', value: true  }, { op: 'set', path: 'archived', value: false }]
            : highestState === 'archived'
            ? [{ op: 'set', path: 'archived',  value: true  }, { op: 'set', path: 'processed', value: false }]
            : [{ op: 'set', path: 'processed', value: false }, { op: 'set', path: 'archived',  value: false }];
          await withRetry(() => pbFetch('patch', `/v2/notes/${target.id}`, {
            data: { patch },
          }), `update state on ${target.id}`);
          auditEntry.stateChange = { from: target.state || 'unprocessed', to: highestState };
        }

        // Step 5: Add secondary owners as followers on the target via owner-cycling.
        // No v2 follower-write API exists — PATCHing `owner` to each email in turn adds
        // that person as a permanent follower (verified live), then the target's real
        // owner is restored (or cleared) as the final step. ~3s between each PATCH.
        const targetOwnerEmail = target.owner_email || '';
        const followerEmailSet = new Set(
          secondaries.map(s => s.owner_email).filter(e => e && e !== targetOwnerEmail)
        );
        if (followerEmailSet.size > 0) {
          const setOwner = (email) => withRetry(() => pbFetch('patch', `/v2/notes/${target.id}`, {
            data: { patch: [{ op: 'set', path: 'owner', value: { email } } ] },
          }), `cycle owner ${email} on ${target.id}`);

          let cycled = 0;
          for (const email of followerEmailSet) {
            if (sse.isAborted()) break;
            try {
              await setOwner(email);
              auditEntry.followersAdded.push(email);
            } catch (followerErr) {
              sse.log('warn', `Add follower ${email} failed: ${parseApiError(followerErr)}`);
            }
            cycled++;
            sse.log('info', `Transferring followers on ${target.id}… (${cycled}/${followerEmailSet.size})`);
            await new Promise((r) => setTimeout(r, 3000));
          }

          // Restore the target's real owner (or clear it if it never had one).
          try {
            if (targetOwnerEmail) {
              await setOwner(targetOwnerEmail);
            } else {
              await withRetry(() => pbFetch('patch', `/v2/notes/${target.id}`, {
                data: { patch: [{ op: 'clear', path: 'owner' }] },
              }), `clear owner on ${target.id}`);
            }
          } catch (restoreErr) {
            sse.log('warn', `Could not restore target owner after follower transfer on ${target.id}: ${parseApiError(restoreErr)}`);
          }
        }

        // Step 6: Preserve user relationship if target has company-only and a secondary has user rel
        if (target.customer_type !== 'user') {
          const secWithUser = secondaries.find(s => s.customer_type === 'user' && s.customer_id);
          if (secWithUser) {
            try {
              await withRetry(() => pbFetch('put', `/v2/notes/${target.id}/relationships/customer`, {
                data: { type: 'customer', target: { id: secWithUser.customer_id, type: 'user' } },
              }), `set user rel on ${target.id}`);
            } catch (relErr) {
              sse.log('warn', `User relationship update failed: ${parseApiError(relErr)}`);
            }
          }
        }

        // Step 7: Delete secondary notes
        for (const sec of secondaries) {
          if (sse.isAborted()) break;
          try {
            await withRetry(() => pbFetch('delete', `/v2/notes/${sec.id}`), `delete note ${sec.id}`);
            auditEntry.deleted.push(sec.id);
            deleted++;
          } catch (delErr) {
            sse.log('error', `Delete ${sec.id} failed: ${parseApiError(delErr)}`);
            auditEntry.errors.push(`delete failed: ${sec.id}`);
            errors++;
          }
        }

        sse.log('success', `Group ${i + 1}: merged ${secondaries.length} note(s) into ${target.id}`);
        merged++;
      } catch (groupErr) {
        const msg = parseApiError(groupErr);
        sse.log('error', `Group ${i + 1} skipped — ${msg}`);
        auditEntry.errors.push(msg);
        skipped++;
        errors++;
      }

      auditLog.push(auditEntry);
    }

    const stopped = sse.isAborted();
    sse.progress(stopped ? 'Stopped.' : 'Merge complete.', 100);
    sse.complete({ runId, merged, deleted, skipped, errors, stopped, auditLog });
  } catch (err) {
    console.error('[notesMerge/run]', err);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// POST /scan-empty
// ---------------------------------------------------------------------------

router.post('/scan-empty', pbAuth, async (req, res) => {
  const sse = startSSE(res);
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  const { createdFrom, createdTo } = req.body || {};

  try {
    sse.progress('Fetching notes…', 5);
    const notes = [];
    let cursor = null;
    let page   = 0;

    do {
      const params = new URLSearchParams();
      if (createdFrom) params.set('createdFrom', createdFrom);
      if (createdTo)   params.set('createdTo',   createdTo);
      if (cursor)      params.set('pageCursor',   cursor);
      const qs  = params.toString();
      const url = `/v2/notes${qs ? `?${qs}` : ''}`;
      const r   = await withRetry(() => pbFetch('get', url), `fetch notes page ${page + 1}`);
      if (r.data?.length) notes.push(...r.data);
      cursor = extractCursor(r.links?.next);
      page++;
      sse.progress(`Fetching notes… (${notes.length} so far)`, Math.min(50, 5 + page * 2));
    } while (cursor);

    sse.progress(`Fetched ${notes.length} notes. Building caches…`, 55);

    const [userMap, companyMap] = await Promise.all([
      buildIdToEmailMap(fetchAllPages, 'fetch users for notes-merge scan-empty'),
      buildIdToDomainMap(fetchAllPages, 'fetch companies for notes-merge scan-empty'),
    ]);

    sse.progress('Detecting empty notes…', 85);

    const emptyNotes = [];
    for (const note of notes) {
      const f   = note.fields || {};
      const raw = typeof f.content === 'object' ? JSON.stringify(f.content) : (f.content || '');
      if (raw.trim()) continue; // has content — skip

      const rel = getNoteCustomerRel(note);
      let customerEmail   = '';
      let customerCompany = '';
      if (rel?.target) {
        const { id, type } = rel.target;
        if (type === 'user')    customerEmail   = userMap[id]?.email      || id;
        if (type === 'company') customerCompany = companyMap[id]?.domain || id;
      }

      emptyNotes.push({
        id:               note.id          || '',
        title:            f.name           || '',
        customer_email:   customerEmail,
        customer_company: customerCompany,
        owner_email:      f.owner?.email   || '',
        state:            getNoteState(note),
        created_at:       note.createdAt   || '',
      });
    }

    sse.progress(`Found ${emptyNotes.length} empty note(s).`, 100);
    sse.complete({
      emptyNotes,
      stats: { totalNotes: notes.length, emptyFound: emptyNotes.length },
    });
  } catch (err) {
    console.error('[notesMerge/scan-empty]', err);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// POST /delete-empty
// ---------------------------------------------------------------------------

router.post('/delete-empty', pbAuth, async (req, res) => {
  const sse = startSSE(res);
  const { pbFetch, withRetry } = res.locals.pbClient;
  const { notes = [] } = req.body || {};

  let deleted = 0, errors = 0;

  try {
    sse.progress(`Deleting ${notes.length} empty note(s)…`, 0);

    for (let i = 0; i < notes.length; i++) {
      if (sse.isAborted()) break;

      const note = notes[i];
      const pct  = Math.round((i / notes.length) * 95);
      sse.progress(`Deleting note ${i + 1} of ${notes.length}…`, pct);

      try {
        await withRetry(() => pbFetch('delete', `/v2/notes/${note.id}`), `delete note ${note.id}`);
        sse.log('success', `Deleted: ${note.title ? `"${note.title}"` : `(untitled)`} — ${note.id}`);
        deleted++;
      } catch (err) {
        sse.log('error', `Failed to delete ${note.id}: ${parseApiError(err)}`);
        errors++;
      }
    }

    const stopped = sse.isAborted();
    sse.progress(stopped ? 'Stopped.' : 'Done.', 100);
    sse.complete({ deleted, errors, stopped });
  } catch (err) {
    console.error('[notesMerge/delete-empty]', err);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

module.exports = router;
