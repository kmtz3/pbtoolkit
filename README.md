# PBToolkit

A web-based toolkit for bulk operations on Productboard data. Supports exporting, importing, and managing **Companies**, **Notes**, **Entities**, and **Member Activity**.

---

## Running the app

**Requirements:** Node >= 18

```bash
npm install
npm run dev      # development (nodemon, auto-restart)
npm start        # production
```

The app runs on `http://localhost:8080` by default.

### Environment variables

Copy `.env.example` to `.env` and fill in values as needed:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Port the server listens on |
| `FEEDBACK_URL` | — | URL opened by the "Share feedback" button (hidden if unset) |
| `ISSUE_URL` | — | URL opened by the "Report issue" button (hidden if unset) |

```bash
cp .env.example .env
# then edit .env with your values
```

Or pass them inline:

```bash
FEEDBACK_URL=https://your-form.com ISSUE_URL=https://github.com/kmtz3/pbtoolkit/issues/new npm run dev
```

### Docker / Cloud Run

```bash
docker build -t pbtoolkit .
docker run -p 8080:8080 pbtoolkit
```

The Dockerfile targets Cloud Run (`ENV PORT=8080`).

---

## Authentication

Open the app in a browser. You can browse the tool list without a token, but a **Productboard API token** is required before running any operation.

- The token lives only in `sessionStorage` — it is never persisted to disk or sent anywhere except directly to the Productboard API.
- Select **EU datacenter** if your Productboard workspace is hosted on `api.eu.productboard.com`. Tokens are region-bound; switching datacenter requires re-authentication.
- The token is validated on connect by making a test API call. An incorrect token shows an error before you can proceed.

To disconnect, click **Disconnect** in the top-right corner. This clears the session and resets all module pages — file uploads, export results, and any in-progress state are cleared.

---

## Modules

| Module | Status | Description |
|---|---|---|
| Companies | ✅ Live | Export and import companies with custom fields |
| Notes | ✅ Live | Export, import, delete, and migration-prep for notes |
| Entities | 🔄 Polish | Templates, export, and import for all entity types (QA in progress) |
| Member Activity | ✅ Live | Export member activity and license utilization data |
| Team Membership | ✅ Live | Export and bulk-import team assignments via CSV diff preview |

---

## Companies

### Export companies

Fetches all companies and generates a downloadable CSV.

| CSV Column | Source |
|---|---|
| PB Company ID | `company.id` |
| Company Name | `company.name` |
| Domain | `company.domain` |
| Description | `company.description` |
| Source Origin *(v1 — deprecated)* | `company.sourceOrigin` (v1 API) |
| Source Record ID *(v1 — deprecated)* | `company.sourceRecordId` (v1 API) |
| External System Name *(v2)* | `metadata.source.externalSystemName` |
| External Record ID *(v2)* | `metadata.source.externalRecordId` |
| *(one column per custom field)* | `entity.fields` |

Custom field values are fetched in parallel batches of 5. Progress is streamed in real time. Output filename: `companies-YYYY-MM-DD.csv`.

### Import companies

A four-step guided flow: **Upload → Map columns → Validate → Run**.

**Column mapping** auto-detects common headers. Base fields:

| PB Field | Required | Notes |
|---|---|---|
| PB Company UUID | No | If present, row will PATCH by UUID regardless of domain |
| Company Name | Yes | |
| Domain | Yes* | *Not required if every row has a UUID |
| Description | No | Supports a subset of HTML tags |
| Source Origin | No | |
| Source Record ID | No | |

**Validation** (optional, client + server-side) checks: required fields, duplicate domains, UUID format, custom field type mismatches, text values over 1024 chars.

Supported HTML tags in Description: `h1 h2 p b i u s code pre ul ol li a hr blockquote span br`. Unsupported tags are stripped automatically; plain text is wrapped in `<p>` tags.

**Run logic per row:**
- Has UUID → PATCH that company directly
- No UUID, domain exists → PATCH matched company
- No UUID, domain is new → POST (create)

