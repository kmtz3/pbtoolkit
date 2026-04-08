/* =========================================================
   Merge Duplicate Companies module
   Exposes: window.initCompaniesDuplicateCleanupModule()
   ========================================================= */

(function () {
  'use strict';

  // ── Module state ─────────────────────────────────────────
  let _previewData     = null;  // { domainRecords, skippedRows, totalDomains, totalDuplicates }
  let _selectedDomains = new Set(); // domainRecord objects selected for merge
  let _groupCardEls    = new Map(); // domainRecord → { el: <details>, di: number }
  let _scanCtrl        = null;  // AbortController for scan SSE
  let _runCtrl         = null;  // AbortController for run SSE
  let _auditLog        = null;  // action log from last run
  let _logAppender     = null;
  let _fromRun         = false; // true if last error came from /run (enables back-to-preview)
  let _originsLoaded   = false;
  let _originsLoading  = false;
  let _inited          = false;

  // ── DOM helpers ───────────────────────────────────────────
  function dc$(id) { return document.getElementById(id); }
  function dcShow(id) { dc$(id)?.classList.remove('hidden'); }
  function dcHide(id) { dc$(id)?.classList.add('hidden'); }
  function dcText(id, text) { const el = dc$(id); if (el) el.textContent = text; }

  // ── View state ────────────────────────────────────────────
  const DC_STATES = ['idle', 'scanning', 'preview', 'running', 'results', 'error'];
  let _vs = null;

  function dcGo(state) { _vs?.go(state); }

  // ── Reset ─────────────────────────────────────────────────
  function resetModule() {
    if (_scanCtrl) { _scanCtrl.abort(); _scanCtrl = null; }
    if (_runCtrl)  { _runCtrl.abort();  _runCtrl  = null; }
    _previewData     = null;
    _selectedDomains = new Set();
    _groupCardEls    = new Map();
    _auditLog        = null;
    _fromRun         = false;
    if (_logAppender) _logAppender.reset();
    dcGo('idle');
    const gate = dc$('dc-gate-checkbox');
    if (gate) gate.checked = false;
    unlockScanConfig(false);
  }

  // ── Gate checkbox → unlock scan config ───────────────────
  function unlockScanConfig(enabled) {
    const cfg = dc$('dc-scan-config');
    if (cfg) {
      cfg.style.opacity       = enabled ? '1'    : '0.4';
      cfg.style.pointerEvents = enabled ? 'auto' : 'none';
    }
  }

  // ── Origins: fetch distinct source origins on load ────────
  function loadOrigins() {
    if (_originsLoading) return;
    if (!token) return;  // not authenticated yet — pb:connected will retry

    _originsLoading = true;
    dcShow('dc-origins-loading');
    dcHide('dc-origins-field');
    dcHide('dc-origins-all-manual');
    dcHide('dc-origins-error');

    fetch('/api/companies-duplicate-cleanup/origins', { headers: buildHeaders() })
      .then(res => res.json().then(data => ({ ok: res.ok, status: res.status, data })))
      .then(({ ok, status, data }) => {
        _originsLoading = false;
        dcHide('dc-origins-loading');

        if (!ok) {
          showOriginsError(data.error || `Failed to load origins (${status}).`);
          return;
        }

        const origins = data.origins || [];
        _originsLoaded = true;

        if (origins.length === 0) {
          // All companies have null origin — force manual mode
          dcShow('dc-origins-all-manual');
          const manualCb = dc$('dc-manual-checkbox');
          if (manualCb) { manualCb.checked = true; applyManualMode(true); }
          return;
        }

        // Populate dropdown
        const select = dc$('dc-origin-select');
        if (select) {
          select.innerHTML = '';
          for (const o of origins) {
            const opt = document.createElement('option');
            opt.value = o;
            opt.textContent = o;
            if (o === 'salesforce') opt.selected = true;
            select.appendChild(opt);
          }
          if (!origins.includes('salesforce')) select.selectedIndex = 0;
          // Ensure manual checkbox is disabled since a value is pre-selected
          applyOriginSelected(true);
        }
        dcShow('dc-origins-field');
      })
      .catch(err => {
        _originsLoading = false;
        dcHide('dc-origins-loading');
        showOriginsError(err.message || 'Network error loading origins.');
      });
  }

  function showOriginsError(msg) {
    dcText('dc-origins-error-msg', msg);
    dcShow('dc-origins-error');
  }

  // ── Mutual exclusion: dropdown ↔ manual checkbox ──────────
  function applyManualMode(isManual) {
    const select   = dc$('dc-origin-select');
    const manualCb = dc$('dc-manual-checkbox');
    if (isManual) {
      if (select)   select.disabled = true;
      if (manualCb) manualCb.disabled = false;
    } else {
      if (select)   select.disabled = false;
      if (manualCb) { manualCb.checked = false; manualCb.disabled = true; }
    }
  }

  function applyOriginSelected(hasValue) {
    const manualCb = dc$('dc-manual-checkbox');
    if (hasValue) {
      if (manualCb) { manualCb.checked = false; manualCb.disabled = true; }
    } else {
      if (manualCb) manualCb.disabled = false;
    }
  }

  // ── Scan: discover duplicates via API ─────────────────────
  function runScan() {
    if (!token) { requireToken(runScan); return; }

    const manualMode    = dc$('dc-manual-checkbox')?.checked === true;
    const primaryOrigin = manualMode ? null : (dc$('dc-origin-select')?.value || 'salesforce');

    _fromRun = false;
    _selectedDomains = new Set();
    _groupCardEls    = new Map();
    dcGo('scanning');
    setProgress('dc', 'Starting scan…', 0);

    _scanCtrl = subscribeSSE(
      '/api/companies-duplicate-cleanup/scan',
      { primaryOrigin, manualMode },
      {
        onProgress({ message, percent }) { setProgress('dc', message, percent ?? 0); },
        onLog() {},
        onComplete(data) {
          _scanCtrl = null;
          if (data.stopped) { dcGo('idle'); return; }
          _previewData = data;
          renderPreview(data);
          dcGo('preview');
        },
        onError(msg) {
          _scanCtrl = null;
          dcText('dc-error-msg', msg);
          dcGo('error');
        },
        onAbort() { dcGo('idle'); },
      }
    );
  }

  // ── Render preview ─────────────────────────────────────────
  function renderPreview(data) {
    const { domainRecords, skippedRows, totalDomains, totalDuplicates } = data;
    const isManual = domainRecords[0]?.isManualMode ?? false;

    // Summary banner
    const summaryText = dc$('dc-preview-summary-text');
    if (summaryText) {
      if (totalDomains > 0) {
        summaryText.textContent =
          `${totalDomains} domain group${totalDomains !== 1 ? 's' : ''} · ` +
          `${totalDuplicates} duplicate compan${totalDuplicates !== 1 ? 'ies' : 'y'} to delete` +
          (isManual ? ' · manual target selection' : '') +
          (skippedRows.length ? ` · ${skippedRows.length} skipped` : '');
      } else {
        summaryText.textContent = `No duplicate groups found.${skippedRows.length ? ` ${skippedRows.length} domain(s) skipped.` : ''}`;
      }
    }

    if (totalDomains === 0) {
      dcShow('dc-no-duplicates');
      dcHide('dc-groups-wrap');
    } else {
      dcHide('dc-no-duplicates');
      dcShow('dc-groups-wrap');

      const listEl = dc$('dc-groups-list');
      if (listEl) {
        listEl.innerHTML = '';
        _groupCardEls.clear();
        _selectedDomains.clear();
        domainRecords.forEach((dr, di) => { listEl.appendChild(buildDomainBlock(dr, di)); });
      }
    }

    // Skipped domains
    const skippedWrap  = dc$('dc-skipped-wrap');
    const skippedTbody = dc$('dc-skipped-tbody');
    if (skippedWrap && skippedTbody) {
      if (skippedRows.length > 0) {
        skippedWrap.classList.remove('hidden');
        dcText('dc-skipped-count', String(skippedRows.length));
        const origin    = skippedRows[0]?.primaryOrigin || 'selected origin';
        const reasonEl  = dc$('dc-skipped-reason');
        if (reasonEl) reasonEl.textContent = `zero or multiple "${origin}" companies found`;
        skippedTbody.innerHTML = '';
        for (const s of skippedRows) {
          const o = s.primaryOrigin || 'selected origin';
          const reasonLabel = s.reason === 'no_primary_origin'
            ? `No "${o}" company found`
            : `${(s.sfUuids || []).length} "${o}" companies found (expected 1)`;
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${esc(s.domain)}</td>
            <td>${esc(reasonLabel)}</td>
            <td style="font-family:monospace;font-size:11px;">${esc((s.sfUuids || []).join(', ') || '—')}</td>
          `;
          skippedTbody.appendChild(tr);
        }
      } else {
        skippedWrap.classList.add('hidden');
      }
    }

    updateSelectionUI();
  }

  // ── Build a collapsible domain group card ─────────────────
  function buildDomainBlock(dr, di) {
    const duplicates = dr.duplicates || [];
    const total      = 1 + duplicates.length;
    const isManual   = dr.isManualMode === true;

    const details = document.createElement('details');
    details.open = true;
    details.dataset.di = di;
    details.style.cssText = 'border:1px solid var(--c-border,#e2e8f0);border-radius:6px;margin-bottom:8px;overflow:hidden;';
    _groupCardEls.set(dr, { el: details, di });

    // ── Summary / header ──────────────────────────────────
    const summary = document.createElement('summary');
    summary.style.cssText = [
      'cursor:pointer;list-style:none;padding:10px 14px;',
      'display:flex;align-items:center;gap:10px;min-width:0;',
      'background:var(--c-bg-alt,#f8f9fa);font-size:13px;font-weight:500;user-select:none;',
    ].join('');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = _selectedDomains.has(dr);
    checkbox.style.cssText = 'cursor:pointer;flex-shrink:0;';
    checkbox.title = 'Select group for bulk merge';
    checkbox.addEventListener('click', (e) => { e.stopPropagation(); });
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) _selectedDomains.add(dr);
      else _selectedDomains.delete(dr);
      updateSelectionUI();
    });

    const groupLabel = document.createElement('span');
    groupLabel.className = 'nm-group-label';
    groupLabel.textContent = `Group ${di + 1}`;

    const totalNotes = duplicates.reduce((n, d) => n + (d.notesCount ?? 0), 0);
    const totalUsers = duplicates.reduce((n, d) => n + (d.usersCount ?? 0), 0);
    const hasCounts  = duplicates.some(d => d.notesCount != null);

    const countLabel = document.createElement('span');
    countLabel.className = 'nm-group-count';
    let countText = `${total} compan${total !== 1 ? 'ies' : 'y'} · ${duplicates.length} to delete`;
    if (hasCounts) countText += ` · ${totalNotes} note${totalNotes !== 1 ? 's' : ''} · ${totalUsers} user${totalUsers !== 1 ? 's' : ''} to move`;
    countLabel.textContent = countText;

    const domainLabel = document.createElement('span');
    domainLabel.className = 'nm-group-title';
    domainLabel.textContent = dr.domain;

    const spacer = document.createElement('span');
    spacer.className = 'nm-group-spacer';

    const mergeOneBtn = document.createElement('button');
    mergeOneBtn.className = 'btn btn-danger btn-sm';
    mergeOneBtn.textContent = 'Merge this group';
    mergeOneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startSingleGroupMerge(dr, di + 1);
    });

    summary.append(checkbox, groupLabel, countLabel, domainLabel, spacer, mergeOneBtn);
    details.appendChild(summary);

    // ── Compact table ─────────────────────────────────────
    const table = document.createElement('table');
    table.className = 'mapping-table';
    table.style.marginBottom = '0';
    table.innerHTML = `
      <thead>
        <tr>
          <th style="width:80px;">Role</th>
          <th>Company name</th>
          <th>UUID</th>
          <th>Source</th>
          ${hasCounts ? '<th style="text-align:right;width:60px;">Notes</th><th style="text-align:right;width:60px;">Users</th>' : ''}
          ${isManual  ? '<th style="width:110px;"></th>' : ''}
        </tr>
      </thead>
    `;
    const tbody = document.createElement('tbody');

    // Target row
    const targetTr = document.createElement('tr');
    targetTr.style.height = '38px';
    targetTr.innerHTML = `
      <td><span class="badge badge-ok" style="font-size:10px;">Target</span></td>
      <td style="font-weight:600;">${esc(dr.sfCompanyName || dr.sfCompanyId)}</td>
      <td style="font-family:monospace;font-size:11px;color:var(--c-muted);">${esc(dr.sfCompanyId.slice(0, 18))}…</td>
      <td style="font-size:12px;">${esc(dr.sfCompanyOrigin || '—')}</td>
      ${hasCounts ? '<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td><td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>' : ''}
      ${isManual  ? '<td></td>' : ''}
    `;
    tbody.appendChild(targetTr);

    // Duplicate rows
    for (const dup of duplicates) {
      const tr = document.createElement('tr');
      tr.style.height = '38px';
      const noteCell = dup.notesCount != null
        ? `<td style="text-align:right;font-size:12px;">${dup.notesCount}</td>`
        : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
      const userCell = dup.usersCount != null
        ? `<td style="text-align:right;font-size:12px;">${dup.usersCount}</td>`
        : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
      tr.innerHTML = `
        <td><span class="badge badge-danger" style="font-size:10px;">Delete</span></td>
        <td>${esc(dup.name || dup.id)}</td>
        <td style="font-family:monospace;font-size:11px;color:var(--c-muted);">${esc(dup.id.slice(0, 18))}…</td>
        <td style="font-size:12px;">${esc(dup.sourceOrigin || '—')}</td>
        ${hasCounts ? noteCell + userCell : ''}
        ${isManual  ? '<td></td>' : ''}
      `;
      if (isManual) {
        const actionCell = tr.lastElementChild;
        const setTargetBtn = document.createElement('button');
        setTargetBtn.className = 'btn btn-ghost btn-sm';
        setTargetBtn.textContent = 'Set as target';
        setTargetBtn.title = 'Set this company as the merge target — the others will be deleted';
        setTargetBtn.style.cssText = 'font-size:11px;white-space:nowrap;';
        setTargetBtn.addEventListener('click', (e) => { e.stopPropagation(); swapTarget(dr, dup); });
        actionCell.appendChild(setTargetBtn);
      }
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    const tableWrap = document.createElement('div');
    tableWrap.className = 'nm-group-table-wrap';
    tableWrap.appendChild(table);
    details.appendChild(tableWrap);
    return details;
  }

  // ── Target swap (manual mode only) ────────────────────────
  function swapTarget(dr, newTarget) {
    const oldTarget = { id: dr.sfCompanyId, name: dr.sfCompanyName, sourceOrigin: dr.sfCompanyOrigin || null };
    dr.duplicates = dr.duplicates.filter(d => d.id !== newTarget.id);
    dr.duplicates.unshift(oldTarget);
    dr.sfCompanyId     = newTarget.id;
    dr.sfCompanyName   = newTarget.name;
    dr.sfCompanyOrigin = newTarget.sourceOrigin;
    rerenderDomainBlock(dr);
  }

  function rerenderDomainBlock(dr) {
    const entry = _groupCardEls.get(dr);
    if (!entry) return;
    const wasOpen = entry.el.open;
    const newEl   = buildDomainBlock(dr, entry.di);
    newEl.open = wasOpen;
    entry.el.replaceWith(newEl);
  }

  // ── Selection toolbar UI ───────────────────────────────────
  function updateSelectionUI() {
    const anySelected = _selectedDomains.size > 0;
    const mergeBtn = dc$('dc-merge-btn');
    if (mergeBtn) {
      mergeBtn.textContent = anySelected
        ? `Merge & delete selected (${_selectedDomains.size})`
        : 'Merge & delete duplicates';
    }
    if (anySelected) { dcShow('dc-unselect-all'); dcShow('dc-invert-selection'); }
    else             { dcHide('dc-unselect-all'); dcHide('dc-invert-selection'); }
  }

  // ── Merge confirmation wrappers ────────────────────────────
  function startMerge() {
    if (!_previewData?.domainRecords?.length) return;
    const records  = _selectedDomains.size > 0 ? [..._selectedDomains] : _previewData.domainRecords;
    const dupCount = records.reduce((n, dr) => n + (dr.duplicates?.length ?? 0), 0);
    const label    = _selectedDomains.size > 0
      ? `Merge ${records.length} selected group(s) and permanently delete ${dupCount} duplicate compan${dupCount !== 1 ? 'ies' : 'y'}?`
      : `This will merge ${records.length} group(s) and permanently delete ${dupCount} duplicate compan${dupCount !== 1 ? 'ies' : 'y'}.`;
    showConfirm(
      `${label}\n\nThis cannot be undone. Export your companies data from Companies → Export first if you need a backup.`,
      { confirmText: 'Merge & delete', danger: true }
    ).then((confirmed) => { if (confirmed) runMerge(records); });
  }

  function startSingleGroupMerge(dr, groupNum) {
    const dupCount = dr.duplicates?.length ?? 0;
    showConfirm(
      `Merge group ${groupNum} (${dr.domain})?\n\nThis will relink all notes from ${dupCount} duplicate compan${dupCount !== 1 ? 'ies' : 'y'} and permanently delete them.\n\nThis cannot be undone.`,
      { confirmText: 'Merge this group', danger: true }
    ).then((confirmed) => { if (confirmed) runMerge([dr]); });
  }

  // ── Run merge via SSE ──────────────────────────────────────
  function runMerge(records) {
    if (!token) { requireToken(() => runMerge(records)); return; }
    const toProcess = records ?? (_selectedDomains.size > 0 ? [..._selectedDomains] : _previewData?.domainRecords ?? []);
    if (!toProcess.length) return;

    _fromRun = true;
    dcGo('running');
    setProgress('dc-run', 'Starting merge…', 0);
    if (_logAppender) _logAppender.reset();

    _runCtrl = subscribeSSE(
      '/api/companies-duplicate-cleanup/run',
      { domainRecords: toProcess, dryRun: false },
      {
        onProgress({ message, percent }) { setProgress('dc-run', message, percent ?? 0); },
        onLog(entry) { if (_logAppender) _logAppender(entry); },
        onComplete(data) {
          _runCtrl  = null;
          _auditLog = data.actionLog || [];
          renderResults(data);
          dcGo('results');
        },
        onError(msg) {
          _runCtrl = null;
          dcText('dc-error-msg', msg);
          if (_fromRun) dcShow('dc-error-back-to-preview');
          dcGo('error');
        },
        onAbort() {},
      }
    );
  }

  // ── Render results summary ─────────────────────────────────
  function renderResults(data) {
    const { notesRelinked = 0, usersRelinked = 0, deleted = 0, errors = 0, stopped = false } = data;
    const summaryEl = dc$('dc-results-summary');
    if (!summaryEl) return;

    const hasErrors  = errors > 0;
    const alertClass = (stopped || hasErrors) ? 'alert-warn' : 'alert-ok';
    const icon       = stopped ? '⏹' : hasErrors ? '⚠️' : '✅';
    const status     = stopped ? 'Merge stopped' : 'Merge complete';

    const parts = [];
    if (notesRelinked) parts.push(`${notesRelinked} note${notesRelinked !== 1 ? 's' : ''} relinked`);
    if (usersRelinked) parts.push(`${usersRelinked} user${usersRelinked !== 1 ? 's' : ''} updated`);
    if (deleted)       parts.push(`${deleted} compan${deleted !== 1 ? 'ies' : 'y'} deleted`);
    if (errors)        parts.push(`${errors} error${errors !== 1 ? 's' : ''}`);

    summaryEl.innerHTML = `
      <div class="alert ${alertClass}" style="margin-bottom:0;">
        <span class="alert-icon">${icon}</span>
        <span><strong>${status}.</strong> ${parts.join(' · ') || 'Nothing done.'}${stopped ? ' (incomplete)' : ''}</span>
      </div>
    `;

    const runEntries = dc$('dc-run-log-entries');
    const resEntries = dc$('dc-results-log-entries');
    const runCounts  = dc$('dc-run-log-counts');
    const resCounts  = dc$('dc-results-log-counts');
    if (runEntries && resEntries) resEntries.innerHTML = runEntries.innerHTML;
    if (runCounts  && resCounts)  resCounts.innerHTML  = runCounts.innerHTML;
    const runLogEl = dc$('dc-run-log');
    const resLogEl = dc$('dc-results-log');
    if (resLogEl && runLogEl && !runLogEl.classList.contains('hidden')) resLogEl.classList.remove('hidden');
  }

  // ── Download audit log ─────────────────────────────────────
  function downloadAuditLog() {
    if (!_auditLog) return;
    const json = JSON.stringify({ actions: _auditLog }, null, 2);
    const date = new Date().toISOString().slice(0, 10);
    triggerDownload(
      new Blob([json], { type: 'application/json;charset=utf-8;' }),
      `companies-duplicate-cleanup-log-${date}.json`
    );
  }

  // ── Init ──────────────────────────────────────────────────
  function initCompaniesDuplicateCleanupModule() {
    if (_inited) return;
    _inited = true;

    _vs = createViewState('dc', DC_STATES);
    _logAppender = makeLogAppender('dc-run-log', 'dc-run-log-entries', 'dc-run-log-counts');

    // Gate checkbox unlocks scan config
    dc$('dc-gate-checkbox')?.addEventListener('change', (e) => {
      unlockScanConfig(e.target.checked);
    });

    // Origin dropdown — disable manual checkbox when a value is selected
    dc$('dc-origin-select')?.addEventListener('change', (e) => {
      applyOriginSelected(!!e.target.value);
    });

    // Manual checkbox — disable dropdown when checked
    dc$('dc-manual-checkbox')?.addEventListener('change', (e) => {
      applyManualMode(e.target.checked);
    });

    // Origins retry
    dc$('dc-origins-retry')?.addEventListener('click', () => {
      _originsLoaded  = false;
      _originsLoading = false;
      loadOrigins();
    });

    // Scan button
    dc$('dc-scan-btn')?.addEventListener('click', runScan);

    // Scan stop
    dc$('dc-scan-stop')?.addEventListener('click', () => {
      if (_scanCtrl) { _scanCtrl.abort(); _scanCtrl = null; }
    });

    // Collapse / expand all groups
    dc$('dc-toggle-all-groups')?.addEventListener('click', () => {
      const allDetails = dc$('dc-groups-list')?.querySelectorAll('details[data-di]') || [];
      const anyOpen = [...allDetails].some(d => d.open);
      allDetails.forEach(d => { d.open = !anyOpen; });
      const btn = dc$('dc-toggle-all-groups');
      if (btn) btn.textContent = anyOpen ? 'Expand all' : 'Collapse all';
    });

    // Unselect all
    dc$('dc-unselect-all')?.addEventListener('click', () => {
      _selectedDomains.clear();
      dc$('dc-groups-list')?.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
      updateSelectionUI();
    });

    // Invert selection
    dc$('dc-invert-selection')?.addEventListener('click', () => {
      dc$('dc-groups-list')?.querySelectorAll('input[type=checkbox]').forEach((cb, i) => {
        const dr = _previewData?.domainRecords?.[i];
        if (!dr) return;
        cb.checked = !cb.checked;
        if (cb.checked) _selectedDomains.add(dr);
        else _selectedDomains.delete(dr);
      });
      updateSelectionUI();
    });

    // Adjust options / re-scan from preview
    dc$('dc-rescan-btn')?.addEventListener('click', runScan);
    dc$('dc-no-dup-rescan')?.addEventListener('click', runScan);

    // Merge button
    dc$('dc-merge-btn')?.addEventListener('click', startMerge);

    // Run stop
    dc$('dc-run-stop')?.addEventListener('click', () => {
      if (_runCtrl) { _runCtrl.abort(); _runCtrl = null; }
    });

    // Results actions
    dc$('dc-back-to-preview')?.addEventListener('click', () => dcGo('preview'));
    dc$('dc-download-audit')?.addEventListener('click', downloadAuditLog);
    dc$('dc-start-over')?.addEventListener('click', resetModule);

    // Error actions
    dc$('dc-error-back-to-preview')?.addEventListener('click', () => dcGo('preview'));
    dc$('dc-error-retry')?.addEventListener('click', resetModule);

    // Disconnect: clear origins state + reset
    window.addEventListener('pb:disconnect', () => {
      _originsLoaded  = false;
      _originsLoading = false;
      resetModule();
    });

    // Retry origins on connect
    window.addEventListener('pb:connected', () => {
      if (!_originsLoaded && !_originsLoading) loadOrigins();
    });

    // Auto-load origins if already authenticated
    loadOrigins();
  }

  window.initCompaniesDuplicateCleanupModule = initCompaniesDuplicateCleanupModule;
})();
