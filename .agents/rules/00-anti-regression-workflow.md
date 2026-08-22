# 100% AUTOMATIC CI/CD PUBLISHING WORKFLOW (MANDATORY)

You are operating in a high-velocity repository where multiple AI agents commit to `main` simultaneously. To prevent silent regressions, merge conflicts, and lost work, ALL agents must adhere to this 100% automated workflow without ANY human intervention.

## 1. One Push Path Only (No Direct Pushes to Main)

- **NEVER push directly to `main` or merge locally.**
- ALWAYS create and checkout a new branch (e.g. `git checkout -b fix/feature-name`).
- ALWAYS commit and push the branch.
- ALWAYS create a Pull Request (`gh pr create --title "..." --body "..."`).
- ALWAYS enable auto-merge immediately via `gh pr merge --auto --squash`. GitHub will merge it automatically the millisecond CI passes.
- DO NOT run background scripts to manually poll and merge PRs.

## 2. No Wholesale Conflict Resolution

When a merge conflict occurs, NEVER accept "ours" or "theirs" for the entire file. This destroys concurrent work.

- Use hunk-by-hunk resolution.
- Ensure that you are rebasing onto a fresh `main` immediately before merging.

## 3. Pin Behaviour, Not Mechanism

To prevent silent regressions (e.g., a function reverting while its signature survives), you MUST add invariant tests.

- When creating or modifying a feature that touches the database or RPCs, add an assertion in `tests/shipped-invariants.test.ts`.
- Anchor the test to RPC names, DB effects, and crucial paths. Make sure the behaviour is actually invoked.

## 4. Respect the Mac Clone Guard

If you get blocked by the pre-rebase hook (or the "production is running code main doesn't have" guard):

- DO NOT force push or blindly `git reset --hard origin/main`.
- ALWAYS run `bash scripts/git-unstick.sh` to safely backup local commits and sync with `origin/main`.

## 5. Fix Stale Tests in the Same PR

If your UI or CSS changes cause a test (like E2E Playwright tests) to fail, YOU MUST FIX THE TEST in the same PR. Do not ignore it or bypass CI. A test suite that cries wolf allows real regressions to slip through.

## 6. Zero Human Intervention

- If a CI job fails, read the failure (`gh run view --log-failed`), fix the issue, commit, push, and trust `--auto` to merge it when the next run passes.
- Never ask the user to "merge it for you".
- Never ask the user to "click the button".
- Do not stop until the feature is successfully merged to `main` and deploying.
