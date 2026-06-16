---
description: Run consistency, security, and docs-drift audits on all files changed since main. Produces a combined report before merging to staging.
---

Run a full pre-staging audit on this branch. Follow these steps exactly.

## Step 1 — Get changed files

Run:
```bash
git diff main...HEAD --name-only
```

Collect the list. Filter to files that exist and are auditable:
- Frontend JS: `public/*-app.js`, `public/app.js`, `public/csv-utils.js`
- Backend: `src/routes/*.js`, `src/services/**/*.js`, `src/lib/*.js`, `src/middleware/*.js`
- HTML: `public/views/*.html`, `public/index.html`

If no changed files are found, report "No changed files vs main — nothing to audit."

## Step 2 — Consistency audit

Invoke the `consistency-checker` agent with the list of changed files as context. Ask it to audit only those files (not the entire codebase) against the PBToolkit conventions in `.claude/agents/consistency-checker.md`.

## Step 3 — Security audit

Invoke the `security-checker` agent with the same list of changed files. Ask it to audit those files against the checks in `.claude/agents/security-checker.md`.

## Step 4 — Docs sync

Run `/sync-docs` in default mode (changed files only) — this is the same scope as Steps 2 and 3.

The docs sync will:
1. Print a drift report showing what it found
2. Apply edits to `CLAUDE.md`, `IMPLEMENTATION.md`, and/or `README.md` for any High or Medium drift

Include the drift report output and a list of any edits made in the combined report below.

## Step 5 — Combined report

Print a combined report:

```
# Pre-Staging Audit — {branch name} — {date}

## Scope
Files audited: {N}
{list files}

---

## Consistency findings
{paste consistency-checker output}

---

## Security findings
{paste security-checker output}

---

## Docs drift
{paste sync-docs drift report}

Edits applied:
- CLAUDE.md: {N changes, or "none"}
- IMPLEMENTATION.md: {N changes, or "none"}
- README.md: {N changes, or "none"}

---

## Verdict
[ ] PASS — No issues found. Safe to merge to staging.
[ ] PASS WITH NOTES — Only Low/Defer items. Safe to merge; consider fixing before main.
[ ] BLOCK — High or Critical issues found. Fix before merging to staging.
```

Choose the verdict based on severity:
- Any Critical or High security issue → BLOCK
- Any High consistency issue → BLOCK
- High doc drift that could not be auto-fixed → BLOCK
- Medium or lower only → PASS WITH NOTES
- Nothing found (or only auto-fixed doc drift) → PASS

If docs edits were applied, append this note to the verdict:
> Docs updated — review with `git diff CLAUDE.md IMPLEMENTATION.md README.md` before staging.
```
