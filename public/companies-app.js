/* =========================================================
   PBToolkit — Companies module
   ========================================================= */

// ── Module state ────────────────────────────────────────────
let parsedCSV    = null; // { raw: string, headers: string[], rowCount: number }
let customFields = [];   // [{ id, name, type }]
const COMPANIES_MAPPING_KEY = 'companies-mapping';
let mappingChangeListenerAdded = false;
let lastExportCSV = null;
let lastExportFilename = 'companies.csv';
let companyExportCtrl = null;
let csmV1V2Ctrl = null;
let csmV2V1Ctrl = null;
let clearImportDropzone = null;
let clearDeleteDropzone = null;

// Called by app.js disconnect handler
function resetCompaniesState() {
  parsedCSV = null;
  customFields = [];
  lastExportCSV = null;
  lastExportFilename = 'companies.csv';
  if (clearImportDropzone) clearImportDropzone();
  if (clearDeleteDropzone) clearDeleteDropzone();
  resetExport();
  ['import-step-map', 'import-step-options', 'import-step-validate', 'import-step-run', 'import-summary-box'].forEach((id) => {
    const el = $(id); if (el) el.classList.add('hidden');
  });
  csmV1V2Ctrl = null;
  csmV2V1Ctrl = null;
  ['csm-v1v2-running', 'csm-v1v2-results', 'csm-v2v1-running', 'csm-v2v1-results'].forEach((id) => {
    const el = $(id); if (el) el.classList.add('hidden');
  });
  ['csm-v1v2-idle', 'csm-v2v1-idle'].forEach((id) => {
    const el = $(id); if (el) el.classList.remove('hidden');
  });
}

// ══════════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════════
function resetExport() {
  show('export-idle');
  hide('export-running');
  hide('export-stopped');
  hide('export-done');
  hide('export-error');
}


function startExport() {
  show('export-running');
  hide('export-idle');
  hide('export-stopped');
  hide('export-done');
  hide('export-error');

  setExportProgress('Starting…', 0);

  companyExportCtrl = subscribeSSE('/api/export', {}, {
    onProgress: ({ message, percent }) => setExportProgress(message, percent),
    onComplete: (data) => {
      hide('export-running');
      if (!data.csv && data.count === 0) {
        showExportError('No companies found in this workspace.');
        return;
      }
      lastExportCSV = data.csv;
      lastExportFilename = data.filename || 'companies.csv';
      triggerDownload(new Blob([lastExportCSV], { type: 'text/csv;charset=utf-8;' }), lastExportFilename);
      show('export-done');
      setText('export-done-msg', `Exported ${data.count.toLocaleString()} companies. Download started.`);
    },
    onError: (msg) => {
      hide('export-running');
      showExportError(msg);
    },
    onAbort: () => {
      hide('export-running');
      show('export-stopped');
      companyExportCtrl = null;
    },
  });
}


function setExportProgress(msg, pct) {
  setText('export-progress-msg', msg);
  setText('export-progress-pct', `${pct}%`);
  $('export-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

function showExportError(msg) {
  setText('export-error-msg', msg);
  show('export-error');
}


// ══════════════════════════════════════════════════════════
// IMPORT — Step 1: Upload
// ══════════════════════════════════════════════════════════

function loadCSVFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) {
      alert('CSV file appears empty or has no data rows.');
      return;
    }
    parsedCSV = { raw: text, headers: parseCSVHeaders(text), rowCount };
    showMappingStep();
  };
  reader.readAsText(file);
}

// ══════════════════════════════════════════════════════════
// IMPORT — Step 2: Map columns
// ══════════════════════════════════════════════════════════
async function showMappingStep() {
  hide('import-step-validate');
  hide('import-step-run');
  show('import-step-map');
  show('import-step-options'); // Options panel always shows alongside map panel
  setText('map-subtitle', `${parsedCSV.rowCount} rows detected · ${parsedCSV.headers.length} columns`);

  buildBaseMappingTable();
  await loadAndBuildCustomFieldTable();
}

