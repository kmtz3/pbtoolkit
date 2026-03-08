/* =========================================================
   PBToolkit — frontend
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

// Import state (companies tool)
let parsedCSV    = null; // { raw: string, headers: string[], rowCount: number }
let customFields = [];   // [{ id, name, type }]
let lastExportCSV = null;
let lastExportFilename = 'companies.csv';

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

// ── Tool cards ─────────────────────────────────────────────
document.querySelectorAll('.tool-card:not(.tool-card-soon)').forEach((card) => {
  card.addEventListener('click', () => {
    const tool = card.dataset.tool;
    if (tool) loadTool(tool);
  });
});

function loadTool(toolName) {
  const names = { companies: 'Companies', notes: 'Notes', entities: 'Entities', 'member-activity': 'Member Activity' };
  setText('topbar-tool-name', names[toolName] || toolName);
  showScreen('tool');

  // Show the correct sidebar section
  $('sidebar-companies').classList.toggle('hidden', toolName !== 'companies');
  $('sidebar-notes').classList.toggle('hidden', toolName !== 'notes');
  $('sidebar-entities').classList.toggle('hidden', toolName !== 'entities');
  $('sidebar-member-activity').classList.toggle('hidden', toolName !== 'member-activity');

  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));

  if (toolName === 'companies') {
    $('nav-export').classList.add('active');
    showView('export');
  }

  if (toolName === 'notes') {
    $('nav-notes-export').classList.add('active');
    showView('notes-export');
  }

  if (toolName === 'entities') {
    $('nav-entities-templates').classList.add('active');
    showView('entities-templates');
  }

  if (toolName === 'member-activity') {
    $('nav-member-activity-export').classList.add('active');
    showView('member-activity-export');
    if (typeof initMemberActivityModule === 'function') initMemberActivityModule();
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
    const res = await fetch('/api/fields', {
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
    'companies-delete-csv', 'companies-delete-all',
    'notes-export', 'notes-import', 'notes-delete-csv', 'notes-delete-all', 'notes-migrate',
    'entities-templates', 'entities-export', 'entities-import',
    'member-activity-export',
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

// ══════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════
function resetExport() {
  show('export-idle');
  hide('export-running');
  hide('export-done');
  hide('export-error');
}

$('btn-export').addEventListener('click', () => requireToken(startExport));
$('btn-export-again').addEventListener('click', resetExport);
$('btn-export-retry').addEventListener('click', () => requireToken(startExport));

function startExport() {
  show('export-running');
  hide('export-idle');
  hide('export-done');
  hide('export-error');

  setExportProgress('Starting…', 0);

  subscribeSSE('/api/export', {}, {
    onProgress: ({ message, percent }) => setExportProgress(message, percent),
    onComplete: (data) => {
      hide('export-running');
      if (!data.csv && data.count === 0) {
        showExportError('No companies found in this workspace.');
        return;
      }
      lastExportCSV = data.csv;
      lastExportFilename = data.filename || 'companies.csv';
      show('export-done');
      setText('export-done-msg', `Exported ${data.count} companies. Ready to download.`);
    },
    onError: (msg) => {
      hide('export-running');
      showExportError(msg);
    },
  });
}

function setExportProgress(msg, pct) {
  setText('export-progress-msg', msg);
  setText('export-progress-pct', `${pct}%`);
  $('export-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

function showExportError(msg) {
  setText('export-error-msg', msg);
  show('export-error');
}

$('btn-download-csv').addEventListener('click', () => {
  if (!lastExportCSV) return;
  triggerDownload(new Blob([lastExportCSV], { type: 'text/csv;charset=utf-8;' }), lastExportFilename);
});

// ══════════════════════════════════════════════════════════
// IMPORT — Step 1: Upload
// ══════════════════════════════════════════════════════════
const dropzone  = $('dropzone');
const fileInput = $('file-input');

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadCSVFile(e.target.files[0]);
});

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadCSVFile(file);
});

function loadCSVFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) {
      alert('CSV file appears empty or has no data rows.');
      return;
    }
    parsedCSV = { raw: text, headers: parseCSVHeaders(text), rowCount };
    showMappingStep();
  };
  reader.readAsText(file);
}

// ══════════════════════════════════════════════════════════
// IMPORT — Step 2: Map columns
// ══════════════════════════════════════════════════════════
async function showMappingStep() {
  hide('import-step-validate');
  hide('import-step-run');
  show('import-step-map');
  show('import-step-options'); // Options panel always shows alongside map panel
  setText('map-subtitle', `${parsedCSV.rowCount} rows detected · ${parsedCSV.headers.length} columns`);

  buildBaseMappingTable();
  await loadAndBuildCustomFieldTable();
}

function buildBaseMappingTable() {
  const tbody = $('base-field-map-rows');
  tbody.innerHTML = '';

  const baseFields = [
    { id: 'map-pb-id',         label: 'PB Company UUID',   required: false, hint: 'If present → PATCH, else use domain lookup' },
    { id: 'map-name',          label: 'Company Name',       required: true  },
    { id: 'map-domain',        label: 'Domain',             required: true  },
    { id: 'map-desc',          label: 'Description',        required: false },
    { id: 'map-source-origin', label: 'Source Origin',      required: false },
    { id: 'map-source-record', label: 'Source Record ID',   required: false },
  ];

  for (const f of baseFields) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        ${f.label}
        ${f.hint ? `<div class="text-sm text-muted">${f.hint}</div>` : ''}
      </td>
      <td>${buildColumnSelect(f.id, !f.required)}</td>
      <td>${f.required ? '<span class="badge badge-danger">required</span>' : '<span class="badge badge-muted">optional</span>'}</td>
    `;
    tbody.appendChild(tr);
  }

  autoDetectBaseMappings();
}

function buildColumnSelect(id, includeNone = true) {
  const options = includeNone
    ? '<option value="">— not mapped —</option>'
    : '<option value="">— select column —</option>';

  const colOptions = parsedCSV.headers
    .map((h) => `<option value="${esc(h)}">${esc(h)}</option>`)
    .join('');

  return `<select id="${id}">${options}${colOptions}</select>`;
}

function autoDetectBaseMappings() {
  const hints = {
    'map-pb-id':         ['pb_id', 'id', 'uuid', 'company id', 'pb company id'],
    'map-name':          ['name', 'company name', 'company_name'],
    'map-domain':        ['domain', 'website', 'url'],
    'map-desc':          ['description', 'desc', 'notes'],
    'map-source-origin': ['sourceorigin', 'source_origin', 'source origin'],
    'map-source-record': ['sourcerecordid', 'source_record_id', 'source record id'],
  };

  for (const [selectId, candidates] of Object.entries(hints)) {
    const sel = $(selectId);
    if (!sel) continue;
    for (const candidate of candidates) {
      const match = parsedCSV.headers.find((h) => h.toLowerCase() === candidate);
      if (match) { sel.value = match; break; }
    }
  }
}

async function loadAndBuildCustomFieldTable() {
  $('custom-fields-loading').textContent = 'Loading custom fields from Productboard…';
  show('custom-fields-loading');
  hide('custom-field-table');

  try {
    const res = await fetch('/api/fields', { headers: buildHeaders() });
    const data = await res.json();
    customFields = data.fields || [];

    hide('custom-fields-loading');

    if (customFields.length === 0) {
      $('custom-fields-loading').textContent = 'No custom fields found in this workspace.';
      show('custom-fields-loading');
      return;
    }

    buildCustomFieldTable();
    show('custom-field-table');
  } catch (e) {
    $('custom-fields-loading').textContent = `Failed to load custom fields: ${e.message}`;
  }
}

function buildCustomFieldTable() {
  const tbody = $('custom-field-map-rows');
  tbody.innerHTML = '';

  for (const field of customFields) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(field.name)}</td>
      <td><span class="badge badge-muted">${esc(field.type)}</span></td>
      <td>${buildColumnSelect(`cf-${field.id}`, true)}</td>
    `;
    tbody.appendChild(tr);

    const sel = $(`cf-${field.id}`);
    const match = parsedCSV.headers.find(
      (h) => h.toLowerCase() === field.name.toLowerCase()
    );
    if (match) sel.value = match;
  }
}

$('btn-reupload').addEventListener('click', () => {
  parsedCSV = null;
  fileInput.value = '';
  hide('import-step-map');
  hide('import-step-options');
  hide('import-step-validate');
  hide('import-step-run');
});

// ── Check for unmapped custom fields ────────────────────────
function checkUnmappedWarning() {
  const unmappedCustom = customFields
    .filter((f) => !$(`cf-${f.id}`)?.value)
    .map((f) => f.name);

  if (unmappedCustom.length > 0) {
    setText('unmapped-warning-msg',
      `${unmappedCustom.length} custom field(s) not mapped and will be skipped: ${unmappedCustom.join(', ')}.`
    );
    show('unmapped-warning');
  } else {
    hide('unmapped-warning');
  }
}

$('btn-validate').addEventListener('click', () => requireToken(() => {
  checkUnmappedWarning();
  runValidation();
}));
$('btn-run-import').addEventListener('click', () => requireToken(() => {
  checkUnmappedWarning();
  runImport();
}));

// ══════════════════════════════════════════════════════════
// IMPORT — Step 3: Validate
// ══════════════════════════════════════════════════════════
async function runValidation() {
  const mapping = buildMapping();
  if (!validateRequiredMappings(mapping)) return;

  show('import-step-validate');
  hide('validate-ok');
  hide('validate-errors');
  setText('validate-ok-msg', '');
  $('validate-error-rows').innerHTML = '';

  try {
    const res = await fetch('/api/import/preview', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ csvText: parsedCSV.raw, mapping }),
    });
    const data = await res.json();

    if (data.valid) {
      setText('validate-ok-msg', `All ${data.totalRows} rows passed validation. Ready to import.`);
      show('validate-ok');
    } else {
      const summary = `${data.errors.length} error(s) found in ${data.totalRows} rows. Fix the CSV and re-upload.`;
      setText('validate-error-summary', summary);
      const tbody = $('validate-error-rows');
      for (const err of data.errors) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${err.row ?? '—'}</td>
          <td><span class="col-tag">${esc(err.field || '')}</span></td>
          <td class="text-danger">${esc(err.message)}</td>
        `;
        tbody.appendChild(tr);
      }
      show('validate-errors');
    }
  } catch (e) {
    setText('validate-error-summary', `Validation request failed: ${e.message}`);
    show('validate-errors');
  }
}

$('btn-run-after-validate').addEventListener('click', () => requireToken(runImport));
$('btn-back-to-map').addEventListener('click', () => hide('import-step-validate'));
$('btn-back-to-map2').addEventListener('click', () => hide('import-step-validate'));

// ══════════════════════════════════════════════════════════
// IMPORT — Step 4: Run
// ══════════════════════════════════════════════════════════

let importController = null; // AbortController for the active import stream

// Log appender for companies import — bound to companies log DOM IDs.
// Uses shared makeLogAppender() defined above.
const appendLogEntry = makeLogAppender('import-live-log', 'live-log-entries', 'live-log-counts');

function runImport() {
  const mapping = buildMapping();
  if (!validateRequiredMappings(mapping)) return;

  // Reset log for fresh run (clears entries, counts, hides the log panel)
  appendLogEntry.reset();
  // Reset summary box
  $('import-summary-box').innerHTML = '';
  hide('import-summary-box');
  hide('import-step-validate');
  show('import-step-run');
  setText('import-run-title', 'Importing…');
  setImportProgress('Starting…', 0);
  show('btn-stop-import');

  const clearEmpty = $('clear-empty-fields').checked;

  importController = subscribeSSE(
    '/api/import/run',
    { csvText: parsedCSV.raw, mapping, clearEmptyFields: clearEmpty },
    {
      onProgress: ({ message, percent }) => setImportProgress(message, percent),

      // appendLogEntry is the shared makeLogAppender-bound function
      onLog: (entry) => appendLogEntry(entry),

      onComplete: (data) => {
        hide('btn-stop-import');
        setText('import-run-title', data.stopped ? 'Import stopped' : 'Import complete');
        // Use shared renderImportComplete for styled alert-ok/warn summary
        renderImportComplete($('import-summary-box'), {
          created: data.created,
          updated: data.updated,
          errors:  data.errors,
          stopped: data.stopped,
          extraText: data.total ? `${data.total} rows` : '',
        });
      },

      onError: (msg) => {
        hide('btn-stop-import');
        setText('import-run-title', 'Import failed');
        // Show error in summary box using danger alert
        $('import-summary-box').innerHTML = `
          <div class="alert alert-danger">
            <span class="alert-icon">⚠️</span>
            <span>${esc(msg)}</span>
          </div>`;
        show('import-summary-box');
        // Also append to log so it's visible in context
        appendLogEntry({ level: 'error', message: msg, ts: new Date().toISOString() });
      },
    }
  );
}

function setImportProgress(msg, pct) {
  setText('import-progress-msg', msg);
  setText('import-progress-pct', `${pct}%`);
  $('import-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

$('btn-stop-import').addEventListener('click', () => {
  if (importController) {
    importController.abort();
    importController = null;
  }
  hide('btn-stop-import');
  setText('import-run-title', 'Import stopped');
  const c = appendLogEntry.getCounts();
  renderImportComplete($('import-summary-box'), {
    stopped: true,
    created: 0, updated: 0, // server hasn't sent final counts; log shows row detail
    errors:  c.error,
    extraText: `${c.success} rows processed`,
  });
});

// ── Mapping helpers ─────────────────────────────────────────
function buildMapping() {
  return {
    pbIdColumn:       $('map-pb-id')?.value        || null,
    nameColumn:       $('map-name')?.value          || null,
    domainColumn:     $('map-domain')?.value        || null,
    descColumn:       $('map-desc')?.value          || null,
    sourceOriginCol:  $('map-source-origin')?.value || null,
    sourceRecordCol:  $('map-source-record')?.value || null,
    customFields: customFields
      .map((f) => ({
        csvColumn: $(`cf-${f.id}`)?.value || '',
        fieldId:   f.id,
        fieldType: f.type,
      }))
      .filter((cf) => cf.csvColumn),
  };
}

function validateRequiredMappings(mapping) {
  if (!mapping.nameColumn) {
    alert('Please map the "Company Name" column before continuing.');
    return false;
  }
  if (!mapping.domainColumn) {
    alert('Please map the "Domain" column before continuing.');
    return false;
  }
  return true;
}

// ── Escape HTML ─────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
function makeLogAppender(logId, entriesId, countsId) {
  const counts = { success: 0, error: 0, warn: 0, info: 0 };

  function append({ level, message, detail, ts } = {}) {
    const logEl     = document.getElementById(logId);
    const entriesEl = document.getElementById(entriesId);
    const countsEl  = document.getElementById(countsId);
    if (!logEl || !entriesEl || !countsEl) return;

    logEl.classList.remove('hidden');

    if (counts[level] !== undefined) counts[level]++;
    const parts = [];
    if (counts.success) parts.push(`<span style="color:#34d399">${counts.success} ok</span>`);
    if (counts.error)   parts.push(`<span style="color:#f87171">${counts.error} err</span>`);
    if (counts.warn)    parts.push(`<span style="color:#fbbf24">${counts.warn} warn</span>`);
    countsEl.innerHTML = parts.join(' · ');

    const time = ts
      ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const div = document.createElement('div');
    div.className = `log-entry ${level}`;
    div.innerHTML = `
      <span class="log-ts">${esc(time)}</span>
      <span class="log-msg">${esc(message)}</span>
      ${detail ? `<span class="log-detail" title="${esc(String(detail))}">${esc(String(detail))}</span>` : ''}
    `;
    entriesEl.appendChild(div);
    entriesEl.scrollTop = entriesEl.scrollHeight;
  }

  // getCounts() — returns a snapshot of processed row counts.
  // Used by stop handlers to render accurate stopped-summary alerts.
  append.getCounts = () => ({ ...counts });

  // reset() — clears counts and log entries for a fresh run.
  append.reset = () => {
    counts.success = 0; counts.error = 0; counts.warn = 0; counts.info = 0;
    const entriesEl = document.getElementById(entriesId);
    const countsEl  = document.getElementById(countsId);
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
}

// ══════════════════════════════════════════════════════════
// NOTES — Export
// ══════════════════════════════════════════════════════════

let lastNotesExportCSV = null;
let lastNotesExportFilename = 'notes.csv';

function resetNotesExport() {
  show('notes-export-idle');
  hide('notes-export-running');
  hide('notes-export-done');
  hide('notes-export-error');
}

$('btn-notes-export').addEventListener('click', () => requireToken(startNotesExport));
$('btn-notes-export-again').addEventListener('click', resetNotesExport);
$('btn-notes-export-retry').addEventListener('click', () => requireToken(startNotesExport));

document.querySelectorAll('input[name="notes-date-filter"]').forEach(r => {
  r.addEventListener('change', () => {
    hide('notes-filter-range');
    hide('notes-filter-dynamic');
    if (r.value === 'range')   show('notes-filter-range');
    if (r.value === 'dynamic') show('notes-filter-dynamic');
  });
});

function resolveNotesDateFilter() {
  const mode = document.querySelector('input[name="notes-date-filter"]:checked')?.value;
  if (!mode || mode === 'none') return {};

  if (mode === 'range') {
    const from = document.getElementById('notes-filter-from').value;  // 'YYYY-MM-DD' or ''
    const to   = document.getElementById('notes-filter-to').value;
    return {
      createdFrom: from ? `${from}T00:00:00Z` : undefined,
      createdTo:   to   ? `${to}T23:59:59Z`   : undefined,
    };
  }

  if (mode === 'dynamic') {
    const n      = parseInt(document.getElementById('notes-filter-n').value, 10) || 7;
    const period = document.getElementById('notes-filter-period').value;
    const now    = new Date();
    const from   = new Date(now);
    if (period === 'days')   from.setDate(now.getDate() - n);
    if (period === 'weeks')  from.setDate(now.getDate() - n * 7);
    if (period === 'months') from.setMonth(now.getMonth() - n);
    return { createdFrom: from.toISOString(), createdTo: now.toISOString() };
  }

  return {};
}

function startNotesExport() {
  const filters = resolveNotesDateFilter();

  if (filters.createdFrom && filters.createdTo && filters.createdFrom > filters.createdTo) {
    hide('notes-export-idle');
    setNotesExportError('"From" date must be before "To" date.');
    return;
  }

  hide('notes-export-idle');
  show('notes-export-running');
  hide('notes-export-done');
  hide('notes-export-error');
  setNotesExportProgress('Starting…', 0);

  subscribeSSE('/api/notes/export', filters, {
    onProgress: ({ message, percent }) => setNotesExportProgress(message, percent),
    onComplete: (data) => {
      hide('notes-export-running');
      if (!data.csv && data.count === 0) {
        setNotesExportError('No notes found matching your filters.');
        return;
      }
      lastNotesExportCSV = data.csv;
      lastNotesExportFilename = data.filename || 'notes-export.csv';
      show('notes-export-done');
      setText('notes-export-done-msg', `Exported ${data.count} notes. Ready to download.`);
    },
    onError: (msg) => {
      hide('notes-export-running');
      setNotesExportError(msg);
    },
  });
}

function setNotesExportProgress(msg, pct) {
  setText('notes-export-progress-msg', msg);
  setText('notes-export-progress-pct', `${pct}%`);
  $('notes-export-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

function setNotesExportError(msg) {
  setText('notes-export-error-msg', msg);
  show('notes-export-error');
}

$('btn-notes-download-csv').addEventListener('click', () => {
  if (!lastNotesExportCSV) return;
  triggerDownload(new Blob([lastNotesExportCSV], { type: 'text/csv;charset=utf-8;' }), lastNotesExportFilename);
});

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

// ══════════════════════════════════════════════════════════
// NOTES — Import Step 1: Upload
// ══════════════════════════════════════════════════════════

let notesParsedCSV = null; // { raw, headers, rowCount }

const notesDropzone  = $('notes-dropzone');
const notesFileInput = $('notes-file-input');

notesDropzone.addEventListener('click', () => notesFileInput.click());
notesFileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadNotesCSV(e.target.files[0]);
});
notesDropzone.addEventListener('dragover', (e) => { e.preventDefault(); notesDropzone.classList.add('drag-over'); });
notesDropzone.addEventListener('dragleave', () => notesDropzone.classList.remove('drag-over'));
notesDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  notesDropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadNotesCSV(file);
});

function loadNotesCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) { alert('CSV file appears empty or has no data rows.'); return; }
    notesParsedCSV = { raw: text, headers: parseCSVHeaders(text), rowCount };
    showNotesMappingStep();
  };
  reader.readAsText(file);
}

// ══════════════════════════════════════════════════════════
// NOTES — Import Step 2: Map columns
// ══════════════════════════════════════════════════════════

const NOTES_FIELDS = [
  { id: 'notes-map-pb-id',          label: 'PB Note UUID',       key: 'pbIdColumn',          required: false, hint: 'If present → update note in-place' },
  { id: 'notes-map-type',           label: 'Note Type',          key: 'typeColumn',           required: false, hint: 'simple, conversation, or opportunity' },
  { id: 'notes-map-title',          label: 'Title',              key: 'titleColumn',          required: true  },
  { id: 'notes-map-content',        label: 'Content',            key: 'contentColumn',        required: false },
  { id: 'notes-map-display-url',    label: 'Display URL',        key: 'displayUrlColumn',     required: false },
  { id: 'notes-map-user-email',     label: 'User Email',         key: 'userEmailColumn',      required: false },
  { id: 'notes-map-company-domain', label: 'Company Domain',     key: 'companyDomainColumn',  required: false, hint: 'Used when user_email is not set' },
  { id: 'notes-map-owner-email',    label: 'Owner Email',        key: 'ownerEmailColumn',     required: false },
  { id: 'notes-map-creator-email',  label: 'Creator Email',      key: 'creatorEmailColumn',   required: false, hint: 'Set via v2 backfill after creation' },
  { id: 'notes-map-tags',           label: 'Tags',               key: 'tagsColumn',           required: false, hint: 'Comma-separated list' },
  { id: 'notes-map-source-origin',  label: 'Source Origin',      key: 'sourceOriginColumn',   required: false },
  { id: 'notes-map-source-record',  label: 'Source Record ID',   key: 'sourceRecordIdColumn', required: false },
  { id: 'notes-map-archived',       label: 'Archived',           key: 'archivedColumn',       required: false, hint: 'TRUE/FALSE — set via v2 backfill' },
  { id: 'notes-map-processed',      label: 'Processed',          key: 'processedColumn',      required: false, hint: 'TRUE/FALSE — set via v2 backfill' },
  { id: 'notes-map-linked-ents',    label: 'Linked Entities',    key: 'linkedEntitiesColumn', required: false, hint: 'Comma-separated feature/component UUIDs' },
];

const NOTES_AUTODETECT = {
  'notes-map-pb-id':          ['pb_id', 'pb note id', 'note id', 'uuid'],
  'notes-map-type':           ['type', 'note type'],
  'notes-map-title':          ['title', 'name', 'subject'],
  'notes-map-content':        ['content', 'body', 'description'],
  'notes-map-display-url':    ['display_url', 'display url', 'url'],
  'notes-map-user-email':     ['user_email', 'user email', 'email'],
  'notes-map-company-domain': ['company_domain', 'company domain', 'domain'],
  'notes-map-owner-email':    ['owner_email', 'owner email'],
  'notes-map-creator-email':  ['creator_email', 'creator email'],
  'notes-map-tags':           ['tags'],
  'notes-map-source-origin':  ['source_origin', 'source origin'],
  'notes-map-source-record':  ['source_record_id', 'source record id'],
  'notes-map-archived':       ['archived'],
  'notes-map-processed':      ['processed'],
  'notes-map-linked-ents':    ['linked_entities', 'linked entities', 'features'],
};

function showNotesMappingStep() {
  hide('notes-import-step-validate');
  hide('notes-import-step-run');
  show('notes-import-step-map');
  show('notes-import-step-options'); // Options panel always shows alongside map panel
  setText('notes-map-subtitle', `${notesParsedCSV.rowCount} rows · ${notesParsedCSV.headers.length} columns`);
  buildNotesMappingTable();
}

function buildNotesMappingTable() {
  const tbody = $('notes-field-map-rows');
  tbody.innerHTML = '';

  for (const f of NOTES_FIELDS) {
    const tr = document.createElement('tr');
    const opts = (f.required ? '' : '<option value="">— not mapped —</option>') +
      notesParsedCSV.headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
    tr.innerHTML = `
      <td>
        ${esc(f.label)}
        ${f.hint ? `<div class="text-sm text-muted">${esc(f.hint)}</div>` : ''}
      </td>
      <td><select id="${f.id}">${opts}</select></td>
      <td>${f.required ? '<span class="badge badge-danger">required</span>' : '<span class="badge badge-muted">optional</span>'}</td>
    `;
    tbody.appendChild(tr);
  }

  // Auto-detect
  for (const [selectId, candidates] of Object.entries(NOTES_AUTODETECT)) {
    const sel = $(selectId);
    if (!sel) continue;
    for (const c of candidates) {
      const match = notesParsedCSV.headers.find((h) => h.toLowerCase() === c);
      if (match) { sel.value = match; break; }
    }
  }
}

function buildNotesMapping() {
  const mapping = {};
  for (const f of NOTES_FIELDS) {
    mapping[f.key] = $(f.id)?.value || null;
  }
  return mapping;
}

function validateNotesRequiredMappings(mapping) {
  if (!mapping.titleColumn) { alert('Please map the "Title" column before continuing.'); return false; }
  return true;
}

$('btn-notes-reupload').addEventListener('click', () => {
  notesParsedCSV = null;
  notesFileInput.value = '';
  hide('notes-import-step-map');
  hide('notes-import-step-options');
  hide('notes-import-step-validate');
  hide('notes-import-step-run');
});

// Toggle migration field row visibility
$('notes-migration-mode').addEventListener('change', () => {
  if ($('notes-migration-mode').checked) {
    show('notes-migration-field-row');
  } else {
    hide('notes-migration-field-row');
    setText('notes-migration-field-status', '');
  }
});

// Detect migration custom field
$('btn-notes-detect-field').addEventListener('click', () => requireToken(async () => {
  const fieldName = $('notes-migration-field-name').value.trim();
  if (!fieldName) { alert('Enter a field name first.'); return; }

  const btn = $('btn-notes-detect-field');
  const statusEl = $('notes-migration-field-status');
  btn.disabled = true;
  setText('notes-migration-field-status', 'Checking…');

  try {
    const res = await fetch('/api/notes/detect-migration-field', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ fieldName }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      statusEl.textContent = `Error: ${data.error || res.status}`;
      statusEl.style.color = 'var(--color-danger, #e53e3e)';
    } else if (data.found) {
      statusEl.textContent = `✅ Found — text field "${data.fieldName}" exists on entities`;
      statusEl.style.color = 'var(--color-success, #38a169)';
    } else {
      statusEl.textContent = `❌ Not found — no text field named "${data.fieldName}" on entities`;
      statusEl.style.color = 'var(--color-danger, #e53e3e)';
    }
  } catch (e) {
    statusEl.textContent = `Error: ${e.message}`;
    statusEl.style.color = 'var(--color-danger, #e53e3e)';
  } finally {
    btn.disabled = false;
  }
}));

$('btn-notes-validate').addEventListener('click', () => requireToken(() => {
  const mapping = buildNotesMapping();
  if (!validateNotesRequiredMappings(mapping)) return;
  runNotesValidation(mapping);
}));

$('btn-notes-run-import').addEventListener('click', () => requireToken(() => {
  const mapping = buildNotesMapping();
  if (!validateNotesRequiredMappings(mapping)) return;
  runNotesImport(mapping);
}));

// ══════════════════════════════════════════════════════════
// NOTES — Import Step 3: Validate
// ══════════════════════════════════════════════════════════

async function runNotesValidation(mapping) {
  show('notes-import-step-validate');
  hide('notes-validate-ok');
  hide('notes-validate-errors');

  try {
    const res = await fetch('/api/notes/import/preview', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ csvText: notesParsedCSV.raw, mapping }),
    });
    const data = await res.json();

    if (data.valid) {
      setText('notes-validate-ok-msg', `All ${data.totalRows} rows passed validation. Ready to import.`);

      // Show warnings if any
      if (data.warnings?.length) {
        setText('notes-validate-warnings-summary', `${data.warnings.length} warning(s) — import will still proceed`);
        const tbody = $('notes-validate-warning-rows');
        tbody.innerHTML = '';
        for (const w of data.warnings) {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td>${w.row ?? '—'}</td><td><span class="col-tag">${esc(w.field || '')}</span></td><td class="text-muted">${esc(w.message)}</td>`;
          tbody.appendChild(tr);
        }
        show('notes-validate-warnings-section');
      } else {
        hide('notes-validate-warnings-section');
      }

      show('notes-validate-ok');
    } else {
      setText('notes-validate-error-summary', `${data.errors.length} error(s) in ${data.totalRows} rows. Fix and re-upload.`);
      const tbody = $('notes-validate-error-rows');
      tbody.innerHTML = '';
      for (const e of data.errors) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${e.row ?? '—'}</td><td><span class="col-tag">${esc(e.field || '')}</span></td><td class="text-danger">${esc(e.message)}</td>`;
        tbody.appendChild(tr);
      }
      show('notes-validate-errors');
    }
  } catch (e) {
    setText('notes-validate-error-summary', `Validation failed: ${e.message}`);
    show('notes-validate-errors');
  }
}

$('btn-notes-run-after-validate').addEventListener('click', () => requireToken(() => {
  const mapping = buildNotesMapping();
  if (!validateNotesRequiredMappings(mapping)) return;
  runNotesImport(mapping);
}));
$('btn-notes-back-to-map').addEventListener('click',  () => hide('notes-import-step-validate'));
$('btn-notes-back-to-map2').addEventListener('click', () => hide('notes-import-step-validate'));

// ══════════════════════════════════════════════════════════
// NOTES — Import Step 4: Run
// ══════════════════════════════════════════════════════════

let notesImportController = null;

// Log appender for notes import — bound to notes log DOM IDs.
// Uses shared makeLogAppender() defined above.
const appendNotesLogEntry = makeLogAppender('notes-import-live-log', 'notes-live-log-entries', 'notes-live-log-counts');

function runNotesImport(mapping) {
  // Reset log for fresh run
  appendNotesLogEntry.reset();
  // Reset summary box
  $('notes-import-summary-box').innerHTML = '';
  hide('notes-import-summary-box');
  hide('notes-import-step-validate');
  show('notes-import-step-run');
  setText('notes-import-run-title', 'Importing notes…');
  setNotesImportProgress('Starting…', 0);
  show('btn-stop-notes-import');

  const migrationMode = $('notes-migration-mode').checked;
  const migrationFieldName = migrationMode
    ? ($('notes-migration-field-name').value.trim() || 'original_uuid')
    : 'original_uuid';

  notesImportController = subscribeSSE(
    '/api/notes/import/run',
    { csvText: notesParsedCSV.raw, mapping, migrationMode, migrationFieldName },
    {
      onProgress: ({ message, percent }) => setNotesImportProgress(message, percent),

      // appendNotesLogEntry is the shared makeLogAppender-bound function
      onLog: (entry) => appendNotesLogEntry(entry),

      onComplete: (data) => {
        hide('btn-stop-notes-import');
        setText('notes-import-run-title', data.stopped ? 'Import stopped' : 'Import complete');
        // Use shared renderImportComplete for styled alert-ok/warn summary
        renderImportComplete($('notes-import-summary-box'), {
          created: data.created,
          updated: data.updated,
          errors:  data.errors,
          stopped: data.stopped,
          extraText: data.total ? `${data.total} rows` : '',
        });
      },

      onError: (msg) => {
        hide('btn-stop-notes-import');
        setText('notes-import-run-title', 'Import failed');
        $('notes-import-summary-box').innerHTML = `
          <div class="alert alert-danger">
            <span class="alert-icon">⚠️</span>
            <span>${esc(msg)}</span>
          </div>`;
        show('notes-import-summary-box');
        appendNotesLogEntry({ level: 'error', message: msg, ts: new Date().toISOString() });
      },

      onAbort: () => {
        hide('btn-stop-notes-import');
        setText('notes-import-run-title', 'Import stopped');
        setNotesImportProgress('Import stopped', 100);
        appendNotesLogEntry({ level: 'warn', message: 'Import stopped by user', ts: new Date().toISOString() });
        const c = appendNotesLogEntry.getCounts();
        renderImportComplete($('notes-import-summary-box'), {
          stopped: true,
          created: 0, updated: 0,
          errors:  c.error,
          extraText: `${c.success} rows processed`,
        });
      },
    }
  );
}

function setNotesImportProgress(msg, pct) {
  setText('notes-import-progress-msg', msg);
  setText('notes-import-progress-pct', `${pct}%`);
  $('notes-import-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

$('btn-stop-notes-import').addEventListener('click', () => {
  if (notesImportController) {
    notesImportController.abort();
    notesImportController = null;
  }
  // onAbort handler above fires after abort and renders the summary
  hide('btn-stop-notes-import');
});

// ══════════════════════════════════════════════════════════
// NOTES — Delete from CSV
// ══════════════════════════════════════════════════════════

let notesDeleteParsedCSV = null;
let notesDeleteController = null;

const notesDeleteDropzone  = $('notes-delete-dropzone');
const notesDeleteFileInput = $('notes-delete-file-input');

notesDeleteDropzone.addEventListener('click', () => notesDeleteFileInput.click());
notesDeleteFileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadNotesDeleteCSV(e.target.files[0]);
});
notesDeleteDropzone.addEventListener('dragover', (e) => { e.preventDefault(); notesDeleteDropzone.classList.add('drag-over'); });
notesDeleteDropzone.addEventListener('dragleave', () => notesDeleteDropzone.classList.remove('drag-over'));
notesDeleteDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  notesDeleteDropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadNotesDeleteCSV(file);
});

function loadNotesDeleteCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const headers = parseCSVHeaders(text);
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) { alert('CSV appears empty.'); return; }
    notesDeleteParsedCSV = { raw: text, headers, rowCount };

    // Populate column picker
    const sel = $('notes-delete-uuid-column');
    sel.innerHTML = headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');

    // Auto-select pb_id column
    const auto = headers.find((h) => ['pb_id', 'pb note id', 'id', 'uuid'].includes(h.toLowerCase()));
    if (auto) sel.value = auto;

    setText('notes-delete-csv-subtitle', `${notesDeleteParsedCSV.rowCount} rows · ${headers.length} columns`);
    updateDeleteCSVPreview();
    show('notes-delete-csv-step-confirm');
  };
  reader.readAsText(file);
}

$('notes-delete-uuid-column').addEventListener('change', updateDeleteCSVPreview);

function updateDeleteCSVPreview() {
  const col = $('notes-delete-uuid-column').value;
  if (!notesDeleteParsedCSV || !col) return;

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const headers = parseCSVHeaders(notesDeleteParsedCSV.raw);
  const colIdx = headers.indexOf(col);
  if (colIdx < 0) return;

  // Extract first 5 valid UUIDs for preview
  const lines = notesDeleteParsedCSV.raw.trim().split('\n').slice(1);
  const uuids = lines
    .map((l) => l.split(',')[colIdx]?.trim().replace(/^"|"$/g, ''))
    .filter((v) => UUID_PATTERN.test(v))
    .slice(0, 5);

  const preview = $('notes-delete-csv-preview');
  if (uuids.length > 0) {
    preview.textContent = `First UUIDs: ${uuids.join(', ')}${lines.length > 5 ? ', …' : ''}`;
    show('notes-delete-csv-preview');
  } else {
    preview.textContent = 'No valid UUIDs found in this column.';
    show('notes-delete-csv-preview');
  }
}

$('btn-notes-delete-reupload').addEventListener('click', () => {
  notesDeleteParsedCSV = null;
  notesDeleteFileInput.value = '';
  hide('notes-delete-csv-step-confirm');
  hide('notes-delete-csv-step-run');
});

$('btn-notes-delete-csv-run').addEventListener('click', () => requireToken(() => {
  const col = $('notes-delete-uuid-column').value;
  if (!col || !notesDeleteParsedCSV) return;
  startNotesDeleteCSV(col);
}));

function startNotesDeleteCSV(uuidColumn) {
  hide('notes-delete-csv-step-confirm');
  show('notes-delete-csv-step-run');
  setText('notes-delete-csv-run-title', 'Deleting notes…');
  show('notes-delete-csv-running');
  hide('notes-delete-csv-results');
  setNotesDeleteCSVProgress('Starting…', 0);

  $('notes-delete-csv-log-entries').innerHTML = '';
  hide('notes-delete-csv-live-log');

  show('btn-stop-notes-delete-csv');

  notesDeleteController = subscribeSSE(
    '/api/notes/delete/by-csv',
    { csvText: notesDeleteParsedCSV.raw, uuidColumn },
    {
      onProgress: ({ message, percent }) => setNotesDeleteCSVProgress(message, percent),

      onLog: (entry) => {
        const logEl = $('notes-delete-csv-live-log');
        const entries = $('notes-delete-csv-log-entries');
        if (logEl.classList.contains('hidden')) show('notes-delete-csv-live-log');
        const e = document.createElement('div');
        e.className = `log-entry ${entry.level}`;
        e.innerHTML = `<span class="log-msg">${esc(entry.message)}</span>`;
        entries.appendChild(e);
        entries.scrollTop = entries.scrollHeight;
      },

      onComplete: (data) => {
        hide('btn-stop-notes-delete-csv');
        hide('notes-delete-csv-running');
        show('notes-delete-csv-results');
        setText('notes-delete-csv-run-title', 'Deletion complete');
        const hasErrors = data.errors > 0;
        const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
        const icon = hasErrors ? '⚠️' : '✅';
        $('notes-delete-csv-summary-alert').innerHTML = `
          <div class="alert ${alertClass}"><span class="alert-icon">${icon}</span>
          <span>${data.deleted} deleted · ${data.errors} error(s) · ${data.total} in CSV</span></div>`;
      },

      onError: (msg) => {
        hide('btn-stop-notes-delete-csv');
        hide('notes-delete-csv-running');
        show('notes-delete-csv-results');
        setText('notes-delete-csv-run-title', 'Deletion failed');
        $('notes-delete-csv-summary-alert').innerHTML = `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`;
      },
    }
  );
}

function setNotesDeleteCSVProgress(msg, pct) {
  setText('notes-delete-csv-progress-msg', msg);
  setText('notes-delete-csv-progress-pct', `${pct}%`);
  $('notes-delete-csv-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

$('btn-stop-notes-delete-csv').addEventListener('click', () => {
  if (notesDeleteController) { notesDeleteController.abort(); notesDeleteController = null; }
  hide('btn-stop-notes-delete-csv');
});

$('btn-notes-delete-csv-again').addEventListener('click', () => {
  notesDeleteParsedCSV = null;
  notesDeleteFileInput.value = '';
  hide('notes-delete-csv-step-confirm');
  hide('notes-delete-csv-step-run');
});

// ══════════════════════════════════════════════════════════
// NOTES — Delete All
// ══════════════════════════════════════════════════════════

let notesDeleteAllController = null;

$('notes-delete-all-confirm-input').addEventListener('input', (e) => {
  $('btn-notes-delete-all-run').disabled = e.target.value.trim() !== 'DELETE';
});

$('btn-notes-delete-all-run').addEventListener('click', () => requireToken(() => {
  if ($('notes-delete-all-confirm-input').value.trim() !== 'DELETE') return;
  startNotesDeleteAll();
}));

function startNotesDeleteAll() {
  hide('notes-delete-all-idle');
  show('notes-delete-all-running');
  hide('notes-delete-all-results');
  setNotesDeleteAllProgress('Starting…', 0);

  $('notes-delete-all-log-entries').innerHTML = '';
  hide('notes-delete-all-live-log');

  notesDeleteAllController = subscribeSSE(
    '/api/notes/delete/all',
    {},
    {
      onProgress: ({ message, percent }) => setNotesDeleteAllProgress(message, percent),

      onLog: (entry) => {
        const logEl = $('notes-delete-all-live-log');
        const entries = $('notes-delete-all-log-entries');
        if (logEl.classList.contains('hidden')) show('notes-delete-all-live-log');
        const e = document.createElement('div');
        e.className = `log-entry ${entry.level}`;
        e.innerHTML = `<span class="log-msg">${esc(entry.message)}</span>`;
        entries.appendChild(e);
        entries.scrollTop = entries.scrollHeight;
      },

      onComplete: (data) => {
        hide('notes-delete-all-running');
        show('notes-delete-all-results');
        const hasErrors = data.errors > 0;
        const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
        const icon = hasErrors ? '⚠️' : '✅';
        $('notes-delete-all-summary-alert').innerHTML = `
          <div class="alert ${alertClass}"><span class="alert-icon">${icon}</span>
          <span>${data.deleted} notes deleted · ${data.errors} error(s)</span></div>`;
      },

      onError: (msg) => {
        hide('notes-delete-all-running');
        show('notes-delete-all-results');
        $('notes-delete-all-summary-alert').innerHTML = `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`;
      },
    }
  );
}

function setNotesDeleteAllProgress(msg, pct) {
  setText('notes-delete-all-progress-msg', msg);
  setText('notes-delete-all-progress-pct', `${pct}%`);
  $('notes-delete-all-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

$('btn-notes-delete-all-again').addEventListener('click', () => {
  $('notes-delete-all-confirm-input').value = '';
  $('btn-notes-delete-all-run').disabled = true;
  hide('notes-delete-all-running');
  hide('notes-delete-all-results');
  show('notes-delete-all-idle');
});

// ══════════════════════════════════════════════════════════
// COMPANIES — Delete from CSV
// ══════════════════════════════════════════════════════════

let companiesDeleteParsedCSV = null;
let companiesDeleteController = null;

const companiesDeleteDropzone  = $('companies-delete-dropzone');
const companiesDeleteFileInput = $('companies-delete-file-input');

companiesDeleteDropzone.addEventListener('click', () => companiesDeleteFileInput.click());
companiesDeleteFileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadCompaniesDeleteCSV(e.target.files[0]);
});
companiesDeleteDropzone.addEventListener('dragover', (e) => { e.preventDefault(); companiesDeleteDropzone.classList.add('drag-over'); });
companiesDeleteDropzone.addEventListener('dragleave', () => companiesDeleteDropzone.classList.remove('drag-over'));
companiesDeleteDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  companiesDeleteDropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadCompaniesDeleteCSV(file);
});

function loadCompaniesDeleteCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const headers = parseCSVHeaders(text);
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) { alert('CSV appears empty.'); return; }
    companiesDeleteParsedCSV = { raw: text, headers, rowCount };

    // Populate column picker
    const sel = $('companies-delete-uuid-column');
    sel.innerHTML = headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');

    // Auto-select id/pb_id/uuid column — export CSV uses 'id' as the UUID column
    const auto = headers.find((h) => ['pb_id', 'id', 'uuid'].includes(h.toLowerCase()));
    if (auto) sel.value = auto;

    setText('companies-delete-csv-subtitle', `${companiesDeleteParsedCSV.rowCount} rows · ${headers.length} columns`);
    updateCompaniesDeleteCSVPreview();
    show('companies-delete-csv-step-confirm');
  };
  reader.readAsText(file);
}

$('companies-delete-uuid-column').addEventListener('change', updateCompaniesDeleteCSVPreview);

function updateCompaniesDeleteCSVPreview() {
  const col = $('companies-delete-uuid-column').value;
  if (!companiesDeleteParsedCSV || !col) return;

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const headers = parseCSVHeaders(companiesDeleteParsedCSV.raw);
  const colIdx = headers.indexOf(col);
  if (colIdx < 0) return;

  // Extract first 5 valid UUIDs for preview
  const lines = companiesDeleteParsedCSV.raw.trim().split('\n').slice(1);
  const uuids = lines
    .map((l) => l.split(',')[colIdx]?.trim().replace(/^"|"$/g, ''))
    .filter((v) => UUID_PATTERN.test(v))
    .slice(0, 5);

  const preview = $('companies-delete-csv-preview');
  if (uuids.length > 0) {
    preview.textContent = `First UUIDs: ${uuids.join(', ')}${lines.length > 5 ? ', …' : ''}`;
    show('companies-delete-csv-preview');
  } else {
    preview.textContent = 'No valid UUIDs found in this column.';
    show('companies-delete-csv-preview');
  }
}

$('btn-companies-delete-reupload').addEventListener('click', () => {
  companiesDeleteParsedCSV = null;
  companiesDeleteFileInput.value = '';
  hide('companies-delete-csv-step-confirm');
  hide('companies-delete-csv-step-run');
});

$('btn-companies-delete-csv-run').addEventListener('click', () => requireToken(() => {
  const col = $('companies-delete-uuid-column').value;
  if (!col || !companiesDeleteParsedCSV) return;
  startCompaniesDeleteCSV(col);
}));

function startCompaniesDeleteCSV(uuidColumn) {
  hide('companies-delete-csv-step-confirm');
  show('companies-delete-csv-step-run');
  setText('companies-delete-csv-run-title', 'Deleting companies…');
  show('companies-delete-csv-running');
  hide('companies-delete-csv-results');
  setCompaniesDeleteCSVProgress('Starting…', 0);

  $('companies-delete-csv-log-entries').innerHTML = '';
  hide('companies-delete-csv-live-log');

  show('btn-stop-companies-delete-csv');

  companiesDeleteController = subscribeSSE(
    '/api/companies/delete/by-csv',
    { csvText: companiesDeleteParsedCSV.raw, uuidColumn },
    {
      onProgress: ({ message, percent }) => setCompaniesDeleteCSVProgress(message, percent),

      onLog: (entry) => {
        const logEl = $('companies-delete-csv-live-log');
        const entries = $('companies-delete-csv-log-entries');
        if (logEl.classList.contains('hidden')) show('companies-delete-csv-live-log');
        const e = document.createElement('div');
        e.className = `log-entry ${entry.level}`;
        e.innerHTML = `<span class="log-msg">${esc(entry.message)}</span>`;
        entries.appendChild(e);
        entries.scrollTop = entries.scrollHeight;
      },

      onComplete: (data) => {
        hide('btn-stop-companies-delete-csv');
        hide('companies-delete-csv-running');
        show('companies-delete-csv-results');
        setText('companies-delete-csv-run-title', 'Deletion complete');
        const hasErrors = data.errors > 0;
        const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
        const icon = hasErrors ? '⚠️' : '✅';
        $('companies-delete-csv-summary-alert').innerHTML = `
          <div class="alert ${alertClass}"><span class="alert-icon">${icon}</span>
          <span>${data.deleted} deleted · ${data.errors} error(s) · ${data.total} in CSV</span></div>`;
      },

      onError: (msg) => {
        hide('btn-stop-companies-delete-csv');
        hide('companies-delete-csv-running');
        show('companies-delete-csv-results');
        setText('companies-delete-csv-run-title', 'Deletion failed');
        $('companies-delete-csv-summary-alert').innerHTML = `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`;
      },
    }
  );
}

function setCompaniesDeleteCSVProgress(msg, pct) {
  setText('companies-delete-csv-progress-msg', msg);
  setText('companies-delete-csv-progress-pct', `${pct}%`);
  $('companies-delete-csv-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

$('btn-stop-companies-delete-csv').addEventListener('click', () => {
  if (companiesDeleteController) { companiesDeleteController.abort(); companiesDeleteController = null; }
  hide('btn-stop-companies-delete-csv');
});

$('btn-companies-delete-csv-again').addEventListener('click', () => {
  companiesDeleteParsedCSV = null;
  companiesDeleteFileInput.value = '';
  hide('companies-delete-csv-step-confirm');
  hide('companies-delete-csv-step-run');
});

// ══════════════════════════════════════════════════════════
// COMPANIES — Delete All
// ══════════════════════════════════════════════════════════

let companiesDeleteAllController = null;

$('companies-delete-all-confirm-input').addEventListener('input', (e) => {
  $('btn-companies-delete-all-run').disabled = e.target.value.trim() !== 'DELETE';
});

$('btn-companies-delete-all-run').addEventListener('click', () => requireToken(() => {
  if ($('companies-delete-all-confirm-input').value.trim() !== 'DELETE') return;
  startCompaniesDeleteAll();
}));

function startCompaniesDeleteAll() {
  hide('companies-delete-all-idle');
  show('companies-delete-all-running');
  hide('companies-delete-all-results');
  setCompaniesDeleteAllProgress('Starting…', 0);

  $('companies-delete-all-log-entries').innerHTML = '';
  hide('companies-delete-all-live-log');

  companiesDeleteAllController = subscribeSSE(
    '/api/companies/delete/all',
    {},
    {
      onProgress: ({ message, percent }) => setCompaniesDeleteAllProgress(message, percent),

      onLog: (entry) => {
        const logEl = $('companies-delete-all-live-log');
        const entries = $('companies-delete-all-log-entries');
        if (logEl.classList.contains('hidden')) show('companies-delete-all-live-log');
        const e = document.createElement('div');
        e.className = `log-entry ${entry.level}`;
        e.innerHTML = `<span class="log-msg">${esc(entry.message)}</span>`;
        entries.appendChild(e);
        entries.scrollTop = entries.scrollHeight;
      },

      onComplete: (data) => {
        hide('companies-delete-all-running');
        show('companies-delete-all-results');
        const hasErrors = data.errors > 0;
        const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
        const icon = hasErrors ? '⚠️' : '✅';
        $('companies-delete-all-summary-alert').innerHTML = `
          <div class="alert ${alertClass}"><span class="alert-icon">${icon}</span>
          <span>${data.deleted} companies deleted · ${data.errors} error(s)</span></div>`;
      },

      onError: (msg) => {
        hide('companies-delete-all-running');
        show('companies-delete-all-results');
        $('companies-delete-all-summary-alert').innerHTML = `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`;
      },
    }
  );
}

function setCompaniesDeleteAllProgress(msg, pct) {
  setText('companies-delete-all-progress-msg', msg);
  setText('companies-delete-all-progress-pct', `${pct}%`);
  $('companies-delete-all-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

$('btn-companies-delete-all-again').addEventListener('click', () => {
  $('companies-delete-all-confirm-input').value = '';
  $('btn-companies-delete-all-run').disabled = true;
  hide('companies-delete-all-running');
  hide('companies-delete-all-results');
  show('companies-delete-all-idle');
});

// ══════════════════════════════════════════════════════════
// NOTES — Migration Prep
// ══════════════════════════════════════════════════════════

let notesMigrateParsedCSV = null;
let notesMigrateResultCSV = null;
let notesMigrateFilename  = 'notes-prepared.csv';

const notesMigrateDropzone  = $('notes-migrate-dropzone');
const notesMigrateFileInput = $('notes-migrate-file-input');

notesMigrateDropzone.addEventListener('click', () => notesMigrateFileInput.click());
notesMigrateFileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) loadNotesMigrateCSV(e.target.files[0]);
});
notesMigrateDropzone.addEventListener('dragover', (e) => { e.preventDefault(); notesMigrateDropzone.classList.add('drag-over'); });
notesMigrateDropzone.addEventListener('dragleave', () => notesMigrateDropzone.classList.remove('drag-over'));
notesMigrateDropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  notesMigrateDropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) loadNotesMigrateCSV(file);
});

function loadNotesMigrateCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) { alert('CSV appears empty.'); return; }
    notesMigrateParsedCSV = { raw: text, rowCount };
    show('notes-migrate-form');
    notesMigrateDropzone.querySelector('.dropzone-label').textContent = `${file.name} (${rowCount} rows)`;
  };
  reader.readAsText(file);
}

$('btn-notes-migrate-run').addEventListener('click', () => requireToken(async () => {
  if (!notesMigrateParsedCSV) { alert('Upload a CSV first.'); return; }
  const sourceOriginName = $('notes-migrate-source-name').value.trim();
  if (!sourceOriginName) { alert('Enter a migration source name.'); return; }

  $('btn-notes-migrate-run').disabled = true;

  try {
    const res = await fetch('/api/notes/migrate-prep', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ csvText: notesMigrateParsedCSV.raw, sourceOriginName }),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      hide('notes-migrate-idle');
      setText('notes-migrate-error-msg', data.error || `HTTP ${res.status}`);
      show('notes-migrate-error');
      return;
    }

    notesMigrateResultCSV = data.csv;
    const date = new Date().toISOString().slice(0, 10);
    notesMigrateFilename = `notes-migration-${sourceOriginName.replace(/[^a-zA-Z0-9-_]/g, '_')}-${date}.csv`;

    hide('notes-migrate-idle');
    hide('notes-migrate-error');
    setText('notes-migrate-done-msg', `${data.count} notes prepared for migration. Download and import into the target workspace.`);
    show('notes-migrate-done');
  } catch (e) {
    setText('notes-migrate-error-msg', e.message);
    show('notes-migrate-error');
    hide('notes-migrate-done');
  } finally {
    $('btn-notes-migrate-run').disabled = false;
  }
}));

$('btn-notes-migrate-download').addEventListener('click', () => {
  if (notesMigrateResultCSV) triggerDownload(new Blob([notesMigrateResultCSV], { type: 'text/csv;charset=utf-8;' }), notesMigrateFilename);
});

$('btn-notes-migrate-again').addEventListener('click', () => {
  notesMigrateParsedCSV = null;
  notesMigrateResultCSV = null;
  notesMigrateFileInput.value = '';
  notesMigrateDropzone.querySelector('.dropzone-label').textContent = 'Drop your export CSV here';
  hide('notes-migrate-form');
  hide('notes-migrate-done');
  hide('notes-migrate-error');
  show('notes-migrate-idle');
});

$('btn-notes-migrate-retry').addEventListener('click', () => {
  hide('notes-migrate-error');
  show('notes-migrate-idle');
});

// ── Run ─────────────────────────────────────────────────────
boot();
