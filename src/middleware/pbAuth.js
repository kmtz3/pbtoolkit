'use strict';
const { createClient } = require('../lib/pbClient');

/**
 * Express middleware: validates x-pb-token header and attaches pbClient to res.locals.
 *
 * Usage: router.post('/route', pbAuth, handler)
 * Access in handler: const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
 */
function pbAuth(req, res, next) {
  // Session token (OAuth path) takes priority; header token is the manual fallback.
  const token = req.session?.pbToken || req.headers['x-pb-token'];
  if (!token) return res.status(400).json({ error: 'Missing x-pb-token header' });
  const useEu = req.session?.useEu ?? (req.headers['x-pb-eu'] === 'true');
  res.locals.pbClient = createClient(token, useEu);
  next();
}

module.exports = { pbAuth };