function buildBaseMappingTable() {
  const tbody = $('co-mapping-rows');
  tbody.innerHTML = '';

  const groupTr = document.createElement('tr');
  groupTr.className = 'mapping-group-row';
  groupTr.innerHTML = '<td colspan="3" class="mapping-group-label">Default fields</td>';
  tbody.appendChild(groupTr);

  const baseFields = [
    { id: 'map-pb-id',         label: 'pb_id',            displayType: 'uuid',     required: false, hint: 'Present → update existing · empty → check domain match → update or create new' },
    { id: 'map-name',          label: 'Name',             displayType: 'Text',     required: false, hint: 'Required when creating a new company (no pb_id provided)' },
    { id: 'map-domain',        label: 'Domain',           displayType: 'domain',   required: false, hint: 'Required when pb_id is not provided — used for lookup and new company creation' },
    { id: 'map-desc',          label: 'Description',      displayType: 'RichText', required: false },
    { id: 'map-owner',         label: 'Owner',            displayType: 'Member',   required: false, hint: 'Email of the workspace member who owns this company' },
    { id: 'map-source-origin', label: 'Source Origin',    displayType: 'Text',     required: false },
    { id: 'map-source-record', label: 'Source Record ID', displayType: 'Text',     required: false },
  ];

  for (const f of baseFields) {
    const tr = document.createElement('tr');
    const reqBadge = f.required ? ' <span class="badge badge-danger">required</span>' : '';
    tr.innerHTML = `
      <td>
        ${f.label}${reqBadge}${f.hint ? ` <span class="info-icon" data-tip="${esc(f.hint)}">i</span>` : ''}
      </td>
      <td><span class="badge badge-muted">${f.displayType}</span></td>
      <td>${buildColumnSelect(f.id, !f.required)}</td>
    `;
    tbody.appendChild(tr);
  }

  autoDetectBaseMappings();
  restoreCompaniesMapping(); // saved values override auto-detect

  // Add change listener once — delegate from the stable tbody element
  if (!mappingChangeListenerAdded) {
    $('co-mapping-rows').addEventListener('change', saveCompaniesMapping);
    mappingChangeListenerAdded = true;
  }
}

function buildColumnSelect(id, includeNone = true) {
  const options = includeNone
    ? '<option value="">(⇢ skip)</option>'
    : '<option value="">— select column —</option>';

  const colOptions = parsedCSV.headers
    .map((h) => `<option value="${esc(h)}">${esc(h)}</option>`)
    .join('');

  return `<select id="${id}">${options}${colOptions}</select>`;
}

function autoDetectBaseMappings() {
  const hints = {
    'map-pb-id':         ['pb_id', 'id', 'uuid', 'company id', 'pb company id'],
    'map-name':          ['name', 'company name', 'company_name'],
    'map-domain':        ['domain', 'website', 'url'],
    'map-desc':          ['description', 'desc', 'notes'],
    'map-owner':         ['owner', 'owner_email', 'owner email'],
    'map-source-origin': ['sourceorigin', 'source_origin', 'source origin'],
    'map-source-record': ['sourcerecordid', 'source_record_id', 'source record id'],
  };

  for (const [selectId, candidates] of Object.entries(hints)) {
    const sel = $(selectId);
    if (!sel) continue;
    for (const candidate of candidates) {
      const match = parsedCSV.headers.find((h) => h.toLowerCase() === candidate);
      if (match) { sel.value = match; break; }
    }
  }
}

async function loadAndBuildCustomFieldTable() {
  $('custom-fields-loading').textContent = 'Loading custom fields from Productboard…';
  show('custom-fields-loading');

  try {
    const res = await fetch('/api/fields', { headers: buildHeaders() });
    const data = await res.json();
    customFields = data.fields || [];
    const domainFieldId = data.domainFieldId || null;

    hide('custom-fields-loading');

    // Build custom field mapping table, excluding the domain field (it's in Base Fields)
    const nonDomainFields = customFields.filter((f) => f.id !== domainFieldId);
    if (nonDomainFields.length === 0) {
      $('custom-fields-loading').textContent = 'No custom fields found in this workspace.';
      show('custom-fields-loading');
      return;
    }
    buildCustomFieldTable(nonDomainFields);
    restoreCompaniesMapping(); // restore custom field columns now that those selects exist
  } catch (e) {
    $('custom-fields-loading').textContent = `Failed to load custom fields: ${e.message}`;
    show('custom-fields-loading');
  }
}

