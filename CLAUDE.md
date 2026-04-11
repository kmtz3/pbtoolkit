# CLAUDE.md — PBToolkit project anchor

This file exists to orient Claude at the start of every session.
Read it before making any file writes or path assumptions.

Last audited: 2026-04-10. Updated for Merge Duplicate Companies module (companies-duplicate-cleanup) + Merge from CSV submodule.

---

## Project Overview

This is a JavaScript/HTML/CSS web application (PBToolkit - Productboard toolkit). Key patterns: vanilla JS with module-based architecture, shared utilities, HTML templates per module. When making CSS changes, test that they don't break existing card names, panel titles, or other styled components.

Documentation files: CLAUDE.md contains the modules table and project conventions. IMPLEMENTATION.md contains architecture details. README.md is user-facing. Check the correct file before editing.

This is a JavaScript/HTML/CSS browser extension and web toolkit project (PBToolkit). Primary languages: JavaScript, HTML, CSS, Markdown. Minimal TypeScript.

---

## Project identity

| Key | Value |
|---|---|
| **Project name** | PBToolkit |
| **Root directory** | `/Users/klaramartinez/pb-tools/PBToolkit` |
| **Entry point** | `src/server.js` |
| **Port** | 8080 (default; override with `PORT` env var) |
| **Runtime** | Node 18+, Express, no frontend framework |
| **Deployment** | Google Cloud Run (`Dockerfile` in root) |

---

## Git branching

- **`staging`** — pre-production branch for live testing before merging to `main`. All new work lands here first, gets verified on a staging deployment, then merges into `main` for production. **Never delete the `staging` branch.**
- **`main`** — production branch. Only receives merges from `staging`.

**Never commit planning or report documents.** Files in `implementation_notes/` are gitignored by design. Audit reports (e.g. `report-consistency.md`), improvement plans (e.g. `plan-*.md`), and any other local analysis docs must stay out of git — write them to `implementation_notes/` or the project root (both gitignored). If a `.md` file was produced by an audit or planning session, delete it after use rather than staging it.

---

## Directory map

