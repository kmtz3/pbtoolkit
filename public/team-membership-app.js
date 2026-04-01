// ══════════════════════════════════════════════════════════════════════════════
// Team Membership module
// Depends on: app.js globals — $(), show(), hide(), setText(), subscribeSSE(),
//             requireToken(), triggerDownload(), esc(), makeLogAppender(),
//             downloadLogCsv(), token, useEu
// ══════════════════════════════════════════════════════════════════════════════

(function () {

  // ── Module state ──────────────────────────────────────────────────────────

  let tmCacheReady   = false;
  let tmCacheLoading = false;
  let tmTeamData     = []; // [{ id, name, handle }, ...] — sorted alphabetically

  // Export
  let tmLastBlob     = null;
  let tmLastFilename = 'pb-team-assignments.csv';

  // Import
  let tmCsvBuffer    = null;  // raw CSV text from uploaded file
  let tmCurrentDiffs = null;  // TeamDiff[] from last /preview response
  let tmImportCtrl   = null;  // AbortController from subscribeSSE

  // Log appender (created once, reused across runs within the same session)
  let tmLogAppender  = null;

  // Dropzone clear function (set in initTeamMembershipModule)
  let tmClearDropzone = null;

  // ── Helpers ───────────────────────────────────────────────────────────────

  function tm$(id) { return document.getElementById(id); }

  /**
   * GET request headers — omits Content-Type (invalid on GET, no body).
   * token and useEu are declared at page scope in app.js.
   */
  function tmGetHeaders() {
    const h = { 'x-pb-token': token };
    if (useEu) h['x-pb-eu'] = 'true';
    return h;
  }

  function tmShow(id) { const el = tm$(id); if (el) el.classList.remove('hidden'); }
  function tmHide(id) { const el = tm$(id); if (el) el.classList.add('hidden'); }

  // ── Format preview snippet ────────────────────────────────────────────────

  const FORMAT_PREVIEW = {
    A: `<div class="tm-preview-label">Example</div><div class="tm-preview-wrap"><table class="tm-preview-table">
      <thead><tr>
        <th>email</th><th>name</th><th>role</th>
        <th class="col-team">Team Alpha [id]</th><th class="col-team">Growth [id]</th>
      </tr></thead>
      <tbody>
        <tr><td>jane@…</td><td>Jane</td><td>maker</td><td class="col-check">✓</td><td></td></tr>
        <tr><td>bob@…</td><td>Bob</td><td>admin</td><td class="col-check">✓</td><td class="col-check">✓</td></tr>
      </tbody>
    </table></div>`,
    B: `<div class="tm-preview-label">Example</div><div class="tm-preview-wrap"><table class="tm-preview-table">
      <thead><tr>
        <th class="col-team">Team Alpha [id]</th><th class="col-team">Growth [id]</th><th class="col-team">Platform [id]</th>
      </tr></thead>
      <tbody>
        <tr><td>jane@…</td><td>james@…</td><td>sarah@…</td></tr>
        <tr><td>bob@…</td><td>maria@…</td><td></td></tr>
      </tbody>
    </table></div>`,
  };

  function updateFormatPreview() {
    const fmt = document.querySelector('input[name="tm-export-format"]:checked')?.value ?? 'A';
    const el  = tm$('tm-format-preview');
    if (el) el.innerHTML = FORMAT_PREVIEW[fmt] ?? '';
  }

  // ── Team filter list ──────────────────────────────────────────────────────

  function renderExportTeamList(teams) {
    tmTeamData = teams;
    const container = tm$('tm-export-team-filter');
    container.innerHTML = '';

    for (const team of teams) {
      const label = document.createElement('label');
      const cb    = document.createElement('input');
      cb.type    = 'checkbox';
      cb.value   = team.id;
      cb.checked = true;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + team.name));
      container.appendChild(label);
    }

    // Advisory for large workspaces
    const advisory = tm$('tm-export-team-advisory');
    if (teams.length > 20) {
      advisory.textContent = `Your workspace has ${teams.length} teams. Consider filtering to a subset for a more manageable export.`;
      tmShow('tm-export-team-advisory');
    } else {
      tmHide('tm-export-team-advisory');
    }
  }

  function wireExportTeamSearch() {
    const input = tm$('tm-export-team-search');
    if (!input) return;
    input.addEventListener('input', () => {
      const q = input.value.toLowerCase();
      tm$('tm-export-team-filter').querySelectorAll('label').forEach((lbl) => {
        lbl.style.display = lbl.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
  }

  function getSelectedExportTeamIds() {
    const cbs = tm$('tm-export-team-filter').querySelectorAll('input[type="checkbox"]');
    const checked = [...cbs].filter((cb) => cb.checked).map((cb) => cb.value);
    // If all selected, send null (export all — no filter param)
    return checked.length === tmTeamData.length ? null : checked;
  }

  // ── Metadata / cache init ─────────────────────────────────────────────────

  function loadTmMetadata(refresh = false) {
    if (tmCacheLoading) return;
    tmCacheLoading = true;
    tmCacheReady   = false;

    tm$('tm-export-team-filter').innerHTML =
      '<span class="text-muted" style="padding:8px 12px;display:block;font-size:12px;">Loading teams…</span>';
    tmHide('tm-export-team-error');
    tm$('tm-export-btn').disabled = true;

    const url = '/api/team-membership/metadata' + (refresh ? '?refresh=true' : '');
    fetch(url, { headers: tmGetHeaders() })
      .then((res) => res.json().then((data) => ({ ok: res.ok, status: res.status, data })))
      .then(({ ok, status, data }) => {
        tmCacheLoading = false;
        if (!ok) {
          showExportTeamError(data.error || `Failed to load workspace data (${status}).`);
          return;
        }
        renderExportTeamList(data.teams || []);
        const count = data.memberCount ?? 0;
        tm$('tm-export-member-count').textContent = count ? `${count.toLocaleString()} members loaded` : '';
        tmCacheReady = true;
        tm$('tm-export-btn').disabled = false;
      })
      .catch((err) => {
        tmCacheLoading = false;
        showExportTeamError(err.message || 'Network error loading workspace data.');
      });
  }

  function showExportTeamError(msg) {
    setText('tm-export-team-error-msg', msg);
    tmShow('tm-export-team-error');
    tm$('tm-export-team-filter').innerHTML = '';
    tm$('tm-export-btn').disabled = true;
  }

  // ── Export tab ────────────────────────────────────────────────────────────

  function resetExportState() {
    tmShow('tm-export-idle');
    tmHide('tm-export-done');
    tmHide('tm-export-error');
  }

  function runExport() {
    const fmt     = document.querySelector('input[name="tm-export-format"]:checked')?.value ?? 'A';
    const teamIds = getSelectedExportTeamIds();

    let url = `/api/team-membership/export?format=${fmt}`;
    if (teamIds && teamIds.length > 0) url += `&teamIds=${teamIds.join(',')}`;

    fetch(url, { headers: tmGetHeaders() })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          setText('tm-export-error-msg', err.error || `Export failed (${res.status}).`);
          tmHide('tm-export-idle');
          tmShow('tm-export-error');
          return;
        }
        // Extract filename from Content-Disposition header
        const cd = res.headers.get('Content-Disposition') || '';
        const match = cd.match(/filename="([^"]+)"/);
        tmLastFilename = match ? match[1] : `pb-team-assignments_${new Date().toISOString().slice(0, 10)}.csv`;

        return res.blob().then((blob) => {
          tmLastBlob = blob;
          triggerDownload(blob, tmLastFilename);
          setText('tm-export-last-filename', tmLastFilename);
          tmHide('tm-export-idle');
          tmShow('tm-export-done');
        });
      })
      .catch((err) => {
        setText('tm-export-error-msg', err.message || 'Export failed.');
        tmHide('tm-export-idle');
        tmShow('tm-export-error');
      });
  }

  // ── Import tab — file upload + preview ───────────────────────────────────

  function resetImportState() {
    tmCsvBuffer    = null;
    tmCurrentDiffs = null;
    if (tmClearDropzone) tmClearDropzone();
    tmHide('tm-import-format-badge');
    tmHide('tm-import-parse-error');
    tm$('tm-import-preview-btn').disabled = true;
    tmShow('tm-import-idle');
    tmHide('tm-import-uploading');
    tmHide('tm-import-diff');
    tmHide('tm-import-running');
    tmHide('tm-import-stopped');
    tmHide('tm-import-results');
    tmHide('tm-import-error');
    tmHide('btn-tm-results-download-log');
    tmHide('btn-tm-error-download-log');
    if (tmLogAppender) tmLogAppender.reset();
  }

  function onFileSelected(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      tmCsvBuffer = e.target.result;
      // Auto-detect format from first header
      const firstLine = tmCsvBuffer.split('\n')[0] || '';
      const firstHeader = firstLine.split(',')[0].replace(/"/g, '').trim().toLowerCase();
      let formatLabel = '';
      if (firstHeader === 'email') {
        formatLabel = 'Format A detected (team columns)';
      } else if (/\[[0-9a-f-]{36}\]/i.test(firstLine)) {
        formatLabel = 'Format B detected (stacked by team)';
      } else {
        formatLabel = 'Format unknown — server will attempt to detect';
      }
      setText('tm-import-format-badge', formatLabel);
      tmShow('tm-import-format-badge');
      tmHide('tm-import-parse-error');
      tm$('tm-import-preview-btn').disabled = false;
    };
    reader.readAsText(file);
  }

  function runPreview() {
    if (!tmCsvBuffer) return;
    const mode = document.querySelector('input[name="tm-import-mode"]:checked')?.value ?? 'set';

    tmHide('tm-import-idle');
    tmShow('tm-import-uploading');
    tmHide('tm-import-diff');

    fetch('/api/team-membership/preview', {
      method:  'POST',
      headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
      body:    JSON.stringify({ csvText: tmCsvBuffer, mode }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, status: res.status, data })))
      .then(({ ok, status, data }) => {
        tmHide('tm-import-uploading');

        if (!ok) {
          showImportError(data.error || `Preview failed (${status}).`);
          return;
        }

        if (data.hardErrors && data.hardErrors.length > 0) {
          // Show hard errors back in the idle state
          setText('tm-import-parse-error-msg', data.hardErrors[0]);
          tmShow('tm-import-idle');
          tmShow('tm-import-parse-error');
          tm$('tm-import-preview-btn').disabled = false;
          return;
        }

        tmCurrentDiffs = data.diffs || [];
        renderDiffPreview(data, mode);
        tmShow('tm-import-diff');
      })
      .catch((err) => {
        tmHide('tm-import-uploading');
        showImportError(err.message || 'Preview failed.');
      });
  }

  // ── Diff preview rendering ────────────────────────────────────────────────

  function renderDiffPreview(data, mode) {
    const diffs             = data.diffs || [];
    const unresolvable      = data.unresolvableEmails || [];
    const nameResolved      = data.nameResolvedTeams || [];
    const unrecognisedVals  = data.unrecognisedValues;

    // Global summary counts
    const totalAdd     = diffs.reduce((n, d) => n + d.toAdd.length,    0);
    const totalRemove  = diffs.reduce((n, d) => n + d.toRemove.length, 0);
    const totalUnchg   = diffs.reduce((n, d) => n + d.unchanged.length, 0);
    const teamsAffected = diffs.filter((d) => d.toAdd.length + d.toRemove.length > 0).length;
    const totalOps     = totalAdd + totalRemove;

    // Summary bar
    tm$('tm-diff-summary').innerHTML =
      `<span><strong>${diffs.length}</strong> team${diffs.length !== 1 ? 's' : ''} in scope</span>` +
      ` · <span class="tm-diff-add"><strong>+${totalAdd.toLocaleString()}</strong> will be added</span>` +
      ` · <span class="tm-diff-remove"><strong>−${totalRemove.toLocaleString()}</strong> will be removed</span>` +
      ` · <span class="tm-diff-unchanged"><strong>●${totalUnchg.toLocaleString()}</strong> unchanged</span>`;

    // Warnings block
    const warningsEl = tm$('tm-diff-warnings');
    warningsEl.innerHTML = '';

    if (mode === 'set' && totalRemove > 0) {
      warningsEl.innerHTML += `
        <div class="alert alert-warn" style="margin-bottom:8px;">
          <span class="alert-icon">⚠️</span>
          <span>Members not listed in this file will be removed from the teams shown above. Teams not present as columns are unaffected.</span>
        </div>`;
    }

    if (unresolvable.length > 0) {
      const list = unresolvable.slice(0, 5).map((u) => `<li>${esc(u.email)} (column: ${esc(u.teamName)})</li>`).join('');
      const more = unresolvable.length > 5 ? `<li>…and ${unresolvable.length - 5} more</li>` : '';
      warningsEl.innerHTML += `
        <div class="alert alert-warn" style="margin-bottom:8px;">
          <span class="alert-icon">⚠️</span>
          <span>${unresolvable.length} email${unresolvable.length !== 1 ? 's' : ''} could not be resolved and will be skipped:<ul style="margin:4px 0 0 16px;">${list}${more}</ul></span>
        </div>`;
    }

    if (nameResolved.length > 0) {
      const list = nameResolved.map((n) =>
        `<li>"${esc(n.colName)}" → matched to ${esc(n.resolvedName)} [${esc(n.resolvedId)}]</li>`
      ).join('');
      warningsEl.innerHTML += `
        <div class="alert alert-warn" style="margin-bottom:8px;">
          <span class="alert-icon">⚠️</span>
          <span>${nameResolved.length} column${nameResolved.length !== 1 ? 's were' : ' was'} matched by team name (no ID found in header). Verify before confirming:<ul style="margin:4px 0 0 16px;">${list}</ul></span>
        </div>`;
    }

    if (unrecognisedVals) {
      warningsEl.innerHTML += `
        <div class="alert alert-warn" style="margin-bottom:8px;">
          <span class="alert-icon">⚠️</span>
          <span>${unrecognisedVals.count} cell${unrecognisedVals.count !== 1 ? 's' : ''} had unrecognised values and were treated as unassigned. Check your CSV if this is unexpected.</span>
        </div>`;
    }

    // Per-team collapsible blocks
    renderTeamBlocks(diffs);

    // API call estimate
    tm$('tm-diff-api-estimate').textContent =
      `This import will make ~${totalOps.toLocaleString()} API call${totalOps !== 1 ? 's' : ''}  (workspace limit: 1,000/hour)`;

    // Confirm button
    const confirmBtn = tm$('tm-confirm-btn');
    const modeLabels = { set: 'Confirm & Set', add: 'Confirm & Add', remove: 'Confirm & Remove' };
    confirmBtn.textContent = modeLabels[mode] ?? 'Confirm';
    confirmBtn.disabled = false;
    // Set mode gets a more prominent destructive style
    confirmBtn.className = mode === 'set'
      ? 'btn btn-danger'
      : 'btn btn-primary';
  }

  function renderTeamBlocks(diffs) {
    const container    = tm$('tm-diff-teams');
    const showUnchanged = tm$('tm-diff-show-unchanged')?.checked ?? false;
    container.innerHTML = '';

    for (const diff of diffs) {
      const hasChanges = diff.toAdd.length + diff.toRemove.length > 0;
      if (!hasChanges && !showUnchanged) continue;

      const addBadge    = diff.toAdd.length    > 0 ? `<span class="tm-diff-add">+${diff.toAdd.length}</span>`       : '';
      const removeBadge = diff.toRemove.length > 0 ? `<span class="tm-diff-remove">−${diff.toRemove.length}</span>` : '';
      const unchgBadge  = diff.unchanged.length > 0 ? `<span class="tm-diff-unchanged">●${diff.unchanged.length}</span>` : '';
      const badges      = [addBadge, removeBadge, unchgBadge].filter(Boolean).join(' / ');

      const details = document.createElement('details');
      details.className = 'tm-diff-team-block' + (!hasChanges ? ' tm-diff-team-unchanged' : '');

      const summary = document.createElement('summary');
      summary.innerHTML = `<span class="tm-diff-team-name">${esc(diff.teamName)}</span> <span class="tm-diff-badges">${badges}</span>`;
      details.appendChild(summary);

      // Member rows
      const rows = document.createElement('div');
      rows.className = 'tm-diff-member-rows';

      for (const m of diff.unchanged) {
        rows.innerHTML += `<div class="tm-diff-unchanged">● ${esc(m.email ?? m)}</div>`;
      }
      for (const m of diff.toAdd) {
        rows.innerHTML += `<div class="tm-diff-add">+ ${esc(m.email ?? m)}</div>`;
      }
      for (const m of diff.toRemove) {
        rows.innerHTML += `<div class="tm-diff-remove">− ${esc(m.email ?? m)}</div>`;
      }

      details.appendChild(rows);
      container.appendChild(details);
    }

    if (container.children.length === 0) {
      container.innerHTML = '<p class="text-muted" style="font-size:13px;">No teams to display.</p>';
    }
  }

  // ── Import execution ──────────────────────────────────────────────────────

  function runImport() {
    if (!tmCsvBuffer) return;
    const mode = document.querySelector('input[name="tm-import-mode"]:checked')?.value ?? 'set';

    // Initialise log appender
    if (!tmLogAppender) {
      tmLogAppender = makeLogAppender(
        'tm-import-log',
        'tm-import-log-entries',
        'tm-import-log-counts',
        'team_membership'
      );
    } else {
      tmLogAppender.reset();
    }

    // Switch to running state
    tmHide('tm-import-diff');
    tmShow('tm-import-running');
    tmHide('tm-import-stopped');
    tmHide('tm-import-results');
    tmHide('tm-import-error');
    setImportProgress('Starting import…', 0);

    tmImportCtrl = subscribeSSE('/api/team-membership/import', { csvText: tmCsvBuffer, mode }, {
      onProgress({ message, percent }) {
        setImportProgress(message, percent);
      },
      onLog(entry) {
        tmLogAppender(entry);
      },
      onComplete(data) {
        tmHide('tm-import-running');
        showImportResults(data, mode);
      },
      onError(msg) {
        tmHide('tm-import-running');
        showImportError(msg || 'Import failed. Please try again.');
      },
      onAbort() {
        tmHide('tm-import-running');
        const counts = tmLogAppender?.getCounts() ?? {};
        setText('tm-import-stopped-msg',
          `Import stopped. ${counts.success ?? 0} operations completed before stopping.`
        );
        tmShow('tm-import-stopped');
        tmImportCtrl = null;
        // Move log to stopped state
        moveLogToResults();
      },
    });
  }

  function setImportProgress(msg, pct) {
    setText('tm-import-progress-msg', msg || '');
    if (pct !== null && pct !== undefined) {
      tm$('tm-import-progress-bar').style.width = `${Math.min(100, Math.round(pct))}%`;
    }
  }

  function showImportResults(data, mode) {
    const resultsEl = tm$('tm-results-summary');

    const hasErrors  = (data.errors?.length ?? 0) > 0;
    const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
    const icon       = hasErrors ? '⚠️' : '✅';

    resultsEl.innerHTML = `
      <div class="alert ${alertClass}">
        <span class="alert-icon">${icon}</span>
        <div>
          <div><strong>Import complete</strong></div>
          <div style="margin-top:4px;font-size:13px;">
            ✓ ${(data.added   ?? 0).toLocaleString()} assignment${data.added   !== 1 ? 's' : ''} added<br>
            ✓ ${(data.removed ?? 0).toLocaleString()} assignment${data.removed !== 1 ? 's' : ''} removed<br>
            – ${(data.skippedAlreadyMember ?? 0).toLocaleString()} skipped (already assigned)<br>
            – ${(data.skippedNotMember     ?? 0).toLocaleString()} skipped (not a member)
            ${hasErrors ? `<br><span style="color:var(--c-danger);">✗ ${data.errors.length} error${data.errors.length !== 1 ? 's' : ''} — see log for details</span>` : ''}
          </div>
        </div>
      </div>`;

    moveLogToResults();
    tmShow('tm-import-results');
  }

  function showImportError(msg) {
    setText('tm-import-error-msg', msg);
    tmHide('tm-import-idle');
    tmHide('tm-import-uploading');
    tmHide('tm-import-diff');
    tmHide('tm-import-running');
    tmShow('tm-import-error');
    if (tmLogAppender?.getRows().length > 0) tmShow('btn-tm-error-download-log');
  }

  /**
   * The live log lives inside #tm-import-running while running.
   * After completion/stop, move the log entries into #tm-results-log so they
   * persist in the results panel — avoids duplicating state.
   */
  function moveLogToResults() {
    const srcEntries = tm$('tm-import-log-entries');
    const srcCounts  = tm$('tm-import-log-counts');
    const dstEntries = tm$('tm-results-log-entries');
    const dstCounts  = tm$('tm-results-log-counts');
    if (!srcEntries || !dstEntries) return;
    dstEntries.innerHTML = srcEntries.innerHTML;
    dstCounts.innerHTML  = srcCounts.innerHTML;
    if (srcEntries.children.length > 0) {
      tmShow('tm-results-log');
      tmShow('btn-tm-results-download-log');
    }
  }

  // ── Public init (called from app.js loadTool) ─────────────────────────────

  function initTeamMembershipModule() {
    // Wire up listeners once only
    if (tm$('tm-export-btn').__tmInit) return;
    tm$('tm-export-btn').__tmInit = true;

    // Format toggle
    document.querySelectorAll('input[name="tm-export-format"]').forEach((r) => {
      r.addEventListener('change', updateFormatPreview);
    });
    updateFormatPreview();

    // Export team search
    wireExportTeamSearch();

    // Export select/deselect all
    tm$('btn-tm-export-teams-select-all').addEventListener('click', () => {
      tm$('tm-export-team-filter').querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        if (cb.closest('label').style.display !== 'none') cb.checked = true;
      });
    });
    tm$('btn-tm-export-teams-deselect-all').addEventListener('click', () => {
      tm$('tm-export-team-filter').querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        if (cb.closest('label').style.display !== 'none') cb.checked = false;
      });
    });

    // Export buttons
    tm$('tm-export-btn').addEventListener('click', () => requireToken(runExport));
    tm$('btn-tm-export-refresh').addEventListener('click', () => loadTmMetadata(true));
    tm$('btn-tm-export-download').addEventListener('click', () => {
      if (tmLastBlob) triggerDownload(tmLastBlob, tmLastFilename);
    });
    tm$('btn-tm-export-again').addEventListener('click', resetExportState);
    tm$('btn-tm-export-retry').addEventListener('click', resetExportState);

    // Import: upload dropzone
    ({ clear: tmClearDropzone } = wireDropzone(
      tm$('tm-import-dropzone'),
      tm$('tm-import-file'),
      (file) => onFileSelected(file),
      () => {
        tmCsvBuffer = null;
        tm$('tm-import-preview-btn').disabled = true;
      }
    ));

    // Import preview
    tm$('tm-import-preview-btn').addEventListener('click', () => requireToken(runPreview));

    // Diff: show unchanged toggle
    tm$('tm-diff-show-unchanged').addEventListener('change', () => {
      if (tmCurrentDiffs) renderTeamBlocks(tmCurrentDiffs);
    });

    // Confirm import
    tm$('tm-confirm-btn').addEventListener('click', () => requireToken(runImport));

    // Cancel diff
    tm$('tm-cancel-btn').addEventListener('click', () => {
      tmHide('tm-import-diff');
      tmShow('tm-import-idle');
    });

    // Stop import
    tm$('tm-import-stop').addEventListener('click', () => {
      tmImportCtrl?.abort();
      tmImportCtrl = null;
    });

    // Results / stopped — start over
    tm$('btn-tm-import-again').addEventListener('click', resetImportState);
    tm$('btn-tm-import-stopped-again').addEventListener('click', resetImportState);
    tm$('btn-tm-import-error-retry').addEventListener('click', resetImportState);

    // Download log (results header + error panel)
    tm$('btn-tm-results-download-log').addEventListener('click', () => {
      if (tmLogAppender) downloadLogCsv(tmLogAppender, 'team-membership-import');
    });
    tm$('btn-tm-error-download-log').addEventListener('click', () => {
      if (tmLogAppender) downloadLogCsv(tmLogAppender, 'team-membership-import');
    });

    // Load metadata
    loadTmMetadata(false);
  }

  // ── pb:disconnect / pb:connected ──────────────────────────────────────────

  window.addEventListener('pb:disconnect', () => {
    tmCacheReady   = false;
    tmCacheLoading = false;
    tmTeamData     = [];
    tmLastBlob     = null;
    tmLastFilename = 'pb-team-assignments.csv';
    tmCsvBuffer    = null;
    tmCurrentDiffs = null;
    tmImportCtrl   = null;
    if (tmLogAppender) tmLogAppender.reset();
    resetExportState();
    resetImportState();
  });

  window.addEventListener('pb:connected', () => {
    if (!tmCacheReady && !tmCacheLoading && tm$('tm-export-team-filter')) loadTmMetadata(false);
  });

  // ── Expose to global scope ────────────────────────────────────────────────

  window.initTeamMembershipModule = initTeamMembershipModule;

})();