function buildCustomFieldTable(fields) {
  const tbody = $('co-mapping-rows');

  const groupTr = document.createElement('tr');
  groupTr.className = 'mapping-group-row';
  groupTr.innerHTML = '<td colspan="3" class="mapping-group-label">Custom fields</td>';
  tbody.appendChild(groupTr);

  for (const field of fields) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${esc(field.name)}</td>
      <td><span class="badge badge-muted">${esc(field.displayType || field.type)}</span></td>
      <td>${buildColumnSelect(`cf-${field.id}`, true)}</td>
    `;
    tbody.appendChild(tr);

    const sel = $(`cf-${field.id}`);
    const uuidSuffix = `[${field.id}]`.toLowerCase();
    const match = parsedCSV.headers.find(
      (h) => h.toLowerCase().endsWith(uuidSuffix) || h.toLowerCase() === field.name.toLowerCase()
    );
    if (match) sel.value = match;
  }
}


// ── Check for unmapped custom fields ────────────────────────
function checkUnmappedWarning() {
  const unmappedCustom = customFields
    .filter((f) => { const el = $(`cf-${f.id}`); return el && !el.value; })
    .map((f) => f.name);

  if (unmappedCustom.length > 0) {
    setText('unmapped-warning-msg',
      `${unmappedCustom.length} custom field(s) not mapped and will be skipped: ${unmappedCustom.join(', ')}.`
    );
    show('unmapped-warning');
  } else {
    hide('unmapped-warning');
  }
}


// ══════════════════════════════════════════════════════════
// IMPORT — Step 3: Validate
// ══════════════════════════════════════════════════════════
async function runValidation() {
  const mapping = buildMapping();
  if (!validateRequiredMappings(mapping)) return;

  show('import-step-validate');
  $('import-step-validate').scrollIntoView({ behavior: 'smooth', block: 'start' });
  hide('validate-ok');
  hide('validate-errors');
  setText('validate-ok-msg', '');
  $('validate-error-rows').innerHTML = '';

  try {
    const res = await fetch('/api/import/preview', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ csvText: parsedCSV.raw, mapping, options: { skipInvalidOwner: $('imp-skip-invalid-owner')?.checked || false } }),
    });
    const data = await res.json();

    if (data.valid) {
      setText('validate-ok-msg', `All ${data.totalRows} rows passed validation. Ready to import.`);
      show('validate-ok');
    } else {
      const summary = `${data.errors.length} error(s) found in ${data.totalRows} rows. Fix the CSV and re-upload.`;
      setText('validate-error-summary', summary);
      const tbody = $('validate-error-rows');
      for (const err of data.errors) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${err.row ?? '—'}</td>
          <td><span class="col-tag">${esc(err.field || '')}</span></td>
          <td class="text-danger">${esc(err.message)}</td>
        `;
        tbody.appendChild(tr);
      }
      show('validate-errors');
    }
  } catch (e) {
    setText('validate-error-summary', `Validation request failed: ${e.message}`);
    show('validate-errors');
  }
}


// ══════════════════════════════════════════════════════════
// IMPORT — Step 4: Run
// ══════════════════════════════════════════════════════════

let importController = null; // AbortController for the active import stream

// Log appender for companies import — bound to companies log DOM IDs.
// Uses shared makeLogAppender() defined in app.js.
const appendLogEntry = makeLogAppender('import-live-log', 'live-log-entries', 'live-log-counts', 'company');

