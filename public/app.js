/* =========================================================
   PBToolkit — frontend (shared utilities)
   ========================================================= */

// ── App config (feedback/issue URLs from env) ───────────────
async function loadAppConfig() {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    const fbBtn    = document.getElementById('btn-share-feedback');
    const issueBtn = document.getElementById('btn-report-issue');
    if (cfg.feedbackUrl) {
      fbBtn.href             = cfg.feedbackUrl;
      fbBtn.target           = '_blank';
      fbBtn.rel              = 'noopener';
      fbBtn.style.display    = 'inline-flex';
    }
    if (cfg.issueUrl) {
      issueBtn.href          = cfg.issueUrl;
      issueBtn.style.display = 'inline-flex';
    }
  } catch (_) {
    // leave both hidden
  }
}
loadAppConfig();

// ── Session state ──────────────────────────────────────────
const SESSION_KEY = 'pb_token';
const EU_KEY      = 'pb_eu';

let token  = sessionStorage.getItem(SESSION_KEY) || '';
let useEu  = sessionStorage.getItem(EU_KEY) === 'true';

// ── DOM helpers ────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const show  = (id) => $(id).classList.remove('hidden');
const hide  = (id) => $(id).classList.add('hidden');
const setText = (id, t) => { $(id).textContent = t; };

// ── Screen management ───────────────────────────────────────
// Screens: 'home' | 'tool'

function showScreen(screen) {
  hide('home-view');
  hide('tool-view');
  hide('topbar-breadcrumb');

  if (screen === 'home') {
    show('home-view');
    updateConnectionStatus();
  } else if (screen === 'tool') {
    show('tool-view');
    show('topbar-breadcrumb');
    updateConnectionStatus();
  }
}

function updateConnectionStatus() {
  const connected = Boolean(token);
  const dot = $('conn-dot');
  dot.classList.toggle('conn-dot--connected', connected);
  dot.classList.toggle('conn-dot--disconnected', !connected);
  setText('conn-label', connected ? 'Connected' : 'Not connected');
  $('btn-disconnect').classList.toggle('hidden', !connected);
  $('btn-connect').classList.toggle('hidden', connected);
  updateDcToggle();
  const inTool = $('tool-view') && !$('tool-view').classList.contains('hidden');
  $('token-warning-banner').classList.toggle('hidden', connected || !inTool);
}

function updateDcToggle() {
  $('dc-us').classList.toggle('active', !useEu);
  $('dc-eu').classList.toggle('active', useEu);
}

// ── Boot ───────────────────────────────────────────────────
function boot() {
  showScreen('home');
  updateConnectionStatus();
}

// ── "PB Tools" home button ─────────────────────────────────
$('btn-home').addEventListener('click', () => showScreen('home'));
$('btn-back-home').addEventListener('click', () => showScreen('home'));

// ── DC toggle ──────────────────────────────────────────────
$('dc-us').addEventListener('click', () => switchDatacenter(false));
$('dc-eu').addEventListener('click', () => switchDatacenter(true));

function switchDatacenter(newEu) {
  if (newEu === useEu) return;
  const label = newEu ? 'EU' : 'US';
  if (token) {
    if (!confirm(`Switching to the ${label} datacenter requires re-authentication (tokens are region-bound). Continue?`)) return;
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(EU_KEY);
    token = '';
    useEu = newEu;
    updateConnectionStatus();
    openConnectModal();
  } else {
    useEu = newEu;
    sessionStorage.setItem(EU_KEY, String(useEu));
    updateDcToggle();
  }
}

// ── Partial loader ──────────────────────────────────────────
const _loadedPartials = new Set();

async function loadPartial(toolName) {
  if (_loadedPartials.has(toolName)) return;
  const res = await fetch(`/views/${toolName}.html`);
  if (!res.ok) throw new Error(`Failed to load view: ${toolName} (${res.status})`);
  const html = await res.text();
  $('view-area').insertAdjacentHTML('beforeend', html);
  _loadedPartials.add(toolName);
}

// ── Tool cards ─────────────────────────────────────────────
document.querySelectorAll('.tool-card:not(.tool-card-soon)').forEach((card) => {
  card.addEventListener('click', () => {
    const tool = card.dataset.tool;
    if (tool) loadTool(tool);
  });
});

