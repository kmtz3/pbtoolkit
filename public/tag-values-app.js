/* =========================================================
   PBToolkit — Tag Values module
   Manages delete operations for Tags / MultiSelect / SingleSelect
   custom field values.
   ========================================================= */

// ── Module state ─────────────────────────────────────────────────────────────
let _tvFields = [];           // [{ id, name, displayType, entityTypes }]
let _tvSelectedFieldId = '';  // currently selected field id (shared across views)
let _tvValues = [];           // [{ id, name }] — loaded for pick-mode checklist
let _tvCheckedIds = new Set();// checked value IDs in pick mode
let _tvDeleteCtrl = null;     // SSE abort controller
let _tvInitDone = false;      // initTagValuesModule() guard

// CSV modes
let _tvCsvParsed = null;      // { raw, headers, rowCount } for delete-by-csv
let _tvClearCsv = null;       // wireDropzone clear fn
let _tvDiffParsed = null;     // { raw, headers, rowCount } for delete-by-diff
let _tvClearDiff = null;      // wireDropzone clear fn

// ── Module constants ──────────────────────────────────────────────────────────
const TV_FIELD_PICKER_IDS = [
  'tv-field-select-all',
  'tv-field-select-csv',
  'tv-field-select-diff',
  'tv-field-select-pick',
  'tv-field-select-pick-2',
];
const TV_TAG_NAME_HINTS = ['name', 'tag', 'value', 'tag_name', 'tag_value'];

// ── DOM shortcuts ─────────────────────────────────────────────────────────────
function tv$(id)       { return document.getElementById(id); }
function tvShow(id)    { const el = tv$(id); if (el) el.classList.remove('hidden'); }
function tvHide(id)    { const el = tv$(id); if (el) el.classList.add('hidden'); }
function tvText(id, t) { const el = tv$(id); if (el) el.textContent = t; }
function tvHtml(id, h) { const el = tv$(id); if (el) el.innerHTML = h; }

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetTagValuesState() {
  if (_tvDeleteCtrl)  { _tvDeleteCtrl.abort(); _tvDeleteCtrl = null; }
  if (_tvClearCsv)    { _tvClearCsv(); _tvClearCsv = null; }
  if (_tvClearDiff)   { _tvClearDiff(); _tvClearDiff = null; }
  _tvCsvParsed = null;
  _tvDiffParsed = null;
  _tvValues = [];
  _tvCheckedIds = new Set();
}

// ── Field picker ──────────────────────────────────────────────────────────────

function tvPopulateFieldPicker(selectId) {
  const sel = tv$(selectId);
  if (!sel) return;
  const prev = sel.value || _tvSelectedFieldId;
  sel.innerHTML = '';

  if (!_tvFields.length) {
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

  for (const f of _tvFields) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = `${f.name} [${f.displayType}]`;
    sel.appendChild(opt);
  }

  if (prev && [...sel.options].some((o) => o.value === prev)) {
    sel.value = prev;
  }
}

function tvSyncFieldPickers() {
  TV_FIELD_PICKER_IDS.forEach(tvPopulateFieldPicker);
  tvUpdateDeleteAllHint();
}

async function tvLoadFields() {
  if (_tvFields.length) {
    tvSyncFieldPickers();
    return;
  }
  TV_FIELD_PICKER_IDS.forEach((id) => {
    const el = tv$(id);
    if (el) { el.innerHTML = '<option value="">Loading fields…</option>'; el.disabled = true; }
  });
  try {
    const r = await fetch('/api/tag-values/fields', { headers: buildHeaders() });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load fields');
    _tvFields = data.fields || [];
  } catch (err) {
    showAlert('Failed to load tag fields: ' + err.message);
    _tvFields = [];
  }
  TV_FIELD_PICKER_IDS.forEach((id) => {
    const el = tv$(id); if (el) el.disabled = false;
  });
  tvSyncFieldPickers();
}

function tvOnFieldChange(newId) {
  _tvSelectedFieldId = newId;
  tvSyncFieldPickers();
  tvUpdateDeleteAllHint();
  tvUpdateCsvRunBtn();
  tvUpdateDiffRunBtn();
  // Reset pick mode checklist when field changes
  _tvValues = [];
  _tvCheckedIds = new Set();
  tvHide('tv-pick-checklist-wrap');
  tvShow('tv-pick-idle');
  tvHide('tv-pick-running');
  tvHide('tv-pick-results');
  tvHide('tv-pick-load-error');
}

