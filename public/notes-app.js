/* =========================================================
   PBToolkit — Notes module
   ========================================================= */

// ── Module state ────────────────────────────────────────────
const NOTES_MAPPING_KEY = 'notes-mapping';
let notesMappingChangeListenerAdded = false;
let clearNotesDropzone        = null;
let clearNotesDeleteDropzone  = null;
let clearNotesMigrateDropzone = null;

// Called by app.js disconnect handler
function resetNotesState() {
  if (clearNotesDropzone)        clearNotesDropzone();
  if (clearNotesDeleteDropzone)  clearNotesDeleteDropzone();
  if (clearNotesMigrateDropzone) clearNotesMigrateDropzone();
  resetNotesExport();
  ['notes-import-step-map', 'notes-import-step-options', 'notes-import-step-validate', 'notes-import-step-run',
   'notes-import-summary-box', 'notes-migrate-done'].forEach((id) => {
    const el = $(id); if (el) el.classList.add('hidden');
  });
}

// ── Notes mapping persistence ────────────────────────────────
function saveNotesMapping() {
  try { localStorage.setItem(NOTES_MAPPING_KEY, JSON.stringify(buildNotesMapping())); } catch (_) {}
}

function restoreNotesMapping() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(NOTES_MAPPING_KEY)); } catch (_) { return; }
  if (!saved) return;

  for (const f of NOTES_FIELDS) {
    const value = saved[f.key];
    const sel = $(f.id);
    // Only restore if the saved column header exists in the current CSV options
    if (sel && value && [...sel.options].some((o) => o.value === value)) sel.value = value;
  }
}

// ══════════════════════════════════════════════════════════
// NOTES — Export
// ══════════════════════════════════════════════════════════

let lastNotesExportCSV = null;
let lastNotesExportFilename = 'notes.csv';
let notesExportCtrl = null;

function resetNotesExport() {
  show('notes-export-idle');
  hide('notes-export-running');
  hide('notes-export-stopped');
  hide('notes-export-done');
  hide('notes-export-error');
}


function resolveNotesDateFilter() {
  const mode = document.querySelector('input[name="notes-date-filter"]:checked')?.value;
  if (!mode || mode === 'none') return {};

  if (mode === 'range') {
    const from = document.getElementById('notes-filter-from').value;  // 'YYYY-MM-DD' or ''
    const to   = document.getElementById('notes-filter-to').value;
    return {
      createdFrom: from ? `${from}T00:00:00Z` : undefined,
      createdTo:   to   ? `${to}T23:59:59Z`   : undefined,
    };
  }

  if (mode === 'dynamic') {
    const n      = parseInt(document.getElementById('notes-filter-n').value, 10) || 7;
    const period = document.getElementById('notes-filter-period').value;
    const now    = new Date();
    const from   = new Date(now);
    if (period === 'days')   from.setDate(now.getDate() - n);
    if (period === 'weeks')  from.setDate(now.getDate() - n * 7);
    if (period === 'months') from.setMonth(now.getMonth() - n);
    return { createdFrom: from.toISOString(), createdTo: now.toISOString() };
  }

  return {};
}

function startNotesExport() {
  const filters = resolveNotesDateFilter();

  if (filters.createdFrom && filters.createdTo && filters.createdFrom > filters.createdTo) {
    hide('notes-export-idle');
    setNotesExportError('"From" date must be before "To" date.');
    return;
  }

  hide('notes-export-idle');
  show('notes-export-running');
  hide('notes-export-stopped');
  hide('notes-export-done');
  hide('notes-export-error');
  setNotesExportProgress('Starting…', 0);

  notesExportCtrl = subscribeSSE('/api/notes/export', filters, {
    onProgress: ({ message, percent }) => setNotesExportProgress(message, percent),
    onComplete: (data) => {
      hide('notes-export-running');
      if (!data.csv && data.count === 0) {
        setNotesExportError('No notes found matching your filters.');
        return;
      }
      lastNotesExportCSV = data.csv;
      lastNotesExportFilename = data.filename || 'notes-export.csv';
      triggerDownload(new Blob([lastNotesExportCSV], { type: 'text/csv;charset=utf-8;' }), lastNotesExportFilename);
      show('notes-export-done');
      setText('notes-export-done-msg', `Exported ${data.count.toLocaleString()} notes. Download started.`);
    },
    onError: (msg) => {
      hide('notes-export-running');
      setNotesExportError(msg);
    },
    onAbort: () => {
      hide('notes-export-running');
      show('notes-export-stopped');
      notesExportCtrl = null;
    },
  });
}


