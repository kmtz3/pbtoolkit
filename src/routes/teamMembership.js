/**
 * Team Membership module
 *
 * GET  /api/team-membership/metadata  — init/return session cache (teams list, member count)
 * GET  /api/team-membership/export    — direct CSV download (?format=A|B&teamIds=id1,id2,...)
 * POST /api/team-membership/preview   — parse CSV + diff; returns TeamDiff[] JSON
 * POST /api/team-membership/import    — SSE: re-parse CSV + diff + execute import
 *
 * Headers: x-pb-token (required), x-pb-eu (optional)
 */

'use strict';

const express = require('express');
const { listTeams, listMembers, listTeamMembers } = require('../lib/pbClient');
const { parseCSV } = require('../lib/csvUtils');
const { startSSE } = require('../lib/sse');
const { pbAuth } = require('../middleware/pbAuth');
const { parseApiError } = require('../lib/errorUtils');

const router = express.Router();

// ---------------------------------------------------------------------------
// Session cache
// ---------------------------------------------------------------------------

/** @type {Map<string, CacheEntry>} token → CacheEntry */
const sessionCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
const CACHE_MAX_ENTRIES = 200;

const BATCH = 5;
const BATCH_DELAY_MS = 100;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isCacheStale(entry) {
  return !entry || Date.now() - entry.fetchedAt > CACHE_TTL_MS;
}

function pruneCache() {
  if (sessionCache.size < CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of sessionCache) {
    if (isCacheStale(entry)) sessionCache.delete(key);
  }
  if (sessionCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = [...sessionCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    sessionCache.delete(oldest[0][0]);
  }
}

/**
 * Build and store the session cache for a given token.
 * Fetches members (includeDisabled:false, includeInvited:false) and teams concurrently,
 * then fans out team relationship calls in batches of 5.
 *
 * @param {string} token
 * @param {object} pbClient - from createClient()
 * @param {Function} [onProgress]
 * @returns {CacheEntry}
 */
async function buildCache(token, pbClient, onProgress = () => {}) {
  onProgress('Fetching members and teams…');

  const [memberRecords, teamRecords] = await Promise.all([
    listMembers(pbClient, { includeDisabled: false, includeInvited: false }),
    listTeams(pbClient),
  ]);

  // membersById: id → MemberProfile
  const membersById = new Map();
  // membersByEmail: email.toLowerCase() → MemberProfile
  const membersByEmail = new Map();
  for (const m of memberRecords) {
    const profile = {
      id:    m.id,
      name:  m.fields?.name     ?? '[unknown]',
      email: m.fields?.email    ?? '',
      role:  m.fields?.role     ?? 'viewer',
    };
    membersById.set(m.id, profile);
    if (profile.email) membersByEmail.set(profile.email.toLowerCase().trim(), profile);
  }

  // teamsById: id → TeamMeta
  const teamsById = new Map();
  for (const t of teamRecords) {
    teamsById.set(t.id, {
      id:     t.id,
      name:   t.fields?.name   ?? t.id,
      handle: t.fields?.handle ?? '',
    });
  }

  // memberIdsByTeamId: teamId → Set<memberId>
  const memberIdsByTeamId = new Map();
  const teamIds = teamRecords.map((t) => t.id);
  for (const id of teamIds) memberIdsByTeamId.set(id, new Set());

  onProgress(`Fetching team memberships (${teamRecords.length} teams)…`);

  let reqCount = 0;
  for (let i = 0; i < teamIds.length; i += BATCH) {
    const batch = teamIds.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (teamId) => {
        const members = await listTeamMembers(pbClient, teamId);
        reqCount++;
        for (const m of members) {
          if (m.id) memberIdsByTeamId.get(teamId)?.add(m.id);
        }
      })
    );
    // Inter-batch sleep: all 5 calls in a batch fire concurrently via Promise.all,
    // so rate-limit headers from one batch aren't visible to the next batch's requests
    // until after they've already started. This delay is the safety margin.
    if (i + BATCH < teamIds.length) await sleep(BATCH_DELAY_MS);
  }

  console.log(`[team-membership] cache built: ${membersById.size} members, ${teamsById.size} teams, ${reqCount} member-list requests`);

  const entry = { membersById, membersByEmail, teamsById, memberIdsByTeamId, fetchedAt: Date.now() };
  pruneCache();
  sessionCache.set(token, entry);
  return entry;
}

