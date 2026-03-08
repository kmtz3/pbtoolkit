// ══════════════════════════════════════════════════════════════════════════════
// Member Activity Export module
// Depends on: app.js globals — $(), show(), hide(), setText(), buildHeaders(),
//             subscribeSSE(), requireToken(), triggerDownload()
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  // Module state
  let maLastCsv      = null;
  let maLastFilename = 'member-activity.csv';
  let maCacheReady   = false;
  let maCacheLoading = false;

  // Stored team data (id → name) for reading checked state
  let maTeamData = []; // [{ id, name }, ...]

  // ── Helpers ────────────────────────────────────────────────────────────────

  function maShow(id)           { show(id); }
  function maHide(id)           { hide(id); }
  function maText(id, t)        { setText(id, t); }
  function ma$(id)              { return $(id); }

  // ── Date preset logic ──────────────────────────────────────────────────────

  function getDateRange() {
    const preset = ma$('ma-date-preset').value;
    const now    = new Date();
    const today  = now.toISOString().slice(0, 10);

    function daysAgo(n) {
      const d = new Date(now);
      d.setDate(d.getDate() - n);
      return d.toISOString().slice(0, 10);
    }

    switch (preset) {
      case 'last7':   return { dateFrom: daysAgo(7),  dateTo: today };
      case 'last30':  return { dateFrom: daysAgo(30), dateTo: today };
      case 'last90':  return { dateFrom: daysAgo(90), dateTo: today };
      case 'thisMonth': {
        const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
        return { dateFrom: from, dateTo: today };
      }
      case 'lastMonth': {
        const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const last  = new Date(now.getFullYear(), now.getMonth(), 0);
        return {
          dateFrom: first.toISOString().slice(0, 10),
          dateTo:   last.toISOString().slice(0, 10),
        };
      }
      case 'custom':
        return {
          dateFrom: ma$('ma-date-from').value,
          dateTo:   ma$('ma-date-to').value,
        };
      default:
        return { dateFrom: daysAgo(30), dateTo: today };
    }
  }

  function updateCustomDateVisibility() {
    const isCustom = ma$('ma-date-preset').value === 'custom';
    ma$('ma-custom-dates').classList.toggle('hidden', !isCustom);
  }

  // ── Team checkbox list ─────────────────────────────────────────────────────

  function renderTeamList(teams) {
    maTeamData = teams;
    const container = ma$('ma-team-list');
    container.innerHTML = '';

    for (const team of teams) {
      const label = document.createElement('label');
      const cb    = document.createElement('input');
      cb.type    = 'checkbox';
      cb.value   = team.id;
      cb.checked = true;
      cb.dataset.teamName = team.name;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' ' + team.name));
      container.appendChild(label);
    }
  }

  function wireTeamSearch() {
    const searchInput = ma$('ma-team-search');
    if (!searchInput) return;
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase();
      const labels = ma$('ma-team-list').querySelectorAll('label');
      labels.forEach((lbl) => {
        const name = lbl.textContent.toLowerCase();
        lbl.style.display = name.includes(q) ? '' : 'none';
      });
    });
  }

  function getSelectedTeamIds() {
    const checkboxes = ma$('ma-team-list').querySelectorAll('input[type="checkbox"]');
    return [...checkboxes].filter((cb) => cb.checked).map((cb) => cb.value);
  }

  function getSelectedRoles() {
    return ['admin', 'maker', 'viewer', 'contributor'].filter(
      (role) => ma$(`ma-role-${role}`) && ma$(`ma-role-${role}`).checked
    );
  }

  // ── Metadata / cache init ──────────────────────────────────────────────────

  function loadMaMetadata(refresh = false) {
    if (maCacheLoading) return;
    maCacheLoading = true;
    maCacheReady   = false;

    // Show loading state in team section
    ma$('ma-team-list').innerHTML = '<span class="text-muted" style="padding:8px 12px;display:block;font-size:12px;">Loading teams…</span>';
    maHide('ma-team-error');
    maHide('ma-obfuscated-warn');
    ma$('btn-ma-export').disabled = true;

    const url = '/api/member-activity/metadata' + (refresh ? '?refresh=true' : '');
    fetch(url, { headers: buildHeaders() })
      .then((res) => res.json().then((data) => ({ ok: res.ok, status: res.status, data })))
      .then(({ ok, status, data }) => {
        maCacheLoading = false;
        if (!ok) {
          showMaTeamError(data.error || `Failed to load workspace data (${status}).`);
          return;
        }
        renderTeamList(data.teams || []);
        if (data.obfuscated) {
          maShow('ma-obfuscated-warn');
        }
        maText('ma-member-count', data.memberCount ? `${data.memberCount} members loaded` : '');
        maCacheReady = true;
        ma$('btn-ma-export').disabled = false;
      })
      .catch((err) => {
        maCacheLoading = false;
        showMaTeamError(err.message || 'Network error loading workspace data.');
      });
  }

  function showMaTeamError(msg) {
    maText('ma-team-error-msg', msg);
    maShow('ma-team-error');
    ma$('ma-team-list').innerHTML = '';
    ma$('btn-ma-export').disabled = true;
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  function resetMaExport() {
    maShow('ma-idle');
    maHide('ma-running');
    maHide('ma-done');
    maHide('ma-error');
    maHide('ma-zero-activity-alert');
  }

  function startMaExport() {
    const { dateFrom, dateTo } = getDateRange();

    if (!dateFrom || !dateTo) {
      alert('Please select a valid date range.');
      return;
    }
    if (dateFrom > dateTo) {
      alert('Start date must not be after end date.');
      return;
    }

    const roles          = getSelectedRoles();
    const teamIds        = getSelectedTeamIds();
    const activeFilter   = document.querySelector('input[name="ma-active-filter"]:checked')?.value ?? 'all';
    const includeZero    = ma$('ma-include-zero').checked;
    const rawMode        = ma$('ma-raw-mode').checked;

    // Switch to running state
    maHide('ma-idle');
    maShow('ma-running');
    maHide('ma-done');
    maHide('ma-error');
    setMaProgress('Starting export…', 0);

    subscribeSSE('/api/member-activity/export', {
      dateFrom, dateTo, roles, teamIds, activeFilter,
      includeZeroActivity: includeZero,
      rawMode,
    }, {
      onProgress({ message, percent }) {
        setMaProgress(message, percent);
      },
      onComplete(data) {
        maLastCsv      = data.csv;
        maLastFilename = data.filename || 'member-activity.csv';

        maHide('ma-running');
        maShow('ma-done');
        maText('ma-done-msg', `Exported ${data.count.toLocaleString()} rows. Ready to download.`);

        if (data.zeroActivityPaidCount > 0) {
          maText(
            'ma-zero-activity-msg',
            `You have ${data.zeroActivityPaidCount} member${data.zeroActivityPaidCount === 1 ? '' : 's'} with 0 activity on maker/admin seats. Consider reviewing their license allocation or providing enablement support.`
          );
          maShow('ma-zero-activity-alert');
        } else {
          maHide('ma-zero-activity-alert');
        }
      },
      onError(msg) {
        maHide('ma-running');
        maText('ma-error-msg', msg || 'Export failed. Please try again.');
        maShow('ma-error');
      },
      onLog(data) {
        if (data.level === 'warn') {
          setMaProgress(data.message, null);
        }
      },
    });
  }

  function setMaProgress(msg, pct) {
    maText('ma-progress-msg', msg || '');
    if (pct !== null && pct !== undefined) {
      maText('ma-progress-pct', `${Math.round(pct)}%`);
      ma$('ma-progress-bar').style.width = `${Math.min(100, Math.round(pct))}%`;
    }
  }

  // ── Public init (called from app.js loadTool) ──────────────────────────────

  function initMemberActivityModule() {
    // Only wire up listeners once
    if (ma$('btn-ma-export').__maInit) return;
    ma$('btn-ma-export').__maInit = true;

    // Date preset
    ma$('ma-date-preset').addEventListener('change', updateCustomDateVisibility);
    updateCustomDateVisibility();

    // Team search
    wireTeamSearch();

    // Buttons
    ma$('btn-ma-export').addEventListener('click', () => requireToken(startMaExport));
    ma$('btn-ma-export-again').addEventListener('click', resetMaExport);
    ma$('btn-ma-export-retry').addEventListener('click', () => requireToken(startMaExport));
    ma$('btn-ma-refresh').addEventListener('click', () => loadMaMetadata(true));
    ma$('btn-ma-download').addEventListener('click', () => {
      if (!maLastCsv) return;
      triggerDownload(
        new Blob([maLastCsv], { type: 'text/csv;charset=utf-8;' }),
        maLastFilename
      );
    });

    // Load metadata (cache init)
    loadMaMetadata(false);
  }

  // Expose to global scope for app.js
  window.initMemberActivityModule = initMemberActivityModule;
})();
