# 1. One Push Path Only (No Direct Pushes to Main)

All Antigravity and Claude agents MUST follow a strict Branch -> PR -> Auto-Squash-Merge workflow.

- NEVER push directly to `main` or merge locally.
- ALWAYS checkout a new branch (e.g. `git checkout -b fix/feature-name`).
- ALWAYS push the branch and create a Pull Request (`gh pr create`).
- ALWAYS enable auto-merge immediately via `gh pr merge --auto --squash`. GitHub will merge it when CI passes.
- DO NOT run background scripts to manually poll and merge PRs.

# 2. Never Resolve Conflicts by Taking a Whole File

When a merge conflict occurs, NEVER accept "ours" or "theirs" for the entire file. This destroys concurrent work.

- Use hunk-by-hunk resolution.
- Ensure that you are rebasing onto a fresh `main` immediately before merging.

# 3. Pin Behaviour, Not Mechanism

To prevent silent regressions (e.g., a function reverting while its signature survives), you MUST add invariant tests.

- When creating or modifying a feature that touches the database or RPCs, add an assertion in `tests/shipped-invariants.test.ts`.
- Anchor the test to RPC names, DB effects, and crucial paths. Make sure the behaviour is actually invoked.

# 4. Respect the Mac Clone Guard

If you get blocked by the pre-rebase hook (or the "production is running code main doesn't have" guard):

- DO NOT force push or blindly `git reset --hard origin/main`.
- ALWAYS run `bash scripts/git-unstick.sh` to safely backup local commits and sync with `origin/main`.

# 5. Fix Stale Tests in the Same PR

If your UI or CSS changes cause a test (like E2E Playwright tests) to fail, YOU MUST FIX THE TEST in the same PR. Do not ignore it or bypass CI. A test suite that cries wolf allows real regressions to slip through.
