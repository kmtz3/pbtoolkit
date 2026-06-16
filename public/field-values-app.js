/* =========================================================
   PBToolkit — Tag Values module
   Manages delete operations for Tags / MultiSelect / SingleSelect
   custom field values.
   ========================================================= */

// ── Module state ─────────────────────────────────────────────────────────────
let _fvFields = [];           // [{ id, name, displayType, entityTypes }]
let _fvSelectedFieldId = '';  // currently selected field id (shared across views)
let _fvValues = [];           // [{ id, name }] — loaded for pick-mode checklist
let _fvCheckedIds = new Set();// checked value IDs in pick mode
let _fvDeleteCtrl = null;     // SSE abort controller
let _fvInitDone = false;      // initFieldValuesModule() guard

// CSV modes
let _fvCsvParsed = null;      // { raw, headers, rowCount } for delete-by-csv
let _fvClearCsv = null;       // wireDropzone clear fn
let _fvDiffParsed = null;     // { raw, headers, rowCount } for delete-by-diff
let _fvClearDiff = null;      // wireDropzone clear fn

// Live editor
let _fvLeValues = [];         // [{ id, name }] — live editor value list
let _fvLeEditingId = null;    // value ID currently being renamed (null if none)
let _fvLeLoading = false;     // live editor network-in-flight flag
let _fvLeSearch = '';         // current search filter text

// ── Module constants ──────────────────────────────────────────────────────────
const FV_FIELD_PICKER_IDS = [
  'fv-field-select-all',
  'fv-field-select-csv',
  'fv-field-select-diff',
  'fv-field-select-pick',
  'fv-field-select-pick-2',
  'fv-field-select-le',
];
const FV_TAG_NAME_HINTS = ['name', 'tag', 'value', 'tag_name', 'tag_value'];

// ── DOM shortcuts ─────────────────────────────────────────────────────────────
function fv$(id)       { return document.getElementById(id); }
function fvShow(id)    { const el = fv$(id); if (el) el.classList.remove('hidden'); }
function fvHide(id)    { const el = fv$(id); if (el) el.classList.add('hidden'); }
function fvText(id, t) { const el = fv$(id); if (el) el.textContent = t; }
function fvHtml(id, h) { const el = fv$(id); if (el) el.innerHTML = h; }

// ── Reset ─────────────────────────────────────────────────────────────────────
function fvResetPickers() {
  _fvFields = [];
  _fvSelectedFieldId = '';
  FV_FIELD_PICKER_IDS.forEach((id) => {
    const el = fv$(id);
    if (el) { el.innerHTML = '<option value="">— connect to load fields —</option>'; el.disabled = false; }
  });
  const errEl = fv$('fv-fields-load-error');
  if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
  fvUpdateDeleteAllHint();
}

function resetFieldValuesState() {
  if (_fvDeleteCtrl)  { _fvDeleteCtrl.abort(); _fvDeleteCtrl = null; }
  if (_fvClearCsv)    { _fvClearCsv(); _fvClearCsv = null; }
  if (_fvClearDiff)   { _fvClearDiff(); _fvClearDiff = null; }
  _fvCsvParsed = null;
  _fvDiffParsed = null;
  _fvValues = [];
  _fvCheckedIds = new Set();
  fvResetPickers();
  fvLeReset();
}

// ── Field picker ──────────────────────────────────────────────────────────────

function fvPopulateFieldPicker(selectId) {
  const sel = fv$(selectId);
  if (!sel) return;
  const prev = sel.value || _fvSelectedFieldId;
  sel.innerHTML = '';

  if (!_fvFields.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No select-type fields found';
    sel.appendChild(opt);
    return;
  }

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— choose a field —';
  sel.appendChild(placeholder);

  for (const f of _fvFields) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = `${f.name} [${f.displayType}]`;
    sel.appendChild(opt);
  }

  if (prev && [...sel.options].some((o) => o.value === prev)) {
    sel.value = prev;
  }
}

function fvSyncFieldPickers() {
  FV_FIELD_PICKER_IDS.forEach(fvPopulateFieldPicker);
  fvUpdateDeleteAllHint();
}