Standard and custom fields are written in a single v2 API call per row. Source fields (`Source Origin`, `Source Record ID`) map to `metadata.source.externalSystemName` and `metadata.source.externalRecordId` in the v2 API.

A **Stop** button is available during import. The summary shows rows processed, created, updated, and error count.

---

## Notes

### Export notes

Fetches all notes via the v2 API and exports a CSV including note content, owner, company association, source origin/record ID, and timestamps. User and company names are resolved from UUID caches to avoid per-note API calls.

Output filename: `notes-YYYY-MM-DD.csv`.

### Import notes

Uploads a CSV and creates or updates notes. Match logic:

1. Match by `pb_id` (UUID) if present
2. Match by `source[recordId]` (external ID) if present
3. Create new note if no match found

Owner assignment is attempted first; if rejected, the note is created without an owner and the owner is backfilled via the v2 API (with retry for v1→v2 propagation lag).

### Delete notes by CSV

Uploads a CSV with a `pb_id` column and deletes the listed notes one by one, with a live log.

### Delete all notes

Deletes **all** notes in the workspace. Requires typing `DELETE` to confirm. Irreversible.

### Migration prep

A pure client-side CSV transform — no API calls. Converts an exported notes CSV into a migration-ready format: copies `pb_id` to `ext_id` (source record ID), sets a `source_origin`, and clears `pb_id` so the import creates new notes rather than patching existing ones.

---

## Entities *(in progress)*

Covers all Productboard entity types: objectives, key results, initiatives, products, components, features, subfeatures, release groups, and releases.

### What's live

**Templates tab** — Download pre-built CSV import templates for any entity type. Templates include all supported fields (system + custom, pulled live from the API) with a header row ready for data entry.

**Export tab** — Export any combination of entity types as CSV (single type) or ZIP (multiple types). Check the entity types you want, then click "Download selected". Migration mode rewrites UUID `ext_key`s and relationship columns to `WORKSPACE-TYPE-NNN` format for cross-workspace moves. Workspace code required when migration mode is on.

**Normalize ext_keys tab** — Upload exported CSVs (one or more entity types) and a workspace code to rewrite UUID `ext_key`s to `WORKSPACE-TYPE-NNN` format with full cross-entity relationship rewriting. No API calls — pure CSV transform. Returns a ZIP. Useful for preparing exports from one workspace for import into another.

**Import tab** — Full import pipeline. Drag-and-drop one or more entity-type CSVs, map columns with auto-detection, validate, then run. Entities are processed in dependency order (objectives → releases). Supports CREATE (new rows) and PATCH (rows with `pb_id`). After upserts, parent links and connected links (feature↔initiative, feature/initiative/subfeature↔release, etc.) are written automatically. Live log streams row-by-row results; per-entity summary on completion. Options: multi-select mode (set / addItems / removeItems), bypass empty cells, bypass HTML formatter, fiscal year start month, auto-generate ext_keys. "Fix relationships" button re-runs only the relationship pass (idempotent — 409s logged as already linked). Stop button available during run.

### Known API quirks

- **Objectives — `team` vs `teams` field key**: The Productboard API returns and expects the team field as `team` (singular) for objectives, while all other entity types use `teams` (plural). This is handled automatically by PBToolkit in both export (reading) and import (writing).
- **Objectives — search endpoint**: The `POST /v2/entities/search` endpoint silently returns empty results for `objective` type despite being documented. PBToolkit uses `GET /v2/entities?type[]=objective` instead.

### What's coming

| Item | Description | Status |
|---|---|---|
| QA | End-to-end testing with real CSV fixtures across all 9 entity types | 🔜 Next |

---

## Member Activity *(WIP)*

Exports member activity data from the Productboard Analytics API enriched with current member profiles and team assignments.

### Features

