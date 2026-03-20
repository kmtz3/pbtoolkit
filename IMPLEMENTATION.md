# Implementation Notes

Reference for adding and maintaining modules in PBToolkit.

---

## Project structure

```
pbtoolkit/
├── test/                      # server-side tests (supertest)
│   ├── TESTING-GUIDE.md       # manual QA checklist
│   ├── companies.delete.test.js
│   ├── companies.export.test.js
│   ├── companies.fields.test.js
│   ├── companies.import.test.js
│   ├── entities.dependencies.test.js
│   ├── entities.exporter.test.js
│   ├── entities.fieldBuilder.test.js
│   ├── entities.importCoordinator.test.js
│   ├── entities.validator.test.js
│   ├── memberActivity.metadata.test.js
│   ├── notes-import.test.js
│   └── utils.test.js
├── src/
│   ├── server.js              # Express entry point — mounts all routers
│   ├── lib/
│   │   ├── pbClient.js        # Productboard API client
│   │   ├── csvUtils.js        # papaparse wrappers
│   │   ├── sse.js             # Server-Sent Events helper
│   │   ├── constants.js       # shared constants: UUID_RE
│   │   └── errorUtils.js      # shared helpers: parseApiError()
│   ├── middleware/
│   │   └── pbAuth.js          # token validation + pbClient injection
│   └── routes/
│       ├── companies.js       # GET /api/fields + POST /api/export + POST /api/import/* + POST /api/companies/* (unified)
│       ├── notes.js           # POST /api/notes/* (export, import, delete, migrate)
│       ├── entities.js        # GET/POST /api/entities/* (templates, configs, preview, normalize-keys)
│       ├── memberActivity.js  # GET /api/member-activity/metadata + POST /api/member-activity/export (SSE)
│       └── teamMembership.js  # GET /api/team-membership/metadata + GET /api/team-membership/export + POST /api/team-membership/preview + POST /api/team-membership/import (SSE)
├── src/services/
│   └── entities/
│       ├── meta.js            # ENTITY_ORDER, TYPE_CODE, labels, syntheticColumns(), relationshipColumns()
│       ├── configCache.js     # fetchEntityConfigs() — per-request GET /v2/entities/configurations
│       ├── csvParser.js       # parseEntityCsv(), extractCustomFieldId(), cell()
│       ├── validator.js       # validateEntityRows() — duplicate ext_key, required name, date/email format
│       ├── exporter.js        # exportEntityType(), rowsToCsv() — Phase 3
│       ├── migrationHelper.js # applyMigrationMode() — Phase 3
│       ├── idCache.js         # ext_key → pb_id cache; seed/set/resolve/resolveParent — Phase 4
│       ├── fieldBuilder.js    # applyMapping(), buildCreatePayload(), buildPatchPayload() — Phase 4
│       ├── relationWriter.js  # writeRelations() — parent PUT + connected POST, 409 swallow — Phase 4
│       └── importCoordinator.js # runImport() — orchestrates parse→seed→upsert→relations — Phase 4
├── public/
│   ├── index.html             # All HTML views, inline
│   ├── app.js                 # Shared utilities: auth, DOM helpers, SSE, makeLogAppender
│   ├── companies-app.js       # Companies module frontend JS
│   ├── notes-app.js           # Notes module frontend JS
│   ├── entities-app.js        # Entities module frontend JS (separate script tag)
│   ├── member-activity-app.js # Member Activity module frontend JS (separate script tag)
│   ├── team-membership-app.js # Team Membership module frontend JS (separate script tag)
│   ├── csv-utils.js           # Frontend CSV utilities (papaparse wrappers for browser)
│   └── style.css              # CSS custom properties design system
├── Dockerfile
├── .env.example           # Documented env vars (PORT, FEEDBACK_URL, ISSUE_URL)
└── package.json
```

---

## Runtime configuration (`/api/config`)

`GET /api/config` is a public endpoint (no token required) that returns server-side environment variables the frontend needs at runtime:

```js
// src/server.js
app.get('/api/config', (_req, res) => {
  res.json({
    feedbackUrl: process.env.FEEDBACK_URL || null,
    issueUrl:    process.env.ISSUE_URL    || null,
  });
});
```

**Frontend wiring** (`public/app.js` — `loadAppConfig()`, called immediately on script load):

```js
async function loadAppConfig() {
  const cfg = await fetch('/api/config').then(r => r.json());
  const fbBtn    = document.getElementById('btn-share-feedback');
  const issueBtn = document.getElementById('btn-report-issue');
  if (cfg.feedbackUrl) { fbBtn.href = cfg.feedbackUrl; fbBtn.target = '_blank'; }
  else fbBtn.style.display = 'none';
  if (cfg.issueUrl)    { issueBtn.href = cfg.issueUrl; }
  else issueBtn.style.display = 'none';
}
```

Rules:
- Each button is **hidden** (`display: none`) when its URL is `null` — never shows a dead link.
- If the fetch itself fails (network error, cold-start race), both buttons are hidden.
- Add new frontend-visible env vars here — keep secrets (API keys, tokens) server-side only.

Supported variables (documented in `.env.example`):

| Variable | Description |
|---|---|
| `PORT` | Server listen port (default `8080`) |
| `FEEDBACK_URL` | "Share feedback" button URL |
| `ISSUE_URL` | "Report issue" button URL |

---

## Adding a new module (checklist)

### 1. Backend route file — `src/routes/{module}.js`

**Preferred pattern** — use `pbAuth` middleware (token validation + client injection):

```js
const express = require('express');
const { pbAuth } = require('../middleware/pbAuth');
const { startSSE } = require('../lib/sse');

const router = express.Router();

router.post('/run', pbAuth, async (req, res) => {
  const { pbFetch, withRetry } = res.locals.pbClient;

  const sse = startSSE(res);
  try {
    // ... work ...
    sse.complete({ ... });
  } catch (err) {
    sse.error(err.message || 'Operation failed');
  } finally {
    sse.done();
  }
});

module.exports = router;
```

All routes now use `pbAuth` — the legacy manual token extraction migration is complete. The old pattern (for reference only — do not use):

```js
// Legacy pattern (do not copy — all routes now use pbAuth middleware)
const token = req.headers['x-pb-token'];
const useEu  = req.headers['x-pb-eu'] === 'true';
if (!token) return res.status(400).json({ error: 'Missing x-pb-token header' });
const { pbFetch, withRetry } = createClient(token, useEu);
```

### 2. Register in `src/server.js`

```js
const notesRouter = require('./routes/notes');
app.use('/api/notes', notesRouter);
```

### 3. Home card in `public/index.html`

Remove `tool-card-soon` class and add `data-tool="{name}"` to activate the card:

```html
<!-- Before (placeholder) -->
<div class="tool-card tool-card-soon">

<!-- After (active) -->
<div class="tool-card" data-tool="notes">
```

The home screen JS already picks up all `.tool-card:not(.tool-card-soon)` elements via `querySelectorAll` — no other JS change needed for the card click.

### 4. Sidebar nav items in `public/index.html`

Add inside `.sidebar-nav`:

```html
<button class="nav-item" data-view="notes-export" id="nav-notes-export">
  <span class="icon">📤</span> Export notes
</button>
<button class="nav-item" data-view="notes-delete" id="nav-notes-delete">
  <span class="icon">🗑️</span> Delete notes
</button>
```

### 5. View panels in `public/views/{module}.html`

Create a new file `public/views/{module}.html` containing all view panels for the module. `loadPartial()` in `app.js` will inject this file into `#view-area` on first navigation — it is **not** added to `index.html`. Example:

```html
<div id="view-notes-export" class="hidden">
  <div class="panel">
    ...
  </div>
</div>
```

### 6. Frontend JS

#### `public/{module}-app.js`

Write all module logic here. Wrap everything in an `initXxxModule()` function and expose it on `window`:

```js
function initNotesModule() {
  // wire up DOM event listeners, reset state, etc.
  // called once after the partial is first loaded
}
window.initNotesModule = initNotesModule;
```

#### `public/app.js` — extend `loadTool()`

Add the tool name to the `names` map and a block that calls `loadPartial()`, sets the active nav item, shows the default view, and calls the module init:

```js
async function loadTool(toolName) {
  const names = { companies: 'Companies', notes: 'Notes' };
  setText('topbar-tool-name', names[toolName] || toolName);
  showScreen('tool');
  // ... sidebar show/hide ...
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));

  await loadPartial(toolName);   // injects public/views/{toolName}.html into #view-area

  if (toolName === 'notes') {
    $('nav-notes-export').classList.add('active');
    showView('notes-export');
    window.initNotesModule?.();
  }
}
```

`loadPartial()` is idempotent — subsequent navigations skip the fetch.

**Add event listeners** for buttons in the new views inside `initNotesModule()`, not at the top level, so they are registered after the HTML is in the DOM.

---

## Productboard API conventions

### Headers (backend)

Every route reads these from the request:

```js
const token = req.headers['x-pb-token'];   // required
const useEu  = req.headers['x-pb-eu'] === 'true'; // optional
```

The frontend sends them via `buildHeaders()` in `app.js`.

### Request body wrapping

| Method | Body shape |
|---|---|
| POST v1 (create) | `pbFetch('post', '/resource', body)` — v1 endpoints (e.g. `POST /notes`) send body directly, no wrapper |
| POST v2 (create) | `pbFetch('post', '/v2/entities', { data: { type, fields, metadata? } })` — v2 entity creates use a `data` wrapper with `type` + `fields` |
| PATCH (update) | `pbFetch('patch', '/resource/id', { data: body })` — **must** wrap in `data` |
| PUT (custom field value) | `pbFetch('put', '/companies/{id}/custom-fields/{fid}/value', { data: { type, value } })` |
| DELETE (clear value) | `pbFetch('delete', '/resource')` — no body |

> **Never set a field to `null` to clear it.** The API rejects null values. Use DELETE instead.

### Pagination

**v1 endpoints** use offset pagination. The pattern:

```js
let offset = 0;
const limit = 100;
let hasMore = true;

while (hasMore) {
  const response = await withRetry(
    () => pbFetch('get', `/resource?pageLimit=${limit}&pageOffset=${offset}`),
    `fetch label offset ${offset}`
  );

  if (response.data?.length) items.push(...response.data);

  // Some endpoints use pagination object, some use links.next
  if (response.pagination) {
    const { offset: off, limit: lim, total } = response.pagination;
    hasMore = (off + lim) < (total ?? 0);
  } else {
    hasMore = !!(response.links?.next);
  }

  offset += limit;
  if (items.length >= 10000) break; // safety cap
}
```

### Error extraction from PB responses

```js
function parseApiError(err) {
  const msg = err.message || String(err);
  const jsonMatch = msg.match(/\{[\s\S]*"errors"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const first = parsed.errors?.[0];
      if (first) return first.detail || first.title || msg;
    } catch (_) {}
  }
  return msg;
}
```

This helper lives in `src/lib/errorUtils.js` — import with `const { parseApiError } = require('../lib/errorUtils')`.

### 404 on field value endpoints

A 404 from `/resource/{id}/custom-fields/{fid}/value` means the value is not set — this is normal, not an error. Pattern:

```js
try {
  await pbFetch('delete', `...`);
} catch (err) {
  if (err.status !== 404) throw err;
}
```

---

## SSE helper

`startSSE(res)` in `src/lib/sse.js` returns:

```js
sse.progress(message, percent, detail = null)  // event: progress
sse.log(level, message, detail = null)         // event: log  (level: 'success'|'info'|'warn'|'error')
sse.complete(data)                             // event: complete
sse.error(message, detail = null)              // event: error
sse.done()                                     // ends the stream (always call in finally)
```

Always call `sse.done()` in a `finally` block so the stream closes even on unexpected errors.

---

## Frontend SSE

```js
const ctrl = subscribeSSE('/api/endpoint', bodyObject, {
  onProgress: ({ message, percent }) => { ... },
  onLog:      (entry) => { ... },       // optional
  onComplete: (data) => { ... },
  onError:    (msg) => { ... },
});

// To abort:
ctrl.abort();
```

`subscribeSSE` uses `fetch` with a `ReadableStream` reader — this is a manual SSE-over-POST implementation since `EventSource` only supports GET.

The `AbortController` returned is used for the Stop button pattern. When aborted, the backend detects `req.on('close', ...)` and sets an `aborted` flag checked between rows.

---

## Frontend state and DOM helpers

```js
const $ = (id) => document.getElementById(id);
const show  = (id) => $(id).classList.remove('hidden');
const hide  = (id) => $(id).classList.add('hidden');
const setText = (id, t) => { $(id).textContent = t; };
```

Session state lives in module-level variables (`token`, `useEu`) backed by `sessionStorage`. New modules should follow the same pattern — use module-level variables for any state that needs to persist between view switches.

---

## CSS design system