async function fvLoadFields() {
  if (_fvFields.length) {
    fvSyncFieldPickers();
    return;
  }
  FV_FIELD_PICKER_IDS.forEach((id) => {
    const el = fv$(id);
    if (el) { el.innerHTML = '<option value="">Loading fields…</option>'; el.disabled = true; }
  });
  try {
    const r = await fetch('/api/field-values/fields', { headers: buildHeaders() });
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      // No token yet — silently reset; pb:connected will retry after connect
      FV_FIELD_PICKER_IDS.forEach((id) => {
        const el = fv$(id);
        if (el) { el.innerHTML = '<option value="">— connect to load fields —</option>'; el.disabled = false; }
      });
      return;
    }
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load fields');
    _fvFields = data.fields || [];
    const errEl = fv$('fv-fields-load-error');
    if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
  } catch (err) {
    _fvFields = [];
    const errEl = fv$('fv-fields-load-error');
    if (errEl) {
      const msg = /token|auth|connect/i.test(err.message) ? 'Could not load fields — check your token and try again.' : `Could not load fields: ${err.message}`;
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
    }
  }
  FV_FIELD_PICKER_IDS.forEach((id) => {
    const el = fv$(id); if (el) el.disabled = false;
  });
  fvSyncFieldPickers();
}

function fvOnFieldChange(newId) {
  _fvSelectedFieldId = newId;
  fvSyncFieldPickers();
  fvUpdateDeleteAllHint();
  fvUpdateCsvRunBtn();
  fvUpdateDiffRunBtn();
  // Reset pick mode checklist when field changes
  _fvValues = [];
  _fvCheckedIds = new Set();
  fvHide('fv-pick-checklist-wrap');
  fvShow('fv-pick-idle');
  fvHide('fv-pick-running');
  fvHide('fv-pick-results');
  fvHide('fv-pick-load-error');
  // Reload live editor for new field
  if (newId) {
    requireToken(() => fvLeLoadValues());
  } else {
    fvLeReset();
  }
}