function runImport() {
  const mapping = buildMapping();
  if (!validateRequiredMappings(mapping)) return;

  // Reset log for fresh run (clears entries, counts, hides the log panel)
  appendLogEntry.reset();
  hide('btn-import-download-log');
  // Reset summary box
  $('import-summary-box').innerHTML = '';
  hide('import-summary-box');
  hide('import-step-validate');
  show('import-step-run');
  $('import-step-run').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setText('import-run-title', 'Importing…');
  setImportProgress('Starting…', 0);
  show('btn-stop-import');

  const msMode = document.querySelector('input[name="imp-ms-mode"]:checked');
  const options = {
    multiSelectMode:     msMode ? msMode.value : 'set',
    bypassEmptyCells:    $('imp-bypass-empty')?.checked           || false,
    bypassHtmlFormatter: $('imp-bypass-html')?.checked            || false,
    skipInvalidOwner:    $('imp-skip-invalid-owner')?.checked     || false,
  };

  importController = subscribeSSE(
    '/api/import/run',
    { csvText: parsedCSV.raw, mapping, options },
    {
      onProgress: ({ message, percent }) => setImportProgress(message, percent),

      // appendLogEntry is the shared makeLogAppender-bound function
      onLog: (entry) => appendLogEntry(entry),

      onComplete: (data) => {
        hide('btn-stop-import');
        setImportProgress(data.stopped ? 'Import stopped' : 'Import complete', 100);
        setText('import-run-title', data.stopped ? 'Import stopped' : 'Import complete');
        // Use shared renderImportComplete for styled alert-ok/warn summary
        renderImportComplete($('import-summary-box'), {
          created: data.created,
          updated: data.updated,
          errors:  data.errors,
          stopped: data.stopped,
          extraText: data.total ? `${data.total} rows` : '',
        });
        show('btn-import-download-log');
      },

      onError: (msg) => {
        hide('btn-stop-import');
        setText('import-run-title', 'Import failed');
        // Show error in summary box using danger alert
        $('import-summary-box').innerHTML = `
          <div class="alert alert-danger">
            <span class="alert-icon">⚠️</span>
            <span>${esc(msg)}</span>
          </div>`;
        show('import-summary-box');
        // Also append to log so it's visible in context
        appendLogEntry({ level: 'error', message: msg, ts: new Date().toISOString() });
        show('btn-import-download-log');
      },

      onAbort: () => {
        hide('btn-stop-import');
        setText('import-run-title', 'Import stopped');
        setImportProgress('Stopped by user', 100);
        appendLogEntry({ level: 'warn', message: 'Import stopped by user', ts: new Date().toISOString() });
        show('btn-import-download-log');
        importController = null;
      },
    }
  );
}

function setImportProgress(msg, pct) {
  setText('import-progress-msg', msg);
  setText('import-progress-pct', `${pct}%`);
  $('import-progress-bar').style.width = `${Math.min(100, pct)}%`;
}


// ── Mapping helpers ─────────────────────────────────────────
function buildMapping() {
  return {
    pbIdColumn:       $('map-pb-id')?.value                || null,
    nameColumn:       $('map-name')?.value                 || null,
    domainColumn:     $('map-domain')?.value               || null,
    descColumn:       $('map-desc')?.value                 || null,
    ownerColumn:      $('map-owner')?.value                || null,
    sourceOriginCol:  $('map-source-origin')?.value        || null,
    sourceRecordCol:  $('map-source-record')?.value        || null,

    customFields: customFields
      .map((f) => ({
        csvColumn: $(`cf-${f.id}`)?.value || '',
        fieldId:   f.id,
        fieldType: f.type,
      }))
      .filter((cf) => cf.csvColumn),
  };
}

function validateRequiredMappings(mapping) {
  if (!mapping.pbIdColumn && !mapping.domainColumn && !mapping.nameColumn) {
    alert('Please map at least one field before continuing.');
    return false;
  }
  return true;
}

function saveCompaniesMapping() {
  try { localStorage.setItem(COMPANIES_MAPPING_KEY, JSON.stringify(buildMapping())); } catch (_) {}
}