function invalidateCache(token) {
  sessionCache.delete(token);
}

async function refreshAfterImport(token, pbClient) {
  invalidateCache(token);
  return buildCache(token, pbClient);
}

/**
 * Return a display name for a team, appending handle when another team shares the same name.
 */
function getDisplayName(team, allTeams) {
  const hasDuplicate = allTeams.some((t) => t.id !== team.id && t.name === team.name);
  return hasDuplicate ? `${team.name} (${team.handle})` : team.name;
}

// ---------------------------------------------------------------------------
// GET /api/team-membership/metadata
// ---------------------------------------------------------------------------

router.get('/metadata', pbAuth, async (req, res) => {
  const token = req.headers['x-pb-token'];
  const { pbClient } = res.locals;

  const refresh = req.query.refresh === 'true';
  if (refresh) invalidateCache(token);

  try {
    let entry = sessionCache.get(token);
    if (isCacheStale(entry)) {
      entry = await buildCache(token, pbClient);
    }

    const allTeams = [...entry.teamsById.values()].sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      teams:       allTeams,
      memberCount: entry.membersById.size,
      fetchedAt:   new Date(entry.fetchedAt).toISOString(),
    });
  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    console.error('[team-membership] metadata error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to load workspace data.' });
  }
});

// ---------------------------------------------------------------------------
// CSV Format helpers
// ---------------------------------------------------------------------------

const UUID_PATTERN = /\[([0-9a-f-]{36})\]/i;

/**
 * Extract teamId and teamName from a header like "Team Alpha [abc123-...]"
 * @returns {{ teamId: string|null, teamName: string }}
 */
function extractTeamId(header) {
  const m = header.match(UUID_PATTERN);
  if (m) {
    return {
      teamId:   m[1],
      teamName: header.replace(UUID_PATTERN, '').trim(),
    };
  }
  return { teamId: null, teamName: header.trim() };
}

/**
 * Detect CSV format from headers array.
 * @param {string[]} headers
 * @returns {'A' | 'B' | 'unknown'}
 */
function detectFormat(headers) {
  if (!headers || headers.length === 0) return 'unknown';
  if (headers[0].toLowerCase() === 'email') return 'A';
  if (UUID_PATTERN.test(headers[0])) return 'B';
  return 'unknown';
}

const TRUTHY_VALUES  = new Set(['✓', '✔', '☑', 'yes', 'y', 'assigned', 'assign', 'true', '1', 'x']);
const FALSY_VALUES   = new Set(['false', '0', 'no', 'n', 'unassigned', '']);

/**
 * Normalise a cell value to assigned/not-assigned.
 * @param {string} raw
 * @returns {{ assigned: boolean, unrecognised: boolean }}
 */
function normaliseAssignedValue(raw) {
  const v = (raw ?? '').toString().trim().toLowerCase();
  if (TRUTHY_VALUES.has(v)) return { assigned: true,  unrecognised: false };
  if (FALSY_VALUES.has(v))  return { assigned: false, unrecognised: false };
  return { assigned: false, unrecognised: true };
}

/**
 * Parse Format A CSV rows into ParsedAssignment[].
 * Columns: email, name, role, "Team Name [uuid]", ...
 */
function parseFormatA(headers, rows) {
  const teamCols = headers.slice(3).map((h) => ({ header: h, ...extractTeamId(h) }));
  const assignments = [];
  const unrecognisedCells = [];

  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx];
    const email = (row['email'] ?? row['Email'] ?? '').toString().trim();
    if (!email) continue;

    for (const col of teamCols) {
      const cellVal = row[col.header] ?? '';
      const { assigned, unrecognised } = normaliseAssignedValue(cellVal);

      if (unrecognised) {
        unrecognisedCells.push({ row: rowIdx + 2, col: col.header, value: cellVal });
      }

      if (assigned) {
        assignments.push({
          teamId:      col.teamId,
          teamName:    col.teamName,
          email,
          headerHasId: col.teamId !== null,
        });
      }
    }
  }

  return { assignments, unrecognisedCells };
}

/**
 * Parse Format B CSV rows into ParsedAssignment[].
 * Each column is a team; cells are member emails stacked vertically.
 */