```
PBToolkit/                         ← project root (git repo)
├── CLAUDE.md                      ← this file (tracked in git, shared with collaborators)
├── IMPLEMENTATION.md              ← patterns, conventions, API reference
├── plan-codebase-improvement.md   ← prioritized refactor plan (gitignored, local only)
├── Dockerfile
├── package.json
├── "openapi v2 public API"/       ← Productboard v2 OpenAPI YAML specs (untracked reference)
├── implementation_notes/          ← planning docs (gitignored)
│   ├── plan-entity-importer.md            ← entities module spec + phase log
│   ├── plan-members-activity-implementation.md
│   ├── plan-oauth-implementation.md
│   ├── plan-companies-v2-migration.md
│   ├── plan-entities-delete-from-csv.md
│   ├── plan-reset-settings-on-token-disconnect.md
│   ├── plan-team-membership.md            ← team membership module spec
│   ├── plan-teams-crud.md                 ← teams CRUD module spec
│   ├── plan-dependencies-support.md
│   └── module-creation-guide.md           ← **READ THIS when creating new modules**
├── .claude/                       ← local tooling (.env gitignored; agents/ and commands/ tracked)
│   ├── .env                       ← local test secrets (PB_TOKEN, PB_EU, SERVER_URL)
│   ├── agents/
│   │   ├── endpoint-tester.md     ← agent: test all API endpoints
│   │   ├── consistency-checker.md ← agent: audit module conventions (state block, naming, SSE, DOM safety)
│   │   └── security-checker.md    ← agent: audit XSS, auth gaps, token leakage, injection risks
│   └── commands/
│       ├── health.md              ← /health skill
│       ├── test-token.md          ← /test-token skill
│       ├── test-api.md            ← /test-api skill
│       ├── dev.md                 ← /dev skill
│       └── pre-staging-audit.md   ← /pre-staging-audit skill: runs both audits on changed files
├── test/                          ← server-side test files (untracked)
│   ├── TESTING-GUIDE.md           ← manual QA checklist
│   ├── companies.delete.test.js
│   ├── companies.export.test.js
│   ├── companies.fields.test.js
│   ├── companies.import.test.js
│   ├── entities.dependencies.test.js
│   ├── entities.exporter.test.js
│   ├── entities.fieldBuilder.test.js
│   ├── entities.importCoordinator.test.js
│   ├── entities.validator.test.js
│   ├── configCache.test.js
│   ├── csvParser.test.js
│   ├── domainCache.test.js
│   ├── feedback.test.js
│   ├── fieldFormat.test.js
│   ├── memberActivity.metadata.test.js
│   ├── membersTeamsMgmt.test.js
│   ├── notes-export.test.js
│   ├── notes-import.test.js
│   ├── pbAuth.test.js
│   ├── sse.test.js
│   ├── team-membership.export.bench.js
│   ├── teamMembership.test.js
│   ├── teamsCrud.test.js
│   ├── users.test.js
│   └── utils.test.js
├── src/
│   ├── server.js                  ← Express entry; mounts all routers at /api/*
│   ├── lib/
│   │   ├── pbClient.js            ← PB API client (rate limiting, retry, backoff)
│   │   ├── csvUtils.js            ← papaparse wrappers: parseCSV(), generateCSV()
│   │   ├── sse.js                 ← SSE helper: startSSE(res) → { progress, log, complete, error, done }
│   │   ├── constants.js           ← shared constants: UUID_RE
│   │   ├── errorUtils.js          ← shared helpers: parseApiError()
│   │   ├── fieldFormat.js         ← shared custom-field formatting for v2 entity imports
│   │   └── domainCache.js         ← shared company domain cache (domain→id and id→domain lookups)
│   ├── middleware/
│   │   └── pbAuth.js              ← Express middleware: validates x-pb-token, attaches pbClient to res.locals
│   ├── routes/
│   │   ├── validate.js            ← GET  /api/validate (token validation)
│   │   ├── auth.js                ← GET /auth/pb (OAuth initiate) + GET /auth/pb/callback + POST /auth/pb/disconnect
│   │   ├── companies.js           ← GET /api/fields + POST /api/export + POST /api/import/* + POST /api/companies/delete/* (unified companies module)
│   │   ├── notes.js               ← POST /api/notes/* (export, import, delete, migrate) — largest route
│   │   ├── entities.js            ← GET/POST /api/entities/* (templates, configs, preview, export, import)
│   │   ├── memberActivity.js      ← GET /api/member-activity/metadata + POST /api/member-activity/export (SSE)
│   │   ├── teamMembership.js      ← GET /api/team-membership/metadata + GET /api/team-membership/export + POST /api/team-membership/preview + POST /api/team-membership/import (SSE)
│   │   ├── teamsCrud.js           ← GET /api/teams-crud/export + POST /api/teams-crud/preview + POST /api/teams-crud/import (SSE) + POST /api/teams-crud/delete/by-csv (SSE) + POST /api/teams-crud/delete/all (SSE)
│   │   ├── membersTeamsMgmt.js    ← GET /api/members-teams-mgmt/load + PATCH/POST/DELETE team & member ops (live editor)
│   │   ├── users.js               ← GET/POST /api/users/* (export, import/preview, import/run, delete)
│   │   ├── feedback.js            ← POST /api/feedback (bug report → PB note or Brevo email fallback)
│   │   ├── notesMerge.js          ← POST /api/notes-merge/scan + /run + /scan-empty + /delete-empty (SSE)
│   │   └── companiesDuplicateCleanup.js ← GET /api/companies-duplicate-cleanup/origins + POST /scan + /preview-csv + /run (SSE)
│   └── services/
│       ├── teamCache.js           ← shared team+member session cache (used by teamMembership + membersTeamsMgmt)
│       └── entities/
│           ├── meta.js            ← ENTITY_ORDER, TYPE_CODE, syntheticColumns(), relationshipColumns()
│           ├── configCache.js     ← fetchEntityConfigs() — per-request GET /v2/entities/configurations
│           ├── csvParser.js       ← parseEntityCsv(), extractCustomFieldId(), cell()
│           ├── validator.js       ← validateEntityRows()
│           ├── exporter.js        ← exportEntityType(), rowsToCsv() — Phase 3
│           ├── migrationHelper.js ← applyMigrationMode() — Phase 3
│           ├── idCache.js         ← createIdCache() — Phase 4
│           ├── fieldBuilder.js    ← applyMapping(), buildCreatePayload(), buildPatchPayload() — Phase 4
│           ├── relationWriter.js  ← writeRelations() — Phase 4
│           └── importCoordinator.js ← runImport() — Phase 4
└── public/                        ← served as static files
    ├── index.html                 ← shell only — module views loaded as partials (~453 lines)
    ├── app.js                     ← shared utilities: auth, DOM helpers, SSE, makeLogAppender, renderImportComplete, loadPartial() (~989 lines)
    ├── companies-app.js           ← companies module frontend JS; exposes initCompaniesModule() (~884 lines)
    ├── notes-app.js               ← notes module frontend JS; exposes initNotesModule() (~787 lines)
    ├── notes-merge-app.js         ← merge duplicate notes module frontend JS; exposes initNotesMergeModule() (~981 lines)
    ├── entities-app.js            ← entities module frontend JS; exposes initEntitiesModule() (~1621 lines)
    ├── member-activity-app.js     ← member activity module frontend JS; exposes initMemberActivityModule() (~321 lines)
    ├── team-membership-app.js     ← team membership module frontend JS; exposes initTeamMembershipModule() (~648 lines)
    ├── teams-crud-app.js          ← teams CRUD module frontend JS; exposes initTeamsCrudModule() (~872 lines)
    ├── members-teams-mgmt-app.js  ← live team editor frontend JS; exposes initMembersTeamsMgmtModule() (~696 lines)
    ├── users-app.js               ← users module frontend JS; exposes initUsersModule() (~768 lines)
    ├── companies-duplicate-cleanup-app.js ← merge duplicate companies frontend JS; exposes initCompaniesDuplicateCleanupModule() — contains two submodules: dc (merge by scan) and dcm (merge from CSV)
    ├── views/                     ← HTML partials, one per submodule group (lazy-loaded into #view-area on first navigation)
    │   ├── companies.html
    │   ├── notes.html
    │   ├── notes-merge.html
    │   ├── entities.html
    │   ├── member-activity.html
    │   ├── team-membership.html
    │   ├── teams-crud.html
    │   ├── members-teams-mgmt.html
    │   ├── users.html
    │   └── companies-duplicate-cleanup.html
    ├── csv-utils.js               ← frontend CSV utilities (papaparse wrappers for browser)
    ├── privacy.html               ← GDPR privacy policy page (served at /privacy)
    └── style.css                  ← CSS custom properties design system
```