- **Two export modes**: Summary (one row per member, totals across the date range) or Raw (one row per member per day for trend analysis)
- **Date range presets**: Last 7/30/90 days, this month, last month, or custom range
- **Filters**: Role (admin/maker/viewer/contributor), team (scrollable checkbox list with search), active/inactive toggle
- **Include members with no records**: Pads the export with zero-rows for workspace members the Analytics API returned no data for — useful for a complete roster audit
- **Zero-activity alert**: After export, surfaces count of maker/admin seat holders with 0 active days with guidance on license review
- **Session cache**: Member and team data is fetched once per session (30-min TTL) and reused across exports to minimise API calls

### APIs used

| API | Endpoint |
|---|---|
| Analytics | `GET /v2/analytics/member-activities` |
| Members | `GET /v2/members` |
| Teams | `GET /v2/teams`, `GET /v2/teams/{id}/relationships` |

A single bearer token covers all three APIs.

### Output

Filename convention: `member-activity-{dateFrom}-{dateTo}[-{roles}][-{teams}][-{activeFilter}][-raw].csv`

**Summary columns:** `member_id, name, email, role, teams, date_from, date_to, active_days_count,` + activity count columns (boards created/opened, features created, notes processed, insights, etc.)

**Raw columns:** `date, member_id, name, email, role, teams, active_flag,` + same count columns.

### Known limitations

The `GET /v2/analytics/member-activities` endpoint has a bug in `links.next` (relative path instead of absolute URL, missing `/v2/analytics/` prefix). A workaround is in place in `src/routes/memberActivity.js` — see the `WORKAROUND` comment block for details and the cleanup TODO for when engineering ships a fix.

---

## Team Membership

Bulk-manages team–member assignments via two tabs: **Export** (download current assignments as CSV) and **Import** (upload a CSV to add, remove, or reconcile assignments with a diff preview before any writes).

### Export

Fetches all teams and member assignments and generates a CSV in one of two formats:

- **Format A** — one row per member, one column per team. Tick marks show current assignments. Best for reviewing and editing who is on which team.
- **Format B** — one column per team, member emails stacked vertically. Best for pasting email lists from external tools (HRIS exports, Slack, spreadsheets).

Filter to specific teams using the checkbox list. Output filename: `pb-team-assignments_YYYY-MM-DD[_stacked][_team-slug].csv`.

### Import

A four-step flow: **Upload → Preview diff → Confirm → Run**.

Three import modes:

| Mode | Behaviour |
|---|---|
| **Set** *(default)* | Treats the CSV as the source of truth for the listed teams. Adds missing assignments and removes extras. Teams not in the CSV are untouched. Review diff carefully — this removes assignments. |
| **Add** | Only adds assignments from the CSV. Nothing is removed. Safe to run multiple times. |
| **Remove** | Only removes the assignments listed in the CSV. Nothing is added. |

**Diff preview** shows a per-team breakdown of what will be added (green `+`), removed (red `−`), and unchanged (grey `●`), plus the estimated API call count. Confirmation is required before any write operations execute.

**Unresolved emails** (not found in the workspace member list) are shown as warnings — the import proceeds for all other rows.

A **Stop** button is available during import. The results panel shows assignments added, removed, and skipped (already assigned / not a member).

### Known limitations

Every add/remove is a separate API call (no bulk endpoint). Large imports should be planned against the workspace rate limit (1,000 requests/hour) — the diff preview shows an estimate.

---

## API rate limiting

All Productboard API calls go through a shared client that:

- Respects `X-RateLimit-Remaining` headers, throttling automatically as the limit approaches
- Retries on `429 Too Many Requests` (honouring `Retry-After`) and `5xx` errors
- Uses exponential backoff with jitter, up to 6 attempts

---

## UI

### Feedback widget

A fixed bottom-right widget with two buttons — **Share feedback** and **Report issue**. URLs are configured via the `FEEDBACK_URL` and `ISSUE_URL` environment variables. Each button is hidden automatically if its corresponding variable is not set, so the widget only appears when at least one URL is configured.

On page load, the frontend calls `GET /api/config` to retrieve the URLs from the server and applies them to the anchor elements at runtime — no rebuild required when changing URLs.
