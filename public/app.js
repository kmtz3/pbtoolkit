/* =========================================================
   PBToolkit — frontend (shared utilities)
   ========================================================= */

// ── App config (feedback/issue URLs from env) ───────────────
async function loadAppConfig() {
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    if (cfg.version) document.getElementById('app-version').textContent = ` \u00b7 v${cfg.version}`;
    const fbBtn    = document.getElementById('btn-share-feedback');
    const issueBtn = document.getElementById('btn-report-issue');
    if (cfg.feedbackUrl) {
      fbBtn.href             = cfg.feedbackUrl;
      fbBtn.target           = '_blank';
      fbBtn.rel              = 'noopener';
      fbBtn.style.display    = 'inline-flex';
    }
    // Report Issue: modal if feedback service is configured, else fall back to ISSUE_URL.
    const issueUrl = normalizeExternalUrl(cfg.issueUrl);
    if (cfg.feedbackFormEnabled || issueUrl) {
      issueBtn.style.display = 'inline-flex';
      issueBtn.addEventListener('click', () => {
        if (cfg.feedbackFormEnabled) openReportIssueModal();
        else window.location.assign(issueUrl);
      });
    }
  } catch (err) {
    console.warn('[loadAppConfig] failed:', err);
  }
}
loadAppConfig();

function normalizeExternalUrl(url) {
  if (!url) return null;
  const raw = String(url).trim();
  if (!raw) return null;
  if (raw.startsWith('/')) return raw;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return raw;
  if (/^[^/]+\.[^/]+/.test(raw)) return `https://${raw}`;
  return raw;
}

function setReportIssueStatus(statusEl, message, { isError = false, html = false } = {}) {
  if (html) statusEl.innerHTML = message;
  else statusEl.textContent = message;
  statusEl.className = `ri-status${isError ? ' ri-status--error' : ''}`;
}

// ── Report Issue modal ────────────────────────────────────
function openReportIssueModal() {
  const overlay  = document.getElementById('ri-overlay');
  const form     = document.getElementById('ri-form');
  const select   = document.getElementById('ri-module');
  const status   = document.getElementById('ri-status');

  // Populate module dropdown dynamically from active tool cards
  if (select.options.length <= 1) {
    const modules = [];
    document.querySelectorAll('.tool-card:not(.tool-card-soon) .tool-card-name').forEach(el => {
      modules.push(el.textContent.trim());
    });
    ['Authentication', 'General Issue'].forEach(name => modules.push(name));
    modules.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
  }

  // Reset form state
  form.reset();
  status.textContent = '';
  status.className = 'ri-status';
  document.getElementById('ri-submit').disabled = false;

  overlay.classList.remove('hidden');

  // Focus first field
  document.getElementById('ri-email').focus();
}

function closeReportIssueModal() {
  document.getElementById('ri-overlay').classList.add('hidden');
}

// Wire close/cancel/overlay-click
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('ri-overlay');
  if (!overlay) return;

  document.getElementById('ri-close').addEventListener('click', closeReportIssueModal);
  document.getElementById('ri-cancel').addEventListener('click', closeReportIssueModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeReportIssueModal();
  });

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeReportIssueModal();
  });

  // Form submission
  document.getElementById('ri-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status  = document.getElementById('ri-status');
    const submitBtn = document.getElementById('ri-submit');

    // Consent check
    if (!document.getElementById('ri-consent').checked) {
      setReportIssueStatus(status, 'Please agree to the Privacy Policy.', { isError: true });
      return;
    }

    submitBtn.disabled = true;
    setReportIssueStatus(status, 'Sending...');

    const payload = {
      email:            document.getElementById('ri-email').value.trim() || undefined,
      module:           document.getElementById('ri-module').value,
      description:      document.getElementById('ri-description').value.trim(),
      expectedBehavior: document.getElementById('ri-expected').value.trim(),
      stepsToReproduce: document.getElementById('ri-steps').value.trim() || undefined,
    };

    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        const fallbackUrl = normalizeExternalUrl(data.fallbackUrl);
        if (fallbackUrl) {
          setReportIssueStatus(
            status,
            `Automatic report submission is unavailable right now. Please <a href="${esc(fallbackUrl)}" target="_blank" rel="noopener">submit the issue here</a>.`,
            { isError: true, html: true }
          );
          submitBtn.disabled = false;
          return;
        }
        throw new Error(data.error || 'Failed to send report.');
      }
      setReportIssueStatus(status, 'Report sent — thank you!');
      status.classList.add('ri-status--ok');
      setTimeout(closeReportIssueModal, 2000);
    } catch (err) {
      setReportIssueStatus(status, err.message, { isError: true });
      submitBtn.disabled = false;
    }
  });
});

