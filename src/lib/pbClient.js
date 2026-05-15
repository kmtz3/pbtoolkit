/**
 * Productboard API client
 * Ported from companiesMain.gs — preserves rate limiting, retry, and backoff logic.
 */

const BASE_US = 'https://api.productboard.com';
const BASE_EU = 'https://api.eu.productboard.com';
// Allow test env to redirect API calls to a local mock server
const PB_API_BASE_URL_OVERRIDE = () => process.env.PB_API_BASE_URL || null;

/**
 * Extract pageCursor value from a links.next URL or path string.
 * Works with full URLs, relative paths, and internal service URLs.
 * @param {string|null} nextLink
 * @returns {string|null}
 */
function extractCursor(nextLink) {
  if (!nextLink) return null;
  const match = String(nextLink).match(/pageCursor=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Create a PB API client bound to a specific token and datacenter.
 * @param {string} token - Productboard API token
 * @param {boolean} useEu - Whether to use the EU datacenter
 * @returns {object} Client with fetch/retry methods and rate limiter state
 */
function createClient(token, useEu = false) {
  const baseUrl = PB_API_BASE_URL_OVERRIDE() || (useEu ? BASE_EU : BASE_US);

  // Rate limiter state — per client instance (per request lifecycle)
  const rl = {
    lastRequestTime: 0,
    remaining: null,
    limit: 50,
    minDelay: 20, // ms — allows ~50 req/sec
  };

  function updateRateLimit(headers) {
    const limit =
      headers['x-ratelimit-limit-second'] ||
      headers['ratelimit-limit'] ||
      headers['x-ratelimit-limit'];
    const remaining =
      headers['x-ratelimit-remaining-second'] ||
      headers['ratelimit-remaining'] ||
      headers['x-ratelimit-remaining'];

    if (limit) rl.limit = parseInt(limit, 10);
    if (remaining != null) rl.remaining = parseInt(remaining, 10);
  }

  async function throttle() {
    const now = Date.now();
    let delay = rl.minDelay;

    if (rl.remaining !== null && rl.remaining < 10) {
      delay = Math.max(100, rl.minDelay * 5);
    } else if (rl.remaining !== null && rl.remaining < 20) {
      delay = rl.minDelay * 2;
    }

    const elapsed = now - rl.lastRequestTime;
    if (elapsed < delay) {
      await sleep(delay - elapsed);
    }
    rl.lastRequestTime = Date.now();
  }

  /**
   * Make one HTTP request to the PB API.
   * @param {string} method - HTTP method
   * @param {string} path - API path (relative or absolute)
   * @param {object} [body] - Request body
   * @returns {object} Parsed JSON response
   */
  async function pbFetch(method, path, body) {
    await throttle();

    const url = path.startsWith('http') ? path : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;

    const isV2 = path.includes('/v2/');
    const opts = {
      method: method.toUpperCase(),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(!isV2 && { 'X-Version': '1' }),
      },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    const allHeaders = Object.fromEntries(res.headers.entries());
    updateRateLimit(allHeaders);
    const xReqId = allHeaders['x-request-id'] || allHeaders['x-pb-request-id'] || allHeaders['request-id'];
    if (xReqId && method.toUpperCase() !== 'GET' && process.env.DEBUG_MODE === 'true') console.log(`[PB REQUEST ID] ${method.toUpperCase()} ${path} → ${xReqId}`);

    const text = await res.text();

    if (res.ok) {
      return text ? JSON.parse(text) : {};
    }

    const retryAfter = res.headers.get('retry-after');
    const err = new Error(`PB ${method.toUpperCase()} ${url} → ${res.status}: ${text}`);
    err.status = res.status;
    if (retryAfter) err.retryAfter = parseInt(retryAfter, 10);
    throw err;
  }

  /**
   * Call pbFetch with exponential backoff retry on 429/5xx.
   * @param {function} fn - Async function to retry
   * @param {string} label - Label for logging
   * @returns {*} Result of fn
   */
  async function withRetry(fn, label) {
    const maxAttempts = 6;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        return await fn();
      } catch (err) {
        const status = err.status || 0;
        const is429 = status === 429;
        const is5xx = status >= 500 && status < 600;
        const retryable = is429 || is5xx;

        if (!retryable || i === maxAttempts - 1) throw err;

        let delay;
        if (is429 && err.retryAfter) {
          delay = err.retryAfter * 1000;
          console.warn(`${label}: 429 rate limited, Retry-After: ${err.retryAfter}s`);
        } else {
          delay = Math.floor(Math.pow(2, i) * 250 + Math.random() * 200);
          console.warn(`${label}: ${status} error (attempt ${i + 1}), backoff ${delay}ms`);
        }
        await sleep(delay);
      }
    }
  }

  /**
   * Fetch all pages of a cursor-paginated v2 API endpoint.
   * Follows links.next (full URL) until null.
   * @param {string} path - Initial URL path or full URL
   * @param {string} [label] - Label for retry logging
   * @returns {Promise<object[]>} All items across all pages
   */
  async function fetchAllPages(path, label) {
    const items = [];
    let nextUrl = path;
    while (nextUrl) {
      const r = await withRetry(() => pbFetch('get', nextUrl), label || path);
      if (r.data?.length) items.push(...r.data);
      nextUrl = r.links?.next || null;
    }
    return items;
  }

  return { pbFetch, withRetry, fetchAllPages, rl };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch all pages from POST /v2/entities/search using cursor pagination.
 * Cursor is passed in the request body as body.data.pageCursor (confirmed pattern
 * from notes.js migration cache — same endpoint, same schema).
 *
 * @param {Function} pbFetch   - bound pbFetch from createClient
 * @param {Function} withRetry - bound withRetry from createClient
 * @param {object}   body      - base request body, e.g. { data: { filter: { type: ['company'] } } }
 * @param {string}   label     - label for retry logging
 * @returns {Promise<object[]>} all items across all pages
 */
async function fetchAllEntitiesPost(pbFetch, withRetry, body, label) {
  const items = [];
  let cursor = null;
  do {
    const url = cursor
      ? `/v2/entities/search?pageCursor=${encodeURIComponent(cursor)}`
      : '/v2/entities/search';
    const r = await withRetry(() => pbFetch('post', url, body), label);
    items.push(...(r.data || []));
    cursor = extractCursor(r.links?.next);
  } while (cursor);
  return items;
}

/**
 * Fetch all pages of an offset-paginated v1 API endpoint.
 * Stops when a page returns fewer items than the limit.
 * @param {Function} pbFetch   - bound pbFetch from createClient
 * @param {Function} withRetry - bound withRetry from createClient
 * @param {string}   basePath  - path without pagination params, e.g. '/users'
 * @param {Function} onPage    - callback(data: object[], pageIndex: number) called per page
 * @param {number}   [limit]   - page size (default 100)
 */
async function paginateOffset(pbFetch, withRetry, basePath, onPage, limit = 100) {
  let offset = 0;
  let pageIndex = 0;
  const sep = basePath.includes('?') ? '&' : '?';
  while (true) {
    const r = await withRetry(
      () => pbFetch('get', `${basePath}${sep}pageLimit=${limit}&pageOffset=${offset}`),
      `${basePath} offset ${offset}`
    );
    const data = r.data || [];
    if (!data.length) break;
    await onPage(data, pageIndex);
    if (data.length < limit) break;
    offset += limit;
    pageIndex++;
  }
}

// ---------------------------------------------------------------------------
// Team membership helpers — thin wrappers around fetchAllPages.
// Used by src/routes/teamMembership.js.
// memberActivity.js is NOT updated — it uses includeDisabled:true which differs.
// ---------------------------------------------------------------------------

/**
 * Fetch all teams in the workspace.
 * @param {{ fetchAllPages: Function }} client - from createClient()
 */
function listTeams(client) {
  return client.fetchAllPages('/v2/teams', 'list teams');
}

/**
 * Fetch all members in the workspace.
 * @param {{ fetchAllPages: Function }} client - from createClient()
 * @param {{ includeDisabled?: boolean, includeInvited?: boolean }} [opts]
 */
function listMembers(client, { includeDisabled = false, includeInvited = false } = {}) {
  return client.fetchAllPages(
    `/v2/members?includeDisabled=${includeDisabled}&includeInvited=${includeInvited}`,
    'list members'
  );
}

/**
 * Fetch all members of a team.
 * Returns TeamMemberResource objects with { id, fields: { name, email } }.
 * @param {{ fetchAllPages: Function }} client - from createClient()
 * @param {string} teamId
 */
function listTeamMembers(client, teamId) {
  return client.fetchAllPages(
    `/v2/teams/${teamId}/members`,
    `list team members ${teamId}`
  );
}

module.exports = { createClient, extractCursor, fetchAllEntitiesPost, paginateOffset, listTeams, listMembers, listTeamMembers };
