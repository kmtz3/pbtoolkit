# Module Creation Guide

Complete reference for creating, structuring, and styling new PBToolkit frontend modules and wiring them to backend routes. Follow every section in order when building a new module.

Last updated: 2026-04-01.

---

## Table of Contents

1. [Overview — what makes a module](#1-overview)
2. [Step 1: Backend route file](#2-backend-route)
3. [Step 2: Register route in server.js](#3-register-route)
4. [Step 3: HTML partial (view template)](#4-html-partial)
5. [Step 4: Frontend JS module](#5-frontend-js)
6. [Step 5: Register in app.js routing tables](#6-routing-tables)
7. [Step 6: Sidebar nav in index.html](#7-sidebar-nav)
8. [Step 7: Tool card in index.html](#8-tool-card)
9. [Step 8: Wire loadTool() and showView()](#9-wire-loadtool)
10. [Step 9: Add script tag to index.html](#10-script-tag)
11. [HTML component patterns](#11-html-patterns)
12. [CSS design tokens and component classes](#12-css-reference)
13. [Shared JS helpers reference](#13-js-helpers)
14. [SSE pattern (frontend + backend)](#14-sse-pattern)
15. [Common workflows](#15-common-workflows)
16. [Checklist](#16-checklist)

---

<a id="1-overview"></a>
## 1. Overview — what makes a module

A PBToolkit module consists of:

| Layer | File(s) | Purpose |
|-------|---------|---------|
| **Backend route** | `src/routes/{module}.js` | Express router with API endpoints |
| **HTML partial** | `public/views/{module}.html` | View template, lazy-loaded into `#view-area` |
| **Frontend JS** | `public/{module}-app.js` | Event wiring, state, SSE subscription |
| **Registration** | `public/app.js` + `public/index.html` | Routing tables, sidebar nav, tool card, script tag |

A **module** is a top-level tool card on the home screen. Each module can have multiple **submodules** (sidebar tabs), each with its own view panel inside the HTML partial.

Some modules combine multiple backend routes and frontend JS files under one tool card (e.g., Teams = teams-crud + team-membership + members-teams-mgmt). Each sub-file still follows the same patterns.

---

<a id="2-backend-route"></a>
## 2. Step 1: Backend route file

Create `src/routes/{module}.js`:

```js
const express = require('express');
const { pbAuth } = require('../middleware/pbAuth');
const { startSSE } = require('../lib/sse');
const { parseApiError } = require('../lib/errorUtils');
const { parseCSV, generateCSVFromColumns } = require('../lib/csvUtils');

const router = express.Router();

// ── Simple GET endpoint (no SSE) ──────────────────────────
router.get('/metadata', pbAuth, async (_req, res) => {
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  try {
    const items = await fetchAllPages('/v2/resource', 'list resources');
    res.json({ data: items });
  } catch (err) {
    res.status(err.status || 500).json({ error: parseApiError(err) });
  }
});

// ── SSE export endpoint ───────────────────────────────────
router.post('/export', pbAuth, async (req, res) => {
  const { pbFetch, withRetry, fetchAllPages } = res.locals.pbClient;
  const sse = startSSE(res);

  try {
    sse.progress('Fetching data…', 5);

    const items = await fetchAllPages('/v2/resource', 'fetch resources');

    for (let i = 0; i < items.length; i++) {
      if (sse.isAborted()) break;          // ← ALWAYS check abort in loops
      sse.progress(`Processing ${i + 1}/${items.length}`, Math.round((i / items.length) * 100));
      // ... process item ...
    }

    const csv = generateCSVFromColumns(items, [
      { key: 'id', label: 'ID' },
      { key: 'name', label: 'Name' },
    ]);
    const filename = `resources-${new Date().toISOString().slice(0, 10)}.csv`;

    sse.complete({ csv, filename, count: items.length });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();                            // ← ALWAYS in finally
  }
});

// ── SSE import endpoint ───────────────────────────────────
router.post('/import/run', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;
  const sse = startSSE(res);

  try {
    const { csvText, mapping, options } = req.body;
    if (!csvText) { sse.error('Missing CSV data'); return; }

    const { headers, rows } = parseCSV(csvText);
    if (!rows.length) { sse.complete({ total: 0, created: 0, updated: 0, errors: 0 }); return; }

    let created = 0, updated = 0, errors = 0;
    const total = rows.length;

    for (let i = 0; i < total; i++) {
      if (sse.isAborted()) break;          // ← check abort every row
      const row = rows[i];
      const pct = Math.round(((i + 1) / total) * 100);
      sse.progress(`Row ${i + 1} of ${total}`, pct);

      try {
        // Build payload from mapping + row
        // POST create or PATCH update
        created++;
        sse.log('success', `Row ${i + 1}: Created`, { uuid: 'xxx', row: i + 1 });
      } catch (err) {
        errors++;
        sse.log('error', `Row ${i + 1}: ${parseApiError(err)}`, { row: i + 1 });
      }
    }

    const stopped = sse.isAborted();
    sse.complete({ total, created, updated, errors, stopped });
  } catch (err) {
    sse.error(parseApiError(err));
  } finally {
    sse.done();
  }
});

module.exports = router;
```

### Key rules

- **Always use `pbAuth` middleware** — gives you `res.locals.pbClient` with `{ pbFetch, withRetry, fetchAllPages }`.
- **Always call `sse.done()` in `finally`** — or the browser SSE connection hangs.
- **Check `sse.isAborted()` at the top of every loop iteration** — this is how the Stop button works.
- **Use `parseApiError(err)`** for user-friendly error messages.
- **Pagination**: use `fetchAllPages(path, label)` for v2 cursor-based APIs; use `paginateOffset(pbFetch, withRetry, path, onPage)` for v1 offset-based APIs.

### SSE helper methods

| Method | Emits event | Purpose |
|--------|-------------|---------|
| `sse.progress(message, percent, detail?)` | `progress` | Update progress bar (0–100) |
| `sse.log(level, message, detail?)` | `log` | Per-row result (`'success'`/`'error'`/`'warn'`/`'info'`) |
| `sse.complete(data)` | `complete` | Final result object |
| `sse.error(message, detail?)` | `error` | Fatal error |
| `sse.done()` | — | Ends the stream |
| `sse.isAborted()` | — | Returns `true` if client disconnected |

---

<a id="3-register-route"></a>
## 3. Step 2: Register route in server.js

In `src/server.js`:

```js
const myModuleRouter = require('./routes/myModule');
app.use('/api/my-module', myModuleRouter);
```

Convention: route prefix is `/api/{kebab-case-module-name}`.

---

<a id="4-html-partial"></a>
## 4. Step 3: HTML partial (view template)

Create `public/views/{module}.html`. This file is fetched by `loadPartial()` and injected into `#view-area`. It is NOT added to `index.html`.

### Outer structure

Every submodule view is wrapped in a `<div id="view-{view-name}">`:

```html
<!-- ── EXPORT VIEW ── -->
<div id="view-mymod-export" class="hidden">
  <!-- panels go here -->
</div>

<!-- ── IMPORT VIEW ── -->
<div id="view-mymod-import" class="hidden">
  <!-- panels go here -->
</div>
```

The first view listed in `DEFAULT_VIEWS` should NOT have `class="hidden"` — but in practice `showView()` handles toggling, so adding `hidden` to all is safe.

### Panel structure (core building block)

```html
<div class="panel">
  <div class="panel-header">
    <h2 class="panel-title">Export resources</h2>
    <div class="panel-subtitle">Download all resources as CSV.</div>
    <details class="howto">
      <summary>How to use</summary>
      <ul>
        <li><strong>Action name</strong> — brief description of what the user does.</li>
        <li><strong>Another action</strong> — another instruction.</li>
      </ul>
    </details>
  </div>
  <hr class="panel-divider mt-12" />
  <div class="panel-body">
    <!-- content -->
  </div>
</div>
```

> **Every submodule panel should include a `<details class="howto">` block** in its `panel-header`, after the `panel-subtitle`. Use `<strong>` for action names, an em-dash to separate, and keep each bullet to one sentence. The `.howto` class (defined in `style.css`) styles the collapsible with a brand-colored chevron. Use `<kbd>` for keyboard keys when relevant.

Multiple panels stack with `mt-16`:

```html
<div class="panel" id="mymod-import-step-upload">...</div>
<div class="panel mt-16 hidden" id="mymod-import-step-map">...</div>
<div class="panel mt-16 hidden" id="mymod-import-step-run">...</div>
```

### Export view template

```html
<div id="view-mymod-export" class="hidden">
  <div class="panel">
    <div class="panel-header">
      <h2 class="panel-title">Export resources</h2>
      <div class="panel-subtitle">Download all resources as CSV.</div>
      <details class="howto">
        <summary>How to use</summary>
        <ul>
          <li><strong>Export</strong> — click the export button to download all resources as CSV.</li>
          <li><strong>Stop</strong> — use the "Stop" button to cancel a running export.</li>
          <li><strong>Download</strong> — the CSV downloads automatically when complete.</li>
        </ul>
      </details>
    </div>
    <hr class="panel-divider mt-12" />
    <div class="panel-body">

      <!-- IDLE state -->
      <div id="mymod-export-idle">
        <p class="text-sm text-muted">Click below to export all resources.</p>
        <button class="btn btn-primary mt-16" id="btn-mymod-export">📤 Export</button>
      </div>

      <!-- RUNNING state -->
      <div id="mymod-export-running" class="hidden">
        <div class="progress-wrap">
          <div class="progress-bar" id="mymod-export-progress-bar" style="width:0%"></div>
        </div>
        <div class="progress-label">
          <span id="mymod-export-progress-msg">Starting…</span>
          <span id="mymod-export-progress-pct">0%</span>
        </div>
        <button class="btn btn-danger btn-sm mt-8" id="btn-mymod-stop-export">⏹ Stop</button>
      </div>

      <!-- STOPPED state -->
      <div id="mymod-export-stopped" class="hidden">
        <div class="alert alert-warn">
          <span class="alert-icon">⏹</span>
          <span>Export stopped by user.</span>
        </div>
        <button class="btn btn-secondary mt-16" id="btn-mymod-export-stopped-again">Export again</button>
      </div>

      <!-- DONE state -->
      <div id="mymod-export-done" class="hidden">
        <div class="alert alert-ok">
          <span class="alert-icon">✅</span>
          <span id="mymod-export-done-msg"></span>
        </div>
        <button class="btn btn-primary mt-16" id="btn-mymod-download-csv">⬇ Download CSV</button>
        <button class="btn btn-secondary mt-8" id="btn-mymod-export-again">Export again</button>
      </div>

      <!-- ERROR state -->
      <div id="mymod-export-error" class="hidden">
        <div class="alert alert-danger">
          <span class="alert-icon">⚠️</span>
          <span id="mymod-export-error-msg"></span>
        </div>
        <button class="btn btn-secondary mt-12" id="btn-mymod-export-retry">Try again</button>
      </div>

    </div>
  </div>
</div>
```

### Import view template (multi-step wizard)

```html
<div id="view-mymod-import" class="hidden">

  <!-- Step 1: Upload CSV -->
  <div class="panel" id="mymod-import-step-upload">
    <div class="panel-header">
      <h2 class="panel-title">Import resources</h2>
      <div class="panel-subtitle">Upload a CSV file to create or update resources.</div>
    </div>
    <hr class="panel-divider mt-12" />
    <div class="panel-body">
      <div class="dropzone" id="mymod-dropzone">
        <span class="dropzone-icon">📄</span>
        <div class="dropzone-label">Drop a CSV file here</div>
        <div class="dropzone-hint">or click to browse</div>
      </div>
      <input type="file" id="mymod-file-input" accept=".csv,text/csv" class="hidden" />
    </div>
  </div>

  <!-- Step 2: Map fields -->
  <div class="panel mt-16 hidden" id="mymod-import-step-map">
    <div class="panel-header">
      <h2 class="panel-title">Map fields</h2>
    </div>
    <hr class="panel-divider mt-12" />
    <div class="panel-body">
      <table class="mapping-table" id="mymod-mapping-table">
        <thead>
          <tr><th>PB Field</th><th>Type</th><th>CSV Column</th></tr>
        </thead>
        <tbody id="mymod-mapping-rows"></tbody>
      </table>
      <button class="btn btn-ghost btn-sm mt-12" id="btn-mymod-reupload">← Upload different file</button>
    </div>
  </div>

  <!-- Step 3: Options + action buttons -->
  <div class="panel mt-16 hidden" id="mymod-import-step-options">
    <div class="panel-header">
      <h3 class="panel-title">Options</h3>
    </div>
    <hr class="panel-divider mt-12" />
    <div class="panel-body">
      <label class="checkbox-row">
        <input type="checkbox" id="mymod-imp-bypass-empty" />
        Bypass empty cells
        <span class="info-icon" data-tip="Skip field update when CSV cell is blank">i</span>
      </label>

      <hr class="panel-divider mt-16" />
      <div class="flex gap-8 mt-16 items-center flex-wrap">
        <button class="btn btn-secondary" id="btn-mymod-validate">✔ Validate</button>
        <button class="btn btn-primary" id="btn-mymod-run-import">📥 Import</button>
        <button class="btn btn-danger btn-sm hidden" id="btn-mymod-stop-import">⏹ Stop</button>
      </div>
    </div>
  </div>

  <!-- Step 4: Validation results -->
  <div class="panel mt-16 hidden" id="mymod-import-step-validate">
    <div class="panel-header">
      <h3 class="panel-title">Validation results</h3>
    </div>
    <hr class="panel-divider mt-12" />
    <div class="panel-body">
      <div id="mymod-validation-results"></div>
    </div>
  </div>

  <!-- Step 5: Import progress + log -->
  <div class="panel mt-16 hidden" id="mymod-import-step-run">
    <div class="panel-header">
      <div class="flex items-center justify-between">
        <h3 class="panel-title" id="mymod-import-run-title">Importing…</h3>
      </div>
    </div>
    <hr class="panel-divider mt-12" />
    <div class="panel-body">
      <div class="progress-wrap">
        <div class="progress-bar" id="mymod-import-progress-bar" style="width:0%"></div>
      </div>
      <div class="progress-label">
        <span id="mymod-import-progress-msg">Starting…</span>
        <span id="mymod-import-progress-pct">0%</span>
      </div>

      <!-- Live log -->
      <div id="mymod-import-live-log" class="live-log hidden mt-16">
        <div class="live-log-header">
          <span>Live log</span>
          <span id="mymod-live-log-counts" class="live-log-counts"></span>
          <button id="btn-mymod-import-download-log" class="btn btn-ghost btn-sm hidden" style="margin-left:auto">↓ Download log</button>
        </div>
        <div id="mymod-live-log-entries" class="live-log-scroll"></div>
      </div>

      <!-- Summary (shown after completion) -->
      <div id="mymod-import-summary-box" class="hidden mt-16"></div>
    </div>
  </div>

</div>
```

### Delete from CSV view template

```html
<div id="view-mymod-delete-csv" class="hidden">
  <div class="panel">
    <div class="panel-header">
      <h2 class="panel-title">Delete from CSV</h2>
    </div>
    <hr class="panel-divider mt-12" />
    <div class="panel-body">

      <div class="alert alert-danger mb-16">
        <span class="alert-icon">⚠️</span>
        <span>This action is irreversible. Deleted resources cannot be recovered.</span>
      </div>

      <!-- Upload -->
      <div class="dropzone" id="mymod-delete-dropzone">
        <span class="dropzone-icon">📄</span>
        <div class="dropzone-label">Drop a CSV file with IDs</div>
        <div class="dropzone-hint">or click to browse</div>
      </div>
      <input type="file" id="mymod-delete-file-input" accept=".csv,text/csv" class="hidden" />
    </div>
  </div>

  <!-- Confirm column -->
  <div class="panel mt-16 hidden" id="mymod-delete-csv-step-confirm">
    <div class="panel-body">
      <label class="text-sm font-semibold">ID column:</label>
      <select id="mymod-delete-uuid-column" class="mt-4" style="width:100%"></select>
      <div id="mymod-delete-csv-preview" class="mt-8 text-sm text-muted"></div>
      <div class="flex gap-8 mt-16">
        <button class="btn btn-danger" id="btn-mymod-delete-csv-run">🗑️ Delete</button>
        <button class="btn btn-ghost btn-sm" id="btn-mymod-delete-reupload">← Different file</button>
      </div>
    </div>
  </div>

  <!-- Progress + results -->
  <div class="panel mt-16 hidden" id="mymod-delete-csv-step-run">
    <div class="panel-body">
      <div class="progress-wrap">
        <div class="progress-bar" id="mymod-delete-progress-bar" style="width:0%"></div>
      </div>
      <div class="progress-label">
        <span id="mymod-delete-progress-msg">Starting…</span>
        <span id="mymod-delete-progress-pct">0%</span>
      </div>
      <button class="btn btn-danger btn-sm hidden" id="btn-stop-mymod-delete-csv">⏹ Stop</button>

      <div id="mymod-delete-csv-live-log" class="live-log hidden mt-16">
        <div class="live-log-header">
          <span>Live log</span>
        </div>
        <div id="mymod-delete-csv-log-entries" class="live-log-scroll"></div>
      </div>

      <div id="mymod-delete-csv-results" class="hidden mt-16"></div>
      <button class="btn btn-ghost btn-sm hidden mt-8" id="btn-mymod-delete-download-log">↓ Download log</button>
    </div>
  </div>
</div>
```

### ID prefix convention

Every element ID in a module partial MUST be prefixed to avoid collisions with other modules. Existing prefixes:

| Module | Prefix examples |
|--------|-----------------|
| Companies | `export-`, `import-`, `companies-delete-` |
| Users | `users-export-`, `users-import-`, `users-delete-` |
| Notes | `notes-export-`, `notes-import-`, `notes-delete-` |
| Entities | `ent-export-`, `ent-import-`, `ent-delete-` |
| Member Activity | `ma-` |
| Teams CRUD | `tc-` |
| Team Membership | `tm-` |

Pick a short, unique prefix for your module and use it consistently.

---

<a id="5-frontend-js"></a>
## 5. Step 4: Frontend JS module

Create `public/{module}-app.js`. Use the IIFE pattern (preferred for new modules):

```js
/* =========================================================
   PBToolkit — {Module Name} module
   ========================================================= */
(function () {
  'use strict';

  // ── Module state ──────────────────────────────────────────
  let mymodParsedCSV     = null;   // { raw, headers, rowCount }
  let mymodExportCtrl    = null;   // AbortController for export SSE
  let mymodImportCtrl    = null;   // AbortController for import SSE
  let mymodLastExportCSV = null;   // stored CSV blob for re-download
  let mymodLastExportFilename = 'resources.csv';
  let mymodClearImportDropzone = null;

  // ── Reset (called on token disconnect) ────────────────────
  function resetMymodState() {
    if (mymodExportCtrl)  { mymodExportCtrl.abort(); mymodExportCtrl = null; }
    if (mymodImportCtrl)  { mymodImportCtrl.abort(); mymodImportCtrl = null; }
    mymodLastExportCSV = null;
    mymodLastExportFilename = 'resources.csv';
    resetMymodExport();
    // Hide import results but keep CSV/mapping visible
    ['mymod-import-step-validate', 'mymod-import-step-run', 'mymod-import-summary-box'].forEach((id) => {
      const el = $(id); if (el) el.classList.add('hidden');
    });
  }


  // ══════════════════════════════════════════════════════════
  // EXPORT
  // ══════════════════════════════════════════════════════════
  function resetMymodExport() {
    show('mymod-export-idle');
    hide('mymod-export-running');
    hide('mymod-export-stopped');
    hide('mymod-export-done');
    hide('mymod-export-error');
  }

  function startMymodExport() {
    hide('mymod-export-idle');
    hide('mymod-export-stopped');
    hide('mymod-export-done');
    hide('mymod-export-error');
    show('mymod-export-running');
    setMymodExportProgress('Starting…', 0);

    mymodExportCtrl = subscribeSSE('/api/my-module/export', {}, {
      onProgress: ({ message, percent }) => setMymodExportProgress(message, percent),

      onComplete: (data) => {
        hide('mymod-export-running');
        if (!data.csv || data.count === 0) {
          setText('mymod-export-error-msg', 'No resources found.');
          show('mymod-export-error');
          return;
        }
        mymodLastExportCSV = data.csv;
        mymodLastExportFilename = data.filename || 'resources.csv';
        triggerDownload(
          new Blob([mymodLastExportCSV], { type: 'text/csv;charset=utf-8;' }),
          mymodLastExportFilename
        );
        setText('mymod-export-done-msg',
          `Exported ${data.count.toLocaleString()} resources. Download started.`);
        show('mymod-export-done');
      },

      onError: (msg) => {
        hide('mymod-export-running');
        setText('mymod-export-error-msg', msg);
        show('mymod-export-error');
      },

      onAbort: () => {
        hide('mymod-export-running');
        show('mymod-export-stopped');
        mymodExportCtrl = null;
      },
    });
  }

  function setMymodExportProgress(msg, pct) {
    setText('mymod-export-progress-msg', msg);
    setText('mymod-export-progress-pct', `${pct}%`);
    $('mymod-export-progress-bar').style.width = `${Math.min(100, pct)}%`;
  }


  // ══════════════════════════════════════════════════════════
  // IMPORT — CSV load + mapping
  // ══════════════════════════════════════════════════════════
  function loadMymodCSV(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      mymodParsedCSV = {
        raw: text,
        headers: parseCSVHeaders(text),
        rowCount: countCSVDataRows(text),
      };
      // Show mapping step, build mapping table, etc.
      show('mymod-import-step-map');
      show('mymod-import-step-options');
    };
    reader.readAsText(file);
  }


  // ══════════════════════════════════════════════════════════
  // IMPORT — Run
  // ══════════════════════════════════════════════════════════
  const appendMymodLogEntry = makeLogAppender(
    'mymod-import-live-log',     // log container ID
    'mymod-live-log-entries',    // entries container ID
    'mymod-live-log-counts',     // counts badge ID
    'resource'                   // default entity type label
  );

  function runMymodImport() {
    const mapping = buildMymodMapping();

    appendMymodLogEntry.reset();
    hide('btn-mymod-import-download-log');
    $('mymod-import-summary-box').innerHTML = '';
    hide('mymod-import-summary-box');
    hide('mymod-import-step-validate');
    show('mymod-import-step-run');
    $('mymod-import-step-run').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setText('mymod-import-run-title', 'Importing…');
    setMymodImportProgress('Starting…', 0);
    show('btn-mymod-stop-import');

    mymodImportCtrl = subscribeSSE(
      '/api/my-module/import/run',
      { csvText: mymodParsedCSV.raw, mapping },
      {
        onProgress: ({ message, percent }) => setMymodImportProgress(message, percent),

        onLog: (entry) => appendMymodLogEntry(entry),

        onComplete: (data) => {
          hide('btn-mymod-stop-import');
          setMymodImportProgress(data.stopped ? 'Import stopped' : 'Import complete', 100);
          setText('mymod-import-run-title', data.stopped ? 'Import stopped' : 'Import complete');
          renderImportComplete($('mymod-import-summary-box'), {
            created: data.created,
            updated: data.updated,
            errors:  data.errors,
            stopped: data.stopped,
            extraText: data.total ? `${data.total} rows` : '',
          });
          show('btn-mymod-import-download-log');
        },

        onError: (msg) => {
          hide('btn-mymod-stop-import');
          setText('mymod-import-run-title', 'Import failed');
          $('mymod-import-summary-box').innerHTML = `
            <div class="alert alert-danger">
              <span class="alert-icon">⚠️</span>
              <span>${esc(msg)}</span>
            </div>`;
          show('mymod-import-summary-box');
          appendMymodLogEntry({ level: 'error', message: msg, ts: new Date().toISOString() });
          show('btn-mymod-import-download-log');
        },

        onAbort: () => {
          hide('btn-mymod-stop-import');
          setText('mymod-import-run-title', 'Import stopped');
          setMymodImportProgress('Stopped by user', 100);
          appendMymodLogEntry({ level: 'warn', message: 'Import stopped by user', ts: new Date().toISOString() });
          show('btn-mymod-import-download-log');
          mymodImportCtrl = null;
        },
      }
    );
  }

  function setMymodImportProgress(msg, pct) {
    setText('mymod-import-progress-msg', msg);
    setText('mymod-import-progress-pct', `${pct}%`);
    $('mymod-import-progress-bar').style.width = `${Math.min(100, pct)}%`;
  }

  function buildMymodMapping() {
    // Read select values from mapping table and return mapping object
    return {};
  }


  // ══════════════════════════════════════════════════════════
  // INIT (called by app.js after partial is loaded)
  // ══════════════════════════════════════════════════════════
  let _mymodInitDone = false;

  function initMyModuleModule() {
    if (_mymodInitDone) return;             // ← guard: init only once
    _mymodInitDone = true;

    // ── Export ──────────────────────────────────────────────
    $('btn-mymod-export').addEventListener('click', () => requireToken(startMymodExport));
    $('btn-mymod-export-again').addEventListener('click', resetMymodExport);
    $('btn-mymod-export-stopped-again').addEventListener('click', resetMymodExport);
    $('btn-mymod-export-retry').addEventListener('click', resetMymodExport);
    $('btn-mymod-stop-export').addEventListener('click', () => {
      if (mymodExportCtrl) { mymodExportCtrl.abort(); mymodExportCtrl = null; }
    });
    $('btn-mymod-download-csv').addEventListener('click', () => {
      if (mymodLastExportCSV) {
        triggerDownload(
          new Blob([mymodLastExportCSV], { type: 'text/csv;charset=utf-8;' }),
          mymodLastExportFilename
        );
      }
    });

    // ── Import: file upload ──────────────────────────────────
    ({ clear: mymodClearImportDropzone } = wireDropzone(
      $('mymod-dropzone'),
      $('mymod-file-input'),
      (file) => loadMymodCSV(file),
      () => {
        mymodParsedCSV = null;
        hide('mymod-import-step-map');
        hide('mymod-import-step-options');
        hide('mymod-import-step-validate');
        hide('mymod-import-step-run');
        hide('mymod-import-summary-box');
      }
    ));
    $('btn-mymod-reupload').addEventListener('click', () => {
      mymodParsedCSV = null;
      if (mymodClearImportDropzone) mymodClearImportDropzone();
      hide('mymod-import-step-map');
      hide('mymod-import-step-options');
      hide('mymod-import-step-validate');
      hide('mymod-import-step-run');
      hide('mymod-import-summary-box');
    });

    // ── Import: validate + run ──────────────────────────────
    $('btn-mymod-run-import').addEventListener('click', () => requireToken(runMymodImport));
    $('btn-mymod-stop-import').addEventListener('click', () => {
      if (mymodImportCtrl) { mymodImportCtrl.abort(); mymodImportCtrl = null; }
    });
    $('btn-mymod-import-download-log').addEventListener('click', () => {
      downloadLogCsv(appendMymodLogEntry, 'mymod-import');
    });
  }

  // ── Lifecycle events ──────────────────────────────────────
  window.addEventListener('pb:disconnect', resetMymodState);
  window.addEventListener('pb:connected', () => {
    // Optional: reload metadata with new token
  });

  // ── Export to global ──────────────────────────────────────
  window.initMyModuleModule = initMyModuleModule;

})();
```

### Critical rules for frontend JS

1. **Guard init**: `if (_initDone) return;` — prevents double event wiring.
2. **Always provide `onAbort` callback** to `subscribeSSE` — without it, the UI freezes when the user clicks Stop.
3. **Stop button variable must match**: the click handler must reference the same controller variable that `subscribeSSE` returns to. This is the #1 source of broken stop buttons.
4. **Listen for `pb:disconnect`** — reset state, abort controllers, hide result panels.
5. **Use `requireToken(callback)`** — wraps actions that need auth; shows connect modal if no token.
6. **Use global `$`, `show`, `hide`, `setText`** — or define scoped versions within the IIFE.
7. **`makeLogAppender` is called once at module scope** — not inside init or per-run.
8. **Show download log button on error and abort too** — not just on complete.

---

<a id="6-routing-tables"></a>
## 6. Step 5: Register in app.js routing tables

In `public/app.js`, update these objects:

### VALID_TOOLS (~line 250)
```js
const VALID_TOOLS = new Set([
  'entities', 'notes', 'companies',
  'member-activity', 'teams',
  'my-module',                          // ← ADD
]);
```

### PAGE_META (~line 255)
```js
const PAGE_META = {
  // ... existing ...
  'my-module': { title: 'My Module', desc: 'Do things with resources' },
};
```

### DEFAULT_VIEWS (~line 273)
```js
const DEFAULT_VIEWS = {
  // ... existing ...
  'my-module': 'mymod-export',          // ← default submodule view
};
```

### TOOL_VIEWS (~line 281)
```js
const TOOL_VIEWS = {
  // ... existing ...
  'my-module': ['mymod-export', 'mymod-import', 'mymod-delete-csv'],
};
```

---

<a id="7-sidebar-nav"></a>
## 7. Step 6: Sidebar nav in index.html

Add inside the `.sidebar-nav` section of `public/index.html`:

```html
<div id="sidebar-my-module" class="hidden">
  <button class="nav-item active" data-view="mymod-export" id="nav-mymod-export">
    <span class="icon">📤</span> Export
  </button>
  <button class="nav-item" data-view="mymod-import" id="nav-mymod-import">
    <span class="icon">📥</span> Import
  </button>
  <button class="nav-item" data-view="mymod-delete-csv" id="nav-mymod-delete-csv">
    <span class="icon">🗑️</span> Delete from CSV
  </button>
</div>
```

**With submodule categories** (for modules with grouped sections):
```html
<div id="sidebar-my-module" class="hidden">
  <span class="nav-group-label">Data Management</span>
  <button class="nav-item active" data-view="mymod-export">
    <span class="icon">📤</span> Export
  </button>
  <button class="nav-item" data-view="mymod-import">
    <span class="icon">📥</span> Import
  </button>

  <span class="nav-group-label">Cleanup</span>
  <button class="nav-item" data-view="mymod-delete-csv">
    <span class="icon">🗑️</span> Delete from CSV
  </button>
</div>
```

---

<a id="8-tool-card"></a>
## 8. Step 7: Tool card in index.html

Add in the `#home-view` tool grid:

```html
<div class="tool-card" data-tool="my-module">
  <span class="tool-card-icon">🔧</span>
  <h3 class="tool-card-name">My Module</h3>
  <div class="tool-card-desc">Export, import, and manage resources.</div>
</div>
```

For a placeholder (coming soon):
```html
<div class="tool-card tool-card-soon">
  <span class="tool-card-icon">🔧</span>
  <h3 class="tool-card-name">My Module</h3>
  <div class="tool-card-desc">Coming soon.</div>
  <span class="badge badge-muted" style="margin-top:8px">Coming soon</span>
</div>
```

---

<a id="9-wire-loadtool"></a>
## 9. Step 8: Wire loadTool() and showView()

### In loadTool() (~line 466)

Add sidebar toggle:
```js
$('sidebar-my-module').classList.toggle('hidden', toolName !== 'my-module');
```

Add partial loading + init:
```js
if (toolName === 'my-module') {
  await loadPartial('my-module');     // fetches /views/my-module.html
}
// ... in the init section:
if (toolName === 'my-module') {
  window.initMyModuleModule?.();
}
```

For combined modules (multiple partials under one tool card):
```js
if (toolName === 'my-module') {
  await Promise.all([
    loadPartial('my-module-a'),
    loadPartial('my-module-b'),
  ]);
}
if (toolName === 'my-module') {
  window.initMyModuleAModule?.();
  window.initMyModuleBModule?.();
}
```

### In showView() (~line 626)

Add view names to the array:
```js
[
  // ... existing views ...
  'mymod-export', 'mymod-import', 'mymod-delete-csv',   // ← ADD
].forEach((v) => {
  const el = $(`view-${v}`);
  if (el) el.classList.toggle('hidden', v !== view);
});
```

### In the names map in loadTool()

```js
const names = {
  // ... existing ...
  'my-module': 'My Module',
};
```

---

<a id="10-script-tag"></a>
## 10. Step 9: Add script tag to index.html

At the bottom of `index.html`, after `app.js`:

```html
<script src="my-module-app.js"></script>
```

Order: `csv-utils.js` → `app.js` → all module scripts (order among modules doesn't matter).

---

<a id="11-html-patterns"></a>
## 11. HTML component patterns

### Progress bar
```html
<div class="progress-wrap">
  <div class="progress-bar" id="{prefix}-progress-bar" style="width:0%"></div>
</div>
<div class="progress-label">
  <span id="{prefix}-progress-msg">Starting…</span>
  <span id="{prefix}-progress-pct">0%</span>
</div>
```

### Alert blocks
```html
<!-- Success -->
<div class="alert alert-ok">
  <span class="alert-icon">✅</span>
  <span>Operation completed successfully.</span>
</div>

<!-- Warning -->
<div class="alert alert-warn">
  <span class="alert-icon">⚠️</span>
  <span>Some items were skipped.</span>
</div>

<!-- Error -->
<div class="alert alert-danger">
  <span class="alert-icon">⚠️</span>
  <span>Operation failed.</span>
</div>

<!-- Info -->
<div class="alert alert-info">
  <span class="alert-icon">ℹ️</span>
  <span>This will take a few minutes.</span>
</div>
```

### Live log
```html
<div id="{prefix}-live-log" class="live-log hidden mt-16">
  <div class="live-log-header">
    <span>Live log</span>
    <span id="{prefix}-live-log-counts" class="live-log-counts"></span>
    <button id="btn-{prefix}-download-log" class="btn btn-ghost btn-sm hidden" style="margin-left:auto">↓ Download log</button>
  </div>
  <div id="{prefix}-live-log-entries" class="live-log-scroll"></div>
</div>
```

### Dropzone
```html
<div class="dropzone" id="{prefix}-dropzone">
  <span class="dropzone-icon">📄</span>
  <div class="dropzone-label">Drop a CSV file here</div>
  <div class="dropzone-hint">or click to browse</div>
</div>
<input type="file" id="{prefix}-file-input" accept=".csv,text/csv" class="hidden" />
```

### Button groups
```html
<div class="flex gap-8 mt-16 items-center flex-wrap">
  <button class="btn btn-secondary" id="btn-validate">✔ Validate</button>
  <button class="btn btn-primary" id="btn-run">📥 Import</button>
  <button class="btn btn-danger btn-sm hidden" id="btn-stop">⏹ Stop</button>
</div>
```

### Checkbox + info tooltip
```html
<label class="checkbox-row">
  <input type="checkbox" id="{prefix}-option" />
  Option label
  <span class="info-icon" data-tip="Tooltip text explaining the option">i</span>
</label>
```

### Radio group
```html
<label class="label-bold">Mode</label>
<div class="text-sm text-muted mb-8">Explanation text.</div>
<div class="flex flex-col gap-4">
  <label class="radio-label"><input type="radio" name="{prefix}-mode" value="a" checked> Option A</label>
  <label class="radio-label"><input type="radio" name="{prefix}-mode" value="b"> Option B</label>
</div>
```

### Mapping table
```html
<table class="mapping-table">
  <thead>
    <tr><th>PB Field</th><th>Type</th><th>CSV Column</th></tr>
  </thead>
  <tbody id="{prefix}-mapping-rows">
    <!-- JS populates with <tr> for each field -->
  </tbody>
</table>
```

### Validation results table
```html
<div class="result-scroll mt-12">
  <table class="results-table">
    <thead><tr><th>Row</th><th>Column</th><th>Error</th></tr></thead>
    <tbody id="{prefix}-error-rows"></tbody>
  </table>
</div>
```

### Diff preview (for preview-before-import patterns)
```html
<details open style="margin-bottom:12px;">
  <summary style="cursor:pointer;font-weight:600;padding:8px 0;">
    Create (<span id="{prefix}-create-count">0</span> new items)
  </summary>
  <div style="margin-top:8px;overflow-x:auto;">
    <table class="results-table">...</table>
  </div>
</details>
```

---

<a id="12-css-reference"></a>
## 12. CSS design tokens and component classes

### Design tokens (CSS custom properties)

```
--c-brand:       #355E3B    (hunter green — primary interactive)
--c-brand-dark:  #1e3d22    (brand hover)
--c-brand-light: #edf7ee    (brand background tint)
--c-danger:      #c62828    (destructive/error — red)
--c-danger-bg:   #fef2f2    (light red background)
--c-warn:        #c47c00    (warning — orange)
--c-warn-bg:     #fffbeb    (light orange background)
--c-ok:          #2e7d32    (success — green)
--c-ok-bg:       #f0faf0    (light green background)
--c-info:        #1565c0    (info — blue)
--c-info-bg:     #eff6ff    (light blue background)
--c-text:        #111827    (primary text)
--c-muted:       #6b7280    (secondary text)
--c-border:      #e5e7eb    (borders/dividers)
--c-surface:     #ffffff    (card/panel background)
--c-bg:          #f9fafb    (page background)
--r-sm: 3px   --r-md: 5px   --r-lg: 8px
```

### Button classes

| Class | Visual |
|-------|--------|
| `.btn` | Base — inline-flex, 9px 16px padding |
| `.btn-primary` | Green background, white text |
| `.btn-secondary` | White background, gray border |
| `.btn-danger` | Red background, white text |
| `.btn-ghost` | Transparent, muted text |
| `.btn-sm` | Smaller — 6px 12px, 13px font |
| `.btn-xs` | Tiny — 2px 7px, 11px font |
| `.btn-full` | Full width |

### Alert classes

| Class | Use |
|-------|-----|
| `.alert` | Base container (flex, 12px 14px padding) |
| `.alert-ok` | Green left border + green background |
| `.alert-warn` | Orange left border + orange background |
| `.alert-danger` | Red left border + red background |
| `.alert-info` | Blue left border + blue background |

### Badge classes

| Class | Use |
|-------|-----|
| `.badge` | Base (inline-flex, 2px 8px, 12px font) |
| `.badge-ok` | Green |
| `.badge-warn` | Orange |
| `.badge-danger` | Red |
| `.badge-info` | Blue |
| `.badge-muted` | Gray |

### Utility classes

| Class | CSS |
|-------|-----|
| `.hidden` | `display: none !important` |
| `.flex` | `display: flex` |
| `.flex-col` | `flex-direction: column` |
| `.items-center` | `align-items: center` |
| `.justify-between` | `justify-content: space-between` |
| `.gap-8` | `gap: 8px` |
| `.mt-4` / `.mt-8` / `.mt-12` / `.mt-16` / `.mt-20` | margin-top |
| `.mb-8` / `.mb-16` | margin-bottom |
| `.text-sm` | `font-size: 13px` |
| `.text-muted` | `color: var(--c-muted)` |
| `.text-danger` | `color: var(--c-danger)` |
| `.text-ok` | `color: var(--c-ok)` |
| `.font-mono` | `font-family: monospace` |
| `.truncate` | `text-overflow: ellipsis; overflow: hidden` |

---

<a id="13-js-helpers"></a>
## 13. Shared JS helpers reference (app.js globals)

### DOM

| Helper | Signature | Purpose |
|--------|-----------|---------|
| `$` | `$(id) → Element` | `document.getElementById(id)` |
| `show` | `show(id)` | Remove `.hidden` class |
| `hide` | `hide(id)` | Add `.hidden` class |
| `setText` | `setText(id, text)` | Set `.textContent` |
| `esc` | `esc(str) → string` | HTML-escape for safe `innerHTML` |

### Dialogs

| Helper | Signature | Purpose |
|--------|-----------|---------|
| `showAlert` | `showAlert(msg, opts?) → Promise` | Styled alert (replaces `alert()`) |
| `showConfirm` | `showConfirm(msg, opts?) → Promise<boolean>` | Styled confirm (replaces `confirm()`) |

Options: `{ icon, okLabel, cancelLabel, html }`.

### State management

| Helper | Signature | Purpose |
|--------|-----------|---------|
| `createViewState` | `createViewState(prefix, states) → { go, reset, current }` | Mutually exclusive visibility states |
| `setProgress` | `setProgress(prefix, msg, pct)` | Update progress bar + label by ID convention |

`createViewState` expects elements `{prefix}-{state}` in the DOM. `go('running')` shows `{prefix}-running` and hides all others.

### Auth

| Helper | Signature | Purpose |
|--------|-----------|---------|
| `requireToken` | `requireToken(callback)` | Run callback if token exists, else show connect modal |
| `buildHeaders` | `buildHeaders(token?, useEu?) → object` | Build fetch headers with auth |

### SSE

| Helper | Signature | Purpose |
|--------|-----------|---------|
| `subscribeSSE` | `subscribeSSE(url, body, callbacks) → AbortController` | Subscribe to SSE-over-POST stream |

Callbacks: `{ onProgress, onComplete, onError, onLog?, onAbort? }`. **Always provide `onAbort`.**

### File handling

| Helper | Signature | Purpose |
|--------|-----------|---------|
| `wireDropzone` | `wireDropzone(dropzoneEl, fileInputEl, onFile, onClear?) → { clear }` | Wire file drop/select UI |
| `triggerDownload` | `triggerDownload(blob, filename)` | Trigger browser file download |
| `parseCSVHeaders` | `parseCSVHeaders(text) → string[]` | Extract CSV column headers (naive, display only) |
| `countCSVDataRows` | `countCSVDataRows(text) → number` | Count data rows in CSV text |

### Logging

| Helper | Signature | Purpose |
|--------|-----------|---------|
| `makeLogAppender` | `makeLogAppender(logId, entriesId, countsId, entityType) → append` | Create log entry appender |
| `downloadLogCsv` | `downloadLogCsv(appender, filenamePrefix)` | Export log entries as CSV |
| `renderImportComplete` | `renderImportComplete(el, opts)` | Render styled import summary |

`makeLogAppender` returns a function `append({ level, message, detail?, ts })`. Additional methods: `.reset()`, `.getCounts()`, `.getRows()`.

`renderImportComplete` options: `{ created, updated, errors, stopped, extraText?, extraHtml? }`.

---

<a id="14-sse-pattern"></a>
## 14. SSE pattern (frontend + backend)

### How it works end-to-end

1. **Frontend** calls `subscribeSSE(url, body, callbacks)` → returns `AbortController`
2. **Frontend** stores the controller: `myCtrl = subscribeSSE(...)`
3. **Backend** calls `startSSE(res)` → returns SSE helper
4. **Backend** sends events: `sse.progress()`, `sse.log()`, `sse.complete()`
5. **Frontend** receives events → calls `onProgress`, `onLog`, `onComplete`
6. **User clicks Stop** → handler calls `myCtrl.abort()`
7. **Browser** cancels fetch → server detects via `res.on('close')`
8. **Backend** `sse.isAborted()` returns `true` → loop breaks
9. **Backend** sends `sse.complete({ ..., stopped: true })` and `sse.done()`
10. **Frontend** catches `AbortError` → calls `onAbort()` callback

### Critical: the Stop button pattern

```js
// CORRECT — variable names match
let importCtrl = null;

// In SSE subscription:
importCtrl = subscribeSSE('/api/import/run', body, { ... });

// In stop button handler:
$('btn-stop').addEventListener('click', () => {
  if (importCtrl) { importCtrl.abort(); importCtrl = null; }
});
```

```js
// WRONG — this is the #1 bug pattern
let importController = null;
importController = subscribeSSE(...);

// Bug: references wrong variable name!
$('btn-stop').addEventListener('click', () => {
  if (window._importController) { window._importController.abort(); }  // ← WRONG
});
```

---

<a id="15-common-workflows"></a>
## 15. Common workflows

### Export-only module (simplest)

Files needed:
- `src/routes/mymod.js` — one `POST /export` SSE endpoint
- `public/views/mymod.html` — one view with idle/running/stopped/done/error states
- `public/mymod-app.js` — export function + init
- Registrations in `app.js` + `index.html`

### Export + Import module (standard)

Files needed:
- `src/routes/mymod.js` — `POST /export` + `POST /import/run` (both SSE)
- `public/views/mymod.html` — export view + import view (multi-step wizard)
- `public/mymod-app.js` — export + CSV load + mapping + run import + log
- Registrations

### Export + Import + Delete module (full)

Same as above, plus:
- `POST /delete/by-csv` and/or `POST /delete/all` SSE endpoints
- Delete-from-CSV view and/or Delete-all view in HTML partial
- Delete handlers in JS

### Combined modules (multiple route files under one tool card)

When a tool card maps to multiple backend concerns (like Teams = teams-crud + team-membership + members-teams-mgmt):
- Create separate route files and JS files for each
- Create separate HTML partials
- Load all partials in `loadTool()` via `Promise.all([loadPartial('a'), loadPartial('b')])`
- Call all init functions: `window.initAModule?.(); window.initBModule?.();`
- Use `nav-group-label` in sidebar to visually separate submodule groups

---

<a id="16-checklist"></a>
## 16. Checklist

Use this when creating a new module:

- [ ] **Backend**: Create `src/routes/{module}.js` with `pbAuth` middleware
- [ ] **Backend**: Mount router in `src/server.js`
- [ ] **HTML**: Create `public/views/{module}.html` with prefixed IDs
- [ ] **HTML**: Add `<details class="howto">` section to each submodule panel header
- [ ] **JS**: Create `public/{module}-app.js` with IIFE, init guard, reset, `pb:disconnect` listener
- [ ] **JS**: All `subscribeSSE` calls have `onAbort` callback
- [ ] **JS**: Stop button handlers reference the correct controller variable
- [ ] **JS**: Stop buttons styled as `btn btn-danger btn-sm`
- [ ] **JS**: Log download button shown on error and abort, not just complete
- [ ] **app.js**: Add to `VALID_TOOLS`
- [ ] **app.js**: Add to `PAGE_META`
- [ ] **app.js**: Add to `DEFAULT_VIEWS`
- [ ] **app.js**: Add to `TOOL_VIEWS`
- [ ] **app.js**: Add sidebar toggle in `loadTool()`
- [ ] **app.js**: Add `loadPartial()` call in `loadTool()`
- [ ] **app.js**: Add `window.initXxxModule?.()` call in `loadTool()`
- [ ] **app.js**: Add view names to `showView()` array
- [ ] **index.html**: Add tool card with `data-tool` attribute
- [ ] **index.html**: Add sidebar `<div id="sidebar-{tool}">` with nav items
- [ ] **index.html**: Add `<script src="{module}-app.js"></script>` tag
- [ ] **Test**: Stop buttons actually abort operations
- [ ] **Test**: Token disconnect resets module state
- [ ] **Test**: Navigation to/from module works (deep links, back button)