// ── Session state ──────────────────────────────────────────
const SESSION_KEY = 'pb_token';
const EU_KEY      = 'pb_eu';

let token      = sessionStorage.getItem(SESSION_KEY) || '';
let useEu      = sessionStorage.getItem(EU_KEY) === 'true';
let authMethod = null; // 'oauth' | 'manual' | null

// ── DOM helpers ────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const show  = (id) => $(id).classList.remove('hidden');
const hide  = (id) => $(id).classList.add('hidden');
const setText = (id, t) => { $(id).textContent = t; };

// ── Dialog helpers (replace native alert/confirm) ──────────
/**
 * showAlert(msg, opts)  — styled non-blocking alert. Returns a Promise that resolves when dismissed.
 * showConfirm(msg, opts) — styled confirm dialog. Returns a Promise<boolean>.
 *
 * opts.icon  — optional emoji/string shown left of the message (default: '⚠️' for confirm, 'ℹ️' for alert)
 * opts.okLabel — label for the OK button (default 'OK')
 * opts.cancelLabel — label for the cancel button (default 'Cancel', confirm only)
 */
function showAlert(msg, opts = {}) {
  return _showDialog(msg, { ...opts, mode: 'alert' });
}
function showConfirm(msg, opts = {}) {
  return _showDialog(msg, { ...opts, mode: 'confirm' });
}
function _showDialog(msg, { mode = 'alert', icon, okLabel = 'OK', cancelLabel = 'Cancel', html = false } = {}) {
  const overlay  = $('app-dialog');
  const msgEl    = $('app-dialog-msg');
  const iconEl   = $('app-dialog-icon');
  const okBtn    = $('app-dialog-ok');
  const cancelBtn = $('app-dialog-cancel');

  if (html) msgEl.innerHTML = msg;
  else      msgEl.textContent = msg;
  iconEl.textContent = icon || (mode === 'confirm' ? '⚠️' : 'ℹ️');
  okBtn.textContent = okLabel;
  cancelBtn.textContent = cancelLabel;
  cancelBtn.classList.toggle('hidden', mode === 'alert');
  overlay.classList.remove('hidden');
  okBtn.focus();

  return new Promise((resolve) => {
    function cleanup() {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBg);
      document.removeEventListener('keydown', onKey);
    }
    function onOk()     { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    function onBg(e)    { if (e.target === overlay) { mode === 'alert' ? onOk() : onCancel(); } }
    function onKey(e)   {
      if (e.key === 'Escape') { mode === 'alert' ? onOk() : onCancel(); }
      if (e.key === 'Enter')  onOk();
    }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBg);
    document.addEventListener('keydown', onKey);
  });
}

// ── Progress helper ────────────────────────────────────────
/**
 * setProgress(prefix, msg, pct)
 *
 * Update a progress bar + label in one call.
 * Expects DOM ids: `${prefix}-progress-bar`, `${prefix}-progress-msg`,
 * and optionally `${prefix}-progress-pct`.
 */
function setProgress(prefix, msg, pct) {
  const bar = $(prefix + '-progress-bar');
  if (bar) bar.style.width = `${Math.min(100, Math.round(pct))}%`;
  const msgEl = $(prefix + '-progress-msg');
  if (msgEl) msgEl.textContent = msg;
  const pctEl = $(prefix + '-progress-pct');
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
}

// ── View-state controller ──────────────────────────────────
/**
 * createViewState(prefix, states)
 *
 * Manages mutually exclusive visibility states for an operation panel.
 * Each state maps to a DOM element with id `${prefix}-${state}`.
 *
 * Usage:
 *   const vs = createViewState('notes-export', ['idle', 'running', 'done', 'error', 'stopped']);
 *   vs.go('running');  // shows notes-export-running, hides all others
 *   vs.go('idle');     // back to idle
 *   vs.current;        // 'idle'
 *
 * Returns { go(state), reset(), current }
 */
function createViewState(prefix, states) {
  let current = states[0];

  function go(state) {
    for (const s of states) {
      const el = $(prefix + '-' + s);
      if (el) el.classList.toggle('hidden', s !== state);
    }
    current = state;
  }

  go(current);

  return {
    go,
    reset() { go(states[0]); },
    get current() { return current; },
  };
}

