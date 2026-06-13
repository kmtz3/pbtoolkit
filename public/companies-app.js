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
let sfmParsedCSV        = null;
let sfmTextFields       = [];
let sfmCurrentMapping   = null;
let sfmController       = null;
let clearSfmDropzone    = null;
let sfmCheckpointKey    = null;
let sfmResumeFromRow    = 0;

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
  sfmParsedCSV = null;
  sfmTextFields = [];
  sfmCurrentMapping = null;
  sfmController = null;
  sfmCheckpointKey = null;
  sfmResumeFromRow = 0;
  if (clearSfmDropzone) clearSfmDropzone();
  ['sfm-step-map', 'sfm-step-preview', 'sfm-step-run'].forEach((id) => {
    const el = $(id); if (el) el.classList.add('hidden');
  });
  hide('sfm-resume-banner');
  hide('sfm-resume-prompt');
  hide('sfm-checkpoint-notice');
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
    'map-source-origin': ['source_origin', 'sourceorigin', 'source origin'],
    'map-source-record': ['source_record_id', 'sourcerecordid', 'source record id'],
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
  hide('validate-warnings');
  setText('validate-ok-msg', '');
  $('validate-error-rows').innerHTML = '';
  $('validate-warning-rows').innerHTML = '';

  try {
    const res = await fetch('/api/import/preview', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ csvText: parsedCSV.raw, mapping, options: { skipInvalidOwner: $('imp-skip-invalid-owner')?.checked || false, autoCreateFieldValues: $('imp-auto-create-values')?.checked || false } }),
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

    // Show warnings (non-blocking)
    if (data.warnings && data.warnings.length > 0) {
      setText('validate-warning-summary', `${data.warnings.length} warning(s) — these won't block the import.`);
      const warnTbody = $('validate-warning-rows');
      for (const w of data.warnings) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${w.row ?? '—'}</td>
          <td><span class="col-tag">${esc(w.field || '')}</span></td>
          <td class="${w.isInfo ? 'text-info' : ''}">${esc(w.message)}</td>
        `;
        warnTbody.appendChild(tr);
      }
      show('validate-warnings');
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
    bypassEmptyCells:       $('imp-bypass-empty')?.checked              || false,
    bypassHtmlFormatter:    $('imp-bypass-html')?.checked               || false,
    skipInvalidOwner:       $('imp-skip-invalid-owner')?.checked        || false,
    autoCreateFieldValues:  $('imp-auto-create-values')?.checked        || false,
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

  // Extract first 5 valid UUIDs for preview (quote-aware split)
  const lines = companiesDeleteParsedCSV.raw.trim().split('\n').slice(1);
  const uuids = lines
    .map((l) => {
      const cols = l.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
      return cols[colIdx]?.trim().replace(/^"|"$/g, '');
    })
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

      onAbort: () => {
        hide('btn-stop-companies-delete-csv');
        hide('companies-delete-csv-running');
        show('companies-delete-csv-results');
        setText('companies-delete-csv-run-title', 'Deletion stopped');
        $('companies-delete-csv-summary-alert').innerHTML = `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Deletion stopped by user.</span></div>`;
        show('btn-companies-delete-download-log');
        companiesDeleteController = null;
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

      onAbort: () => {
        hide('companies-delete-all-running');
        show('companies-delete-all-results');
        $('companies-delete-all-summary-alert').innerHTML = `<div class="alert alert-warn"><span class="alert-icon">⏹</span><span>Deletion stopped by user.</span></div>`;
        companiesDeleteAllController = null;
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
// SF INSTANCE MIGRATION
// ══════════════════════════════════════════════════════════

const SFM_UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SFM_PREVIEW_MAX = 10;

const sfmAppendLogEntry = makeLogAppender('sfm-live-log', 'sfm-log-entries', 'sfm-log-counts', 'company');

function sfmCsvFingerprint(filename, size, text) {
  // Stable key: filename + size + first data line (not headers, not content hash — fast enough)
  const firstLine = text.split('\n').slice(0, 2).join('|');
  return `sfm-checkpoint:${filename}:${size}:${firstLine}`;
}

function sfmLoadCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) { alert('CSV file appears empty or has no data rows.'); return; }
    sfmParsedCSV = { raw: text, headers: parseCSVHeaders(text), rowCount };

    // Check for a saved checkpoint matching this exact file
    sfmCheckpointKey = sfmCsvFingerprint(file.name, file.size, text);
    const saved = sfmLoadCheckpoint(sfmCheckpointKey);
    if (saved && saved.row > 0 && saved.row < rowCount) {
      sfmResumeFromRow = saved.row;
    } else {
      sfmResumeFromRow = 0;
    }

    sfmShowMapStep();
  };
  reader.readAsText(file);
}

function sfmSaveCheckpoint(key, row) {
  try { localStorage.setItem(key, JSON.stringify({ row })); } catch (_) {}
}

function sfmLoadCheckpoint(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (_) { return null; }
}

function sfmClearCheckpoint(key) {
  if (key) try { localStorage.removeItem(key); } catch (_) {}
}

function sfmShowMapStep() {
  hide('sfm-step-preview');
  hide('sfm-step-run');
  setText('sfm-row-count', `${sfmParsedCSV.rowCount} rows · ${sfmParsedCSV.headers.length} columns`);
  sfmBuildSelects();
  if (sfmResumeFromRow > 0) {
    setText('sfm-checkpoint-row', sfmResumeFromRow.toLocaleString());
    show('sfm-checkpoint-notice');
  } else {
    hide('sfm-checkpoint-notice');
  }
  show('sfm-step-map');
}

function sfmBuildSelects() {
  const headers = sfmParsedCSV.headers;
  const reqOpt  = '<option value="">— required —</option>';
  const skipOpt = '<option value="">(⇢ skip)</option>';
  const colOpts = headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');

  $('sfm-uuid-col').innerHTML   = reqOpt  + colOpts;
  $('sfm-new-id-col').innerHTML = reqOpt  + colOpts;
  $('sfm-old-id-col').innerHTML = skipOpt + colOpts;

  const hints = {
    'sfm-uuid-col':   ['pb_id', 'id', 'uuid', 'company_id', 'company id'],
    'sfm-new-id-col': ['new_salesforce_id', 'new_sf_id', 'new_sfid', 'new salesforce id', 'new_source_record_id'],
    'sfm-old-id-col': ['old_salesforce_id', 'old_sf_id', 'old_sfid', 'old salesforce id', 'old_source_record_id', 'source_record_id'],
  };
  for (const [selId, candidates] of Object.entries(hints)) {
    const sel = $(selId);
    if (!sel) continue;
    for (const c of candidates) {
      const match = headers.find((h) => h.toLowerCase() === c);
      if (match) { sel.value = match; break; }
    }
  }
  sfmUpdateOldIdToggle();
}

function sfmUpdateOldIdToggle() {
  const hasOldId  = !!$('sfm-old-id-col')?.value;
  const section   = $('sfm-old-id-options');
  if (!section) return;

  if (hasOldId) {
    section.classList.remove('hidden');
  } else {
    section.classList.add('hidden');
    const cb = $('sfm-move-old-id');
    if (cb) cb.checked = false;
    sfmUpdateTextFieldToggle();
  }
}

function sfmUpdateTextFieldToggle() {
  const checked = $('sfm-move-old-id')?.checked;
  const section = $('sfm-text-field-section');
  if (!section) return;

  if (checked) {
    section.classList.remove('hidden');
    if (sfmTextFields.length === 0) requireToken(sfmLoadTextFields);
  } else {
    section.classList.add('hidden');
  }
}

async function sfmLoadTextFields() {
  const sel = $('sfm-text-field-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">Loading…</option>';
  sel.disabled  = true;
  hide('sfm-fields-error');

  try {
    const res = await fetch('/api/fields', { headers: buildHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    sfmTextFields = (data.fields || []).filter((f) => f.type === 'text');

    if (sfmTextFields.length === 0) {
      sel.innerHTML = '<option value="">No text fields found</option>';
    } else {
      sel.innerHTML = '<option value="">— select a text field —</option>' +
        sfmTextFields.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
      sel.disabled = false;
    }
  } catch (e) {
    setText('sfm-fields-error', `Failed to load fields: ${e.message}`);
    show('sfm-fields-error');
    sel.innerHTML = '<option value="">Error loading fields</option>';
  }
}

function sfmBuildPreview() {
  const uuidCol    = $('sfm-uuid-col')?.value    || '';
  const newIdCol   = $('sfm-new-id-col')?.value  || '';
  const oldIdCol   = $('sfm-old-id-col')?.value  || '';
  const moveOldId  = $('sfm-move-old-id')?.checked;
  const textFieldId = moveOldId ? ($('sfm-text-field-select')?.value || '') : '';

  if (!uuidCol)  { showAlert('Please select the PB Company UUID column.'); return; }
  if (!newIdCol) { showAlert('Please select the New Salesforce ID column.'); return; }
  if (moveOldId && !textFieldId) {
    showAlert('Please select a text field for the old Salesforce ID, or uncheck the option.');
    return;
  }

  sfmCurrentMapping = { uuidCol, newIdCol, oldIdCol, textFieldId };
  const rows        = sfmParseRows(sfmParsedCSV.raw, uuidCol, newIdCol, oldIdCol);
  const validCount  = rows.filter((r) => r.status === 'ready').length;
  const skipCount   = rows.length - validCount;

  setText('sfm-preview-subtitle',
    `${validCount} rows ready to migrate${skipCount > 0 ? ` · ${skipCount} will be skipped` : ''}`);
  sfmRenderPreviewTable(rows, !!oldIdCol);

  if (skipCount > 0) {
    setText('sfm-preview-warn-msg',
      `${skipCount} row(s) will be skipped — check that UUID and New Salesforce ID columns are correctly mapped.`);
    show('sfm-preview-warn');
  } else {
    hide('sfm-preview-warn');
  }

  // Update Run button label to make resume intent explicit
  const runBtn = $('btn-sfm-run');
  if (sfmResumeFromRow > 0) {
    runBtn.textContent = `▶ Resume from row ${sfmResumeFromRow.toLocaleString()}`;
  } else {
    runBtn.innerHTML = '🔀 Run migration';
  }

  hide('sfm-step-run');
  show('sfm-step-preview');
  $('sfm-step-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function sfmParseRows(raw, uuidCol, newIdCol, oldIdCol) {
  const headers  = parseCSVHeaders(raw);
  const uuidIdx  = headers.indexOf(uuidCol);
  const newIdIdx = headers.indexOf(newIdCol);
  const oldIdIdx = oldIdCol ? headers.indexOf(oldIdCol) : -1;

  const lines = cleanCSVText(raw).trim().split('\n').slice(1).filter((l) => l.trim());
  return lines.map((line) => {
    const cols  = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    const get   = (idx) => idx >= 0 ? (cols[idx]?.trim().replace(/^"|"$/g, '') || '') : '';

    const uuid  = get(uuidIdx);
    const newId = get(newIdIdx);
    const oldId = get(oldIdIdx);

    let status = 'ready';
    if (!uuid || !SFM_UUID_RE.test(uuid)) status = 'skip-uuid';
    else if (!newId) status = 'skip-empty';

    return { uuid, newId, oldId, status };
  });
}

function sfmRenderPreviewTable(rows, showOldId) {
  const previewRows = rows.slice(0, SFM_PREVIEW_MAX);

  $('sfm-preview-thead').innerHTML = `<tr>
    <th>PB UUID</th>
    ${showOldId ? '<th>Old Salesforce ID</th>' : ''}
    <th>New Salesforce ID</th>
    <th>Status</th>
  </tr>`;

  const tbody = $('sfm-preview-tbody');
  tbody.innerHTML = '';
  for (const row of previewRows) {
    const badge = row.status === 'ready'
      ? '<span class="badge badge-ok">✓ Ready</span>'
      : row.status === 'skip-uuid'
        ? '<span class="badge badge-danger">Skip — invalid UUID</span>'
        : '<span class="badge badge-warn">Skip — empty new ID</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-mono text-sm">${esc(row.uuid || '—')}</td>
      ${showOldId ? `<td class="font-mono text-sm">${esc(row.oldId || '—')}</td>` : ''}
      <td class="font-mono text-sm">${esc(row.newId || '—')}</td>
      <td>${badge}</td>
    `;
    tbody.appendChild(tr);
  }

  const moreEl = $('sfm-preview-more');
  if (rows.length > SFM_PREVIEW_MAX) {
    moreEl.textContent = `…and ${rows.length - SFM_PREVIEW_MAX} more row(s) (not shown)`;
    show('sfm-preview-more');
  } else {
    hide('sfm-preview-more');
  }
}

