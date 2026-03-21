// ══════════════════════════════════════════════════════════════════════════════
// Teams CRUD module
// Depends on: app.js globals — $(), show(), hide(), setText(), subscribeSSE(),
//             requireToken(), triggerDownload(), esc(), makeLogAppender(),
//             downloadLogCsv(), parseCSVHeaders(), countCSVDataRows(), token, useEu
// ══════════════════════════════════════════════════════════════════════════════

(function () {

  // ── Module state ────────────────────────────────────────────────────────────

  const TC_MAPPING_KEY = 'teams-crud-mapping';

  // Export
  let tcExportBlob     = null;
  let tcExportFilename = 'pb-teams.csv';
  let tcExportCount    = 0;

  // Import
  let tcImportParsedCSV = null;  // { raw, headers, rowCount }
  let tcCurrentDiff     = null;  // { toCreate, toUpdate, unchanged } from /preview
  let tcImportCtrl      = null;

  // Delete by CSV
  let tcDeleteCsvParsed = null;  // { raw, headers, rowCount }
  let tcDeleteCsvCtrl   = null;

  // Delete all
  let tcDeleteAllCtrl   = null;

  // Log appenders (created lazily in initTeamsCrudModule, after DOM is ready)
  let tcImportLogAppender    = null;
  let tcDeleteCsvLogAppender = null;

  // ── Scope helpers ────────────────────────────────────────────────────────────

  function tc$(id)            { return document.getElementById(id); }
  function tcShow(id)         { const el = tc$(id); if (el) el.classList.remove('hidden'); }
  function tcHide(id)         { const el = tc$(id); if (el) el.classList.add('hidden'); }
  function tcSetText(id, text){ const el = tc$(id); if (el) el.textContent = text; }

  // ── GET headers (no Content-Type — used for the direct fetch export) ─────────

  function tcGetHeaders() {
    const h = { 'x-pb-token': token };
    if (useEu) h['x-pb-eu'] = 'true';
    return h;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // EXPORT
  // ════════════════════════════════════════════════════════════════════════════

  async function startTcExport() {
    tcHide('tc-export-idle');
    tcHide('tc-export-done');
    tcHide('tc-export-error');
    tcShow('tc-export-loading');

    try {
      const res = await fetch('/api/teams-crud/export', { headers: tcGetHeaders() });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const blob     = await res.blob();
      const today    = new Date().toISOString().slice(0, 10);
      tcExportFilename = `pb-teams_${today}.csv`;
      tcExportBlob     = blob;

      // Count rows from CSV text (exclude header line)
      const text = await blob.text();
      tcExportCount = Math.max(0, text.trim().split('\n').length - 1);

      triggerDownload(blob, tcExportFilename);

      tcHide('tc-export-loading');
      tcSetText('tc-export-count',    String(tcExportCount));
      tcSetText('tc-export-filename', tcExportFilename);
      tcShow('tc-export-done');

    } catch (err) {
      tcHide('tc-export-loading');
      tcSetText('tc-export-error-msg', err.message || 'Export failed.');
      tcShow('tc-export-error');
    }
  }

  function resetTcExport() {
    tcExportBlob = null;
    tcHide('tc-export-loading');
    tcHide('tc-export-done');
    tcHide('tc-export-error');
    tcShow('tc-export-idle');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // IMPORT — Step 1: Upload
  // ════════════════════════════════════════════════════════════════════════════

  function loadTcImportCSV(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text     = e.target.result;
      const rowCount = countCSVDataRows(text);
      if (rowCount === 0) { alert('CSV file appears empty or has no data rows.'); return; }
      tcImportParsedCSV = { raw: text, headers: parseCSVHeaders(text), rowCount };
      tcShowImportMapStep();
    };
    reader.readAsText(file);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // IMPORT — Step 2: Map columns
  // ════════════════════════════════════════════════════════════════════════════

  function tcShowImportMapStep() {
    tcHide('tc-import-step-preview');
    tcHide('tc-import-step-run');
    tcHide('tc-import-error');

    tcSetText('tc-map-subtitle', `${tcImportParsedCSV.rowCount} rows · ${tcImportParsedCSV.headers.length} columns`);

    // Populate all four selects
    populateTcMapSelect('tc-map-id',     true);
    populateTcMapSelect('tc-map-name',   true);
    populateTcMapSelect('tc-map-handle', true);
    populateTcMapSelect('tc-map-desc',   true);

    autoDetectTcMappings();
    restoreTcMapping();

    tcShow('tc-import-step-map');
  }

  function populateTcMapSelect(selectId, includeSkip) {
    const sel = tc$(selectId);
    if (!sel) return;
    const skip = includeSkip ? '<option value="">(⇢ skip)</option>' : '';
    sel.innerHTML = skip + tcImportParsedCSV.headers
      .map((h) => `<option value="${esc(h)}">${esc(h)}</option>`)
      .join('');
  }

  function autoDetectTcMappings() {
    const hints = {
      'tc-map-id':     ['id', 'pb_id', 'uuid', 'team id', 'team_id'],
      'tc-map-name':   ['name', 'team name', 'team_name'],
      'tc-map-handle': ['handle', 'team handle', 'team_handle'],
      'tc-map-desc':   ['description', 'desc'],
    };
    for (const [selectId, candidates] of Object.entries(hints)) {
      const sel = tc$(selectId);
      if (!sel) continue;
      for (const candidate of candidates) {
        const match = tcImportParsedCSV.headers.find((h) => h.toLowerCase() === candidate);
        if (match) { sel.value = match; break; }
      }
    }
  }

  function saveTcMapping() {
    try {
      const mapping = {
        idCol:     tc$('tc-map-id')?.value     || '',
        nameCol:   tc$('tc-map-name')?.value   || '',
        handleCol: tc$('tc-map-handle')?.value || '',
        descCol:   tc$('tc-map-desc')?.value   || '',
      };
      localStorage.setItem(TC_MAPPING_KEY, JSON.stringify(mapping));
    } catch (_) {}
  }

  function restoreTcMapping() {
    try {
      const saved = JSON.parse(localStorage.getItem(TC_MAPPING_KEY) || 'null');
      if (!saved) return;
      if (saved.idCol     && tcImportParsedCSV.headers.includes(saved.idCol))     tc$('tc-map-id').value     = saved.idCol;
      if (saved.nameCol   && tcImportParsedCSV.headers.includes(saved.nameCol))   tc$('tc-map-name').value   = saved.nameCol;
      if (saved.handleCol && tcImportParsedCSV.headers.includes(saved.handleCol)) tc$('tc-map-handle').value = saved.handleCol;
      if (saved.descCol   && tcImportParsedCSV.headers.includes(saved.descCol))   tc$('tc-map-desc').value   = saved.descCol;
    } catch (_) {}
  }

  function getTcMapping() {
    return {
      idCol:     tc$('tc-map-id')?.value     || null,
      nameCol:   tc$('tc-map-name')?.value   || null,
      handleCol: tc$('tc-map-handle')?.value || null,
      descCol:   tc$('tc-map-desc')?.value   || null,
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // IMPORT — Step 3: Preview
  // ════════════════════════════════════════════════════════════════════════════

  async function runTcPreview() {
    if (!tcImportParsedCSV) return;

    const mapping = getTcMapping();
    if (!mapping.idCol && !mapping.nameCol && !mapping.handleCol) {
      const warn = tc$('tc-map-warning');
      tcSetText('tc-map-warning-msg', 'Map at least one of "id", "name", or "handle" before previewing.');
      if (warn) warn.classList.remove('hidden');
      return;
    }
    const warn = tc$('tc-map-warning');
    if (warn) warn.classList.add('hidden');

    saveTcMapping();

    tc$('btn-tc-import-preview').disabled = true;
    tc$('btn-tc-import-preview').textContent = 'Fetching preview…';

    try {
      const res = await fetch('/api/teams-crud/preview', {
        method:  'POST',
        headers: buildHeaders(),
        body:    JSON.stringify({ csvText: tcImportParsedCSV.raw, mapping }),
      });

      const data = await res.json();
      tc$('btn-tc-import-preview').disabled = false;
      tc$('btn-tc-import-preview').textContent = 'Preview changes';

      tcShowPreviewStep(data);

    } catch (err) {
      tc$('btn-tc-import-preview').disabled = false;
      tc$('btn-tc-import-preview').textContent = 'Preview changes';
      alert(`Preview failed: ${err.message}`);
    }
  }

  function tcShowPreviewStep(data) {
    tcHide('tc-preview-warnings');
    tcHide('tc-preview-errors');
    tcHide('tc-preview-diff');

    // Warnings
    if (data.warnings && data.warnings.length > 0) {
      const el = tc$('tc-preview-warnings');
      el.innerHTML = data.warnings.map((w) =>
        `<div class="alert alert-warn" style="margin-bottom:6px;"><span class="alert-icon">⚠️</span><span>${esc(w)}</span></div>`
      ).join('');
      tcShow('tc-preview-warnings');
    }

    // Hard errors
    if (data.hardErrors && data.hardErrors.length > 0) {
      const listEl = tc$('tc-preview-error-list');
      listEl.innerHTML = data.hardErrors.map((e) => `<div>${esc(e)}</div>`).join('');
      tcShow('tc-preview-errors');
      tcHide('tc-import-step-map');
      tcShow('tc-import-step-preview');
      return;
    }

    // Diff
    const diff = data.diff;
    tcCurrentDiff = diff;

    tcSetText('tc-preview-create-count',    String(diff.toCreate.length));
    tcSetText('tc-preview-update-count',    String(diff.toUpdate.length));
    tcSetText('tc-preview-unchanged-count', String(diff.unchanged.length));

    // Populate create table
    const createTbody = tc$('tc-preview-create-rows');
    createTbody.innerHTML = diff.toCreate.length === 0
      ? '<tr><td colspan="3" class="text-muted text-sm">No new teams to create.</td></tr>'
      : diff.toCreate.map((t) =>
          `<tr><td>${esc(t.name)}</td><td>${esc(t.handle)}</td><td>${esc(t.description || '')}</td></tr>`
        ).join('');

    // Populate unchanged table
    const unchangedTbody = tc$('tc-preview-unchanged-rows');
    unchangedTbody.innerHTML = diff.unchanged.length === 0
      ? '<tr><td colspan="2" class="text-muted text-sm">None.</td></tr>'
      : diff.unchanged.map((t) =>
          `<tr><td>${esc(t.name)}</td><td>${esc(t.handle)}</td></tr>`
        ).join('');

    // Populate update table
    const updateTbody = tc$('tc-preview-update-rows');
    updateTbody.innerHTML = diff.toUpdate.length === 0
      ? '<tr><td colspan="3" class="text-muted text-sm">No existing teams to update.</td></tr>'
      : diff.toUpdate.map((t) => {
          const changeList = Object.entries(t.changes)
            .map(([k, v]) => `${esc(k)}: <em>${esc(String(v))}</em>`)
            .join('; ');
          return `<tr><td>${esc(t.currentName)}</td><td>${esc(t.matchedBy)}</td><td>${changeList}</td></tr>`;
        }).join('');

    const totalOps = diff.toCreate.length + diff.toUpdate.length;
    const execBtn  = tc$('btn-tc-import-execute');
    execBtn.disabled = totalOps === 0;
    execBtn.textContent = totalOps === 0
      ? 'No changes to apply'
      : `Import ${totalOps} team${totalOps !== 1 ? 's' : ''} (${diff.toCreate.length} create, ${diff.toUpdate.length} update)`;

    tcShow('tc-preview-diff');
    tcHide('tc-import-step-map');
    tcShow('tc-import-step-preview');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // IMPORT — Step 4: Execute (SSE)
  // ════════════════════════════════════════════════════════════════════════════

  function startTcImport() {
    if (!tcImportParsedCSV) return;

    tcHide('tc-import-step-preview');
    tcHide('tc-import-error');
    tcShow('tc-import-step-run');

    tcSetText('tc-import-run-title', 'Importing…');
    tcHide('tc-import-summary');
    tcShow('btn-tc-import-stop');
    tcHide('btn-tc-import-again');

    // Reset progress
    const bar = tc$('tc-import-progress-bar');
    if (bar) bar.style.width = '0%';
    tcSetText('tc-import-progress-msg', 'Starting…');

    // Reset log
    if (tcImportLogAppender) tcImportLogAppender.reset();
    tcHide('tc-import-live-log');
    tcHide('btn-tc-import-download-log');

    const mapping = getTcMapping();

    tcImportCtrl = subscribeSSE(
      '/api/teams-crud/import',
      { csvText: tcImportParsedCSV.raw, mapping },
      {
        onProgress: ({ message, percent }) => {
          if (tc$('tc-import-progress-bar')) tc$('tc-import-progress-bar').style.width = `${Math.min(100, percent)}%`;
          tcSetText('tc-import-progress-msg', message);
        },

        onLog: (entry) => {
          tcShow('tc-import-live-log');
          if (tcImportLogAppender) tcImportLogAppender(entry);
        },

        onComplete: (data) => {
          tcHide('btn-tc-import-stop');
          tcShow('btn-tc-import-again');
          tcSetText('tc-import-run-title', 'Import complete');
          tcShow('btn-tc-import-download-log');

          const unchanged = data.unchanged ?? 0;
          const summary = tc$('tc-import-summary');
          const hasErrors = data.errors > 0;
          const icon  = hasErrors ? '⚠️' : '✅';
          const klass = hasErrors ? 'alert-warn' : 'alert-ok';
          summary.innerHTML = `
            <div class="alert ${klass}">
              <span class="alert-icon">${icon}</span>
              <span>Import complete — Created ${data.created.toLocaleString()} · Updated ${data.updated.toLocaleString()} · Unchanged ${unchanged.toLocaleString()} · Errors ${data.errors}</span>
            </div>`;
          tcShow('tc-import-summary');
        },

        onError: (msg) => {
          tcHide('btn-tc-import-stop');
          tcHide('tc-import-step-run');
          tcSetText('tc-import-error-msg', msg);
          tcShow('tc-import-error');
          tcShow('btn-tc-import-error-download-log');
        },

        onAbort: () => {
          tcHide('btn-tc-import-stop');
          tcShow('btn-tc-import-again');
          tcSetText('tc-import-run-title', 'Import stopped');
          tcImportCtrl = null;
        },
      }
    );
  }

  function resetTcImport() {
    tcImportParsedCSV = null;
    tcCurrentDiff     = null;
    const fi = tc$('tc-import-file-input');
    if (fi) fi.value = '';
    tcHide('tc-import-step-map');
    tcHide('tc-import-step-preview');
    tcHide('tc-import-step-run');
    tcHide('tc-import-error');
    tcShow('tc-import-step-upload');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DELETE BY CSV — Step 1: Upload
  // ════════════════════════════════════════════════════════════════════════════

  function loadTcDeleteCsv(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text     = e.target.result;
      const headers  = parseCSVHeaders(text);
      const rowCount = countCSVDataRows(text);
      if (rowCount === 0) { alert('CSV appears empty.'); return; }
      tcDeleteCsvParsed = { raw: text, headers, rowCount };

      // Populate UUID column select
      const idSel     = tc$('tc-delete-csv-id-col');
      const handleSel = tc$('tc-delete-csv-handle-col');

      const skipOpt   = '<option value="">(⇢ skip)</option>';
      const colOpts   = headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');

      idSel.innerHTML     = skipOpt + colOpts;
      handleSel.innerHTML = skipOpt + colOpts;

      // Auto-detect
      const autoId = headers.find((h) => ['pb_id', 'id', 'uuid', 'team id', 'team_id'].includes(h.toLowerCase()));
      if (autoId) idSel.value = autoId;

      const autoHandle = headers.find((h) => ['handle', 'team handle', 'team_handle'].includes(h.toLowerCase()));
      if (autoHandle) handleSel.value = autoHandle;

      tcSetText('tc-delete-csv-subtitle', `${rowCount} rows · ${headers.length} columns`);
      updateTcDeleteCsvPreview();
      tcShow('tc-delete-csv-step-confirm');
    };
    reader.readAsText(file);
  }

  function updateTcDeleteCsvPreview() {
    if (!tcDeleteCsvParsed) return;
    const idCol     = tc$('tc-delete-csv-id-col')?.value;
    const handleCol = tc$('tc-delete-csv-handle-col')?.value;

    const preview = tc$('tc-delete-csv-preview');
    if (!preview) return;

    const parts = [];
    if (idCol)     parts.push(`UUID column: "${idCol}"`);
    if (handleCol) parts.push(`Handle column: "${handleCol}"`);

    if (parts.length === 0) {
      preview.textContent = 'Select at least one column to identify teams.';
    } else {
      preview.textContent = parts.join(' · ') + ` — up to ${tcDeleteCsvParsed.rowCount} deletion(s)`;
    }
    tcShow('tc-delete-csv-preview');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DELETE BY CSV — Step 3: Preview
  // ════════════════════════════════════════════════════════════════════════════

  async function runTcDeleteCsvPreview() {
    if (!tcDeleteCsvParsed) return;

    const idCol          = tc$('tc-delete-csv-id-col')?.value     || null;
    const handleCol      = tc$('tc-delete-csv-handle-col')?.value || null;
    const fallbackToHandle = tc$('tc-delete-csv-fallback')?.checked ?? false;

    if (!idCol && !handleCol) {
      alert('Select at least one column (UUID or handle) to identify teams for deletion.');
      return;
    }

    const btn = tc$('btn-tc-delete-csv-run');
    btn.disabled    = true;
    btn.textContent = 'Fetching preview…';

    try {
      const res = await fetch('/api/teams-crud/delete/preview', {
        method:  'POST',
        headers: buildHeaders(),
        body:    JSON.stringify({ csvText: tcDeleteCsvParsed.raw, idCol: idCol || undefined, handleCol: handleCol || undefined, fallbackToHandle }),
      });

      const data = await res.json();
      btn.disabled    = false;
      btn.textContent = 'Preview deletions →';

      if (!res.ok) {
        alert(`Preview failed: ${data.error || res.status}`);
        return;
      }

      tcShowDeleteCsvPreview(data);

    } catch (err) {
      btn.disabled    = false;
      btn.textContent = 'Preview deletions →';
      alert(`Preview failed: ${err.message}`);
    }
  }

  function tcShowDeleteCsvPreview({ toDelete, notFound }) {
    tcSetText('tc-delete-csv-preview-count',         String(toDelete.length));
    tcSetText('tc-delete-csv-preview-notfound-count', String(notFound.length));

    const rowsTbody = tc$('tc-delete-csv-preview-rows');
    rowsTbody.innerHTML = toDelete.length === 0
      ? '<tr><td colspan="4" class="text-muted text-sm">No matching teams found.</td></tr>'
      : toDelete.map((t) =>
          `<tr><td>${esc(t.name)}</td><td>${esc(t.handle)}</td><td class="text-sm text-muted">${esc(t.id)}</td><td>${esc(t.resolvedVia)}</td></tr>`
        ).join('');

    const notFoundBody = tc$('tc-delete-csv-preview-notfound-body');
    notFoundBody.innerHTML = notFound.length === 0
      ? '<span>None — all rows matched.</span>'
      : notFound.map((n) => `<div>Row ${n.row}: <strong>${esc(n.value)}</strong> — ${esc(n.reason)}</div>`).join('');

    const execBtn = tc$('btn-tc-delete-csv-preview-run');
    execBtn.disabled    = toDelete.length === 0;
    execBtn.textContent = toDelete.length === 0
      ? 'No teams to delete'
      : `🗑 Delete ${toDelete.length} team${toDelete.length !== 1 ? 's' : ''}`;

    tcHide('tc-delete-csv-step-confirm');
    tcShow('tc-delete-csv-step-preview');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DELETE BY CSV — Step 4: SSE
  // ════════════════════════════════════════════════════════════════════════════

  function startTcDeleteCsv() {
    if (!tcDeleteCsvParsed) return;

    const idCol          = tc$('tc-delete-csv-id-col')?.value     || null;
    const handleCol      = tc$('tc-delete-csv-handle-col')?.value || null;
    const fallbackToHandle = tc$('tc-delete-csv-fallback')?.checked ?? false;

    if (!idCol && !handleCol) {
      alert('Select at least one column (UUID or handle) to identify teams for deletion.');
      return;
    }

    tcHide('tc-delete-csv-step-preview');
    tcShow('tc-delete-csv-step-run');
    tcShow('tc-delete-csv-running');
    tcHide('tc-delete-csv-results');
    tcSetText('tc-delete-csv-run-title', 'Deleting teams…');
    tcSetText('tc-delete-csv-progress-msg', 'Starting…');
    tcSetText('tc-delete-csv-progress-pct', '0%');
    if (tc$('tc-delete-csv-progress-bar')) tc$('tc-delete-csv-progress-bar').style.width = '0%';

    if (tcDeleteCsvLogAppender) tcDeleteCsvLogAppender.reset();
    tcHide('tc-delete-csv-live-log');
    tcHide('btn-tc-delete-csv-download-log');
    tcShow('btn-tc-delete-csv-stop');

    tcDeleteCsvCtrl = subscribeSSE(
      '/api/teams-crud/delete/by-csv',
      { csvText: tcDeleteCsvParsed.raw, idCol: idCol || undefined, handleCol: handleCol || undefined, fallbackToHandle },
      {
        onProgress: ({ message, percent }) => {
          if (tc$('tc-delete-csv-progress-bar')) tc$('tc-delete-csv-progress-bar').style.width = `${Math.min(100, percent)}%`;
          tcSetText('tc-delete-csv-progress-msg', message);
          tcSetText('tc-delete-csv-progress-pct', `${percent}%`);
        },

        onLog: (entry) => {
          tcShow('tc-delete-csv-live-log');
          if (tcDeleteCsvLogAppender) tcDeleteCsvLogAppender(entry);
        },

        onComplete: (data) => {
          tcHide('btn-tc-delete-csv-stop');
          tcHide('tc-delete-csv-running');
          tcShow('tc-delete-csv-results');
          tcSetText('tc-delete-csv-run-title', 'Deletion complete');
          tcShow('btn-tc-delete-csv-download-log');

          const hasErrors  = data.errors > 0;
          const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
          const icon       = hasErrors ? '⚠️' : '✅';
          const skippedNote = data.skipped > 0 ? ` · ${data.skipped} skipped not found` : '';
          tc$('tc-delete-csv-summary-alert').innerHTML = `
            <div class="alert ${alertClass}">
              <span class="alert-icon">${icon}</span>
              <span>Deleted ${data.deleted} team${data.deleted !== 1 ? 's' : ''}${skippedNote} · ${data.errors} error(s)</span>
            </div>`;
        },

        onError: (msg) => {
          tcHide('btn-tc-delete-csv-stop');
          tcHide('tc-delete-csv-running');
          tcShow('tc-delete-csv-results');
          tcSetText('tc-delete-csv-run-title', 'Deletion failed');
          tcShow('btn-tc-delete-csv-download-log');
          tc$('tc-delete-csv-summary-alert').innerHTML = `
            <div class="alert alert-danger">
              <span class="alert-icon">⚠️</span>
              <span>${esc(msg)}</span>
            </div>`;
        },

        onAbort: () => {
          tcHide('btn-tc-delete-csv-stop');
          tcHide('tc-delete-csv-running');
          tcShow('tc-delete-csv-results');
          tcSetText('tc-delete-csv-run-title', 'Deletion stopped');
          tcShow('btn-tc-delete-csv-download-log');
          tc$('tc-delete-csv-summary-alert').innerHTML = `
            <div class="alert alert-warn">
              <span class="alert-icon">⏹</span>
              <span>Deletion stopped by user.</span>
            </div>`;
          tcDeleteCsvCtrl = null;
        },
      }
    );
  }

  function resetTcDeleteCsv() {
    tcDeleteCsvParsed = null;
    const fi = tc$('tc-delete-csv-file-input');
    if (fi) fi.value = '';
    tcHide('tc-delete-csv-step-confirm');
    tcHide('tc-delete-csv-step-preview');
    tcHide('tc-delete-csv-step-run');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DELETE ALL — SSE
  // ════════════════════════════════════════════════════════════════════════════

  function startTcDeleteAll() {
    tcHide('tc-delete-all-idle');
    tcShow('tc-delete-all-running');
    tcHide('tc-delete-all-results');
    tcSetText('tc-delete-all-progress-msg', 'Starting…');
    tcSetText('tc-delete-all-progress-pct', '0%');
    if (tc$('tc-delete-all-progress-bar')) tc$('tc-delete-all-progress-bar').style.width = '0%';

    if (tc$('tc-delete-all-log-entries')) tc$('tc-delete-all-log-entries').innerHTML = '';
    tcHide('tc-delete-all-live-log');

    tcDeleteAllCtrl = subscribeSSE(
      '/api/teams-crud/delete/all',
      {},
      {
        onProgress: ({ message, percent }) => {
          if (tc$('tc-delete-all-progress-bar')) tc$('tc-delete-all-progress-bar').style.width = `${Math.min(100, percent)}%`;
          tcSetText('tc-delete-all-progress-msg', message);
          tcSetText('tc-delete-all-progress-pct', `${percent}%`);
        },

        onLog: (entry) => {
          const logEl = tc$('tc-delete-all-live-log');
          const entries = tc$('tc-delete-all-log-entries');
          if (logEl && logEl.classList.contains('hidden')) tcShow('tc-delete-all-live-log');
          if (entries) {
            const e = document.createElement('div');
            e.className = `log-entry ${entry.level || 'info'}`;
            e.innerHTML = `<span class="log-msg">${esc(entry.message)}</span>`;
            entries.appendChild(e);
            entries.scrollTop = entries.scrollHeight;
          }
        },

        onComplete: (data) => {
          tcHide('tc-delete-all-running');
          tcShow('tc-delete-all-results');
          const hasErrors  = data.errors > 0;
          const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
          const icon       = hasErrors ? '⚠️' : '✅';
          const skippedNote = data.skipped > 0 ? ` · ${data.skipped} already gone` : '';
          tc$('tc-delete-all-summary-alert').innerHTML = `
            <div class="alert ${alertClass}">
              <span class="alert-icon">${icon}</span>
              <span>${data.deleted} teams deleted${skippedNote} · ${data.errors} error(s)</span>
            </div>`;
        },

        onError: (msg) => {
          tcHide('tc-delete-all-running');
          tcShow('tc-delete-all-results');
          tc$('tc-delete-all-summary-alert').innerHTML = `
            <div class="alert alert-danger">
              <span class="alert-icon">⚠️</span>
              <span>${esc(msg)}</span>
            </div>`;
        },
      }
    );
  }

  function resetTcDeleteAll() {
    if (tc$('tc-delete-all-confirm-input')) tc$('tc-delete-all-confirm-input').value = '';
    if (tc$('btn-tc-delete-all-run')) tc$('btn-tc-delete-all-run').disabled = true;
    tcHide('tc-delete-all-running');
    tcHide('tc-delete-all-results');
    tcShow('tc-delete-all-idle');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // TOKEN DISCONNECT — reset all state
  // ════════════════════════════════════════════════════════════════════════════

  function resetTcModuleOnDisconnect() {
    // Abort any in-flight SSE
    if (tcImportCtrl)    { tcImportCtrl.abort();    tcImportCtrl    = null; }
    if (tcDeleteCsvCtrl) { tcDeleteCsvCtrl.abort(); tcDeleteCsvCtrl = null; }
    if (tcDeleteAllCtrl) { tcDeleteAllCtrl.abort(); tcDeleteAllCtrl = null; }

    // Clear file inputs and in-memory buffers
    tcImportParsedCSV = null;
    tcCurrentDiff     = null;
    tcDeleteCsvParsed = null;
    tcExportBlob      = null;

    const fi1 = tc$('tc-import-file-input');
    const fi2 = tc$('tc-delete-csv-file-input');
    if (fi1) fi1.value = '';
    if (fi2) fi2.value = '';

    // Reset export
    tcHide('tc-export-done');
    tcHide('tc-export-error');
    tcShow('tc-export-idle');

    // Reset import panels
    tcHide('tc-import-step-map');
    tcHide('tc-import-step-preview');
    tcHide('tc-import-step-run');
    tcHide('tc-import-error');

    // Reset delete by CSV panels
    tcHide('tc-delete-csv-step-confirm');
    tcHide('tc-delete-csv-step-preview');
    tcHide('tc-delete-csv-step-run');

    // Reset delete all panel
    resetTcDeleteAll();
  }

  window.addEventListener('pb:disconnect', resetTcModuleOnDisconnect);

  // ════════════════════════════════════════════════════════════════════════════
  // MODULE INIT — called once by app.js after partial is loaded
  // ════════════════════════════════════════════════════════════════════════════

  let _tcInitDone = false;

  window.initTeamsCrudModule = function () {
    if (_tcInitDone) return;
    _tcInitDone = true;

    // Create log appenders now that DOM is available
    tcImportLogAppender    = makeLogAppender('tc-import-live-log',   'tc-import-log-entries',    'tc-import-log-counts',    'team');
    tcDeleteCsvLogAppender = makeLogAppender('tc-delete-csv-live-log', 'tc-delete-csv-log-entries', null, 'team');

    // ── Export ──────────────────────────────────────────────────────────────
    tc$('btn-tc-export').addEventListener('click', () => requireToken(startTcExport));

    tc$('btn-tc-export-download').addEventListener('click', () => {
      if (tcExportBlob) triggerDownload(tcExportBlob, tcExportFilename);
    });

    tc$('btn-tc-export-again').addEventListener('click', resetTcExport);
    tc$('btn-tc-export-retry').addEventListener('click', () => {
      tcHide('tc-export-error');
      tcShow('tc-export-idle');
    });

    // ── Import: upload dropzone ──────────────────────────────────────────────
    const importDropzone  = tc$('tc-import-dropzone');
    const importFileInput = tc$('tc-import-file-input');

    importDropzone.addEventListener('click', () => importFileInput.click());
    importDropzone.addEventListener('dragover',  (e) => { e.preventDefault(); importDropzone.classList.add('dragover'); });
    importDropzone.addEventListener('dragleave', () => importDropzone.classList.remove('dragover'));
    importDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      importDropzone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) loadTcImportCSV(file);
    });
    importFileInput.addEventListener('change', () => {
      if (importFileInput.files[0]) loadTcImportCSV(importFileInput.files[0]);
    });

    // ── Import: re-upload ────────────────────────────────────────────────────
    tc$('btn-tc-import-reupload').addEventListener('click', () => {
      tcImportParsedCSV = null;
      if (importFileInput) importFileInput.value = '';
      tcHide('tc-import-step-map');
      tcHide('tc-import-step-preview');
    });

    // ── Import: mapping change → auto-save ──────────────────────────────────
    ['tc-map-id', 'tc-map-name', 'tc-map-handle', 'tc-map-desc'].forEach((id) => {
      const el = tc$(id);
      if (el) el.addEventListener('change', saveTcMapping);
    });

    // ── Import: preview / back ───────────────────────────────────────────────
    tc$('btn-tc-import-preview').addEventListener('click', () => requireToken(runTcPreview));

    tc$('btn-tc-preview-back').addEventListener('click', () => {
      tcHide('tc-import-step-preview');
      tcShow('tc-import-step-map');
    });

    // ── Import: execute ──────────────────────────────────────────────────────
    tc$('btn-tc-import-execute').addEventListener('click', () => requireToken(startTcImport));

    tc$('btn-tc-import-stop').addEventListener('click', () => {
      if (tcImportCtrl) { tcImportCtrl.abort(); tcImportCtrl = null; }
    });

    tc$('btn-tc-import-again').addEventListener('click', resetTcImport);

    tc$('btn-tc-import-download-log').addEventListener('click', () => {
      if (tcImportLogAppender) downloadLogCsv(tcImportLogAppender, 'teams-import');
    });

    tc$('btn-tc-import-error-retry').addEventListener('click', resetTcImport);

    tc$('btn-tc-import-error-download-log').addEventListener('click', () => {
      if (tcImportLogAppender) downloadLogCsv(tcImportLogAppender, 'teams-import');
    });

    // ── Delete by CSV: upload dropzone ──────────────────────────────────────
    const deleteCsvDropzone  = tc$('tc-delete-csv-dropzone');
    const deleteCsvFileInput = tc$('tc-delete-csv-file-input');

    deleteCsvDropzone.addEventListener('click', () => deleteCsvFileInput.click());
    deleteCsvDropzone.addEventListener('dragover',  (e) => { e.preventDefault(); deleteCsvDropzone.classList.add('dragover'); });
    deleteCsvDropzone.addEventListener('dragleave', () => deleteCsvDropzone.classList.remove('dragover'));
    deleteCsvDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      deleteCsvDropzone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) loadTcDeleteCsv(file);
    });
    deleteCsvFileInput.addEventListener('change', () => {
      if (deleteCsvFileInput.files[0]) loadTcDeleteCsv(deleteCsvFileInput.files[0]);
    });

    // ── Delete by CSV: column pickers → update preview ───────────────────────
    tc$('tc-delete-csv-id-col').addEventListener('change',     updateTcDeleteCsvPreview);
    tc$('tc-delete-csv-handle-col').addEventListener('change', updateTcDeleteCsvPreview);

    tc$('btn-tc-delete-csv-reupload').addEventListener('click', () => {
      resetTcDeleteCsv();
    });

    tc$('btn-tc-delete-csv-run').addEventListener('click', () => requireToken(runTcDeleteCsvPreview));

    tc$('btn-tc-delete-csv-preview-back').addEventListener('click', () => {
      tcHide('tc-delete-csv-step-preview');
      tcShow('tc-delete-csv-step-confirm');
    });

    tc$('btn-tc-delete-csv-preview-run').addEventListener('click', () => requireToken(startTcDeleteCsv));

    tc$('btn-tc-delete-csv-stop').addEventListener('click', () => {
      if (tcDeleteCsvCtrl) { tcDeleteCsvCtrl.abort(); tcDeleteCsvCtrl = null; }
      tcHide('btn-tc-delete-csv-stop');
      tcShow('btn-tc-delete-csv-download-log');
    });

    tc$('btn-tc-delete-csv-again').addEventListener('click', () => {
      resetTcDeleteCsv();
    });

    tc$('btn-tc-delete-csv-download-log').addEventListener('click', () => {
      if (tcDeleteCsvLogAppender) downloadLogCsv(tcDeleteCsvLogAppender, 'teams-delete');
    });

    // ── Delete all: confirm input + run ──────────────────────────────────────
    tc$('tc-delete-all-confirm-input').addEventListener('input', (e) => {
      tc$('btn-tc-delete-all-run').disabled = e.target.value.trim() !== 'DELETE';
    });

    tc$('btn-tc-delete-all-run').addEventListener('click', () => requireToken(() => {
      if (tc$('tc-delete-all-confirm-input').value.trim() !== 'DELETE') return;
      startTcDeleteAll();
    }));

    tc$('btn-tc-delete-all-again').addEventListener('click', resetTcDeleteAll);
  };

})();
