/* =========================================================
   PBToolkit — Users module (within Companies & Users tool)
   ========================================================= */

// ── Module state ────────────────────────────────────────────
let usersParsedCSV    = null; // { raw: string, headers: string[], rowCount: number }
let usersCustomFields = [];   // [{ id, name, type }]
const USERS_MAPPING_KEY = 'users-mapping';
let usersMappingChangeListenerAdded = false;
let usersLastExportCSV = null;
let usersLastExportFilename = 'users.csv';
let usersExportCtrl = null;
let usersImportController = null;
let usersClearImportDropzone = null;
let usersClearDeleteDropzone = null;
let usersDeleteParsedCSV = null;
let usersDeleteController = null;
let usersDeleteAllController = null;

function resetUsersState() {
  // Clear token-dependent state but preserve CSV file, mapping, and settings
  // so the user doesn't lose work when disconnecting and reconnecting.
  usersCustomFields = [];
  usersLastExportCSV = null;
  usersLastExportFilename = 'users.csv';
  resetUsersExport();
  // Hide validation/run results (stale without token) but keep map + options visible if CSV loaded
  ['users-import-step-validate', 'users-import-step-run', 'users-import-summary-box'].forEach((id) => {
    const el = $(id); if (el) el.classList.add('hidden');
  });
  // Abort any in-flight operations
  if (usersExportCtrl) { usersExportCtrl.abort(); usersExportCtrl = null; }
  if (usersImportController) { usersImportController.abort(); usersImportController = null; }
  if (usersDeleteController) { usersDeleteController.abort(); usersDeleteController = null; }
  if (usersDeleteAllController) { usersDeleteAllController.abort(); usersDeleteAllController = null; }
}

// ══════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════
function resetUsersExport() {
  show('users-export-idle');
  hide('users-export-running');
  hide('users-export-stopped');
  hide('users-export-done');
  hide('users-export-error');
}

function startUsersExport() {
  show('users-export-running');
  hide('users-export-idle');
  hide('users-export-stopped');
  hide('users-export-done');
  hide('users-export-error');
  setUsersExportProgress('Starting…', 0);

  usersExportCtrl = subscribeSSE('/api/users/export', {}, {
    onProgress: ({ message, percent }) => setUsersExportProgress(message, percent),
    onComplete: (data) => {
      hide('users-export-running');
      if (!data.csv && data.count === 0) {
        showUsersExportError('No users found in this workspace.');
        return;
      }
      usersLastExportCSV = data.csv;
      usersLastExportFilename = data.filename || 'users.csv';
      triggerDownload(new Blob([usersLastExportCSV], { type: 'text/csv;charset=utf-8;' }), usersLastExportFilename);
      show('users-export-done');
      setText('users-export-done-msg', `Exported ${data.count.toLocaleString()} users. Download started.`);
    },
    onError: (msg) => {
      hide('users-export-running');
      showUsersExportError(msg);
    },
    onAbort: () => {
      hide('users-export-running');
      show('users-export-stopped');
      usersExportCtrl = null;
    },
  });
}

function setUsersExportProgress(msg, pct) {
  setText('users-export-progress-msg', msg);
  setText('users-export-progress-pct', `${pct}%`);
  $('users-export-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

function showUsersExportError(msg) {
  setText('users-export-error-msg', msg);
  show('users-export-error');
}

// ══════════════════════════════════════════════════════════
// IMPORT — Step 1: Upload
// ══════════════════════════════════════════════════════════

function loadUsersCSVFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) {
      showAlert('CSV file appears empty or has no data rows.');
      return;
    }
    usersParsedCSV = { raw: text, headers: parseCSVHeaders(text), rowCount };
    showUsersMappingStep();
  };
  reader.readAsText(file);
}

// ══════════════════════════════════════════════════════════
// IMPORT — Step 2: Map columns
// ══════════════════════════════════════════════════════════
async function showUsersMappingStep() {
  hide('users-import-step-validate');
  hide('users-import-step-run');
  show('users-import-step-map');
  show('users-import-step-options');
  setText('users-map-subtitle', `${usersParsedCSV.rowCount} rows detected · ${usersParsedCSV.headers.length} columns`);

  buildUsersBaseMappingTable();
  await loadUsersCustomFieldTable();
}