function parseFormatB(headers, rows) {
  const teamCols = headers.map((h) => ({ header: h, ...extractTeamId(h) }));
  const assignments = [];

  for (const row of rows) {
    for (const col of teamCols) {
      // PapaParse pads shorter columns with '' — treat undefined and '' identically
      const email = (row[col.header] ?? '').toString().trim();
      if (!email) continue;

      assignments.push({
        teamId:      col.teamId,
        teamName:    col.teamName,
        email,
        headerHasId: col.teamId !== null,
      });
    }
  }

  return { assignments, unrecognisedCells: [] };
}

// ---------------------------------------------------------------------------
// Import engine
// ---------------------------------------------------------------------------

/**
 * Resolve email → memberId for each ParsedAssignment.
 * Returns { resolved: ResolvedAssignment[], unresolvableEmails: string[] }
 */
function resolveAssignments(assignments, cache) {
  const resolved = [];
  const unresolvableSet = new Map(); // email → teamName (for reporting)

  for (const a of assignments) {
    const member = cache.membersByEmail.get(a.email.toLowerCase().trim());
    if (!member) {
      unresolvableSet.set(a.email, a.teamName);
      continue;
    }
    resolved.push({
      teamId:      a.teamId,
      teamName:    a.teamName,
      memberId:    member.id,
      email:       a.email,
      headerHasId: a.headerHasId,
    });
  }

  return {
    resolved,
    unresolvableEmails: [...unresolvableSet.entries()].map(([email, teamName]) => ({ email, teamName })),
  };
}

/**
 * Build desired state: Map<teamId, Set<memberId>>
 * Only includes teams that appear in the CSV.
 */
function buildDesiredState(resolved) {
  const desired = new Map();
  for (const r of resolved) {
    if (!r.teamId) continue;
    if (!desired.has(r.teamId)) desired.set(r.teamId, new Set());
    desired.get(r.teamId).add(r.memberId);
  }
  return desired;
}

/**
 * Compute diff for each team present in desired state.
 * Set mode: only teams that appear in the CSV are diffed.
 *           Teams absent from CSV are completely untouched.
 *
 * @param {Map<string, Set<string>>} desired
 * @param {object} cache
 * @param {'add'|'remove'|'set'} mode
 * @returns {TeamDiff[]}
 */
function buildDiff(desired, cache, mode) {
  const diffs = [];

  for (const [teamId, desiredMembers] of desired) {
    const teamMeta = cache.teamsById.get(teamId);
    if (!teamMeta) continue; // unknown team — validation should have caught this

    const current = cache.memberIdsByTeamId.get(teamId) ?? new Set();
    const allTeams = [...cache.teamsById.values()];

    let toAdd     = [];
    let toRemove  = [];
    let unchanged = [];

    if (mode === 'add') {
      toAdd     = [...desiredMembers].filter((id) => !current.has(id));
      toRemove  = [];
      unchanged = [...desiredMembers].filter((id) =>  current.has(id));
    } else if (mode === 'remove') {
      toAdd     = [];
      toRemove  = [...desiredMembers].filter((id) =>  current.has(id));
      unchanged = [...current].filter((id) => !desiredMembers.has(id));
    } else {
      // set — source of truth for teams in CSV only
      toAdd     = [...desiredMembers].filter((id) => !current.has(id));
      toRemove  = [...current].filter((id) => !desiredMembers.has(id));
      unchanged = [...desiredMembers].filter((id) =>  current.has(id));
    }

    diffs.push({
      teamId,
      teamName:    getDisplayName(teamMeta, allTeams),
      toAdd,
      toRemove,
      unchanged,
    });
  }

  return diffs;
}

/**
 * Resolve a memberId → email for log messages, falling back to the raw ID.
 */
function memberEmail(id, cache) {
  return cache.membersById.get(id)?.email ?? id;
}

/**
 * Execute import: process TeamDiff[] via API calls, emitting SSE log events.
 * @param {TeamDiff[]} diffs
 * @param {object} cache
 * @param {object} pbClient
 * @param {object} sse
 * @returns {ImportResult}
 */
