---
name: auto-push
description: 'MANDATORY post-completion protocol. After ANY fix, build, update, or code change is finished, the agent MUST push to GitHub. This is non-negotiable. Trigger on: every task completion, every code change, every fix, every build, every update.'
---

# Auto-Push to GitHub — Mandatory Post-Completion Protocol

## RULE (NON-NEGOTIABLE)

**After EVERY code change, fix, build, or update — you MUST push to GitHub before considering the task complete.**

No exceptions. No "I'll push later." No forgetting. The work is NOT done until it is pushed.

## WHEN TO PUSH

Push after ANY of the following:

- A bug fix
- A feature addition
- A code cleanup / refactor
- A file deletion
- A config change
- A dependency update
- A build verification that resulted in code changes
- An audit that resulted in fixes
- ANY modification to tracked files

## HOW TO PUSH

Run these commands sequentially from the project root:

```bash
# 1. Review the worktree, then stage only paths you intentionally changed
git status --short
git add <path> [<path> ...]

# 2. Commit with a descriptive message
git commit -m "Description of what changed"

# 3. Bring current main forward without rewriting published history
git fetch origin main
git merge --no-edit origin/main

# 4. Push the feature branch with every repository hook enabled
git push -u origin HEAD
```

Never push directly to `main`, rebase shared work, stage another agent's files,
or skip a hook. The Club Arena pull request and owning Hetzner workflows are
the only release route.

### Commit Message Guidelines

- Be specific: `fix: remove notification badge overlay from lobby Player Stats tile`
- NOT vague: `updates` or `fix stuff`
- Use conventional prefixes when appropriate:
  - `fix:` — bug fixes
  - `feat:` — new features
  - `refactor:` — code cleanup without behavior change
  - `chore:` — config, dependency, or tooling changes
  - `perf:` — performance improvements
  - `style:` — visual/CSS changes

## VERIFICATION

After pushing, confirm the push succeeded by checking the output. If it fails:

1. Check whether the remote branch already belongs to a merged/closed pull request;
   if so, create a new feature branch from current `origin/main`.
2. If `main` advanced, merge `origin/main`, resolve conflicts, and rerun the gates.
3. Fix authentication or source/test failures and retry the normal push.

## CRITICAL REMINDER

**A task is NOT complete until the code is pushed to GitHub.** This is the final step of every task, always.
