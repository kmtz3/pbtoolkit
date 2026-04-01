const { UUID_RE } = require('../../lib/constants');

/**
 * Relationship writer for entity import.
 *
 * Runs after the main upsert pass to set parent links and connected-entity links.
 * Mirrors writeRelations_() from mainLogicImporter.gs.
 *
 * Parent links:   PUT  /v2/entities/{id}/relationships/parent
 * Connected links: POST /v2/entities/{id}/relationships
 *
 * Both endpoints return 409 when the relationship already exists — these are
 * swallowed and logged as "already linked" to allow idempotent re-runs.
 */

/**
 * Write all relationships for a set of normalized rows.
 *
 * @param {object[]}  allRows      — all normalized rows from the run (_type, _pbId, _extKey, rel cols…)
 * @param {object}    idCache      — createIdCache() instance
 * @param {Function}  pbFetch      — (method, path, body) → response
 * @param {Function}  withRetry    — (fn, label) → result with retry/backoff
 * @param {Function}  onLog        — (level, message, detail?) → void
 * @returns {{ parentLinks: number, relationshipLinks: number, errors: number, skippedLinks: number }}
 */
async function writeRelations(allRows, idCache, pbFetch, withRetry, onLog) {
  let parentLinks = 0;
  let relationshipLinks = 0;
  let errors = 0;
  let skippedLinks = 0;

  // ── 1. Parent links ──────────────────────────────────────────────────────
  for (const row of allRows) {
    if (row._parentSetInline) continue;

    const selfId = _selfId(row, idCache);
    if (!selfId) continue;

    const parent = idCache.resolveParent(row);
    if (!parent || !parent.id || parent.id === selfId) continue;

    try {
      await withRetry(
        () => pbFetch('put', `/v2/entities/${encodeURIComponent(selfId)}/relationships/parent`,
          { data: { target: { id: parent.id } } }),
        'rel:parent',
      );
      parentLinks++;
      onLog('info', `Set parent → ${parent.id}`, { entityType: row._type, extKey: row._extKey });
    } catch (err) {
      if (_is409(err)) {
        onLog('info', 'Parent already set, skipping', { entityType: row._type, extKey: row._extKey });
      } else {
        errors++;
        onLog('warn', `Parent link failed: ${err.message || err}`, { entityType: row._type, extKey: row._extKey });
      }
    }
  }

  // ── 2. Feature ↔ Initiative ───────────────────────────────────────────────
  for (const row of allRows.filter((r) => r._type === 'feature' && r['connected_inis_ext_key'])) {
    const selfId = _selfId(row, idCache);
    if (!selfId) continue;
    const tokens = _split(row['connected_inis_ext_key']);
    const linked = new Set();
    for (const tok of tokens) {
      const targetId = idCache.resolve('initiative', tok);
      if (!targetId) { skippedLinks++; onLog('warn', `Skipped link — initiative target not resolved: ${tok}`, { entityType: row._type, extKey: row._extKey }); continue; }
      if (targetId === selfId || linked.has(targetId)) continue;
      linked.add(targetId);
      relationshipLinks += await _postLink(selfId, targetId, 'feature-initiative', row, pbFetch, withRetry, onLog);
      if (relationshipLinks < 0) { errors++; relationshipLinks = Math.abs(relationshipLinks) - 1; }
    }
  }

  // ── 3. Initiative ↔ Objective ─────────────────────────────────────────────
  for (const row of allRows.filter((r) => r._type === 'initiative' && r['connected_objs_ext_key'])) {
    const selfId = _selfId(row, idCache);
    if (!selfId) continue;
    const tokens = _split(row['connected_objs_ext_key']);
    const linked = new Set();
    for (const tok of tokens) {
      const targetId = idCache.resolve('objective', tok);
      if (!targetId) { skippedLinks++; onLog('warn', `Skipped link — objective target not resolved: ${tok}`, { entityType: row._type, extKey: row._extKey }); continue; }
      if (targetId === selfId || linked.has(targetId)) continue;
      linked.add(targetId);
      const r = await _postLinkRaw(selfId, targetId, 'initiative-objective', row, pbFetch, withRetry, onLog);
      if (r.ok) relationshipLinks++; else errors++;
    }
  }

  // ── 4. Feature ↔ Objective ────────────────────────────────────────────────
  for (const row of allRows.filter((r) => r._type === 'feature' && r['connected_objs_ext_key'])) {
    const selfId = _selfId(row, idCache);
    if (!selfId) continue;
    const tokens = _split(row['connected_objs_ext_key']);
    const linked = new Set();
    for (const tok of tokens) {
      const targetId = idCache.resolve('objective', tok);
      if (!targetId) { skippedLinks++; onLog('warn', `Skipped link — objective target not resolved: ${tok}`, { entityType: row._type, extKey: row._extKey }); continue; }
      if (targetId === selfId || linked.has(targetId)) continue;
      linked.add(targetId);
      const r = await _postLinkRaw(selfId, targetId, 'feature-objective', row, pbFetch, withRetry, onLog);
      if (r.ok) relationshipLinks++; else errors++;
    }
  }

  // ── 5. Feature / Initiative / Subfeature ↔ Release ────────────────────────
  for (const entityType of ['feature', 'initiative', 'subfeature']) {
    for (const row of allRows.filter((r) => r._type === entityType && r['connected_rels_ext_key'])) {
      const selfId = _selfId(row, idCache);
      if (!selfId) continue;
      const tokens = _split(row['connected_rels_ext_key']);
      const linked = new Set();
      for (const tok of tokens) {
        const targetId = idCache.resolve('release', tok);
        if (!targetId) { skippedLinks++; onLog('warn', `Skipped link — release target not resolved: ${tok}`, { entityType: row._type, extKey: row._extKey }); continue; }
        if (targetId === selfId || linked.has(targetId)) continue;
        linked.add(targetId);
        const r = await _postLinkRaw(selfId, targetId, `${entityType}-release`, row, pbFetch, withRetry, onLog);
        if (r.ok) relationshipLinks++; else errors++;
      }
    }
  }

  // ── 6. Feature / Subfeature / Initiative isBlockedBy ─────────────────────
  for (const entityType of ['feature', 'subfeature', 'initiative']) {
    for (const row of allRows.filter((r) => r._type === entityType && r['blocked_by_ext_key'])) {
      const selfId = _selfId(row, idCache);
      if (!selfId) continue;
      const tokens = _split(row['blocked_by_ext_key']);
      const linked = new Set();
      for (const tok of tokens) {
        const targetId = _resolveDepTarget(idCache, tok);
        if (!targetId) { skippedLinks++; onLog('warn', `Skipped isBlockedBy — target not resolved: ${tok}`, { entityType: row._type, extKey: row._extKey }); continue; }
        if (targetId === selfId || linked.has(targetId)) continue;
        linked.add(targetId);
        const r = await _postDepLink(selfId, targetId, 'isBlockedBy', `${entityType}-blockedBy`, row, pbFetch, withRetry, onLog);
        if (r.ok) relationshipLinks++; else errors++;
      }
    }
  }

  // ── 7. Feature / Subfeature / Initiative isBlocking ───────────────────────
  // Temporary API hotfix: post isBlockedBy from the target's side rather than
  // isBlocking from self. The current API route can return 500 (instead of 409)
  // when isBlocking is posted explicitly for an already-existing pair. Posting
  // isBlockedBy lets PB create the inverse isBlocking and keeps duplicates
  // idempotent until the API route is fixed.
  for (const entityType of ['feature', 'subfeature', 'initiative']) {
    for (const row of allRows.filter((r) => r._type === entityType && r['blocking_ext_key'])) {
      const selfId = _selfId(row, idCache);
      if (!selfId) continue;
      const tokens = _split(row['blocking_ext_key']);
      const linked = new Set();
      for (const tok of tokens) {
        const targetId = _resolveDepTarget(idCache, tok);
        if (!targetId) { skippedLinks++; onLog('warn', `Skipped isBlocking — target not resolved: ${tok}`, { entityType: row._type, extKey: row._extKey }); continue; }
        if (targetId === selfId || linked.has(targetId)) continue;
        linked.add(targetId);
        // POST isBlockedBy on targetId (the entity being blocked), with selfId as the blocker.
        const r = await _postDepLink(targetId, selfId, 'isBlockedBy', `${entityType}-blocking`, row, pbFetch, withRetry, onLog);
        if (r.ok) relationshipLinks++; else errors++;
      }
    }
  }

  return { parentLinks, relationshipLinks, errors, skippedLinks };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _selfId(row, idCache) {
  return row._pbId || idCache.store[row._type]?.[row._extKey] || null;
}

function _split(val) {
  if (!val) return [];
  return String(val).split(',').map((s) => s.trim()).filter(Boolean);
}

function _is409(err) {
  return err && (err.status === 409 || String(err.message || '').includes('409'));
}

async function _postLink(selfId, targetId, label, row, pbFetch, withRetry, onLog) {
  const r = await _postLinkRaw(selfId, targetId, label, row, pbFetch, withRetry, onLog);
  return r.ok ? 1 : 0;
}

async function _postLinkRaw(selfId, targetId, label, row, pbFetch, withRetry, onLog) {
  try {
    await withRetry(
      () => pbFetch('post', `/v2/entities/${encodeURIComponent(selfId)}/relationships`,
        { data: { type: 'link', target: { id: targetId } } }),
      `rel:${label}`,
    );
    onLog('info', `Linked ${label} → ${targetId}`, { entityType: row._type, extKey: row._extKey });
    return { ok: true };
  } catch (err) {
    if (_is409(err)) {
      onLog('info', `${label} already linked, skipping`, { entityType: row._type, extKey: row._extKey });
      return { ok: true }; // 409 is idempotent success
    }
    onLog('warn', `${label} link failed: ${err.message || err}`, { entityType: row._type, extKey: row._extKey });
    return { ok: false };
  }
}

/**
 * Resolve a dependency target token (UUID or ext_key) across all three dep-capable types.
 * Live API shows that isBlockedBy/isBlocking targets can be feature, subfeature, or initiative.
 * UUID tokens bypass the cache and are returned directly.
 */
function _resolveDepTarget(idCache, tok) {
  if (!tok) return null;
  const clean = String(tok).trim();
  if (UUID_RE.test(clean)) return clean;
  for (const type of ['feature', 'subfeature', 'initiative']) {
    const id = idCache.resolve(type, clean);
    if (id) return id;
  }
  return null;
}

async function _postDepLink(selfId, targetId, depType, label, row, pbFetch, withRetry, onLog) {
  try {
    await withRetry(
      () => pbFetch('post', `/v2/entities/${encodeURIComponent(selfId)}/relationships`,
        { data: { type: depType, target: { id: targetId } } }),
      `rel:${label}`,
    );
    onLog('info', `Linked ${label} → ${targetId}`, { entityType: row._type, extKey: row._extKey });
    return { ok: true };
  } catch (err) {
    if (_is409(err)) {
      onLog('info', `${label} already linked, skipping`, { entityType: row._type, extKey: row._extKey });
      return { ok: true };
    }
    onLog('warn', `${label} link failed: ${err.message || err}`, { entityType: row._type, extKey: row._extKey });
    return { ok: false };
  }
}

module.exports = { writeRelations };