async function executeImport(diffs, cache, pbClient, sse) {
  const result = {
    added:               0,
    removed:             0,
    skippedAlreadyMember: 0,
    skippedNotMember:     0,
    errors:              [],
  };

  const totalTeams = diffs.filter((d) => d.toAdd.length + d.toRemove.length > 0).length;
  let doneTeams = 0;

  for (const diff of diffs) {
    if (sse.isAborted()) break;
    const hasAdds    = diff.toAdd.length > 0;
    const hasRemoves = diff.toRemove.length > 0;
    if (!hasAdds && !hasRemoves) continue;

    // Build a single PATCH with addItems and/or removeItems operations
    const patchOps = [];
    if (hasAdds) {
      patchOps.push({
        op: 'addItems',
        path: 'members',
        value: diff.toAdd.map((id) => ({ id })),
      });
    }
    if (hasRemoves) {
      patchOps.push({
        op: 'removeItems',
        path: 'members',
        value: diff.toRemove.map((id) => ({ id })),
      });
    }

    try {
      await pbClient.withRetry(
        () => pbClient.pbFetch('patch', `/v2/teams/${diff.teamId}`, {
          data: { patch: patchOps },
        }),
        `update members of ${diff.teamId}`
      );

      // Log individual successes
      for (const memberId of diff.toAdd) {
        result.added++;
        sse.log('success', `Added ${memberEmail(memberId, cache)} → ${diff.teamName}`, { uuid: memberId });
      }
      for (const memberId of diff.toRemove) {
        result.removed++;
        sse.log('success', `Removed ${memberEmail(memberId, cache)} ← ${diff.teamName}`, { uuid: memberId });
      }
    } catch (err) {
      const detail = parseApiError(err);
      let correlationId = null;
      try { correlationId = JSON.parse(err.message.split(' → ')[1]?.split(': ').slice(1).join(': '))?.id ?? null; } catch (_) {}

      // Count all members in this team as errors
      for (const memberId of [...diff.toAdd, ...diff.toRemove]) {
        result.errors.push({ teamId: diff.teamId, memberId, detail, correlationId });
      }
      sse.log('error', `Failed to update ${diff.teamName} — ${detail}`, { uuid: correlationId ?? diff.teamId });
    }

    doneTeams++;
    sse.progress(`Processing… (${doneTeams}/${totalTeams} teams)`, Math.round((doneTeams / totalTeams) * 90));
  }

  return result;
}

// ---------------------------------------------------------------------------
// CSV validation helpers (shared by /preview and /import)
// ---------------------------------------------------------------------------

/**
 * Parse + validate an uploaded CSV.
 * Returns hard errors (block import), soft warnings, and parsed assignments.
 */
function parseAndValidate(csvText, cache) {
  const { headers, rows, errors: parseErrors } = parseCSV(csvText);

  if (parseErrors.length > 0) {
    return { hardErrors: [`Malformed CSV: ${parseErrors[0]}`], warnings: [], assignments: [], unrecognisedCells: [], format: null };
  }

  if (!headers || headers.length === 0) {
    return { hardErrors: ['CSV has no headers.'], warnings: [], assignments: [], unrecognisedCells: [], format: null };
  }

  const format = detectFormat(headers);

  let assignments = [];
  let unrecognisedCells = [];

  if (format === 'A') {
    const result = parseFormatA(headers, rows);
    assignments        = result.assignments;
    unrecognisedCells  = result.unrecognisedCells;
  } else if (format === 'B') {
    const result = parseFormatB(headers, rows);
    assignments        = result.assignments;
    unrecognisedCells  = result.unrecognisedCells;
  } else {
    return { hardErrors: ['Could not detect CSV format. First column must be "email" (Format A) or a "Team Name [uuid]" header (Format B).'], warnings: [], assignments: [], unrecognisedCells: [], format: null };
  }

  // Validate team IDs
  const hardErrors = [];
  const unknownTeamHeaders = new Set();
  for (const a of assignments) {
    if (a.teamId && !cache.teamsById.has(a.teamId)) {
      unknownTeamHeaders.add(`${a.teamName} [${a.teamId}]`);
    }
  }
  if (unknownTeamHeaders.size > 0) {
    hardErrors.push(
      `The following teams were not found in your workspace: ${[...unknownTeamHeaders].join(', ')}. Fix your CSV or create these teams in Productboard first.`
    );
  }

  // Name-resolved team warnings (headers without UUID)
  const warnings = [];
  const nameResolved = new Map(); // teamName → matched team
  for (const a of assignments) {
    if (!a.teamId) {
      // Try name resolution
      const match = [...cache.teamsById.values()].find(
        (t) => t.name.toLowerCase() === a.teamName.toLowerCase()
      );
      if (match) {
        a.teamId = match.id; // patch in place
        if (!nameResolved.has(a.teamName)) {
          nameResolved.set(a.teamName, match);
          warnings.push({ type: 'nameResolved', colName: a.teamName, resolvedTo: match });
        }
      } else {
        hardErrors.push(
          `Column "${a.teamName}" has no team ID and could not be resolved by name. Fix your CSV header.`
        );
      }
    }
  }

  if (unrecognisedCells.length > 0) {
    warnings.push({
      type:    'unrecognisedValues',
      count:   unrecognisedCells.length,
      samples: unrecognisedCells.slice(0, 5),
    });
  }

  return { hardErrors, warnings, assignments, unrecognisedCells, format };
}

