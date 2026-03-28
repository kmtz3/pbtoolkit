# Documentation Update Report

**Generated**: 2026-03-28
**Scope**: Full repo
**Mode**: auto

---

## Summary

| Status | Count |
|--------|-------|
| Updated | 5 |
| Up to date (skipped) | 1 |
| Orphaned (flagged, not deleted) | 0 |
| Needs manual review | 0 |

---

## Files Updated

### `CLAUDE.md`
- **Status**: MINOR_DRIFT
- **What changed**:
  - Updated "Last audited" date to 2026-03-28
  - Added `src/routes/auth.js` to the directory map
  - Added OAuth Auth row to the Modules and API mount points table
  - Updated the **Token** key convention to describe session-first resolution (OAuth path takes priority over header token)
- **What was preserved**: All other sections, known issues, conventions, planning doc refs

### `IMPLEMENTATION.md`
- **Status**: MINOR_DRIFT
- **What changed**:
  - Added `auth.js` to the project structure tree
  - Updated "Headers (backend)" section to reflect `pbAuth`'s session-first token resolution (was: showed legacy direct header reads)
  - Added `SESSION_SECRET`, `PB_OAUTH_CLIENT_ID`, `PB_OAUTH_CLIENT_SECRET`, `PB_OAUTH_REDIRECT_URI` to the env vars table
  - Added a new **OAuth authentication** section describing the four auth routes, token storage, and required env vars
- **What was preserved**: All existing module patterns, entity module detail, SSE helper docs, CSS design system, pagination patterns

### `README.md`
- **Status**: MINOR_DRIFT
- **What changed**:
  - Rewrote the Authentication section to describe both OAuth (primary) and manual API token (fallback) paths
  - Added `SESSION_SECRET`, `PB_OAUTH_CLIENT_ID`, `PB_OAUTH_CLIENT_SECRET`, `PB_OAUTH_REDIRECT_URI` to the environment variables table
  - Changed `## Entities *(in progress)*` header to `## Entities` (module is live per modules table)
  - Changed `## Member Activity *(WIP)*` header to `## Member Activity` (module is live per modules table)
- **What was preserved**: All module documentation, API quirks, rate limiting section, UI/feedback widget section

### `test/TESTING-GUIDE.md`
- **Status**: MINOR_DRIFT
- **What changed**:
  - Expanded section 1 (Auth & Token Validation) to cover both the manual token path and the new OAuth path
  - Added OAuth test cases: redirect to consent screen, callback success, page-reload session restore, disconnect
- **What was preserved**: All existing 19 sections, section numbering, formatting

### `.env.example`
- **Status**: MINOR_DRIFT
- **What changed**:
  - Added `SESSION_SECRET` with a placeholder value and production warning
  - Added `PB_OAUTH_CLIENT_ID`, `PB_OAUTH_CLIENT_SECRET`, `PB_OAUTH_REDIRECT_URI` with blank defaults and explanatory comment
- **What was preserved**: Existing `PORT`, `FEEDBACK_URL`, `ISSUE_URL` entries

---

## Files Skipped (Up to Date)

- `implementation_notes/*.md` — planning docs unaffected by OAuth work; all accurate

---

## Orphaned References Found

None.

---

## Needs Manual Review

None.

---

## Not Covered

- `.claude/commands/*.md` skill files — gitignored, not in repo scope
- `.claude/agents/*.md` agent files — gitignored, not in repo scope