async function loadTool(toolName) {
  const names = { companies: 'Companies', notes: 'Notes', entities: 'Entities', 'member-activity': 'Member Activity', 'team-membership': 'Team Membership' };
  setText('topbar-tool-name', names[toolName] || toolName);
  showScreen('tool');

  // Show the correct sidebar section
  $('sidebar-companies').classList.toggle('hidden', toolName !== 'companies');
  $('sidebar-notes').classList.toggle('hidden', toolName !== 'notes');
  $('sidebar-entities').classList.toggle('hidden', toolName !== 'entities');
  $('sidebar-member-activity').classList.toggle('hidden', toolName !== 'member-activity');
  $('sidebar-team-membership').classList.toggle('hidden', toolName !== 'team-membership');

  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));

  try {
    await loadPartial(toolName);
  } catch (e) {
    console.error('Failed to load view partial:', e);
    return;
  }

  if (toolName === 'companies') {
    $('nav-export').classList.add('active');
    showView('export');
    window.initCompaniesModule?.();
  }

  if (toolName === 'notes') {
    $('nav-notes-export').classList.add('active');
    showView('notes-export');
    window.initNotesModule?.();
  }

  if (toolName === 'entities') {
    $('nav-entities-templates').classList.add('active');
    showView('entities-templates');
    window.initEntitiesModule?.();
  }

  if (toolName === 'member-activity') {
    $('nav-member-activity-export').classList.add('active');
    showView('member-activity-export');
    if (typeof initMemberActivityModule === 'function') initMemberActivityModule();
  }

  if (toolName === 'team-membership') {
    $('nav-team-membership-export').classList.add('active');
    showView('team-membership-export');
    if (typeof window.initTeamMembershipModule === 'function') window.initTeamMembershipModule();
  }

  updateConnectionStatus();
}

// ── Connect modal ───────────────────────────────────────────
function openConnectModal() {
  $('auth-token').value = '';
  $('auth-submit').disabled = false;
  hide('auth-error');
  $('auth-eu').checked = useEu;
  show('auth-screen');
}

function closeConnectModal() {
  hide('auth-screen');
}

// Stores a callback that was deferred because no token was connected.
// Fired automatically after the user successfully submits the auth modal.
let _pendingTokenCallback = null;

function requireToken(callback) {
  if (token) { callback(); }
  else { _pendingTokenCallback = callback; openConnectModal(); }
}

$('btn-connect').addEventListener('click', () => openConnectModal());
$('btn-close-connect-modal').addEventListener('click', closeConnectModal);
$('btn-connect-from-tool').addEventListener('click', () => openConnectModal());
$('auth-screen').addEventListener('click', (e) => { if (e.target === $('auth-screen')) closeConnectModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('auth-screen').classList.contains('hidden')) closeConnectModal();
});

$('auth-submit').addEventListener('click', async () => {
  const t = $('auth-token').value.trim();
  const eu = $('auth-eu').checked;
  if (!t) return;

  $('auth-submit').disabled = true;
  hide('auth-error');

  // Quick validation: try fetching custom fields with the token
  try {
    const res = await fetch('/api/validate', {
      headers: buildHeaders(t, eu),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      showAuthError(err.error || `Authentication failed (${res.status})`);
      return;
    }
    // Token works — save and update status
    token = t;
    useEu = eu;
    sessionStorage.setItem(SESSION_KEY, token);
    sessionStorage.setItem(EU_KEY, String(useEu));
    hide('auth-screen');
    updateConnectionStatus();
    // Fire any callback that was deferred because there was no token
    // (e.g. entities file upload triggering entLoadConfigs → entUpdatePanelVisibility)
    if (_pendingTokenCallback) {
      const cb = _pendingTokenCallback;
      _pendingTokenCallback = null;
      cb();
    }
    // If the member activity module loaded before a token was set, reload now
    if (typeof window.maReloadIfNeeded === 'function') window.maReloadIfNeeded();
    // If the team membership module loaded before a token was set, reload now
    if (typeof window.tmReloadIfNeeded === 'function') window.tmReloadIfNeeded();
    // If the companies mapper is open and custom fields failed to load (no token), reload them now
    if (typeof parsedCSV !== 'undefined' && parsedCSV && $('import-step-map') && !$('import-step-map').classList.contains('hidden')) {
      loadAndBuildCustomFieldTable();
    }
  } catch (e) {
    showAuthError('Could not connect. Check your network and token.');
  } finally {
    $('auth-submit').disabled = false;
  }
});

$('auth-token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('auth-submit').click();
});