// ── Routing ─────────────────────────────────────────────────
const VALID_TOOLS = new Set([
  'entities', 'notes', 'companies',
  'member-activity', 'teams', 'notes-merge', 'companies-duplicate-cleanup',
]);

const PAGE_META = {
  entities:          { title: 'Entities', desc: 'Import, export, and migrate Productboard entities across workspaces via CSV.' },
  notes:             { title: 'Notes', desc: 'Export, import, delete, and migrate Productboard notes across workspaces.' },
  companies:         { title: 'Companies & Users', desc: 'Export and import Productboard companies and users, including custom fields, relationships, and UUID-based patching.' },
  'member-activity': { title: 'Member Activity', desc: 'Export Productboard member activity data for license auditing and enablement planning.' },
  teams:                { title: 'Teams & Members', desc: 'Manage Productboard teams — edit names, handles, descriptions, and members. Import and export via CSV.' },
  'companies-duplicate-cleanup':  { title: 'Merge Duplicate Companies', desc: 'Relink notes and user associations from duplicate Productboard companies to their Salesforce canonical record, then delete the duplicates.' },
};

const DEFAULT_TITLE = 'PBToolkit \u2014 Productboard Importer, Exporter & Migration Tool';
const DEFAULT_DESC  = 'Import, export, and migrate Productboard data via CSV. Bulk-manage entities, notes, and companies across workspaces. Free, open-source, browser-based tool.';

function updatePageMeta(tool) {
  const meta = tool ? PAGE_META[tool] : null;
  document.title = meta ? `${meta.title} \u2014 PBToolkit` : DEFAULT_TITLE;
  const descEl = document.querySelector('meta[name="description"]');
  if (descEl) descEl.content = meta ? meta.desc : DEFAULT_DESC;
}

const DEFAULT_VIEWS = {
  companies:         'export',
  notes:             'notes-export',
  entities:          'entities-templates',
  'member-activity': 'member-activity-export',
  teams:             'members-teams-mgmt-manage',
  'notes-merge':        'notes-merge-view',
  'companies-duplicate-cleanup':  'companies-duplicate-cleanup',
};

const TOOL_VIEWS = {
  companies:         ['export', 'import', 'companies-delete-csv', 'companies-delete-all', 'companies-source-migration', 'users-export', 'users-import', 'users-delete-csv', 'users-delete-all'],
  notes:             ['notes-export', 'notes-import', 'notes-delete-csv', 'notes-delete-all', 'notes-migrate'],
  entities:          ['entities-templates', 'entities-export', 'entities-import', 'entities-delete'],
  'member-activity': ['member-activity-export'],
  teams:             [
    'teams-crud-export', 'teams-crud-import', 'teams-crud-delete-csv', 'teams-crud-delete-all',
    'team-membership-export', 'team-membership-import',
    'members-teams-mgmt-manage',
  ],
  'notes-merge':       ['notes-merge-view', 'notes-merge-empty'],
  'companies-duplicate-cleanup': ['companies-duplicate-cleanup'],
};

let _currentTool = null;
let _currentView = null;

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

// ── Router helpers ─────────────────────────────────────────
function viewToSegment(tool, view) {
  // Strip tool prefix for cleaner URLs: 'notes-export' → 'export'
  if (view.startsWith(tool + '-')) return view.slice(tool.length + 1);
  return view;
}

function segmentToView(tool, segment) {
  const views = TOOL_VIEWS[tool] || [];
  // Try prefixed first: 'export' → 'notes-export'
  const prefixed = tool + '-' + segment;
  if (views.includes(prefixed)) return prefixed;
  // Then try as-is: 'export' (companies)
  if (views.includes(segment)) return segment;
  return null;
}

function buildPath(tool, view) {
  if (!tool) return '/';
  if (!view || view === DEFAULT_VIEWS[tool]) return '/' + tool;
  return '/' + tool + '/' + viewToSegment(tool, view);
}

function parsePath(pathname) {
  const segments = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  const toolSlug = segments[0] || null;
  const viewSegment = segments[1] || null;
  if (!toolSlug || !VALID_TOOLS.has(toolSlug)) return { tool: null, view: null };
  const view = viewSegment
    ? (segmentToView(toolSlug, viewSegment) || DEFAULT_VIEWS[toolSlug])
    : DEFAULT_VIEWS[toolSlug];
  return { tool: toolSlug, view };
}

