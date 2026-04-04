/* =========================================================
   Merge Duplicate Notes module
   Exposes: window.initNotesMergeModule()
   ========================================================= */

(function () {
  'use strict';

  // ── Module state ─────────────────────────────────────────
  let _scanData    = null;  // { groups, partialMatchGroups, stats } from last scan
  let _looseMatch  = false; // whether loose match was enabled for the last scan
  let _auditLog    = null;  // audit log from last run
  let _scanCtrl    = null;  // AbortController for scan SSE
  let _runCtrl     = null;  // AbortController for run SSE
  let _logAppender = null;  // makeLogAppender bound to run log panel
  let _inited      = false;
  let _groupCardEls    = new Map(); // group → <details> el, for in-place re-render after target swap
  let _selectedGroups  = new Set(); // groups with checkbox checked
  let _lastMergedGroups = [];       // groups sent in the last runMerge call, used by "Back to preview"

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
    nmHide('nm-compare-overlay');
    _splitGroup = null;
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
    if (!token) { requireToken(() => startScan()); return; }

    const createdFrom = nm$('nm-date-from')?.value ? nm$('nm-date-from').value + 'T00:00:00.000Z' : '';
    const createdTo   = nm$('nm-date-to')?.value   ? nm$('nm-date-to').value   + 'T23:59:59.999Z' : '';
    const looseMatch  = nm$('nm-loose-match')?.checked || false;
    const targetMode  = document.querySelector('input[name="nm-target-mode"]:checked')?.value || 'newest';
    _looseMatch = looseMatch;

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

  // ── Compare modal state ───────────────────────────────────
  let _splitGroup      = null;
  let _splitGroupIndex = 0;
  let _splitSecIndex   = 0;

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
        if (stats.oversizedGroups > 0) text += ` ${stats.oversizedGroups} group(s) with 100+ notes were skipped.`;
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
    nmHide('nm-split-view');

    // Oversized warning
    if (stats.oversizedGroups > 0) {
      nmText('nm-oversized-warn-text', `${stats.oversizedGroups} group(s) with 100+ notes were skipped — review manually.`);
      nmShow('nm-oversized-warn');
    } else {
      nmHide('nm-oversized-warn');
    }

    // Collapsible groups
    const listEl = nm$('nm-groups-list');
    if (listEl) {
      listEl.innerHTML = '';
      _groupCardEls.clear();
      _selectedGroups.clear();
      groups.forEach((group, gi) => {
        listEl.appendChild(buildGroupBlock(group, gi));
      });
    }

    // Partial matches
    if (partialMatchGroups.length > 0) {
      nmShow('nm-partial-matches-wrap');
      nmText('nm-partial-count', String(partialMatchGroups.length));
      // Show loose-match hint only when loose match was not enabled for this scan
      if (_looseMatch) nmHide('nm-partial-loose-hint');
      else             nmShow('nm-partial-loose-hint');
      const ptbody = nm$('nm-partial-tbody');
      if (ptbody) {
        ptbody.innerHTML = '';
        partialMatchGroups.forEach((notes, gi) => {
          notes.forEach(note => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
              <td>${gi + 1}</td>
              <td>${esc(note.title || '—')}</td>
              <td style="font-size:12px;">${esc(note.customer_email || note.customer_company || '—')}</td>
              <td style="font-size:12px;">${esc(note.owner_email || '—')}</td>
              <td style="font-size:12px;">${esc(note.state)}</td>
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

  function updateSelectionUI() {
    const anySelected = _selectedGroups.size > 0;
    const mergeBtn = nm$('nm-merge-btn');
    if (mergeBtn) mergeBtn.textContent = anySelected
      ? `Merge & delete selected (${_selectedGroups.size})`
      : 'Merge & delete duplicates';
    if (anySelected) {
      nmShow('nm-unselect-all');
      nmShow('nm-invert-selection');
    } else {
      nmHide('nm-unselect-all');
      nmHide('nm-invert-selection');
    }
  }

  /** Build a collapsible <details> block for one duplicate group. */
  function buildGroupBlock(group, gi) {
    // Preserve original note order across target swaps
    if (!group.allNotes) group.allNotes = [group.target, ...group.secondaries];
    const { target, secondaries } = group;
    const total = group.allNotes.length;

    const details = document.createElement('details');
    details.open = true;
    details.dataset.gi = gi;
    details.style.cssText = 'border:1px solid var(--c-border,#e2e8f0);border-radius:6px;margin-bottom:8px;overflow:hidden;';
    _groupCardEls.set(group, details);

    // Summary / header
    const summary = document.createElement('summary');
    summary.style.cssText = [
      'cursor:pointer;list-style:none;padding:10px 14px;',
      'display:flex;align-items:center;gap:10px;min-width:0;',
      'background:var(--c-bg-alt,#f8f9fa);font-size:13px;font-weight:500;user-select:none;',
    ].join('');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = _selectedGroups.has(group);
    checkbox.style.cssText = 'cursor:pointer;flex-shrink:0;';
    checkbox.title = 'Select group for bulk merge';
    checkbox.addEventListener('click', (e) => { e.stopPropagation(); });
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) _selectedGroups.add(group);
      else _selectedGroups.delete(group);
      updateSelectionUI();
    });

    const groupLabel = document.createElement('span');
    groupLabel.style.cssText = 'white-space:nowrap;';
    groupLabel.textContent = `Group ${gi + 1}`;

    const countLabel = document.createElement('span');
    countLabel.style.cssText = 'color:var(--c-muted);font-weight:400;white-space:nowrap;';
    countLabel.textContent = `${total} note${total > 1 ? 's' : ''} · ${secondaries.length} to delete`;

    const titleLabel = document.createElement('span');
    titleLabel.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-weight:400;';
    titleLabel.textContent = target.title || '(untitled)';

    const customerLabel = document.createElement('span');
    customerLabel.style.cssText = 'color:var(--c-muted);font-weight:400;font-size:12px;white-space:nowrap;';
    customerLabel.textContent = target.customer_email || target.customer_company || '';

    const spacer = document.createElement('span');
    spacer.style.flex = '1';

    const compareHint = document.createElement('span');
    compareHint.style.cssText = 'font-size:11px;color:var(--c-muted);font-weight:400;white-space:nowrap;';
    compareHint.textContent = 'click a row to compare';

    const mergeOneBtn = document.createElement('button');
    mergeOneBtn.className = 'btn btn-danger btn-sm';
    mergeOneBtn.textContent = 'Merge this group';
    mergeOneBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't toggle the details element
      runSingleGroupMerge(group, gi + 1);
    });

    summary.append(checkbox, groupLabel, countLabel, titleLabel, customerLabel, spacer, compareHint, mergeOneBtn);
    details.appendChild(summary);

    // Compact table
    const table = document.createElement('table');
    table.className = 'mapping-table';
    table.style.marginBottom = '0';
    table.innerHTML = `
      <thead>
        <tr>
          <th style="width:80px;">Role</th>
          <th>Title</th>
          <th>Customer</th>
          <th>Owner</th>
          <th>State</th>
          <th>Created</th>
          <th style="width:110px;"></th>
        </tr>
      </thead>
    `;
    const tbody = document.createElement('tbody');

    group.allNotes.forEach((note) => {
      const isTarget = note === group.target;
      const secIndex = isTarget ? 0 : group.secondaries.indexOf(note);

      const tr = document.createElement('tr');
      tr.style.cssText = 'cursor:pointer;height:38px;';
      tr.title = 'Click to compare';

      const roleBadge = isTarget
        ? '<span class="badge badge-ok" style="font-size:10px;">Target</span>'
        : '<span class="badge badge-danger" style="font-size:10px;">Delete</span>';

      tr.innerHTML = `
        <td>${roleBadge}</td>
        <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${isTarget ? 'font-weight:600;' : ''}"
            title="${esc(note.title)}">${esc(note.title) || '<em style="color:var(--c-muted)">untitled</em>'}</td>
        <td style="font-size:12px;">${esc(note.customer_email || note.customer_company || '—')}</td>
        <td style="font-size:12px;">${esc(note.owner_email || '—')}</td>
        <td style="font-size:12px;">${esc(note.state)}</td>
        <td style="font-size:11px;color:var(--c-muted);">${esc(note.created_at ? note.created_at.slice(0, 10) : '—')}</td>
        <td></td>
      `;

      if (!isTarget) {
        const actionCell = tr.lastElementChild;
        const makeTargetBtn = document.createElement('button');
        makeTargetBtn.className = 'btn btn-ghost btn-sm';
        makeTargetBtn.textContent = 'Set as target';
        makeTargetBtn.title = 'Set this note as the merge target — others in the group will be deleted';
        makeTargetBtn.style.cssText = 'font-size:11px;white-space:nowrap;';
        makeTargetBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          swapTarget(group, note);
        });
        actionCell.appendChild(makeTargetBtn);
      }

      tr.addEventListener('click', () => {
        openSplitView(group, isTarget ? 0 : secIndex);
      });

      tr.addEventListener('mouseenter', () => { tr.style.background = 'var(--c-bg-hover,#f1f5f9)'; });
      tr.addEventListener('mouseleave', () => { tr.style.background = ''; });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    details.appendChild(table);
    return details;
  }

  // ── Target swap ────────────────────────────────────────────
  function swapTarget(group, newTargetNote) {
    if (newTargetNote === group.target) return;
    const oldTarget = group.target;
    group.target = newTargetNote;
    // Rebuild secondaries: all allNotes except the new target
    group.secondaries = group.allNotes.filter(n => n !== newTargetNote);
    rerenderGroupCard(group);
    if (_splitGroup === group) {
      // Keep showing same note in right panel if still a secondary, else reset
      const stillSec = group.secondaries.indexOf(oldTarget);
      _splitSecIndex = stillSec !== -1 ? stillSec : 0;
      renderSplitPanel();
    }
  }

  function rerenderGroupCard(group) {
    const oldEl = _groupCardEls.get(group);
    if (!oldEl) return;
    const wasOpen = oldEl.open;
    const gi = parseInt(oldEl.dataset.gi, 10);
    const newEl = buildGroupBlock(group, gi);
    newEl.open = wasOpen;
    oldEl.replaceWith(newEl);
  }

  // ── Compare modal ──────────────────────────────────────────
  function openSplitView(group, secIndex) {
    const groups = _scanData?.groups || [];
    _splitGroupIndex = groups.indexOf(group);
    if (_splitGroupIndex === -1) _splitGroupIndex = 0;
    _splitGroup    = group;
    _splitSecIndex = secIndex;
    renderSplitPanel();
    nmShow('nm-compare-overlay');
  }

  function renderSplitPanel() {
    const groups      = _scanData?.groups || [];
    const { target, secondaries } = _splitGroup;
    const sec         = secondaries[_splitSecIndex];
    const totalSec    = secondaries.length;
    const totalGroups = groups.length;
    const showMerged  = nm$('nm-split-preview-merge')?.checked || false;

    // Header labels
    nmText('nm-cmp-group-label', target.title || '(untitled)');
    nmText('nm-cmp-group-nav',   `${_splitGroupIndex + 1} / ${totalGroups}`);
    nmText('nm-cmp-sec-nav',     `${_splitSecIndex + 1} / ${totalSec}`);

    // Sync modal checkbox with _selectedGroups
    const modalCb = nm$('nm-cmp-group-select');
    if (modalCb) modalCb.checked = _selectedGroups.has(_splitGroup);

    // Group nav buttons
    const prevGrpBtn = nm$('nm-cmp-prev-group');
    const nextGrpBtn = nm$('nm-cmp-next-group');
    if (prevGrpBtn) prevGrpBtn.disabled = _splitGroupIndex === 0;
    if (nextGrpBtn) nextGrpBtn.disabled = _splitGroupIndex === totalGroups - 1;

    // Secondary nav buttons
    const prevSecBtn = nm$('nm-cmp-prev-sec');
    const nextSecBtn = nm$('nm-cmp-next-sec');
    if (prevSecBtn) prevSecBtn.disabled = _splitSecIndex === 0;
    if (nextSecBtn) nextSecBtn.disabled = _splitSecIndex === totalSec - 1;

    // Panels
    const leftEl  = nm$('nm-split-left');
    const rightEl = nm$('nm-split-right');
    if (leftEl)  leftEl.innerHTML  = showMerged
      ? renderNoteCardMerged(_splitGroup)
      : renderNoteCard(target, 'TARGET — kept', false, null);
    if (rightEl) {
      rightEl.innerHTML = renderNoteCard(sec, `DUPLICATE ${_splitSecIndex + 1} — will be deleted`, true, target, showMerged);
      const makeTargetBtn = document.createElement('button');
      makeTargetBtn.className = 'btn btn-secondary';
      makeTargetBtn.textContent = 'Set as target';
      makeTargetBtn.style.cssText = 'flex-shrink:0;font-size:10px;padding:2px 7px;line-height:1.4;';
      makeTargetBtn.addEventListener('click', () => swapTarget(_splitGroup, sec));
      // Inject into the label row (first element child) so it sits top-right
      const labelEl = rightEl.firstElementChild;
      if (labelEl) {
        labelEl.style.cssText += 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
        labelEl.appendChild(makeTargetBtn);
      } else {
        rightEl.prepend(makeTargetBtn);
      }
    }
  }

  function closeCompareModal() {
    nmHide('nm-compare-overlay');
    _splitGroup = null;
  }

  function navigateGroup(delta) {
    const groups = _scanData?.groups || [];
    const next   = _splitGroupIndex + delta;
    if (next < 0 || next >= groups.length) return;
    _splitGroupIndex = next;
    _splitGroup      = groups[next];
    _splitSecIndex   = 0;
    renderSplitPanel();
  }

  function navigateSec(delta) {
    const next = _splitSecIndex + delta;
    if (!_splitGroup || next < 0 || next >= _splitGroup.secondaries.length) return;
    _splitSecIndex = next;
    renderSplitPanel();
  }

  /** Render the target card showing what it will look like after merge rules are applied.
   *  Items that will be added are highlighted in purple. */
  function renderNoteCardMerged(group) {
    const { target, secondaries } = group;
    const STATE_PRI = { processed: 0, unprocessed: 1, archived: 2 };

    // Tags: existing stay, new ones from secondaries shown in purple
    const existingTags = new Set(target.tags || []);
    const newTags = [...new Set(secondaries.flatMap(s => s.tags || []))].filter(t => !existingTags.has(t));

    // Links: same logic
    const existingLinks = new Set(target.product_links || []);
    const newLinks = [...new Set(secondaries.flatMap(s => s.product_links || []))].filter(id => !existingLinks.has(id));

    // State reconciliation
    const allStates   = [target, ...secondaries].map(n => n.state || 'unprocessed');
    const mergedState = allStates.reduce((best, s) => (STATE_PRI[s] ?? 99) < (STATE_PRI[best] ?? 99) ? s : best);
    const stateChanged = mergedState !== (target.state || 'unprocessed');

    // Followers: secondary owners that aren't already the target owner
    const targetOwner  = target.owner_email || '';
    const newFollowers = [...new Set(secondaries.map(s => s.owner_email).filter(e => e && e !== targetOwner))];

    // Customer: upgrade from company to user if a secondary has a user rel
    let newCustomerLabel = null;
    if (target.customer_type !== 'user') {
      const secWithUser = secondaries.find(s => s.customer_type === 'user' && s.customer_id);
      if (secWithUser) newCustomerLabel = secWithUser.customer_email || secWithUser.customer_id;
    }

    const purple = (html) => `<span style="color:#7c3aed;font-weight:500;">${html}</span>`;

    const customerHtml = newCustomerLabel
      ? `${esc(target.customer_email || target.customer_company || '—')} → ${purple(esc(newCustomerLabel))}`
      : esc(target.customer_email || target.customer_company || '—');

    const tagsHtml = [
      ...[...existingTags].map(t => esc(t)),
      ...newTags.map(t => purple(`+ ${esc(t)}`)),
    ].join(', ') || '—';

    const linksHtml = [
      ...(existingLinks.size  ? [`${existingLinks.size} existing`]               : []),
      ...(newLinks.length     ? [purple(`+ ${newLinks.length} new`)]              : []),
    ].join(', ') || '—';

    const stateHtml = stateChanged
      ? `${esc(target.state || 'unprocessed')} → ${purple(esc(mergedState))}`
      : esc(mergedState);

    const followersHtml = newFollowers.length
      ? newFollowers.map(e => purple(esc(e))).join(', ')
      : '<span style="color:var(--c-muted)">none</span>';

    function row(label, value) {
      return `<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--c-border,#e2e8f0);font-size:12px;">
        <span style="width:76px;flex-shrink:0;color:var(--c-muted);font-weight:500;">${label}</span>
        <span style="min-width:0;word-break:break-word;">${value}</span>
      </div>`;
    }

    return `
      <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--c-ok,#22c55e);margin-bottom:6px;">TARGET — POST-MERGE PREVIEW</div>
      <div style="font-size:11px;color:#7c3aed;margin-bottom:10px;">Items in purple will be added during merge.</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:12px;line-height:1.3;">${esc(target.title || '(untitled)')}</div>
      <div style="font-size:11px;color:var(--c-muted);margin-bottom:4px;font-weight:500;">Content preview</div>
      <div style="font-size:12px;background:var(--c-bg-alt,#f8f9fa);border:1px solid var(--c-border,#e2e8f0);border-radius:4px;padding:8px;max-height:100px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;margin-bottom:12px;line-height:1.5;">${esc(target.content_preview || '—')}${target.content_preview?.length >= 100 ? '<span style="color:var(--c-muted)">…</span>' : ''}</div>
      ${row('Customer',  customerHtml)}
      ${row('Owner',     esc(target.owner_email || '—'))}
      ${row('Tags',      tagsHtml)}
      ${row('Links',     linksHtml)}
      ${row('Source',    [target.source_origin, target.source_record_id].filter(Boolean).map(esc).join(' · ') || '—')}
      ${row('State',     stateHtml)}
      ${row('Created',   esc(target.created_at ? target.created_at.slice(0, 10) : '—'))}
      ${row('Followers', followersHtml)}
    `;
  }

  /**
   * Render a note detail card.
   * When target is provided (secondary panel), fields are compared against the target:
   *   - Data that will be merged/transferred → normal colour
   *   - Data that will be permanently lost   → red with a "lost" tooltip
   *   - Data identical to the target         → muted
   */
  function renderNoteCard(note, label, isSecondary, target, showMerged = false) {
    const lost = (html, reason) =>
      `<span style="color:var(--c-danger,#ef4444);" title="${esc(reason)}">${html} <span style="font-size:10px;">✕ lost</span></span>`;
    const muted = (html) =>
      `<span style="color:var(--c-muted);">${html}</span>`;

    function row(fieldLabel, value) {
      return `<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--c-border,#e2e8f0);font-size:12px;">
        <span style="width:76px;flex-shrink:0;color:var(--c-muted);font-weight:500;">${fieldLabel}</span>
        <span style="min-width:0;word-break:break-word;">${value}</span>
      </div>`;
    }

    // ── Field values ──────────────────────────────────────────
    const customer = note.customer_email || note.customer_company || '—';
    const tags     = note.tags?.length            ? note.tags.join(', ')              : '—';
    const links    = note.product_links?.length   ? `${note.product_links.length} link(s)` : '—';

    // Title: lost when secondary title differs from target's (loose match case)
    let titleHtml = `<div style="font-size:14px;font-weight:600;margin-bottom:12px;line-height:1.3;">`;
    if (isSecondary && target && note.title !== target.title) {
      titleHtml += lost(esc(note.title || '(untitled)'), 'Title differs from target and will be discarded');
    } else {
      titleHtml += esc(note.title || '(untitled)');
    }
    titleHtml += '</div>';

    // Source: show origin + record_id. On secondaries, only flag source_record_id red
    // when it differs from the target's — if they match, the target already has it (no loss).
    let sourceHtml;
    if (!note.source_origin && !note.source_record_id) {
      sourceHtml = '<span style="color:var(--c-muted)">—</span>';
    } else if (isSecondary && target) {
      const sameRecord = note.source_record_id && note.source_record_id === target.source_record_id;
      const originPart = note.source_origin ? esc(note.source_origin) : '';
      const recordPart = note.source_record_id
        ? (sameRecord
            ? muted(esc(note.source_record_id))
            : lost(esc(note.source_record_id), 'Source record ID is immutable — cannot be transferred to the target'))
        : '';
      sourceHtml = [originPart, recordPart].filter(Boolean).join(' · ') || '<span style="color:var(--c-muted)">—</span>';
    } else {
      const parts = [note.source_origin, note.source_record_id].filter(Boolean).map(esc);
      sourceHtml = parts.join(' · ') || '<span style="color:var(--c-muted)">—</span>';
    }

    // Tags: on secondary, all tags will be merged → show as muted "will be merged" if target already has them, normal otherwise
    let tagsHtml;
    if (isSecondary && target && note.tags?.length) {
      const targetTags = new Set(target.tags || []);
      tagsHtml = note.tags.map(t =>
        targetTags.has(t) ? muted(esc(t)) : esc(t)
      ).join(', ');
    } else {
      tagsHtml = esc(tags);
    }

    // Links: same as tags — already-linked ones are muted, new ones normal
    let linksHtml;
    if (isSecondary && target && note.product_links?.length) {
      const targetLinks = new Set(target.product_links || []);
      const alreadyLinked = note.product_links.filter(id =>  targetLinks.has(id)).length;
      const newLinks      = note.product_links.filter(id => !targetLinks.has(id)).length;
      const parts = [];
      if (newLinks      > 0) parts.push(`${newLinks} to add`);
      if (alreadyLinked > 0) parts.push(muted(`${alreadyLinked} already linked`));
      linksHtml = parts.join(', ') || '—';
    } else {
      linksHtml = esc(links);
    }

    // Owner: secondary owner becomes a follower only when it differs from the target's
    let ownerHtml = esc(note.owner_email || '—');
    if (isSecondary && note.owner_email && note.owner_email !== target?.owner_email) {
      ownerHtml += ` <span style="font-size:10px;color:var(--c-muted);">(→ follower)</span>`;
    }

    // Content: same content in exact mode; technically the secondary note body is discarded
    // but content matched so it's identical to target — show as muted
    const contentStyle = isSecondary
      ? 'font-size:12px;background:var(--c-bg-alt,#f8f9fa);border:1px solid var(--c-border,#e2e8f0);border-radius:4px;padding:8px;max-height:100px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;margin-bottom:12px;line-height:1.5;color:var(--c-muted);'
      : 'font-size:12px;background:var(--c-bg-alt,#f8f9fa);border:1px solid var(--c-border,#e2e8f0);border-radius:4px;padding:8px;max-height:100px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;margin-bottom:12px;line-height:1.5;';

    const lossLegend = isSecondary && showMerged
      ? `<div style="font-size:11px;color:var(--c-danger,#ef4444);margin-bottom:10px;">Items in red will be permanently lost.</div>`
      : '';

    return `
      <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${isSecondary ? 'var(--c-danger,#ef4444)' : 'var(--c-ok,#22c55e)'};margin-bottom:6px;">${esc(label)}</div>
      ${lossLegend}
      ${titleHtml}
      <div style="font-size:11px;color:var(--c-muted);margin-bottom:4px;font-weight:500;">Content${isSecondary ? ' (same as target)' : ' preview'}</div>
      <div style="${contentStyle}">${esc(note.content_preview || '—')}${note.content_preview?.length >= 100 ? '<span style="color:var(--c-muted)">…</span>' : ''}</div>
      ${row('Customer', esc(customer))}
      ${row('Owner',    ownerHtml)}
      ${row('Tags',     tagsHtml)}
      ${row('Links',    linksHtml)}
      ${row('Source',   sourceHtml)}
      ${row('State',    esc(note.state))}
      ${row('Created',  esc(note.created_at ? note.created_at.slice(0, 10) : '—'))}
    `;
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
    const groups = _selectedGroups.size > 0 ? [..._selectedGroups] : _scanData.groups;
    const notesToDelete = groups.reduce((n, g) => n + g.secondaries.length, 0);
    const label = _selectedGroups.size > 0
      ? `Merge ${groups.length} selected group(s) and permanently delete ${notesToDelete} note(s)?`
      : `This will merge ${groups.length} group(s) and permanently delete ${notesToDelete} note(s).`;

    showConfirm(
      `${label}\n\nThis cannot be undone. Continue?`,
      { confirmText: 'Merge & delete', danger: true }
    ).then((confirmed) => {
      if (!confirmed) return;
      runMerge(groups);
    });
  }

  function runSingleGroupMerge(group, groupNum) {
    showConfirm(
      `Merge group ${groupNum}?\n\nThis will consolidate metadata from ${group.secondaries.length} duplicate(s) into "${group.target.title || 'untitled'}" and permanently delete them.\n\nThis cannot be undone.`,
      { confirmText: 'Merge this group', danger: true }
    ).then((confirmed) => {
      if (!confirmed) return;
      runMerge([group]);
    });
  }

  function runMerge(groups) {
    _lastMergedGroups = groups ?? _scanData.groups;
    if (_logAppender) _logAppender.reset();

    nmGo('running');
    setProgress('nm-run', 'Starting…', 0);

    _runCtrl = subscribeSSE('/api/notes-merge/run', { groups: _lastMergedGroups }, {
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
        // Show "Back to preview" only when a partial preview exists to return to
        const canGoBack = _scanData && _lastMergedGroups.length < (_scanData.groups.length + _lastMergedGroups.length);
        if (canGoBack) nmShow('nm-back-to-preview-error');
        else           nmHide('nm-back-to-preview-error');
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

  function backToPreview() {
    if (!_scanData) return;

    // Remove merged groups from state and DOM
    for (const group of _lastMergedGroups) {
      _scanData.groups = _scanData.groups.filter(g => g !== group);
      _selectedGroups.delete(group);
      const cardEl = _groupCardEls.get(group);
      if (cardEl) cardEl.remove();
      _groupCardEls.delete(group);
      if (_splitGroup === group) closeCompareModal();
    }

    // Re-number remaining group headers
    nm$('nm-groups-list')?.querySelectorAll('details[data-gi]').forEach((el, i) => {
      el.dataset.gi = i;
      // groupLabel is the 2nd child of summary (after checkbox)
      const summaryChildren = el.querySelector('summary')?.children;
      if (summaryChildren?.[1]) summaryChildren[1].textContent = `Group ${i + 1}`;
    });

    // Update summary line
    const remaining = _scanData.groups.length;
    const remainingToDelete = _scanData.groups.reduce((n, g) => n + g.secondaries.length, 0);
    const summaryEl = nm$('nm-preview-summary-text');
    if (summaryEl) summaryEl.textContent = remaining === 0
      ? 'All groups merged.'
      : `${remaining} group(s) remaining · ${remainingToDelete} note(s) to delete.`;

    updateSelectionUI();

    if (remaining === 0) {
      nmHide('nm-groups-wrap');
      nmShow('nm-no-duplicates');
    }

    _lastMergedGroups = [];
    nmGo('preview');
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

    // Show "Back to preview" only when there's a partial preview to return to
    const canGoBack = _scanData && _lastMergedGroups.length < (_scanData.groups.length + _lastMergedGroups.length);
    if (canGoBack) nmShow('nm-back-to-preview');
    else           nmHide('nm-back-to-preview');
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

    // Cap date pickers at today
    const today = new Date().toISOString().slice(0, 10);
    const fromInput = nm$('nm-date-from');
    const toInput   = nm$('nm-date-to');
    if (fromInput) fromInput.max = today;
    if (toInput)   toInput.max   = today;

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
    nm$('nm-rescan-btn')?.addEventListener('click', () => { _scanData = null; nmGo('idle'); });
    nm$('nm-no-dup-rescan')?.addEventListener('click', () => { _scanData = null; nmGo('idle'); });

    // Collapse / expand all groups
    nm$('nm-toggle-all-groups')?.addEventListener('click', () => {
      const listEl = nm$('nm-groups-list');
      if (!listEl) return;
      const blocks  = listEl.querySelectorAll('details');
      const anyOpen = [...blocks].some(d => d.open);
      blocks.forEach(d => { d.open = !anyOpen; });
      const btn = nm$('nm-toggle-all-groups');
      if (btn) btn.textContent = anyOpen ? 'Expand all' : 'Collapse all';
    });

    // Unselect all
    nm$('nm-unselect-all')?.addEventListener('click', () => {
      _selectedGroups.clear();
      nm$('nm-groups-list')?.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
      updateSelectionUI();
    });

    // Invert selection
    nm$('nm-invert-selection')?.addEventListener('click', () => {
      nm$('nm-groups-list')?.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.checked = !cb.checked;
        const group = [..._groupCardEls.entries()].find(([, el]) => el.contains(cb))?.[0];
        if (!group) return;
        if (cb.checked) _selectedGroups.add(group);
        else _selectedGroups.delete(group);
      });
      updateSelectionUI();
    });

    // Compare modal controls
    nm$('nm-cmp-group-select')?.addEventListener('change', (e) => {
      if (!_splitGroup) return;
      if (e.target.checked) _selectedGroups.add(_splitGroup);
      else _selectedGroups.delete(_splitGroup);
      // Sync the corresponding group card checkbox
      const cardEl = _groupCardEls.get(_splitGroup);
      if (cardEl) {
        const cb = cardEl.querySelector('input[type=checkbox]');
        if (cb) cb.checked = e.target.checked;
      }
      updateSelectionUI();
    });
    nm$('nm-split-preview-merge')?.addEventListener('change', () => { if (_splitGroup) renderSplitPanel(); });
    nm$('nm-cmp-prev-group')?.addEventListener('click', () => navigateGroup(-1));
    nm$('nm-cmp-next-group')?.addEventListener('click', () => navigateGroup(+1));
    nm$('nm-cmp-prev-sec')?.addEventListener('click',   () => navigateSec(-1));
    nm$('nm-cmp-next-sec')?.addEventListener('click',   () => navigateSec(+1));
    nm$('nm-cmp-close')?.addEventListener('click', closeCompareModal);
    nm$('nm-compare-overlay')?.addEventListener('click', (e) => {
      if (e.target === nm$('nm-compare-overlay')) closeCompareModal();
    });

    // Keyboard: ← → navigate secondaries; Shift+← Shift+→ navigate groups; Escape closes
    document.addEventListener('keydown', (e) => {
      if (nm$('nm-compare-overlay')?.classList.contains('hidden')) return;
      if (e.key === 'Escape')     { closeCompareModal(); }
      else if (e.key === 'ArrowLeft'  && e.shiftKey) { e.preventDefault(); navigateGroup(-1); }
      else if (e.key === 'ArrowRight' && e.shiftKey) { e.preventDefault(); navigateGroup(+1); }
      else if (e.key === 'ArrowLeft')                { e.preventDefault(); navigateSec(-1);   }
      else if (e.key === 'ArrowRight')               { e.preventDefault(); navigateSec(+1);   }
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
    nm$('nm-back-to-preview')?.addEventListener('click', backToPreview);
    nm$('nm-start-over')?.addEventListener('click', resetNotesMerge);

    // Error
    nm$('nm-back-to-preview-error')?.addEventListener('click', backToPreview);
    nm$('nm-error-retry')?.addEventListener('click', resetNotesMerge);
    nm$('nm-error-download-log')?.addEventListener('click', () => {
      if (_logAppender) downloadLogCsv(_logAppender, 'notes-merge');
    });

    // Token disconnect — reset everything
    window.addEventListener('pb:disconnect', resetNotesMerge);
  }

  window.initNotesMergeModule = initNotesMergeModule;
})();