function setNotesExportProgress(msg, pct) {
  setText('notes-export-progress-msg', msg);
  setText('notes-export-progress-pct', `${pct}%`);
  $('notes-export-progress-bar').style.width = `${Math.min(100, pct)}%`;
}

function setNotesExportError(msg) {
  setText('notes-export-error-msg', msg);
  show('notes-export-error');
}


// ══════════════════════════════════════════════════════════
// NOTES — Import Step 1: Upload
// ══════════════════════════════════════════════════════════

let notesParsedCSV = null; // { raw, headers, rowCount }


function loadNotesCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) { alert('CSV file appears empty or has no data rows.'); return; }
    notesParsedCSV = { raw: text, headers: parseCSVHeaders(text), rowCount };
    showNotesMappingStep();
  };
  reader.readAsText(file);
}

// ══════════════════════════════════════════════════════════
// NOTES — Import Step 2: Map columns
// ══════════════════════════════════════════════════════════

const NOTES_FIELDS = [
  { id: 'notes-map-pb-id',          label: 'pb_id',              key: 'pbIdColumn',          required: false, hint: 'Present → update existing · empty → create new' },
  { id: 'notes-map-type',           label: 'Note Type',          key: 'typeColumn',           required: false, hint: 'simple, conversation, or opportunity' },
  { id: 'notes-map-title',          label: 'Title',              key: 'titleColumn',          required: false, hint: 'Required when creating new notes (rows without a valid pb_id)' },
  { id: 'notes-map-content',        label: 'Content',            key: 'contentColumn',        required: false },
  { id: 'notes-map-display-url',    label: 'Display URL',        key: 'displayUrlColumn',     required: false },
  { id: 'notes-map-user-email',     label: 'User Email',         key: 'userEmailColumn',      required: false },
  { id: 'notes-map-company-domain', label: 'Company Domain',     key: 'companyDomainColumn',  required: false, hint: 'Used when user_email is not set' },
  { id: 'notes-map-owner-email',    label: 'Owner Email',        key: 'ownerEmailColumn',     required: false },
  { id: 'notes-map-creator-email',  label: 'Creator Email',      key: 'creatorEmailColumn',   required: false, hint: 'Set via v2 backfill after creation' },
  { id: 'notes-map-tags',           label: 'Tags',               key: 'tagsColumn',           required: false, hint: 'Comma-separated list' },
  { id: 'notes-map-source-origin',  label: 'Source Origin',      key: 'sourceOriginColumn',   required: false },
  { id: 'notes-map-source-record',  label: 'Source Record ID',   key: 'sourceRecordIdColumn', required: false },
  { id: 'notes-map-archived',       label: 'Archived',           key: 'archivedColumn',       required: false, hint: 'TRUE/FALSE — set via v2 backfill' },
  { id: 'notes-map-processed',      label: 'Processed',          key: 'processedColumn',      required: false, hint: 'TRUE/FALSE — set via v2 backfill' },
  { id: 'notes-map-linked-ents',    label: 'Linked Entities',    key: 'linkedEntitiesColumn', required: false, hint: 'Comma-separated feature/component UUIDs' },
];

const NOTES_AUTODETECT = {
  'notes-map-pb-id':          ['pb_id', 'pb note id', 'note id', 'uuid'],
  'notes-map-type':           ['type', 'note type'],
  'notes-map-title':          ['title', 'name', 'subject'],
  'notes-map-content':        ['content', 'body', 'description'],
  'notes-map-display-url':    ['display_url', 'display url', 'url'],
  'notes-map-user-email':     ['user_email', 'user email', 'email'],
  'notes-map-company-domain': ['company_domain', 'company domain', 'domain'],
  'notes-map-owner-email':    ['owner_email', 'owner email'],
  'notes-map-creator-email':  ['creator_email', 'creator email'],
  'notes-map-tags':           ['tags'],
  'notes-map-source-origin':  ['source_origin', 'source origin'],
  'notes-map-source-record':  ['source_record_id', 'source record id'],
  'notes-map-archived':       ['archived'],
  'notes-map-processed':      ['processed'],
  'notes-map-linked-ents':    ['linked_entities', 'linked entities', 'features'],
};