async function navigateTo(tool, view, { pushState = true, replace = false } = {}) {
  if (!tool || !VALID_TOOLS.has(tool)) {
    // Go home
    _currentTool = null;
    _currentView = null;
    showScreen('home');
    updatePageMeta(null);
    const state = { tool: null, view: null };
    if (replace) history.replaceState(state, '', '/');
    else if (pushState) history.pushState(state, '', '/');
    return;
  }

  const resolvedView = (view && (TOOL_VIEWS[tool] || []).includes(view))
    ? view
    : DEFAULT_VIEWS[tool];

  const toolChanged = _currentTool !== tool;
  if (toolChanged) await loadTool(tool);
  if (_currentView !== resolvedView) showView(resolvedView);
  updatePageMeta(tool);

  const path = buildPath(tool, resolvedView);
  const state = { tool, view: resolvedView };
  if (replace) history.replaceState(state, '', path);
  else if (pushState) history.pushState(state, '', path);
}

window.addEventListener('popstate', (e) => {
  const s = e.state;
  if (!s || !s.tool) navigateTo(null, null, { pushState: false });
  else navigateTo(s.tool, s.view, { pushState: false });
});

// ── Boot ───────────────────────────────────────────────────
async function boot() {
  const { tool, view } = parsePath(window.location.pathname);
  const returnPath = sessionStorage.getItem('pb_return_path');
  sessionStorage.removeItem('pb_return_path');

  if (returnPath) {
    const r = parsePath(returnPath);
    if (r.tool) { await navigateTo(r.tool, r.view, { replace: true }); return; }
  }

  if (tool) {
    await navigateTo(tool, view, { replace: true });
  } else {
    showScreen('home');
    history.replaceState({ tool: null, view: null }, '', '/');
    updateConnectionStatus();
  }
}

// ── "PB Tools" home button ─────────────────────────────────
$('btn-home').addEventListener('click', () => navigateTo(null));
$('btn-back-home').addEventListener('click', () => navigateTo(null));

// ── Sidebar collapse toggle ─────────────────────────────────
(function () {
  const STORAGE_KEY = 'sidebar-collapsed';
  const mainContent = document.querySelector('.main-content');
  const btn         = $('sidebar-collapse-toggle');
  if (!mainContent || !btn) return;

  // Restore saved state
  if (localStorage.getItem(STORAGE_KEY) === 'true') {
    mainContent.classList.add('sidebar-collapsed');
    btn.title = 'Expand sidebar';
  }

  btn.addEventListener('click', () => {
    const collapsed = mainContent.classList.toggle('sidebar-collapsed');
    localStorage.setItem(STORAGE_KEY, String(collapsed));
    btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  });
})();

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
    if (tool) navigateTo(tool);
  });
});