function tvUpdateDeleteAllHint() {
  const hint = tv$('tv-da-field-hint');
  if (!hint) return;
  const f = _tvFields.find((x) => x.id === _tvSelectedFieldId);
  if (f) {
    hint.textContent = `${f.displayType} · used by: ${f.entityTypes.join(', ')}`;
    hint.style.display = 'block';
  } else {
    hint.style.display = 'none';
  }
}

// ── Progress helper ────────────────────────────────────────────────────────────
function tvProgress(prefix, msg, pct) {
  const bar = tv$(prefix + '-progress-bar');
  if (bar) bar.style.width = Math.min(100, pct) + '%';
  tvText(prefix + '-progress-msg', msg);
  tvText(prefix + '-progress-pct', Math.round(pct) + '%');
}

// ── Generic SSE log helper ─────────────────────────────────────────────────────
function tvAppendLog(logWrapId, entriesId, entry) {
  const logEl = tv$(logWrapId);
  const entries = tv$(entriesId);
  if (!entries) return;
  if (logEl && logEl.classList.contains('hidden')) logEl.classList.remove('hidden');
  const e = document.createElement('div');
  e.className = `log-entry ${entry.level}`;
  e.innerHTML = `<span class="log-msg">${esc(entry.message)}</span>`;
  entries.appendChild(e);
  entries.scrollTop = entries.scrollHeight;
}

