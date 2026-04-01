const express = require('express');
const { createClient } = require('../lib/pbClient');
const { parseApiError } = require('../lib/errorUtils');
const router = express.Router();

/**
 * POST /api/feedback
 *
 * Primary path: creates a Productboard v2 note (requires PB token via session or header).
 *   - Module → tag, plus a fixed "🐞 Bug report" tag
 *   - Email (optional) → matched as note user
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

  // ── Try Productboard note first (dedicated app-creator token) ──
  const pbToken = process.env.PB_FEEDBACK_TOKEN;
  if (pbToken) {
    const useEu = process.env.PB_FEEDBACK_EU === 'true';
    const { pbFetch, withRetry } = createClient(pbToken, useEu);

    try {
      const noteContent = buildNoteHtml({ module, description, expectedBehavior, stepsToReproduce, email: safeEmail });

      const fields = {
        name: `🐞 Bug Report — ${module}`,
        content: noteContent,
      };

      const payload = { data: { type: 'textNote', fields } };

      const result = await withRetry(() => pbFetch('post', '/v2/notes', payload), 'create feedback note');
      const noteId = result.id || result.data?.id;

      if (noteId) {
        // Add tags via v1 endpoint — POST /notes/{id}/tags/{name} auto-creates
        // tags that don't exist yet. No v2 tag creation endpoint exists.
        // TODO: switch to v2 when a tag creation endpoint becomes available.
        const tagNames = ['🐞 Bug report', module];
        for (const tag of tagNames) {
          try {
            await pbFetch('post', `/notes/${noteId}/tags/${encodeURIComponent(tag)}`);
          } catch (tagErr) {
            console.warn(`Failed to add tag "${tag}" to note ${noteId}:`, tagErr.message);
          }
        }

        // Link user by email via v1 PATCH — v2 relationships require a UUID,
        // but v1 accepts { email } and auto-matches to existing users/companies.
        if (safeEmail) {
          try {
            await pbFetch('patch', `/notes/${noteId}`, { data: { user: { email: safeEmail, name: safeEmail } } });
          } catch (userErr) {
            console.warn(`Failed to link user "${safeEmail}" to note ${noteId}:`, userErr.message);
          }
        }
      }

      return res.json({ ok: true, method: 'productboard' });
    } catch (err) {
      console.error('PB note creation failed:', parseApiError(err));
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