async function loadTool(toolName) {
  const names = { companies: 'Companies & Users', notes: 'Notes', entities: 'Entities', 'member-activity': 'Member Activity', teams: 'Teams', 'notes-merge': 'Merge Duplicate Notes', 'companies-duplicate-cleanup': 'Merge Duplicate Companies' };
  setText('topbar-tool-name', names[toolName] || toolName);
  showScreen('tool');
  _currentTool = toolName;

  // Show the correct sidebar section
  $('sidebar-companies').classList.toggle('hidden', toolName !== 'companies');
  $('sidebar-notes').classList.toggle('hidden', toolName !== 'notes');
  $('sidebar-entities').classList.toggle('hidden', toolName !== 'entities');
  $('sidebar-member-activity').classList.toggle('hidden', toolName !== 'member-activity');
  $('sidebar-teams').classList.toggle('hidden', toolName !== 'teams');
  $('sidebar-notes-merge').classList.toggle('hidden', toolName !== 'notes-merge');
  $('sidebar-companies-duplicate-cleanup').classList.toggle('hidden', toolName !== 'companies-duplicate-cleanup');

  try {
    if (toolName === 'companies') {
      // Combined module: load companies + users partials
      await Promise.all([
        loadPartial('companies'),
        loadPartial('users'),
      ]);
    } else if (toolName === 'teams') {
      // Combined module: load all three partials
      await Promise.all([
        loadPartial('teams-crud'),
        loadPartial('team-membership'),
        loadPartial('members-teams-mgmt'),
      ]);
    } else {
      await loadPartial(toolName);
    }
  } catch (e) {
    console.error('Failed to load view partial:', e);
    return;
  }

  // Init module (idempotent — each module guards against double-init)
  if (toolName === 'companies')        { window.initCompaniesModule?.(); window.initUsersModule?.(); }
  if (toolName === 'notes')            window.initNotesModule?.();
  if (toolName === 'entities')         window.initEntitiesModule?.();
  if (toolName === 'member-activity')  window.initMemberActivityModule?.();
  if (toolName === 'notes-merge')        window.initNotesMergeModule?.();
  if (toolName === 'companies-duplicate-cleanup')  window.initCompaniesDuplicateCleanupModule?.();
  if (toolName === 'teams') {
    window.initTeamsCrudModule?.();
    window.initTeamMembershipModule?.();
    window.initMembersTeamsMgmtModule?.();
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
$('btn-connect-oauth').addEventListener('click', () => {
  // Preserve the current module path so we can return after OAuth callback.
  if (_currentTool) sessionStorage.setItem('pb_return_path', location.pathname);
  // Redirect to the server-side OAuth initiation route; include the current DC preference.
  location.href = `/auth/pb?eu=${useEu}`;
});
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
    // Notify all modules so they can re-fetch data with the (new) token
    window.dispatchEvent(new CustomEvent('pb:connected'));
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
$('btn-disconnect').addEventListener('click', async () => {
  if (authMethod === 'oauth') {
    // Destroy the server-side session that holds the OAuth token.
    await fetch('/auth/pb/disconnect', { method: 'POST' }).catch(() => {});
    authMethod = null;
  }
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(EU_KEY);
  token = '';
  useEu = false;
  updateConnectionStatus();
  window.dispatchEvent(new CustomEvent('pb:disconnect'));
});

// ── Mobile nav toggle ───────────────────────────────────────
const _sidebarNav = document.querySelector('.sidebar-nav');
const _mobileNavLabel = $('mobile-nav-label');

$('mobile-nav-toggle')?.addEventListener('click', () => {
  _sidebarNav?.classList.toggle('mobile-nav-open');
});

// ── Tool nav (inside tool view) ─────────────────────────────
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    showView(btn.dataset.view, { updateUrl: true });
  });
});

function showView(view, { updateUrl = false } = {}) {
  _currentView = view;

  [
    'export', 'import',
    'companies-delete-csv', 'companies-delete-all', 'companies-source-migration',
    'notes-export', 'notes-import', 'notes-delete-csv', 'notes-delete-all', 'notes-migrate',
    'entities-templates', 'entities-export', 'entities-import', 'entities-delete',
    'member-activity-export',
    'team-membership-export', 'team-membership-import',
    'teams-crud-export', 'teams-crud-import', 'teams-crud-delete-csv', 'teams-crud-delete-all',
    'members-teams-mgmt-manage',
    'users-export', 'users-import', 'users-delete-csv', 'users-delete-all',
    'notes-merge-view', 'notes-merge-empty',
    'companies-duplicate-cleanup', 'companies-duplicate-cleanup-csv',
  ].forEach((v) => {
    const el = $(`view-${v}`);
    if (el) el.classList.toggle('hidden', v !== view);
  });

  // Activate matching sidebar nav-item
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
  const navBtn = document.querySelector(`.nav-item[data-view="${view}"]`);
  if (navBtn) navBtn.classList.add('active');

  // Mobile: collapse nav and update toggle label
  _sidebarNav?.classList.remove('mobile-nav-open');
  if (_mobileNavLabel && navBtn) _mobileNavLabel.textContent = navBtn.textContent.trim();

  if (updateUrl && _currentTool) {
    const path = buildPath(_currentTool, view);
    history.pushState({ tool: _currentTool, view }, '', path);
  }

  updateConnectionStatus();
}

// ── Helpers ─────────────────────────────────────────────────
function buildHeaders(t = token, eu = useEu) {
  const h = { 'Content-Type': 'application/json' };
  // OAuth path: token lives in the session cookie — don't send it as a header.
  // Manual path: pass the token the user provided.
  if (authMethod !== 'oauth') h['x-pb-token'] = t;
  if (eu) h['x-pb-eu'] = 'true';
  return h;
}