function showNotesMappingStep() {
  hide('notes-import-step-validate');
  hide('notes-import-step-run');
  show('notes-import-step-map');
  show('notes-import-step-options'); // Options panel always shows alongside map panel
  setText('notes-map-subtitle', `${notesParsedCSV.rowCount} rows · ${notesParsedCSV.headers.length} columns`);
  buildNotesMappingTable();
}

function buildNotesMappingTable() {
  const tbody = $('notes-field-map-rows');
  tbody.innerHTML = '';

  for (const f of NOTES_FIELDS) {
    const tr = document.createElement('tr');
    const opts = (f.required ? '' : '<option value="">(⇢ skip)</option>') +
      notesParsedCSV.headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');
    const reqBadge = f.required ? ' <span class="badge badge-danger">required</span>' : '';
    tr.innerHTML = `
      <td>
        ${esc(f.label)}${reqBadge}${f.hint ? ` <span class="info-icon" data-tip="${esc(f.hint)}">i</span>` : ''}
      </td>
      <td><select id="${f.id}">${opts}</select></td>
    `;
    tbody.appendChild(tr);
  }

  // Auto-detect
  for (const [selectId, candidates] of Object.entries(NOTES_AUTODETECT)) {
    const sel = $(selectId);
    if (!sel) continue;
    for (const c of candidates) {
      const match = notesParsedCSV.headers.find((h) => h.toLowerCase() === c);
      if (match) { sel.value = match; break; }
    }
  }

  restoreNotesMapping(); // saved values override auto-detect

  // Add change listener once — delegate from the stable tbody element
  if (!notesMappingChangeListenerAdded) {
    $('notes-field-map-rows').addEventListener('change', saveNotesMapping);
    notesMappingChangeListenerAdded = true;
  }
}

function buildNotesMapping() {
  const mapping = {};
  for (const f of NOTES_FIELDS) {
    mapping[f.key] = $(f.id)?.value || null;
  }
  return mapping;
}

function validateNotesRequiredMappings(mapping) {
  if (!mapping.titleColumn) { alert('Please map the "Title" column before continuing.'); return false; }
  return true;
}



// ══════════════════════════════════════════════════════════
// NOTES — Import Step 3: Validate
// ══════════════════════════════════════════════════════════

async function runNotesValidation(mapping) {
  show('notes-import-step-validate');
  $('notes-import-step-validate').scrollIntoView({ behavior: 'smooth', block: 'start' });
  hide('notes-validate-ok');
  hide('notes-validate-errors');

  try {
    const res = await fetch('/api/notes/import/preview', {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ csvText: notesParsedCSV.raw, mapping }),
    });
    const data = await res.json();

    if (data.valid) {
      setText('notes-validate-ok-msg', `All ${data.totalRows} rows passed validation. Ready to import.`);

      // Show warnings if any
      if (data.warnings?.length) {
        setText('notes-validate-warnings-summary', `${data.warnings.length} warning(s) — import will still proceed`);
        const tbody = $('notes-validate-warning-rows');
        tbody.innerHTML = '';
        for (const w of data.warnings) {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td>${w.row ?? '—'}</td><td><span class="col-tag">${esc(w.field || '')}</span></td><td class="text-muted">${esc(w.message)}</td>`;
          tbody.appendChild(tr);
        }
        show('notes-validate-warnings-section');
      } else {
        hide('notes-validate-warnings-section');
      }

      show('notes-validate-ok');
    } else {
      setText('notes-validate-error-summary', `${data.errors.length} error(s) in ${data.totalRows} rows. Fix and re-upload.`);
      const tbody = $('notes-validate-error-rows');
      tbody.innerHTML = '';
      for (const e of data.errors) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${e.row ?? '—'}</td><td><span class="col-tag">${esc(e.field || '')}</span></td><td class="text-danger">${esc(e.message)}</td>`;
        tbody.appendChild(tr);
      }
      show('notes-validate-errors');
    }
  } catch (e) {
    setText('notes-validate-error-summary', `Validation failed: ${e.message}`);
    show('notes-validate-errors');
  }
}


