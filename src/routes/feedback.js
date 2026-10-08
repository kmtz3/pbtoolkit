const express = require('express');
const fs = require('fs');
const path = require('path');
const { rateLimit, MemoryStore, ipKeyGenerator } = require('express-rate-limit');
const { createClient } = require('../lib/pbClient');
const { parseApiError } = require('../lib/errorUtils');
const { fetchFieldValues } = require('../lib/fieldValues');
const { resolveTags, createNoteV2 } = require('../lib/noteWrite');
const router = express.Router();

// ── Input limits ──────────────────────────────────────────────────────────────
const MAX_MODULE_LEN = 100;
const MAX_TEXT_LEN   = 10000;
const MAX_EMAIL_LEN  = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Module allowlist ─────────────────────────────────────────────────────────
// The Report Issue form (public/app.js) populates its module <select> from the
// active tool-card names in index.html plus "Authentication" and "General Issue".
// Derive the same list at startup so renaming a card doesn't need a server change;
// the static list is the fallback if index.html can't be read. Anything not on the
// list is mapped to "Other" (not rejected) so the form never hard-fails.
const FALLBACK_MODULE = 'Other';
const STATIC_MODULES = [
  'Entities', 'Notes', 'Companies & Users', 'Member Activity', 'Teams & Members',
  'Merge Duplicate Notes', 'Merge Duplicate Companies', 'Manage Values',
  'Authentication', 'General Issue', FALLBACK_MODULE,
];

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function loadModuleAllowlist() {
  const names = new Set(STATIC_MODULES.map((n) => n.toLowerCase()));
  const canonical = new Map(STATIC_MODULES.map((n) => [n.toLowerCase(), n]));
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
    const re = /class="tool-card-name"[^>]*>([^<]{1,100})</g;
    let m;
    while ((m = re.exec(html))) {
      const name = decodeHtmlEntities(m[1]).trim();
      if (name) { names.add(name.toLowerCase()); canonical.set(name.toLowerCase(), name); }
    }
  } catch (_) { /* fall back to the static list */ }
  return { names, canonical };
}
const MODULE_ALLOWLIST = loadModuleAllowlist();

function normalizeModule(module) {
  const key = module.trim().toLowerCase();
  return MODULE_ALLOWLIST.names.has(key) ? MODULE_ALLOWLIST.canonical.get(key) : FALLBACK_MODULE;
}

// ── Rate limit ───────────────────────────────────────────────────────────────
// Unauthenticated endpoint backed by a server-side token — keep it tight.
// Applies in every environment (including localhost/test) so it can be tested;
// FEEDBACK_RATE_LIMIT_MAX overrides the default of 5 per hour per IP.
const feedbackRateStore = new MemoryStore();
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: Number(process.env.FEEDBACK_RATE_LIMIT_MAX) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: feedbackRateStore,
  keyGenerator: (req) => ipKeyGenerator(req.ip || ''),
  message: { error: 'Too many reports from this address. Please try again later.' },
});

/**
 * Validate the request body. Returns { error } or { value }.
 * Every field must be a string (or absent where optional) and within length caps.
 */
function validateFeedbackBody(body) {
  const { email, module, description, expectedBehavior, stepsToReproduce } = body || {};
  const isOptStr = (v) => v === undefined || v === null || typeof v === 'string';

  if (typeof module !== 'string' || typeof description !== 'string' || typeof expectedBehavior !== 'string'
      || !isOptStr(stepsToReproduce) || !isOptStr(email)) {
    return { error: 'Module, description, and expected behavior are required and all fields must be text.' };
  }
  if (!module.trim() || !description.trim() || !expectedBehavior.trim()) {
    return { error: 'Module, description, and expected behavior are required.' };
  }
  if (module.length > MAX_MODULE_LEN) {
    return { error: `Module must be at most ${MAX_MODULE_LEN} characters.` };
  }
  for (const [label, v] of [['Description', description], ['Expected behavior', expectedBehavior], ['Steps to reproduce', stepsToReproduce]]) {
    if (typeof v === 'string' && v.length > MAX_TEXT_LEN) {
      return { error: `${label} must be at most ${MAX_TEXT_LEN.toLocaleString('en-US')} characters.` };
    }
  }
  const safeEmail = email ? email.replace(/[\r\n]/g, '').trim() : null;
  if (safeEmail && (safeEmail.length > MAX_EMAIL_LEN || !EMAIL_RE.test(safeEmail))) {
    return { error: 'Invalid email address.' };
  }

  return {
    value: {
      email: safeEmail || null,
      module: normalizeModule(module),
      description,
      expectedBehavior,
      stepsToReproduce: typeof stepsToReproduce === 'string' ? stepsToReproduce : undefined,
    },
  };
}