---

## UI terminology

- **Module** — a top-level tool card on the home screen (Entities, Notes, Merge Duplicate Notes, Merge Duplicate Companies, Companies & Users, Member Activity, Teams). Each module has its own page with a sidebar.
- **Submodule** — a sidebar tab within a module (e.g. Export, Import, Delete by CSV). Each submodule has its own view panel loaded as an HTML partial.
- **Submodule category** — an optional grouping label in the sidebar that visually separates related submodules. Uses `.nav-group-label` CSS class. Example: the Teams module has three categories — "Team Management", "Team Membership", and "Live Editor".

A single module may combine multiple backend route files and frontend JS files under one UI umbrella. For example, the Teams module card maps to three route files (`teamsCrud.js`, `teamMembership.js`, `membersTeamsMgmt.js`) and three frontend JS files, all loaded when the user navigates to the Teams module.

**Activating a new module card** — when a coming-soon card graduates to a live module:
1. Remove `tool-card-soon` from the card's class list and add `data-tool="<tool-name>"`.
2. Replace the `badge-muted` / "Coming soon" badge with `badge-beta` / "Beta".
3. Move the card immediately after the last active (non-coming-soon) card in its section, so all coming-soon cards remain at the end of the grid.

---

## Modules and API mount points

| Module | Route prefix | Files |
|---|---|---|
| Token Validate | `/api/validate` | `routes/validate.js` |
| OAuth Auth | `/auth/pb`, `/auth/pb/callback`, `/auth/pb/disconnect`, `/api/auth/status` | `routes/auth.js` |
| Companies (fields/export/import/delete) | `/api/fields`, `/api/export`, `/api/import/*`, `/api/companies/*` | `routes/companies.js` (unified) |
| Notes | `/api/notes` | `routes/notes.js` |
| Merge Duplicate Notes | `/api/notes-merge` | `routes/notesMerge.js` + `public/notes-merge-app.js` |
| Merge Duplicate Companies | `/api/companies-duplicate-cleanup` | `routes/companiesDuplicateCleanup.js` + `public/companies-duplicate-cleanup-app.js` — two submodules: **Merge by scan** (`dc` prefix) and **Merge from CSV** (`dcm` prefix). CSV submodule uses `POST /preview-csv` (SSE) to fetch counts, then reuses `POST /run` for the merge. |
| Entities | `/api/entities` | `routes/entities.js` + `services/entities/*` |
| Member Activity | `/api/member-activity` | `routes/memberActivity.js` + `public/member-activity-app.js` |
| Teams | `/api/teams-crud`, `/api/team-membership`, `/api/members-teams-mgmt` | `routes/teamsCrud.js` + `routes/teamMembership.js` + `routes/membersTeamsMgmt.js` + `services/teamCache.js` |
| Users | `/api/users` | `routes/users.js` + `public/users-app.js` |
| Feedback | `/api/feedback` | `routes/feedback.js` — creates PB note (via `PB_FEEDBACK_TOKEN`) or sends Brevo email as fallback |