// ══════════════════════════════════════════════════════════
// NOTES — Import Step 4: Run
// ══════════════════════════════════════════════════════════

let notesImportController = null;

// Log appender for notes import — bound to notes log DOM IDs.
// Uses shared makeLogAppender() defined in app.js.
const appendNotesLogEntry = makeLogAppender('notes-import-live-log', 'notes-live-log-entries', 'notes-live-log-counts', 'note');

function runNotesImport(mapping) {
  // Reset log for fresh run
  appendNotesLogEntry.reset();
  hide('btn-notes-download-log');
  // Reset summary box
  $('notes-import-summary-box').innerHTML = '';
  hide('notes-import-summary-box');
  hide('notes-import-step-validate');
  show('notes-import-step-run');
  $('notes-import-step-run').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setText('notes-import-run-title', 'Importing notes…');
  setNotesImportProgress('Starting…', 0);
  show('btn-stop-notes-import');

  const migrationMode = $('notes-migration-mode').checked;
  const migrationFieldName = migrationMode
    ? ($('notes-migration-field-name').value.trim() || 'original_uuid')
    : 'original_uuid';

  notesImportController = subscribeSSE(
    '/api/notes/import/run',
    { csvText: notesParsedCSV.raw, mapping, migrationMode, migrationFieldName },
    {
      onProgress: ({ message, percent }) => setNotesImportProgress(message, percent),

      // appendNotesLogEntry is the shared makeLogAppender-bound function
      onLog: (entry) => appendNotesLogEntry(entry),

      onComplete: (data) => {
        hide('btn-stop-notes-import');
        setNotesImportProgress(data.stopped ? 'Import stopped' : 'Import complete', 100);
        setText('notes-import-run-title', data.stopped ? 'Import stopped' : 'Import complete');
        // Use shared renderImportComplete for styled alert-ok/warn summary
        renderImportComplete($('notes-import-summary-box'), {
          created: data.created,
          updated: data.updated,
          errors:  data.errors,
          stopped: data.stopped,
          extraText: [
            data.total ? `${data.total} rows` : '',
            data.skipped > 0 ? `${data.skipped} skipped (no fields mapped)` : '',
          ].filter(Boolean).join(' · '),
        });
        show('btn-notes-download-log');
      },

      onError: (msg) => {
        hide('btn-stop-notes-import');
        setText('notes-import-run-title', 'Import failed');
        $('notes-import-summary-box').innerHTML = `
          <div class="alert alert-danger">
            <span class="alert-icon">⚠️</span>
            <span>${esc(msg)}</span>
          </div>`;
        show('notes-import-summary-box');
        appendNotesLogEntry({ level: 'error', message: msg, ts: new Date().toISOString() });
        show('btn-notes-download-log');
      },

      onAbort: () => {
        hide('btn-stop-notes-import');
        setText('notes-import-run-title', 'Import stopped');
        setNotesImportProgress('Import stopped', 100);
        appendNotesLogEntry({ level: 'warn', message: 'Import stopped by user', ts: new Date().toISOString() });
        const c = appendNotesLogEntry.getCounts();
        renderImportComplete($('notes-import-summary-box'), {
          stopped: true,
          created: c.success,
          updated: 0,
          errors:  c.error,
          extraText: '',
        });
        show('btn-notes-download-log');
      },
    }
  );
}


function setNotesImportProgress(msg, pct) {
  setText('notes-import-progress-msg', msg);
  setText('notes-import-progress-pct', `${pct}%`);
  $('notes-import-progress-bar').style.width = `${Math.min(100, pct)}%`;
}


// ══════════════════════════════════════════════════════════
// NOTES — Delete from CSV
// ══════════════════════════════════════════════════════════

let notesDeleteParsedCSV = null;
let notesDeleteController = null;


function loadNotesDeleteCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const headers = parseCSVHeaders(text);
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) { alert('CSV appears empty.'); return; }
    notesDeleteParsedCSV = { raw: text, headers, rowCount };

    // Populate column picker
    const sel = $('notes-delete-uuid-column');
    sel.innerHTML = headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('');

    // Auto-select pb_id column
    const auto = headers.find((h) => ['pb_id', 'pb note id', 'id', 'uuid'].includes(h.toLowerCase()));
    if (auto) sel.value = auto;

    setText('notes-delete-csv-subtitle', `${notesDeleteParsedCSV.rowCount} rows · ${headers.length} columns`);
    updateDeleteCSVPreview();
    show('notes-delete-csv-step-confirm');
  };
  reader.readAsText(file);
}


function updateDeleteCSVPreview() {
  const col = $('notes-delete-uuid-column').value;
  if (!notesDeleteParsedCSV || !col) return;

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const headers = parseCSVHeaders(notesDeleteParsedCSV.raw);
  const colIdx = headers.indexOf(col);
  if (colIdx < 0) return;

  // Extract first 5 valid UUIDs for preview
  const lines = notesDeleteParsedCSV.raw.trim().split('\n').slice(1);
  const uuids = lines
    .map((l) => l.split(',')[colIdx]?.trim().replace(/^"|"$/g, ''))
    .filter((v) => UUID_PATTERN.test(v))
    .slice(0, 5);

  const preview = $('notes-delete-csv-preview');
  if (uuids.length > 0) {
    preview.textContent = `First UUIDs: ${uuids.join(', ')}${lines.length > 5 ? ', …' : ''}`;
    show('notes-delete-csv-preview');
  } else {
    preview.textContent = 'No valid UUIDs found in this column.';
    show('notes-delete-csv-preview');
  }
}


function startNotesDeleteCSV(uuidColumn) {
  hide('notes-delete-csv-step-confirm');
  show('notes-delete-csv-step-run');
  setText('notes-delete-csv-run-title', 'Deleting notes…');
  show('notes-delete-csv-running');
  hide('notes-delete-csv-results');
  setNotesDeleteCSVProgress('Starting…', 0);

  $('notes-delete-csv-log-entries').innerHTML = '';
  hide('notes-delete-csv-live-log');

  show('btn-stop-notes-delete-csv');

  notesDeleteController = subscribeSSE(
    '/api/notes/delete/by-csv',
    { csvText: notesDeleteParsedCSV.raw, uuidColumn },
    {
      onProgress: ({ message, percent }) => setNotesDeleteCSVProgress(message, percent),

      onLog: (entry) => {
        const logEl = $('notes-delete-csv-live-log');
        const entries = $('notes-delete-csv-log-entries');
        if (logEl.classList.contains('hidden')) show('notes-delete-csv-live-log');
        const e = document.createElement('div');
        e.className = `log-entry ${entry.level}`;
        e.innerHTML = `<span class="log-msg">${esc(entry.message)}</span>`;
        entries.appendChild(e);
        entries.scrollTop = entries.scrollHeight;
      },

      onComplete: (data) => {
        hide('btn-stop-notes-delete-csv');
        hide('notes-delete-csv-running');
        show('notes-delete-csv-results');
        setText('notes-delete-csv-run-title', 'Deletion complete');
        const hasErrors = data.errors > 0;
        const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
        const icon = hasErrors ? '⚠️' : '✅';
        $('notes-delete-csv-summary-alert').innerHTML = `
          <div class="alert ${alertClass}"><span class="alert-icon">${icon}</span>
          <span>${data.deleted} deleted · ${data.errors} error(s) · ${data.total} in CSV</span></div>`;
      },

      onError: (msg) => {
        hide('btn-stop-notes-delete-csv');
        hide('notes-delete-csv-running');
        show('notes-delete-csv-results');
        setText('notes-delete-csv-run-title', 'Deletion failed');
        $('notes-delete-csv-summary-alert').innerHTML = `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`;
      },
    }
  );
}

function setNotesDeleteCSVProgress(msg, pct) {
  setText('notes-delete-csv-progress-msg', msg);
  setText('notes-delete-csv-progress-pct', `${pct}%`);
  $('notes-delete-csv-progress-bar').style.width = `${Math.min(100, pct)}%`;
}