/**
 * POST /api/feedback
 *
 * Unauthenticated. Rate-limited per IP (default 5/hour) and body-size capped (100kb).
 *
 * Primary path: creates a Productboard v2 note using the server's PB_FEEDBACK_TOKEN.
 *   - Module (allowlisted, unknown → "Other") → tag, plus a fixed "🐞 Bug report" tag
 *     (created as field values if new, then set atomically on note create)
 *   - Email (optional) → included in the note body only. It is NOT resolved to or
 *     created as a PB user: v2 has no targeted user-by-email lookup, and creating
 *     user entities from anonymous input would let anyone pollute the workspace.
 *   - Report fields → formatted HTML content
 *
 * Fallback: sends via Brevo transactional email if no PB token is available.
 */
// Body size is capped at 100kb by the dedicated parser mounted in server.js.
router.post('/', feedbackLimiter, async (req, res) => {
  try {
    await handleFeedback(req, res);
  } catch (err) {
    console.error('feedback: unexpected error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
  }
});

async function handleFeedback(req, res) {
  const { error: validationError, value } = validateFeedbackBody(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  const { email: safeEmail, module, description, expectedBehavior, stepsToReproduce } = value;

  const issueUrl = process.env.ISSUE_URL ? String(process.env.ISSUE_URL).trim() : null;

  // ── Try Productboard note first (dedicated app-creator token) ──
  const pbToken = process.env.PB_FEEDBACK_TOKEN;
  if (pbToken) {
    const useEu = process.env.PB_FEEDBACK_EU === 'true';
    const { pbFetch, withRetry } = createClient(pbToken, useEu);

    try {
      const noteContent = buildNoteHtml({ module, description, expectedBehavior, stepsToReproduce, email: safeEmail });

      // Tags are a shared field-value resource (field id "tags") — a note create
      // fails with selectOption.notFound if a tag name doesn't already exist as a
      // value, so look up/create both tag values before creating the note.
      const tagCache = await fetchFieldValues('tags', pbFetch, withRetry).catch(() => new Map());
      const { tags: resolvedTags, failures } = await resolveTags(pbFetch, withRetry, tagCache, ['🐞 Bug report', module]);
      for (const f of failures) console.warn(`Failed to create tag "${f.name}":`, f.error);

      const fields = {
        name: `🐞 Bug Report — ${module}`,
        content: noteContent,
      };
      if (resolvedTags.length) fields.tags = resolvedTags;

      // No customer relationship (see header) — createNoteV2's propagation retry
      // is therefore inactive here, but the shared helper keeps behaviour aligned
      // with the notes import path.
      await createNoteV2(pbFetch, withRetry, { type: 'textNote', fields, label: 'create feedback note' });

      return res.json({ ok: true, method: 'productboard' });
    } catch (err) {
      console.error('PB note creation failed:', parseApiError(err));
      const hasBrevoFallback = !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL && process.env.FEEDBACK_RECIPIENT_EMAIL);
      if (!hasBrevoFallback) {
        if (issueUrl) {
          return res.status(503).json({
            error: 'Automatic report submission is temporarily unavailable. Please submit your issue using the fallback link.',
            fallbackUrl: issueUrl,
          });
        }
        return res.status(503).json({
          error: 'Automatic report submission is temporarily unavailable. Please try again later.',
        });
      }
      // Fall through to Brevo
    }
  }

  // ── Fallback: Brevo email ──
  const apiKey    = process.env.BREVO_API_KEY;
  const sender    = process.env.BREVO_SENDER_EMAIL;
  const recipient = process.env.FEEDBACK_RECIPIENT_EMAIL;

  if (!apiKey || !sender || !recipient) {
    return res.status(503).json({ error: 'Feedback service is not configured.' });
  }

  const htmlBody = buildEmailHtml({ module, description, expectedBehavior, stepsToReproduce, email: safeEmail });

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'accept':       'application/json',
        'content-type': 'application/json',
        'api-key':      apiKey,
      },
      body: JSON.stringify({
        sender:  { name: 'PBToolkit', email: sender },
        to:      [{ email: recipient }],
        replyTo: safeEmail ? { email: safeEmail } : undefined,
        subject: `Bug Report — ${module}`,
        htmlContent: htmlBody,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Brevo API error:', response.status, err);
      return res.status(502).json({ error: 'Failed to send report. Please try again later.' });
    }

    res.json({ ok: true, method: 'email' });
  } catch (err) {
    console.error('Brevo request failed:', err.message);
    res.status(502).json({ error: 'Failed to send report. Please try again later.' });
  }
}