function buildUsersColumnSelect(id, includeNone = true) {
  const options = includeNone
    ? '<option value="">(⇢ skip)</option>'
    : '<option value="">— select column —</option>';
  const colOptions = usersParsedCSV.headers
    .map((h) => `<option value="${esc(h)}">${esc(h)}</option>`)
    .join('');
  return `<select id="${id}">${options}${colOptions}</select>`;
}

function buildUsersBaseMappingTable() {
  const tbody = $('users-mapping-rows');
  tbody.innerHTML = '';

  const groupTr = document.createElement('tr');
  groupTr.className = 'mapping-group-row';
  groupTr.innerHTML = '<td colspan="3" class="mapping-group-label">Default fields</td>';
  tbody.appendChild(groupTr);

  const baseFields = [
    { id: 'users-map-pb-id',           label: 'pb_id',                   displayType: 'uuid',     required: false, hint: 'Present → update existing · empty → check email match → update or create new' },
    { id: 'users-map-name',            label: 'Name',                    displayType: 'Text',     required: false, hint: 'Required when creating a new user (no pb_id or email match)' },
    { id: 'users-map-email',           label: 'Email',                   displayType: 'Email',    required: false, hint: 'Used for PATCH matching when pb_id is not provided' },
    { id: 'users-map-desc',            label: 'Description',             displayType: 'RichText', required: false },
    { id: 'users-map-owner',           label: 'Owner',                   displayType: 'Member',   required: false, hint: 'Email of the workspace member who owns this user' },
    { id: 'users-map-archived',        label: 'Archived',                displayType: 'Boolean',  required: false, hint: 'true/false — only applied on PATCH (ignored on create)' },
  ];

  for (const f of baseFields) {
    const tr = document.createElement('tr');
    const reqBadge = f.required ? ' <span class="badge badge-danger">required</span>' : '';
    tr.innerHTML = `
      <td>
        ${f.label}${reqBadge}${f.hint ? ` <span class="info-icon" data-tip="${esc(f.hint)}">i</span>` : ''}
      </td>
      <td><span class="badge badge-muted">${f.displayType}</span></td>
      <td>${buildUsersColumnSelect(f.id, !f.required)}</td>
    `;
    tbody.appendChild(tr);
  }

  usersAutoDetectMappings();
  restoreUsersMapping();

  if (!usersMappingChangeListenerAdded) {
    $('users-mapping-rows').addEventListener('change', saveUsersMapping);
    usersMappingChangeListenerAdded = true;
  }
}

function usersAutoDetectMappings() {
  const hints = {
    'users-map-pb-id':         ['pb_id', 'id', 'uuid', 'user id', 'pb user id'],
    'users-map-name':          ['name', 'user name', 'user_name', 'full name'],
    'users-map-email':         ['email', 'e-mail', 'email_address'],
    'users-map-desc':          ['description', 'desc'],
    'users-map-owner':         ['owner', 'owner_email', 'owner email'],
    'users-map-archived':      ['archived', 'is_archived'],
    'users-map-parent-id':     ['parent_company_id', 'company_id', 'company id'],
    'users-map-parent-domain': ['parent_company_domain', 'company_domain', 'company domain'],
  };

  for (const [selectId, candidates] of Object.entries(hints)) {
    const sel = $(selectId);
    if (!sel) continue;
    for (const candidate of candidates) {
      const match = usersParsedCSV.headers.find((h) => h.toLowerCase() === candidate);
      if (match) { sel.value = match; break; }
    }
  }
}

async function loadUsersCustomFieldTable() {
  $('users-custom-fields-loading').textContent = 'Loading custom fields from Productboard…';
  show('users-custom-fields-loading');

  try {
    const res = await fetch('/api/users/fields', { headers: buildHeaders() });
    const data = await res.json();
    usersCustomFields = data.fields || [];

    hide('users-custom-fields-loading');

    if (usersCustomFields.length === 0) {
      $('users-custom-fields-loading').textContent = 'No custom fields found for user entities.';
      show('users-custom-fields-loading');
      buildUsersRelationshipFields();
      return;
    }
    buildUsersCustomFieldTable(usersCustomFields);
    buildUsersRelationshipFields();
    restoreUsersMapping();
  } catch (e) {
    $('users-custom-fields-loading').textContent = `Failed to load custom fields: ${e.message}`;
    show('users-custom-fields-loading');
  }
}

