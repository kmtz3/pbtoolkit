# PBToolkit Manual Testing Guide
_Generated: 2026-03-15_

## How to use
Run automated tests first, then work through each section below.

```bash
node --test test/**/*.test.js   # must be all-green before manual testing
```

Tick each box as you verify it. Re-run after any significant change.

---

## 1. Auth & Token Validation

**Manual token path:**
- [ ] Load the app with no token set → connect modal shown with both OAuth button and manual token field
- [ ] Enter an invalid token and click Connect → clear error message shown, no tools unlock
- [ ] Enter a valid token → modal closes, connection status shows "Connected", tools become accessible
- [ ] Click Disconnect → token cleared, all module state resets, connect form shown again

**OAuth path (requires `PB_OAUTH_CLIENT_ID` / `PB_OAUTH_CLIENT_SECRET` / `PB_OAUTH_REDIRECT_URI` configured):**
- [ ] Click "Sign in with Productboard" → redirected to Productboard OAuth consent screen
- [ ] Approve consent → redirected back to app, connection status shows "Connected"
- [ ] Reload page → app restores "Connected" state via `/api/auth/status` without re-auth
- [ ] Click Disconnect → `POST /auth/pb/disconnect` called, session destroyed, state resets
- [ ] After OAuth disconnect, reload page → app shows "Not connected"

---

## 2. Companies — Export

- [ ] Click Export with a valid token → progress bar appears, SSE log shows activity
- [ ] Export completes → "Exported N companies. Download started." with locale-formatted N
- [ ] Downloaded CSV has columns: PB Company ID, Company Name, Domain, Description, Source Origin, Source Record ID, plus any custom fields with `[type] [uuid]` headers
- [ ] Re-download button appears after export and triggers same file again
- [ ] Export with no companies in workspace → graceful "No companies found" message

---

## 3. Companies — Import

- [ ] Upload a valid CSV → field mapping table populates with base + custom field rows
- [ ] Close tab and re-open → mapping dropdowns restore to previous selections (localStorage)
- [ ] Auto-detect picks up `pb_id`, `name`, `domain` columns by common names (case-insensitive)
- [ ] Preview with no `pb_id` and no `domain` column mapped → validation error per row
- [ ] Preview with duplicate domain values (no UUID column) → validation error flagged
- [ ] Import with `pb_id` column → PATCH existing companies, not CREATE
- [ ] Import with `domain` column only → looks up company by domain, PATCHes if found, CREATEs if not
- [ ] Import with `clearEmptyFields` checked → empty cells clear existing values (not skip)
- [ ] Stop button during import → halts after current row, shows partial count
- [ ] Completion message shows locale-formatted count: "Exported N companies. Download started."

---

## 4. Companies — Delete

- [ ] Delete by CSV: upload CSV with `pb_id` column → correct companies deleted
- [ ] Delete by CSV: UUIDs not found (404) → shown as "skipped", not errors
- [ ] Delete All: confirmation prompt shown before running
- [ ] Delete All: SSE log shows progress every 50 records

---

## 5. Companies — Source Migration

- [ ] Navigate to Source Migration tab → V1→V2 and V2→V1 panels both visible
- [ ] Click "Run V1→V2 migration" → progress bar and Stop button appear
- [ ] Click ⏹ Stop during V1→V2 run → migration halts (regression: stop button was previously wired to wrong ID and did nothing)
- [ ] Click "Run V2→V1 downcopy" → progress bar and Stop button appear
- [ ] Click ⏹ Stop during V2→V1 run → migration halts
- [ ] Navigate away and back → panels reset to idle state

---

## 6. Notes — Export

- [ ] Export notes → CSV downloads with all standard + source columns
- [ ] Source Origin / Source Record ID columns populated from v1+v2 merged data
- [ ] Filename format: `notes-export-YYYY-MM-DD.csv`

---

## 7. Notes — Import

- [ ] Upload CSV and map columns → preview shows row count
- [ ] Import: CREATE rows (no pb_id) → new notes created
- [ ] Import: UPDATE rows (pb_id present) → existing notes patched; empty mapped fields skipped (no empty PATCH sent)
- [ ] Import: abort mid-run → v2 backfill does NOT run for the aborted row
- [ ] Error rows appear in live log in red; successful rows in green

---

## 8. Notes — Delete

- [ ] Delete by CSV: notes with matching UUIDs are deleted
- [ ] Delete All: all notes in workspace removed

---

## 9. Entities — Export

- [ ] Select a single entity type → single CSV downloaded
- [ ] Completion message uses human label: "Exported N Features. Download started." (not "entities")
- [ ] Select multiple types → ZIP file downloaded containing one CSV per type
- [ ] Multi-type completion: "Exported N entities across all selected types. Download started."
- [ ] Filename format: `feature-export-YYYY-MM-DD-HHmm.csv` (note dash-separated date)
- [ ] Objectives export: CSV has `team` column (singular), not `teams`
- [ ] Re-download button appears after export

---

## 10. Entities — Import

- [ ] Upload CSV files per entity type → tiles show row count and file name
- [ ] Mapping state persists per entity type across page reloads
- [ ] Validation: duplicate `ext_key` → error shown before import starts
- [ ] Validation: CREATE row missing `Name` → error shown
- [ ] Validation: release CREATE missing `parent_rlgr_ext_key` → error shown
- [ ] Validation: malformed date in `timeframe_start` → error shown
- [ ] Import runs with SSE log; abort stops cleanly
- [ ] Relationship columns (parent, connections) written in second pass after all entities created

---

