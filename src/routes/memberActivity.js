/**
 * Member Activity Export module
 *
 * GET  /api/member-activity/metadata   — init/return session cache (teams list, member count)
 * POST /api/member-activity/export     — SSE: fetch analytics, enrich, filter, emit CSV
 *
 * Headers: x-pb-token (required), x-pb-eu (optional)
 */

const express = require('express');
const { extractCursor } = require('../lib/pbClient');
const { generateCSVFromColumns } = require('../lib/csvUtils');
const { startSSE } = require('../lib/sse');
const { pbAuth } = require('../middleware/pbAuth');
const { parseApiError } = require('../lib/errorUtils');

const router = express.Router();

// ---------------------------------------------------------------------------
// In-memory session cache
// ---------------------------------------------------------------------------

/** @type {Map<string, CacheEntry>} token → CacheEntry */
const sessionCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_MAX_ENTRIES = 200;

function isCacheStale(entry) {
  return !entry || Date.now() - entry.fetchedAt > CACHE_TTL_MS;
}

function pruneCache() {
  if (sessionCache.size < CACHE_MAX_ENTRIES) return;
  // Drop entries over TTL first, then oldest if still over cap
  for (const [key, entry] of sessionCache) {
    if (isCacheStale(entry)) sessionCache.delete(key);
  }
  if (sessionCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = [...sessionCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    sessionCache.delete(oldest[0][0]);
  }
}

// ---------------------------------------------------------------------------
// Cache builder
// ---------------------------------------------------------------------------

const BATCH = 5;
const BATCH_DELAY_MS = 100;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build and store the session cache for a given token.
 * Fetches members and teams concurrently, then fans out team member list
 * calls in batches of 5 to stay within rate limits.
 *
 * @param {string} token
 * @param {Function} fetchAllPages - from createClient()
 * @param {Function} pbFetch      - from createClient() (used for pre-flight)
 * @param {Function} [onProgress] - optional callback(message)
 * @returns {CacheEntry}
 */
async function buildCache(token, fetchAllPages, pbFetch, onProgress = () => {}) {
  // Pre-flight auth check
  onProgress('Validating token…');
  await pbFetch('get', '/v2/members?limit=1');

  // Fetch members + teams concurrently
  onProgress('Fetching members and teams…');
  const [memberRecords, teamRecords] = await Promise.all([
    fetchAllPages('/v2/members?includeDisabled=true', 'fetch members'),
    fetchAllPages('/v2/teams', 'fetch teams'),
  ]);

  // Detect obfuscated PII on first member
  const obfuscated =
    memberRecords.length > 0 && memberRecords[0].fields?.name === '[obfuscated]';

  // Build members map: memberId → { name, email, username, role }
  const members = new Map();
  for (const m of memberRecords) {
    members.set(m.id, {
      name:     m.fields?.name     ?? '[unknown]',
      email:    m.fields?.email    ?? '[unknown]',
      username: m.fields?.username ?? '[unknown]',
      role:     m.fields?.role     ?? 'viewer',
    });
  }

  // Build teams map: teamId → { name, handle }
  const teams = new Map();
  for (const t of teamRecords) {
    teams.set(t.id, { name: t.fields?.name ?? t.id, handle: t.fields?.handle ?? '' });
  }

  // Fan out team member list calls in batches of 5
  onProgress(`Fetching team memberships (${teamRecords.length} teams)…`);
  const memberTeams = new Map(); // memberId → [teamName, ...]
  const teamIds = teamRecords.map((t) => t.id);

  for (let i = 0; i < teamIds.length; i += BATCH) {
    const batch = teamIds.slice(i, i + BATCH);
    await Promise.all(
      batch.map(async (teamId) => {
        const teamMembers = await fetchAllPages(
          `/v2/teams/${teamId}/members`,
          `fetch team members ${teamId}`
        );
        const teamName = teams.get(teamId)?.name ?? teamId;
        for (const m of teamMembers) {
          if (!m.id) continue;
          if (!memberTeams.has(m.id)) memberTeams.set(m.id, []);
          memberTeams.get(m.id).push(teamName);
        }
      })
    );
    // Wait between batches even though pbClient.js has adaptive rate limiting.
    // All 5 calls in a batch fire concurrently via Promise.all, so rate-limit
    // response headers from one batch aren't visible to the next batch's requests
    // until after they've already started. The delay is a safety margin for the
    // parallel-batch pattern specifically; it is not redundant with the sequential limiter.
    if (i + BATCH < teamIds.length) await sleep(BATCH_DELAY_MS);
  }

  const entry = { members, memberTeams, teams, fetchedAt: Date.now(), obfuscated };
  pruneCache();
  sessionCache.set(token, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// GET /api/member-activity/metadata
// ---------------------------------------------------------------------------

router.get('/metadata', pbAuth, async (req, res) => {
  const token = req.headers['x-pb-token']; // used as session cache key
  const { fetchAllPages, pbFetch } = res.locals.pbClient;

  const refresh = req.query.refresh === 'true';
  if (refresh) sessionCache.delete(token);

  try {
    let entry = sessionCache.get(token);
    if (isCacheStale(entry)) {
      entry = await buildCache(token, fetchAllPages, pbFetch);
    }

    // Build sorted teams list with "No team" prepended
    const teamList = [
      { id: '__none__', name: 'No team' },
      ...[...entry.teams.entries()]
        .map(([id, t]) => ({ id, name: t.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ];

    res.json({
      teams: teamList,
      memberCount: entry.members.size,
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      obfuscated: entry.obfuscated ?? false,
    });
  } catch (err) {
    const status = err.status;
    if (status === 401 || status === 403) {
      return res.status(status).json({ error: 'Invalid or unauthorized token.' });
    }
    console.error('member-activity metadata error:', err.message);
    res.status(500).json({ error: parseApiError(err) || 'Failed to load workspace data.' });
  }
});

// ---------------------------------------------------------------------------
// Analytics column definitions (shared between summary and raw)
// ---------------------------------------------------------------------------

// Keys used to compute total_view_events and total_edit_events in summary mode.
// board_opened / board_created are excluded — they appear to be generic aggregates
// that return 0 even when the named board-type counts have values.
const VIEW_EVENT_KEYS = [
  'gridBoardOpenedCount', 'timelineBoardOpenedCount', 'insightsBoardOpenedCount',
  'documentBoardOpenedCount', 'columnBoardOpenedCount',
];

const EDIT_EVENT_KEYS = [
  'featureCreatedCount', 'subfeatureCreatedCount', 'componentCreatedCount',
  'productCreatedCount', 'noteCreatedCount', 'noteStateChangedCount',
  'insightCreatedCount', 'gridBoardCreatedCount', 'timelineBoardCreatedCount',
  'insightsBoardCreatedCount', 'documentBoardCreatedCount', 'columnBoardCreatedCount',
];

const COUNT_COLS = [
  { key: 'boardCreatedCount',          label: 'board_created' },
  { key: 'boardOpenedCount',           label: 'board_opened' },
  { key: 'featureCreatedCount',        label: 'feature_created' },
  { key: 'subfeatureCreatedCount',     label: 'subfeature_created' },
  { key: 'componentCreatedCount',      label: 'component_created' },
  { key: 'productCreatedCount',        label: 'product_created' },
  { key: 'noteCreatedCount',           label: 'note_created' },
  { key: 'noteStateChangedCount',      label: 'note_state_changed' },
  { key: 'insightCreatedCount',        label: 'insight_created' },
  { key: 'gridBoardCreatedCount',      label: 'grid_board_created' },
  { key: 'timelineBoardCreatedCount',  label: 'timeline_board_created' },
  { key: 'insightsBoardCreatedCount',  label: 'insights_board_created' },
  { key: 'documentBoardCreatedCount',  label: 'document_board_created' },
  { key: 'columnBoardCreatedCount',    label: 'column_board_created' },
  { key: 'gridBoardOpenedCount',       label: 'grid_board_opened' },
  { key: 'timelineBoardOpenedCount',   label: 'timeline_board_opened' },
  { key: 'insightsBoardOpenedCount',   label: 'insights_board_opened' },
  { key: 'documentBoardOpenedCount',   label: 'document_board_opened' },
  { key: 'columnBoardOpenedCount',     label: 'column_board_opened' },
];

const SUMMARY_COLS = [
  { key: 'memberId',        label: 'member_id' },
  { key: 'name',            label: 'name' },
  { key: 'email',           label: 'email' },
  { key: 'role',            label: 'role' },
  { key: 'teams',           label: 'teams' },
  { key: 'dateFrom',        label: 'date_from' },
  { key: 'dateTo',          label: 'date_to' },
  { key: 'activeDaysCount',  label: 'active_days_count' },
  { key: 'totalViewEvents', label: 'total_view_events' },
  { key: 'totalEditEvents', label: 'total_edit_events' },
  ...COUNT_COLS,
];

const RAW_COLS = [
  { key: 'date',            label: 'date' },
  { key: 'memberId',        label: 'member_id' },
  { key: 'name',            label: 'name' },
  { key: 'email',           label: 'email' },
  { key: 'role',            label: 'role' },
  { key: 'teams',           label: 'teams' },
  { key: 'activeFlag',      label: 'active_flag' },
  { key: 'totalViewEvents', label: 'total_view_events' },
  { key: 'totalEditEvents', label: 'total_edit_events' },
  ...COUNT_COLS,
];

/** Returns an object with every COUNT_COLS key set to 0. */
function createZeroCountFields() {
  const fields = {};
  for (const col of COUNT_COLS) fields[col.key] = 0;
  return fields;
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

function filterByRole(rows, roles) {
  if (!roles || roles.length === 0) return rows;
  return rows.filter((r) => roles.includes(r.role));
}

/**
 * Filter rows by active/inactive state.
 * @param {object[]} rows
 * @param {'all'|'active'|'inactive'} mode
 * @param {'summary'|'raw'} outputMode
 */
function filterByActiveState(rows, mode, outputMode) {
  if (mode === 'all') return rows;
  if (outputMode === 'summary') {
    return rows.filter((r) =>
      mode === 'active' ? r.activeDaysCount >= 1 : r.activeDaysCount === 0
    );
  }
  // raw mode
  return rows.filter((r) =>
    mode === 'active' ? r.activeFlag === true : r.activeFlag === false
  );
}

// ---------------------------------------------------------------------------
// POST /api/member-activity/export  (SSE)
// ---------------------------------------------------------------------------

router.post('/export', pbAuth, async (req, res) => {
  const token = req.headers['x-pb-token']; // used as session cache key
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;

  const {
    dateFrom,
    dateTo,
    roles        = [],
    teamIds      = [],   // UUIDs or '__none__'
    activeFilter = 'all',
    includeZeroActivity = false,
    rawMode      = false,
  } = req.body || {};

  // Basic date validation
  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo are required.' });
  }
  if (dateFrom > dateTo) {
    return res.status(400).json({ error: 'dateFrom must not be after dateTo.' });
  }

  const sse = startSSE(res);

  try {

    // Step 1: Ensure cache is ready (0–20%)
    let entry = sessionCache.get(token);
    if (isCacheStale(entry)) {
      sse.progress('Loading workspace data…', 5);
      entry = await buildCache(token, fetchAllPages, pbFetch, (msg) => {
        sse.progress(msg, 10);
      });
      sse.progress('Workspace data loaded.', 20);
    } else {
      sse.progress('Using cached workspace data.', 20);
    }

    if (sse.isAborted()) return;

    const { members, memberTeams, teams } = entry;

    // Resolve selected teamIds → team names for filtering
    const selectedTeamNames = teamIds
      .filter((id) => id !== '__none__')
      .map((id) => teams.get(id)?.name)
      .filter(Boolean);
    const includeNoTeam = teamIds.includes('__none__');
    const filterTeams = teamIds.length > 0;

    // Step 2: Fetch analytics (20–80%)
    // Progress uses an asymptotic curve between 25–79% since total pages are unknown.
    // pct(page) = 25 + 55 * (1 - 1/(1 + page*0.6)) — moves fast at first, slows near 80%.
    function analyticsPct(pagesLoaded) {
      return Math.round(25 + 55 * (1 - 1 / (1 + pagesLoaded * 0.6)));
    }

    sse.progress('Fetching member activity data…', 25);

    // links.next only contains pageCursor — it omits dateFrom, dateTo, and limit.
    // We extract the cursor and rebuild the full path to preserve those params.
    let analyticsRecords = [];
    try {
      let nextPath = `/v2/analytics/member-activities?dateFrom=${dateFrom}&dateTo=${dateTo}&limit=1000`;
      let pagesLoaded = 0;
      while (nextPath) {
        const r = await withRetry(() => pbFetch('get', nextPath), 'fetch member activities');
        if (r.data?.length) analyticsRecords.push(...r.data);
        pagesLoaded++;
        const cursor = extractCursor(r.links?.next);
        if (cursor) {
          nextPath = `/v2/analytics/member-activities?dateFrom=${dateFrom}&dateTo=${dateTo}&pageCursor=${cursor}&limit=1000`;
          sse.progress(`Fetching activity data… (${analyticsRecords.length.toLocaleString()} records)`, analyticsPct(pagesLoaded));
        } else {
          nextPath = null;
        }
      }
    } catch (err) {
      console.error('member-activity analytics fetch error:', err.message);
      if (err.status === 404 || err.status === 501) {
        sse.error(`Analytics API error (${err.status}): ${parseApiError(err)}`);
        return;
      }
      throw err;
    }

    sse.progress(`Fetched ${analyticsRecords.length.toLocaleString()} activity records.`, 80);

    if (sse.isAborted()) return;

    // Step 3: Aggregate / build rows (80–90%)
    sse.progress('Processing data…', 82);

    let rows;

    if (!rawMode) {
      // Summary mode: aggregate per memberId
      const totals = new Map(); // memberId → RunningTotal

      for (const rec of analyticsRecords) {
        const { memberId } = rec;
        if (!totals.has(memberId)) {
          totals.set(memberId, { memberId, activeDaysCount: 0, ...createZeroCountFields() });
        }
        const t = totals.get(memberId);
        if (rec.activeFlag) t.activeDaysCount++;
        for (const col of COUNT_COLS) {
          t[col.key] += rec[col.key] ?? 0;
        }
      }

      // Pad zero-activity members if requested
      if (includeZeroActivity) {
        for (const [memberId] of members) {
          if (!totals.has(memberId)) {
            totals.set(memberId, { memberId, activeDaysCount: 0, ...createZeroCountFields() });
          }
        }
      }

      // Enrich with member profile
      rows = [...totals.values()].map((t) => {
        const profile = members.get(t.memberId);
        const teamNames = memberTeams.get(t.memberId) ?? [];
        const totalViewEvents = VIEW_EVENT_KEYS.reduce((sum, k) => sum + (t[k] ?? 0), 0);
        const totalEditEvents = EDIT_EVENT_KEYS.reduce((sum, k) => sum + (t[k] ?? 0), 0);
        return {
          ...t,
          name:     profile ? profile.name     : '[removed]',
          email:    profile ? profile.email    : '[removed]',
          role:     profile ? profile.role     : '[removed]',
          teams:    teamNames.join(', '),
          dateFrom,
          dateTo,
          totalViewEvents,
          totalEditEvents,
        };
      });

    } else {
      // Raw mode: one row per record
      const RAW_CAP = 100_000;
      rows = [];
      for (const rec of analyticsRecords) {
        if (rows.length >= RAW_CAP) {
          sse.log('warn', `Raw export capped at ${RAW_CAP} rows. Use a shorter date range for the full dataset.`);
          break;
        }
        const profile = members.get(rec.memberId);
        const teamNames = memberTeams.get(rec.memberId) ?? [];
        const totalViewEvents = VIEW_EVENT_KEYS.reduce((sum, k) => sum + (rec[k] ?? 0), 0);
        const totalEditEvents = EDIT_EVENT_KEYS.reduce((sum, k) => sum + (rec[k] ?? 0), 0);
        rows.push({
          date:             rec.date,
          memberId:         rec.memberId,
          name:             profile ? profile.name  : '[removed]',
          email:            profile ? profile.email : '[removed]',
          role:             profile ? profile.role  : '[removed]',
          teams:            teamNames.join(', '),
          activeFlag:       rec.activeFlag,
          totalViewEvents,
          totalEditEvents,
          boardCreatedCount:         rec.boardCreatedCount         ?? 0,
          boardOpenedCount:          rec.boardOpenedCount          ?? 0,
          featureCreatedCount:       rec.featureCreatedCount       ?? 0,
          subfeatureCreatedCount:    rec.subfeatureCreatedCount    ?? 0,
          componentCreatedCount:     rec.componentCreatedCount     ?? 0,
          productCreatedCount:       rec.productCreatedCount       ?? 0,
          noteCreatedCount:          rec.noteCreatedCount          ?? 0,
          noteStateChangedCount:     rec.noteStateChangedCount     ?? 0,
          insightCreatedCount:       rec.insightCreatedCount       ?? 0,
          gridBoardCreatedCount:     rec.gridBoardCreatedCount     ?? 0,
          timelineBoardCreatedCount: rec.timelineBoardCreatedCount ?? 0,
          insightsBoardCreatedCount: rec.insightsBoardCreatedCount ?? 0,
          documentBoardCreatedCount: rec.documentBoardCreatedCount ?? 0,
          columnBoardCreatedCount:   rec.columnBoardCreatedCount   ?? 0,
          gridBoardOpenedCount:      rec.gridBoardOpenedCount      ?? 0,
          timelineBoardOpenedCount:  rec.timelineBoardOpenedCount  ?? 0,
          insightsBoardOpenedCount:  rec.insightsBoardOpenedCount  ?? 0,
          documentBoardOpenedCount:  rec.documentBoardOpenedCount  ?? 0,
          columnBoardOpenedCount:    rec.columnBoardOpenedCount    ?? 0,
        });
      }

      // Pad zero-activity members in raw mode (one row each, clearly distinguishable)
      if (includeZeroActivity) {
        const seenIds = new Set(analyticsRecords.map((r) => r.memberId));
        for (const [memberId, profile] of members) {
          if (seenIds.has(memberId)) continue;
          const teamNames = memberTeams.get(memberId) ?? [];
          rows.push({
            date: dateFrom, memberId,
            name: profile.name, email: profile.email,
            role: profile.role, teams: teamNames.join(', '),
            activeFlag: false,
            totalViewEvents: 0, totalEditEvents: 0,
            ...createZeroCountFields(),
          });
        }
      }
    }

    if (sse.isAborted()) return;

    // Track whether zero rows came from the date range or from filters, for the completion message.
    const hadDataBeforeFilters = rows.length > 0;

    // Step 4: Apply client-side filters (90%)
    sse.progress('Applying filters…', 90);

    if (roles.length > 0) {
      rows = filterByRole(rows, roles);
    }

    if (filterTeams) {
      rows = rows.filter((r) => {
        const memberTeamNames = memberTeams.get(r.memberId) ?? [];
        if (includeNoTeam && memberTeamNames.length === 0) return true;
        if (selectedTeamNames.length === 0) return includeNoTeam && memberTeamNames.length === 0;
        return memberTeamNames.some((name) => selectedTeamNames.includes(name));
      });
    }

    rows = filterByActiveState(rows, activeFilter, rawMode ? 'raw' : 'summary');

    if (sse.isAborted()) return;

    // Step 5: Build CSV (95%) — skip if no rows
    sse.progress('Building CSV…', 95);
    const colDefs = rawMode ? RAW_COLS : SUMMARY_COLS;
    const csv = rows.length > 0 ? generateCSVFromColumns(rows, colDefs) : null;

    // Zero-activity paid-seat alert count
    const zeroActivityPaidCount = rawMode
      ? 0 // not meaningful per-row in raw mode
      : rows.filter(
          (r) => r.activeDaysCount === 0 && (r.role === 'admin' || r.role === 'maker')
        ).length;

    // Build filename
    const filename = buildFilename(dateFrom, dateTo, roles, teamIds, teams, activeFilter, rawMode);

    sse.progress('Done!', 100);
    const zeroMessage = rows.length === 0
      ? (hadDataBeforeFilters
          ? 'No members match the selected filters. Try adjusting your filter criteria.'
          : 'No activity data found for this date range. Try a different date range.')
      : null;
    sse.complete({ csv, filename, count: rows.length, zeroActivityPaidCount, zeroMessage });

  } catch (err) {
    console.error('member-activity export error:', err.message);
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

// ---------------------------------------------------------------------------
// Filename builder
// ---------------------------------------------------------------------------

function buildFilename(dateFrom, dateTo, roles, teamIds, teamsMap, activeFilter, rawMode) {
  let name = `pb-member-activity_${dateFrom}_${dateTo}`;

  if (roles && roles.length > 0 && roles.length < 4) {
    name += `_role-${roles.join('-')}`;
  }

  if (teamIds && teamIds.length > 0) {
    const slugs = teamIds.map((id) => {
      if (id === '__none__') return 'no-team';
      const t = teamsMap.get(id);
      return t ? t.handle || slugify(t.name) : id.slice(0, 8);
    });
    name += `_team-${slugs.join('-')}`;
  }

  if (activeFilter === 'active')   name += '_active';
  if (activeFilter === 'inactive') name += '_inactive';
  if (rawMode) name += '_raw';

  // Cap stem at 200 chars to stay well under the 255-byte OS filename limit.
  if (name.length > 200) name = name.slice(0, 200);

  return `${name}.csv`;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

module.exports = router;

// Named exports for unit testing (additive — does not affect Express router behaviour)
module.exports.createZeroCountFields = createZeroCountFields;
module.exports.isCacheStale          = isCacheStale;
module.exports.filterByRole          = filterByRole;
module.exports.filterByActiveState   = filterByActiveState;
module.exports.buildFilename         = buildFilename;
module.exports.buildCache            = buildCache;
module.exports.COUNT_COLS            = COUNT_COLS;
module.exports.CACHE_TTL_MS          = CACHE_TTL_MS;