function buildUsersCustomFieldTable(fields) {
  const tbody = $('users-mapping-rows');

  const groupTr = document.createElement('tr');
  groupTr.className = 'mapping-group-row';
  groupTr.innerHTML = '<td colspan="3" class="mapping-group-label">Custom fields</td>';
  tbody.appendChild(groupTr);

  for (const field of fields) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(field.name)}</td>
      <td><span class="badge badge-muted">${esc(field.displayType || field.type)}</span></td>
      <td>${buildUsersColumnSelect(`users-cf-${field.id}`, true)}</td>
    `;
    tbody.appendChild(tr);

    const sel = $(`users-cf-${field.id}`);
    const uuidSuffix = `[${field.id}]`.toLowerCase();
    const match = usersParsedCSV.headers.find(
      (h) => h.toLowerCase().endsWith(uuidSuffix) || h.toLowerCase() === field.name.toLowerCase()
    );
    if (match) sel.value = match;
  }
}

function buildUsersRelationshipFields() {
  const tbody = $('users-mapping-rows');

  const groupTr = document.createElement('tr');
  groupTr.className = 'mapping-group-row';
  groupTr.innerHTML = '<td colspan="3" class="mapping-group-label">Relationships</td>';
  tbody.appendChild(groupTr);

  const relFields = [
    { id: 'users-map-parent-id',       label: 'Parent Company ID',       displayType: 'uuid',     required: false, hint: 'UUID of the parent company' },
    { id: 'users-map-parent-domain',   label: 'Parent Company Domain',   displayType: 'domain',   required: false, hint: 'Domain of the parent company (resolved to UUID)' },
  ];

  for (const f of relFields) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        ${f.label} <span class="info-icon" data-tip="${esc(f.hint)}">i</span>
      </td>
      <td><span class="badge badge-muted">${f.displayType}</span></td>
      <td>${buildUsersColumnSelect(f.id, true)}</td>
    `;
    tbody.appendChild(tr);
  }

  usersAutoDetectMappings();
  restoreUsersMapping();
}

