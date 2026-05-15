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
  let _auditLog        = null;  // cumulative action log across all run segments
  let _pendingRun      = null;  // original toProcess list for current run (enables continue)
  let _pendingRunOpts  = null;  // { keepDuplicates, archiveDuplicates } captured at run start
  let _logAppender     = null;
  let _fromRun         = false; // true if last error came from /run (enables back-to-preview)
  let _originsLoaded   = false;
  let _originsLoading  = false;
  let _inited          = false;
  let _compareDr       = null;  // domain record open in compare modal
  let _compareDrIdx    = 0;     // index in _previewData.domainRecords
  let _compareDupIdx   = 0;     // index into current dr's duplicates (non-target companies)
  let _vs              = null;  // createViewState handle

  // ── DOM helpers ───────────────────────────────────────────
  function dc$(id) { return document.getElementById(id); }
  function dcShow(id) { dc$(id)?.classList.remove('hidden'); }
  function dcHide(id) { dc$(id)?.classList.add('hidden'); }
  function dcText(id, text) { const el = dc$(id); if (el) el.textContent = text; }

  // ── View state ────────────────────────────────────────────
  const DC_STATES = ['idle', 'scanning', 'preview', 'running', 'results', 'error'];

  function dcGo(state) { _vs?.go(state); }

  // ── Reset ─────────────────────────────────────────────────
  function resetModule() {
    if (_scanCtrl) { _scanCtrl.abort(); _scanCtrl = null; }
    if (_runCtrl)  { _runCtrl.abort();  _runCtrl  = null; }
    _previewData     = null;
    _selectedDomains = new Set();
    _groupCardEls    = new Map();
    _auditLog        = null;
    _pendingRun      = null;
    _pendingRunOpts  = null;
    _fromRun         = false;
    _originsLoaded   = false;
    _originsLoading  = false;
    if (_logAppender) _logAppender.reset();
    dcHide('dc-results-download-log');
    dcHide('dc-download-survivors');
    dcHide('dc-error-download-log');
    closeCompareModal();
    dcGo('idle');
    const gate = dc$('dc-gate-checkbox');
    if (gate) gate.checked = false;
    const keepCb    = dc$('dc-keep-checkbox');    if (keepCb)    keepCb.checked    = false;
    const archiveCb = dc$('dc-archive-checkbox'); if (archiveCb) archiveCb.checked = false;
    dc$('dc-archive-label')?.classList.add('is-disabled-ctl');
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
          const displayOrigins = origins.filter(o => o !== 'manual');
          const autoDefault = o => o === 'salesforce' || (displayOrigins[0] === o && !displayOrigins.includes('salesforce'));
          list.innerHTML =
            displayOrigins.map(o =>
              `<label class="checkbox-label"><input type="radio" name="dc-origin" value="${esc(o)}"${autoDefault(o) ? ' checked' : ''}>&nbsp;${esc(o.charAt(0).toUpperCase() + o.slice(1))}</label>`
            ).join('') +
            `<label class="checkbox-label"><input type="radio" name="dc-origin" value="__manual__"${displayOrigins.length === 0 ? ' checked' : ''}>&nbsp;Let me choose per group</label>`;
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
    const fuzzyMatch    = matchCriteria === 'name'
      ? (dc$('dc-fuzzy-name-checkbox')?.checked ?? false)
      : (dc$('dc-fuzzy-checkbox')?.checked ?? false);
    const noDomainOnly  = matchCriteria === 'name' && (dc$('dc-no-domain-only-checkbox')?.checked ?? false);

    _fromRun = false;
    _selectedDomains = new Set();
    _groupCardEls    = new Map();
    dcGo('scanning');
    setProgress('dc', 'Starting scan…', 0);

    _scanCtrl = subscribeSSE(
      '/api/companies-duplicate-cleanup/scan',
      { primaryOrigin, manualMode, matchCriteria, fuzzyMatch, noDomainOnly },
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
    const { domainRecords, skippedRows, totalDomains, totalDuplicates, matchCriteria, fuzzyMatch } = data;
    const isManual = domainRecords[0]?.isManualMode ?? false;

    // Summary banner
    const summaryText = dc$('dc-preview-summary-text');
    if (summaryText) {
      if (totalDomains > 0) {
        const matchLabel = matchCriteria
          ? ` · ${matchCriteria}${fuzzyMatch ? ' (fuzzy)' : ''} match`
          : '';
        const opts = readMergeOptions();
        const fate = opts.keepDuplicates ? 'to keep' : 'to delete';
        summaryText.textContent =
          `${totalDomains} group${totalDomains !== 1 ? 's' : ''} · ` +
          `${totalDuplicates} duplicate compan${totalDuplicates !== 1 ? 'ies' : 'y'} ${fate}` +
          (isManual ? ' · manual target selection' : '') +
          matchLabel +
          (skippedRows.length ? ` · ${skippedRows.length} skipped` : '');
      } else {
        summaryText.textContent = `No duplicate groups found.${skippedRows.length ? ` ${skippedRows.length} domain(s) skipped.` : ''}`;
      }
    }
    renderPreviewMode();

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
            : `${(s.primaryUuids || []).length} "${o}" companies found (expected 1)`;
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td>${esc(s.domain ? (s.matchName ? `${s.domain} · ${s.matchName}` : s.domain) : (s.matchName || '(no domain)'))}</td>
            <td>${esc(reasonLabel)}</td>
            <td style="font-family:monospace;font-size:11px;">${esc((s.primaryUuids || []).join(', ') || '—')}</td>
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
          id:             dr.primaryId,
          name:           dr.primaryName,
          domain:         dr.primaryDomain || null,
          sourceOrigin:   dr.primaryOrigin || null,
          sourceRecordId: dr.primarySourceRecordId || null,
          notesCount:     dr.primaryNotesCount    ?? null,
          usersCount:     dr.primaryUsersCount    ?? null,
          entitiesCount:  dr.primaryEntitiesCount ?? null,
        },
        ...(dr.duplicates || []),
      ];
    }
    const duplicates = dr.allCompanies.filter(c => c.id !== dr.primaryId);
    const total      = dr.allCompanies.length;
    const isManual   = dr.isManualMode === true;

    const details = document.createElement('details');
    details.open = true;
    details.dataset.di = di;
    details.style.cssText = 'border:1px solid var(--c-border,#e2e8f0);border-radius:6px;margin-bottom:8px;overflow:hidden;';
    details.addEventListener('toggle', () => {
      const allDetails = dc$('dc-groups-list')?.querySelectorAll('details[data-di]') || [];
      const anyOpen = [...allDetails].some(d => d.open);
      const btn = dc$('dc-toggle-all-groups');
      if (btn) btn.textContent = anyOpen ? 'Collapse all' : 'Expand all';
    });
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

    const totalNotes    = duplicates.reduce((n, d) => n + (d.notesCount    ?? 0), 0);
    const totalUsers    = duplicates.reduce((n, d) => n + (d.usersCount    ?? 0), 0);
    const totalEntities = duplicates.reduce((n, d) => n + (d.entitiesCount ?? 0), 0);
    const hasCounts  = dr.allCompanies.some(c => c.notesCount != null);

    const countLabel = document.createElement('span');
    countLabel.className = 'nm-group-count';
    let countText = `${total} compan${total !== 1 ? 'ies' : 'y'} · ${duplicates.length} to delete`;
    if (hasCounts) countText += ` (${totalNotes} note${totalNotes !== 1 ? 's' : ''} + ${totalUsers} user${totalUsers !== 1 ? 's' : ''} + ${totalEntities} entit${totalEntities !== 1 ? 'ies' : 'y'} to relink)`;
    countLabel.textContent = countText;

    const domainLabel = document.createElement('span');
    domainLabel.className = 'nm-group-title';
    domainLabel.textContent = dr.domain
      ? (dr.matchName ? `${dr.domain} · ${dr.matchName}` : dr.domain)
      : (dr.matchName || '(no domain)');

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
          <th>Domain</th>
          <th>UUID</th>
          <th>Source</th>
          ${hasCounts ? '<th style="text-align:right;width:60px;">Notes</th><th style="text-align:right;width:60px;">Users</th><th style="text-align:right;width:72px;" title="Linked entities (features, components, etc.) attached to this company that will be relinked to the target.">Entities</th>' : ''}
          ${isManual  ? '<th style="width:110px;"></th>' : ''}
        </tr>
      </thead>
    `;
    const tbody = document.createElement('tbody');

    // Pre-compute totals incoming to target from all duplicates (non-manual auto mode display)
    const dupCompanies   = dr.allCompanies.filter(c => c.id !== dr.primaryId);
    const incomingNotes    = dupCompanies.every(d => d.notesCount != null)
      ? dupCompanies.reduce((n, d) => n + d.notesCount, 0) : null;
    const incomingUsers    = dupCompanies.every(d => d.usersCount != null)
      ? dupCompanies.reduce((n, d) => n + (d.usersCount ?? 0), 0) : null;
    const incomingEntities = dupCompanies.every(d => d.entitiesCount != null)
      ? dupCompanies.reduce((n, d) => n + (d.entitiesCount ?? 0), 0) : null;

    // All companies in stable original order — badge reflects current target
    for (const c of dr.allCompanies) {
      const isTarget = c.id === dr.primaryId;
      const tr = document.createElement('tr');
      tr.style.height = '38px';
      const badge    = isTarget
        ? `<span class="badge badge-ok" style="font-size:10px;">Target</span>`
        : `<span class="badge badge-danger" style="font-size:10px;">Delete</span>`;
      let noteCell, userCell, entCell;
      if (isTarget && !isManual) {
        noteCell = incomingNotes != null
          ? `<td style="text-align:right;font-size:12px;color:var(--c-ok,#22c55e);font-weight:600;">+${incomingNotes}</td>`
          : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
        userCell = incomingUsers != null
          ? `<td style="text-align:right;font-size:12px;color:var(--c-ok,#22c55e);font-weight:600;">+${incomingUsers}</td>`
          : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
        entCell  = incomingEntities != null
          ? `<td style="text-align:right;font-size:12px;color:var(--c-ok,#22c55e);font-weight:600;">+${incomingEntities}</td>`
          : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
      } else if (isTarget && isManual) {
        const inNoteTag = incomingNotes != null && incomingNotes > 0
          ? `<span style="color:var(--c-ok,#22c55e);font-weight:600;margin-left:4px;">(+${incomingNotes})</span>` : '';
        const inUserTag = incomingUsers != null && incomingUsers > 0
          ? `<span style="color:var(--c-ok,#22c55e);font-weight:600;margin-left:4px;">(+${incomingUsers})</span>` : '';
        const inEntTag  = incomingEntities != null && incomingEntities > 0
          ? `<span style="color:var(--c-ok,#22c55e);font-weight:600;margin-left:4px;">(+${incomingEntities})</span>` : '';
        noteCell = `<td style="text-align:right;font-size:12px;">${c.notesCount    != null ? c.notesCount    : '—'}${inNoteTag}</td>`;
        userCell = `<td style="text-align:right;font-size:12px;">${c.usersCount    != null ? c.usersCount    : '—'}${inUserTag}</td>`;
        entCell  = `<td style="text-align:right;font-size:12px;">${c.entitiesCount != null ? c.entitiesCount : '—'}${inEntTag}</td>`;
      } else {
        noteCell = c.notesCount != null
          ? `<td style="text-align:right;font-size:12px;">${c.notesCount}</td>`
          : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
        userCell = c.usersCount != null
          ? `<td style="text-align:right;font-size:12px;">${c.usersCount}</td>`
          : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
        entCell  = c.entitiesCount != null
          ? `<td style="text-align:right;font-size:12px;">${c.entitiesCount}</td>`
          : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
      }
      tr.innerHTML = `
        <td>${badge}</td>
        <td>${esc(c.name || c.id)}</td>
        <td style="font-size:12px;color:var(--c-muted);">${esc(c.domain || '—')}</td>
        <td style="font-family:monospace;font-size:11px;color:var(--c-muted);">${esc(c.id.slice(0, 18))}…</td>
        <td style="font-size:12px;">${esc(c.sourceOrigin || '—')}</td>
        ${hasCounts ? noteCell + userCell + entCell : ''}
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
    const oldTargetId  = dr.primaryId;
    dr.primaryId             = newTarget.id;
    dr.primaryName           = newTarget.name;
    dr.primaryDomain         = newTarget.domain || null;
    dr.primaryOrigin         = newTarget.sourceOrigin;
    dr.primarySourceRecordId = newTarget.sourceRecordId || null;
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
      ? dr.allCompanies.filter(c => c.id !== dr.primaryId)
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
    const target  = { id: dr.primaryId, name: dr.primaryName, domain: dr.primaryDomain || null, sourceOrigin: dr.primaryOrigin, sourceRecordId: dr.primarySourceRecordId || null };
    const dup     = dups[_compareDupIdx];
    if (!dup) return;

    dcText('dc-cmp-group-nav',   `${_compareDrIdx + 1} / ${records.length}`);
    dcText('dc-cmp-group-label', dr.domain || dr.matchName || '(no domain)');
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
    const totalNotes    = knownDups.reduce((n, d) => n + d.notesCount, 0);
    const totalUsers    = knownDups.reduce((n, d) => n + (d.usersCount    ?? 0), 0);
    const totalEntities = knownDups.reduce((n, d) => n + (d.entitiesCount ?? 0), 0);
    // If no current dups have known counts (e.g. all were swapped to target), show null (→ "—") not 0
    const targetWithCounts = hasCounts
      ? { ...target,
          notesCount:    knownDups.length > 0 ? totalNotes    : null,
          usersCount:    knownDups.length > 0 ? totalUsers    : null,
          entitiesCount: knownDups.length > 0 ? totalEntities : null }
      : target;

    const leftEl = dc$('dc-split-left');
    if (leftEl) leftEl.innerHTML = renderCompanyCard(targetWithCounts, 'TARGET — kept', true, hasCounts);

    const rightEl = dc$('dc-split-right');
    if (rightEl) {
      rightEl.innerHTML = renderCompanyCard(dup, `DUPLICATE ${_compareDupIdx + 1} — will be deleted`, false, hasCounts);
      const setBtn = document.createElement('button');
      setBtn.className = 'btn btn-secondary';
      setBtn.textContent = 'Set as target';
      setBtn.style.cssText = 'position:absolute;top:14px;right:18px;font-size:10px;padding:2px 7px;line-height:1.4;';
      setBtn.addEventListener('click', () => swapTarget(dr, dup));
      rightEl.appendChild(setBtn);
    }
  }

  function renderCompanyCard(c, roleLabel, isTarget = false, hasCounts = false) {
    const noteLabel = isTarget ? 'Notes incoming (total)'    : 'Notes to move';
    const userLabel = isTarget ? 'Users incoming (total)'    : 'Users to move';
    const entLabel  = isTarget ? 'Entities incoming (total)' : 'Entities to relink';
    const showSection = hasCounts || c.notesCount != null || c.usersCount != null || c.entitiesCount != null;
    const noteVal = c.notesCount != null
      ? (isTarget && c.notesCount > 0 ? `<span style="color:var(--c-ok,#22c55e);">+${c.notesCount}</span>` : c.notesCount)
      : '—';
    const userVal = c.usersCount != null
      ? (isTarget && c.usersCount > 0 ? `<span style="color:var(--c-ok,#22c55e);">+${c.usersCount}</span>` : c.usersCount)
      : '—';
    const entVal  = c.entitiesCount != null
      ? (isTarget && c.entitiesCount > 0 ? `<span style="color:var(--c-ok,#22c55e);">+${c.entitiesCount}</span>` : c.entitiesCount)
      : '—';
    const countRows = showSection ? `
      <div style="display:flex;gap:24px;margin-top:16px;padding-top:14px;border-top:1px solid var(--c-border);">
        <div><div style="font-size:11px;color:var(--c-muted);margin-bottom:2px;">${noteLabel}</div><div style="font-size:22px;font-weight:600;line-height:1;">${noteVal}</div></div>
        <div><div style="font-size:11px;color:var(--c-muted);margin-bottom:2px;">${userLabel}</div><div style="font-size:22px;font-weight:600;line-height:1;">${userVal}</div></div>
        <div><div style="font-size:11px;color:var(--c-muted);margin-bottom:2px;">${entLabel}</div><div style="font-size:22px;font-weight:600;line-height:1;">${entVal}</div></div>
      </div>` : '';
    return `
      <div style="font-size:10px;font-weight:700;color:${isTarget ? 'var(--c-ok,#22c55e)' : 'var(--c-danger,#ef4444)'};letter-spacing:.06em;margin-bottom:10px;">${esc(roleLabel)}</div>
      <div style="font-size:18px;font-weight:600;margin-bottom:16px;word-break:break-word;">${esc(c.name || c.id)}</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr>
          <td style="color:var(--c-muted);padding:4px 0;white-space:nowrap;width:70px;vertical-align:top;">Domain</td>
          <td style="padding:4px 10px;">${esc(c.domain || '—')}</td>
        </tr>
        <tr>
          <td style="color:var(--c-muted);padding:4px 0;vertical-align:top;">Source</td>
          <td style="padding:4px 10px;">${esc(c.sourceOrigin || '—')}</td>
        </tr>
        <tr>
          <td style="color:var(--c-muted);padding:4px 0;vertical-align:top;white-space:nowrap;">Source record ID</td>
          <td style="padding:4px 10px;font-family:monospace;font-size:11px;word-break:break-all;">${esc(c.sourceRecordId || '—')}</td>
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
    // Selection toolbar buttons stay visible at all times so the user can use
    // "Select all" without needing to tick a row first.
  }

  // ── Merge confirmation wrappers ────────────────────────────
  function startMerge() {
    if (!_previewData?.domainRecords?.length) return;
    const records  = _selectedDomains.size > 0 ? [..._selectedDomains] : _previewData.domainRecords;
    const dupCount = records.reduce((n, dr) => n + (dr.duplicates?.length ?? 0), 0);
    const intro    = _selectedDomains.size > 0
      ? `Merge ${records.length} selected group(s)?`
      : `Merge all ${records.length} group(s)?`;
    const opts = readMergeOptions();
    const actionSuffix = opts.keepDuplicates
      ? (opts.archiveDuplicates ? 'kept (and archived)' : 'kept (not deleted)')
      : `permanently deleted`;
    const tail = opts.keepDuplicates
      ? `\n\nDuplicate compan${dupCount !== 1 ? 'ies' : 'y'} will not be deleted — you can review and clean up later using the surviving-UUIDs CSV.`
      : `\n\nThis cannot be undone. Export your companies data from Companies → Export first if you need a backup.`;
    showConfirm(
      `${intro}\n\nNotes, users, and linked entities from ${dupCount} duplicate compan${dupCount !== 1 ? 'ies' : 'y'} will be relinked to their target company, then the duplicate${dupCount !== 1 ? 's' : ''} will be ${actionSuffix}.${tail}`,
      { confirmText: opts.keepDuplicates ? 'Merge & keep' : 'Merge & delete', danger: !opts.keepDuplicates }
    ).then((confirmed) => { if (confirmed) runMerge(records); });
  }

  function startSingleGroupMerge(dr, groupNum) {
    const dupCount = dr.duplicates?.length ?? 0;
    const opts = readMergeOptions();
    const actionSuffix = opts.keepDuplicates
      ? (opts.archiveDuplicates ? 'kept (and archived)' : 'kept (not deleted)')
      : `permanently deleted`;
    showConfirm(
      `Merge group ${groupNum} (${dr.domain || dr.matchName || 'no domain'})?\n\nNotes, users, and linked entities from ${dupCount} duplicate compan${dupCount !== 1 ? 'ies' : 'y'} will be relinked to ${dr.primaryName || dr.primaryId}, then the duplicate${dupCount !== 1 ? 's' : ''} will be ${actionSuffix}.${opts.keepDuplicates ? '' : '\n\nThis cannot be undone.'}`,
      { confirmText: 'Merge this group', danger: !opts.keepDuplicates }
    ).then((confirmed) => { if (confirmed) runMerge([dr]); });
  }

  // ── Run merge via SSE ──────────────────────────────────────
  function runMerge(records, isContinuation = false) {
    if (!token) { requireToken(() => runMerge(records, isContinuation)); return; }
    const toProcess = records ?? (_selectedDomains.size > 0 ? [..._selectedDomains] : _previewData?.domainRecords ?? []);
    if (!toProcess.length) return;

    if (!isContinuation) {
      _pendingRun     = toProcess;
      _pendingRunOpts = readMergeOptions();
    }

    _fromRun = true;
    dcGo('running');
    setProgress('dc-run', 'Starting merge…', 0);
    if (_logAppender) {
      if (isContinuation) _logAppender.separator('▶ Continuing merge');
      else _logAppender.reset();
    }

    _runCtrl = subscribeSSE(
      '/api/companies-duplicate-cleanup/run',
      { domainRecords: toProcess, ...(_pendingRunOpts || {}) },
      {
        onProgress({ message, percent }) { setProgress('dc-run', message, percent ?? 0); },
        onLog(entry) { if (_logAppender) _logAppender(entry); },
        onComplete(data) {
          _runCtrl  = null;
          // Accumulate audit log across continuation segments
          _auditLog = isContinuation && _auditLog
            ? [..._auditLog, ...(data.actionLog || [])]
            : (data.actionLog || []);
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
        onAbort() {
          _runCtrl = null;
          dcGo('preview');
        },
      }
    );
  }

  // ── Continue a stopped run with remaining unprocessed dups ─
  function continueRun() {
    if (!_pendingRun || !_auditLog) return;
    // Continue with the same options as the original run so kept/rename behavior is consistent.
    const processedDupIds = new Set(_auditLog.map(e => e.duplicateCompanyId));
    const remaining = _pendingRun
      .map(dr => ({ ...dr, duplicates: (dr.duplicates || []).filter(d => !processedDupIds.has(d.id)) }))
      .filter(dr => dr.duplicates.length > 0);
    if (!remaining.length) return;
    runMerge(remaining, true);
  }

  // ── Prune successfully merged groups before returning to preview ───────────
  // Removes groups whose duplicates were all deleted from _previewData so that
  // "Back to preview" after a stopped run doesn't re-show already-deleted companies.
  function pruneCompletedFromPreview() {
    if (!_previewData || !_auditLog?.length) return;
    // "Done" = deleted OR successfully kept (no error). Both kinds are processed and
    // should not reappear on "Back to preview".
    const doneIds = new Set(
      _auditLog.filter(e => e.deleted || (e.kept && !e.error)).map(e => e.duplicateCompanyId)
    );
    if (!doneIds.size) return;

    const kept = [];
    for (const dr of _previewData.domainRecords) {
      const remainingDups = (dr.duplicates || []).filter(d => !doneIds.has(d.id));
      if (remainingDups.length === 0) {
        // Every dup in this group was successfully processed — drop it entirely
        _selectedDomains.delete(dr);
        continue;
      }
      // Some dups done — trim in-place to preserve object reference for _selectedDomains
      if (remainingDups.length !== (dr.duplicates || []).length) {
        dr.duplicates = remainingDups;
        if (dr.allCompanies) {
          dr.allCompanies = dr.allCompanies.filter(c => c.id === dr.primaryId || !doneIds.has(c.id));
        }
      }
      kept.push(dr);
    }

    _previewData.domainRecords  = kept;
    _previewData.totalDomains   = kept.length;
    _previewData.totalDuplicates = kept.reduce((n, dr) => n + (dr.duplicates || []).length, 0);
  }

  // ── Render results summary ─────────────────────────────────
  function renderResults(data) {
    const { notesRelinked = 0, usersRelinked = 0, entitiesRelinked = 0, deleted = 0, kept = 0, archived = 0, errors = 0, stopped = false } = data;
    const summaryEl = dc$('dc-results-summary');
    if (!summaryEl) return;

    // Compute remaining unprocessed dups across all run segments
    let remainingCount = 0;
    if (stopped && _pendingRun && _auditLog) {
      const processedDupIds = new Set(_auditLog.map(e => e.duplicateCompanyId));
      remainingCount = _pendingRun.reduce(
        (n, dr) => n + (dr.duplicates || []).filter(d => !processedDupIds.has(d.id)).length, 0
      );
    }

    const hasErrors  = errors > 0;
    const alertClass = (stopped || hasErrors) ? 'alert-warn' : 'alert-ok';
    const icon       = stopped ? '⏹' : hasErrors ? '⚠️' : '✅';
    const status     = stopped ? 'Merge stopped' : 'Merge complete';

    const parts = [];
    if (notesRelinked)    parts.push(`${notesRelinked} note${notesRelinked !== 1 ? 's' : ''} relinked`);
    if (usersRelinked)    parts.push(`${usersRelinked} user${usersRelinked !== 1 ? 's' : ''} updated`);
    if (entitiesRelinked) parts.push(`${entitiesRelinked} entit${entitiesRelinked !== 1 ? 'ies' : 'y'} relinked`);
    if (deleted)       parts.push(`${deleted} compan${deleted !== 1 ? 'ies' : 'y'} deleted`);
    if (kept)          parts.push(`${kept} compan${kept !== 1 ? 'ies' : 'y'} kept`);
    if (archived)      parts.push(`${archived} archived`);
    if (errors)        parts.push(`${errors} error${errors !== 1 ? 's' : ''}`);
    if (remainingCount) parts.push(`${remainingCount} left undone`);

    summaryEl.innerHTML = `
      <div class="alert ${alertClass}" style="margin-bottom:0;">
        <span class="alert-icon">${icon}</span>
        <span><strong>${status}.</strong> ${parts.join(' · ') || 'Nothing done.'}</span>
      </div>
    `;

    if (stopped && remainingCount > 0) dcShow('dc-continue-run');
    else dcHide('dc-continue-run');

    // Show survivors CSV button when any duplicate was not deleted
    if (survivorIdsFromAudit(_auditLog).length > 0) dcShow('dc-download-survivors');
    else dcHide('dc-download-survivors');

    // Hide "Back to preview" if no groups remain after this run (all processed: deleted or kept)
    const doneIds = new Set(
      (_auditLog || []).filter(e => e.deleted || (e.kept && !e.error)).map(e => e.duplicateCompanyId)
    );
    const remainingGroups = (_previewData?.domainRecords || []).filter(dr =>
      (dr.duplicates || []).some(d => !doneIds.has(d.id))
    ).length;
    if (remainingGroups > 0) dcShow('dc-back-to-preview');
    else dcHide('dc-back-to-preview');

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

  // Read keep/archive options from the merge-mode controls on the scan page.
  function readMergeOptions() {
    const keep    = dc$('dc-keep-checkbox')?.checked === true;
    const archive = keep && dc$('dc-archive-checkbox')?.checked === true;
    return { keepDuplicates: keep, archiveDuplicates: archive };
  }

  // Renders the "Mode:" line on the preview banner. Applies to bulk and one-by-one merges alike.
  function renderPreviewMode() {
    const el = dc$('dc-preview-mode-text');
    if (!el) return;
    const opts = readMergeOptions();
    const label = opts.keepDuplicates
      ? (opts.archiveDuplicates
        ? 'Mode: Keep duplicates · archive them after relink'
        : 'Mode: Keep duplicates · do not delete after relink')
      : 'Mode: Delete duplicates after relink';
    el.textContent = `${label} — applies to every merge below (bulk and one-by-one). Change it back on the scan page.`;
  }

  // Survivor = duplicate that was not deleted (kept on purpose, or relink failed, or stopped).
  function survivorIdsFromAudit(audit) {
    return (audit || [])
      .filter(e => e && e.duplicateCompanyId && !e.deleted)
      .map(e => e.duplicateCompanyId);
  }

  function downloadSurvivorsCsv() {
    const ids = survivorIdsFromAudit(_auditLog);
    if (!ids.length) return;
    const csv = 'pb_id\n' + ids.join('\n') + '\n';
    const date = new Date().toISOString().slice(0, 10);
    triggerDownload(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
      `companies-duplicate-survivors-${date}.csv`
    );
  }

  // ==========================================================
  // ── MERGE FROM CSV submodule (prefix: dcm) ──────────────
  // ==========================================================

  // ── Module state ──────────────────────────────────────────
  let _dcmCsvRows       = null;   // parsed CSV data (array of row objects)
  let _dcmHeaders       = null;   // CSV column headers
  let _dcmPreviewData   = null;   // { domainRecords, totalDomains, totalDuplicates }
  let _dcmSkippedGroups = [];     // domainRecords where primaryNotFound === true (not merged)
  let _dcmPreviewCtrl  = null;   // AbortController for preview SSE
  let _dcmRunCtrl      = null;   // AbortController for run SSE
  let _dcmDropzoneClear = null;  // wireDropzone clear fn
  let _dcmLogAppender  = null;
  let _dcmAuditLog     = null;
  let _dcmPendingRun   = null;
  let _dcmPendingRunOpts = null;
  let _dcmSelectedDomains = new Set();
  let _dcmGroupCardEls    = new Map();  // domainRecord → { el, di }
  let _dcmFromRun      = false;
  let _dcmVs           = null;

  const DCM_STATES = ['idle', 'mapping', 'previewing', 'preview', 'running', 'results', 'error'];

  // ── DOM helpers ────────────────────────────────────────────
  function dcm$(id)        { return document.getElementById(id); }
  function dcmShow(id)     { dcm$(id)?.classList.remove('hidden'); }
  function dcmHide(id)     { dcm$(id)?.classList.add('hidden'); }
  function dcmText(id, t)  { const el = dcm$(id); if (el) el.textContent = t; }
  function dcmGo(state)    { _dcmVs?.go(state); }

  // ── Reset ──────────────────────────────────────────────────
  function dcmReset() {
    if (_dcmPreviewCtrl) { _dcmPreviewCtrl.abort(); _dcmPreviewCtrl = null; }
    if (_dcmRunCtrl)     { _dcmRunCtrl.abort();     _dcmRunCtrl     = null; }
    _dcmCsvRows         = null;
    _dcmHeaders         = null;
    _dcmPreviewData     = null;
    _dcmSkippedGroups   = [];
    _dcmAuditLog        = null;
    _dcmPendingRun      = null;
    _dcmPendingRunOpts  = null;
    _dcmSelectedDomains = new Set();
    _dcmGroupCardEls    = new Map();
    _dcmFromRun         = false;
    if (_dcmDropzoneClear) _dcmDropzoneClear();
    if (_dcmLogAppender)   _dcmLogAppender.reset();
    dcmHide('dcm-validate-error');
    dcmHide('dcm-validate-warn');
    dcmHide('dcm-results-download-log');
    dcmHide('dcm-download-survivors');
    dcmHide('dcm-error-download-log');
    const keepCb    = dcm$('dcm-keep-checkbox');    if (keepCb)    keepCb.checked    = false;
    const archiveCb = dcm$('dcm-archive-checkbox'); if (archiveCb) archiveCb.checked = false;
    dcm$('dcm-archive-label')?.classList.add('is-disabled-ctl');
    dcmGo('idle');
  }

  // ── Client-side validation ─────────────────────────────────
  const DCM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function dcmValidate() {
    const targetCol = dcm$('dcm-target-col')?.value;
    const dupesCol  = dcm$('dcm-dupes-col')?.value;
    const errors    = [];

    if (!targetCol || !dupesCol) {
      return { ok: false, errors: [{ row: '—', col: '—', msg: 'Select both column mappings.' }], warnings: [] };
    }
    if (targetCol === dupesCol) {
      return { ok: false, errors: [{ row: '—', col: '—', msg: 'Target and duplicates columns must be different.' }], warnings: [] };
    }

    // targetRows: targetId → [rowNums] — used to detect duplicate target UUIDs across rows
    const targetRows = {};

    for (let i = 0; i < _dcmCsvRows.length; i++) {
      const row    = _dcmCsvRows[i];
      const rowNum = i + 2; // +1 for header, +1 for 1-index

      // Validate target
      const targetVal   = (row[targetCol] || '').trim();
      const targetParts = targetVal.split(',').map(s => s.trim()).filter(Boolean);
      let   targetId    = null;

      if (targetParts.length === 0) {
        errors.push({ row: rowNum, col: 'Target', msg: 'Cell is empty.' });
      } else if (targetParts.length > 1) {
        errors.push({ row: rowNum, col: 'Target', msg: `Expected exactly 1 UUID, found ${targetParts.length}.` });
      } else if (!DCM_UUID_RE.test(targetParts[0])) {
        errors.push({ row: rowNum, col: 'Target', msg: `"${targetParts[0]}" is not a valid UUID.` });
      } else {
        targetId = targetParts[0];
        if (!targetRows[targetId]) targetRows[targetId] = [];
        targetRows[targetId].push(rowNum);
      }

      // Validate duplicates
      const dupesVal   = (row[dupesCol] || '').trim();
      const dupesParts = dupesVal.split(',').map(s => s.trim()).filter(Boolean);

      if (dupesParts.length === 0) {
        errors.push({ row: rowNum, col: 'Duplicates', msg: 'Cell is empty.' });
      } else {
        for (const id of dupesParts) {
          if (!DCM_UUID_RE.test(id)) {
            errors.push({ row: rowNum, col: 'Duplicates', msg: `"${id}" is not a valid UUID.` });
          } else if (targetId && id === targetId) {
            errors.push({ row: rowNum, col: 'Duplicates', msg: 'Target UUID cannot appear in its own duplicates list.' });
          }
        }
      }
    }

    // Warn about target UUIDs that appear on multiple rows — they will be merged into one group
    const warnings = Object.entries(targetRows)
      .filter(([, rows]) => rows.length > 1)
      .map(([targetId, rows]) => ({ targetId, rows }));

    return { ok: errors.length === 0, errors, warnings };
  }

  function dcmShowValidationError(errors) {
    const summary = dcm$('dcm-validate-error-summary');
    const tbody   = dcm$('dcm-validate-error-rows');
    if (summary) summary.textContent = `${errors.length} validation error${errors.length !== 1 ? 's' : ''} — fix your CSV before previewing.`;
    if (tbody) {
      tbody.innerHTML = '';
      for (const e of errors) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${esc(String(e.row))}</td><td>${esc(e.col)}</td><td>${esc(e.msg)}</td>`;
        tbody.appendChild(tr);
      }
    }
    dcmShow('dcm-validate-error');
  }

  function dcmShowValidationWarning(warnings) {
    const msg   = dcm$('dcm-validate-warn-msg');
    const tbody = dcm$('dcm-validate-warn-rows');
    if (msg) {
      const n = warnings.length;
      msg.textContent = `${n} target UUID${n !== 1 ? 's appear' : ' appears'} on multiple rows. These rows will be combined into ${n === 1 ? 'a single group' : 'single groups'} during preview — duplicates across rows are merged automatically.`;
    }
    if (tbody) {
      tbody.innerHTML = '';
      for (const { targetId, rows } of warnings) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-family:monospace;font-size:11px;">${esc(targetId)}</td>
          <td>${esc(rows.join(', '))}</td>
        `;
        tbody.appendChild(tr);
      }
    }
    dcmShow('dcm-validate-warn');
  }

  // ── Build rows payload from CSV data ───────────────────────
  function dcmBuildRows() {
    const targetCol = dcm$('dcm-target-col')?.value;
    const dupesCol  = dcm$('dcm-dupes-col')?.value;
    return (_dcmCsvRows || []).map(row => ({
      primaryId:    (row[targetCol] || '').trim(),
      duplicateIds: (row[dupesCol] || '').split(',').map(s => s.trim()).filter(Boolean),
    }));
  }

  // ── Run preview via SSE ────────────────────────────────────
  function dcmRunPreview() {
    if (!token) { requireToken(dcmRunPreview); return; }

    const { ok, errors, warnings } = dcmValidate();
    if (!ok) { dcmShowValidationError(errors); return; }

    dcmHide('dcm-validate-error');
    if (warnings.length > 0) dcmShowValidationWarning(warnings);
    else dcmHide('dcm-validate-warn');
    dcmGo('previewing');
    setProgress('dcm-preview', 'Starting preview…', 0);

    _dcmPreviewCtrl = subscribeSSE(
      '/api/companies-duplicate-cleanup/preview-csv',
      { rows: dcmBuildRows() },
      {
        onProgress({ message, percent }) { setProgress('dcm-preview', message, percent ?? 0); },
        onLog() {},
        onComplete(data) {
          _dcmPreviewCtrl = null;
          _dcmPreviewData = data;
          dcmRenderPreview(data);
          dcmGo('preview');
        },
        onError(msg) {
          _dcmPreviewCtrl = null;
          dcmText('dcm-error-msg', msg);
          dcmGo('error');
        },
        onAbort() { dcmGo('mapping'); },
      }
    );
  }

  // ── Render preview group cards ─────────────────────────────
  function dcmRenderPreview(data) {
    const { domainRecords } = data;

    // Split into actionable and skipped.
    // Skipped = target not found OR all duplicates not found (nothing can be merged).
    const actionable  = domainRecords.filter(dr =>
      !dr.primaryNotFound && (dr.duplicates || []).some(d => !d.notFound)
    );
    _dcmSkippedGroups = domainRecords.filter(dr =>
      dr.primaryNotFound || (dr.duplicates || []).every(d => d.notFound)
    );

    // Count only active (non-skipped) duplicates for the summary
    const actionableDups = actionable.reduce(
      (n, dr) => n + (dr.duplicates || []).filter(d => !d.notFound).length, 0
    );

    const summaryText = dcm$('dcm-preview-summary-text');
    if (summaryText) {
      const opts = dcmReadMergeOptions();
      const fate = opts.keepDuplicates ? 'to keep' : 'to delete';
      let text = `${actionable.length} group${actionable.length !== 1 ? 's' : ''} · ` +
        `${actionableDups} duplicate compan${actionableDups !== 1 ? 'ies' : 'y'} ${fate}`;
      if (_dcmSkippedGroups.length > 0)
        text += ` · ${_dcmSkippedGroups.length} skipped`;
      summaryText.textContent = text;
    }
    dcmRenderPreviewMode();

    const listEl = dcm$('dcm-groups-list');
    if (listEl) {
      listEl.innerHTML = '';
      _dcmGroupCardEls.clear();
      _dcmSelectedDomains.clear();
      actionable.forEach((dr, di) => { listEl.appendChild(dcmBuildGroupCard(dr, di)); });
    }

    // Skipped groups collapsible section
    const skippedWrap  = dcm$('dcm-skipped-wrap');
    const skippedTbody = dcm$('dcm-skipped-tbody');
    if (skippedWrap && skippedTbody) {
      if (_dcmSkippedGroups.length > 0) {
        skippedWrap.classList.remove('hidden');
        dcmText('dcm-skipped-count', String(_dcmSkippedGroups.length));
        skippedTbody.innerHTML = '';
        for (const dr of _dcmSkippedGroups) {
          const dupList = (dr.duplicates || []).map(d => d.id).join(', ');
          const reason  = dr.primaryNotFound
            ? 'Target company not found in this space'
            : 'All duplicate companies not found in this space';
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td style="font-family:monospace;font-size:11px;">${esc(dr.primaryId)}</td>
            <td style="font-family:monospace;font-size:11px;">${esc(dupList || '—')}</td>
            <td style="font-size:12px;color:var(--c-muted);">${esc(reason)}</td>
          `;
          skippedTbody.appendChild(tr);
        }
      } else {
        skippedWrap.classList.add('hidden');
      }
    }

    dcmUpdateSelectionUI();
  }

  // ── Build a collapsible group card (non-manual mode only) ──
  function dcmBuildGroupCard(dr, di) {
    const duplicates = dr.duplicates || [];
    const total      = duplicates.length + 1; // +1 for the target

    const details = document.createElement('details');
    details.open = true;
    details.dataset.di = di;
    details.style.cssText = 'border:1px solid var(--c-border,#e2e8f0);border-radius:6px;margin-bottom:8px;overflow:hidden;';
    details.addEventListener('toggle', () => {
      const allDetails = dcm$('dcm-groups-list')?.querySelectorAll('details[data-di]') || [];
      const anyOpen = [...allDetails].some(d => d.open);
      const btn = dcm$('dcm-toggle-all-groups');
      if (btn) btn.textContent = anyOpen ? 'Collapse all' : 'Expand all';
    });

    _dcmGroupCardEls.set(dr, { el: details, di });

    // Summary / header
    const summary = document.createElement('summary');
    summary.style.cssText = [
      'cursor:pointer;list-style:none;padding:10px 14px;',
      'display:flex;align-items:center;gap:10px;min-width:0;',
      'background:var(--c-bg-alt,#f8f9fa);font-size:13px;font-weight:500;user-select:none;',
    ].join('');

    const checkbox = document.createElement('input');
    checkbox.type    = 'checkbox';
    checkbox.checked = _dcmSelectedDomains.has(dr);
    checkbox.style.cssText = 'cursor:pointer;flex-shrink:0;';
    checkbox.title   = 'Select group for bulk merge';
    checkbox.addEventListener('click',  (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) _dcmSelectedDomains.add(dr);
      else                  _dcmSelectedDomains.delete(dr);
      dcmUpdateSelectionUI();
    });

    const groupLabel = document.createElement('span');
    groupLabel.className   = 'nm-group-label';
    groupLabel.textContent = `Group ${di + 1}`;

    const activeDups   = duplicates.filter(d => !d.notFound);
    const skippedDups  = duplicates.filter(d =>  d.notFound);
    const hasCounts     = activeDups.some(d => d.notesCount != null);
    const totalNotes    = activeDups.reduce((n, d) => n + (d.notesCount    ?? 0), 0);
    const totalUsers    = activeDups.reduce((n, d) => n + (d.usersCount    ?? 0), 0);
    const totalEntities = activeDups.reduce((n, d) => n + (d.entitiesCount ?? 0), 0);

    const countLabel = document.createElement('span');
    countLabel.className   = 'nm-group-count';
    let countText = `${total} compan${total !== 1 ? 'ies' : 'y'} · ${activeDups.length} to delete`;
    if (skippedDups.length > 0) countText += ` · ${skippedDups.length} not found (skipped)`;
    if (hasCounts) countText += ` (${totalNotes} note${totalNotes !== 1 ? 's' : ''} + ${totalUsers} user${totalUsers !== 1 ? 's' : ''} + ${totalEntities} entit${totalEntities !== 1 ? 'ies' : 'y'} to relink)`;
    countLabel.textContent = countText;

    // Label: use domain if set, otherwise fall back to target UUID (truncated)
    const groupTitle = document.createElement('span');
    groupTitle.className   = 'nm-group-title';
    groupTitle.textContent = dr.primaryDomain || `${dr.primaryId.slice(0, 8)}…`;

    const spacer = document.createElement('span');
    spacer.className = 'nm-group-spacer';

    const mergeOneBtn = document.createElement('button');
    mergeOneBtn.className   = 'btn btn-danger btn-sm';
    mergeOneBtn.textContent = 'Merge this group';
    mergeOneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dcmStartSingleGroupMerge(dr, di + 1);
    });

    summary.append(checkbox, groupLabel, countLabel, groupTitle, spacer, mergeOneBtn);
    details.appendChild(summary);

    // Compact table
    const allCompanies = [
      {
        id:            dr.primaryId,
        name:          dr.primaryName,
        domain:        dr.primaryDomain        || null,
        sourceOrigin:  dr.primaryOrigin        || null,
        sourceRecordId:dr.primarySourceRecordId|| null,
        notFound:      dr.primaryNotFound      || false,
        isTarget:      true,
      },
      ...duplicates.map(d => ({ ...d, isTarget: false })),
    ];

    const incomingNotes    = activeDups.every(d => d.notesCount != null)
      ? activeDups.reduce((n, d) => n + d.notesCount, 0) : null;
    const incomingUsers    = activeDups.every(d => d.usersCount != null)
      ? activeDups.reduce((n, d) => n + (d.usersCount ?? 0), 0) : null;
    const incomingEntities = activeDups.every(d => d.entitiesCount != null)
      ? activeDups.reduce((n, d) => n + (d.entitiesCount ?? 0), 0) : null;

    const table = document.createElement('table');
    table.className = 'mapping-table';
    table.style.marginBottom = '0';
    table.innerHTML = `
      <thead>
        <tr>
          <th style="width:80px;">Role</th>
          <th>UUID</th>
          <th>Name</th>
          <th>Domain</th>
          <th>Source</th>
          ${hasCounts ? '<th style="text-align:right;width:60px;">Notes</th><th style="text-align:right;width:60px;">Users</th><th style="text-align:right;width:72px;" title="Linked entities (features, components, etc.) attached to this company that will be relinked to the target.">Entities</th>' : ''}
        </tr>
      </thead>
    `;
    const tbody = document.createElement('tbody');

    for (const c of allCompanies) {
      const tr = document.createElement('tr');
      tr.style.height = '38px';
      const badge = c.isTarget
        ? `<span class="badge badge-ok" style="font-size:10px;">Target</span>`
        : c.notFound
          ? `<span class="badge badge-warn" style="font-size:10px;">Skip</span>`
          : `<span class="badge badge-danger" style="font-size:10px;">Delete</span>`;
      let noteCell = '', userCell = '', entCell = '';
      if (hasCounts) {
        if (c.isTarget) {
          noteCell = incomingNotes != null
            ? `<td style="text-align:right;font-size:12px;color:var(--c-ok,#22c55e);font-weight:600;">+${incomingNotes}</td>`
            : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
          userCell = incomingUsers != null
            ? `<td style="text-align:right;font-size:12px;color:var(--c-ok,#22c55e);font-weight:600;">+${incomingUsers}</td>`
            : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
          entCell  = incomingEntities != null
            ? `<td style="text-align:right;font-size:12px;color:var(--c-ok,#22c55e);font-weight:600;">+${incomingEntities}</td>`
            : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
        } else if (c.notFound) {
          noteCell = `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
          userCell = `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
          entCell  = `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
        } else {
          noteCell = c.notesCount != null
            ? `<td style="text-align:right;font-size:12px;">${c.notesCount}</td>`
            : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
          userCell = c.usersCount != null
            ? `<td style="text-align:right;font-size:12px;">${c.usersCount}</td>`
            : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
          entCell  = c.entitiesCount != null
            ? `<td style="text-align:right;font-size:12px;">${c.entitiesCount}</td>`
            : `<td style="text-align:right;color:var(--c-muted);font-size:12px;">—</td>`;
        }
      }
      const nameCell = c.notFound
        ? `<span style="color:var(--c-danger,#ef4444);font-size:12px;">Company does not exist</span>`
        : esc(c.name || '—');
      tr.innerHTML = `
        <td>${badge}</td>
        <td style="font-family:monospace;font-size:11px;color:var(--c-muted);">${esc(c.id.slice(0, 18))}…</td>
        <td>${nameCell}</td>
        <td style="font-size:12px;color:var(--c-muted);">${esc(c.domain || '—')}</td>
        <td style="font-size:12px;">${esc(c.sourceOrigin || '—')}</td>
        ${hasCounts ? noteCell + userCell + entCell : ''}
      `;
      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    const tableWrap = document.createElement('div');
    tableWrap.className = 'nm-group-table-wrap';
    tableWrap.appendChild(table);
    details.appendChild(tableWrap);
    return details;
  }

  // ── Selection toolbar UI ───────────────────────────────────
  function dcmUpdateSelectionUI() {
    const anySelected = _dcmSelectedDomains.size > 0;
    const mergeBtn = dcm$('dcm-merge-btn');
    if (mergeBtn) {
      mergeBtn.textContent = anySelected
        ? `Merge & delete selected (${_dcmSelectedDomains.size})`
        : 'Merge & delete duplicates';
    }
    // Selection toolbar buttons stay visible at all times so the user can use
    // "Select all" without needing to tick a row first.
  }

  // ── Merge confirmation wrappers ────────────────────────────
  function dcmStartMerge() {
    if (!_dcmPreviewData?.domainRecords?.length) return;
    // Only actionable groups (target found), with not-found duplicates stripped out
    const actionable = (_dcmPreviewData.domainRecords || []).filter(dr => !dr.primaryNotFound);
    const base       = _dcmSelectedDomains.size > 0 ? [..._dcmSelectedDomains] : actionable;
    const records    = base
      .map(dr => ({ ...dr, duplicates: (dr.duplicates || []).filter(d => !d.notFound) }))
      .filter(dr => dr.duplicates.length > 0);
    if (!records.length) return;
    const dupCount = records.reduce((n, dr) => n + dr.duplicates.length, 0);
    const intro    = _dcmSelectedDomains.size > 0
      ? `Merge ${records.length} selected group(s)?`
      : `Merge all ${records.length} group(s)?`;
    const opts = dcmReadMergeOptions();
    const actionSuffix = opts.keepDuplicates
      ? (opts.archiveDuplicates ? 'kept (and archived)' : 'kept (not deleted)')
      : `permanently deleted`;
    const tail = opts.keepDuplicates
      ? `\n\nDuplicate compan${dupCount !== 1 ? 'ies' : 'y'} will not be deleted — you can review and clean up later using the surviving-UUIDs CSV.`
      : `\n\nThis cannot be undone. Export your companies data first if you need a backup.`;
    showConfirm(
      `${intro}\n\nNotes, users, and linked entities from ${dupCount} duplicate compan${dupCount !== 1 ? 'ies' : 'y'} will be relinked to their target company, then the duplicate${dupCount !== 1 ? 's' : ''} will be ${actionSuffix}.${tail}`,
      { confirmText: opts.keepDuplicates ? 'Merge & keep' : 'Merge & delete', danger: !opts.keepDuplicates }
    ).then(confirmed => { if (confirmed) dcmRunMerge(records); });
  }

  function dcmStartSingleGroupMerge(dr, groupNum) {
    const activeDups = (dr.duplicates || []).filter(d => !d.notFound);
    if (!activeDups.length) return;
    const dupCount = activeDups.length;
    const opts = dcmReadMergeOptions();
    const actionSuffix = opts.keepDuplicates
      ? (opts.archiveDuplicates ? 'kept (and archived)' : 'kept (not deleted)')
      : `permanently deleted`;
    showConfirm(
      `Merge group ${groupNum}?\n\nNotes, users, and linked entities from ${dupCount} duplicate compan${dupCount !== 1 ? 'ies' : 'y'} will be relinked to ${dr.primaryName || dr.primaryId}, then the duplicate${dupCount !== 1 ? 's' : ''} will be ${actionSuffix}.${opts.keepDuplicates ? '' : '\n\nThis cannot be undone.'}`,
      { confirmText: 'Merge this group', danger: !opts.keepDuplicates }
    ).then(confirmed => {
      if (confirmed) dcmRunMerge([{ ...dr, duplicates: activeDups }]);
    });
  }

  function dcmReadMergeOptions() {
    const keep    = dcm$('dcm-keep-checkbox')?.checked === true;
    const archive = keep && dcm$('dcm-archive-checkbox')?.checked === true;
    return { keepDuplicates: keep, archiveDuplicates: archive };
  }

  function dcmRenderPreviewMode() {
    const el = dcm$('dcm-preview-mode-text');
    if (!el) return;
    const opts = dcmReadMergeOptions();
    const label = opts.keepDuplicates
      ? (opts.archiveDuplicates
        ? 'Mode: Keep duplicates · archive them after relink'
        : 'Mode: Keep duplicates · do not delete after relink')
      : 'Mode: Delete duplicates after relink';
    el.textContent = `${label} — applies to every merge below (bulk and one-by-one). Change it back on the mapping page.`;
  }

  function dcmDownloadSurvivorsCsv() {
    const ids = survivorIdsFromAudit(_dcmAuditLog);
    if (!ids.length) return;
    const csv = 'pb_id\n' + ids.join('\n') + '\n';
    const date = new Date().toISOString().slice(0, 10);
    triggerDownload(
      new Blob([csv], { type: 'text/csv;charset=utf-8;' }),
      `companies-merge-csv-survivors-${date}.csv`
    );
  }

  // ── Run merge via SSE ──────────────────────────────────────
  function dcmRunMerge(records, isContinuation = false) {
    if (!token) { requireToken(() => dcmRunMerge(records, isContinuation)); return; }
    // Defensive strip: never send not-found targets or not-found duplicates to /run
    const toProcess = (records || [])
      .filter(dr => !dr.primaryNotFound)
      .map(dr => ({ ...dr, duplicates: (dr.duplicates || []).filter(d => !d.notFound) }))
      .filter(dr => dr.duplicates.length > 0);
    if (!toProcess.length) return;

    if (!isContinuation) {
      _dcmPendingRun     = toProcess;
      _dcmPendingRunOpts = dcmReadMergeOptions();
    }

    _dcmFromRun = true;
    dcmGo('running');
    setProgress('dcm-run', 'Starting merge…', 0);
    if (_dcmLogAppender) {
      if (isContinuation) _dcmLogAppender.separator('▶ Continuing merge');
      else                _dcmLogAppender.reset();
    }

    _dcmRunCtrl = subscribeSSE(
      '/api/companies-duplicate-cleanup/run',
      { domainRecords: toProcess, ...(_dcmPendingRunOpts || {}) },
      {
        onProgress({ message, percent }) { setProgress('dcm-run', message, percent ?? 0); },
        onLog(entry) { if (_dcmLogAppender) _dcmLogAppender(entry); },
        onComplete(data) {
          _dcmRunCtrl = null;
          _dcmAuditLog = isContinuation && _dcmAuditLog
            ? [..._dcmAuditLog, ...(data.actionLog || [])]
            : (data.actionLog || []);
          dcmRenderResults(data);
          dcmGo('results');
        },
        onError(msg) {
          _dcmRunCtrl = null;
          dcmText('dcm-error-msg', msg);
          if (_dcmFromRun) dcmShow('dcm-error-back-to-preview');
          if (_dcmLogAppender?.getRows().length > 0) dcmShow('dcm-error-download-log');
          dcmGo('error');
        },
        onAbort() {
          _dcmRunCtrl = null;
          dcmGo('preview');
        },
      }
    );
  }

  // ── Continue a stopped run ─────────────────────────────────
  function dcmContinueRun() {
    if (!_dcmPendingRun || !_dcmAuditLog) return;
    const processedDupIds = new Set(_dcmAuditLog.map(e => e.duplicateCompanyId));
    const remaining = _dcmPendingRun
      .map(dr => ({ ...dr, duplicates: (dr.duplicates || []).filter(d => !processedDupIds.has(d.id)) }))
      .filter(dr => dr.duplicates.length > 0);
    if (!remaining.length) return;
    dcmRunMerge(remaining, true);
  }

  // ── Prune completed groups before back-to-preview ─────────
  function dcmPruneCompleted() {
    if (!_dcmPreviewData || !_dcmAuditLog?.length) return;
    const doneIds = new Set(
      _dcmAuditLog.filter(e => e.deleted || (e.kept && !e.error)).map(e => e.duplicateCompanyId)
    );
    if (!doneIds.size) return;

    const kept = [];
    for (const dr of _dcmPreviewData.domainRecords) {
      const remainingDups = (dr.duplicates || []).filter(d => !doneIds.has(d.id));
      if (remainingDups.length === 0) { _dcmSelectedDomains.delete(dr); continue; }
      if (remainingDups.length !== (dr.duplicates || []).length) dr.duplicates = remainingDups;
      kept.push(dr);
    }
    _dcmPreviewData.domainRecords   = kept;
    _dcmPreviewData.totalDomains    = kept.length;
    _dcmPreviewData.totalDuplicates = kept.reduce((n, dr) => n + (dr.duplicates || []).length, 0);
  }

  // ── Render results summary ─────────────────────────────────
  function dcmRenderResults(data) {
    const { notesRelinked = 0, usersRelinked = 0, entitiesRelinked = 0, deleted = 0, kept = 0, archived = 0, errors = 0, stopped = false } = data;
    const summaryEl = dcm$('dcm-results-summary');
    if (!summaryEl) return;

    let remainingCount = 0;
    if (stopped && _dcmPendingRun && _dcmAuditLog) {
      const processedDupIds = new Set(_dcmAuditLog.map(e => e.duplicateCompanyId));
      remainingCount = _dcmPendingRun.reduce(
        (n, dr) => n + (dr.duplicates || []).filter(d => !processedDupIds.has(d.id)).length, 0
      );
    }

    const hasErrors  = errors > 0;
    const alertClass = (stopped || hasErrors) ? 'alert-warn' : 'alert-ok';
    const icon       = stopped ? '⏹' : hasErrors ? '⚠️' : '✅';
    const status     = stopped ? 'Merge stopped' : 'Merge complete';

    const parts = [];
    if (notesRelinked)    parts.push(`${notesRelinked} note${notesRelinked !== 1 ? 's' : ''} relinked`);
    if (usersRelinked)    parts.push(`${usersRelinked} user${usersRelinked !== 1 ? 's' : ''} updated`);
    if (entitiesRelinked) parts.push(`${entitiesRelinked} entit${entitiesRelinked !== 1 ? 'ies' : 'y'} relinked`);
    if (deleted)       parts.push(`${deleted} compan${deleted !== 1 ? 'ies' : 'y'} deleted`);
    if (kept)          parts.push(`${kept} compan${kept !== 1 ? 'ies' : 'y'} kept`);
    if (archived)      parts.push(`${archived} archived`);
    if (errors)        parts.push(`${errors} error${errors !== 1 ? 's' : ''}`);
    if (remainingCount) parts.push(`${remainingCount} left undone`);

    summaryEl.innerHTML = `
      <div class="alert ${alertClass}" style="margin-bottom:0;">
        <span class="alert-icon">${icon}</span>
        <span><strong>${status}.</strong> ${parts.join(' · ') || 'Nothing done.'}</span>
      </div>
    `;

    if (stopped && remainingCount > 0) dcmShow('dcm-continue-run');
    else                               dcmHide('dcm-continue-run');

    if (survivorIdsFromAudit(_dcmAuditLog).length > 0) dcmShow('dcm-download-survivors');
    else                                               dcmHide('dcm-download-survivors');

    // Only show "Back to preview" if actionable groups remain — skipped groups
    // (target not found / all dups not found) don't warrant returning to preview.
    const doneIds = new Set(
      (_dcmAuditLog || []).filter(e => e.deleted || (e.kept && !e.error)).map(e => e.duplicateCompanyId)
    );
    const remainingActionable = (_dcmPreviewData?.domainRecords || [])
      .filter(dr => !dr.primaryNotFound)
      .filter(dr => (dr.duplicates || []).some(d => !d.notFound && !doneIds.has(d.id)))
      .length;
    if (remainingActionable > 0) dcmShow('dcm-back-to-preview');
    else                         dcmHide('dcm-back-to-preview');

    // Transfer live log to results panel
    const runEntries = dcm$('dcm-run-log-entries');
    const resEntries = dcm$('dcm-results-log-entries');
    const runCounts  = dcm$('dcm-run-log-counts');
    const resCounts  = dcm$('dcm-results-log-counts');
    if (runEntries && resEntries) resEntries.innerHTML = runEntries.innerHTML;
    if (runCounts  && resCounts)  resCounts.innerHTML  = runCounts.innerHTML;
    const runLogEl = dcm$('dcm-run-log');
    const resLogEl = dcm$('dcm-results-log');
    if (resLogEl && runLogEl && !runLogEl.classList.contains('hidden')) resLogEl.classList.remove('hidden');
    if (_dcmLogAppender?.getRows().length > 0) dcmShow('dcm-results-download-log');
  }

  // ── Download audit log ─────────────────────────────────────
  function dcmDownloadAuditLog() {
    if (!_dcmAuditLog) return;
    const json = JSON.stringify({ actions: _dcmAuditLog }, null, 2);
    const date = new Date().toISOString().slice(0, 10);
    triggerDownload(
      new Blob([json], { type: 'application/json;charset=utf-8;' }),
      `companies-merge-csv-log-${date}.json`
    );
  }

  // ── Init (called by initCompaniesDuplicateCleanupModule) ───
  function initDcmSubmodule() {
    _dcmVs         = createViewState('dcm', DCM_STATES);
    _dcmLogAppender = makeLogAppender('dcm-run-log', 'dcm-run-log-entries', 'dcm-run-log-counts');

    // Dropzone
    const dropzoneEl  = dcm$('dcm-dropzone');
    const fileInputEl = dcm$('dcm-file-input');
    if (dropzoneEl && fileInputEl) {
      const { clear } = wireDropzone(dropzoneEl, fileInputEl, (file) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const text = cleanCSVText(e.target.result);
          _dcmHeaders = parseCSVHeaders(text);
          // Parse all data rows into objects keyed by header
          const SPLIT_RE = /,(?=(?:[^"]*"[^"]*")*[^"]*$)/;
          _dcmCsvRows = text.trim().split('\n').slice(1)
            .filter(l => l.trim())
            .map(l => {
              const cols = l.split(SPLIT_RE).map(c => c.replace(/^"|"$/g, '').trim());
              const obj  = {};
              _dcmHeaders.forEach((h, i) => { obj[h] = cols[i] ?? ''; });
              return obj;
            });

          if (_dcmCsvRows.length === 0) {
            showAlert('CSV file appears empty or has no data rows.');
            _dcmDropzoneClear?.();
            return;
          }

          // Populate column selects
          const targetSel = dcm$('dcm-target-col');
          const dupesSel  = dcm$('dcm-dupes-col');
          if (targetSel && dupesSel) {
            const opts = _dcmHeaders.map(h => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
            targetSel.innerHTML = opts;
            dupesSel.innerHTML  = opts;
            if (_dcmHeaders.length > 1) dupesSel.value = _dcmHeaders[1];
          }

          dcmText('dcm-map-subtitle', `${_dcmCsvRows.length} row${_dcmCsvRows.length !== 1 ? 's' : ''} · ${_dcmHeaders.length} column${_dcmHeaders.length !== 1 ? 's' : ''}`);
          dcmHide('dcm-validate-error');
          dcmGo('mapping');
        };
        reader.readAsText(file);
      });
      _dcmDropzoneClear = clear;
    }

    // Re-upload
    dcm$('dcm-reupload')?.addEventListener('click', () => {
      _dcmDropzoneClear?.();
      _dcmCsvRows = null;
      _dcmHeaders = null;
      dcmHide('dcm-validate-error');
      dcmGo('idle');
    });

    // Validate & preview
    dcm$('dcm-preview-btn')?.addEventListener('click', dcmRunPreview);

    // Cancel preview SSE
    dcm$('dcm-preview-stop')?.addEventListener('click', () => {
      if (_dcmPreviewCtrl) { _dcmPreviewCtrl.abort(); _dcmPreviewCtrl = null; }
    });

    // Collapse / expand all groups
    dcm$('dcm-toggle-all-groups')?.addEventListener('click', () => {
      const allDetails = dcm$('dcm-groups-list')?.querySelectorAll('details[data-di]') || [];
      const anyOpen = [...allDetails].some(d => d.open);
      allDetails.forEach(d => { d.open = !anyOpen; });
      const btn = dcm$('dcm-toggle-all-groups');
      if (btn) btn.textContent = anyOpen ? 'Expand all' : 'Collapse all';
    });

    // Unselect all
    // Select all — iterate rendered group cards via _dcmGroupCardEls, which only contains
    // actionable groups (skipped/not-found groups are listed separately, not as cards).
    dcm$('dcm-select-all')?.addEventListener('click', () => {
      _dcmSelectedDomains.clear();
      for (const [dr, { el }] of _dcmGroupCardEls) {
        const cb = el.querySelector('summary > input[type=checkbox]');
        if (!cb) continue;
        cb.checked = true;
        _dcmSelectedDomains.add(dr);
      }
      dcmUpdateSelectionUI();
    });

    dcm$('dcm-unselect-all')?.addEventListener('click', () => {
      _dcmSelectedDomains.clear();
      dcm$('dcm-groups-list')?.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
      dcmUpdateSelectionUI();
    });

    // Invert selection
    dcm$('dcm-invert-selection')?.addEventListener('click', () => {
      for (const [dr, { el }] of _dcmGroupCardEls) {
        const cb = el.querySelector('summary > input[type=checkbox]');
        if (!cb) continue;
        cb.checked = !cb.checked;
        if (cb.checked) _dcmSelectedDomains.add(dr);
        else            _dcmSelectedDomains.delete(dr);
      }
      dcmUpdateSelectionUI();
    });

    // Back to map (from preview)
    dcm$('dcm-back-to-map')?.addEventListener('click', () => dcmGo('mapping'));

    // Merge button
    dcm$('dcm-merge-btn')?.addEventListener('click', dcmStartMerge);

    // Run stop — graceful server-side stop
    dcm$('dcm-run-stop')?.addEventListener('click', async () => {
      const btn = dcm$('dcm-run-stop');
      if (btn) { btn.disabled = true; btn.textContent = '⏹ Stopping…'; }
      try {
        await fetch('/api/companies-duplicate-cleanup/run/stop', {
          method: 'POST', headers: buildHeaders(),
        });
      } catch (_e) {
        if (_dcmRunCtrl) { _dcmRunCtrl.abort(); _dcmRunCtrl = null; }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '⏹ Stop'; }
      }
    });

    // Results actions
    dcm$('dcm-continue-run')?.addEventListener('click', dcmContinueRun);
    dcm$('dcm-back-to-preview')?.addEventListener('click', () => {
      dcmPruneCompleted();
      dcmRenderPreview(_dcmPreviewData);
      dcmGo('preview');
    });
    dcm$('dcm-results-download-log')?.addEventListener('click', () => {
      if (_dcmLogAppender) downloadLogCsv(_dcmLogAppender, 'companies-merge-csv');
    });
    dcm$('dcm-download-audit')?.addEventListener('click', dcmDownloadAuditLog);
    dcm$('dcm-download-survivors')?.addEventListener('click', dcmDownloadSurvivorsCsv);
    dcm$('dcm-start-over')?.addEventListener('click', dcmReset);

    // Merge mode: keep checkbox toggles archive row enablement, and refreshes preview banner if visible
    dcm$('dcm-keep-checkbox')?.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      dcm$('dcm-archive-label')?.classList.toggle('is-disabled-ctl', !enabled);
      if (!enabled) {
        const cb = dcm$('dcm-archive-checkbox'); if (cb) cb.checked = false;
      }
      if (_dcmPreviewData) dcmRenderPreview(_dcmPreviewData);
    });
    dcm$('dcm-archive-checkbox')?.addEventListener('change', () => {
      if (_dcmPreviewData) dcmRenderPreviewMode();
    });

    // Error actions
    dcm$('dcm-error-back-to-preview')?.addEventListener('click', () => {
      dcmPruneCompleted();
      dcmRenderPreview(_dcmPreviewData);
      dcmGo('preview');
    });
    dcm$('dcm-error-download-log')?.addEventListener('click', () => {
      if (_dcmLogAppender) downloadLogCsv(_dcmLogAppender, 'companies-merge-csv');
    });
    dcm$('dcm-error-retry')?.addEventListener('click', dcmReset);

    // Disconnect → reset
    window.addEventListener('pb:disconnect', dcmReset);
  }

  // ── Init ──────────────────────────────────────────────────
  function initCompaniesDuplicateCleanupModule() {
    if (_inited) return;
    _inited = true;

    _vs = createViewState('dc', DC_STATES);
    _logAppender = makeLogAppender('dc-run-log', 'dc-run-log-entries', 'dc-run-log-counts');

    initDcmSubmodule();

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

    // Match criteria — enable the appropriate fuzzy sub-option
    document.querySelectorAll('input[name="dc-match"]').forEach(radio => {
      radio.addEventListener('change', () => {
        const val            = document.querySelector('input[name="dc-match"]:checked')?.value;
        const domNameEnabled = val === 'domain+name';
        const nameEnabled    = val === 'name';
        const label           = dc$('dc-fuzzy-label');
        const nameLabel       = dc$('dc-fuzzy-name-label');
        const noDomainLabel   = dc$('dc-no-domain-only-label');
        if (label) {
          label.style.opacity       = domNameEnabled ? '1'    : '0.4';
          label.style.pointerEvents = domNameEnabled ? 'auto' : 'none';
        }
        if (nameLabel) {
          nameLabel.style.opacity       = nameEnabled ? '1'    : '0.4';
          nameLabel.style.pointerEvents = nameEnabled ? 'auto' : 'none';
        }
        if (noDomainLabel) {
          noDomainLabel.style.opacity       = nameEnabled ? '1'    : '0.4';
          noDomainLabel.style.pointerEvents = nameEnabled ? 'auto' : 'none';
        }
        if (!domNameEnabled) { const cb = dc$('dc-fuzzy-checkbox');          if (cb) cb.checked = false; }
        if (!nameEnabled)    { const cb = dc$('dc-fuzzy-name-checkbox');     if (cb) cb.checked = false; }
        if (!nameEnabled)    { const cb = dc$('dc-no-domain-only-checkbox'); if (cb) cb.checked = false; }
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

    // Select all — iterate details[data-di] so we only touch group-summary checkboxes,
    // never extra checkboxes inside expanded cards (matches the invert-selection pattern).
    dc$('dc-select-all')?.addEventListener('click', () => {
      _selectedDomains.clear();
      dc$('dc-groups-list')?.querySelectorAll('details[data-di]').forEach(detailsEl => {
        const di = parseInt(detailsEl.dataset.di, 10);
        const dr = _previewData?.domainRecords?.[di];
        if (!dr) return;
        const cb = detailsEl.querySelector('summary > input[type=checkbox]');
        if (!cb) return;
        cb.checked = true;
        _selectedDomains.add(dr);
      });
      updateSelectionUI();
    });

    // Unselect all
    dc$('dc-unselect-all')?.addEventListener('click', () => {
      _selectedDomains.clear();
      dc$('dc-groups-list')?.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
      updateSelectionUI();
    });

    // Invert selection — iterate details[data-di] (one per group) rather than
    // raw checkboxes by index, so extra checkboxes inside a card never drift the mapping.
    dc$('dc-invert-selection')?.addEventListener('click', () => {
      dc$('dc-groups-list')?.querySelectorAll('details[data-di]').forEach(detailsEl => {
        const di = parseInt(detailsEl.dataset.di, 10);
        const dr = _previewData?.domainRecords?.[di];
        if (!dr) return;
        const cb = detailsEl.querySelector('summary > input[type=checkbox]');
        if (!cb) return;
        cb.checked = !cb.checked;
        if (cb.checked) _selectedDomains.add(dr);
        else _selectedDomains.delete(dr);
      });
      updateSelectionUI();
    });

    // Adjust options → back to idle so user can change source selection before re-scanning
    dc$('dc-rescan-btn')?.addEventListener('click', () => dcGo('idle'));
    // No duplicates found → go back to idle so user can adjust options before re-scanning
    dc$('dc-no-dup-rescan')?.addEventListener('click', () => dcGo('idle'));

    // Merge button
    dc$('dc-merge-btn')?.addEventListener('click', startMerge);

    // Run stop — signal the server to finish the current duplicate then stop gracefully.
    // We do NOT abort the SSE connection so we still receive the complete event with partial results.
    dc$('dc-run-stop')?.addEventListener('click', async () => {
      const btn = dc$('dc-run-stop');
      if (btn) { btn.disabled = true; btn.textContent = '⏹ Stopping…'; }
      try {
        await fetch('/api/companies-duplicate-cleanup/run/stop', {
          method: 'POST', headers: buildHeaders(),
        });
      } catch (_e) {
        // If the stop request itself fails, fall back to hard abort
        if (_runCtrl) { _runCtrl.abort(); _runCtrl = null; }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '⏹ Stop'; }
      }
    });

    // Results actions
    dc$('dc-continue-run')?.addEventListener('click', continueRun);
    dc$('dc-back-to-preview')?.addEventListener('click', () => {
      pruneCompletedFromPreview();
      renderPreview(_previewData);
      dcGo('preview');
    });
    dc$('dc-results-download-log')?.addEventListener('click', () => {
      if (_logAppender) downloadLogCsv(_logAppender, 'companies-merge');
    });
    dc$('dc-download-audit')?.addEventListener('click', downloadAuditLog);
    dc$('dc-download-survivors')?.addEventListener('click', downloadSurvivorsCsv);
    dc$('dc-start-over')?.addEventListener('click', resetModule);

    // Merge mode: keep checkbox toggles archive row enablement, and refreshes preview banner if visible
    dc$('dc-keep-checkbox')?.addEventListener('change', (e) => {
      const enabled = e.target.checked;
      dc$('dc-archive-label')?.classList.toggle('is-disabled-ctl', !enabled);
      if (!enabled) {
        const cb = dc$('dc-archive-checkbox'); if (cb) cb.checked = false;
      }
      if (_previewData) renderPreview(_previewData);
    });
    dc$('dc-archive-checkbox')?.addEventListener('change', () => {
      if (_previewData) renderPreviewMode();
    });

    // Error actions
    dc$('dc-error-back-to-preview')?.addEventListener('click', () => {
      pruneCompletedFromPreview();
      renderPreview(_previewData);
      dcGo('preview');
    });
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
    window.addEventListener('pb:disconnect', resetModule);

    // Retry origins on connect
    window.addEventListener('pb:connected', () => {
      if (!_originsLoaded && !_originsLoading) loadOrigins();
    });

    // Auto-load origins if already authenticated
    loadOrigins();
  }

  window.initCompaniesDuplicateCleanupModule = initCompaniesDuplicateCleanupModule;
})();