function showAuthError(msg) {
  setText('auth-error-msg', msg);
  show('auth-error');
}

// ── Disconnect ─────────────────────────────────────────────
$('btn-disconnect').addEventListener('click', () => {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(EU_KEY);
  token = '';
  useEu = false;
  updateConnectionStatus();
  resetCompaniesState();
  resetNotesState();
  window.dispatchEvent(new CustomEvent('pb:disconnect'));
});

// ── Tool nav (inside tool view) ─────────────────────────────
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    showView(btn.dataset.view);
  });
});

function showView(view) {
  [
    'export', 'import',
    'companies-delete-csv', 'companies-delete-all', 'companies-source-migration',
    'notes-export', 'notes-import', 'notes-delete-csv', 'notes-delete-all', 'notes-migrate',
    'entities-templates', 'entities-export', 'entities-import', 'entities-delete',
    'member-activity-export',
    'team-membership-export', 'team-membership-import',
  ].forEach((v) => {
    const el = $(`view-${v}`);
    if (el) el.classList.toggle('hidden', v !== view);
  });
  updateConnectionStatus();
}

// ── Helpers ─────────────────────────────────────────────────
function buildHeaders(t = token, eu = useEu) {
  const h = { 'Content-Type': 'application/json', 'x-pb-token': t };
  if (eu) h['x-pb-eu'] = 'true';
  return h;
}

function subscribeSSE(url, body, { onProgress, onComplete, onError, onLog = null, onAbort = null }) {
  // SSE over POST: read the response body as a stream and parse SSE frames manually
  const ctrl = new AbortController();

  fetch(url, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).then(async (res) => {
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      onError(err.error || `Request failed (${res.status})`);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const parts = buf.split('\n\n');
      buf = parts.pop(); // keep incomplete last part

      for (const part of parts) {
        const lines = part.split('\n');
        let eventType = 'message';
        let dataLine = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim();
          if (line.startsWith('data: '))  dataLine  = line.slice(6).trim();
        }
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine);
          if (eventType === 'progress')       onProgress(data);
          else if (eventType === 'complete')  onComplete(data);
          else if (eventType === 'error')     onError(data.message);
          else if (eventType === 'log' && onLog) onLog(data);
        } catch (_) {}
      }
    }
  }).catch((e) => {
    if (e.name === 'AbortError') {
      if (onAbort) onAbort();
    } else {
      onError(e.message);
    }
  });

  return ctrl;
}

// ── Escape HTML ─────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Download helpers ─────────────────────────────────────────
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * downloadLogCsv(appender, filenamePrefix)
 *
 * Generates a CSV from the appender's captured log buffer and triggers a download.
 * Columns: timestamp, level, row_num, uuid, entity_type, message
 */