// ══════════════════════════════════════════════════════════
// IMPORT — Step 3: Validate
// ══════════════════════════════════════════════════════════
async function runUsersValidation() {
  const mapping = buildUsersMapping();
  if (!validateUsersRequiredMappings(mapping)) return;

  show('users-import-step-validate');
  $('users-import-step-validate').scrollIntoView({ behavior: 'smooth', block: 'start' });
  hide('users-validate-ok');
  hide('users-validate-warnings');
  hide('users-validate-errors');
  setText('users-validate-ok-msg', '');
  $('users-validate-error-rows').innerHTML = '';
  $('users-validate-warning-rows').innerHTML = '';

  try {
    const res = await fetch('/api/users/import/preview', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ csvText: usersParsedCSV.raw, mapping, options: { skipInvalidOwner: $('users-imp-skip-invalid-owner')?.checked || false } }),
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `Server error (${res.status})`);
    }

    if (data.valid) {
      const summary = `All ${data.totalRows} rows passed validation. ${data.createCount} to create, ${data.updateCount} to update.`;
      setText('users-validate-ok-msg', summary);
      show('users-validate-ok');
    } else {
      setText('users-validate-error-summary', `${data.errors.length} error(s) found in ${data.totalRows} rows.`);
      const tbody = $('users-validate-error-rows');
      for (const err of data.errors) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${err.row ?? '—'}</td>
          <td><span class="col-tag">${esc(err.field || '')}</span></td>
          <td class="text-danger">${esc(err.message)}</td>
        `;
        tbody.appendChild(tr);
      }
      show('users-validate-errors');
    }

    // Show warnings (non-blocking)
    if (data.warnings && data.warnings.length > 0) {
      setText('users-validate-warning-summary', `${data.warnings.length} warning(s) — these won't block the import.`);
      const warnTbody = $('users-validate-warning-rows');
      for (const w of data.warnings) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${w.row ?? '—'}</td>
          <td><span class="col-tag">${esc(w.field || '')}</span></td>
          <td>${esc(w.message)}</td>
        `;
        warnTbody.appendChild(tr);
      }
      show('users-validate-warnings');
    }
  } catch (e) {
    setText('users-validate-error-summary', `Validation request failed: ${e.message}`);
    show('users-validate-errors');
  }
}

// ══════════════════════════════════════════════════════════
// IMPORT — Step 4: Run
// ══════════════════════════════════════════════════════════

const appendUsersLogEntry = makeLogAppender('users-import-live-log', 'users-live-log-entries', 'users-live-log-counts', 'user');

function runUsersImport() {
  const mapping = buildUsersMapping();
  if (!validateUsersRequiredMappings(mapping)) return;

  appendUsersLogEntry.reset();
  hide('btn-users-import-download-log');
  $('users-import-summary-box').innerHTML = '';
  hide('users-import-summary-box');
  hide('users-import-step-validate');
  show('users-import-step-run');
  $('users-import-step-run').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setText('users-import-run-title', 'Importing…');
  setUsersImportProgress('Starting…', 0);
  show('btn-users-stop-import');

  const msMode = document.querySelector('input[name="users-imp-ms-mode"]:checked');
  const options = {
    multiSelectMode:     msMode ? msMode.value : 'set',
    bypassEmptyCells:    $('users-imp-bypass-empty')?.checked        || false,
    bypassHtmlFormatter: $('users-imp-bypass-html')?.checked         || false,
    skipInvalidOwner:    $('users-imp-skip-invalid-owner')?.checked  || false,
  };

  usersImportController = subscribeSSE(
    '/api/users/import/run',
    { csvText: usersParsedCSV.raw, mapping, options },
    {
      onProgress: ({ message, percent }) => setUsersImportProgress(message, percent),
      onLog: (entry) => appendUsersLogEntry(entry),
      onComplete: (data) => {
        hide('btn-users-stop-import');
        setUsersImportProgress(data.stopped ? 'Import stopped' : 'Import complete', 100);
        setText('users-import-run-title', data.stopped ? 'Import stopped' : 'Import complete');
        renderImportComplete($('users-import-summary-box'), {
          created: data.created,
          updated: data.updated,
          errors:  data.errors,
          stopped: data.stopped,
          extraText: data.total ? `${data.total} rows` : '',
        });
        show('btn-users-import-download-log');
      },
      onError: (msg) => {
        hide('btn-users-stop-import');
        setText('users-import-run-title', 'Import failed');
        $('users-import-summary-box').innerHTML = `
          <div class="alert alert-danger">
            <span class="alert-icon">⚠️</span>
            <span>${esc(msg)}</span>
          </div>`;
        show('users-import-summary-box');
        appendUsersLogEntry({ level: 'error', message: msg, ts: new Date().toISOString() });
        show('btn-users-import-download-log');
      },
      onAbort: () => {
        hide('btn-users-stop-import');
        setText('users-import-run-title', 'Import stopped');
        setUsersImportProgress('Stopped by user', 100);
        show('btn-users-import-download-log');
        usersImportController = null;
      },
    }
  );
}

function setUsersImportProgress(msg, pct) {
  setText('users-import-progress-msg', msg);
  setText('users-import-progress-pct', `${pct}%`);
  $('users-import-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

// ── Mapping helpers ─────────────────────────────────────────
function buildUsersMapping() {
  return {
    pbIdColumn:                $('users-map-pb-id')?.value           || null,
    nameColumn:                $('users-map-name')?.value            || null,
    emailColumn:               $('users-map-email')?.value           || null,
    descColumn:                $('users-map-desc')?.value            || null,
    ownerColumn:               $('users-map-owner')?.value           || null,
    archivedColumn:            $('users-map-archived')?.value        || null,
    parentCompanyIdColumn:     $('users-map-parent-id')?.value       || null,
    parentCompanyDomainColumn: $('users-map-parent-domain')?.value   || null,

    customFields: usersCustomFields
      .map((f) => ({
        csvColumn: $(`users-cf-${f.id}`)?.value || '',
        fieldId:   f.id,
        fieldType: f.type,
      }))
      .filter((cf) => cf.csvColumn),
  };
}

function validateUsersRequiredMappings(mapping) {
  if (!mapping.pbIdColumn && !mapping.emailColumn && !mapping.nameColumn) {
    showAlert('Please map at least one identifying field (pb_id, email, or name) before continuing.');
    return false;
  }
  return true;
}

function saveUsersMapping() {
  try { localStorage.setItem(USERS_MAPPING_KEY, JSON.stringify(buildUsersMapping())); } catch (_) {}
}

function restoreUsersMapping() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(USERS_MAPPING_KEY)); } catch (_) { return; }
  if (!saved) return;

  const baseMap = {
    'users-map-pb-id':         saved.pbIdColumn,
    'users-map-name':          saved.nameColumn,
    'users-map-email':         saved.emailColumn,
    'users-map-desc':          saved.descColumn,
    'users-map-owner':         saved.ownerColumn,
    'users-map-archived':      saved.archivedColumn,
    'users-map-parent-id':     saved.parentCompanyIdColumn,
    'users-map-parent-domain': saved.parentCompanyDomainColumn,
  };
  for (const [id, value] of Object.entries(baseMap)) {
    const sel = $(id);
    if (sel && value && [...sel.options].some((o) => o.value === value)) sel.value = value;
  }

  if (saved.customFields) {
    for (const cf of saved.customFields) {
      const sel = $(`users-cf-${cf.fieldId}`);
      if (sel && cf.csvColumn && [...sel.options].some((o) => o.value === cf.csvColumn)) {
        sel.value = cf.csvColumn;
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
// USERS — Delete from CSV
// ══════════════════════════════════════════════════════════

const appendUsersDeleteLogEntry = makeLogAppender('users-delete-csv-live-log', 'users-delete-csv-log-entries', null, 'user');

function loadUsersDeleteCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const headers = parseCSVHeaders(text);
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) { showAlert('CSV appears empty.'); return; }
    usersDeleteParsedCSV = { raw: text, headers, rowCount };

    const sel = $('users-delete-uuid-column');
    sel.innerHTML = headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');

    const auto = headers.find((h) => ['pb_id', 'id', 'uuid'].includes(h.toLowerCase()));
    if (auto) sel.value = auto;

    setText('users-delete-csv-subtitle', `${usersDeleteParsedCSV.rowCount} rows · ${headers.length} columns`);
    updateUsersDeleteCSVPreview();
    show('users-delete-csv-step-confirm');
  };
  reader.readAsText(file);
}

function updateUsersDeleteCSVPreview() {
  const col = $('users-delete-uuid-column').value;
  if (!usersDeleteParsedCSV || !col) return;

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const headers = parseCSVHeaders(usersDeleteParsedCSV.raw);
  const colIdx = headers.indexOf(col);
  if (colIdx < 0) return;

  const lines = usersDeleteParsedCSV.raw.trim().split('\n').slice(1);
  const uuids = lines
    .map((l) => {
      const cols = l.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      return cols[colIdx]?.trim().replace(/^"|"$/g, '');
    })
    .filter((v) => UUID_PATTERN.test(v))
    .slice(0, 5);

  const preview = $('users-delete-csv-preview');
  if (uuids.length > 0) {
    preview.textContent = `First UUIDs: ${uuids.join(', ')}${lines.length > 5 ? ', …' : ''}`;
    show('users-delete-csv-preview');
  } else {
    preview.textContent = 'No valid UUIDs found in this column.';
    show('users-delete-csv-preview');
  }
}

function startUsersDeleteCSV(uuidColumn) {
  hide('users-delete-csv-step-confirm');
  show('users-delete-csv-step-run');
  setText('users-delete-csv-run-title', 'Deleting users…');
  show('users-delete-csv-running');
  hide('users-delete-csv-results');
  setUsersDeleteCSVProgress('Starting…', 0);

  appendUsersDeleteLogEntry.reset();
  hide('btn-users-delete-download-log');
  show('btn-stop-users-delete-csv');

  usersDeleteController = subscribeSSE(
    '/api/users/delete/by-csv',
    { csvText: usersDeleteParsedCSV.raw, uuidColumn },
    {
      onProgress: ({ message, percent }) => setUsersDeleteCSVProgress(message, percent),
      onLog: (entry) => appendUsersDeleteLogEntry(entry),
      onComplete: (data) => {
        hide('btn-stop-users-delete-csv');
        hide('users-delete-csv-running');
        show('users-delete-csv-results');
        setText('users-delete-csv-run-title', 'Deletion complete');
        const hasErrors = data.errors > 0;
        const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
        const icon = hasErrors ? '⚠️' : '✅';
        $('users-delete-csv-summary-alert').innerHTML = `
          <div class="alert ${alertClass}"><span class="alert-icon">${icon}</span>
          <span>${data.deleted} deleted · ${data.errors} error(s) · ${data.total} in CSV</span></div>`;
        show('btn-users-delete-download-log');
      },
      onError: (msg) => {
        hide('btn-stop-users-delete-csv');
        hide('users-delete-csv-running');
        show('users-delete-csv-results');
        setText('users-delete-csv-run-title', 'Deletion failed');
        $('users-delete-csv-summary-alert').innerHTML = `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`;
        show('btn-users-delete-download-log');
      },

      onAbort: () => {
        hide('btn-stop-users-delete-csv');
        hide('users-delete-csv-running');
        show('users-delete-csv-results');
        setText('users-delete-csv-run-title', 'Deletion stopped');
        $('users-delete-csv-summary-alert').innerHTML = `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Deletion stopped by user.</span></div>`;
        show('btn-users-delete-download-log');
        usersDeleteController = null;
      },
    }
  );
}

function setUsersDeleteCSVProgress(msg, pct) {
  setText('users-delete-csv-progress-msg', msg);
  setText('users-delete-csv-progress-pct', `${pct}%`);
  $('users-delete-csv-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

// ══════════════════════════════════════════════════════════
// USERS — Delete All
// ══════════════════════════════════════════════════════════

function startUsersDeleteAll() {
  hide('users-delete-all-idle');
  show('users-delete-all-running');
  hide('users-delete-all-results');
  setUsersDeleteAllProgress('Starting…', 0);

  $('users-delete-all-log-entries').innerHTML = '';
  hide('users-delete-all-live-log');

  usersDeleteAllController = subscribeSSE(
    '/api/users/delete/all',
    {},
    {
      onProgress: ({ message, percent }) => setUsersDeleteAllProgress(message, percent),
      onLog: (entry) => {
        const logEl = $('users-delete-all-live-log');
        const entries = $('users-delete-all-log-entries');
        if (logEl.classList.contains('hidden')) show('users-delete-all-live-log');
        const e = document.createElement('div');
        e.className = `log-entry ${entry.level}`;
        e.innerHTML = `<span class="log-msg">${esc(entry.message)}</span>`;
        entries.appendChild(e);
        entries.scrollTop = entries.scrollHeight;
      },
      onComplete: (data) => {
        hide('users-delete-all-running');
        show('users-delete-all-results');
        const hasErrors = data.errors > 0;
        const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
        const icon = hasErrors ? '⚠️' : '✅';
        $('users-delete-all-summary-alert').innerHTML = `
          <div class="alert ${alertClass}"><span class="alert-icon">${icon}</span>
          <span>${data.deleted} users deleted · ${data.skipped > 0 ? `${data.skipped} already gone · ` : ''}${data.errors} error(s)</span></div>`;
      },
      onError: (msg) => {
        hide('users-delete-all-running');
        show('users-delete-all-results');
        $('users-delete-all-summary-alert').innerHTML = `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`;
      },
      onAbort: () => {
        hide('users-delete-all-running');
        show('users-delete-all-results');
        $('users-delete-all-summary-alert').innerHTML = `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Deletion stopped by user.</span></div>`;
        usersDeleteAllController = null;
      },
    }
  );
}

function setUsersDeleteAllProgress(msg, pct) {
  setText('users-delete-all-progress-msg', msg);
  setText('users-delete-all-progress-pct', `${pct}%`);
  $('users-delete-all-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

// ══════════════════════════════════════════════════════════
// MODULE INIT — called once by app.js after partial is loaded
// ══════════════════════════════════════════════════════════
let _usersInitDone = false;
function initUsersModule() {
  if (_usersInitDone) return;
  _usersInitDone = true;

  // ── Export ──────────────────────────────────────────────
  $('btn-users-export').addEventListener('click', () => requireToken(startUsersExport));
  $('btn-users-export-again').addEventListener('click', resetUsersExport);
  $('btn-users-export-stopped-again').addEventListener('click', resetUsersExport);
  $('btn-users-export-retry').addEventListener('click', resetUsersExport);
  $('btn-stop-users-export').addEventListener('click', () => {
    if (usersExportCtrl) { usersExportCtrl.abort(); usersExportCtrl = null; }
  });
  $('btn-users-download-csv').addEventListener('click', () => {
    if (usersLastExportCSV) triggerDownload(new Blob([usersLastExportCSV], { type: 'text/csv;charset=utf-8;' }), usersLastExportFilename);
  });

  // ── Import: file upload ──────────────────────────────────
  ({ clear: usersClearImportDropzone } = wireDropzone($('users-dropzone'), $('users-file-input'), (file) => loadUsersCSVFile(file), () => {
    usersParsedCSV = null;
    hide('users-import-step-map');
    hide('users-import-step-options');
    hide('users-import-step-validate');
    hide('users-import-step-run');
    hide('users-import-summary-box');
  }));
  $('btn-users-reupload').addEventListener('click', () => {
    usersParsedCSV = null;
    if (usersClearImportDropzone) usersClearImportDropzone();
    hide('users-import-step-map');
    hide('users-import-step-options');
    hide('users-import-step-validate');
    hide('users-import-step-run');
    hide('users-import-summary-box');
  });

  // ── Import: map / validate / run ─────────────────────────
  $('btn-users-skip-all').addEventListener('click', () => {
    $('users-mapping-rows').querySelectorAll('select').forEach((sel) => { sel.value = ''; });
    saveUsersMapping();
  });
  $('btn-users-validate').addEventListener('click', () => requireToken(runUsersValidation));
  $('btn-users-run-import').addEventListener('click', () => requireToken(runUsersImport));
  $('btn-users-back-to-map').addEventListener('click', () => {
    hide('users-import-step-validate');
    hide('users-import-step-run');
    show('users-import-step-map');
    show('users-import-step-options');
  });
  $('btn-users-stop-import').addEventListener('click', () => {
    if (usersImportController) { usersImportController.abort(); usersImportController = null; }
  });
  $('btn-users-import-download-log').addEventListener('click', () => {
    downloadLogCsv(appendUsersLogEntry, 'users-import');
  });

  // ── Delete from CSV ───────────────────────────────────────
  ({ clear: usersClearDeleteDropzone } = wireDropzone($('users-delete-dropzone'), $('users-delete-file-input'), (file) => loadUsersDeleteCSV(file), () => {
    usersDeleteParsedCSV = null;
    hide('users-delete-csv-step-confirm');
  }));
  $('users-delete-uuid-column').addEventListener('change', updateUsersDeleteCSVPreview);
  $('btn-users-delete-reupload').addEventListener('click', () => {
    usersDeleteParsedCSV = null;
    if (usersClearDeleteDropzone) usersClearDeleteDropzone();
    hide('users-delete-csv-step-confirm');
    hide('users-delete-csv-step-run');
  });
  $('btn-users-delete-csv-run').addEventListener('click', () => requireToken(() => {
    const col = $('users-delete-uuid-column').value;
    if (!col || !usersDeleteParsedCSV) return;
    startUsersDeleteCSV(col);
  }));
  $('btn-users-delete-download-log').addEventListener('click', () => {
    downloadLogCsv(appendUsersDeleteLogEntry, 'users-delete');
  });
  $('btn-stop-users-delete-csv').addEventListener('click', () => {
    if (usersDeleteController) { usersDeleteController.abort(); usersDeleteController = null; }
    hide('btn-stop-users-delete-csv');
    show('btn-users-delete-download-log');
  });
  $('btn-users-delete-csv-again').addEventListener('click', () => {
    usersDeleteParsedCSV = null;
    if (usersClearDeleteDropzone) usersClearDeleteDropzone();
    hide('users-delete-csv-step-confirm');
    hide('users-delete-csv-step-run');
  });

  // ── Delete all ────────────────────────────────────────────
  $('users-delete-all-confirm-input').addEventListener('input', (e) => {
    $('btn-users-delete-all-run').disabled = e.target.value.trim() !== 'DELETE';
  });
  $('btn-users-delete-all-run').addEventListener('click', () => requireToken(() => {
    if ($('users-delete-all-confirm-input').value.trim() !== 'DELETE') return;
    startUsersDeleteAll();
  }));
  $('btn-stop-users-delete-all').addEventListener('click', () => {
    if (usersDeleteAllController) { usersDeleteAllController.abort(); usersDeleteAllController = null; }
  });
  $('btn-users-delete-all-again').addEventListener('click', () => {
    $('users-delete-all-confirm-input').value = '';
    $('btn-users-delete-all-run').disabled = true;
    hide('users-delete-all-running');
    hide('users-delete-all-results');
    show('users-delete-all-idle');
  });
}
window.initUsersModule = initUsersModule;

// ── pb:disconnect / pb:connected ───────────────────────────
window.addEventListener('pb:disconnect', resetUsersState);
window.addEventListener('pb:connected', () => {
  if (usersParsedCSV && $('users-import-step-map') && !$('users-import-step-map').classList.contains('hidden')) {
    loadUsersCustomFieldTable();
  }
});