// ---------------------------------------------------------------------------
// GET /api/team-membership/export
// ---------------------------------------------------------------------------

router.get('/export', pbAuth, async (req, res) => {
  const token  = req.headers['x-pb-token'];
  const format  = (req.query.format || 'A').toUpperCase();
  const teamIds = req.query.teamIds
    ? req.query.teamIds.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  try {
    let entry = sessionCache.get(token);
    if (isCacheStale(entry)) {
      const { pbClient } = res.locals;
      entry = await buildCache(token, pbClient);
    }

    const csv = format === 'B'
      ? exportFormatB(entry, teamIds)
      : exportFormatA(entry, teamIds);

    const today = new Date().toISOString().slice(0, 10);
    let filename = `pb-team-assignments_${today}`;
    if (format === 'B') filename += '_stacked';
    if (teamIds && teamIds.length === 1) {
      const t = entry.teamsById.get(teamIds[0]);
      if (t) filename += `_${slugify(t.name)}`;
    }
    filename += '.csv';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    console.error('[team-membership] export error:', err.message);
    res.status(500).json({ error: err.message || 'Export failed.' });
  }
});

// ---------------------------------------------------------------------------
// CSV export serializers
// ---------------------------------------------------------------------------

function csvCell(v) {
  const s = v == null ? '' : String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('[') || s.includes(']')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(',');
}

/**
 * Format A: one row per member, one column per team.
 * Header: email, name, role, "Team Name [team-id]", ...
 * Cell value: ✓ if assigned, empty if not.
 */