// ── Summary builder ────────────────────────────────────────────────────────────
function tvBuildSummary(data, mode) {
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

function tvResetDeleteAll() {
  tvShow('tv-da-idle');
  tvHide('tv-da-running');
  tvHide('tv-da-results');
  const confirmInput = tv$('tv-da-confirm-input');
  if (confirmInput) confirmInput.value = '';
  const runBtn = tv$('btn-tv-da-run');
  if (runBtn) runBtn.disabled = true;
}

function tvStartDeleteAll() {
  if (!_tvSelectedFieldId) { showAlert('Please select a field first.'); return; }

  tvHide('tv-da-idle');
  tvShow('tv-da-running');
  tvHide('tv-da-results');
  tvProgress('tv-da', 'Starting…', 0);
  const logEntries = tv$('tv-da-log-entries');
  if (logEntries) logEntries.innerHTML = '';
  tvHide('tv-da-live-log');

  _tvDeleteCtrl = subscribeSSE(
    '/api/tag-values/delete/all',
    { fieldId: _tvSelectedFieldId },
    {
      onProgress: ({ message, percent }) => tvProgress('tv-da', message, percent),
      onLog:      (entry) => tvAppendLog('tv-da-live-log', 'tv-da-log-entries', entry),
      onComplete: (data) => {
        tvHide('tv-da-running');
        tvShow('tv-da-results');
        tvHtml('tv-da-summary', tvBuildSummary(data, 'all'));
        _tvDeleteCtrl = null;
      },
      onError: (msg) => {
        tvHide('tv-da-running');
        tvShow('tv-da-results');
        tvHtml('tv-da-summary', `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`);
        _tvDeleteCtrl = null;
      },
      onAbort: () => {
        tvHide('tv-da-running');
        tvShow('tv-da-results');
        tvHtml('tv-da-summary', `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Deletion stopped.</span></div>`);
        _tvDeleteCtrl = null;
      },
    }
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// DELETE FROM CSV
// ════════════════════════════════════════════════════════════════════════════════

function tvResetDeleteCsv() {
  tvShow('tv-csv-idle');
  tvHide('tv-csv-running');
  tvHide('tv-csv-results');
  _tvCsvParsed = null;
  if (_tvClearCsv) { _tvClearCsv(); _tvClearCsv = null; }
  const colWrap = tv$('tv-csv-column-wrap');
  if (colWrap) colWrap.style.display = 'none';
  tvUpdateCsvRunBtn();
}

function tvUpdateCsvRunBtn() {
  const btn = tv$('btn-tv-csv-run');
  if (btn) btn.disabled = !(_tvSelectedFieldId && _tvCsvParsed);
}

// Shared CSV loader for delete-by-csv and delete-by-diff submodules.
function tvLoadCsvForMode(file, opts) {
  const { selectId, colWrapId, subtitleId, onParsed, updateBtn } = opts;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const headers = parseCSVHeaders(text);
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) { showAlert('CSV appears empty.'); return; }
    onParsed({ raw: text, headers, rowCount });

    const sel = tv$(selectId);
    if (sel) {
      sel.innerHTML = headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
      const auto = headers.find((h) => TV_TAG_NAME_HINTS.includes(h.toLowerCase()));
      if (auto) sel.value = auto;
    }

    const colWrap = tv$(colWrapId);
    if (colWrap) colWrap.style.display = '';
    tvText(subtitleId, `${rowCount.toLocaleString()} rows · ${headers.length} columns`);
    updateBtn();
  };
  reader.readAsText(file);
}

function tvLoadCsvFile(file) {
  tvLoadCsvForMode(file, {
    selectId: 'tv-csv-column-select',
    colWrapId: 'tv-csv-column-wrap',
    subtitleId: 'tv-csv-subtitle',
    onParsed: (p) => { _tvCsvParsed = p; },
    updateBtn: tvUpdateCsvRunBtn,
  });
}

function tvStartDeleteCsv() {
  if (!_tvSelectedFieldId) { showAlert('Please select a field first.'); return; }
  if (!_tvCsvParsed) { showAlert('Please upload a CSV first.'); return; }

  const column = tv$('tv-csv-column-select')?.value;
  if (!column) { showAlert('Please select a column.'); return; }

  tvHide('tv-csv-idle');
  tvShow('tv-csv-running');
  tvHide('tv-csv-results');
  tvProgress('tv-csv', 'Starting…', 0);
  const logEntries = tv$('tv-csv-log-entries');
  if (logEntries) logEntries.innerHTML = '';
  tvHide('tv-csv-live-log');

  _tvDeleteCtrl = subscribeSSE(
    '/api/tag-values/delete/by-csv',
    { fieldId: _tvSelectedFieldId, csvText: _tvCsvParsed.raw, column },
    {
      onProgress: ({ message, percent }) => tvProgress('tv-csv', message, percent),
      onLog:      (entry) => tvAppendLog('tv-csv-live-log', 'tv-csv-log-entries', entry),
      onComplete: (data) => {
        tvHide('tv-csv-running');
        tvShow('tv-csv-results');
        tvHtml('tv-csv-summary', tvBuildSummary(data, 'csv'));
        _tvDeleteCtrl = null;
      },
      onError: (msg) => {
        tvHide('tv-csv-running');
        tvShow('tv-csv-results');
        tvHtml('tv-csv-summary', `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`);
        _tvDeleteCtrl = null;
      },
      onAbort: () => {
        tvHide('tv-csv-running');
        tvShow('tv-csv-results');
        tvHtml('tv-csv-summary', `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Deletion stopped.</span></div>`);
        _tvDeleteCtrl = null;
      },
    }
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// DIFF BY CSV
// ════════════════════════════════════════════════════════════════════════════════

function tvResetDeleteDiff() {
  tvShow('tv-diff-idle');
  tvHide('tv-diff-running');
  tvHide('tv-diff-results');
  _tvDiffParsed = null;
  if (_tvClearDiff) { _tvClearDiff(); _tvClearDiff = null; }
  const colWrap = tv$('tv-diff-column-wrap');
  if (colWrap) colWrap.style.display = 'none';
  tvUpdateDiffRunBtn();
}

function tvUpdateDiffRunBtn() {
  const btn = tv$('btn-tv-diff-run');
  if (btn) btn.disabled = !(_tvSelectedFieldId && _tvDiffParsed);
}

function tvLoadDiffFile(file) {
  tvLoadCsvForMode(file, {
    selectId: 'tv-diff-column-select',
    colWrapId: 'tv-diff-column-wrap',
    subtitleId: 'tv-diff-subtitle',
    onParsed: (p) => { _tvDiffParsed = p; },
    updateBtn: tvUpdateDiffRunBtn,
  });
}

function tvStartDeleteDiff() {
  if (!_tvSelectedFieldId) { showAlert('Please select a field first.'); return; }
  if (!_tvDiffParsed) { showAlert('Please upload a CSV first.'); return; }

  const column = tv$('tv-diff-column-select')?.value;
  if (!column) { showAlert('Please select a column.'); return; }

  tvHide('tv-diff-idle');
  tvShow('tv-diff-running');
  tvHide('tv-diff-results');
  tvProgress('tv-diff', 'Starting…', 0);
  const logEntries = tv$('tv-diff-log-entries');
  if (logEntries) logEntries.innerHTML = '';
  tvHide('tv-diff-live-log');

  _tvDeleteCtrl = subscribeSSE(
    '/api/tag-values/delete/by-diff',
    { fieldId: _tvSelectedFieldId, csvText: _tvDiffParsed.raw, column },
    {
      onProgress: ({ message, percent }) => tvProgress('tv-diff', message, percent),
      onLog:      (entry) => tvAppendLog('tv-diff-live-log', 'tv-diff-log-entries', entry),
      onComplete: (data) => {
        tvHide('tv-diff-running');
        tvShow('tv-diff-results');
        tvHtml('tv-diff-summary', tvBuildSummary(data, 'diff'));
        _tvDeleteCtrl = null;
      },
      onError: (msg) => {
        tvHide('tv-diff-running');
        tvShow('tv-diff-results');
        tvHtml('tv-diff-summary', `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`);
        _tvDeleteCtrl = null;
      },
      onAbort: () => {
        tvHide('tv-diff-running');
        tvShow('tv-diff-results');
        tvHtml('tv-diff-summary', `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Deletion stopped.</span></div>`);
        _tvDeleteCtrl = null;
      },
    }
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// DELETE BY SELECTING (pick mode)
// ════════════════════════════════════════════════════════════════════════════════

function tvResetDeletePick() {
  tvShow('tv-pick-idle');
  tvHide('tv-pick-checklist-wrap');
  tvHide('tv-pick-running');
  tvHide('tv-pick-results');
  tvHide('tv-pick-load-error');
  _tvValues = [];
  _tvCheckedIds = new Set();
}

async function tvLoadPickValues() {
  if (!_tvSelectedFieldId) { showAlert('Please select a field first.'); return; }

  tvHide('tv-pick-load-error');
  const loadBtn = tv$('btn-tv-pick-load');
  if (loadBtn) { loadBtn.disabled = true; loadBtn.textContent = 'Loading…'; }

  try {
    const r = await fetch('/api/tag-values/values', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ fieldId: _tvSelectedFieldId }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to load values');
    _tvValues = data.values || [];
    _tvCheckedIds = new Set();
    tvBuildChecklist();
    tvHide('tv-pick-idle');
    tvShow('tv-pick-checklist-wrap');
  } catch (err) {
    tvShow('tv-pick-load-error');
    tvText('tv-pick-load-error-msg', err.message);
  } finally {
    if (loadBtn) { loadBtn.disabled = false; loadBtn.textContent = 'Load values'; }
  }
}

function tvBuildChecklist() {
  const listEl = tv$('tv-pick-list');
  if (!listEl) return;
  listEl.innerHTML = '';

  if (!_tvValues.length) {
    listEl.innerHTML = '<div style="padding:10px 12px;font-size:13px;color:var(--c-muted)">No values found for this field.</div>';
    tvUpdatePickDeleteBtn();
    return;
  }

  for (const v of _tvValues) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = v.id;
    cb.dataset.id = v.id;
    cb.dataset.name = v.name;
    cb.checked = _tvCheckedIds.has(v.id);
    cb.addEventListener('change', () => {
      if (cb.checked) _tvCheckedIds.add(v.id);
      else _tvCheckedIds.delete(v.id);
      tvUpdatePickDeleteBtn();
    });
    const span = document.createElement('span');
    span.textContent = v.name;
    label.appendChild(cb);
    label.appendChild(span);
    listEl.appendChild(label);
  }

  tvUpdatePickDeleteBtn();
}

function tvUpdatePickDeleteBtn() {
  const n = _tvCheckedIds.size;
  const btn = tv$('btn-tv-pick-delete');
  if (btn) {
    btn.disabled = n === 0;
    btn.textContent = n > 0 ? `🗑 Delete selected (${n})` : '🗑 Delete selected (0)';
  }
  tvText('tv-pick-count', `${n} selected`);
}

function tvPickSelectAll() {
  _tvCheckedIds = new Set(_tvValues.map((v) => v.id));
  tvBuildChecklist();
}

function tvPickDeselectAll() {
  _tvCheckedIds = new Set();
  tvBuildChecklist();
}

function tvPickInvert() {
  const newSet = new Set();
  for (const v of _tvValues) {
    if (!_tvCheckedIds.has(v.id)) newSet.add(v.id);
  }
  _tvCheckedIds = newSet;
  tvBuildChecklist();
}

function tvStartDeletePick() {
  if (!_tvSelectedFieldId) { showAlert('No field selected.'); return; }
  if (!_tvCheckedIds.size) { showAlert('No values selected.'); return; }

  const values = _tvValues.filter((v) => _tvCheckedIds.has(v.id)).map((v) => ({ id: v.id, name: v.name }));

  tvHide('tv-pick-checklist-wrap');
  tvHide('tv-pick-idle');
  tvShow('tv-pick-running');
  tvHide('tv-pick-results');
  tvProgress('tv-pick', 'Starting…', 0);
  const logEntries = tv$('tv-pick-log-entries');
  if (logEntries) logEntries.innerHTML = '';
  tvHide('tv-pick-live-log');

  _tvDeleteCtrl = subscribeSSE(
    '/api/tag-values/delete/by-ids',
    { fieldId: _tvSelectedFieldId, values },
    {
      onProgress: ({ message, percent }) => tvProgress('tv-pick', message, percent),
      onLog:      (entry) => tvAppendLog('tv-pick-live-log', 'tv-pick-log-entries', entry),
      onComplete: (data) => {
        tvHide('tv-pick-running');
        tvShow('tv-pick-results');
        tvHtml('tv-pick-summary', tvBuildSummary(data, 'pick'));
        _tvDeleteCtrl = null;
        // Reset checklist state so user can reload with updated values
        _tvValues = [];
        _tvCheckedIds = new Set();
      },
      onError: (msg) => {
        tvHide('tv-pick-running');
        tvShow('tv-pick-results');
        tvHtml('tv-pick-summary', `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`);
        _tvDeleteCtrl = null;
      },
      onAbort: () => {
        tvHide('tv-pick-running');
        tvShow('tv-pick-results');
        tvHtml('tv-pick-summary', `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Deletion stopped.</span></div>`);
        _tvDeleteCtrl = null;
        _tvValues = [];
        _tvCheckedIds = new Set();
      },
    }
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// MODULE INIT — called once by app.js after partial is loaded
// ════════════════════════════════════════════════════════════════════════════════
function initTagValuesModule() {
  if (_tvInitDone) return;
  _tvInitDone = true;

  // Load fields immediately
  requireToken(tvLoadFields);

  // ── Delete All ────────────────────────────────────────────────────────────────
  tv$('tv-field-select-all')?.addEventListener('change', (e) => tvOnFieldChange(e.target.value));

  tv$('tv-da-confirm-input')?.addEventListener('input', (e) => {
    const btn = tv$('btn-tv-da-run');
    if (btn) btn.disabled = e.target.value.trim() !== 'DELETE' || !_tvSelectedFieldId;
  });

  tv$('btn-tv-da-run')?.addEventListener('click', () => {
    requireToken(() => {
      showConfirm(`Delete ALL values from the selected field? This cannot be undone.`).then((ok) => {
        if (ok) tvStartDeleteAll();
      });
    });
  });

  tv$('btn-tv-da-stop')?.addEventListener('click', () => {
    if (_tvDeleteCtrl) _tvDeleteCtrl.abort();
  });

  tv$('btn-tv-da-again')?.addEventListener('click', tvResetDeleteAll);

  // ── Delete from CSV ───────────────────────────────────────────────────────────
  tv$('tv-field-select-csv')?.addEventListener('change', (e) => tvOnFieldChange(e.target.value));

  const csvDropzoneEl = tv$('tv-csv-dropzone');
  const csvFileInput  = tv$('tv-csv-file-input');
  if (csvDropzoneEl && csvFileInput) {
    const { clear } = wireDropzone(csvDropzoneEl, csvFileInput, (file) => {
      tvLoadCsvFile(file);
    }, () => {
      _tvCsvParsed = null;
      const colWrap = tv$('tv-csv-column-wrap');
      if (colWrap) colWrap.style.display = 'none';
      tvUpdateCsvRunBtn();
    });
    _tvClearCsv = clear;
  }

  tv$('tv-csv-column-select')?.addEventListener('change', tvUpdateCsvRunBtn);

  tv$('btn-tv-csv-run')?.addEventListener('click', () => requireToken(tvStartDeleteCsv));

  tv$('btn-tv-csv-stop')?.addEventListener('click', () => {
    if (_tvDeleteCtrl) _tvDeleteCtrl.abort();
  });

  tv$('btn-tv-csv-again')?.addEventListener('click', tvResetDeleteCsv);

  // ── Diff by CSV ───────────────────────────────────────────────────────────────
  tv$('tv-field-select-diff')?.addEventListener('change', (e) => tvOnFieldChange(e.target.value));

  const diffDropzoneEl = tv$('tv-diff-dropzone');
  const diffFileInput  = tv$('tv-diff-file-input');
  if (diffDropzoneEl && diffFileInput) {
    const { clear } = wireDropzone(diffDropzoneEl, diffFileInput, (file) => {
      tvLoadDiffFile(file);
    }, () => {
      _tvDiffParsed = null;
      const colWrap = tv$('tv-diff-column-wrap');
      if (colWrap) colWrap.style.display = 'none';
      tvUpdateDiffRunBtn();
    });
    _tvClearDiff = clear;
  }

  tv$('tv-diff-column-select')?.addEventListener('change', tvUpdateDiffRunBtn);

  tv$('btn-tv-diff-run')?.addEventListener('click', () => {
    requireToken(() => {
      showConfirm('Delete all values NOT listed in the CSV? This cannot be undone.').then((ok) => {
        if (ok) tvStartDeleteDiff();
      });
    });
  });

  tv$('btn-tv-diff-stop')?.addEventListener('click', () => {
    if (_tvDeleteCtrl) _tvDeleteCtrl.abort();
  });

  tv$('btn-tv-diff-again')?.addEventListener('click', tvResetDeleteDiff);

  // ── Delete by selecting ───────────────────────────────────────────────────────
  tv$('tv-field-select-pick')?.addEventListener('change',   (e) => tvOnFieldChange(e.target.value));
  tv$('tv-field-select-pick-2')?.addEventListener('change', (e) => tvOnFieldChange(e.target.value));

  tv$('btn-tv-pick-load')?.addEventListener('click',   () => requireToken(tvLoadPickValues));
  tv$('btn-tv-pick-reload')?.addEventListener('click', () => requireToken(tvLoadPickValues));

  tv$('btn-tv-pick-select-all')?.addEventListener('click',   tvPickSelectAll);
  tv$('btn-tv-pick-deselect-all')?.addEventListener('click', tvPickDeselectAll);
  tv$('btn-tv-pick-invert')?.addEventListener('click',       tvPickInvert);

  tv$('btn-tv-pick-delete')?.addEventListener('click', () => {
    requireToken(() => {
      showConfirm(`Delete ${_tvCheckedIds.size} selected value(s)? This cannot be undone.`).then((ok) => {
        if (ok) tvStartDeletePick();
      });
    });
  });

  tv$('btn-tv-pick-stop')?.addEventListener('click', () => {
    if (_tvDeleteCtrl) _tvDeleteCtrl.abort();
  });

  tv$('btn-tv-pick-again')?.addEventListener('click', () => {
    tvHide('tv-pick-results');
    tvShow('tv-pick-idle');
    // checklist state was already cleared on complete/abort; reload needed
  });

  // ── Token connect / disconnect ────────────────────────────────────────────────
  // On reconnect, force a refresh of the field picker so a different workspace's
  // fields aren't shown stale.
  window.addEventListener('pb:connected', () => {
    _tvFields = [];
    tvLoadFields();
  });
  window.addEventListener('pb:disconnect', resetTagValuesState);
}

window.initTagValuesModule = initTagValuesModule;