function restoreCompaniesMapping() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(COMPANIES_MAPPING_KEY)); } catch (_) { return; }
  if (!saved) return;

  // Base fields
  const baseMap = {
    'map-pb-id':         saved.pbIdColumn,
    'map-name':          saved.nameColumn,
    'map-domain':        saved.domainColumn,
    'map-desc':          saved.descColumn,
    'map-owner':         saved.ownerColumn,
    'map-source-origin': saved.sourceOriginCol,
    'map-source-record': saved.sourceRecordCol,
  };
  for (const [id, value] of Object.entries(baseMap)) {
    const sel = $(id);
    // Only restore if the saved column header exists in the current CSV options
    if (sel && value && [...sel.options].some((o) => o.value === value)) sel.value = value;
  }

  // Custom fields
  if (saved.customFields) {
    for (const cf of saved.customFields) {
      const sel = $(`cf-${cf.fieldId}`);
      if (sel && cf.csvColumn && [...sel.options].some((o) => o.value === cf.csvColumn)) {
        sel.value = cf.csvColumn;
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
// COMPANIES — Source Migration
// ══════════════════════════════════════════════════════════

function csmSetProgress(prefix, message, percent) {
  const msg = $(`${prefix}-progress-msg`);
  const pct = $(`${prefix}-progress-pct`);
  const bar = $(`${prefix}-progress-bar`);
  if (msg) msg.textContent = message;
  if (pct) pct.textContent = `${percent}%`;
  if (bar) bar.style.width = `${percent}%`;
}

function csmRenderSummary(prefix, { total, migrated, skippedEmpty, skippedNotFound, errors }) {
  const el = $(`${prefix}-summary`);
  if (!el) return;
  const hasErrors = errors > 0;
  const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
  const icon = hasErrors ? '⚠️' : '✅';
  el.innerHTML = `
    <div class="alert ${alertClass}">
      <span class="alert-icon">${icon}</span>
      <span>
        ${migrated} migrated · ${skippedEmpty} skipped (no source data) · ${skippedNotFound} not found in target · ${errors} error(s)
        <br><span class="text-muted">${total} companies scanned total</span>
      </span>
    </div>
  `;
}

function startCsmMigration(direction) {
  const prefix   = direction === 'v1v2' ? 'csm-v1v2' : 'csm-v2v1';
  const endpoint = direction === 'v1v2'
    ? '/api/companies/source-migration/v1-to-v2'
    : '/api/companies/source-migration/v2-to-v1';

  hide(`${prefix}-idle`);
  hide(`${prefix}-results`);
  show(`${prefix}-running`);
  show(`${prefix}-live-log`);
  $(`${prefix}-log-entries`).innerHTML = '';
  csmSetProgress(prefix, 'Starting…', 0);

  const ctrl = subscribeSSE(endpoint, {}, {
    onProgress: ({ message, percent }) => csmSetProgress(prefix, message, percent),
    onLog: (entry) => {
      const entries = $(`${prefix}-log-entries`);
      const e = document.createElement('div');
      e.className = `log-entry ${entry.level}`;
      e.innerHTML = `<span class="log-msg">${esc(entry.message)}</span>`;
      entries.appendChild(e);
      entries.scrollTop = entries.scrollHeight;
      show(`${prefix}-live-log`);
    },
    onComplete: (data) => {
      hide(`${prefix}-running`);
      show(`${prefix}-results`);
      csmRenderSummary(prefix, data);
    },
    onError: (msg) => {
      hide(`${prefix}-running`);
      show(`${prefix}-results`);
      const el = $(`${prefix}-summary`);
      if (el) el.innerHTML = `<div class="alert alert-danger"><span class="alert-icon">⛔</span><span>${msg}</span></div>`;
    },
    onAbort: () => {
      hide(`${prefix}-running`);
      show(`${prefix}-idle`);
    },
  });

  if (direction === 'v1v2') csmV1V2Ctrl = ctrl;
  else csmV2V1Ctrl = ctrl;
}


// ══════════════════════════════════════════════════════════
// COMPANIES — Delete from CSV
// ══════════════════════════════════════════════════════════

let companiesDeleteParsedCSV = null;
let companiesDeleteController = null;

// Log appender for companies delete-by-CSV — no counts element in this panel.
const appendCompaniesDeleteLogEntry = makeLogAppender('companies-delete-csv-live-log', 'companies-delete-csv-log-entries', null, 'company');

function loadCompaniesDeleteCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const headers = parseCSVHeaders(text);
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) { alert('CSV appears empty.'); return; }
    companiesDeleteParsedCSV = { raw: text, headers, rowCount };

    // Populate column picker
    const sel = $('companies-delete-uuid-column');
    sel.innerHTML = headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');

    // Auto-select id/pb_id/uuid column — export CSV uses 'id' as the UUID column
    const auto = headers.find((h) => ['pb_id', 'id', 'uuid'].includes(h.toLowerCase()));
    if (auto) sel.value = auto;

    setText('companies-delete-csv-subtitle', `${companiesDeleteParsedCSV.rowCount} rows · ${headers.length} columns`);
    updateCompaniesDeleteCSVPreview();
    show('companies-delete-csv-step-confirm');
  };
  reader.readAsText(file);
}