All colours and spacing are CSS custom properties defined in `:root` in `style.css`. Font is [Manrope](https://fonts.google.com/specimen/Manrope) loaded via Google Fonts. Key tokens:

| Token | Use |
|---|---|
| `--c-brand` | Primary interactive colour (hunter green `#355E3B`) |
| `--c-brand-dark` | Hover state for primary brand elements |
| `--c-brand-light` | Active/hover background tint (`#edf7ee`) |
| `--c-danger` | Destructive actions, errors |
| `--c-warn` | Warnings, partial success |
| `--c-ok` | Success |
| `--c-muted` | Secondary text |
| `--c-border` | Borders and dividers |
| `--c-surface` | Card/panel background (white) |
| `--c-bg` | Page background (off-white `#f9fafb`) |

**Left-accent pattern:** active/interactive elements use `box-shadow: inset 3px 0 0 var(--c-brand)` (nav items) or `border-left: 3px solid var(--c-brand)` (tool cards) as a consistent green left-bar indicator. Alerts use `border-left: 3px solid <semantic-color>` for the same reason.

Utility classes: `.hidden`, `.mt-{4|8|12|16|20}`, `.mb-16`, `.flex`, `.gap-8`, `.items-center`, `.justify-between`, `.text-sm`, `.text-muted`, `.text-danger`, `.font-mono`

Component classes: `.panel`, `.panel-header`, `.panel-title`, `.panel-subtitle`, `.panel-body`, `.panel-divider`, `.btn`, `.btn-primary`, `.btn-secondary`, `.btn-danger`, `.btn-ghost`, `.btn-sm`, `.btn-full`, `.badge`, `.alert`, `.alert-ok/.warn/.danger/.info`, `.progress-wrap`, `.progress-bar`, `.dropzone`, `.mapping-table`, `.live-log`, `.log-entry`

---

## Entities module

All entity-specific backend logic lives in `src/services/entities/`. The route file (`src/routes/entities.js`) is thin — it reads headers, calls service functions, and serialises the response. All entity-specific frontend JS lives in `public/entities-app.js` (a second `<script>` tag) to keep `app.js` from growing unbounded.

### Key frontend state

`entImport` module-level object in `entities-app.js` tracks the current import session:

```js
entImport = {
  configs: null,      // fetchEntityConfigs() result; null until first file is dropped
  files:   {},        // entityType → { filename, csvText, headers, rowCount }
  mappings:{},        // entityType → { columns: { fieldId: csvHeader } }
  activeTab: null,    // entity type string
  validationResults: null,
}
```

### Auto-mapping (entBuildAutoMapping)

Resolves CSV column headers → internal field IDs in 5 steps (first match wins; a `claimed` Set prevents double-mapping):

1. Exact `defaultHeader` match (case-sensitive)
2. Case-insensitive `defaultHeader` match
3. Case-insensitive PB display name from configs (`bySystemNameLower`)
4. `ENT_FIELD_ALIASES` lookup — large map of `fieldId → [lowercase candidate strings]`
5. UUID suffix match — parses `[uuid]` from the end of the column header (custom fields only)

**Critical timing note**: `entImport.configs` is `null` when the first file is dropped (configs load asynchronously via `GET /api/entities/configs`). Auto-mapping must be deferred until after `entLoadConfigs()` resolves — if called with null configs, `entGetFieldDefs()` returns no system or custom fields and all aliases for those fields are silently skipped. The correct pattern in `entHandleFile`:

```js
if (!entImport.configs) {
  requireToken(async () => {
    await entLoadConfigs();
    // Re-map ALL uploaded files now that configs are available
    Object.entries(entImport.files).forEach(([type, f]) => {
      const persisted = entLoadSavedMapping(type);
      const auto = entBuildAutoMapping(type, f.headers, entImport.configs);
      entImport.mappings[type] = persisted
        ? { columns: { ...auto.columns, ...persisted.columns } }
        : auto;
    });
    entUpdatePanelVisibility();
  });
} else {
  // configs already loaded — map and render immediately
}
```

### Mapping table field labels

Custom field `label` in `entGetFieldDefs()` is just `f.name` (the PB display name). Do **not** append `[${f.displayType}]` to the label — the type is already rendered as a separate `.ent-type-hint` chip in `renderMappingTable()`. Duplicating it in the label creates "Effort [Number] Number" clutter.

### Entities CSS classes

New component classes added in `style.css` for the entities Import view:

| Class | Use |
|---|---|
| `.ent-file-grid` | 3-column file picker tile grid |
| `.ent-file-tile` / `.has-file` | Individual entity tile, filled state |
| `.ent-tile-header/name/remove/drop/icon/status` | Tile sub-elements |
| `.ent-tab-bar` / `.ent-tab-btn` | Tab strip above mapping table |
| `.ent-tab-pill` / `.pill-ok` / `.pill-error` | Validation state pills on tabs |
| `.mapping-group-row` | Section divider row in mapping table |
| `.badge-required` | "required" badge on mandatory fields |
| `.ent-type-hint` | Field type chip (e.g. `Number`, `Text`) |
| `.ent-options-grid` | 2-column options panel layout |
| `.ent-error-panel` / `.ent-error-panel-title` | Per-entity validation result block |

---

## Frontend UX conventions

### Export completion messages

All export done messages follow this format:

```
Exported {N} {noun}. Download started.
```

- Count is always formatted with `.toLocaleString()` (locale-aware thousands separators).
- Noun is the human-readable item type: `companies`, `notes`, `rows` (member activity), or the
  entity-type label from `ENT_LABELS` (e.g. `Features`, `Components`).
- Multi-type entity ZIP: `Exported {N} entities across all selected types. Download started.`

### Mapping persistence (localStorage)

All field mapping configurations persist across page reloads using `localStorage`:

| Module | Key | Format |
|---|---|---|
| Companies | `companies-mapping` | `{ pbIdColumn, nameColumn, domainColumn, descColumn, sourceOriginCol, sourceRecordCol, customFields: [{ csvColumn, fieldId, fieldType }] }` |
| Entities | `ent-mapping-{entityType}` | `{ columns: { fieldId: csvHeader } }` |

Saved mappings override auto-detect. Values are restored silently — if a saved column header no
longer exists in the current CSV, the select stays at `(⇢ skip)`. Mappings persist across token
disconnects (they map CSV column names, not token-specific data).

Notes mapping persists to `localStorage` under key `notes-mapping` (same pattern as companies).

### Filename conventions

- **Date-only**: `YYYY-MM-DD` (from `new Date().toISOString().slice(0, 10)`)
- **Datetime**: `YYYY-MM-DD-HHmm` (from `nowStamp()` in `entities.js`)
- **Filename stem length**: capped at 200 chars max (full filename ≤ 204 chars), well under the
  255-byte OS limit. Member activity filenames apply this cap because team/role slugs can grow long.

Examples:
```
companies-2026-03-15.csv
notes-export-2026-03-01-to-2026-03-14.csv
feature-export-2026-03-15.csv
pbtoolkit-entities-export-2026-03-15-1430.zip
pb-member-activity_2026-03-01_2026-03-14_role-maker_team-frontend.csv
```

---

## Known quirks and gotchas

- **v2 POST uses a `data` wrapper** — `POST /v2/entities` sends `{ data: { type: 'company', fields, metadata? } }`. The v1 `/companies` endpoint did not need the wrapper, but v2 does. Verify body shape for each new resource type.

- **v2 list/search returns domain under a UUID key, single GET normalises to `"domain"`** — `GET /v2/entities?type[]=company` returns domain in `fields[<workspace-UUID>]`; `GET /v2/entities/{id}` returns it in `fields.domain`. This discrepancy is a PB bug. `buildDomainCache` in `companies.js` does a UUID discovery GET to work around it — see the "Domain cache" section above.

- **V1 and v2 company lists are separate** — `GET /companies` (v1) only returns companies that were originally created via v1. Companies created via `POST /v2/entities` (including all PBToolkit-imported companies) do not appear in v1 and can only be retrieved via `GET /v2/entities?type[]=company`.

- **Source fields are v2 `metadata.source`** — `sourceOriginCol` maps to `metadata.source.externalSystemName` and `sourceRecordCol` to `metadata.source.externalRecordId`. The v1 `source.origin`/`source.record_id` fields are separate and are not written by the import. Export includes both v1 and v2 source columns (v1 columns are marked as deprecated in the CSV header).

- **`parseCSVHeaders` in `app.js` is a naive implementation** — it splits on `,` and strips quotes. It is only used to populate the mapping dropdowns; the actual parsing for import uses `papaparse` on the server. If headers contain quoted commas, the frontend display may be slightly off but the import will still be correct.

- **Live log `detail` is truncated in the UI** — the `log-detail` span in CSS has `max-width: 200px` and `text-overflow: ellipsis`. The full value is in the `title` attribute (hover to see).

- **`showView()` must list all view names explicitly** — it toggles hidden/visible by iterating the array. When adding new views, add their names to the array or they will never be shown.

- **Tool card auto-detection** — `document.querySelectorAll('.tool-card:not(.tool-card-soon)')` runs once at page load. Adding a new active card requires the class to be correct in the HTML; there is no dynamic registration.

- **Sidebar is per-tool** — `#sidebar-companies` and `#sidebar-notes` are separate `<div>` wrappers inside `.sidebar-nav`. `loadTool()` shows/hides the correct one. When adding a new tool, add a `#sidebar-{tool}` wrapper and toggle it in `loadTool()`.

---

## Companies module — API reference

All companies logic lives in **one unified route file** (`src/routes/companies.js`), mounted at `/api`:

| Routes | Purpose |
|---|---|
| `GET /api/fields` | Custom field definitions |
| `POST /api/export` | Export all companies as CSV (SSE) |
| `POST /api/import/preview`, `POST /api/import/run` | Create/patch companies + custom fields (SSE) |
| `POST /api/companies/delete/by-csv`, `POST /api/companies/delete/all` | Delete companies (SSE) |

### Import (create/patch pipeline)

`POST /api/import/run` processes each CSV row via the v2 API:
1. **pb_id present** → `PATCH /v2/entities/{id}` — all standard fields as patch ops + `metadata.source` if source columns are mapped
2. **domain match found** → same `PATCH /v2/entities/{id}` by UUID from domain cache
3. **neither** → `POST /v2/entities` — all fields (name, domain, description, custom fields) inline in the request body + `metadata.source`

Custom fields and standard fields are included in the same v2 create/patch call — no separate per-field calls. Source fields (`sourceOriginCol` → `metadata.source.externalSystemName`, `sourceRecordCol` → `metadata.source.externalRecordId`) are written via v2 metadata at creation/update time.

### Domain cache (`buildDomainCache`)

Builds a `{ 'domain.com' → companyUUID }` map before import runs, used for step 2 above.

**Why v2 list, not v1:** Companies created via `POST /v2/entities` (PBToolkit import) do NOT appear in v1 `GET /companies` — v1 and v2 have separate company lists. A v1-only cache misses all PBToolkit-imported companies.

**Known PB quirk — UUID domain field key:** `GET /v2/entities?type[]=company` returns domain under a workspace-specific UUID key (e.g. `b37b798e-e827-4b91-8faa-0b298189cdbe`), not the string `"domain"`. `GET /v2/entities/{id}` (single-entity GET) always normalises it to `fields.domain`. The UUID is not in the config endpoint response and varies per workspace.

**Workaround (current implementation):**
1. Fetch all companies via `GET /v2/entities?type[]=company` (cursor-paginated via `fetchAllPages`)
2. Pick the first company that has a domain value; call `GET /v2/entities/{id}` on it to get its `fields.domain` value
3. Cross-reference that value against the UUID-keyed fields in the list entity to identify the workspace-specific domain field key
4. Use that key to read domains from all remaining list entities

> **TODO**: once PB fixes the domain field key inconsistency in list/search responses (so `"domain"` string key is returned consistently), remove the individual GET discovery loop and read domain directly from `entity.fields.domain` in the list response.

Mapping shape:
```js
{
  pbIdColumn:      string | null,   // CSV column → pb_id; null = create or domain-match only
  nameColumn:      string,
  domainColumn:    string,
  descColumn:      string | null,
  sourceOriginCol: string | null,
  sourceRecordCol: string | null,
  customFields: [
    { csvColumn: string, fieldId: string, fieldType: 'text' | 'number' }
  ]
}
```

### companies.js — delete pipeline

- **by-csv**: parses UUID column from uploaded CSV, deletes each UUID via `DELETE /v2/entities/{id}`. 404s warned and skipped.
- **delete-all**: paginates `GET /companies` (v1) to collect all IDs, then deletes via `DELETE /v2/entities/{id}`. 404s counted as success.

---

## Notes module — API reference

All Notes routes live in `src/routes/notes.js`.

### Endpoint table

| Route | Method | Type | Description |
|---|---|---|---|
| `/api/notes/export` | POST | SSE | Export all notes to CSV |
| `/api/notes/import/preview` | POST | JSON | Validate CSV before import |
| `/api/notes/import/run` | POST | SSE | Import notes |
| `/api/notes/delete/by-csv` | POST | SSE | Delete notes by UUID from CSV |
| `/api/notes/delete/all` | POST | SSE | Delete every note in workspace |
| `/api/notes/migrate-prep` | POST | JSON | Transform CSV for cross-workspace migration |

### Productboard API conventions for notes

| Operation | API | Endpoint | Body wrapper |
|---|---|---|---|
| List notes (with relationships inline) | v2 | `GET /v2/notes` | none |
| Create note | v1 | `POST /notes` | **none** |
| Update note | v1 | `PATCH /notes/{id}` | **none** |
| Backfill archived/processed/creator/owner | v2 | `PATCH /v2/notes/{id}` | `{ data: { patch: [...] } }` |
| Link to hierarchy entity | v2 | `POST /v2/notes/{id}/relationships` | `{ data: { type: 'link', target: { id, type: 'link' } } }` |
| Delete note | v2 | `DELETE /v2/notes/{id}` | none (returns 204) |
| Search by source.recordId | v2 | `GET /v2/notes?source[recordId]=X` | none |
| List users (for export cache) | v1 | `GET /users?pageLimit=100&pageOffset=N` | none |
| List notes (v1, for source enrichment) | v1 | `GET /notes?pageLimit=100&pageCursor=X` | cursor from `response.pageCursor` |

### v2 pagination vs v1 pagination

- **v2 cursor**: extracted from `response.links?.next` URL using `extractCursor()` helper
- **v1 cursor**: read directly from `response.pageCursor`

### Export pipeline

1. Paginate `GET /v2/notes` — each note includes `relationships` inline (no per-note calls needed)
2. Build user UUID → email cache from `GET /users`
3. Build company UUID → domain cache from `GET /companies`
4. Build v1 source map from `GET /notes` — fills gaps where `fields.source.origin` is missing in v2
5. Transform each note → CSV row using `buildNoteRow()`, then `generateCSV()`

**Key field paths in v2 response:**
- `note.fields.name` — title
- `note.fields.displayUrl` — display URL
- `note.fields.source.origin` / `note.fields.source.id` — source data
- `note.fields.owner.email` / `note.fields.creator.email` — direct emails (no UUID lookup needed)
- `note.relationships` — array of `{ type: 'customer'|'link', target: { id, type, links } }`
- Customer relationship target is UUID only — resolved via user/company caches

### Import pipeline (per row)

1. Match: `pb_id` present → UPDATE directly; `ext_id` present → `GET /v2/notes?source[recordId]=ext_id` → UPDATE if found, else CREATE; neither → CREATE
2. CREATE via v1 `POST /notes` (no wrapper). Owner rejection → retry without owner, set `ownerRejected = true`
3. UPDATE via v1 `PATCH /notes/{id}` (no wrapper). Same owner retry pattern
4. Backfill via v2 `PATCH /v2/notes/{id}` for: `archived`, `processed`, `creator`, `owner` (when ownerRejected). On 404: retry up to 3× with 1s delay (v1→v2 propagation)
5. Hierarchy links via `POST /v2/notes/{id}/relationships`. In migration mode, map old UUID → new UUID via `original_uuid` custom field on entities

### Content format

- simple notes: `fields.content` is a plain string
- conversation notes: `fields.content` is an array of message objects → **JSON.stringify** in CSV
- On import: if content column is a JSON string starting with `[`, it is sent as-is to v1 (v1 accepts JSON string for conversation content)

---

## Member Activity module — API reference

Routes in `src/routes/memberActivity.js`. Frontend JS in `public/member-activity-app.js`.

### In-memory session cache

Module-level `Map<token, CacheEntry>` with 30-min TTL and 200-entry cap. Cache is pruned on insert. Stores `members`, `teams`, and `memberTeams` Maps built from the PB Members + Teams APIs.

### `GET /api/member-activity/metadata`

Returns team list and member count for populating the export UI. Query param `?refresh=true` busts the cache.

Response: `{ teams: [{id, name}…], memberCount, fetchedAt, obfuscated }`

`obfuscated: true` when the first member's name is `'[obfuscated]'` — token lacks PII access.

### `POST /api/member-activity/export` (SSE)

Body: `{ dateFrom, dateTo, roles[], teamIds[], activeFilter, includeZeroActivity, rawMode }`

Flow:
1. Build cache if missing/stale (progress 0–20%)
2. Fetch analytics (progress 20–80%) — uses custom pagination loop (see Known Bugs below)
3. Aggregate: summary mode → `Map<memberId, RunningTotal>`; raw mode → array of rows (100k cap)
4. Enrich from cache: name, email, current role, teams
5. Pad zero-rows for members absent from analytics if `includeZeroActivity=true`
6. Apply filters: role → team → activeFilter
7. Build CSV with `generateCSV()`, emit `complete { csv, filename, count, zeroActivityPaidCount }`

`zeroActivityPaidCount` = members in result with `active_days_count === 0` and role `admin` or `maker`.

### Column order

**Summary:** `member_id, name, email, role, teams, date_from, date_to, active_days_count, total_view_events, total_edit_events, board_created, board_opened, feature_created, subfeature_created, component_created, product_created, note_created, note_state_changed, insight_created, grid_board_created, timeline_board_created, insights_board_created, document_board_created, column_board_created, grid_board_opened, timeline_board_opened, insights_board_opened, document_board_opened, column_board_opened`

`total_view_events` = sum of named board `*_opened` columns (grid/timeline/insights/document/column); `total_edit_events` = sum of `feature/subfeature/component/product/note_created` + `note_state_changed` + `insight_created` + named board `*_created` columns. `board_opened` and `board_created` are excluded from both totals — they appear to be generic aggregates that return 0 even when the named board-type counts have values.

**Raw:** `date, member_id, name, email, role, teams, active_flag, total_view_events, total_edit_events,` + same count columns (no `date_from`/`date_to`/`active_days_count`).

### Known bug — analytics pagination

`GET /v2/analytics/member-activities` returns a broken `links.next`: relative path `/member-activities?pageCursor=...` instead of a full absolute URL with the correct `/v2/analytics/` prefix. **Cannot use `fetchAllPages()` for this endpoint.** A custom loop is in place that extracts `pageCursor` via `new URL(r.links.next, 'https://x').searchParams.get('pageCursor')` and reconstructs the correct URL. See `// ── WORKAROUND` comment block in `memberActivity.js` for the cleanup TODO.

### "Include members with no records" vs Activity filter

These two controls are independent:
- **Include members with no records** (checkbox): pads zero-rows for members absent from the API response entirely. Use for a full roster audit.
- **Activity filter** (radio — all/active/inactive): post-fetch filter. "Inactive only" catches members with records but `active_days_count === 0`; also includes padded zero-rows if the checkbox is checked.

---

## Entities importer (Cloud Run) — implementation plan

### Objectives & scope
- Rebuild the legacy Apps Script importer with the existing Cloud Run stack (Express API + SSE + vanilla JS UI) while keeping behavior parity for objectives → releases.
- Operate on CSV inputs only (no multi-sheet XLSX) and mirror the companies/notes mapping workflow so users stay in a familiar flow.
- Preserve key workflows: per-entity imports/exports, “import all” multi-entity runs, relationships-only pass, and the UUID → type+number migration helper.

### Source-of-truth inputs
1. **Per-entity CSVs**: each entity type gets its own CSV with a single header row using human-readable format: `Field Name [FieldType] [fieldUuid]`. Canonical key format (`custom__{id}`) is internal only — the mapping UI translates headers to API fields. Standard columns (`ext_key`, `pb_id`, `title`, `archived`, `phase`, `health`, `workProgress`, etc.) use fixed labels. Import preview/run expect one CSV per entity. The importer accepts:
   - A single entity run (one CSV upload + mapping).
   - A multi-entity run where the user supplies multiple CSVs in one request (one file picker per entity in the UI). Backend processes the subset supplied while respecting dependency order.
2. **Templates**: server exposes download endpoints that emit ready-to-edit CSVs per entity. Each single-entity template downloads as `entities-template-{entity}.csv` (e.g., `entities-template-features.csv`). “Download all templates” returns `pbtoolkit-entities-templates-{YYYYMMDD-HHmm}.zip` containing those CSVs plus a manifest. No spreadsheet validation rows. Each header cell follows `Field Name [FieldType] [fieldUuid]` (e.g., `Business Value [Number] [8b54dcf8-4b1e-4550-b490-d7f985c734e8]`) so users can cross-reference Productboard UI labels/types.
3. **Entity metadata & configs**: port `ENT`, `TYPE_CODE`, `ENTITY_STATUS_DEFINITIONS`, and type abbreviation map (feature→FEAT, etc.) into `meta.js`. Config is fetched per-request (no TTL cache): `GET /v2/entities/configurations/{type}` (v2) + `GET /hierarchy-entities/custom-fields?type=dropdown|multi-dropdown` (v1) + `GET /feature-statuses` (v1). These power template generation, validators, and import payload builders.

### Backend architecture
1. **Routes** (`src/routes/entities.js`):
   - `POST /api/entities/preview` — body `{ files, mappings, options }`. Returns validation errors grouped by entity + row + field. Fetches config (two-pass v2+v1) to validate select field values.
   - `POST /api/entities/run` — same payload; streams SSE progress/logs, enforces entity processing order, reports per-entity stats. SSE `complete` includes `newIdsCsv` (CSV string, not a token) when ext_key auto-generation is enabled.
   - `POST /api/entities/relationships` — same CSV payload as `/run`; runs relationship pass only (upsert skipped). User re-uploads CSVs; mappings pre-filled from localStorage.
   - `POST /api/entities/normalize-keys` — pure CSV transform, no API calls. Accepts CSV + workspace code; returns CSV with UUID ext_keys rewritten to `WORKSPACE-TYPE-NNN`. Used for pre-import migration cleanup.
   - `GET /api/entities/templates/:type` — download one CSV template (human-readable headers); `GET /api/entities/templates.zip` bundles all entity templates.
   - `POST /api/entities/export/:type` — SSE export for one entity type; CSV string in `complete` event, downloaded client-side. `migrationMode` flag in body rewrites relationship columns to ext_key strings.
   - `POST /api/entities/export-all` — SSE job; sequentially exports all types, optionally in migration mode; returns `pbtoolkit-entities-export-{YYYYMMDD-HHmm}.zip`.
2. **Services** (`src/services/entities/`):
   - `meta.js`: ENT ordering, status definitions, column presets, type abbreviation map (feature→FEAT, objective→OBJ, etc.).
   - `configCache.js`: per-request two-pass fetch — `GET /v2/entities/configurations/{type}` v2 + `GET /hierarchy-entities/custom-fields?type=dropdown|multi-dropdown` v1 + `GET /feature-statuses` v1. No in-memory TTL.
   - `csvParser.js`: PapaParse wrapper, normalizes rows, trims values, coerces numbers/dates.
   - `validator.js`: enforces required columns, duplicate ext_keys, select/multi-select value validation against config (blocks on unallowed), parent resolution pre-check (hard error for unresolvable CREATE parents), skips status validation for objective/keyResult/initiative/release.
   - `importCoordinator.js`: orchestrates per-entity queues in dependency order (objectives → releases), seeds idCache in preflight from CSV `pb_id` columns, shares ID caches between entity files, attaches SSE events, emits row count warning at 50k rows.
   - `fieldBuilder.js`: builds create/patch payloads. Both PATCH shapes (`{ data: { fields } }` for set, `{ data: { patch: [...] } }` for addItems/removeItems). Entity-type branching for `team`/`teams`. `bypassEmptyCells` applied per-field. Handles `archived`, `phase`, `health`, `workProgress`. HTML sanitization with allowed tag set; `bypassHtmlFormatter` skips it. Ref: `mainLogicImporter.gs:buildFieldsObject_`, `buildPatchOperations_`.
   - `relationWriter.js`: `PUT /v2/entities/{id}/relationships/parent` for parent; `POST` for connected. Swallows 409s. Ref: `mainLogicImporter.gs:writeRelations_`.
   - `idCache.js`: ext_key → pb_id map. Pre-seeded in preflight from CSV rows with both `ext_key` and `pb_id`. No live PB lookup fallback.
   - `templateBuilder.js`: generates CSV header strings in `Field Name [FieldType] [fieldUuid]` format from config; `buildAllTemplatesZip()` uses `archiver`.
   - `exporter.js`: uses `POST /v2/entities/search` + cursor pagination. Reads relationship data inline if available; else fetches per-entity in batches of 20. Normal mode: relationship columns = UUIDs. Migration mode: relationship columns = ext_key strings. Warns at 50k rows.
   - `migrationHelper.js`: (1) export mode — rewrite UUID ext_keys to `WORKSPACE-TYPE-NNN` and adjust relationship columns; (2) normalize mode — pure CSV transform for `normalize-keys` endpoint, no API calls.
3. **Shared utilities**: keep using existing SSE + pbClient helpers; extend the HTML sanitizer when needed; store multi-entity upload metadata in memory per request to keep state simple.

### Import pipeline blueprint
1. **Preflight**
   - Receive `{ files, mappings, options }`, reject if no files provided.
   - Parse each CSV independently, attach `_entityType`, `_row`, `_fileName`.
   - Fetch config for all entity types present (two-pass v2+v1 per request).
   - **Seed idCache** from all CSV rows where both `ext_key` and `pb_id` are present before any upsert begins.
2. **Validation phase**
   - Run `validator` per entity; accumulate issues into `{ entity, fileName, row, field, message }`.
   - Stop run if any blocking errors exist; warnings bubble up but do not block.
3. **Execution phase**
   - Determine execution order: objectives → keyResults → initiatives → products → components → features → subfeatures → releaseGroups → releases.
   - For each entity with provided CSV:
     - Build/create/patch rows: `pb_id` present → PATCH; no `pb_id` → CREATE.
     - **Parent rules:** CREATE without resolvable parent → hard validation error (blocked). PATCH with empty parent column → existing parent unchanged. PATCH with parent column value → PUT new parent (allows reparenting). UUID parent references passed directly to API.
     - Buffer pb_id assignments for newly created ext_keys. If `autoGenerateExtKeys` is enabled, generate `ABBREV-{entity_number}` from each PB response and buffer for `newIdsCsv`.
     - Share ID cache across entity types so later files can resolve parents created earlier in the same run.
   - Track per-entity metrics and emit SSE logs (start/finish for each file + row-level warnings).
4. **Relationship + migration pass**
   - After upserts, run `relationWriter` for parent + connected links, respecting requirements (component/feature/subfeature/release parents).
   - Offer optional `migrationHelper` action that rekeys ext_keys and exports the mapping so cross-workspace migrations preserve relationships.
5. **Completion**
   - SSE `complete` payload includes `summary`, `perEntityStats`, `newIdsCsv` (CSV string embedded directly in the event; absent if no new entities were created — frontend downloads via `Blob` + `URL.createObjectURL`), and `warnings`.

### Frontend integration plan
1. **Card + sidebar**
   - Activate the Entities card + `#sidebar-entities` nav grouping once backend endpoints exist. Provide nav buttons for `Import`, `Export`, `Templates`, `Migration`, and `Relationships`.
2. **Import UI**
   - File picker grid (one per entity type). Each picker shows status pill (no file / file name + row count). Row count warning shown inline if file exceeds 50,000 rows.
   - **Tabbed mapping UI**: one tab per uploaded entity type. Tab header: entity name, file name, row count, status pill (valid/warnings/errors/unmapped). Active tab shows column mapping drawer (reuses companies/notes component). Allowed select values shown as helper text per mapped field. Mappings persisted in `localStorage` keyed by entity type + column name.
   - Shared options panel: multi-select mode radio, bypass empty cells toggle, bypass HTML formatter toggle, `fiscal_year_start_month` input (1–12, default 1), "Auto-generate ext_keys" checkbox + workspace code field.
   - Buttons: `Validate selected` (calls preview; surfaces errors in mapping tabs) and `Run import` (SSE). Live log panel + per-entity summary table on completion.
3. **Export UI**
   - Per-entity export buttons trigger `POST /api/entities/export/:type` (SSE); CSV delivered in `complete` event and downloaded client-side. Consistent with export-all.
   - “Export all entities” → SSE job returning ZIP.
   - “Migration mode” toggle: when enabled, relationship columns are rewritten to ext_key strings (`WORKSPACE-TYPE-NNN`) instead of PB UUIDs. Workspace code field required. Helper copy explains cross-workspace import use case.
4. **Templates UI**
   - Buttons to download single-entity CSV templates and a “Download all templates (ZIP)” shortcut.
5. **Migration UI**
   - “Migration mode” toggle for exports (linked to Export view).
   - “Normalize ext_keys” action: user uploads CSV + enters workspace code; `POST /api/entities/normalize-keys` returns transformed CSV with UUID ext_keys rewritten to `WORKSPACE-TYPE-NNN`. Pure CSV transform, no API calls.
6. **Relationships UI**
   - File picker grid (same layout as Import view) for re-uploading CSVs. Mappings pre-filled from `localStorage`. Entity type checklist + “Select all.” “Fix relationships” CTA triggers `POST /api/entities/relationships` SSE — only relationship pass runs (upsert skipped). 409s logged as “already linked.”
7. **Progress + logs**
   - Reuse live log panel; include per-entity subsections so multi-file runs remain understandable. Display dependency order and highlight entities skipped due to missing files.

### Rate limit & concurrency strategy
- Reuse the existing `pbClient` throttle + retry logic from companies/notes: sequential requests per Cloud Run instance with adaptive delay (`minDelay` 20 ms, slower when remaining quota <20) and exponential backoff (up to 6 attempts) on 429/5xx.
- Import/export loops run row-by-row (no parallel API calls) to ensure the shared ID cache stays consistent and PB rate limits stay predictable.
- If future workloads demand more throughput, we can add an env-driven concurrency cap to process multiple entities in parallel, but the default plan keeps the safer single-worker execution model.

### Delivery phases
1. **Metadata & templates** ✅: add `archiver` dependency; port entity constants/meta to `meta.js`; build per-request config fetch helper; implement template endpoints (single + ZIP).
2. **Validator & preview endpoint** ✅: build `csvParser.js` + `validator.js`; add `/api/entities/preview` and `POST /api/entities/normalize-keys`; wire Import view with tabbed mapping UI, auto-mapping, options panel.
3. **Exporters + Migration** ✅: implemented `exporter.js` (`POST /v2/entities/search` + cursor pagination; relationships inline); added export endpoints; `migrationHelper.js` as post-processing step; wired Export view (migration mode toggle, checkbox grid, normalize ext_keys tab).
4. **Importer SSE + relationships** ✅: implemented `idCache.js`, `importCoordinator.js`, `fieldBuilder.js` (sanitize-html for HTML, all system fields, custom fields via `custom__<uuid>` mapping), `relationWriter.js`; added `/api/entities/run` + `/api/entities/relationships`; ext_key auto-generation + `newIdsCsv` download; Run/Stop/Fix-relationships buttons; live log + complete summary. Notable: `tags` is a UUID custom field — removed hardcoded `F.tags` block; flows through `custom__<uuid>` path like other custom fields.
5. **Polish & launch** 🔄 in progress: ✅ Error message extraction (`parseApiError` in `importCoordinator.js`). ✅ 50k-row warning. ✅ Empty CSV skip warning. 🔲 QA across all 9 entity types with real fixtures — see §10 Testing Plan in `ENTITY_IMPORTER_PLAN.md`.

---

## Unified import UI (all three modules)

All three import modules (Companies, Notes, Entities) share the same four-panel layout:

```
[Upload panel]   — file drop zone, unchanged per module
[Map Columns]    — mapping tables only; no buttons
[Options panel]  — module options + Validate / Import / Stop action buttons
[Log panel]      — progress bar (top) → summary alert → live log (persistent)
```

### Shared helpers in `public/app.js`

Two utility functions live at the top of `app.js` and are available to `entities-app.js` (same page, loads second):

**`makeLogAppender(logId, entriesId, countsId)`**
Factory returning a bound `append({ level, message, detail, ts })` function.
- Unhides the log container on first call.
- Tracks `success/error/warn/info` counts; renders colored span header.
- Creates `.log-entry ${level}` entries with `.log-ts`, `.log-msg`, `.log-detail`.
- Exposes `.reset()` — clears entries and counts for a fresh run.
- Exposes `.getCounts()` — returns a snapshot for stop-handler summaries.
- Level CSS: `success` → `#34d399`, `error` → `#f87171`, `warn` → `#fbbf24`, `info` → `#93c5fd`.

Usage (one instance per module):
```js
// Companies (app.js)
const appendLogEntry = makeLogAppender('import-live-log', 'live-log-entries', 'live-log-counts');

// Notes (app.js)
const appendNotesLogEntry = makeLogAppender('notes-import-live-log', 'notes-live-log-entries', 'notes-live-log-counts');

// Entities (entities-app.js — wraps base appender to add [entityType] suffix)
const _entLogAppendBase = makeLogAppender('ent-import-log', 'ent-import-log-entries', 'ent-import-log-counts');
function entImportAppendLog(level, message, detail) { ... }
```

**`renderImportComplete(el, { created, updated, errors, stopped, extraText, extraHtml })`**
Renders a styled `.alert-ok` / `.alert-warn` summary into `el`.
- Icon: `✅` (ok) · `⚠️` (errors) · `⏹` (stopped).
- `extraText` — appended to the summary line (e.g. `"3 parent links · 2 connected links"` for entities).
- `extraHtml` — rendered below the alert (e.g. per-entity breakdown table for entities).
- Calls `el.classList.remove('hidden')` automatically.

### Panel IDs by module

| Panel       | Companies            | Notes                      | Entities               |
|-------------|----------------------|----------------------------|------------------------|
| Upload      | `import-step-upload` | `notes-import-step-upload` | `ent-import-step-upload` |
| Map         | `import-step-map`    | `notes-import-step-map`    | `ent-import-step-map`  |
| Options     | `import-step-options`| `notes-import-step-options`| `ent-import-step-options` |
| Log         | `import-step-run`    | `notes-import-step-run`    | `ent-import-step-log`  |

### Log panel structure (top to bottom in all modules)

1. Progress bar (`progress-wrap` + `progress-bar`)
2. Progress status text
3. `*-summary-box` — empty div, filled by `renderImportComplete` on complete/stop/error
4. Fatal error alert (`ent-import-error` for entities; inline in summary-box for companies/notes)
5. Live log (`live-log` + `live-log-scroll`) — **never hidden after import completes**
6. Entities only: `btn-ent-fix-rels` — shown after complete

### Key design rules
- Live log is **never hidden** after an import completes or errors — user should be able to review rows.
- `makeLogAppender.reset()` is called at the start of each run (clears entries, not DOM structure).
- Options panel and Map panel **always show together** once a file is loaded.
- Log panel is only shown when import starts (`entImportSetRunning(true)` / `show('import-step-run')`).
- Stop button lives in the Options panel; `btn-stop-*` is shown/hidden via JS during import.

---

## Team Membership module — API reference

Routes in `src/routes/teamMembership.js`. Frontend JS in `public/team-membership-app.js`. UI has two tabs: **Export** and **Import**.

### Endpoints

| Method | Path | Type | Description |
|---|---|---|---|
| `GET` | `/api/team-membership/metadata` | JSON | Returns `{ teams, memberCount, fetchedAt }`. Builds/returns session cache. `?refresh=true` busts cache. |
| `GET` | `/api/team-membership/export` | CSV download | Direct `text/csv` response (no SSE). Query params: `format=A\|B`, `teamIds=id1,id2,...` |
| `POST` | `/api/team-membership/preview` | JSON | Body: `{ csvText, mode }`. Returns `{ diffs, unresolvableEmails, nameResolvedTeams, unrecognisedValues }`. Diffs include `{ id, email }` objects (not raw UUIDs) for human-readable preview. |
| `POST` | `/api/team-membership/import` | SSE | Body: `{ csvText, mode }`. Executes the import. Events: `progress`, `log`, `complete`, `error`, `done`. |

Import mode: `'add' | 'remove' | 'set'` (default `'set'`).

### CSV formats

Two formats are supported, auto-detected on upload:

- **Format A** — one row per member, one column per team. Header: `email, name, role, "Team Name [team-uuid]", …`. Cell value `✓`/`1`/`yes`/`x`/`true`/`assigned` = assigned; empty = not assigned. First column header `email` is the detection signal.
- **Format B** — one column per team, member emails stacked vertically. Header: `"Team Name [team-uuid]", …`. Detection signal: first header matches `[uuid]` pattern.

### Session cache

Server-side `Map<token, CacheEntry>` with 30-min TTL and 200-entry cap (same pattern as `memberActivity.js`). **Not shared** with member activity's cache. Stores:
- `membersById: Map<memberId, { id, name, email, role }>`
- `membersByEmail: Map<email, MemberProfile>`
- `teamsById: Map<teamId, { id, name, handle }>`
- `memberIdsByTeamId: Map<teamId, Set<memberId>>`

Members fetched with `includeDisabled: false, includeInvited: false`. Cache is automatically invalidated and rebuilt after a successful import.

### Diff preview

`/preview` returns enriched `TeamDiff[]`:
```js
{
  teamId: string,
  teamName: string,
  toAdd:     [{ id, email }],   // member objects, not raw IDs
  toRemove:  [{ id, email }],
  unchanged: [{ id, email }],
}
```
The frontend renders `member.email` (not UUID) in the per-team collapsible blocks.

### PB API calls

| Operation | Endpoint |
|---|---|
| List teams | `GET /v2/teams` (via `listTeams` helper in `pbClient.js`) |
| List members | `GET /v2/members` (via `listMembers` helper) |
| List team members | `GET /v2/teams/{id}/relationships` (via `listTeamMembers` helper) |
| Add member | `POST /v2/teams/{teamId}/relationships` — body: `{ data: { type: 'team_membership', target: { id: memberId, type: 'member' } } }` |
| Remove member | `DELETE /v2/teams/{teamId}/relationships/member/{memberId}` |

409 on add = already a member (skip, not an error). 404 on remove = not a member (skip, not an error).

### Frontend pattern differences vs other import modules

Team Membership does **not** use the four-panel upload/map/options/log layout. It uses a simpler state machine: `idle → uploading → diff preview → running → (results | stopped | error)`. The live log panel is inside `#tm-import-running` (hidden when running ends), so the log is copied to `#tm-results-log` in the results panel via `moveLogToResults()`. The download button appears in:
- `#tm-results-log` header — after complete/abort
- `#tm-import-error` panel — after error (if log has entries)