> `companies.js` is mounted at `/api` (not `/api/companies`) so it can serve routes at `/api/fields`, `/api/export`, and `/api/import/*` alongside `/api/companies/*`.
>
> The Teams module combines three backend route files under one frontend module card. They share a session cache via `services/teamCache.js`.

---

## Entities module status

Phases tracked in `implementation_notes/plan-entity-importer.md`:

- **Phase 1 – Metadata & Templates** ✅ live
- **Phase 2 – CSV Parser, Validator & Import UI** ✅ live
- **Phase 3 – Exports + Migration** ✅ live
- **Phase 4 – Import SSE + Relationships** ✅ live
- **Phase 5 – Polish & Launch** 🔄 in progress (error extraction, 50k-row warning, empty-file warning done; QA pending)

---

## Key conventions (summary — full detail in IMPLEMENTATION.md)

- **Token**: all API routes use the `pbAuth` middleware (`src/middleware/pbAuth.js`) which validates the token and attaches `res.locals.pbClient`. Token resolution order: session token (`req.session?.pbToken`, OAuth path) → `x-pb-token` header (manual token path). EU flag resolution: `req.session?.useEu` → `x-pb-eu: 'true'` header. Migration complete — no manual token extraction remains.
- **PB API body wrapping**: POST (create) → no wrapper; PATCH (update) → `{ data: { ... } }`; PUT (custom field) → `{ data: { type, value } }`. Never set a field to `null` to clear — use DELETE.
- **Pagination**: Two strategies used depending on API version:
  - Offset-based (v1/companies): `pageLimit=100&pageOffset=N`; check `response.data.length < limit` to detect last page.
  - Cursor-based (v2/entities/notes/analytics): check `response.links?.next`; use `extractCursor()` helper in the route file.
