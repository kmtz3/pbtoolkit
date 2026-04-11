---
description: Commit Skill — PBToolkit version. Bumps package.json version (semver) before committing, based on the nature of the changes. Then commits all staged + relevant untracked files together.
---

Commit the current changes for PBToolkit. Follow these steps exactly.

## Step 1 — Understand the changes

Run in parallel:
```bash
git status
git diff HEAD
git log --oneline -5
```

Review the diff to understand what changed: new feature, bug fix, refactor, chore, etc.

## Step 2 — Determine the semver bump

Use the rules from CLAUDE.md:

| Change type | Bump |
|---|---|
| Breaking change — removes/renames a route, changes API contract | MAJOR |
| New feature — new module, new route, new UI capability | MINOR |
| Bug fix, polish, docs, tests, refactor — no new user-facing capability | PATCH |

- A single commit can only bump one level. If it includes both a new feature and bug fixes, bump MINOR.
- Never skip versions — increment by 1 only.
- PATCH resets to 0 on MINOR bump. MINOR and PATCH reset to 0 on MAJOR bump.

Read the current version:
```bash
node -p "require('./package.json').version"
```

## Step 3 — Bump the version in package.json

Edit `package.json` with the new version using the Edit tool. Do not use sed or shell substitution.

## Step 4 — Stage files and commit

Stage the changed source files plus `package.json`:
```bash
git add <files> package.json
```

Never use `git add -A` or `git add .` — add files by name only.
Never stage files in `implementation_notes/`, `*.md` audit/plan docs, or `.claude/.env`.

Write the commit message using a HEREDOC:
```bash
git commit -m "$(cat <<'EOF'
<type>: <description>

chore: bump version to X.Y.Z

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

If the version bump is the only change (e.g. after a merge), use a single-line message:
```bash
git commit -m "$(cat <<'EOF'
chore: bump version to X.Y.Z

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

## Step 5 — Confirm

Run `git status` to confirm the working tree is clean, then report what was committed and the new version.
