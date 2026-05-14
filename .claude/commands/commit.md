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

## Step 2 — Check the current branch

```bash
git branch --show-current
```

**If the current branch is `main`:** do NOT bump the version. The version was already bumped when the work was committed to `staging`. Skip Steps 3 and proceed directly to Step 4 (staging only). Simply merge or commit without touching `package.json`.

**If the current branch is `staging` or any feature branch:** continue to Step 3.

## Step 3 — Determine the semver bump (staging / feature branches only)

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

## Step 4 — Bump the version in package.json (staging / feature branches only)

Edit `package.json` with the new version using the Edit tool. Do not use sed or shell substitution.

## Step 5 — Stage files and commit

Stage the changed source files plus `package.json`:
```bash
git add <files> package.json
```

Never use `git add -A` or `git add .` — add files by name only.
Never stage files in `implementation_notes/`, `*.md` audit/plan docs, or `.claude/.env`.

Write the commit message using a HEREDOC. On `staging`, include the version bump in the body:
```bash
git commit -m "$(cat <<'EOF'
<type>: <description>

Bumps version to X.Y.Z.
EOF
)"
```

On `main` (no version bump), use a plain merge message:
```bash
git commit -m "$(cat <<'EOF'
<type>: <description>
EOF
)"
```

## Step 6 — Confirm

Run `git status` to confirm the working tree is clean, then report what was committed and the new version.