function fvUpdateDeleteAllHint() {
  const hint = fv$('fv-da-field-hint');
  if (!hint) return;
  const f = _fvFields.find((x) => x.id === _fvSelectedFieldId);
  if (f) {
    hint.textContent = `${f.displayType} · used by: ${f.entityTypes.join(', ')}`;
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
}

// ── Progress helper ────────────────────────────────────────────────────────────
function fvProgress(prefix, msg, pct) {
  const bar = fv$(prefix + '-progress-bar');
  if (bar) bar.style.width = Math.min(100, pct) + '%';
  fvText(prefix + '-progress-msg', msg);
  fvText(prefix + '-progress-pct', Math.round(pct) + '%');
}

// ── Generic SSE log helper ─────────────────────────────────────────────────────
function fvAppendLog(logWrapId, entriesId, entry) {
  const logEl = fv$(logWrapId);
  const entries = fv$(entriesId);
  if (!entries) return;
  if (logEl && logEl.classList.contains('hidden')) logEl.classList.remove('hidden');
  const e = document.createElement('div');
  e.className = `log-entry ${entry.level}`;
  e.innerHTML = `<span class="log-msg">${esc(entry.message)}</span>`;
  entries.appendChild(e);
  entries.scrollTop = entries.scrollHeight;
}

// ── Summary builder ────────────────────────────────────────────────────────────
function fvBuildSummary(data, mode) {
  if (data.stopped) {
    return `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Stopped. ${data.deleted || 0} deleted · ${data.errors || 0} error(s).</span></div>`;
  }
  const hasErrors = (data.errors || 0) > 0;
  const cls = hasErrors ? 'alert-warn' : 'alert-ok';
  const icon = hasErrors ? '⚠️' : '✅';
  let msg = `${data.deleted || 0} deleted · ${data.errors || 0} error(s)`;
  if (mode === 'diff' && data.kept != null) msg += ` · ${data.kept} kept`;
  if (mode === 'csv' && data.unmatched != null) msg += ` · ${data.unmatched} CSV names had no match`;
  return `<div class="alert ${cls}"><span class="alert-icon">${icon}</span><span>${msg}</span></div>`;
}

// ════════════════════════════════════════════════════════════════════════════════
// DELETE ALL
// ════════════════════════════════════════════════════════════════════════════════

function fvResetDeleteAll() {
  fvShow('fv-da-idle');
  fvHide('fv-da-running');
  fvHide('fv-da-results');
  const confirmInput = fv$('fv-da-confirm-input');
  if (confirmInput) confirmInput.value = '';
  const runBtn = fv$('btn-fv-da-run');
  if (runBtn) runBtn.disabled = true;
}

function fvStartDeleteAll() {
  if (!_fvSelectedFieldId) { showAlert('Please select a field first.'); return; }

  fvHide('fv-da-idle');
  fvShow('fv-da-running');
  fvHide('fv-da-results');
  fvProgress('fv-da', 'Starting…', 0);
  const logEntries = fv$('fv-da-log-entries');
  if (logEntries) logEntries.innerHTML = '';
  fvHide('fv-da-live-log');

  _fvDeleteCtrl = subscribeSSE(
    '/api/field-values/delete/all',
    { fieldId: _fvSelectedFieldId },
    {
      onProgress: ({ message, percent }) => fvProgress('fv-da', message, percent),
      onLog:      (entry) => fvAppendLog('fv-da-live-log', 'fv-da-log-entries', entry),
      onComplete: (data) => {
        fvHide('fv-da-running');
        fvShow('fv-da-results');
        fvHtml('fv-da-summary', fvBuildSummary(data, 'all'));
        _fvDeleteCtrl = null;
      },
      onError: (msg) => {
        fvHide('fv-da-running');
        fvShow('fv-da-results');
        fvHtml('fv-da-summary', `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`);
        _fvDeleteCtrl = null;
      },
      onAbort: () => {
        fvHide('fv-da-running');
        fvShow('fv-da-results');
        fvHtml('fv-da-summary', `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Deletion stopped.</span></div>`);
        _fvDeleteCtrl = null;
      },
    }
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// DELETE FROM CSV
// ════════════════════════════════════════════════════════════════════════════════

function fvResetDeleteCsv() {
  fvShow('fv-csv-idle');
  fvHide('fv-csv-running');
  fvHide('fv-csv-results');
  _fvCsvParsed = null;
  if (_fvClearCsv) { _fvClearCsv(); _fvClearCsv = null; }
  const colWrap = fv$('fv-csv-column-wrap');
  if (colWrap) colWrap.style.display = 'none';
  fvUpdateCsvRunBtn();
}

function fvUpdateCsvRunBtn() {
  const btn = fv$('btn-fv-csv-run');
  if (btn) btn.disabled = !(_fvSelectedFieldId && _fvCsvParsed);
}

// Shared CSV loader for delete-by-csv and delete-by-diff submodules.
function fvLoadCsvForMode(file, opts) {
  const { selectId, colWrapId, subtitleId, onParsed, updateBtn } = opts;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const headers = parseCSVHeaders(text);
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) { showAlert('CSV appears empty.'); return; }
    onParsed({ raw: text, headers, rowCount });

    const sel = fv$(selectId);
    if (sel) {
      sel.innerHTML = headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
      const auto = headers.find((h) => FV_TAG_NAME_HINTS.includes(h.toLowerCase()));
      if (auto) sel.value = auto;
    }

    const colWrap = fv$(colWrapId);
    if (colWrap) colWrap.style.display = '';
    fvText(subtitleId, `${rowCount.toLocaleString()} rows · ${headers.length} columns`);
    updateBtn();
  };
  reader.readAsText(file);
}

function fvLoadCsvFile(file) {
  fvLoadCsvForMode(file, {
    selectId: 'fv-csv-column-select',
    colWrapId: 'fv-csv-column-wrap',
    subtitleId: 'fv-csv-subtitle',
    onParsed: (p) => { _fvCsvParsed = p; },
    updateBtn: fvUpdateCsvRunBtn,
  });
}

function fvStartDeleteCsv() {
  if (!_fvSelectedFieldId) { showAlert('Please select a field first.'); return; }
  if (!_fvCsvParsed) { showAlert('Please upload a CSV first.'); return; }

  const column = fv$('fv-csv-column-select')?.value;
  if (!column) { showAlert('Please select a column.'); return; }

  fvHide('fv-csv-idle');
  fvShow('fv-csv-running');
  fvHide('fv-csv-results');
  fvProgress('fv-csv', 'Starting…', 0);
  const logEntries = fv$('fv-csv-log-entries');
  if (logEntries) logEntries.innerHTML = '';
  fvHide('fv-csv-live-log');

  _fvDeleteCtrl = subscribeSSE(
    '/api/field-values/delete/by-csv',
    { fieldId: _fvSelectedFieldId, csvText: _fvCsvParsed.raw, column },
    {
      onProgress: ({ message, percent }) => fvProgress('fv-csv', message, percent),
      onLog:      (entry) => fvAppendLog('fv-csv-live-log', 'fv-csv-log-entries', entry),
      onComplete: (data) => {
        fvHide('fv-csv-running');
        fvShow('fv-csv-results');
        fvHtml('fv-csv-summary', fvBuildSummary(data, 'csv'));
        _fvDeleteCtrl = null;
      },
      onError: (msg) => {
        fvHide('fv-csv-running');
        fvShow('fv-csv-results');
        fvHtml('fv-csv-summary', `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`);
        _fvDeleteCtrl = null;
      },
      onAbort: () => {
        fvHide('fv-csv-running');
        fvShow('fv-csv-results');
        fvHtml('fv-csv-summary', `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Deletion stopped.</span></div>`);
        _fvDeleteCtrl = null;
      },
    }
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// DIFF BY CSV
// ════════════════════════════════════════════════════════════════════════════════

function fvResetDeleteDiff() {
  fvShow('fv-diff-idle');
  fvHide('fv-diff-running');
  fvHide('fv-diff-results');
  _fvDiffParsed = null;
  if (_fvClearDiff) { _fvClearDiff(); _fvClearDiff = null; }
  const colWrap = fv$('fv-diff-column-wrap');
  if (colWrap) colWrap.style.display = 'none';
  fvUpdateDiffRunBtn();
}

function fvUpdateDiffRunBtn() {
  const btn = fv$('btn-fv-diff-run');
  if (btn) btn.disabled = !(_fvSelectedFieldId && _fvDiffParsed);
}

function fvLoadDiffFile(file) {
  fvLoadCsvForMode(file, {
    selectId: 'fv-diff-column-select',
    colWrapId: 'fv-diff-column-wrap',
    subtitleId: 'fv-diff-subtitle',
    onParsed: (p) => { _fvDiffParsed = p; },
    updateBtn: fvUpdateDiffRunBtn,
  });
}

function fvStartDeleteDiff() {
  if (!_fvSelectedFieldId) { showAlert('Please select a field first.'); return; }
  if (!_fvDiffParsed) { showAlert('Please upload a CSV first.'); return; }

  const column = fv$('fv-diff-column-select')?.value;
  if (!column) { showAlert('Please select a column.'); return; }

  fvHide('fv-diff-idle');
  fvShow('fv-diff-running');
  fvHide('fv-diff-results');
  fvProgress('fv-diff', 'Starting…', 0);
  const logEntries = fv$('fv-diff-log-entries');
  if (logEntries) logEntries.innerHTML = '';
  fvHide('fv-diff-live-log');

  _fvDeleteCtrl = subscribeSSE(
    '/api/field-values/delete/by-diff',
    { fieldId: _fvSelectedFieldId, csvText: _fvDiffParsed.raw, column },
    {
      onProgress: ({ message, percent }) => fvProgress('fv-diff', message, percent),
      onLog:      (entry) => fvAppendLog('fv-diff-live-log', 'fv-diff-log-entries', entry),
      onComplete: (data) => {
        fvHide('fv-diff-running');
        fvShow('fv-diff-results');
        fvHtml('fv-diff-summary', fvBuildSummary(data, 'diff'));
        _fvDeleteCtrl = null;
      },
      onError: (msg) => {
        fvHide('fv-diff-running');
        fvShow('fv-diff-results');
        fvHtml('fv-diff-summary', `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`);
        _fvDeleteCtrl = null;
      },
      onAbort: () => {
        fvHide('fv-diff-running');
        fvShow('fv-diff-results');
        fvHtml('fv-diff-summary', `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Deletion stopped.</span></div>`);
        _fvDeleteCtrl = null;
      },
    }
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// DELETE BY SELECTING (pick mode)
// ════════════════════════════════════════════════════════════════════════════════

function fvResetDeletePick() {
  fvShow('fv-pick-idle');
  fvHide('fv-pick-checklist-wrap');
  fvHide('fv-pick-running');
  fvHide('fv-pick-results');
  fvHide('fv-pick-load-error');
  _fvValues = [];
  _fvCheckedIds = new Set();
}

async function fvLoadPickValues() {
  if (!_fvSelectedFieldId) { showAlert('Please select a field first.'); return; }

  fvHide('fv-pick-load-error');
  const loadBtn = fv$('btn-fv-pick-load');
  if (loadBtn) { loadBtn.disabled = true; loadBtn.textContent = 'Loading…'; }

  try {
    const r = await fetch('/api/field-values/values', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ fieldId: _fvSelectedFieldId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load values');
    _fvValues = data.values || [];
    _fvCheckedIds = new Set();
    fvBuildChecklist();
    fvHide('fv-pick-idle');
    fvShow('fv-pick-checklist-wrap');
  } catch (err) {
    fvShow('fv-pick-load-error');
    fvText('fv-pick-load-error-msg', err.message);
  } finally {
    if (loadBtn) { loadBtn.disabled = false; loadBtn.textContent = 'Load values'; }
  }
}

function fvBuildChecklist() {
  const listEl = fv$('fv-pick-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!_fvValues.length) {
    listEl.innerHTML = '<div style="padding:10px 12px;font-size:13px;color:var(--c-muted)">No values found for this field.</div>';
    fvUpdatePickDeleteBtn();
    return;
  }

  for (const v of _fvValues) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = v.id;
    cb.dataset.id = v.id;
    cb.dataset.name = v.name;
    cb.checked = _fvCheckedIds.has(v.id);
    cb.addEventListener('change', () => {
      if (cb.checked) _fvCheckedIds.add(v.id);
      else _fvCheckedIds.delete(v.id);
      fvUpdatePickDeleteBtn();
    });
    const span = document.createElement('span');
    span.textContent = v.name;
    label.appendChild(cb);
    label.appendChild(span);
    listEl.appendChild(label);
  }

  fvUpdatePickDeleteBtn();
}

function fvUpdatePickDeleteBtn() {
  const n = _fvCheckedIds.size;
  const btn = fv$('btn-fv-pick-delete');
  if (btn) {
    btn.disabled = n === 0;
    btn.textContent = n > 0 ? `🗑 Delete selected (${n})` : '🗑 Delete selected (0)';
  }
  fvText('fv-pick-count', `${n} selected`);
}

function fvPickSelectAll() {
  _fvCheckedIds = new Set(_fvValues.map((v) => v.id));
  fvBuildChecklist();
}

function fvPickDeselectAll() {
  _fvCheckedIds = new Set();
  fvBuildChecklist();
}

function fvPickInvert() {
  const newSet = new Set();
  for (const v of _fvValues) {
    if (!_fvCheckedIds.has(v.id)) newSet.add(v.id);
  }
  _fvCheckedIds = newSet;
  fvBuildChecklist();
}

function fvStartDeletePick() {
  if (!_fvSelectedFieldId) { showAlert('No field selected.'); return; }
  if (!_fvCheckedIds.size) { showAlert('No values selected.'); return; }

  const values = _fvValues.filter((v) => _fvCheckedIds.has(v.id)).map((v) => ({ id: v.id, name: v.name }));

  fvHide('fv-pick-checklist-wrap');
  fvHide('fv-pick-idle');
  fvShow('fv-pick-running');
  fvHide('fv-pick-results');
  fvProgress('fv-pick', 'Starting…', 0);
  const logEntries = fv$('fv-pick-log-entries');
  if (logEntries) logEntries.innerHTML = '';
  fvHide('fv-pick-live-log');

  _fvDeleteCtrl = subscribeSSE(
    '/api/field-values/delete/by-ids',
    { fieldId: _fvSelectedFieldId, values },
    {
      onProgress: ({ message, percent }) => fvProgress('fv-pick', message, percent),
      onLog:      (entry) => fvAppendLog('fv-pick-live-log', 'fv-pick-log-entries', entry),
      onComplete: (data) => {
        fvHide('fv-pick-running');
        fvShow('fv-pick-results');
        fvHtml('fv-pick-summary', fvBuildSummary(data, 'pick'));
        _fvDeleteCtrl = null;
        // Reset checklist state so user can reload with updated values
        _fvValues = [];
        _fvCheckedIds = new Set();
      },
      onError: (msg) => {
        fvHide('fv-pick-running');
        fvShow('fv-pick-results');
        fvHtml('fv-pick-summary', `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`);
        _fvDeleteCtrl = null;
      },
      onAbort: () => {
        fvHide('fv-pick-running');
        fvShow('fv-pick-results');
        fvHtml('fv-pick-summary', `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Deletion stopped.</span></div>`);
        _fvDeleteCtrl = null;
        _fvValues = [];
        _fvCheckedIds = new Set();
      },
    }
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// LIVE EDITOR — create / rename / delete values inline
// ════════════════════════════════════════════════════════════════════════════════

function fvLeSetStatus(type, msg) {
  const el = fv$('fv-le-add-status');
  if (!el) return;
  if (!type || !msg) { el.innerHTML = ''; return; }
  const icons = { ok: '✓', warn: '⚠️', error: '⚠️' };
  const cls   = { ok: 'alert-ok', warn: 'alert-warn', error: 'alert-danger' };
  el.innerHTML = `<div class="alert ${cls[type]}"><span class="alert-icon">${icons[type]}</span><span>${msg}</span></div>`;
}

function fvLeReset() {
  _fvLeValues = [];
  _fvLeEditingId = null;
  _fvLeLoading = false;
  _fvLeSearch = '';
  fvHide('fv-le-loading');
  fvHide('fv-le-error');
  fvHide('fv-le-loaded');
  fvHide('fv-le-empty');
  fvShow('fv-le-no-field');
  fvLeSetStatus('', '');
  const ta = fv$('fv-le-add-input');
  if (ta) ta.value = '';
  const si = fv$('fv-le-search');
  if (si) si.value = '';
}

async function fvLeLoadValues() {
  if (!_fvSelectedFieldId) { fvLeReset(); return; }
  if (_fvLeLoading) return;
  _fvLeLoading = true;
  _fvLeEditingId = null;

  fvHide('fv-le-no-field');
  fvHide('fv-le-error');
  fvHide('fv-le-loaded');
  fvShow('fv-le-loading');

  try {
    const r = await fetch('/api/field-values/values', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ fieldId: _fvSelectedFieldId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load values');
    _fvLeValues = (data.values || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    fvHide('fv-le-loading');
    fvShow('fv-le-loaded');
    fvLeRenderList();
  } catch (err) {
    fvHide('fv-le-loading');
    fvShow('fv-le-error');
    fvText('fv-le-error-msg', err.message);
  } finally {
    _fvLeLoading = false;
  }
}

function fvLeRenderList() {
  const listEl = fv$('fv-le-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  const total = _fvLeValues.length;
  const q = _fvLeSearch.toLowerCase();
  const visible = q ? _fvLeValues.filter((v) => v.name.toLowerCase().includes(q)) : _fvLeValues;

  if (q) {
    fvText('fv-le-count', `${visible.length} of ${total} value${total !== 1 ? 's' : ''}`);
  } else {
    fvText('fv-le-count', total === 0 ? '' : `${total} value${total !== 1 ? 's' : ''}`);
  }

  if (!total) {
    fvHide('fv-le-list');
    fvShow('fv-le-empty');
    return;
  }
  fvHide('fv-le-empty');
  fvShow('fv-le-list');

  if (!visible.length) {
    listEl.innerHTML = '<p class="text-sm text-muted" style="padding:12px">No values match your search.</p>';
    return;
  }

  for (const v of visible) {
    listEl.appendChild(fvLeBuildRow(v));
  }
}

function fvLeBuildRow(v) {
  const row = document.createElement('div');
  row.dataset.id = v.id;
  row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--c-border);';

  if (_fvLeEditingId === v.id) {
    // ── Rename mode ──
    const input = document.createElement('input');
    input.type = 'text';
    input.value = v.name;
    input.style.cssText = 'flex:1;padding:4px 8px;border:1px solid var(--c-border);border-radius:4px;font-size:14px;';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') fvLeSubmitRename(v.id, input.value);
      if (e.key === 'Escape') fvLeCancelRename();
    });

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => fvLeSubmitRename(v.id, input.value));

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost btn-sm';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', fvLeCancelRename);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-ghost btn-sm';
    delBtn.title = 'Delete value';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', () => fvLeDeleteOne(v.id, v.name));

    row.appendChild(input);
    row.appendChild(saveBtn);
    row.appendChild(cancelBtn);
    row.appendChild(delBtn);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  } else {
    // ── Display mode ──
    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'flex:1;font-size:14px;';
    nameSpan.textContent = v.name;

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn btn-ghost btn-sm';
    renameBtn.title = 'Rename';
    renameBtn.textContent = '✏️';
    renameBtn.addEventListener('click', () => fvLeStartRename(v.id));

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-ghost btn-sm';
    delBtn.title = 'Delete value';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', () => fvLeDeleteOne(v.id, v.name));

    row.appendChild(nameSpan);
    row.appendChild(renameBtn);
    row.appendChild(delBtn);
  }

  return row;
}

function fvLeStartRename(id) {
  _fvLeEditingId = id;
  fvLeRenderList();
}

function fvLeCancelRename() {
  _fvLeEditingId = null;
  fvLeRenderList();
}

async function fvLeSubmitRename(id, rawName) {
  const newName = (rawName || '').trim();
  if (!newName) { showAlert('Value name cannot be empty.'); return; }
  const existing = _fvLeValues.find((v) => v.id === id);
  if (existing && existing.name === newName) { fvLeCancelRename(); return; }

  try {
    const r = await fetch('/api/field-values/rename', {
      method: 'PATCH',
      headers: buildHeaders(),
      body: JSON.stringify({ fieldId: _fvSelectedFieldId, valueId: id, name: newName }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Rename failed');
    if (existing) existing.name = data.name || newName;
    _fvLeValues.sort((a, b) => a.name.localeCompare(b.name));
    _fvLeEditingId = null;
    fvLeRenderList();
  } catch (err) {
    showAlert('Rename failed: ' + err.message);
  }
}

async function fvLeAddValues() {
  const ta = fv$('fv-le-add-input');
  if (!ta || !ta.value.trim()) return;
  if (!_fvSelectedFieldId) { showAlert('Please select a field first.'); return; }

  // Parse: split on newlines and commas, dedupe, trim
  const raw = ta.value;
  const names = [...new Set(
    raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
  )];
  if (!names.length) return;

  const addBtn = fv$('btn-fv-le-add');
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Adding…'; }
  fvLeSetStatus('', '');

  try {
    const r = await fetch('/api/field-values/create', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ fieldId: _fvSelectedFieldId, names }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Create failed');

    const created = data.created || [];
    const errors  = data.errors  || [];

    // Merge new values into list
    for (const v of created) {
      if (!_fvLeValues.some((x) => x.id === v.id)) _fvLeValues.push(v);
    }
    _fvLeValues.sort((a, b) => a.name.localeCompare(b.name));

    ta.value = '';
    fvLeRenderList();

    if (created.length && !errors.length) {
      fvLeSetStatus('ok', `${created.length} value${created.length !== 1 ? 's' : ''} added.`);
    } else if (created.length && errors.length) {
      const errList = errors.map((e) => `${esc(e.name)}: ${esc(e.error)}`).join(' · ');
      fvLeSetStatus('warn', `${created.length} added · ${errors.length} could not be added: ${errList}`);
    } else if (!created.length && errors.length) {
      const errList = errors.map((e) => `${esc(e.name)}: ${esc(e.error)}`).join(' · ');
      fvLeSetStatus('error', `No values added. ${errors.length} error${errors.length !== 1 ? 's' : ''}: ${errList}`);
    }
  } catch (err) {
    fvLeSetStatus('error', esc(err.message));
  } finally {
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = '+ Add'; }
  }
}

async function fvLeDeleteOne(id, name) {
  const ok = await showConfirm(`Delete "${name}"? This removes it from the field and unsets it from all entities.`);
  if (!ok) return;

  try {
    const r = await fetch('/api/field-values/delete/one', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ fieldId: _fvSelectedFieldId, valueId: id }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Delete failed');
    _fvLeValues = _fvLeValues.filter((v) => v.id !== id);
    if (_fvLeEditingId === id) _fvLeEditingId = null;
    fvLeRenderList();
    fvLeSetStatus('ok', `"${name}" deleted.`);
  } catch (err) {
    showAlert('Delete failed: ' + err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// MODULE INIT — called once by app.js after partial is loaded
// ════════════════════════════════════════════════════════════════════════════════
function initFieldValuesModule() {
  if (_fvInitDone) return;
  _fvInitDone = true;
  try {
    _initFieldValuesModuleBody();
  } catch (e) {
    _fvInitDone = false;
    throw e;
  }
}

function _initFieldValuesModuleBody() {
  // Load fields on init — silently no-ops if no token yet (pb:connected retries).
  fvLoadFields().then(() => {
    if (_fvSelectedFieldId) fvLeLoadValues();
  });


  // ── Delete All ────────────────────────────────────────────────────────────────
  fv$('fv-field-select-all')?.addEventListener('change', (e) => fvOnFieldChange(e.target.value));

  fv$('fv-da-confirm-input')?.addEventListener('input', (e) => {
    const btn = fv$('btn-fv-da-run');
    if (btn) btn.disabled = e.target.value.trim() !== 'DELETE' || !_fvSelectedFieldId;
  });

  fv$('btn-fv-da-run')?.addEventListener('click', () => {
    requireToken(() => {
      showConfirm(`Delete ALL values from the selected field? This cannot be undone.`).then((ok) => {
        if (ok) fvStartDeleteAll();
      });
    });
  });

  fv$('btn-fv-da-stop')?.addEventListener('click', () => {
    if (_fvDeleteCtrl) _fvDeleteCtrl.abort();
  });

  fv$('btn-fv-da-again')?.addEventListener('click', fvResetDeleteAll);

  // ── Delete from CSV ───────────────────────────────────────────────────────────
  fv$('fv-field-select-csv')?.addEventListener('change', (e) => fvOnFieldChange(e.target.value));

  const csvDropzoneEl = fv$('fv-csv-dropzone');
  const csvFileInput  = fv$('fv-csv-file-input');
  if (csvDropzoneEl && csvFileInput) {
    const { clear } = wireDropzone(csvDropzoneEl, csvFileInput, (file) => {
      fvLoadCsvFile(file);
    }, () => {
      _fvCsvParsed = null;
      const colWrap = fv$('fv-csv-column-wrap');
      if (colWrap) colWrap.style.display = 'none';
      fvUpdateCsvRunBtn();
    });
    _fvClearCsv = clear;
  }

  fv$('fv-csv-column-select')?.addEventListener('change', fvUpdateCsvRunBtn);

  fv$('btn-fv-csv-run')?.addEventListener('click', () => requireToken(fvStartDeleteCsv));

  fv$('btn-fv-csv-stop')?.addEventListener('click', () => {
    if (_fvDeleteCtrl) _fvDeleteCtrl.abort();
  });

  fv$('btn-fv-csv-again')?.addEventListener('click', fvResetDeleteCsv);

  // ── Diff by CSV ───────────────────────────────────────────────────────────────
  fv$('fv-field-select-diff')?.addEventListener('change', (e) => fvOnFieldChange(e.target.value));

  const diffDropzoneEl = fv$('fv-diff-dropzone');
  const diffFileInput  = fv$('fv-diff-file-input');
  if (diffDropzoneEl && diffFileInput) {
    const { clear } = wireDropzone(diffDropzoneEl, diffFileInput, (file) => {
      fvLoadDiffFile(file);
    }, () => {
      _fvDiffParsed = null;
      const colWrap = fv$('fv-diff-column-wrap');
      if (colWrap) colWrap.style.display = 'none';
      fvUpdateDiffRunBtn();
    });
    _fvClearDiff = clear;
  }

  fv$('fv-diff-column-select')?.addEventListener('change', fvUpdateDiffRunBtn);

  fv$('btn-fv-diff-run')?.addEventListener('click', () => {
    requireToken(() => {
      showConfirm('Delete all values NOT listed in the CSV? This cannot be undone.').then((ok) => {
        if (ok) fvStartDeleteDiff();
      });
    });
  });

  fv$('btn-fv-diff-stop')?.addEventListener('click', () => {
    if (_fvDeleteCtrl) _fvDeleteCtrl.abort();
  });

  fv$('btn-fv-diff-again')?.addEventListener('click', fvResetDeleteDiff);

  // ── Delete by selecting ───────────────────────────────────────────────────────
  fv$('fv-field-select-pick')?.addEventListener('change',   (e) => fvOnFieldChange(e.target.value));
  fv$('fv-field-select-pick-2')?.addEventListener('change', (e) => fvOnFieldChange(e.target.value));

  fv$('btn-fv-pick-load')?.addEventListener('click',   () => requireToken(fvLoadPickValues));
  fv$('btn-fv-pick-reload')?.addEventListener('click', () => requireToken(fvLoadPickValues));

  fv$('btn-fv-pick-select-all')?.addEventListener('click',   fvPickSelectAll);
  fv$('btn-fv-pick-deselect-all')?.addEventListener('click', fvPickDeselectAll);
  fv$('btn-fv-pick-invert')?.addEventListener('click',       fvPickInvert);

  fv$('btn-fv-pick-delete')?.addEventListener('click', () => {
    requireToken(() => {
      showConfirm(`Delete ${_fvCheckedIds.size} selected value(s)? This cannot be undone.`).then((ok) => {
        if (ok) fvStartDeletePick();
      });
    });
  });

  fv$('btn-fv-pick-stop')?.addEventListener('click', () => {
    if (_fvDeleteCtrl) _fvDeleteCtrl.abort();
  });

  fv$('btn-fv-pick-again')?.addEventListener('click', () => {
    fvHide('fv-pick-results');
    fvShow('fv-pick-idle');
    // checklist state was already cleared on complete/abort; reload needed
  });

  // ── Live editor ───────────────────────────────────────────────────────────────
  fv$('fv-field-select-le')?.addEventListener('change', (e) => fvOnFieldChange(e.target.value));

  fv$('btn-fv-le-add')?.addEventListener('click',     () => requireToken(fvLeAddValues));
  fv$('btn-fv-le-refresh')?.addEventListener('click',  () => requireToken(fvLeLoadValues));
  fv$('btn-fv-le-retry')?.addEventListener('click',    () => requireToken(fvLeLoadValues));

  fv$('fv-le-search')?.addEventListener('input', (e) => {
    _fvLeSearch = e.target.value;
    fvLeRenderList();
  });

  fv$('fv-le-add-input')?.addEventListener('keydown', (e) => {
    // Ctrl+Enter / Cmd+Enter submits
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      requireToken(fvLeAddValues);
    }
  });

  // ── Token connect / disconnect ────────────────────────────────────────────────
  // On reconnect, force a refresh of the field picker so a different workspace's
  // fields aren't shown stale.
  window.addEventListener('pb:connected', () => {
    _fvFields = [];
    fvLoadFields();
  });
  window.addEventListener('pb:disconnect', resetFieldValuesState);
}

window.initFieldValuesModule = initFieldValuesModule;