function updateCompaniesDeleteCSVPreview() {
  const col = $('companies-delete-uuid-column').value;
  if (!companiesDeleteParsedCSV || !col) return;

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const headers = parseCSVHeaders(companiesDeleteParsedCSV.raw);
  const colIdx = headers.indexOf(col);
  if (colIdx < 0) return;

  // Extract first 5 valid UUIDs for preview
  const lines = companiesDeleteParsedCSV.raw.trim().split('\n').slice(1);
  const uuids = lines
    .map((l) => l.split(',')[colIdx]?.trim().replace(/^"|"$/g, ''))
    .filter((v) => UUID_PATTERN.test(v))
    .slice(0, 5);

  const preview = $('companies-delete-csv-preview');
  if (uuids.length > 0) {
    preview.textContent = `First UUIDs: ${uuids.join(', ')}${lines.length > 5 ? ', …' : ''}`;
    show('companies-delete-csv-preview');
  } else {
    preview.textContent = 'No valid UUIDs found in this column.';
    show('companies-delete-csv-preview');
  }
}


function startCompaniesDeleteCSV(uuidColumn) {
  hide('companies-delete-csv-step-confirm');
  show('companies-delete-csv-step-run');
  setText('companies-delete-csv-run-title', 'Deleting companies…');
  show('companies-delete-csv-running');
  hide('companies-delete-csv-results');
  setCompaniesDeleteCSVProgress('Starting…', 0);

  appendCompaniesDeleteLogEntry.reset();
  hide('btn-companies-delete-download-log');

  show('btn-stop-companies-delete-csv');

  companiesDeleteController = subscribeSSE(
    '/api/companies/delete/by-csv',
    { csvText: companiesDeleteParsedCSV.raw, uuidColumn },
    {
      onProgress: ({ message, percent }) => setCompaniesDeleteCSVProgress(message, percent),

      onLog: (entry) => appendCompaniesDeleteLogEntry(entry),

      onComplete: (data) => {
        hide('btn-stop-companies-delete-csv');
        hide('companies-delete-csv-running');
        show('companies-delete-csv-results');
        setText('companies-delete-csv-run-title', 'Deletion complete');
        const hasErrors = data.errors > 0;
        const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
        const icon = hasErrors ? '⚠️' : '✅';
        $('companies-delete-csv-summary-alert').innerHTML = `
          <div class="alert ${alertClass}"><span class="alert-icon">${icon}</span>
          <span>${data.deleted} deleted · ${data.errors} error(s) · ${data.total} in CSV</span></div>`;
        show('btn-companies-delete-download-log');
      },

      onError: (msg) => {
        hide('btn-stop-companies-delete-csv');
        hide('companies-delete-csv-running');
        show('companies-delete-csv-results');
        setText('companies-delete-csv-run-title', 'Deletion failed');
        $('companies-delete-csv-summary-alert').innerHTML = `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`;
        show('btn-companies-delete-download-log');
      },
    }
  );
}


function setCompaniesDeleteCSVProgress(msg, pct) {
  setText('companies-delete-csv-progress-msg', msg);
  setText('companies-delete-csv-progress-pct', `${pct}%`);
  $('companies-delete-csv-progress-bar').style.width = `${Math.min(100, pct)}%`;
}


// ══════════════════════════════════════════════════════════
// COMPANIES — Delete All
// ══════════════════════════════════════════════════════════

let companiesDeleteAllController = null;