- **SSE**: always call `sse.done()` in a `finally` block. Listen on `res.on('close')` for abort — NOT `req.on('close')` (req close fires as soon as the request body is consumed).
- **Frontend state**: `token` + `useEu` live in `sessionStorage`; `buildHeaders()` sets the right headers.
- **localStorage**: mapping state persists for companies (`companies-mapping` key), notes (`notes-mapping` key), users (`users-mapping` key), teams-crud (`teams-crud-mapping` key), and entities (`ent-mapping-{entityType}` key).
- **Export CSV headers must match import auto-detect hints**: export `BASE_FIELDS[].label` values must be snake_case (e.g. `pb_id`, `name`, `domain`) so that a re-imported export CSV auto-maps all columns. The frontend auto-detect compares `header.toLowerCase()` against hint arrays — if export labels don't appear in those arrays, re-import requires manual mapping. When adding a new base field, add the export label to the corresponding auto-detect hint array in the module's frontend JS.
- **No framework**: vanilla JS only in `public/`. No build step — files are served directly.
- **DOM building**: default to `innerHTML` + `esc()` for display markup; use `createElement` only when event listeners must be attached during construction. See IMPLEMENTATION.md § "DOM building convention".
- **Shared UI helpers** (in `app.js`): `setProgress(prefix, msg, pct)` for progress bars, `showAlert(msg)`/`showConfirm(msg)` for styled dialogs (prefer over native `alert()`/`confirm()`), `createViewState(prefix, states)` for idle/running/done/error state machines. See IMPLEMENTATION.md § "Shared JS helpers" for signatures.
- **Frontend module scoping**: each module uses its own `$(id)` / `show()` / `hide()` wrappers (e.g., `ma$()`, `entShow()`, `tm$()`) to avoid ID collisions.
- **Module state block — all state at the top**: every `let _xxx` variable in a frontend module must be declared in the `// ── Module state` block at the top of the IIFE. Never declare state mid-file — it makes reset functions incomplete and creates confusing reference-before-declaration patterns.
- **Module-scoped helpers — hoist and prefix**: any helper function used by more than one function within a module must be hoisted to module level (inside the IIFE, above its first caller) and named with the module prefix (e.g. `nmRow`, `maFmt`). Never define a generic un-prefixed helper (`row()`, `cell()`, `fmt()`) locally inside multiple functions — hoist and prefix it once.
- **Module-scoped constants — declare at module level**: constants that are referenced by more than one function (e.g. state priority maps, column lists) must be declared at module level inside the IIFE alongside other constants, not inside individual function bodies. Name them with the module prefix (e.g. `NM_STATE_PRIORITY`).
- **HTML partials + lazy init**: module views live in `public/views/{module}.html` and are injected into `#view-area` on first navigation via `loadPartial()` (idempotent — subsequent navigations skip the fetch). Each module JS file exposes an `initXxxModule()` function on `window` (e.g. `window.initCompaniesModule`). `loadTool()` in `app.js` calls it immediately after the partial is loaded so event listeners and state are wired up only once. New modules must follow this pattern. **See `implementation_notes/module-creation-guide.md` for the complete guide with code templates, HTML skeletons, CSS reference, and step-by-step checklist.**
- **memberActivity.js named exports**: `createZeroCountFields`, `isCacheStale`, `filterByRole`, `filterByActiveState`, `buildFilename`, `buildCache`, `COUNT_COLS`, `CACHE_TTL_MS` are exported as named properties on the router module for unit testing. Router behaviour is unchanged.
- **Download log on error**: import modules that use SSE show the `↓ Download log` button on `onError` as well as `onComplete`/`onAbort`, so partially-run logs are always accessible. For modules where the live log panel is hidden on error (team membership), a download button is added directly to the error state panel (`btn-tm-error-download-log`).
- **Token disconnect event**: when the user disconnects, `app.js` dispatches `window.dispatchEvent(new CustomEvent('pb:disconnect'))` after clearing the session. Each module listens for this event and resets its own state (file inputs, in-memory buffers, UI panels). New modules should follow this pattern — see `public/entities-app.js` and `public/member-activity-app.js` for examples.
- **`transferLog` (notes-merge-app.js)**: a module-local helper that clones live log entries from the running panel into the results panel when a merge completes. No other module currently uses a "running → results with live log carried over" UX. If a future module needs the same pattern, promote `transferLog` to a shared helper in `app.js` rather than duplicating it.
- **Unified UI — reuse before inventing**: always check how existing modules solve a UI problem before writing new markup or JS. Single-file dropzones use `wireDropzone()` from `app.js`. SSE import panels, progress bars, live logs, alert blocks, and diff previews all follow established patterns — copy the closest existing module's HTML structure rather than inventing a new one.
- **`wireDropzone(dropzoneEl, fileInputEl, onFile, [onClear])`** — shared helper in `app.js` for all single-file CSV dropzones. Handles click, drag-and-drop, change events; switches the dropzone to a `has-file` state (solid brand border + background) showing the filename, row count, and a ✕ remove button; returns `{ clear }` for programmatic reset. Store the returned `clear` in module state and call it from the module's reset function.

