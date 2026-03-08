/**
 * Productboard API client
 * Ported from companiesMain.gs — preserves rate limiting, retry, and backoff logic.
 */

const BASE_US = 'https://api.productboard.com';
const BASE_EU = 'https://api.eu.productboard.com';

/**
 * Create a PB API client bound to a specific token and datacenter.
 * @param {string} token - Productboard API token
 * @param {boolean} useEu - Whether to use the EU datacenter
 * @returns {object} Client with fetch/retry methods and rate limiter state
 */
function createClient(token, useEu = false) {
  const baseUrl = useEu ? BASE_EU : BASE_US;

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

    const opts = {
      method: method.toUpperCase(),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Version': '1',
      },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    updateRateLimit(Object.fromEntries(res.headers.entries()));

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

module.exports = { createClient };
