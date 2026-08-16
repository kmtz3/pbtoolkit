const express = require('express');
const { createClient } = require('../lib/pbClient');
const { parseApiError } = require('../lib/errorUtils');
const { buildEmailToIdMap } = require('../lib/userCache');
const { fetchFieldValues, createFieldValue } = require('../lib/fieldValues');
const router = express.Router();

/**
 * POST /api/feedback
 *
 * Primary path: creates a Productboard v2 note (requires PB token via session or header).
 *   - Module → tag, plus a fixed "🐞 Bug report" tag (created as field values if new, then
 *     set atomically on note create)
 *   - Email (optional) → resolved to a v2 user entity (created if not found), linked via
 *     the note's create-time relationships array
 *   - Report fields → formatted HTML content
 *
 * Fallback: sends via Brevo transactional email if no PB token is available.
 */
router.post('/', async (req, res) => {
  const { email, module, description, expectedBehavior, stepsToReproduce } = req.body;

  // ── Validation ──
  if (!module || !description?.trim() || !expectedBehavior?.trim()) {
    return res.status(400).json({ error: 'Module, description, and expected behavior are required.' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  const safeEmail = email ? email.replace(/[\r\n]/g, '').trim() : null;
  const issueUrl = process.env.ISSUE_URL ? String(process.env.ISSUE_URL).trim() : null;

  // ── Try Productboard note first (dedicated app-creator token) ──
  const pbToken = process.env.PB_FEEDBACK_TOKEN;
  if (pbToken) {
    const useEu = process.env.PB_FEEDBACK_EU === 'true';
    const { pbFetch, withRetry, fetchAllPages } = createClient(pbToken, useEu);

    try {
      const noteContent = buildNoteHtml({ module, description, expectedBehavior, stepsToReproduce, email: safeEmail });

      // Tags are a shared field-value resource (field id "tags") — a note create
      // fails with selectOption.notFound if a tag name doesn't already exist as a
      // value, so look up/create both tag values before creating the note.
      const tagNames = ['🐞 Bug report', module];
      const tagCache = await fetchFieldValues('tags', pbFetch, withRetry).catch(() => new Map());
      const resolvedTags = [];
      for (const name of tagNames) {
        const key = name.toLowerCase().trim();
        if (!tagCache.has(key)) {
          try {
            const created = await createFieldValue('tags', name, pbFetch, withRetry);
            tagCache.set(key, created);
          } catch (tagErr) {
            console.warn(`Failed to create tag "${name}":`, tagErr.message);
            continue;
          }
        }
        resolvedTags.push({ name: tagCache.get(key).name });
      }

      const fields = {
        name: `🐞 Bug Report — ${module}`,
        content: noteContent,
      };
      if (resolvedTags.length) fields.tags = resolvedTags;

      // Resolve the reporter's email to a v2 user entity, creating one if it
      // doesn't exist yet — v2 relationships need a UUID, not a bare email.
      let customerRel = null;
      if (safeEmail) {
        try {
          const emailToId = await buildEmailToIdMap(fetchAllPages, 'fetch users for feedback note');
          let userId = emailToId[safeEmail.toLowerCase()];
          if (!userId) {
            const created = await withRetry(
              () => pbFetch('post', '/v2/entities', { data: { type: 'user', fields: { email: safeEmail, name: safeEmail } } }),
              `create user ${safeEmail}`
            );
            userId = created.data?.id || created.id;
          }
          if (userId) customerRel = { type: 'customer', target: { id: userId, type: 'user' } };
        } catch (userErr) {
          console.warn(`Failed to resolve user "${safeEmail}" for feedback note:`, userErr.message);
        }
      }

      // A user entity created moments ago can briefly 404 when referenced in a note's
      // relationships — retry with backoff, then fall back to creating without the
      // customer link rather than losing the whole report.
      let noteId = null;
      let currentCustomerRel = customerRel;
      let propagationRetries = 0;
      while (noteId === null) {
        const payload = { data: { type: 'textNote', fields } };
        if (currentCustomerRel) payload.data.relationships = [currentCustomerRel];
        try {
          const result = await withRetry(() => pbFetch('post', '/v2/notes', payload), 'create feedback note');
          noteId = result.id || result.data?.id;
          if (!noteId) throw new Error('API did not return a note ID');
        } catch (err) {
          if (currentCustomerRel && /not found/i.test(String(err.message || ''))) {
            if (propagationRetries < 3) {
              propagationRetries++;
              await new Promise((r) => setTimeout(r, 1500 * propagationRetries));
              continue;
            }
            currentCustomerRel = null; // give up on the customer link, try once more without it
            continue;
          }
          throw err;
        }
      }

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
});

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