---

## Known Issues / Tech Debt

See `plan-codebase-improvement.md` for the full prioritized improvement plan (generated 2026-04-02).

### Active issues

- ~~**SSE send methods don't check `aborted`**~~ — ✅ **Resolved**: `send()` and heartbeat now guard on `aborted`.
- **Entity import: can't clear multiselect with bypassEmptyCells** — `fieldBuilder.js` line 257 skips empty cells before reaching the multiselect-clear logic. See plan P1-2.
- ~~**CSS `--c-bg-hover` undefined**~~ — ✅ **Resolved**: defined in `:root`.
- **Entity import: `typeSkipped` counter always 0** — `importCoordinator.js` initializes but never increments it. See plan P1-5.
- **Entity validator: `warnings` array always empty** — created and returned but never populated. See plan P1-6.
- **`setProgress()` and `createViewState()` defined but unused** — app.js exports these shared helpers, but every module defines its own duplicates. See plan P2-6.
- ~~**`escHtml()` in entities-app.js duplicates global `esc()`**~~ — ✅ **Resolved**: replaced with global `esc()`.
- **Email regex inconsistency** — fieldBuilder.js and validator.js use different email patterns for the same field. See plan P2-2.
- ~~**notes-app.js missing `pb:connected` handler**~~ — ✅ **Resolved**: added handler calling `resetNotesExport()`.
- ~~**relationWriter.js section 2 inconsistency**~~ — ✅ **Resolved**: switched to `_postLinkRaw` pattern.
- ~~**Companies domain cache UUID key quirk**~~ — ✅ **Resolved** (2026-04-03): PB fixed the API — `domain` is now a standard key in list responses. UUID discovery loop and individual GET calls removed from `domainCache.js`.

### V1 and v2 company lists are separate
- Companies created via `POST /v2/entities` (PBToolkit import) do NOT appear in v1 `GET /companies`. Always use `GET /v2/entities?type[]=company` (cursor-paginated) for domain caches — covers both legacy v1-created and v2-created companies.

### Objective search endpoint quirk
- The `/v2/entities/search` POST endpoint silently returns empty results for the `objective` type despite being documented; the exporter uses `GET /v2/entities?type[]=objective` instead.

### Previously resolved (audit history)
All critical duplications (token extraction, parseApiError, cell(), UUID_RE, abort handling, pagination loops) were resolved in prior audits. Token/header extraction unified via `pbAuth` middleware. Pagination helpers centralized in `pbClient.js`. Progress bar, error display, download UX, state persistence, completion summaries, and view show/hide inconsistencies all resolved. The objective `team` vs `teams` API quirk was resolved by PB (2026-04-01).

---

## Do Not Touch (fragile areas)

- **`src/lib/pbClient.js` rate limiting logic** — the token-bucket / adaptive backoff is finely tuned. Don't adjust the `minDelay`, `remaining` thresholds, or `withRetry` logic without understanding the Productboard API rate limit headers.
- **`src/routes/notes.js` v1/v2 source-field merge** — notes export merges `source` data from both PB v1 and v2 APIs. The fallback logic (`if (!sourceOrigin && sourceMap)`) is intentional and handles notes that only have source data in v1. Removing it will silently drop source data.
- **`src/services/entities/importCoordinator.js` two-pass relationship write** — relationships must be written in a second pass after all entities are created/patched, because the target entity must exist before the relation can be written. Don't collapse to a single pass.
- **SSE `sse.done()` in `finally`** — this must stay in `finally` or the browser SSE connection will hang on errors. Every SSE route has this; don't remove it.

