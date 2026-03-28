'use strict';

const express = require('express');
const crypto  = require('crypto');

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function pbBaseUrl(useEu) {
  return useEu
    ? 'https://app.eu.productboard.com'
    : 'https://app.productboard.com';
}

/** Generate a base64url-encoded random string of `byteLength` bytes. */
function randomBase64url(byteLength) {
  return crypto.randomBytes(byteLength)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/** SHA-256 of a string, returned as base64url. */
function sha256Base64url(str) {
  return crypto.createHash('sha256')
    .update(str)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// ── GET /auth/pb — Initiate OAuth ─────────────────────────────────────────────

router.get('/pb', (req, res) => {
  const clientId    = process.env.PB_OAUTH_CLIENT_ID;
  const redirectUri = process.env.PB_OAUTH_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(503).send('OAuth is not configured on this server.');
  }

  const useEu = req.query.eu === 'true';

  // CSRF protection: random state stored in session
  const state = randomBase64url(16);

  // PKCE: code_verifier stored in session; code_challenge sent in URL
  const codeVerifier  = randomBase64url(32);
  const codeChallenge = sha256Base64url(codeVerifier);

  req.session.oauthState    = state;
  req.session.oauthVerifier = codeVerifier;
  req.session.useEu         = useEu;

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             clientId,
    redirect_uri:          redirectUri,
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });

  res.redirect(`${pbBaseUrl(useEu)}/oauth2/authorize?${params}`);
});

// ── GET /auth/pb/callback — Receive authorization code ────────────────────────

router.get('/pb/callback', async (req, res) => {
  const { code, state, error } = req.query;

  // Productboard sent an error (user denied, etc.)
  if (error) {
    return res.redirect(`/?error=${encodeURIComponent(error)}`);
  }

  // Validate state to prevent CSRF
  if (!state || state !== req.session.oauthState) {
    req.session.destroy(() => {});
    return res.redirect('/?error=invalid_state');
  }

  const clientId     = process.env.PB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.PB_OAUTH_CLIENT_SECRET;
  const redirectUri  = process.env.PB_OAUTH_REDIRECT_URI;
  const codeVerifier = req.session.oauthVerifier;
  const useEu        = req.session.useEu ?? false;

  // Clear one-time OAuth session values
  delete req.session.oauthState;
  delete req.session.oauthVerifier;

  try {
    const tokenRes = await fetch(`${pbBaseUrl(useEu)}/oauth2/token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
        client_id:     clientId,
        client_secret: clientSecret,
        code_verifier: codeVerifier,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error('OAuth token exchange failed:', tokenRes.status, body);
      return res.redirect('/?error=oauth_failed');
    }

    const { access_token } = await tokenRes.json();

    if (!access_token) {
      return res.redirect('/?error=oauth_failed');
    }

    // Store token in session — this is the only place the token lives
    req.session.pbToken = access_token;
    // useEu already set on session from the initiation step

    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ── POST /auth/pb/disconnect — Destroy OAuth session ─────────────────────────

router.post('/pb/disconnect', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Session destroy error:', err.message);
    res.json({ ok: true });
  });
});

module.exports = router;
