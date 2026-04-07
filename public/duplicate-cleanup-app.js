/* =========================================================
   Duplicate Company Cleanup module
   Exposes: window.initDuplicateCleanupModule()
   ========================================================= */

(function () {
  'use strict';

  // ── Module state ─────────────────────────────────────────
  let _previewData = null;  // { domainRecords, skippedRows, totalDomains, totalDuplicates }
  let _runCtrl     = null;  // AbortController for run SSE
  let _actionLog   = null;  // action log from last run
  let _logAppender = null;
  let _inited      = false;

  // ── DOM helpers ───────────────────────────────────────────
  function dc$(id) { return document.getElementById(id); }
  function dcShow(id) { dc$(id)?.classList.remove('hidden'); }
  function dcHide(id) { dc$(id)?.classList.add('hidden'); }
  function dcText(id, text) { const el = dc$(id); if (el) el.textContent = text; }

  // ── View state ────────────────────────────────────────────
  const DC_STATES = ['idle', 'preview', 'running', 'results', 'error'];
  let _vs = null;

  function dcGo(state) { _vs?.go(state); }

  // ── Reset ─────────────────────────────────────────────────
  function resetModule() {
    if (_runCtrl) { _runCtrl.abort(); _runCtrl = null; }
    _previewData = null;
    _actionLog   = null;
    if (_logAppender) _logAppender.reset();
    dcGo('idle');
    dcHide('dc-input-error');
    // Reset file input
    const fileEl = dc$('dc-csv-file');
    if (fileEl) fileEl.value = '';
    const pasteEl = dc$('dc-csv-paste');
    if (pasteEl) { pasteEl.value = ''; pasteEl.classList.add('hidden'); }
    const pasteToggle = dc$('dc-paste-toggle');
    if (pasteToggle) pasteToggle.textContent = 'Paste CSV text';
    const dryRun = dc$('dc-dry-run');
    if (dryRun) dryRun.checked = true;
  }

  // ── Read CSV text from file or paste area ──────────────────
  function readCsvInput() {
    return new Promise((resolve, reject) => {
      const pasteEl = dc$('dc-csv-paste');
      const fileEl  = dc$('dc-csv-file');

      // Paste area takes priority if it has content
      if (pasteEl && !pasteEl.classList.contains('hidden') && pasteEl.value.trim()) {
        resolve(pasteEl.value.trim());
        return;
      }

      if (fileEl && fileEl.files && fileEl.files[0]) {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Failed to read file.'));
        reader.readAsText(fileEl.files[0]);
        return;
      }

      reject(new Error('Please upload a CSV file or paste CSV text.'));
    });
  }

  // ── Preview: parse CSV via server ─────────────────────────
  async function runPreview() {
    dcHide('dc-input-error');

    let csvText;
    try {
      csvText = await readCsvInput();
    } catch (err) {
      showInputError(err.message);
      return;
    }

    try {
      const res = await fetch('/api/duplicate-cleanup/preview', {
        method:  'POST',
        headers: buildHeaders(),
        body:    JSON.stringify({ csvText }),
      });
      const data = await res.json();
      if (!res.ok) {
        showInputError(data.error || `Request failed (${res.status})`);
        return;
      }
      _previewData = data;
      renderPreview(data);
      dcGo('preview');
    } catch (err) {
      showInputError(err.message);
    }
  }

  function showInputError(msg) {
    dcText('dc-input-error-msg', msg);
    dcShow('dc-input-error');
  }

  // ── Render preview table ───────────────────────────────────
  function renderPreview(data) {
    const { domainRecords, skippedRows, totalDomains, totalDuplicates } = data;
    const dryRun = dc$('dc-dry-run')?.checked !== false;

    // Summary banner
    const summaryEl = dc$('dc-preview-summary');
    if (summaryEl) {
      summaryEl.textContent = totalDomains > 0
        ? `${totalDomains} domain(s) · ${totalDuplicates} duplicate company UUID(s) to process` +
          (skippedRows.length ? ` · ${skippedRows.length} row(s) skipped` : '')
        : `No processable rows found.${skippedRows.length ? ` ${skippedRows.length} row(s) skipped.` : ''}`;
      summaryEl.className = totalDomains > 0 ? 'alert alert-ok' : 'alert alert-warn';
      summaryEl.style.marginBottom = '16px';
    }

    // Domains table
    const tbody = dc$('dc-domains-tbody');
    if (tbody) {
      tbody.innerHTML = '';
      if (domainRecords.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--c-muted);">No domains to process.</td></tr>';
      } else {
        for (const dr of domainRecords) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${esc(dr.domain)}</td>
            <td style="font-family:monospace;font-size:11px;">${esc(dr.sfCompanyId)}</td>
            <td style="text-align:center;">${dr.duplicateIds.length}</td>
          `;
          tbody.appendChild(tr);
        }
      }
    }

    // Skipped rows
    const skippedSection = dc$('dc-skipped-section');
    const skippedTbody   = dc$('dc-skipped-tbody');
    if (skippedSection && skippedTbody) {
      if (skippedRows.length > 0) {
        skippedSection.classList.remove('hidden');
        skippedTbody.innerHTML = '';
        for (const s of skippedRows) {
          const reasonLabel = s.reason === 'no_salesforce_uuid'
            ? 'No Salesforce UUID found'
            : `${(s.sfUuids || []).length} Salesforce UUIDs found (expected 1)`;
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${esc(s.domain)}</td>
            <td>${esc(reasonLabel)}</td>
            <td style="font-family:monospace;font-size:11px;">${esc((s.sfUuids || []).join(', ') || '—')}</td>
          `;
          skippedTbody.appendChild(tr);
        }
      } else {
        skippedSection.classList.add('hidden');
      }
    }

    // Run button label
    const runModeLabel = dc$('dc-run-mode-label');
    if (runModeLabel) {
      runModeLabel.textContent = dryRun ? '(dry run — no changes will be made)' : '(live — changes will be applied)';
    }

    // Disable run if nothing to process
    const runBtn = dc$('dc-run-btn');
    if (runBtn) runBtn.disabled = totalDomains === 0;
  }

  // ── Run cleanup via SSE ────────────────────────────────────
  function runCleanup() {
    if (!token) { requireToken(runCleanup); return; }
    if (!_previewData?.domainRecords?.length) return;

    const dryRun = dc$('dc-dry-run')?.checked !== false;

    dcGo('running');
    setProgress('dc', dryRun ? 'Starting dry run…' : 'Starting cleanup…', 0);
    if (_logAppender) _logAppender.reset();

    _runCtrl = subscribeSSE(
      '/api/duplicate-cleanup/run',
      { domainRecords: _previewData.domainRecords, dryRun },
      {
        onProgress({ message, percent }) {
          setProgress('dc', message, percent ?? 0);
        },
        onLog(entry) {
          if (_logAppender) _logAppender(entry);
        },
        onComplete(data) {
          _actionLog = data.actionLog || [];
          renderResults(data);
          dcGo('results');
        },
        onError(msg) {
          dcText('dc-error-msg', msg);
          dcGo('error');
        },
        onAbort() {
          // SSE was aborted client-side — results will arrive via onComplete with stopped=true
        },
      }
    );
  }

  // ── Render results summary ─────────────────────────────────
  function renderResults(data) {
    const { relinked = 0, deleted = 0, errors = 0, stopped = false, dryRun = true } = data;

    const summaryEl = dc$('dc-results-summary');
    if (!summaryEl) return;

    const hasErrors  = errors > 0;
    const alertClass = (stopped || hasErrors) ? 'alert-warn' : 'alert-ok';
    const icon       = stopped ? '⏹' : hasErrors ? '⚠️' : '✅';
    const modeLabel  = dryRun ? 'Dry run' : 'Cleanup';
    const status     = stopped ? `${modeLabel} stopped` : `${modeLabel} complete`;

    const parts = [];
    if (dryRun) {
      parts.push(`${relinked} relink(s) would be made`);
      parts.push(`${deleted === 0 ? _previewData?.totalDuplicates ?? 0 : deleted} company/companies would be deleted`);
    } else {
      if (relinked) parts.push(`${relinked} note(s) relinked`);
      if (deleted)  parts.push(`${deleted} company/companies deleted`);
    }
    if (errors) parts.push(`${errors} error(s)`);

    summaryEl.innerHTML = `
      <div class="alert ${alertClass}" style="margin-bottom:0;">
        <span class="alert-icon">${icon}</span>
        <span><strong>${status}.</strong> ${parts.join(' · ') || 'Nothing to do.'}${stopped ? ' (incomplete)' : ''}</span>
      </div>
    `;

    // Move log entries into results panel
    const runLogEl     = dc$('dc-run-log');
    const resultsLogEl = dc$('dc-results-log');
    const runEntries   = dc$('dc-log-entries');
    const resEntries   = dc$('dc-results-log-entries');
    const runCounts    = dc$('dc-log-counts');
    const resCounts    = dc$('dc-results-log-counts');

    if (runEntries && resEntries) {
      resEntries.innerHTML = runEntries.innerHTML;
    }
    if (runCounts && resCounts) {
      resCounts.innerHTML = runCounts.innerHTML;
    }
    if (resultsLogEl && runLogEl && !runLogEl.classList.contains('hidden')) {
      resultsLogEl.classList.remove('hidden');
    }
  }

  // ── Download action log as JSON ────────────────────────────
  function downloadActionLog() {
    if (!_actionLog) return;
    const json = JSON.stringify({ actions: _actionLog }, null, 2);
    const date = new Date().toISOString().slice(0, 10);
    triggerDownload(
      new Blob([json], { type: 'application/json;charset=utf-8;' }),
      `duplicate-cleanup-log-${date}.json`
    );
  }

  // ── Init ──────────────────────────────────────────────────
  function initDuplicateCleanupModule() {
    if (_inited) return;
    _inited = true;

    _vs = createViewState('dc', DC_STATES);

    _logAppender = makeLogAppender('dc-run-log', 'dc-log-entries', 'dc-log-counts');

    // Paste toggle
    dc$('dc-paste-toggle')?.addEventListener('click', () => {
      const pasteEl    = dc$('dc-csv-paste');
      const toggleBtn  = dc$('dc-paste-toggle');
      const fileEl     = dc$('dc-csv-file');
      if (!pasteEl) return;
      const showing = !pasteEl.classList.contains('hidden');
      pasteEl.classList.toggle('hidden', showing);
      if (toggleBtn) toggleBtn.textContent = showing ? 'Paste CSV text' : 'Hide paste area';
      if (fileEl)    fileEl.disabled = !showing;
    });

    // Preview button
    dc$('dc-preview-btn')?.addEventListener('click', () => {
      if (!token) { requireToken(runPreview); return; }
      runPreview();
    });

    // Back from preview
    dc$('dc-back-btn')?.addEventListener('click', () => dcGo('idle'));

    // Run button
    dc$('dc-run-btn')?.addEventListener('click', runCleanup);

    // Stop button
    dc$('dc-stop-btn')?.addEventListener('click', () => {
      if (_runCtrl) { _runCtrl.abort(); _runCtrl = null; }
    });

    // Download log
    dc$('dc-download-log-btn')?.addEventListener('click', downloadActionLog);

    // Reset / start over
    dc$('dc-reset-btn')?.addEventListener('click', resetModule);
    dc$('dc-error-reset-btn')?.addEventListener('click', () => dcGo('idle'));

    // Re-render run mode label when dry-run toggle changes (from preview state)
    dc$('dc-dry-run')?.addEventListener('change', () => {
      if (_vs?.current === 'preview' && _previewData) {
        const dryRun = dc$('dc-dry-run')?.checked !== false;
        const runModeLabel = dc$('dc-run-mode-label');
        if (runModeLabel) {
          runModeLabel.textContent = dryRun
            ? '(dry run — no changes will be made)'
            : '(live — changes will be applied)';
        }
        const runBtn = dc$('dc-run-btn');
        if (runBtn) runBtn.textContent = 'Run';
      }
    });

    // Disconnect: reset state
    window.addEventListener('pb:disconnect', resetModule);
  }

  window.initDuplicateCleanupModule = initDuplicateCleanupModule;
})();
