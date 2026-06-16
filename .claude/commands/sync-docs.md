---
description: Check for documentation drift against changed code and update CLAUDE.md, IMPLEMENTATION.md, and README.md to reflect the current state of the codebase. Supports two modes — default (changed files only) and full (/sync-docs full, for catching up after many undocumented commits).
---

Audit and update PBToolkit documentation for drift.

## Determine mode

Check the arguments passed to this command:
- If the argument is `full` → run in **Full mode** (entire codebase scan)
- Otherwise → run in **Default mode** (changed files only)

---

# DEFAULT MODE — Changed files only

Use this mode when you have been committing regularly with docs mostly kept up to date.

## Step 1 — Identify changed files

Run:
```bash
git diff main...HEAD --name-only
git diff --name-only
git ls-files --others --exclude-standard
```

Combine into one deduplicated list. If nothing has changed vs main and no uncommitted files exist, report "No changes detected — docs appear current." and stop.

## Step 2 — Read the documentation

Read all three doc files in full:
- `CLAUDE.md`
- `IMPLEMENTATION.md`
- `README.md`

Also read `.claude/guides/module-creation-guide.md` if any new module files are in the change list.

## Step 3 — Inspect changed source files

For each changed file in these categories, read it:
- `src/routes/*.js` — route paths, HTTP methods, new/removed endpoints
- `src/services/**/*.js`, `src/lib/*.js`, `src/middleware/*.js` — exported functions, helper names, behaviours
- `public/*-app.js`, `public/app.js` — module init function names, shared helpers, state variables, localStorage keys
- `public/views/*.html` — new submodules, renamed panels, changed element IDs
- `public/index.html` — new module cards, removed cards, tool names
- `src/server.js` — new router mounts, changed mount paths
- `package.json` — version number, dependencies

For large files (>400 lines), focus on: the top-of-file comment block, exported symbols, route definitions, and the module state block.

## Step 4 — Identify drift

Skip to the **Drift Checklist** section below. Scope your checks to the changed files only.

---

# FULL MODE — Entire codebase scan

Use this mode when you've made many undocumented commits and need to bring the docs fully up to date.

## Step 1 — Read the documentation

Read all three doc files in full:
- `CLAUDE.md`
- `IMPLEMENTATION.md`
- `README.md`
- `.claude/guides/module-creation-guide.md`

## Step 2 — Enumerate the actual codebase

Run these commands to get the ground truth of what actually exists:

```bash
# All source files
find src -type f -name "*.js" | sort
find public -type f \( -name "*.js" -o -name "*.html" \) | sort

# Actual route mounts
grep -n "app\.\(use\|get\|post\|patch\|delete\)" src/server.js

# Actual module init functions exposed on window
grep -rn "window\.init" public --include="*.js"

# Actual localStorage keys
grep -rn "localStorage\." public --include="*.js" | grep -v "//.*localStorage"

# Actual SSE endpoint paths
grep -rn "startSSE\|sse\.progress\|sse\.complete" src/routes --include="*.js" -l

# Line counts for all frontend app files
wc -l public/*-app.js public/app.js public/csv-utils.js 2>/dev/null

# Current version
node -p "require('./package.json').version"
```

## Step 3 — Read all source files

Read every file in these categories (not just changed ones):
- All `src/routes/*.js` files
- `src/server.js`
- `public/app.js` (shared helpers: exported functions, helper signatures)
- All `public/*-app.js` files — focus on: module state block, init function name, localStorage keys, window.init registration
- `public/index.html` — module cards and their `data-tool` attributes
- `src/lib/sse.js`, `src/lib/pbClient.js`, `src/middleware/pbAuth.js` (for convention accuracy)

For files >400 lines, focus on: top-of-file block, exported symbols, route definitions, module state block.

## Step 4 — Identify drift

Apply the **full** Drift Checklist below — check every item, not just those related to recent changes.

---

# DRIFT CHECKLIST

Apply to the scope of your current mode (changed files only vs. all files).

**CLAUDE.md:**
- Directory map — new files missing, deleted files still listed, `~NNN lines` estimates wrong
- Modules and API mount points table — new modules/routes not listed, old ones not removed, mount paths wrong
- Entities module status — phase status changed
- Known Issues — issues marked as unresolved that the code has since fixed; new known bugs not listed
- Key conventions — new patterns in code not documented; documented patterns that no longer exist in the code
- Do Not Touch section — new fragile areas not listed; listed areas that were safely refactored

**IMPLEMENTATION.md:**
- Project structure file tree — new files, deleted files, changed paths
- Route tables and endpoint lists
- Shared helper function signatures in `app.js` (`wireDropzone`, `setProgress`, `createViewState`, `makeLogAppender`, `renderImportComplete`, `loadPartial`, `showAlert`, `showConfirm`)
- Module conventions — new patterns from modules not yet documented
- API client / pagination / SSE / middleware patterns — if `pbClient.js`, `sse.js`, or `pbAuth.js` changed
- localStorage key inventory (if the file documents them)

**README.md:**
- Module list — new modules not described, removed modules still listed
- Feature descriptions that no longer match what the code does
- Setup / install / deployment steps that are outdated

---

# STEP 5 — Report findings before editing

Print a drift report:

```
# Documentation Drift Report — {mode: Default | Full} — {date}

## Source files reviewed
{list, or "All source files (full mode)"}

## Drift found

### CLAUDE.md
- [High|Medium|Low] {description of drift} — {what to change}
...

### IMPLEMENTATION.md
- [High|Medium|Low] {description of drift} — {what to change}
...

### README.md
- [High|Medium|Low] {description of drift} — {what to change}
...

## No drift found in
{list of docs with no issues, if any}
```

Severity levels:
- **High** — doc actively contradicts how the code works (wrong route, wrong function name, wrong pattern)
- **Medium** — doc is incomplete (new thing exists but isn't mentioned)
- **Low** — cosmetic (line count estimate off, minor wording)

If no drift is found in any file, report that and stop — do not edit files.

---

# STEP 6 — Apply updates

For each doc with High or Medium drift, apply the specific edits using the Edit tool. Rules:

- **Edit precisely** — change only the drifted sections. Do not rewrite sections that are still accurate.
- **Preserve structure** — keep existing headings, tables, and formatting conventions. Don't add new sections unless something genuinely new needs documenting.
- **CLAUDE.md line counts** — update `~NNN lines` estimates using `wc -l` output.
- **CLAUDE.md Known Issues** — mark resolved issues with the `~~strikethrough~~` + ✅ **Resolved** pattern already used in the file. Add new issues only for real known bugs or tech debt, not work-in-progress.
- **Do not touch Low-severity drift** unless it takes one word to fix. Low items are informational only.
- **Do not stage or commit** — leave the edits as working tree changes for the user to review.
- **Never edit files in `implementation_notes/`** — those are local planning docs, not maintained documentation.

---

# STEP 7 — Summary

```
# Sync-Docs Complete ({mode})

## Edits made
- CLAUDE.md: {N changes — brief description}
- IMPLEMENTATION.md: {N changes — brief description}
- README.md: {N changes — brief description}

## Left as-is (Low severity)
{list any skipped low-severity items}

## Recommended next step
Review the diffs with `git diff CLAUDE.md IMPLEMENTATION.md README.md` before staging.
```

If no edits were needed, say so clearly.