function subscribeSSE(url, body, { onProgress, onComplete, onError, onLog = null, onAbort = null }) {
  // SSE over POST: read the response body as a stream and parse SSE frames manually
  const ctrl = new AbortController();
  const headers = buildHeaders();
  headers.Accept = 'text/event-stream';

  fetch(url, {
    method: 'POST',
    headers,
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

  // separator(label) — inserts a visual divider into the live log without clearing it.
  // Used when continuing a stopped run so the full log stays intact across segments.
  append.separator = (label) => {
    const entriesEl = document.getElementById(entriesId);
    const logEl     = document.getElementById(logId);
    if (!entriesEl) return;
    logEl?.classList.remove('hidden');
    const div = document.createElement('div');
    div.style.cssText = 'border-top:1px solid rgba(255,255,255,0.18);margin:6px 0;padding-top:6px;font-size:10px;text-align:center;letter-spacing:.06em;color:rgba(255,255,255,0.55);';
    div.textContent = label || '── continuing ──';
    entriesEl.appendChild(div);
    entriesEl.scrollTop = entriesEl.scrollHeight;
    _buffer.push({ timestamp: new Date().toISOString(), level: 'info', row_num: '', uuid: '', entity_type: defaultEntityType, message: label || '── continuing ──' });
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

// ── Dropzone helper ──────────────────────────────────────────────────────────
/**
 * wireDropzone — attach consistent file-selection UI to a single-file dropzone.
 * When a file is chosen the dropzone switches to a "has-file" state showing the
 * filename, row count, and a ✕ remove button — matching the entities tile look.
 *
 * @param {HTMLElement}      dropzoneEl  - the .dropzone div
 * @param {HTMLInputElement} fileInputEl - the hidden <input type="file">
 * @param {function}         onFile      - called with the File when a file is chosen
 * @param {function}         [onClear]   - optional callback when the file is cleared
 * @returns {{ clear: function }}        - call clear() to reset programmatically
 */
function wireDropzone(dropzoneEl, fileInputEl, onFile, onClear) {
  // Capture original label/hint so clear() restores them correctly
  const origLabel = dropzoneEl.querySelector('.dropzone-label').textContent;
  const origHint  = dropzoneEl.querySelector('.dropzone-hint').textContent;

  // Inject the ✕ remove button once
  let removeBtn = dropzoneEl.querySelector('.dropzone-remove');
  if (!removeBtn) {
    removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'dropzone-remove hidden';
    removeBtn.title = 'Remove file';
    removeBtn.textContent = '✕';
    dropzoneEl.appendChild(removeBtn);
  }

  function setSelected(file) {
    dropzoneEl.classList.add('has-file');
    dropzoneEl.querySelector('.dropzone-label').textContent = file.name;
    const hint = dropzoneEl.querySelector('.dropzone-hint');
    hint.textContent = 'Counting rows…';
    removeBtn.classList.remove('hidden');
    file.text().then((text) => {
      const rows = text.split('\n').filter((l) => l.trim()).length - 1;
      hint.textContent = `${rows.toLocaleString()} row${rows !== 1 ? 's' : ''}`;
    }).catch(() => { hint.textContent = ''; });
  }

  function clear() {
    dropzoneEl.classList.remove('has-file');
    dropzoneEl.querySelector('.dropzone-label').textContent = origLabel;
    dropzoneEl.querySelector('.dropzone-hint').textContent  = origHint;
    removeBtn.classList.add('hidden');
    fileInputEl.value = '';
  }

  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clear();
    if (onClear) onClear();
  });

  dropzoneEl.addEventListener('click', (e) => {
    if (e.target === removeBtn) return;
    fileInputEl.click();
  });
  dropzoneEl.addEventListener('dragover',  (e) => { e.preventDefault(); dropzoneEl.classList.add('drag-over'); });
  dropzoneEl.addEventListener('dragleave', () => dropzoneEl.classList.remove('drag-over'));
  dropzoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) { setSelected(file); onFile(file); }
  });
  fileInputEl.addEventListener('change', () => {
    const file = fileInputEl.files[0];
    if (file) { setSelected(file); onFile(file); }
  });

  return { clear };
}

// ── Run ─────────────────────────────────────────────────────
// Check for an existing OAuth session before booting the UI.
// If the server session holds a token, set authMethod and token sentinel
// so the app shows "Connected" without exposing the token to the browser.
async function initAuth() {
  try {
    const status = await fetch('/api/auth/status').then(r => r.json());
    if (status.connected && status.method === 'oauth') {
      authMethod = 'oauth';
      token  = '__oauth__'; // truthy sentinel — actual token lives server-side
      useEu  = status.useEu;
    }
  } catch (_) {
    // Network error on status check — fall through to manual token path
  }
  await boot();
}
initAuth();