function startCompaniesDeleteAll() {
  hide('companies-delete-all-idle');
  show('companies-delete-all-running');
  hide('companies-delete-all-results');
  setCompaniesDeleteAllProgress('Starting…', 0);

  $('companies-delete-all-log-entries').innerHTML = '';
  hide('companies-delete-all-live-log');

  companiesDeleteAllController = subscribeSSE(
    '/api/companies/delete/all',
    {},
    {
      onProgress: ({ message, percent }) => setCompaniesDeleteAllProgress(message, percent),

      onLog: (entry) => {
        const logEl = $('companies-delete-all-live-log');
        const entries = $('companies-delete-all-log-entries');
        if (logEl.classList.contains('hidden')) show('companies-delete-all-live-log');
        const e = document.createElement('div');
        e.className = `log-entry ${entry.level}`;
        e.innerHTML = `<span class="log-msg">${esc(entry.message)}</span>`;
        entries.appendChild(e);
        entries.scrollTop = entries.scrollHeight;
      },

      onComplete: (data) => {
        hide('companies-delete-all-running');
        show('companies-delete-all-results');
        const hasErrors = data.errors > 0;
        const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
        const icon = hasErrors ? '⚠️' : '✅';
        $('companies-delete-all-summary-alert').innerHTML = `
          <div class="alert ${alertClass}"><span class="alert-icon">${icon}</span>
          <span>${data.deleted} companies deleted · ${data.skipped > 0 ? `${data.skipped} already gone · ` : ''}${data.errors} error(s)</span></div>`;
      },

      onError: (msg) => {
        hide('companies-delete-all-running');
        show('companies-delete-all-results');
        $('companies-delete-all-summary-alert').innerHTML = `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`;
      },
    }
  );
}