// ══════════════════════════════════════════════════════════
// NOTES — Delete All
// ══════════════════════════════════════════════════════════

let notesDeleteAllController = null;


function startNotesDeleteAll() {
  hide('notes-delete-all-idle');
  show('notes-delete-all-running');
  hide('notes-delete-all-results');
  setNotesDeleteAllProgress('Starting…', 0);

  $('notes-delete-all-log-entries').innerHTML = '';
  hide('notes-delete-all-live-log');

  notesDeleteAllController = subscribeSSE(
    '/api/notes/delete/all',
    {},
    {
      onProgress: ({ message, percent }) => setNotesDeleteAllProgress(message, percent),

      onLog: (entry) => {
        const logEl = $('notes-delete-all-live-log');
        const entries = $('notes-delete-all-log-entries');
        if (logEl.classList.contains('hidden')) show('notes-delete-all-live-log');
        const e = document.createElement('div');
        e.className = `log-entry ${entry.level}`;
        e.innerHTML = `<span class="log-msg">${esc(entry.message)}</span>`;
        entries.appendChild(e);
        entries.scrollTop = entries.scrollHeight;
      },

      onComplete: (data) => {
        hide('notes-delete-all-running');
        show('notes-delete-all-results');
        const hasErrors = data.errors > 0;
        const alertClass = hasErrors ? 'alert-warn' : 'alert-ok';
        const icon = hasErrors ? '⚠️' : '✅';
        $('notes-delete-all-summary-alert').innerHTML = `
          <div class="alert ${alertClass}"><span class="alert-icon">${icon}</span>
          <span>${data.deleted} notes deleted · ${data.skipped > 0 ? `${data.skipped} already gone · ` : ''}${data.errors} error(s)</span></div>`;
      },

      onError: (msg) => {
        hide('notes-delete-all-running');
        show('notes-delete-all-results');
        $('notes-delete-all-summary-alert').innerHTML = `<div class="alert alert-danger"><span class="alert-icon">⚠️</span><span>${esc(msg)}</span></div>`;
      },
    }
  );
}

function setNotesDeleteAllProgress(msg, pct) {
  setText('notes-delete-all-progress-msg', msg);
  setText('notes-delete-all-progress-pct', `${pct}%`);
  $('notes-delete-all-progress-bar').style.width = `${Math.min(100, pct)}%`;
}


// ══════════════════════════════════════════════════════════
// NOTES — Migration Prep
// ══════════════════════════════════════════════════════════

let notesMigrateParsedCSV = null;
let notesMigrateResultCSV = null;
let notesMigrateFilename  = 'notes-prepared.csv';


function loadNotesMigrateCSV(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    const rowCount = countCSVDataRows(text);
    if (rowCount === 0) { alert('CSV appears empty.'); return; }
    notesMigrateParsedCSV = { raw: text, rowCount };
    show('notes-migrate-form');
  };
  reader.readAsText(file);
}

