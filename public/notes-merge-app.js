/* =========================================================
   Merge Duplicate Notes module
   Exposes: window.initNotesMergeModule()
   ========================================================= */

(function () {
  'use strict';

  // ── Module state ─────────────────────────────────────────
  let _scanData    = null;  // { groups, partialMatchGroups, stats } from last scan
  let _auditLog    = null;  // audit log from last run
  let _scanCtrl    = null;  // AbortController for scan SSE
  let _runCtrl     = null;  // AbortController for run SSE
  let _logAppender = null;  // makeLogAppender bound to run log panel
  let _inited      = false;

  // ── DOM helpers ───────────────────────────────────────────
  function nm$(id) { return document.getElementById(id); }
  function nmShow(id) { nm$(id)?.classList.remove('hidden'); }
  function nmHide(id) { nm$(id)?.classList.add('hidden'); }
  function nmText(id, text) { const el = nm$(id); if (el) el.textContent = text; }

  // ── View state ────────────────────────────────────────────
  // States correspond to top-level section divs: nm-idle, nm-scanning, nm-preview, nm-running, nm-results, nm-error
  const NM_STATES = ['idle', 'scanning', 'preview', 'running', 'results', 'error'];
  let _vs = null;

  function nmGo(state) {
    if (!_vs) return;
    _vs.go(state);
  }

  // ── Reset ─────────────────────────────────────────────────
  function resetNotesMerge() {
    if (_scanCtrl) { _scanCtrl.abort(); _scanCtrl = null; }
    if (_runCtrl)  { _runCtrl.abort();  _runCtrl  = null; }
    _scanData = null;
    _auditLog = null;
    if (_logAppender) _logAppender.reset();
    nmGo('idle');
  }

  // ── Safety gate ───────────────────────────────────────────
  function updateGate() {
    const checked = nm$('nm-gate-checkbox')?.checked;
    const config  = nm$('nm-config');
    if (!config) return;
    config.style.opacity       = checked ? '1'    : '0.4';
    config.style.pointerEvents = checked ? 'auto' : 'none';
  }

  // ── Scan ──────────────────────────────────────────────────
  function startScan() {
    if (!requireToken(() => startScan())) return;

    const createdFrom = nm$('nm-date-from')?.value || '';
    const createdTo   = nm$('nm-date-to')?.value   || '';
    const looseMatch  = nm$('nm-loose-match')?.checked || false;
    const targetMode  = document.querySelector('input[name="nm-target-mode"]:checked')?.value || 'newest';

    nmGo('scanning');
    setProgress('nm', 'Starting scan…', 0);

    _scanCtrl = subscribeSSE('/api/notes-merge/scan', { createdFrom, createdTo, looseMatch, targetMode }, {
      onProgress({ message, percent }) {
        setProgress('nm', message, percent ?? 0);
      },
      onComplete(data) {
        _scanData = data;
        renderPreview(data);
        nmGo('preview');
      },
      onError(msg) {
        nmText('nm-error-msg', msg);
        nmHide('nm-error-download-log');
        nmGo('error');
      },
      onAbort() {
        nmGo('idle');
      },
    });
  }

  // ── Render preview ────────────────────────────────────────
  function renderPreview(data) {
    const { groups = [], partialMatchGroups = [], stats } = data;

    // Summary line
    const summaryEl = nm$('nm-preview-summary-text');
    if (summaryEl) {
      if (stats.groupsFound === 0) {
        summaryEl.textContent = `Scanned ${stats.totalNotes.toLocaleString()} notes — no duplicate groups found.`;
      } else {
        let text = `Found ${stats.groupsFound} duplicate group(s) across ${stats.notesInGroups} notes — ${stats.notesToDelete} note(s) will be deleted.`;
        if (stats.oversizedGroups > 0) text += ` ${stats.oversizedGroups} group(s) with 100+ notes were skipped — review manually.`;
        summaryEl.textContent = text;
      }
    }

    if (groups.length === 0) {
      nmShow('nm-no-duplicates');
      nmHide('nm-groups-wrap');
      return;
    }

    nmHide('nm-no-duplicates');
    nmShow('nm-groups-wrap');

    // Oversized warning
    if (stats.oversizedGroups > 0) {
      nmText('nm-oversized-warn-text', `${stats.oversizedGroups} group(s) with 100+ notes were skipped — they require manual review and are not included below.`);
      nmShow('nm-oversized-warn');
    } else {
      nmHide('nm-oversized-warn');
    }

    // Groups table
    const tbody = nm$('nm-groups-tbody');
    if (tbody) {
      tbody.innerHTML = '';
      groups.forEach((group, gi) => {
        appendGroupRows(tbody, group, gi + 1);
      });
    }

    // Partial matches
    if (partialMatchGroups.length > 0) {
      nmShow('nm-partial-matches-wrap');
      nmText('nm-partial-count', String(partialMatchGroups.length));
      const ptbody = nm$('nm-partial-tbody');
      if (ptbody) {
        ptbody.innerHTML = '';
        partialMatchGroups.forEach((notes, gi) => {
          notes.forEach(note => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>${gi + 1}</td>
              <td>${esc(note.title)}</td>
              <td>${esc(note.customer_email || note.customer_company || '—')}</td>
              <td>${esc(note.owner_email || '—')}</td>
              <td>${esc(note.state)}</td>
              <td style="font-size:11px;color:var(--c-muted);">${esc(note.created_at ? note.created_at.slice(0, 10) : '—')}</td>
            `;
            ptbody.appendChild(tr);
          });
        });
      }
    } else {
      nmHide('nm-partial-matches-wrap');
    }
  }

  function appendGroupRows(tbody, group, groupNum) {
    const { target, secondaries } = group;

    function makeRow(note, role) {
      const isTarget = role === 'Target';
      const tr = document.createElement('tr');
      if (isTarget) tr.style.fontWeight = '600';

      const roleBadge = isTarget
        ? '<span class="badge badge-ok" style="font-size:10px;">Target</span>'
        : '<span class="badge badge-danger" style="font-size:10px;">Delete</span>';

      const customer = esc(note.customer_email || note.customer_company || '—');
      const tags     = note.tags?.length ? esc(note.tags.join(', ')) : '<span style="color:var(--c-muted)">—</span>';
      const links    = note.product_links?.length
        ? `<span style="color:var(--c-muted);font-size:11px;">${note.product_links.length} link(s)</span>`
        : '<span style="color:var(--c-muted)">—</span>';

      const sourceCell = note.source_origin
        ? `<span title="Source data will be discarded" style="color:var(--c-muted);font-size:11px;text-decoration:line-through;">${esc(note.source_origin)}</span>`
        : '<span style="color:var(--c-muted)">—</span>';

      tr.innerHTML = `
        <td style="color:var(--c-muted);font-size:12px;">${groupNum}</td>
        <td>${roleBadge}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(note.title)}">${esc(note.title) || '<em style="color:var(--c-muted)">untitled</em>'}</td>
        <td style="font-size:12px;">${customer}</td>
        <td style="font-size:12px;">${esc(note.owner_email || '—')}</td>
        <td style="font-size:12px;">${tags}</td>
        <td style="font-size:12px;">${links}</td>
        <td style="font-size:11px;">${sourceCell}</td>
        <td style="font-size:12px;">${esc(note.state)}</td>
        <td style="font-size:11px;color:var(--c-muted);">${esc(note.created_at ? note.created_at.slice(0, 10) : '—')}</td>
      `;
      tbody.appendChild(tr);
    }

    makeRow(target, 'Target');
    secondaries.forEach(s => makeRow(s, 'Delete'));

    // Separator row between groups
    const sep = document.createElement('tr');
    sep.style.height = '4px';
    sep.innerHTML = '<td colspan="10" style="border:none;background:var(--c-bg-alt,#f4f4f5);padding:0;"></td>';
    tbody.appendChild(sep);
  }

  // ── Download preview CSV ──────────────────────────────────
  function downloadPreviewCsv() {
    if (!_scanData?.groups?.length) return;

    const COLS = [
      'group_id', 'role', 'note_id', 'title', 'content_preview',
      'customer_email', 'customer_company', 'owner_email',
      'tags', 'product_links', 'source_origin', 'source_record_id',
      'state', 'created_at',
    ];

    const rows = [];
    _scanData.groups.forEach((group) => {
      rows.push({ ...group.target,     group_id: group.groupId, role: 'Target',    tags: (group.target.tags || []).join(', '),     product_links: (group.target.product_links || []).join(', ')     });
      group.secondaries.forEach(s => {
        rows.push({ ...s,              group_id: group.groupId, role: 'Secondary', tags: (s.tags || []).join(', '),                product_links: (s.product_links || []).join(', ')                });
      });
    });

    function csvCell(v) {
      const s = v == null ? '' : String(v);
      return (s.includes(',') || s.includes('"') || s.includes('\n'))
        ? '"' + s.replace(/"/g, '""') + '"'
        : s;
    }
    const lines = [COLS.join(','), ...rows.map(r => COLS.map(c => csvCell(r[c])).join(','))];
    const date  = new Date().toISOString().slice(0, 10);
    triggerDownload(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' }), `notes-merge-preview-${date}.csv`);
  }

  // ── Run merge ─────────────────────────────────────────────
  function startMerge() {
    if (!_scanData?.groups?.length) return;

    showConfirm(
      `This will merge ${_scanData.stats.groupsFound} group(s) and permanently delete ${_scanData.stats.notesToDelete} note(s).\n\nThis cannot be undone. Continue?`,
      { confirmText: 'Merge & delete', danger: true }
    ).then((confirmed) => {
      if (!confirmed) return;
      runMerge();
    });
  }

  function runMerge() {
    if (_logAppender) _logAppender.reset();

    nmGo('running');
    setProgress('nm-run', 'Starting…', 0);

    _runCtrl = subscribeSSE('/api/notes-merge/run', { groups: _scanData.groups }, {
      onProgress({ message, percent }) {
        setProgress('nm-run', message, percent ?? 0);
      },
      onLog(entry) {
        if (_logAppender) _logAppender(entry);
      },
      onComplete(data) {
        _auditLog = data.auditLog;
        renderResults(data);
        nmGo('results');
        // Move live log entries to results log panel
        transferLog('nm-run-log', 'nm-run-log-entries', 'nm-run-log-counts',
                    'nm-results-log', 'nm-results-log-entries', 'nm-results-log-counts');
      },
      onError(msg) {
        nmText('nm-error-msg', msg);
        // Show download log button if there are log entries
        if (_logAppender && _logAppender.getCounts().success + _logAppender.getCounts().error > 0) {
          nmShow('nm-error-download-log');
        }
        nmGo('error');
      },
      onAbort() {
        renderResults({ merged: 0, deleted: 0, skipped: 0, errors: 0, stopped: true, auditLog: [] });
        nmGo('results');
        transferLog('nm-run-log', 'nm-run-log-entries', 'nm-run-log-counts',
                    'nm-results-log', 'nm-results-log-entries', 'nm-results-log-counts');
      },
    });
  }

  function renderResults(data) {
    const { merged = 0, deleted = 0, skipped = 0, errors = 0, stopped = false } = data;
    const summaryEl = nm$('nm-results-summary');
    if (!summaryEl) return;

    const hasErrors  = errors > 0;
    const alertClass = (stopped || hasErrors) ? 'alert-warn' : 'alert-ok';
    const icon       = stopped ? '⏹' : hasErrors ? '⚠️' : '✅';
    const status     = stopped ? 'Stopped' : 'Complete';
    const detail     = `${merged} group(s) merged · ${deleted} note(s) deleted · ${skipped} group(s) skipped · ${errors} error(s)`;

    summaryEl.innerHTML = `
      <div class="alert ${alertClass}">
        <span class="alert-icon">${icon}</span>
        <span>${status} — ${detail}</span>
      </div>
    `;
    summaryEl.classList.remove('hidden');

    // Show download audit button only when there's data
    if (data.auditLog?.length) {
      nmShow('nm-download-audit');
    } else {
      nmHide('nm-download-audit');
    }
  }

  /**
   * Move live log entries from the running panel to the results panel.
   * The running-panel log div is cloned so the original is untouched.
   */
  function transferLog(srcLogId, srcEntriesId, srcCountsId, dstLogId, dstEntriesId, dstCountsId) {
    const srcLog     = nm$(srcLogId);
    const srcEntries = nm$(srcEntriesId);
    const srcCounts  = nm$(srcCountsId);
    const dstLog     = nm$(dstLogId);
    const dstEntries = nm$(dstEntriesId);
    const dstCounts  = nm$(dstCountsId);
    if (!srcLog || !srcEntries || !dstLog || !dstEntries) return;

    if (srcEntries.children.length === 0) return;

    // Clone entries into destination
    dstEntries.innerHTML = srcEntries.innerHTML;
    if (dstCounts && srcCounts) dstCounts.innerHTML = srcCounts.innerHTML;
    dstLog.classList.remove('hidden');

    // Show download log button
    const dlBtn = nm$('nm-results-download-log');
    if (dlBtn) dlBtn.classList.remove('hidden');
  }

  // ── Download audit log (JSON) ─────────────────────────────
  function downloadAuditLog() {
    if (!_auditLog) return;
    const date = new Date().toISOString().slice(0, 10);
    triggerDownload(
      new Blob([JSON.stringify(_auditLog, null, 2)], { type: 'application/json' }),
      `notes-merge-audit-${date}.json`
    );
  }

  // ── Init ──────────────────────────────────────────────────
  function initNotesMergeModule() {
    if (_inited) return;
    _inited = true;

    // Create view state controller
    _vs = createViewState('nm', NM_STATES);

    // Create log appender bound to the running log panel
    _logAppender = makeLogAppender('nm-run-log', 'nm-run-log-entries', 'nm-run-log-counts', 'note');

    // Safety gate
    nm$('nm-gate-checkbox')?.addEventListener('change', updateGate);

    // Scan
    nm$('nm-scan-btn')?.addEventListener('click', startScan);
    nm$('nm-scan-stop')?.addEventListener('click', () => {
      if (_scanCtrl) { _scanCtrl.abort(); _scanCtrl = null; }
    });

    // Preview actions
    nm$('nm-download-preview-csv')?.addEventListener('click', downloadPreviewCsv);
    nm$('nm-merge-btn')?.addEventListener('click', startMerge);
    nm$('nm-rescan-btn')?.addEventListener('click', () => {
      _scanData = null;
      nmGo('idle');
    });
    nm$('nm-no-dup-rescan')?.addEventListener('click', () => {
      _scanData = null;
      nmGo('idle');
    });

    // Run actions
    nm$('nm-run-stop')?.addEventListener('click', () => {
      if (_runCtrl) { _runCtrl.abort(); _runCtrl = null; }
    });

    // Results
    nm$('nm-download-audit')?.addEventListener('click', downloadAuditLog);
    nm$('nm-results-download-log')?.addEventListener('click', () => {
      if (_logAppender) downloadLogCsv(_logAppender, 'notes-merge');
    });
    nm$('nm-start-over')?.addEventListener('click', resetNotesMerge);

    // Error
    nm$('nm-error-retry')?.addEventListener('click', resetNotesMerge);
    nm$('nm-error-download-log')?.addEventListener('click', () => {
      if (_logAppender) downloadLogCsv(_logAppender, 'notes-merge');
    });

    // Token disconnect — reset everything
    window.addEventListener('pb:disconnect', resetNotesMerge);
  }

  window.initNotesMergeModule = initNotesMergeModule;
})();
