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
  // TODO: switch to a v2 endpoint once v2 entity responses include links.html
  // links.html is currently a v1-only field — try v1 endpoints until one returns a record
  const v1Paths = ['/features?pageLimit=1', '/components?pageLimit=1', '/products?pageLimit=1'];
  for (const path of v1Paths) {
    try {
      const response = await pbFetch('get', path);
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