function exportFormatA(cache, filterTeamIds) {
  const teams = [...cache.teamsById.values()]
    .filter((t) => !filterTeamIds || filterTeamIds.includes(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const header = ['email', 'name', 'role', ...teams.map((t) => `${t.name} [${t.id}]`)];
  const lines  = ['\uFEFF' + csvRow(header)];

  const members = [...cache.membersById.values()].sort((a, b) => a.email.localeCompare(b.email));

  for (const m of members) {
    const cells = [m.email, m.name, m.role];
    for (const t of teams) {
      const assigned = cache.memberIdsByTeamId.get(t.id)?.has(m.id) ?? false;
      cells.push(assigned ? '✓' : '');
    }
    lines.push(csvRow(cells));
  }

  return lines.join('\n');
}

/**
 * Format B: one column per team, member emails stacked vertically.
 * Header: "Team Name [team-id]", ...
 */
function exportFormatB(cache, filterTeamIds) {
  const teams = [...cache.teamsById.values()]
    .filter((t) => !filterTeamIds || filterTeamIds.includes(t.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const header = teams.map((t) => `${t.name} [${t.id}]`);

  // Build member lists per team
  const columns = teams.map((t) => {
    const memberIds = [...(cache.memberIdsByTeamId.get(t.id) ?? [])];
    return memberIds
      .map((id) => cache.membersById.get(id)?.email ?? id)
      .sort();
  });

  const maxLen = columns.reduce((n, col) => Math.max(n, col.length), 0);
  const lines  = ['\uFEFF' + csvRow(header)];

  for (let i = 0; i < maxLen; i++) {
    const cells = columns.map((col) => col[i] ?? '');
    lines.push(csvRow(cells));
  }

  return lines.join('\n');
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// POST /api/team-membership/preview
// ---------------------------------------------------------------------------

router.post('/preview', pbAuth, async (req, res) => {
  const token = req.headers['x-pb-token'];
  const { csvText, mode = 'set' } = req.body || {};

  if (!csvText) return res.status(400).json({ error: 'csvText is required.' });
  if (!['add', 'remove', 'set'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "add", "remove", or "set".' });
  }

  try {
    let entry = sessionCache.get(token);
    const { pbClient } = res.locals;
    if (isCacheStale(entry)) {
      entry = await buildCache(token, pbClient);
    }

    const { hardErrors, warnings, assignments } = parseAndValidate(csvText, entry);

    if (hardErrors.length > 0) {
      return res.json({ hardErrors, warnings, diffs: null });
    }

    const { resolved, unresolvableEmails } = resolveAssignments(assignments, entry);
    const desired = buildDesiredState(resolved);
    const diffs   = buildDiff(desired, entry, mode);

    // Enrich diffs: replace raw member IDs with { id, email } objects for the preview UI
    function enrichMember(id) {
      const m = entry.membersById.get(id);
      return { id, email: m?.email ?? id };
    }
    const enrichedDiffs = diffs.map((d) => ({
      ...d,
      toAdd:     d.toAdd.map(enrichMember),
      toRemove:  d.toRemove.map(enrichMember),
      unchanged: d.unchanged.map(enrichMember),
    }));

    // Collect name-resolved warnings and unrecognised value warnings from parseAndValidate
    const nameResolvedWarnings = warnings
      .filter((w) => w.type === 'nameResolved')
      .map((w) => ({ colName: w.colName, resolvedId: w.resolvedTo.id, resolvedName: w.resolvedTo.name }));

    const unrecognisedWarning = warnings.find((w) => w.type === 'unrecognisedValues') ?? null;

    res.json({
      hardErrors:        [],
      diffs:             enrichedDiffs,
      unresolvableEmails,
      nameResolvedTeams: nameResolvedWarnings,
      unrecognisedValues: unrecognisedWarning
        ? { count: unrecognisedWarning.count, samples: unrecognisedWarning.samples }
        : null,
    });
  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    console.error('[team-membership] preview error:', err.message);
    res.status(500).json({ error: err.message || 'Preview failed.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/team-membership/import  (SSE)
// ---------------------------------------------------------------------------

router.post('/import', pbAuth, async (req, res) => {
  const token = req.headers['x-pb-token'];
  const { csvText, mode = 'set' } = req.body || {};

  if (!csvText) {
    return res.status(400).json({ error: 'csvText is required.' });
  }
  if (!['add', 'remove', 'set'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "add", "remove", or "set".' });
  }

  const sse = startSSE(res);

  try {
    // Step 1 — Ensure cache is warm
    let entry = sessionCache.get(token);
    const { pbClient } = res.locals;
    if (isCacheStale(entry)) {
      sse.progress('Loading workspace data…', 2);
      entry = await buildCache(token, pbClient, (msg) => sse.progress(msg, 5));
      sse.progress('Workspace data loaded.', 8);
    } else {
      sse.progress('Using cached workspace data.', 8);
    }

    if (sse.isAborted()) return;

    // Step 2 — Parse + validate
    sse.progress('Parsing CSV…', 10);
    const { hardErrors, warnings, assignments } = parseAndValidate(csvText, entry);

    if (hardErrors.length > 0) {
      sse.error(hardErrors[0]);
      return;
    }

    if (sse.isAborted()) return;

    // Step 3 — Resolve + diff (against current state at execute time)
    sse.progress('Computing diff…', 15);
    const { resolved, unresolvableEmails } = resolveAssignments(assignments, entry);
    const desired = buildDesiredState(resolved);
    const diffs   = buildDiff(desired, entry, mode);

    if (unresolvableEmails.length > 0) {
      sse.log('warn', `${unresolvableEmails.length} email(s) could not be resolved and will be skipped.`);
    }

    const totalOps = diffs.reduce((n, d) => n + d.toAdd.length + d.toRemove.length, 0);

    if (totalOps === 0) {
      sse.progress('No changes to apply.', 100);
      sse.complete({ added: 0, removed: 0, skippedAlreadyMember: 0, skippedNotMember: 0, errors: [] });
      return;
    }

    sse.progress(`Executing ${totalOps} operation(s)…`, 20);

    // Step 4 — Execute
    const result = await executeImport(diffs, entry, pbClient, sse);

    if (sse.isAborted()) return;

    // Step 5 — Invalidate cache so next export/preview sees updated state
    await refreshAfterImport(token, pbClient);

    sse.progress('Done!', 100);
    sse.complete(result);

  } catch (err) {
    console.error('[team-membership] import error:', err.message);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

module.exports = router;