// ══════════════════════════════════════════════════════════
// MODULE INIT — called once by app.js after partial is loaded
// ══════════════════════════════════════════════════════════
let _notesInitDone = false;
function initNotesModule() {
  if (_notesInitDone) return;
  _notesInitDone = true;

  // ── Export ──────────────────────────────────────────────
  $('btn-notes-export').addEventListener('click', () => requireToken(startNotesExport));
  $('btn-notes-export-again').addEventListener('click', resetNotesExport);
  $('btn-notes-export-stopped-again').addEventListener('click', resetNotesExport);
  $('btn-notes-export-retry').addEventListener('click', () => requireToken(startNotesExport));
  $('btn-stop-notes-export').addEventListener('click', () => { notesExportCtrl?.abort(); notesExportCtrl = null; });
  $('btn-notes-download-csv').addEventListener('click', () => {
    if (lastNotesExportCSV) triggerDownload(new Blob([lastNotesExportCSV], { type: 'text/csv;charset=utf-8;' }), lastNotesExportFilename);
  });
  document.querySelectorAll('input[name="notes-date-filter"]').forEach(r => {
    r.addEventListener('change', () => {
      hide('notes-filter-range');
      hide('notes-filter-dynamic');
      if (r.value === 'range')   show('notes-filter-range');
      if (r.value === 'dynamic') show('notes-filter-dynamic');
    });
  });

  // ── Import: file upload ──────────────────────────────────
  ({ clear: clearNotesDropzone } = wireDropzone($('notes-dropzone'), $('notes-file-input'), (file) => loadNotesCSV(file), () => {
    notesParsedCSV = null;
    hide('notes-import-step-map'); hide('notes-import-step-options');
    hide('notes-import-step-validate'); hide('notes-import-step-run');
  }));
  $('btn-notes-reupload').addEventListener('click', () => {
    notesParsedCSV = null; if (clearNotesDropzone) clearNotesDropzone();
    hide('notes-import-step-map'); hide('notes-import-step-options');
    hide('notes-import-step-validate'); hide('notes-import-step-run');
  });

  // ── Import: options / validate / run ────────────────────
  $('notes-migration-mode').addEventListener('change', () => {
    if ($('notes-migration-mode').checked) { show('notes-migration-field-row'); }
    else { hide('notes-migration-field-row'); setText('notes-migration-field-status', ''); }
  });
  $('btn-notes-detect-field').addEventListener('click', () => requireToken(async () => {
    const fieldName = $('notes-migration-field-name').value.trim();
    if (!fieldName) { alert('Enter a field name first.'); return; }
    const btn = $('btn-notes-detect-field');
    const statusEl = $('notes-migration-field-status');
    btn.disabled = true; setText('notes-migration-field-status', 'Checking…');
    try {
      const res = await fetch('/api/notes/detect-migration-field', {
        method: 'POST', headers: buildHeaders(), body: JSON.stringify({ fieldName }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        statusEl.textContent = `Error: ${data.error || res.status}`;
        statusEl.style.color = 'var(--color-danger, #e53e3e)';
      } else if (data.found) {
        statusEl.textContent = `✅ Found — text field "${data.fieldName}" exists on entities`;
        statusEl.style.color = 'var(--color-success, #38a169)';
      } else {
        statusEl.textContent = `❌ Not found — no text field named "${data.fieldName}" on entities`;
        statusEl.style.color = 'var(--color-danger, #e53e3e)';
      }
    } catch (e) {
      statusEl.textContent = `Error: ${e.message}`;
      statusEl.style.color = 'var(--color-danger, #e53e3e)';
    } finally { btn.disabled = false; }
  }));
  $('btn-notes-validate').addEventListener('click', () => requireToken(() => {
    const mapping = buildNotesMapping();
    if (!validateNotesRequiredMappings(mapping)) return;
    runNotesValidation(mapping);
  }));
  $('btn-notes-run-import').addEventListener('click', () => requireToken(() => {
    const mapping = buildNotesMapping();
    if (!validateNotesRequiredMappings(mapping)) return;
    runNotesImport(mapping);
  }));
  $('btn-notes-back-to-map2').addEventListener('click', () => hide('notes-import-step-validate'));
  $('btn-notes-download-log').addEventListener('click', () => downloadLogCsv(appendNotesLogEntry, 'notes-import'));
  $('btn-stop-notes-import').addEventListener('click', () => {
    if (notesImportController) { notesImportController.abort(); notesImportController = null; }
    hide('btn-stop-notes-import');
  });

  // ── Delete from CSV ───────────────────────────────────────
  ({ clear: clearNotesDeleteDropzone } = wireDropzone($('notes-delete-dropzone'), $('notes-delete-file-input'), (file) => loadNotesDeleteCSV(file), () => {
    notesDeleteParsedCSV = null;
    hide('notes-delete-csv-step-confirm');
  }));
  $('notes-delete-uuid-column').addEventListener('change', updateDeleteCSVPreview);
  $('btn-notes-delete-reupload').addEventListener('click', () => {
    notesDeleteParsedCSV = null; if (clearNotesDeleteDropzone) clearNotesDeleteDropzone();
    hide('notes-delete-csv-step-confirm'); hide('notes-delete-csv-step-run');
  });
  $('btn-notes-delete-csv-run').addEventListener('click', () => requireToken(() => {
    const col = $('notes-delete-uuid-column').value;
    if (!col || !notesDeleteParsedCSV) return;
    startNotesDeleteCSV(col);
  }));
  $('btn-stop-notes-delete-csv').addEventListener('click', () => {
    if (notesDeleteController) { notesDeleteController.abort(); notesDeleteController = null; }
    hide('btn-stop-notes-delete-csv');
  });
  $('btn-notes-delete-csv-again').addEventListener('click', () => {
    notesDeleteParsedCSV = null; if (clearNotesDeleteDropzone) clearNotesDeleteDropzone();
    hide('notes-delete-csv-step-confirm'); hide('notes-delete-csv-step-run');
  });

  // ── Delete all ────────────────────────────────────────────
  $('notes-delete-all-confirm-input').addEventListener('input', (e) => {
    $('btn-notes-delete-all-run').disabled = e.target.value.trim() !== 'DELETE';
  });
  $('btn-notes-delete-all-run').addEventListener('click', () => requireToken(() => {
    if ($('notes-delete-all-confirm-input').value.trim() !== 'DELETE') return;
    startNotesDeleteAll();
  }));
  $('btn-notes-delete-all-again').addEventListener('click', () => {
    $('notes-delete-all-confirm-input').value = '';
    $('btn-notes-delete-all-run').disabled = true;
    hide('notes-delete-all-running'); hide('notes-delete-all-results'); show('notes-delete-all-idle');
  });

  // ── Migration prep ────────────────────────────────────────
  ({ clear: clearNotesMigrateDropzone } = wireDropzone($('notes-migrate-dropzone'), $('notes-migrate-file-input'), (file) => loadNotesMigrateCSV(file), () => {
    notesMigrateParsedCSV = null;
    hide('notes-migrate-form');
  }));
  $('btn-notes-migrate-run').addEventListener('click', () => requireToken(async () => {
    if (!notesMigrateParsedCSV) { alert('Upload a CSV first.'); return; }
    const sourceOriginName = $('notes-migrate-source-name').value.trim();
    if (!sourceOriginName) { alert('Enter a migration source name.'); return; }
    $('btn-notes-migrate-run').disabled = true;
    try {
      const res = await fetch('/api/notes/migrate-prep', {
        method: 'POST', headers: buildHeaders(),
        body: JSON.stringify({ csvText: notesMigrateParsedCSV.raw, sourceOriginName }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        hide('notes-migrate-idle');
        setText('notes-migrate-error-msg', data.error || `HTTP ${res.status}`);
        show('notes-migrate-error');
        return;
      }
      notesMigrateResultCSV = data.csv;
      const date = new Date().toISOString().slice(0, 10);
      notesMigrateFilename = `notes-migration-${sourceOriginName.replace(/[^a-zA-Z0-9-_]/g, '_')}-${date}.csv`;
      triggerDownload(new Blob([notesMigrateResultCSV], { type: 'text/csv;charset=utf-8;' }), notesMigrateFilename);
      hide('notes-migrate-idle'); hide('notes-migrate-error');
      setText('notes-migrate-done-msg', `${data.count} notes prepared for migration. Download started — import into the target workspace.`);
      show('notes-migrate-done');
    } catch (e) {
      setText('notes-migrate-error-msg', e.message);
      show('notes-migrate-error'); hide('notes-migrate-done');
    } finally { $('btn-notes-migrate-run').disabled = false; }
  }));
  $('btn-notes-migrate-download').addEventListener('click', () => {
    if (notesMigrateResultCSV) triggerDownload(new Blob([notesMigrateResultCSV], { type: 'text/csv;charset=utf-8;' }), notesMigrateFilename);
  });
  $('btn-notes-migrate-again').addEventListener('click', () => {
    notesMigrateParsedCSV = null; notesMigrateResultCSV = null;
    if (clearNotesMigrateDropzone) clearNotesMigrateDropzone();
    hide('notes-migrate-form'); hide('notes-migrate-done'); hide('notes-migrate-error'); show('notes-migrate-idle');
  });
  $('btn-notes-migrate-retry').addEventListener('click', () => {
    hide('notes-migrate-error'); show('notes-migrate-idle');
  });
}
window.initNotesModule = initNotesModule;

// ── pb:disconnect / pb:connected ───────────────────────────
window.addEventListener('pb:disconnect', resetNotesState);