function sfmStartRun(fromRow) {
  if (!sfmParsedCSV || !sfmCurrentMapping) return;

  const resumeRow = typeof fromRow === 'number' ? fromRow : sfmResumeFromRow;
  let lastRowSeen = resumeRow;

  hide('sfm-step-preview');
  hide('sfm-resume-banner');
  show('sfm-step-run');
  $('sfm-step-run').scrollIntoView({ behavior: 'smooth', block: 'start' });

  const titleMsg = resumeRow > 0 ? `Resuming from row ${resumeRow.toLocaleString()}…` : 'Migrating…';
  setText('sfm-run-title', titleMsg);
  sfmSetProgress('Starting…', 0);
  $('sfm-summary-box').innerHTML = '';
  hide('sfm-summary-box');
  hide('sfm-resume-prompt');
  sfmAppendLogEntry.reset();
  hide('btn-sfm-download-log');
  show('btn-sfm-stop');

  sfmController = subscribeSSE(
    '/api/companies/sf-migration/run',
    {
      csvText:        sfmParsedCSV.raw,
      uuidColumn:     sfmCurrentMapping.uuidCol,
      newSfIdColumn:  sfmCurrentMapping.newIdCol,
      oldSfIdColumn:  sfmCurrentMapping.oldIdCol,
      textFieldId:    sfmCurrentMapping.textFieldId,
      resumeFromRow:  resumeRow,
    },
    {
      onProgress: ({ message, percent, detail }) => {
        sfmSetProgress(message, percent);
        if (detail?.row) lastRowSeen = detail.row;
      },
      onLog:        (entry) => sfmAppendLogEntry(entry),
      onCheckpoint: ({ row }) => sfmSaveCheckpoint(sfmCheckpointKey, row),

      onComplete: (data) => {
        sfmClearCheckpoint(sfmCheckpointKey);
        sfmResumeFromRow = 0;
        hide('btn-sfm-stop');
        hide('sfm-resume-prompt');
        sfmSetProgress(data.stopped ? 'Migration stopped' : 'Migration complete', 100);
        setText('sfm-run-title', data.stopped ? 'Migration stopped' : 'Migration complete');
        sfmRenderSummary(data);
        show('btn-sfm-download-log');
      },

      onError: (msg) => {
        hide('btn-sfm-stop');
        hide('sfm-resume-prompt');
        setText('sfm-run-title', 'Migration failed');
        $('sfm-summary-box').innerHTML = `
          <div class="alert alert-danger">
            <span class="alert-icon">⚠️</span>
            <span>${esc(msg)}</span>
          </div>`;
        show('sfm-summary-box');
        show('btn-sfm-download-log');
      },

      onAbort: () => {
        // Save checkpoint using last row we received before connection closed
        if (lastRowSeen > resumeRow) sfmSaveCheckpoint(sfmCheckpointKey, lastRowSeen);
        sfmResumeFromRow = lastRowSeen;
        hide('btn-sfm-stop');
        setText('sfm-run-title', 'Migration stopped');
        sfmSetProgress('Stopped by user', 100);
        sfmController = null;
        show('btn-sfm-download-log');
        if (sfmResumeFromRow > 0) {
          setText('sfm-resume-prompt-row', sfmResumeFromRow.toLocaleString());
          show('sfm-resume-prompt');
        }
      },
    }
  );
}

