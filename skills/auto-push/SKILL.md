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
# 1. Stage all changes
git add -A

# 2. Commit with a descriptive message
git commit -m "Description of what changed"

# 3. Push to current branch
git push
```

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

1. Check if there are merge conflicts → resolve them
2. Check if the branch is behind → `git pull --rebase` then push again
3. Check for auth issues → notify the user

## CRITICAL REMINDER

**A task is NOT complete until the code is pushed to GitHub.** This is the final step of every task, always.
