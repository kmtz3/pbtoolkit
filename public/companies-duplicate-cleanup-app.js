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
  let _compareDr       = null;  // domain record open in compare modal
  let _compareDrIdx    = 0;     // index in _previewData.domainRecords
  let _compareDupIdx   = 0;     // index into current dr's duplicates (non-target companies)

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
    dcHide('dc-results-download-log');
    dcHide('dc-error-download-log');
    closeCompareModal();
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
  function loadOrigins(refresh = false) {
    if (_originsLoading) return;
    if (!token) {
      dcHide('dc-origins-loading');
      showOriginsError('Connect to Productboard first to load sources.');
      return;
    }

    _originsLoading = true;
    dcShow('dc-origins-loading');
    dcHide('dc-origins-field');
    dcHide('dc-origins-error');

    const url = '/api/companies-duplicate-cleanup/origins' + (refresh ? '?refresh=true' : '');
    fetch(url, { headers: buildHeaders() })
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

        const list = dc$('dc-origin-list');
        if (list) {
          list.innerHTML = '';

          const displayOrigins = origins.filter(o => o !== 'manual');
          for (const o of displayOrigins) {
            const lbl = document.createElement('label');
            lbl.className = 'checkbox-label';
            const radio = document.createElement('input');
            radio.type  = 'radio';
            radio.name  = 'dc-origin';
            radio.value = o;
            if (o === 'salesforce' || (displayOrigins[0] === o && !displayOrigins.includes('salesforce'))) radio.checked = true;
            lbl.appendChild(radio);
            lbl.appendChild(document.createTextNode('\u00a0' + o.charAt(0).toUpperCase() + o.slice(1)));
            list.appendChild(lbl);
          }

          // Manual option (always last)
          const manualLbl = document.createElement('label');
          manualLbl.className = 'checkbox-label';
          const manualRadio = document.createElement('input');
          manualRadio.type  = 'radio';
          manualRadio.name  = 'dc-origin';
          manualRadio.value = '__manual__';
          if (displayOrigins.length === 0) manualRadio.checked = true;
          manualLbl.appendChild(manualRadio);
          manualLbl.appendChild(document.createTextNode('\u00a0Let me choose per group'));
          list.appendChild(manualLbl);
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

  // ── Scan: discover duplicates via API ─────────────────────
  function runScan() {
    if (!token) { requireToken(runScan); return; }

    const checkedOrigin = document.querySelector('input[name="dc-origin"]:checked')?.value;
    const manualMode    = checkedOrigin === '__manual__';
    const primaryOrigin = manualMode ? null : (checkedOrigin || 'salesforce');
    const matchCriteria = document.querySelector('input[name="dc-match"]:checked')?.value ?? 'domain';
    const fuzzyMatch    = dc$('dc-fuzzy-checkbox')?.checked ?? false;

    _fromRun = false;
    _selectedDomains = new Set();
    _groupCardEls    = new Map();
    dcGo('scanning');
    setProgress('dc', 'Starting scan…', 0);

    _scanCtrl = subscribeSSE(
      '/api/companies-duplicate-cleanup/scan',
      { primaryOrigin, manualMode, matchCriteria, fuzzyMatch },
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
            <td>${esc(s.matchName ? `${s.domain} · ${s.matchName}` : s.domain)}</td>
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
    // Seed stable order once — preserved across target swaps (mirrors notes-merge pattern)
    if (!dr.allCompanies) {
      dr.allCompanies = [
        {
          id:          dr.sfCompanyId,
          name:        dr.sfCompanyName,
          sourceOrigin: dr.sfCompanyOrigin || null,
          notesCount:  dr.sfNotesCount ?? null,
          usersCount:  dr.sfUsersCount ?? null,
        },
        ...(dr.duplicates || []),
      ];
    }
    const duplicates = dr.allCompanies.filter(c => c.id !== dr.sfCompanyId);
    const total      = dr.allCompanies.length;
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
    const hasCounts  = dr.allCompanies.some(c => c.notesCount != null);

    const countLabel = document.createElement('span');
    countLabel.className = 'nm-group-count';
    let countText = `${total} compan${total !== 1 ? 'ies' : 'y'} · ${duplicates.length} to delete`;
    if (hasCounts) countText += ` (${totalNotes} note${totalNotes !== 1 ? 's' : ''} + ${totalUsers} user${totalUsers !== 1 ? 's' : ''} to move)`;
    countLabel.textContent = countText;

    const domainLabel = document.createElement('span');
    domainLabel.className = 'nm-group-title';
    domainLabel.textContent = dr.matchName ? `${dr.domain} · ${dr.matchName}` : dr.domain;

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

    // All companies in stable original order — badge reflects current target
    for (const c of dr.allCompanies) {
      const isTarget = c.id === dr.sfCompanyId;
      const tr = document.createElement('tr');
      tr.style.height = '38px';
      const badge    = isTarget
        ? `<span class="badge badge-ok" style="font-size:10px;">Target</span>`
        : `<span class="badge badge-danger" style="font-size:10px;">Delete</span>`;
      const noteCell = c.notesCount != null
        ? `<td style="text-align:right;font-size:12px;">${c.notesCount}</td>`
        : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
      const userCell = c.usersCount != null
        ? `<td style="text-align:right;font-size:12px;">${c.usersCount}</td>`
        : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
      tr.innerHTML = `
        <td>${badge}</td>
        <td>${esc(c.name || c.id)}</td>
        <td style="font-family:monospace;font-size:11px;color:var(--c-muted);">${esc(c.id.slice(0, 18))}…</td>
        <td style="font-size:12px;">${esc(c.sourceOrigin || '—')}</td>
        ${hasCounts ? noteCell + userCell : ''}
        ${isManual  ? '<td></td>' : ''}
      `;
      if (isManual) {
        const actionCell = tr.lastElementChild;
        const setTargetBtn = document.createElement('button');
        setTargetBtn.className = 'btn btn-ghost btn-sm';
        setTargetBtn.textContent = 'Set as target';
        setTargetBtn.style.cssText = 'font-size:11px;white-space:nowrap;';
        if (isTarget) {
          setTargetBtn.style.visibility = 'hidden';
        } else {
          setTargetBtn.title = 'Set this company as the merge target — the others will be deleted';
          setTargetBtn.addEventListener('click', (e) => { e.stopPropagation(); swapTarget(dr, c); });
        }
        actionCell.appendChild(setTargetBtn);
      }
      if (isManual) {
        tr.style.cursor = 'pointer';
        tr.title = 'Click to compare';
        tr.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          if (isTarget) {
            openCompareModal(dr, _compareDr === dr ? _compareDupIdx : 0);
          } else {
            const dups = dcDuplicates(dr);
            const idx  = dups.findIndex(d => d.id === c.id);
            if (idx !== -1) openCompareModal(dr, idx);
          }
        });
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
    const oldTargetId  = dr.sfCompanyId;
    dr.sfCompanyId     = newTarget.id;
    dr.sfCompanyName   = newTarget.name;
    dr.sfCompanyOrigin = newTarget.sourceOrigin;
    dr.duplicates      = dr.allCompanies.filter(c => c.id !== newTarget.id);
    rerenderDomainBlock(dr);
    // Keep compare modal open and pointing at the old target (now a duplicate)
    if (_compareDr === dr) {
      const newDups = dcDuplicates(dr);
      const oldIdx  = newDups.findIndex(c => c.id === oldTargetId);
      _compareDupIdx = oldIdx !== -1 ? oldIdx : 0;
      renderComparePanel();
    }
  }

  function rerenderDomainBlock(dr) {
    const entry = _groupCardEls.get(dr);
    if (!entry) return;
    const wasOpen = entry.el.open;
    const newEl   = buildDomainBlock(dr, entry.di);
    newEl.open = wasOpen;
    entry.el.replaceWith(newEl);
  }

  // ── Compare modal (manual mode) ───────────────────────────

  function dcDuplicates(dr) {
    return dr.allCompanies
      ? dr.allCompanies.filter(c => c.id !== dr.sfCompanyId)
      : (dr.duplicates || []);
  }

  function openCompareModal(dr, dupIdx) {
    const records  = _previewData?.domainRecords || [];
    _compareDr     = dr;
    _compareDrIdx  = records.indexOf(dr);
    if (_compareDrIdx === -1) _compareDrIdx = 0;
    _compareDupIdx = dupIdx;
    renderComparePanel();
    dcShow('dc-compare-overlay');
  }

  function closeCompareModal() {
    dcHide('dc-compare-overlay');
    _compareDr = null;
  }

  function renderComparePanel() {
    if (!_compareDr) return;
    const dr      = _compareDr;
    const dups    = dcDuplicates(dr);
    const records = _previewData?.domainRecords || [];
    const target  = { id: dr.sfCompanyId, name: dr.sfCompanyName, sourceOrigin: dr.sfCompanyOrigin };
    const dup     = dups[_compareDupIdx];
    if (!dup) return;

    dcText('dc-cmp-group-nav',   `${_compareDrIdx + 1} / ${records.length}`);
    dcText('dc-cmp-group-label', dr.domain);
    dcText('dc-cmp-dup-nav',     `${_compareDupIdx + 1} / ${dups.length}`);

    const modalCb = dc$('dc-cmp-group-select');
    if (modalCb) modalCb.checked = _selectedDomains.has(dr);

    const prevGroupBtn = dc$('dc-cmp-prev-group');
    const nextGroupBtn = dc$('dc-cmp-next-group');
    const prevDupBtn   = dc$('dc-cmp-prev-dup');
    const nextDupBtn   = dc$('dc-cmp-next-dup');
    if (prevGroupBtn) prevGroupBtn.disabled = _compareDrIdx === 0;
    if (nextGroupBtn) nextGroupBtn.disabled = _compareDrIdx === records.length - 1;
    if (prevDupBtn)   prevDupBtn.disabled   = _compareDupIdx === 0;
    if (nextDupBtn)   nextDupBtn.disabled   = _compareDupIdx === dups.length - 1;

    // hasCounts: true if counts were ever fetched for this group (check allCompanies, not just current dups)
    const hasCounts   = dr.allCompanies.some(c => c.notesCount != null);
    const knownDups   = dups.filter(d => d.notesCount != null);
    const totalNotes  = knownDups.reduce((n, d) => n + d.notesCount, 0);
    const totalUsers  = knownDups.reduce((n, d) => n + (d.usersCount ?? 0), 0);
    // If no current dups have known counts (e.g. all were swapped to target), show null (→ "—") not 0
    const targetWithCounts = hasCounts
      ? { ...target, notesCount: knownDups.length > 0 ? totalNotes : null, usersCount: knownDups.length > 0 ? totalUsers : null }
      : target;

    const leftEl = dc$('dc-split-left');
    if (leftEl) leftEl.innerHTML = renderCompanyCard(targetWithCounts, dr.domain, 'TARGET — kept', true, hasCounts);

    const rightEl = dc$('dc-split-right');
    if (rightEl) {
      rightEl.innerHTML = renderCompanyCard(dup, dr.domain, `DUPLICATE ${_compareDupIdx + 1} — will be deleted`, false, hasCounts);
      const setBtn = document.createElement('button');
      setBtn.className = 'btn btn-secondary';
      setBtn.textContent = 'Set as target';
      setBtn.style.cssText = 'position:absolute;top:14px;right:18px;font-size:10px;padding:2px 7px;line-height:1.4;';
      setBtn.addEventListener('click', () => swapTarget(dr, dup));
      rightEl.appendChild(setBtn);
    }
  }

  function renderCompanyCard(c, domain, roleLabel, isTarget = false, hasCounts = false) {
    const noteLabel = isTarget ? 'Notes incoming (total)' : 'Notes to move';
    const userLabel = isTarget ? 'Users incoming (total)' : 'Users to move';
    const showSection = hasCounts || c.notesCount != null || c.usersCount != null;
    const noteVal = c.notesCount != null ? c.notesCount : '—';
    const userVal = c.usersCount != null ? c.usersCount : '—';
    const countRows = showSection ? `
      <div style="display:flex;gap:24px;margin-top:16px;padding-top:14px;border-top:1px solid var(--c-border);">
        <div><div style="font-size:11px;color:var(--c-muted);margin-bottom:2px;">${noteLabel}</div><div style="font-size:22px;font-weight:600;line-height:1;">${noteVal}</div></div>
        <div><div style="font-size:11px;color:var(--c-muted);margin-bottom:2px;">${userLabel}</div><div style="font-size:22px;font-weight:600;line-height:1;">${userVal}</div></div>
      </div>` : '';
    return `
      <div style="font-size:10px;font-weight:700;color:${isTarget ? 'var(--c-ok,#22c55e)' : 'var(--c-danger,#ef4444)'};letter-spacing:.06em;margin-bottom:10px;">${esc(roleLabel)}</div>
      <div style="font-size:18px;font-weight:600;margin-bottom:16px;word-break:break-word;">${esc(c.name || c.id)}</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr>
          <td style="color:var(--c-muted);padding:4px 0;white-space:nowrap;width:70px;vertical-align:top;">Domain</td>
          <td style="padding:4px 10px;">${esc(domain)}</td>
        </tr>
        <tr>
          <td style="color:var(--c-muted);padding:4px 0;vertical-align:top;">Source</td>
          <td style="padding:4px 10px;">${esc(c.sourceOrigin || '—')}</td>
        </tr>
        <tr>
          <td style="color:var(--c-muted);padding:4px 0;vertical-align:top;">UUID</td>
          <td style="padding:4px 10px;font-family:monospace;font-size:11px;word-break:break-all;">${esc(c.id)}</td>
        </tr>
      </table>
      ${countRows}
    `;
  }

  function navigateDomain(delta) {
    const records = _previewData?.domainRecords || [];
    const next    = _compareDrIdx + delta;
    if (next < 0 || next >= records.length) return;
    _compareDrIdx  = next;
    _compareDr     = records[next];
    _compareDupIdx = 0;
    renderComparePanel();
  }

  function navigateDup(delta) {
    if (!_compareDr) return;
    const dups = dcDuplicates(_compareDr);
    const next = _compareDupIdx + delta;
    if (next < 0 || next >= dups.length) return;
    _compareDupIdx = next;
    renderComparePanel();
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
    const intro    = _selectedDomains.size > 0
      ? `Merge ${records.length} selected group(s)?`
      : `Merge all ${records.length} group(s)?`;
    showConfirm(
      `${intro}\n\nNotes and users from ${dupCount} duplicate compan${dupCount !== 1 ? 'ies' : 'y'} will be relinked to their target company, then the duplicate${dupCount !== 1 ? 's' : ''} will be permanently deleted.\n\nThis cannot be undone. Export your companies data from Companies → Export first if you need a backup.`,
      { confirmText: 'Merge & delete', danger: true }
    ).then((confirmed) => { if (confirmed) runMerge(records); });
  }

  function startSingleGroupMerge(dr, groupNum) {
    const dupCount = dr.duplicates?.length ?? 0;
    showConfirm(
      `Merge group ${groupNum} (${dr.domain})?\n\nNotes and users from ${dupCount} duplicate compan${dupCount !== 1 ? 'ies' : 'y'} will be relinked to ${esc(dr.sfCompanyName || dr.sfCompanyId)}, then the duplicate${dupCount !== 1 ? 's' : ''} will be permanently deleted.\n\nThis cannot be undone.`,
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
          if (_logAppender?.getRows().length > 0) dcShow('dc-error-download-log');
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
    if (_logAppender?.getRows().length > 0) dcShow('dc-results-download-log');
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

    // Origins retry — opens connect modal if not yet authenticated
    dc$('dc-origins-retry')?.addEventListener('click', () => {
      _originsLoaded  = false;
      _originsLoading = false;
      requireToken(() => loadOrigins(true));
    });

    // Match criteria — enable fuzzy only when Domain + Name is selected
    document.querySelectorAll('input[name="dc-match"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const enabled = document.querySelector('input[name="dc-match"]:checked')?.value === 'domain+name';
        const label   = dc$('dc-fuzzy-label');
        if (label) {
          label.style.opacity       = enabled ? '1'    : '0.4';
          label.style.pointerEvents = enabled ? 'auto' : 'none';
        }
        if (!enabled) { const cb = dc$('dc-fuzzy-checkbox'); if (cb) cb.checked = false; }
      });
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

    // Adjust options → back to idle so user can change source selection before re-scanning
    dc$('dc-rescan-btn')?.addEventListener('click', () => dcGo('idle'));
    // No duplicates found → re-scan directly (options don't need changing)
    dc$('dc-no-dup-rescan')?.addEventListener('click', runScan);

    // Merge button
    dc$('dc-merge-btn')?.addEventListener('click', startMerge);

    // Run stop
    dc$('dc-run-stop')?.addEventListener('click', () => {
      if (_runCtrl) { _runCtrl.abort(); _runCtrl = null; }
    });

    // Results actions
    dc$('dc-back-to-preview')?.addEventListener('click', () => dcGo('preview'));
    dc$('dc-results-download-log')?.addEventListener('click', () => {
      if (_logAppender) downloadLogCsv(_logAppender, 'companies-merge');
    });
    dc$('dc-download-audit')?.addEventListener('click', downloadAuditLog);
    dc$('dc-start-over')?.addEventListener('click', resetModule);

    // Error actions
    dc$('dc-error-back-to-preview')?.addEventListener('click', () => dcGo('preview'));
    dc$('dc-error-download-log')?.addEventListener('click', () => {
      if (_logAppender) downloadLogCsv(_logAppender, 'companies-merge');
    });
    dc$('dc-error-retry')?.addEventListener('click', resetModule);

    // Compare modal
    dc$('dc-cmp-group-select')?.addEventListener('change', (e) => {
      if (!_compareDr) return;
      if (e.target.checked) _selectedDomains.add(_compareDr);
      else _selectedDomains.delete(_compareDr);
      // Sync the corresponding group card checkbox
      const entry = _groupCardEls.get(_compareDr);
      if (entry) {
        const cb = entry.el.querySelector('input[type=checkbox]');
        if (cb) cb.checked = e.target.checked;
      }
      updateSelectionUI();
    });
    dc$('dc-cmp-prev-group')?.addEventListener('click', () => navigateDomain(-1));
    dc$('dc-cmp-next-group')?.addEventListener('click', () => navigateDomain(1));
    dc$('dc-cmp-prev-dup')?.addEventListener('click',   () => navigateDup(-1));
    dc$('dc-cmp-next-dup')?.addEventListener('click',   () => navigateDup(1));
    dc$('dc-cmp-close')?.addEventListener('click', closeCompareModal);
    dc$('dc-compare-overlay')?.addEventListener('click', (e) => {
      if (e.target === dc$('dc-compare-overlay')) closeCompareModal();
    });
    document.addEventListener('keydown', (e) => {
      if (!_compareDr) return;
      if      (e.key === 'Escape')                      closeCompareModal();
      else if (e.key === 'ArrowLeft'  && !e.shiftKey)   navigateDup(-1);
      else if (e.key === 'ArrowRight' && !e.shiftKey)   navigateDup(1);
      else if (e.key === 'ArrowLeft'  &&  e.shiftKey)   navigateDomain(-1);
      else if (e.key === 'ArrowRight' &&  e.shiftKey)   navigateDomain(1);
    });

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