function downloadLogCsv(appender, filenamePrefix) {
  const COLS = ['timestamp', 'level', 'row_num', 'uuid', 'entity_type', 'message'];
  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }
  const rows = appender.getRows();
  const lines = [COLS.join(',')].concat(rows.map(r => COLS.map(c => csvCell(r[c])).join(',')));
  const csv = lines.join('\n');
  const date = new Date().toISOString().slice(0, 10);
  triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${filenamePrefix}-log-${date}.csv`);
}

// ══════════════════════════════════════════════════════════
// SHARED IMPORT UTILITIES
// Used by all three import modules: companies, notes, entities.
// entities-app.js also calls these since both scripts share the
// same page scope and app.js loads first.
// ══════════════════════════════════════════════════════════

/**
 * makeLogAppender(logId, entriesId, countsId) → append(entry)
 *
 * Factory that returns a per-module log append function bound to
 * specific DOM element IDs. Call once at startup per module.
 *
 * append({ level, message, detail, ts })
 *   level   – 'success' | 'error' | 'warn' | 'info'
 *   message – plain-text row description
 *   detail  – optional hover tooltip string
 *   ts      – ISO timestamp string (from SSE); falls back to now
 *
 * CSS: .log-entry.success/.error/.warn/.info + .log-ts/.log-msg/.log-detail
 */
function makeLogAppender(logId, entriesId, countsId, defaultEntityType = '') {
  const counts = { success: 0, error: 0, warn: 0, info: 0 };
  const _buffer = []; // captured records for CSV download

  function append({ level, message, detail, ts } = {}) {
    const logEl     = document.getElementById(logId);
    const entriesEl = document.getElementById(entriesId);
    const countsEl  = countsId ? document.getElementById(countsId) : null;
    if (!logEl || !entriesEl) return;

    logEl.classList.remove('hidden');

    if (counts[level] !== undefined) counts[level]++;
    if (countsEl) {
      const parts = [];
      if (counts.success) parts.push(`<span style="color:#34d399">${counts.success} ok</span>`);
      if (counts.error)   parts.push(`<span style="color:#f87171">${counts.error} err</span>`);
      if (counts.warn)    parts.push(`<span style="color:#fbbf24">${counts.warn} warn</span>`);
      countsEl.innerHTML = parts.join(' · ');
    }

    const time = ts
      ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // For plain-string detail: show as tooltip span (legacy behaviour).
    // For structured objects: show the uuid as a small muted suffix if present.
    const detailStr   = detail && typeof detail !== 'object' ? String(detail) : null;
    const detailUuid  = detail && typeof detail === 'object' ? detail.uuid : null;

    const div = document.createElement('div');
    div.className = `log-entry ${level}`;
    div.innerHTML = `
      <span class="log-ts">${esc(time)}</span>
      <span class="log-msg">${esc(message)}</span>
      ${detailStr  ? `<span class="log-detail" title="${esc(detailStr)}">${esc(detailStr)}</span>` : ''}
      ${detailUuid ? `<span class="log-detail">${esc(detailUuid)}</span>` : ''}
    `;
    entriesEl.appendChild(div);
    entriesEl.scrollTop = entriesEl.scrollHeight;

    // Capture structured record for CSV download.
    _buffer.push({
      timestamp:   ts || new Date().toISOString(),
      level:       level || 'info',
      row_num:     (detail && typeof detail === 'object' ? detail.row : undefined) ?? '',
      uuid:        (detail && typeof detail === 'object' ? detail.uuid : undefined) ?? '',
      entity_type: (detail && typeof detail === 'object' ? detail.entityType : undefined) ?? defaultEntityType,
      message:     message || '',
    });
  }

  // getCounts() — returns a snapshot of processed row counts.
  // Used by stop handlers to render accurate stopped-summary alerts.
  append.getCounts = () => ({ ...counts });

  // getRows() — returns a copy of captured log records for CSV download.
  append.getRows = () => [..._buffer];

  // reset() — clears counts, log entries, and buffer for a fresh run.
  append.reset = () => {
    counts.success = 0; counts.error = 0; counts.warn = 0; counts.info = 0;
    _buffer.length = 0;
    const entriesEl = document.getElementById(entriesId);
    const countsEl  = countsId ? document.getElementById(countsId) : null;
    const logEl     = document.getElementById(logId);
    if (entriesEl) entriesEl.innerHTML = '';
    if (countsEl)  countsEl.innerHTML  = '';
    if (logEl)     logEl.classList.add('hidden');
  };

  return append;
}

/**
 * renderImportComplete(el, opts)
 *
 * Renders a styled summary alert into el, followed by optional
 * extraHtml (e.g. per-entity table for entities module).
 *
 * opts:
 *   created   – number of created records
 *   updated   – number of updated records
 *   errors    – number of error rows
 *   stopped   – boolean; true when user aborted
 *   extraText – optional suffix appended to the summary line
 *               (e.g. "· 3 parent links · 2 connected links")
 *   extraHtml – optional HTML string appended below the alert
 *               (e.g. per-entity breakdown table)
 *
 * Uses .alert-ok (zero errors, not stopped) or .alert-warn.
 * Icons: ✅ ok · ⚠️ errors · ⏹ stopped
 */
function renderImportComplete(el, { created = 0, updated = 0, errors = 0, stopped = false, extraText = '', extraHtml = '' } = {}) {
  const hasErrors  = errors > 0;
  const alertClass = (stopped || hasErrors) ? 'alert-warn' : 'alert-ok';
  const icon       = stopped ? '⏹' : hasErrors ? '⚠️' : '✅';
  const status     = stopped ? 'Import stopped' : 'Import complete';
  const summary    = `${created} created · ${updated} updated · ${errors} error(s)${extraText ? ' · ' + extraText : ''}`;

  el.innerHTML = `
    <div class="alert ${alertClass}">
      <span class="alert-icon">${icon}</span>
      <span>${status} — ${summary}</span>
    </div>
    ${extraHtml}
  `;
  el.classList.remove('hidden');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Run ─────────────────────────────────────────────────────
boot();