---

## Debugging Guidelines

When debugging API issues, check the exact field names returned by the API (singular vs plural, nested vs flat) before assuming the schema. Log raw API responses early in debugging.

---

## How to Run

```bash
# Install dependencies
npm install

# Start dev server (nodemon, port 8080)
npm run dev

# Or use the skill
/dev
```

Test endpoints with the built-in skills:
```
/health        → check server is up
/test-token    → validate PB API token from .claude/.env
/test-api      → run all read-only endpoint tests
```

---

## Versioning

The app version lives in `package.json` and is served dynamically via `GET /api/config` → displayed in the footer. **Bump the version in `package.json` when merging to `main` or `staging`.**

Follow [semver](https://semver.org/) — `MAJOR.MINOR.PATCH`:

| Change type | Bump | Example | When |
|---|---|---|---|
| **Breaking change** — removes or renames a route, changes API contract, drops backward compatibility | MAJOR | `3.0.0` → `4.0.0` | Rare; requires user action or deployment config changes |
| **New feature** — new module, new route, new UI capability, new integration | MINOR | `3.0.0` → `3.1.0` | Each feature branch merged to staging/main |
| **Bug fix, polish, docs, tests, refactor** — no new user-facing capability | PATCH | `3.1.0` → `3.1.1` | Fix branches, test updates, style tweaks |

**Rules:**
- A single merge can only bump one level. If a merge includes both a new feature and bug fixes, bump MINOR (the higher level wins).
- Multiple features merged in the same session bump MINOR once, not once per feature.
- PATCH resets to 0 on every MINOR bump. MINOR and PATCH reset to 0 on every MAJOR bump.
- Never skip versions — increment by 1 only.
- Bump the version in the same commit as the merge or as a dedicated `chore: bump version to X.Y.Z` commit immediately after.

---

## AI Workflows

When starting an implementation session (e.g. "implement P1-1 through P1-4"), invoke the `implement-plan` skill. It will read `plan-codebase-improvement.md`, write a structured plan, and ask for confirmation on any functionality changes or unknown Productboard API schemas before writing code.

> **Note on planning docs**: `plan-companies-v2-migration.md`, `plan-oauth-implementation.md`, `plan-entities-delete-from-csv.md`, `plan-reset-settings-on-token-disconnect.md`, `plan-dependencies-support.md` (all in `implementation_notes/`) are specs for future features — none are implemented yet. `plan-team-membership.md` and `plan-teams-crud.md` are completed specs for modules that are now live.

## Local tooling (.claude/)

`.claude/agents/` and `.claude/commands/` are tracked in git and shared with collaborators. `.claude/.env` and the rest of `.claude/` (memory, etc.) remain gitignored — each developer creates their own `.env` with their token.

### Secrets — `.claude/.env`

Store your Productboard token and test config here (never committed):
```
PB_TOKEN=your_token
PB_EU=false
SERVER_URL=http://localhost:8080
```

### Slash commands

| Command | What it does |
|---|---|
| `/health` | Curl `GET /api/health`, print result |
| `/test-token` | Read token from `.claude/.env`, hit `GET /api/validate`, report pass/fail |
| `/test-api` | Run all read-only endpoints and print a status table |
| `/dev` | Start the dev server with `npm run dev` |
| `/pre-staging-audit` | Run consistency + security agents on all files changed vs `main`; prints a combined report with a PASS / BLOCK verdict |

### Agents

| Agent | When to use |
|---|---|
| `endpoint-tester` | Systematic endpoint testing with token from `.claude/.env`; safe (skips destructive routes) |
| `consistency-checker` | Audit changed files for convention violations (module structure, naming, SSE patterns, DOM safety). Run via `/pre-staging-audit` or directly after a major feature. |
| `security-checker` | Audit changed files for XSS, auth gaps, token leakage, SSE safety, and injection risks. Run via `/pre-staging-audit` or directly after touching auth/SSE/innerHTML code. |