// ── HTML builders ──

function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nl2br(str) {
  return esc(str).replace(/\n/g, '<br>');
}

/**
 * HTML content for the Productboard note.
 * Clean, readable format that works well in PB's note viewer.
 */
function buildNoteHtml({ module, description, expectedBehavior, stepsToReproduce, email }) {
  const parts = [];
  if (email) {
    parts.push(`<p><b>From:</b> ${esc(email)}</p>`);
  }
  parts.push(`<p><b>Module:</b> ${esc(module)}</p>`);
  parts.push(`<hr>`);
  parts.push(`<h2><b>Description</b></h2>`);
  parts.push(`<p>${nl2br(description)}</p>`);
  parts.push(`<h2><b>Expected Behavior</b></h2>`);
  parts.push(`<p>${nl2br(expectedBehavior)}</p>`);
  if (stepsToReproduce?.trim()) {
    parts.push(`<h2><b>Steps to Reproduce</b></h2>`);
    parts.push(`<p>${nl2br(stepsToReproduce)}</p>`);
  }
  return parts.join('\n');
}

/**
 * HTML email body for Brevo fallback.
 */
function buildEmailHtml({ module, description, expectedBehavior, stepsToReproduce, email }) {
  // Uses semantic HTML (h3, strong, p, hr) so it renders well in both
  // email clients and PB's note viewer (which strips inline styles).
  const parts = [];
  if (email) {
    parts.push(`<p><b>From:</b> <a href="mailto:${esc(email)}">${esc(email)}</a></p>`);
  }
  parts.push(`<p><b>Module:</b> ${esc(module)}</p>`);
  parts.push(`<hr>`);
  parts.push(`<h2><b>Description</b></h2>`);
  parts.push(`<p>${nl2br(description)}</p>`);
  parts.push(`<h2><b>Expected Behavior</b></h2>`);
  parts.push(`<p>${nl2br(expectedBehavior)}</p>`);
  if (stepsToReproduce?.trim()) {
    parts.push(`<h2><b>Steps to Reproduce</b></h2>`);
    parts.push(`<p>${nl2br(stepsToReproduce)}</p>`);
  }
  const body = parts.join('\n');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:system-ui,sans-serif;color:#111827;background:#f9fafb;">
  <div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
    <div style="padding:24px;">
      ${body}
    </div>
    <div style="padding:12px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
      Sent from PBToolkit Report Issue form
    </div>
  </div>
</body></html>`;
}

module.exports = router;
// Exposed for tests
module.exports._feedbackRateStore = feedbackRateStore;
module.exports.validateFeedbackBody = validateFeedbackBody;