## 11. Team Membership — Export

- [ ] Navigate to Team Membership → teams list loads automatically (no manual refresh needed)
- [ ] Token added on another module page then navigate to Team Membership → teams load on arrival
- [ ] Format A export → CSV has `email,name,role` + one column per team with `[uuid]` in header; ✓ for assigned
- [ ] Format B export → CSV has one column per team, member emails stacked vertically
- [ ] Filter teams via checkboxes → only selected teams appear in exported CSV
- [ ] Team search box filters the checkbox list
- [ ] Select All / Deselect All buttons work
- [ ] Export completes → download starts, filename includes date and format suffix for Format B
- [ ] Re-download button after export triggers same file

---

## 12. Team Membership — Import

- [ ] Dropzone shows 📄 icon, "Drop a CSV file here" / "or click to browse" initially
- [ ] Drop or click-to-browse a CSV → dropzone switches to `has-file` state: filename shown, row count shown, ✕ button appears
- [ ] Click ✕ on dropzone → file cleared, dropzone returns to default state, Preview button disabled
- [ ] Drop a replacement file onto the dropzone → new file replaces old one
- [ ] Preview Changes with Format A CSV → diff panel shows added/removed/unchanged per team
- [ ] Preview Changes with Format B CSV → correct diff shown
- [ ] Unresolvable email in CSV → warning shown in diff, not a hard error; import can proceed
- [ ] Unknown team UUID in CSV header → hard error shown, import blocked
- [ ] Set mode: member removed from a team not listed in CSV → that team untouched (set mode only affects columns present in CSV)
- [ ] Confirm import → SSE progress bar advances, live log shows per-operation entries
- [ ] Already-assigned member (409) → logged as "skipped (already a member)", not counted as error
- [ ] Not-a-member on remove (404) → logged as "skipped (not a member)", not counted as error
- [ ] Stop button halts import; partial log remains accessible via "↓ Download log"
- [ ] Import completes → results summary shows added/removed/skipped counts
- [ ] Disconnect token → file input clears, dropzone resets, team list cleared

---

## 13. Teams Management — Import / Delete

- [ ] Teams import dropzone shows `has-file` state (filename + row count + ✕) after file selected
- [ ] Teams delete-by-CSV dropzone shows same `has-file` state
- [ ] Click ✕ on import dropzone → file clears, mapping panel hides, preview panel hides
- [ ] Click ✕ on delete-by-CSV dropzone → file clears, confirm/preview panels hide

---

## 14. Member Activity — Export

- [ ] Connect token → metadata loads (roles, teams) without manual refresh
- [ ] Select date range, roles, teams → export runs
- [ ] Completion message: "Exported N rows. Download started."
- [ ] Filter by Active/Inactive → output contains only matching users
- [ ] Export with many teams selected → filename does not exceed ~204 characters total
- [ ] Raw mode toggle → additional raw-data columns in CSV

---

## 15. Dropzone UI consistency (spot-check across all modules)

- [ ] Companies import dropzone: `has-file` state shows filename, row count, ✕ button
- [ ] Companies import: click ✕ → mapping panel (Step 2) hides
- [ ] Companies delete-by-CSV dropzone: same `has-file` state; click ✕ → Confirm deletion panel hides
- [ ] Notes import dropzone: same; click ✕ → mapping + options panels hide
- [ ] Notes delete-by-CSV dropzone: same; click ✕ → confirm step hides
- [ ] Notes migrate dropzone: same ("Drop your export CSV here" restored on ✕); click ✕ → migrate form hides
- [ ] Teams Management import dropzone: same; click ✕ → mapping panel hides
- [ ] Teams Management delete-by-CSV dropzone: same; click ✕ → preview/confirm panels hide
- [ ] Team Membership import dropzone: same; click ✕ → Preview Changes button re-disables
- [ ] All dropzones: drag-over shows blue border/background; drop triggers file selection
- [ ] All dropzones: clicking anywhere except ✕ opens file picker

---

## 16. Filename conventions (spot-check across modules)

| Module | Expected pattern |
|---|---|
| Companies export | `companies-2026-03-15.csv` |
| Notes export | `notes-export-2026-03-01-to-2026-03-14.csv` |
| Entities single | `feature-export-2026-03-15-1430.csv` |
| Entities multi | `pbtoolkit-entities-export-2026-03-15-1430.zip` |
| Member Activity | `pb-member-activity_2026-03-01_2026-03-14.csv` |

---

## 17. Error & Edge Cases

- [ ] Upload empty CSV → validation message shown (not blank error or crash)
- [ ] Upload CSV with only a header row → "0 rows" shown cleanly
- [ ] Token expires mid-import → 401 error surfaced in live log, import halts
- [ ] Network disconnect mid-export → SSE connection closes, error shown in UI
- [ ] Very large CSV (10 000+ rows) → progress bar advances smoothly, no UI freeze

---

## 18. Security (spot-check)

- [ ] Open browser DevTools → no token visible in URL params or response bodies
- [ ] Inspect response headers → `Content-Security-Policy` and other Helmet headers present
- [ ] Paste `<script>alert(1)</script>` as a company name in a CSV → rendered as escaped text in the log, not executed

---

## 19. UI Consistency

- [ ] Progress bar styling is consistent across Companies / Notes / Entities / Member Activity
- [ ] Live log colour coding consistent: green = success, red = error, yellow = warn, grey = info
- [ ] Back-to-tools button present on every module view
- [ ] Resize browser to narrow width → no horizontal overflow or broken layout

---

_Add new sections here as new modules are shipped._