function setCompaniesDeleteAllProgress(msg, pct) {
  setText('companies-delete-all-progress-msg', msg);
  setText('companies-delete-all-progress-pct', `${pct}%`);
  $('companies-delete-all-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

// ══════════════════════════════════════════════════════════
// MODULE INIT — called once by app.js after partial is loaded
// ══════════════════════════════════════════════════════════
let _companiesInitDone = false;
function initCompaniesModule() {
  if (_companiesInitDone) return;
  _companiesInitDone = true;

  // ── Export ──────────────────────────────────────────────
  $('btn-export').addEventListener('click', () => requireToken(startExport));
  $('btn-export-again').addEventListener('click', resetExport);
  $('btn-export-stopped-again').addEventListener('click', resetExport);
  $('btn-export-retry').addEventListener('click', resetExport);
  $('btn-stop-export').addEventListener('click', () => {
    if (companyExportCtrl) { companyExportCtrl.abort(); companyExportCtrl = null; }
  });
  $('btn-download-csv').addEventListener('click', () => {
    if (lastExportCSV) triggerDownload(new Blob([lastExportCSV], { type: 'text/csv;charset=utf-8;' }), lastExportFilename);
  });

  // ── Import: file upload ──────────────────────────────────
  ({ clear: clearImportDropzone } = wireDropzone($('dropzone'), $('file-input'), (file) => loadCSVFile(file), () => {
    parsedCSV = null;
    hide('import-step-map');
    hide('import-step-options');
    hide('import-step-validate');
    hide('import-step-run');
    hide('import-summary-box');
  }));
  $('btn-reupload').addEventListener('click', () => {
    parsedCSV = null;
    if (clearImportDropzone) clearImportDropzone();
    hide('import-step-map');
    hide('import-step-options');
    hide('import-step-validate');
    hide('import-step-run');
    hide('import-summary-box');
  });

  // ── Import: map / validate / run ─────────────────────────
  $('btn-validate').addEventListener('click', () => requireToken(runValidation));
  $('btn-run-import').addEventListener('click', () => requireToken(runImport));
  $('btn-back-to-map2').addEventListener('click', () => {
    hide('import-step-validate');
    hide('import-step-run');
    show('import-step-map');
    show('import-step-options');
  });
  $('btn-stop-import').addEventListener('click', () => {
    if (importController) { importController.abort(); importController = null; }
  });
  $('btn-import-download-log').addEventListener('click', () => {
    downloadLogCsv(appendLogEntry, 'companies-import');
  });

  // ── Source migration ──────────────────────────────────────
  $('btn-csm-v1v2-run').addEventListener('click', () => requireToken(startCsmV1V2));
  $('btn-stop-csm-v1v2').addEventListener('click', () => {
    if (csmV1V2Ctrl) { csmV1V2Ctrl.abort(); csmV1V2Ctrl = null; }
  });
  $('btn-csm-v1v2-again').addEventListener('click', () => {
    hide('csm-v1v2-running');
    hide('csm-v1v2-results');
    show('csm-v1v2-idle');
  });
  $('btn-csm-v2v1-run').addEventListener('click', () => requireToken(startCsmV2V1));
  $('btn-stop-csm-v2v1').addEventListener('click', () => {
    if (csmV2V1Ctrl) { csmV2V1Ctrl.abort(); csmV2V1Ctrl = null; }
  });
  $('btn-csm-v2v1-again').addEventListener('click', () => {
    hide('csm-v2v1-running');
    hide('csm-v2v1-results');
    show('csm-v2v1-idle');
  });

  // ── Delete from CSV ───────────────────────────────────────
  ({ clear: clearDeleteDropzone } = wireDropzone($('companies-delete-dropzone'), $('companies-delete-file-input'), (file) => loadCompaniesDeleteCSV(file), () => {
    companiesDeleteParsedCSV = null;
    hide('companies-delete-csv-step-confirm');
  }));
  $('companies-delete-uuid-column').addEventListener('change', updateCompaniesDeleteCSVPreview);
  $('btn-companies-delete-reupload').addEventListener('click', () => {
    companiesDeleteParsedCSV = null;
    if (clearDeleteDropzone) clearDeleteDropzone();
    hide('companies-delete-csv-step-confirm');
    hide('companies-delete-csv-step-run');
  });
  $('btn-companies-delete-csv-run').addEventListener('click', () => requireToken(() => {
    const col = $('companies-delete-uuid-column').value;
    if (!col || !companiesDeleteParsedCSV) return;
    startCompaniesDeleteCSV(col);
  }));
  $('btn-companies-delete-download-log').addEventListener('click', () => {
    downloadLogCsv(appendCompaniesDeleteLogEntry, 'companies-delete');
  });
  $('btn-stop-companies-delete-csv').addEventListener('click', () => {
    if (companiesDeleteController) { companiesDeleteController.abort(); companiesDeleteController = null; }
    hide('btn-stop-companies-delete-csv');
    show('btn-companies-delete-download-log');
  });
  $('btn-companies-delete-csv-again').addEventListener('click', () => {
    companiesDeleteParsedCSV = null;
    if (clearDeleteDropzone) clearDeleteDropzone();
    hide('companies-delete-csv-step-confirm');
    hide('companies-delete-csv-step-run');
  });

  // ── Delete all ────────────────────────────────────────────
  $('companies-delete-all-confirm-input').addEventListener('input', (e) => {
    $('btn-companies-delete-all-run').disabled = e.target.value.trim() !== 'DELETE';
  });
  $('btn-companies-delete-all-run').addEventListener('click', () => requireToken(() => {
    if ($('companies-delete-all-confirm-input').value.trim() !== 'DELETE') return;
    startCompaniesDeleteAll();
  }));
  $('btn-companies-delete-all-again').addEventListener('click', () => {
    $('companies-delete-all-confirm-input').value = '';
    $('btn-companies-delete-all-run').disabled = true;
    hide('companies-delete-all-running');
    hide('companies-delete-all-results');
    show('companies-delete-all-idle');
  });

  // ── Mapping persistence ──────────────────────────────────
  // (mappingChangeListenerAdded guards added in loadAndBuildCustomFieldTable)
}
window.initCompaniesModule = initCompaniesModule;

// ── pb:disconnect / pb:connected ───────────────────────────
window.addEventListener('pb:disconnect', resetCompaniesState);
window.addEventListener('pb:connected', () => {
  // If the mapper is open and custom fields failed to load (no token), reload now
  if (parsedCSV && $('import-step-map') && !$('import-step-map').classList.contains('hidden')) {
    loadAndBuildCustomFieldTable();
  }
});