function sfmSetProgress(msg, pct) {
  setText('sfm-progress-msg', msg);
  setText('sfm-progress-pct', `${pct}%`);
  $('sfm-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

function sfmRenderSummary({ total, migrated, partial, errors, skipped, stopped }) {
  const hasIssues  = errors > 0 || partial > 0 || stopped;
  const alertClass = hasIssues ? 'alert-warn' : 'alert-ok';
  const icon       = hasIssues ? '⚠️' : '✅';
  const parts = [`${migrated} migrated`];
  if (partial > 0) parts.push(`${partial} partial (one API call failed)`);
  if (errors  > 0) parts.push(`${errors} error(s)`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (stopped)     parts.push('stopped by user');
  parts.push(`${total} rows total`);

  $('sfm-summary-box').innerHTML = `
    <div class="alert ${alertClass}">
      <span class="alert-icon">${icon}</span>
      <span>${parts.join(' · ')}</span>
    </div>`;
  show('sfm-summary-box');
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
  $('btn-co-skip-all').addEventListener('click', () => {
    $('co-mapping-rows').querySelectorAll('select').forEach((sel) => { sel.value = ''; });
    saveCompaniesMapping();
    checkUnmappedWarning();
  });
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
  $('btn-stop-companies-delete-all').addEventListener('click', () => {
    if (companiesDeleteAllController) { companiesDeleteAllController.abort(); companiesDeleteAllController = null; }
  });
  $('btn-companies-delete-all-again').addEventListener('click', () => {
    $('companies-delete-all-confirm-input').value = '';
    $('btn-companies-delete-all-run').disabled = true;
    hide('companies-delete-all-running');
    hide('companies-delete-all-results');
    show('companies-delete-all-idle');
  });

  // ── SF Instance Migration ────────────────────────────────
  ({ clear: clearSfmDropzone } = wireDropzone(
    $('sfm-dropzone'), $('sfm-file-input'),
    (file) => sfmLoadCSV(file),
    () => {
      sfmParsedCSV = null;
      hide('sfm-step-map');
      hide('sfm-step-preview');
      hide('sfm-step-run');
    }
  ));
  $('btn-sfm-reupload').addEventListener('click', () => {
    sfmParsedCSV = null;
    sfmCurrentMapping = null;
    if (clearSfmDropzone) clearSfmDropzone();
    hide('sfm-step-map');
    hide('sfm-step-preview');
    hide('sfm-step-run');
  });
  $('sfm-old-id-col').addEventListener('change', sfmUpdateOldIdToggle);
  $('sfm-move-old-id').addEventListener('change', sfmUpdateTextFieldToggle);
  $('btn-sfm-preview').addEventListener('click', sfmBuildPreview);
  $('btn-sfm-back-to-map').addEventListener('click', () => {
    hide('sfm-step-preview');
    show('sfm-step-map');
  });
  $('btn-sfm-run').addEventListener('click', () => requireToken(sfmStartRun));
  $('btn-sfm-resume-run').addEventListener('click', () => requireToken(() => sfmStartRun(sfmResumeFromRow)));
  $('btn-sfm-new-run').addEventListener('click', () => {
    sfmClearCheckpoint(sfmCheckpointKey);
    sfmResumeFromRow = 0;
    hide('sfm-resume-prompt');
    sfmStartRun(0);
  });
  $('btn-sfm-checkpoint-discard').addEventListener('click', () => {
    sfmClearCheckpoint(sfmCheckpointKey);
    sfmResumeFromRow = 0;
    hide('sfm-checkpoint-notice');
    $('btn-sfm-run').innerHTML = '🔀 Run migration';
  });
  $('btn-sfm-stop').addEventListener('click', () => {
    if (sfmController) { sfmController.abort(); sfmController = null; }
  });
  $('btn-sfm-download-log').addEventListener('click', () => {
    downloadLogCsv(sfmAppendLogEntry, 'sf-migration');
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
  // If the SF migration text-field section is visible but fields never loaded, retry now
  const sfmSection = $('sfm-text-field-section');
  if (sfmSection && !sfmSection.classList.contains('hidden') && sfmTextFields.length === 0) {
    sfmLoadTextFields();
  }
});
