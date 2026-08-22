---
description: The one and only way agents ship code in this repo. Binding on Claude, Antigravity, Cowork and every other agent.
trigger: always_on
---

# 100% AUTOMATIC PUBLISHING — ZERO HUMAN INTERVENTION

Multiple agents commit here at once (128 commits in 26 hours is a normal day).
Every regression we have traced ended at the same root cause: **an agent trying
to drive the merge itself.** So agents no longer merge. At all.

## 1. Your job ends when the PR exists

```bash
git checkout -b fix/<short-slug> origin/main   # ALWAYS branch from fresh main
# ... make the change ...
git add -A && git commit -m "fix(scope): what changed"
git push -u origin HEAD
gh pr create --fill
```

**Then stop.** `.github/workflows/agent-autopilot.yml` enables squash
auto-merge within seconds, keeps the branch fresh as main moves, and GitHub
merges it the moment the required checks go green.

## 1a. One working tree per agent — NEVER share a checkout

Three to five agents work in this repo at once. A git working tree has exactly
one HEAD, one index, and one set of uncommitted files. So when a second agent
runs `git checkout -b` in the same directory, the first agent's in-progress
edits either ride onto the wrong branch or get stashed out from under it — and
neither agent is told. Then the Antigravity `git reset --hard origin/main` loop
destroys whatever is still uncommitted.

This repo was carrying the evidence: **eight abandoned stashes and six
`backup/*` branches** from `git-unstick.sh` rescues, each one somebody's work
being saved from somebody else's checkout. Branch protection cannot help — the
damage happens before anything is pushed.

**Start every task by claiming your own tree:**

```bash
eval "$(bash scripts/agent-workspace.sh <your-agent-name> fix/<slug>)"
```

That puts you in `~/Documents/.agent-trees/<repo>/<your-agent-name>` on
`agent/<your-agent-name>/fix/<slug>`, branched from a freshly fetched
`origin/main`, sharing one object store. Agents become physically unable to
disturb each other. If your tree has uncommitted work, the script refuses to
move you off it and says so.

Never `git checkout` in `~/Documents/club-arena` itself — that clone is the
shared object store and a mirror of origin, not a place to work.

**This is enforced now, not advised.** `.husky/pre-commit` runs
`scripts/guard-shared-clone.sh`, which refuses a commit whose `--git-dir` and
`--git-common-dir` are the same path — the signature of the shared clone. It
never stashes and never checks anything out: moving an agent off its own
uncommitted work is the exact destruction being prevented, so it refuses,
prints the `agent-workspace.sh` line to run, and stops.

Callers that legitimately commit in the one-and-only tree — `git-safe-push.sh`,
the World Hub sync, any CI checkout — set `AGENT_SHARED_CLONE_OK=1`. Say it
explicitly at the call site; do not weaken the guard to accommodate a script.

And a per-agent tree is not the same as safe: it stops agents overwriting each
other, not an agent leaving hours of work where the Antigravity
`git reset --hard origin/main` loop will delete it.

```bash
bash scripts/agent-trees-audit.sh    # every tree, what is uncommitted, how old
```

Read-only. Exits 1 when any tree holds work that exists in exactly one place,
so it can drive a scheduled task. The first run found a tree carrying 28
uncommitted files whose newest edit was 3h 43m old.

## 2. FORBIDDEN — every one of these caused a real incident

| Never do this                                                                      | What actually happened                                                                                                             |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `gh pr merge --admin`                                                              | Bypasses required checks. Red code reached main four times.                                                                        |
| `gh pr merge --merge`                                                              | Merge commits are **disabled** on this repo. The API call fails **silently**; the PR sits open for hours while you report success. |
| `gh pr merge --rebase`                                                             | Also disabled. Same silent failure.                                                                                                |
| Background polling scripts (`wait_and_merge.sh`, `while true; do gh run list ...`) | Fragile, unobservable, and the source of both failures above. Autopilot already does this, server-side.                            |
| `git push` directly to `main`                                                      | Blocked by the ruleset. Attempting it wastes a cycle.                                                                              |
| `git push --force` / `--force-with-lease` on main                                  | Rewound main and dropped four commits that were already live in production.                                                        |
| `git pull --rebase origin main` on the Mac clone                                   | Strands the clone mid-rebase. Use `bash scripts/git-unstick.sh`.                                                                   |
| Asking Dan to click merge, run a script, or "approve" anything                     | The entire point of this file.                                                                                                     |

If a PR is not merging, **read the failing check and fix the code**. Never
reach for a flag that makes the check stop applying.

## 3. Never resolve a conflict by taking a whole side

`--ours` / `--theirs` on a whole file is how the leaderboard RPC call
disappeared while its function signature survived — code that compiled, passed
typecheck, and was silently wrong for a day.

Resolve hunk by hunk. Then run the test that covers the file you touched.

## 4. Pin behaviour, not mechanism

A signature surviving while a body reverts is invisible to TypeScript. When you
ship anything touching the database, an RPC, or a published path, add an
assertion to `tests/shipped-invariants.test.ts` anchored to the **RPC name / DB
effect / route**, not to phrasing. One line would have caught the leaderboard.

## 5. Fix stale tests in the same PR

If your change intentionally replaces behaviour a test pins, update that test in
the **same commit**. Never commit a red spec "for someone else". Writing the
spec first is encouraged — commit it `it.skip()` with a note, and remove the
`.skip` in the commit that implements it.

A suite that cries wolf is how a real regression walks in unnoticed.

## 6. Which checks gate a merge, and why

Required (a PR cannot merge until these are green):

- **TypeScript Check**
- **Client Unit Tests (vitest)**
- **Server Engine (typecheck + tests)**
- **Production Build** — vite build + bundle budget. Deterministic.
- **CSS Beat E2E (multi-table + animations)** — Playwright against **this
  commit's own build**, served locally.

Not required, and deliberately so:

- **Live Production E2E** — drives the deployed `smarter.poker`. On a PR that is
  not your code, it is whatever main last shipped, so it can never validate the
  change under review. It runs after main deploys and opens an issue when
  production genuinely breaks.

## 7. If something is genuinely stuck

Fix it, or open an issue describing it. Do not hand it to a human, do not write
a handoff asking someone to push, and do not leave work uncommitted — the
Antigravity `git reset --hard origin/main` loop destroys uncommitted work.
