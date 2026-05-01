/**
 * GET /api/validate
 * Lightweight token validation — hits a v2 endpoint to confirm the token is accepted.
 * Returns { ok: true } on success, or a clear status-specific error message on failure.
 *
 * Headers:
 *   x-pb-token:    Productboard API token (required)
 *   x-pb-eu:       "true" to use EU datacenter (optional)
 */
const express = require('express');
const { pbAuth } = require('../middleware/pbAuth');

const router = express.Router();

router.get('/', pbAuth, async (req, res) => {
  const { pbFetch } = res.locals.pbClient;
  try {
    await pbFetch('get', '/v2/entities/configurations/product');
    res.json({ ok: true });
  } catch (err) {
    const status = err.status || 500;
    const message =
      status === 401 ? 'Invalid token — check that you copied it correctly.' :
      status === 403 ? 'Token does not have permission to access this workspace.' :
                       'Could not reach Productboard API — please try again.';
    res.status(status).json({ error: message });
  }
});

router.get('/space-name', pbAuth, async (req, res) => {
  const { pbFetch } = res.locals.pbClient;
  // v2 entities now include links.html (added 2026-04-30) — use GET /v2/entities directly
  const v2Types = ['feature', 'component', 'product'];
  for (const type of v2Types) {
    try {
      const response = await pbFetch('get', `/v2/entities?type[]=${type}`);
      const htmlLink = response.data?.[0]?.links?.html;
      if (htmlLink) {
        let spaceName = null;
        try { spaceName = new URL(htmlLink).hostname.split('.')[0]; } catch (_) {}
        return res.json({ spaceName });
      }
    } catch (_) {}
  }
  res.json({ spaceName: null });
});

module.exports = router;
