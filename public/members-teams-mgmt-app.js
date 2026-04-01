/* =========================================================
   PBToolkit — Members & Teams Management module
   ========================================================= */
(function () {
  'use strict';

  // ── Scoped helpers ──────────────────────────────────────
  function mt$(id)             { return document.getElementById(id); }
  function mtShow(id)          { const el = mt$(id); if (el) el.classList.remove('hidden'); }
  function mtHide(id)          { const el = mt$(id); if (el) el.classList.add('hidden'); }
  function mtSetText(id, text) { const el = mt$(id); if (el) el.textContent = text; }

  // ── Module state ────────────────────────────────────────
  let _teams      = [];   // { id, name, handle, description, members[] }
  let _allMembers = [];   // all workspace members for add-member search
  let _addTeamId  = null; // team ID for the add-member modal
  let _dragData   = null; // { memberId, fromTeamId }

  // ── API helpers (reuse global buildHeaders from app.js) ─

  // ── Load teams + members ────────────────────────────────
  async function loadTeams() {
    mtHide('mtm-error');
    mtHide('mtm-empty');
    mtShow('mtm-loading');
    mt$('mtm-progress-bar').style.width = '30%';
    mtSetText('mtm-loading-msg', 'Loading teams and members...');

    try {
      const res = await fetch('/api/members-teams-mgmt/load', { headers: buildHeaders() });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `Request failed (${res.status})`);
      }

      mt$('mtm-progress-bar').style.width = '100%';
      const data = await res.json();
      _teams      = data.teams;
      _allMembers = data.allMembers;

      mtHide('mtm-loading');
      renderTeams();
    } catch (err) {
      mtHide('mtm-loading');
      mtSetText('mtm-error-msg', err.message);
      mtShow('mtm-error');
    }
  }

  // ── Render team cards ───────────────────────────────────
  function renderTeams(filter = '') {
    const container = mt$('mtm-team-list');
    container.innerHTML = '';

    const q = filter.toLowerCase().trim();
    const filtered = _teams.filter((team) => {
      if (!q) return true;
      if (team.name.toLowerCase().includes(q)) return true;
      if (team.handle.toLowerCase().includes(q)) return true;
      return team.members.some((m) => m.email.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
    });

    // Update count label
    const countEl = mt$('mtm-team-count');
    if (_teams.length === 0) {
      countEl.textContent = '';
    } else if (q) {
      countEl.textContent = `Showing ${filtered.length} of ${_teams.length} team${_teams.length !== 1 ? 's' : ''}`;
    } else {
      countEl.textContent = `${_teams.length} team${_teams.length !== 1 ? 's' : ''}`;
    }

    if (filtered.length === 0) {
      mtShow('mtm-empty');
      return;
    }
    mtHide('mtm-empty');

    for (const team of filtered) {
      container.appendChild(buildTeamCard(team, q));
    }
  }

  function buildTeamCard(team, filter) {
    const card = document.createElement('div');
    card.className = 'mtm-team-card';
    card.dataset.teamId = team.id;

    // Drop zone: allow dropping members onto this card
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = e.shiftKey ? 'copy' : 'move';
      card.classList.add('mtm-drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('mtm-drop-target'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('mtm-drop-target');
      handleDrop(team.id, e.shiftKey);
    });

    // Header section: editable name, handle, description
    const header = document.createElement('div');
    header.className = 'mtm-card-header';

    header.innerHTML = `
      <div class="mtm-card-title-row">
        <span class="mtm-card-name" data-field="name" data-team-id="${team.id}" title="Click to edit name">${esc(team.name)}</span>
        <span class="mtm-card-handle" data-field="handle" data-team-id="${team.id}" title="Click to edit handle">${esc(team.handle ? '@' + team.handle : '')}</span>
        <span class="mtm-card-count badge badge-muted">${team.members.length}</span>
      </div>
      <div class="mtm-card-desc" data-field="description" data-team-id="${team.id}" title="Click to edit description">${esc(team.description || 'No description')}</div>
    `;
    card.appendChild(header);

    // Wire inline editing for name, handle, description
    header.querySelectorAll('[data-field]').forEach((el) => {
      el.addEventListener('click', () => startInlineEdit(el, team));
    });

    // Members list
    const memberList = document.createElement('div');
    memberList.className = 'mtm-member-list';

    const q = filter;
    for (const m of team.members) {
      const highlighted = q && (m.email.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
      memberList.appendChild(buildMemberRow(m, team.id, highlighted));
    }

    card.appendChild(memberList);

    // Footer: add member + delete team
    const footer = document.createElement('div');
    footer.className = 'mtm-card-footer';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm mtm-btn-add';
    addBtn.textContent = '+ Add member';
    addBtn.addEventListener('click', () => openAddModal(team.id));
    footer.appendChild(addBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm mtm-btn-delete';
    delBtn.textContent = '🗑 Delete team';
    delBtn.addEventListener('click', () => openDeleteModal(team));
    footer.appendChild(delBtn);
    card.appendChild(footer);

    return card;
  }

  function buildMemberRow(member, teamId, highlighted) {
    const row = document.createElement('div');
    row.className = 'mtm-member-row' + (highlighted ? ' mtm-highlight' : '');
    row.draggable = true;
    row.dataset.memberId = member.id;
    row.dataset.teamId = teamId;

    // Prevent Shift+click from triggering text selection (which blocks drag)
    row.addEventListener('mousedown', (e) => { if (e.shiftKey) e.preventDefault(); });
    row.addEventListener('dragstart', (e) => {
      _dragData = { memberId: member.id, fromTeamId: teamId };
      e.dataTransfer.effectAllowed = 'copyMove';
      row.classList.add('mtm-dragging');
    });
    row.addEventListener('dragend', () => {
      _dragData = null;
      row.classList.remove('mtm-dragging');
      document.querySelectorAll('.mtm-drop-target').forEach((el) => el.classList.remove('mtm-drop-target'));
    });

    const infoSpan = document.createElement('span');
    infoSpan.className = 'mtm-member-info';
    infoSpan.title = member.email;
    if (member.name && member.name !== '[unknown]') {
      infoSpan.innerHTML = `<strong class="mtm-member-name">${esc(member.name)}</strong> <span class="mtm-member-email">(${esc(member.email)})</span>`;
    } else {
      infoSpan.textContent = member.email;
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'mtm-member-remove';
    removeBtn.title = 'Remove from team';
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', () => removeMember(teamId, member));

    row.appendChild(infoSpan);
    row.appendChild(removeBtn);
    return row;
  }

  // ── Inline editing ──────────────────────────────────────
  function startInlineEdit(el, team) {
    if (el.querySelector('input') || el.querySelector('textarea')) return; // already editing

    const field = el.dataset.field;
    const isDesc = field === 'description';
    const currentValue = field === 'handle'
      ? team.handle
      : isDesc
        ? team.description
        : team.name;

    let inputEl;
    if (isDesc) {
      inputEl = document.createElement('textarea');
      inputEl.className = 'mtm-inline-textarea';
      inputEl.rows = 3;
    } else {
      inputEl = document.createElement('input');
      inputEl.type = 'text';
      inputEl.className = 'mtm-inline-input';
    }
    inputEl.value = currentValue;

    el.textContent = '';
    el.appendChild(inputEl);
    inputEl.focus();
    inputEl.select();

    function commit() {
      const newValue = inputEl.value.trim();
      cleanup();

      if (newValue === currentValue) {
        restoreDisplay();
        return;
      }
      if (field === 'name' && !newValue) {
        restoreDisplay();
        return; // name cannot be empty
      }

      // Optimistic update
      team[field] = newValue;
      restoreDisplay();
      saveTeamField(team.id, field, newValue).catch(() => {
        // Revert on failure
        team[field] = currentValue;
        restoreDisplay();
      });
    }

    function restoreDisplay() {
      if (field === 'handle') {
        el.textContent = team.handle ? '@' + team.handle : '';
      } else if (isDesc) {
        el.textContent = team.description || 'No description';
      } else {
        el.textContent = team.name;
      }
    }

    function cleanup() {
      inputEl.removeEventListener('blur', commit);
      inputEl.removeEventListener('keydown', onKey);
    }

    function onKey(e) {
      // For textarea: Enter inserts newline, Ctrl/Cmd+Enter commits
      if (isDesc) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); inputEl.blur(); }
      } else {
        if (e.key === 'Enter') { e.preventDefault(); inputEl.blur(); }
      }
      if (e.key === 'Escape') { cleanup(); team[field] = currentValue; restoreDisplay(); }
    }

    inputEl.addEventListener('blur', commit);
    inputEl.addEventListener('keydown', onKey);
  }

  async function saveTeamField(teamId, field, value) {
    const body = {};
    body[field] = value;
    const res = await fetch(`/api/members-teams-mgmt/team/${teamId}`, {
      method: 'PATCH',
      headers: buildHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Update failed');
    }
  }

  // ── Remove member ───────────────────────────────────────
  async function removeMember(teamId, member) {
    const team = _teams.find((t) => t.id === teamId);
    const memberLabel = member.name && member.name !== '[unknown]'
      ? `<strong>${esc(member.name)}</strong> <em>(${esc(member.email)})</em>`
      : `<strong>${esc(member.email)}</strong>`;
    const teamLabel = `<span class="badge badge-muted">${esc(team?.name ?? teamId)}</span>`;
    const ok = await showConfirm(`Remove ${memberLabel} from the ${teamLabel} team?`, { okLabel: 'Remove', icon: '👤', html: true });
    if (!ok) return;

    try {
      const res = await fetch(`/api/members-teams-mgmt/team/${teamId}/remove-member`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ memberId: member.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Remove failed');
      }

      // Update local state
      const team = _teams.find((t) => t.id === teamId);
      if (team) team.members = team.members.filter((m) => m.id !== member.id);
      renderTeams(mt$('mtm-search').value);
    } catch (err) {
      showAlert('Failed to remove member: ' + err.message, { icon: '⚠️' });
    }
  }

  // ── Drag-and-drop move / copy ────────────────────────────
  // Default drag = move (remove from source, add to target).
  // Hold Shift while dropping = copy (add to target, keep in source).
  async function handleDrop(toTeamId, copyMode = false) {
    if (!_dragData) return;
    const { memberId, fromTeamId } = _dragData;
    _dragData = null;

    if (fromTeamId === toTeamId) return;

    try {
      if (copyMode) {
        // Copy: just add to the target team (keep source membership)
        const res = await fetch(`/api/members-teams-mgmt/team/${toTeamId}/add-member`, {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify({ memberId }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Copy failed');
        }

        const dstTeam = _teams.find((t) => t.id === toTeamId);
        const srcTeam = _teams.find((t) => t.id === fromTeamId);
        if (dstTeam && !dstTeam.members.some((m) => m.id === memberId)) {
          const memberObj = srcTeam?.members.find((m) => m.id === memberId);
          if (memberObj) {
            dstTeam.members.push({ ...memberObj });
            dstTeam.members.sort((a, b) => a.email.localeCompare(b.email));
          }
        }
      } else {
        // Move: remove from source, add to target
        const res = await fetch('/api/members-teams-mgmt/move-member', {
          method: 'POST',
          headers: buildHeaders(),
          body: JSON.stringify({ memberId, fromTeamId, toTeamId }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Move failed');
        }

        const srcTeam = _teams.find((t) => t.id === fromTeamId);
        const dstTeam = _teams.find((t) => t.id === toTeamId);
        if (srcTeam && dstTeam) {
          const memberObj = srcTeam.members.find((m) => m.id === memberId);
          if (memberObj) {
            srcTeam.members = srcTeam.members.filter((m) => m.id !== memberId);
            if (!dstTeam.members.some((m) => m.id === memberId)) {
              dstTeam.members.push(memberObj);
              dstTeam.members.sort((a, b) => a.email.localeCompare(b.email));
            }
          }
        }
      }
      renderTeams(mt$('mtm-search').value);
    } catch (err) {
      alert(`Failed to ${copyMode ? 'copy' : 'move'} member: ` + err.message);
    }
  }

  // ── Add member modal ────────────────────────────────────
  const ROLE_ORDER = ['admin', 'maker', 'contributor', 'viewer'];
  const ROLE_LABELS = { admin: 'Admin', maker: 'Maker', contributor: 'Contributor', viewer: 'Viewer' };

  function openAddModal(teamId) {
    _addTeamId = teamId;
    const team = _teams.find((t) => t.id === teamId);
    mtSetText('mtm-add-modal-team-name', team?.name ?? teamId);
    mt$('mtm-add-search').value = '';
    renderAddResults('');
    mtShow('mtm-add-modal');
    mt$('mtm-add-search').focus();
  }

  function closeAddModal() {
    mtHide('mtm-add-modal');
    _addTeamId = null;
  }

  function renderAddResults(query) {
    const container = mt$('mtm-add-results');
    container.innerHTML = '';

    const q = query.toLowerCase().trim();
    const team = _teams.find((t) => t.id === _addTeamId);
    const existingIds = new Set((team?.members ?? []).map((m) => m.id));
    const unassignedOnly = mt$('mtm-add-unassigned-only')?.checked;

    // Build set of all members assigned to any team
    let assignedIds;
    if (unassignedOnly) {
      assignedIds = new Set();
      for (const t of _teams) {
        for (const m of t.members) assignedIds.add(m.id);
      }
    }

    const available = _allMembers.filter((m) => {
      if (existingIds.has(m.id)) return false;
      if (unassignedOnly && assignedIds.has(m.id)) return false;
      if (!q) return true;
      return m.email.toLowerCase().includes(q) || m.name.toLowerCase().includes(q);
    });

    if (available.length === 0) {
      container.innerHTML = `<div class="text-sm text-muted" style="padding:8px">${q ? 'No matching members found.' : 'All members are already on this team.'}</div>`;
      return;
    }

    // Group by role
    const grouped = {};
    for (const m of available) {
      const role = m.role || 'viewer';
      if (!grouped[role]) grouped[role] = [];
      grouped[role].push(m);
    }

    function buildRoleSection(roleKey, label, members) {
      const section = document.createElement('div');
      section.className = 'mtm-add-role-section';

      const header = document.createElement('div');
      header.className = 'mtm-add-role-header';
      header.innerHTML = `<span class="mtm-add-chevron">▾</span><span class="badge badge-muted">${esc(label)}</span><span class="text-muted text-sm">${members.length}</span>`;

      const body = document.createElement('div');
      body.className = 'mtm-add-role-body';

      header.addEventListener('click', () => {
        const collapsed = body.classList.toggle('hidden');
        header.querySelector('.mtm-add-chevron').textContent = collapsed ? '▸' : '▾';
      });

      for (const m of members) {
        const row = document.createElement('div');
        row.className = 'mtm-add-result-row';
        const hasName = m.name && m.name !== '[unknown]';
        row.innerHTML = hasName
          ? `<span class="mtm-add-name">${esc(m.name)}</span><span class="mtm-add-sep">·</span><span class="mtm-add-email text-muted">${esc(m.email)}</span>`
          : `<span class="mtm-add-email">${esc(m.email)}</span>`;
        row.addEventListener('click', () => addMemberToTeam(m));
        body.appendChild(row);
      }

      section.appendChild(header);
      section.appendChild(body);
      return section;
    }

    for (const role of ROLE_ORDER) {
      const members = grouped[role];
      if (!members || members.length === 0) continue;
      container.appendChild(buildRoleSection(role, ROLE_LABELS[role] || role, members));
    }

    // Members with roles not in ROLE_ORDER (unlikely but safe)
    for (const [role, members] of Object.entries(grouped)) {
      if (ROLE_ORDER.includes(role)) continue;
      container.appendChild(buildRoleSection(role, role, members));
    }
  }

  async function addMemberToTeam(member) {
    if (!_addTeamId) return;

    try {
      const res = await fetch(`/api/members-teams-mgmt/team/${_addTeamId}/add-member`, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ memberId: member.id }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Add failed');
      }

      // Update local state
      const team = _teams.find((t) => t.id === _addTeamId);
      if (team && !team.members.some((m) => m.id === member.id)) {
        team.members.push(member);
        team.members.sort((a, b) => a.email.localeCompare(b.email));
      }

      closeAddModal();
      renderTeams(mt$('mtm-search').value);
    } catch (err) {
      alert('Failed to add member: ' + err.message);
    }
  }

  // ── Delete team ─────────────────────────────────────────
  let _deleteTeamId = null;

  function openDeleteModal(team) {
    _deleteTeamId = team.id;
    mtSetText('mtm-delete-team-name', team.name);
    mt$('mtm-delete-confirm-input').value = '';
    mt$('btn-mtm-delete-confirm').disabled = true;
    mtShow('mtm-delete-modal');
    mt$('mtm-delete-confirm-input').focus();
  }

  function closeDeleteModal() {
    mtHide('mtm-delete-modal');
    _deleteTeamId = null;
  }

  async function confirmDeleteTeam() {
    if (!_deleteTeamId) return;
    if (mt$('mtm-delete-confirm-input').value.trim() !== 'DELETE') return;

    mt$('btn-mtm-delete-confirm').disabled = true;

    try {
      const res = await fetch(`/api/members-teams-mgmt/team/${_deleteTeamId}`, {
        method: 'DELETE',
        headers: buildHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Delete failed');
      }

      _teams = _teams.filter((t) => t.id !== _deleteTeamId);
      closeDeleteModal();
      renderTeams(mt$('mtm-search').value);
    } catch (err) {
      alert('Failed to delete team: ' + err.message);
      mt$('btn-mtm-delete-confirm').disabled = false;
    }
  }

  // ── Create team modal ──────────────────────────────────
  function openCreateModal() {
    mt$('mtm-create-name').value = '';
    mt$('mtm-create-handle').value = '';
    mt$('mtm-create-desc').value = '';
    mtHide('mtm-create-error');
    mtShow('mtm-create-modal');
    mt$('mtm-create-name').focus();
  }

  function closeCreateModal() {
    mtHide('mtm-create-modal');
  }

  async function submitCreateTeam() {
    const name = mt$('mtm-create-name').value.trim();
    const handle = mt$('mtm-create-handle').value.trim();
    const description = mt$('mtm-create-desc').value.trim();

    if (!name) {
      mtSetText('mtm-create-error-msg', 'Team name is required.');
      mtShow('mtm-create-error');
      return;
    }

    mtHide('mtm-create-error');
    mt$('btn-mtm-create-submit').disabled = true;

    try {
      const res = await fetch('/api/members-teams-mgmt/team', {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify({ name, handle, description }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Create failed');
      }

      const data = await res.json();

      // Add to local state and re-render
      _teams.push({
        id: data.id,
        name,
        handle: handle.toLowerCase().replace(/[^a-z0-9]/g, ''),
        description,
        members: [],
      });
      _teams.sort((a, b) => a.name.localeCompare(b.name));

      closeCreateModal();
      renderTeams(mt$('mtm-search').value);
    } catch (err) {
      mtSetText('mtm-create-error-msg', err.message);
      mtShow('mtm-create-error');
    } finally {
      mt$('btn-mtm-create-submit').disabled = false;
    }
  }

  // ── Disconnect handler ──────────────────────────────────
  function resetModuleOnDisconnect() {
    _teams = [];
    _allMembers = [];
    _addTeamId = null;
    _dragData = null;
    mt$('mtm-team-list').innerHTML = '';
    mt$('mtm-search').value = '';
    mtSetText('mtm-team-count', '');
    mtHide('mtm-loading');
    mtHide('mtm-error');
    mtHide('mtm-empty');
    closeAddModal();
    closeCreateModal();
    closeDeleteModal();
  }

  window.addEventListener('pb:disconnect', resetModuleOnDisconnect);

  window.addEventListener('pb:connected', () => {
    if (_initDone && _teams.length === 0 && token) loadTeams();
  });

  // ── Init ────────────────────────────────────────────────
  let _initDone = false;

  window.initMembersTeamsMgmtModule = function () {
    if (_initDone) return;
    _initDone = true;

    // Search/filter
    mt$('mtm-search').addEventListener('input', () => {
      renderTeams(mt$('mtm-search').value);
    });

    // Refresh button
    mt$('btn-mtm-refresh').addEventListener('click', () => requireToken(loadTeams));

    // Retry on error
    mt$('btn-mtm-retry').addEventListener('click', () => requireToken(loadTeams));

    // Create team
    mt$('btn-mtm-create').addEventListener('click', () => requireToken(openCreateModal));
    mt$('btn-mtm-create-modal-close').addEventListener('click', closeCreateModal);
    mt$('mtm-create-modal').addEventListener('click', (e) => {
      if (e.target === mt$('mtm-create-modal')) closeCreateModal();
    });
    mt$('btn-mtm-create-submit').addEventListener('click', submitCreateTeam);
    mt$('mtm-create-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitCreateTeam(); }
    });

    // Delete team modal
    mt$('btn-mtm-delete-modal-close').addEventListener('click', closeDeleteModal);
    mt$('mtm-delete-modal').addEventListener('click', (e) => {
      if (e.target === mt$('mtm-delete-modal')) closeDeleteModal();
    });
    mt$('mtm-delete-confirm-input').addEventListener('input', (e) => {
      mt$('btn-mtm-delete-confirm').disabled = e.target.value.trim() !== 'DELETE';
    });
    mt$('btn-mtm-delete-confirm').addEventListener('click', confirmDeleteTeam);
    mt$('mtm-delete-confirm-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmDeleteTeam(); }
    });

    // Add-member modal close
    mt$('btn-mtm-add-modal-close').addEventListener('click', closeAddModal);
    mt$('mtm-add-modal').addEventListener('click', (e) => {
      if (e.target === mt$('mtm-add-modal')) closeAddModal();
    });

    // Add-member search
    mt$('mtm-add-search').addEventListener('input', (e) => {
      renderAddResults(e.target.value);
    });
    mt$('mtm-add-unassigned-only').addEventListener('change', () => {
      renderAddResults(mt$('mtm-add-search').value);
    });

    // Auto-load if token is already present
    if (token) loadTeams();
  };

})();
