# RULE 1 — VERIFICATION PASS. Do not take your own word for it.

Every claim below needs a command behind it, and you must paste the output.

PART A — IS IT ACTUALLY SHIPPED?
git status --porcelain # must be empty of tracked files
git log --oneline origin/main..HEAD # must be empty
git branch -r --contains HEAD # must name your branch
gh pr list --head <your-branch> # must show a PR, or explain why not
If any of those is wrong, you are not finished. Fix it before continuing.

PART B — DID YOU FOLLOW THE RULES?
pwd # must be under .agent-trees/
git log -1 --format='%an <%ae>' # must be Smarter-Poker # <254329056+...@users.noreply.github.com>
git log --oneline origin/main..HEAD | wc -l
Confirm that every repository hook ran and no bypass mechanism was used.

PART C — IS THE CODE ACTUALLY DONE?
Re-read your own diff before answering: `git diff origin/main...HEAD`

1. STUBS — any TODO, FIXME, `throw new Error('not implemented')`,
   empty catch, hardcoded placeholder, mock left in a real path?
   Search for them; do not rely on memory.
2. WIRING — is every new function actually CALLED? Every new component
   rendered? Every new route reachable? Every emitted event listened
   for? Name the caller for each thing you added.
3. DATABASE — did you add a migration? Was it APPLIED to production
   via the Supabase MCP? A migration file that never ran is a feature
   the code believes in and the database has never heard of.
4. REGRESSIONS — what existing behaviour does this change? Which tests
   covered it? Did you update them in the SAME commit, or leave them
   asserting the old rule?
5. ERROR PATHS — what happens when the network fails, the row is
   missing, the user is logged out? Show me where each is handled.

PART D — DOES IT RUN?
npx tsc --noEmit # paste the result
npx vitest run <the tests covering your change>
npm run build # if you touched src/
Paste real output. "Tests pass" without a count is not an answer.

PART E — IS IT LIVE?
If your PR merged: what SHA does production serve right now, and does it
contain your commit? Check it. Do not say "should be live shortly".
If your PR has not merged: what is blocking it, in the words of the
check that is failing?

ANSWER FORMAT: for each of A–E, either the command output showing it is
satisfied, or a plain statement of what is not done and what you are
doing about it. If something is incomplete, say so — an honest gap is
worth more than a confident claim I have to discover is wrong.

---

---

description: The one and only way agents ship code in this repo. Binding on Claude, Antigravity, Cowork and every other agent.
trigger: always_on

---

# 100% AUTOMATIC PUBLISHING — ZERO HUMAN INTERVENTION

# RULE 1 — VERIFICATION PASS. Do not take your own word for it.

Every claim below needs a command behind it, and you must paste the output.

PART A — IS IT ACTUALLY SHIPPED?
git status --porcelain # must be empty of tracked files
git log --oneline origin/main..HEAD # must be empty
git branch -r --contains HEAD # must name your branch
gh pr list --head <your-branch> # must show a PR, or explain why not
If any of those is wrong, you are not finished. Fix it before continuing.

PART B — DID YOU FOLLOW THE RULES?
pwd # must be under .agent-trees/
git log -1 --format='%an <%ae>' # must be Smarter-Poker # <254329056+...@users.noreply.github.com>
git log --oneline origin/main..HEAD | wc -l
Confirm that every repository hook ran and no bypass mechanism was used.

PART C — IS THE CODE ACTUALLY DONE?
Re-read your own diff before answering: `git diff origin/main...HEAD`

1. STUBS — any TODO, FIXME, `throw new Error('not implemented')`,
   empty catch, hardcoded placeholder, mock left in a real path?
   Search for them; do not rely on memory.
2. WIRING — is every new function actually CALLED? Every new component
   rendered? Every new route reachable? Every emitted event listened
   for? Name the caller for each thing you added.
3. DATABASE — did you add a migration? Was it APPLIED to production
   via the Supabase MCP? A migration file that never ran is a feature
   the code believes in and the database has never heard of.
4. REGRESSIONS — what existing behaviour does this change? Which tests
   covered it? Did you update them in the SAME commit, or leave them
   asserting the old rule?
5. ERROR PATHS — what happens when the network fails, the row is
   missing, the user is logged out? Show me where each is handled.

PART D — DOES IT RUN?
npx tsc --noEmit # paste the result
npx vitest run <the tests covering your change>
npm run build # if you touched src/
Paste real output. "Tests pass" without a count is not an answer.

PART E — IS IT LIVE?
If your PR merged: what SHA does production serve right now, and does it
contain your commit? Check it. Do not say "should be live shortly".
If your PR has not merged: what is blocking it, in the words of the
check that is failing?

ANSWER FORMAT: for each of A–E, either the command output showing it is
satisfied, or a plain statement of what is not done and what you are
doing about it. If something is incomplete, say so — an honest gap is
worth more than a confident claim I have to discover is wrong.

---

> **↗ `AGENT-PLAYBOOK.md` at the repository root is the front door.** Same file
> in all seven repos, checked hourly by `estate-integrity`. It carries the ship
> sequence, every guard and what it is telling you, and **where each credential
> lives**. This file is the Club Arena detail underneath it.

Multiple agents commit here at once (128 commits in 26 hours is a normal day).
Every regression we have traced ended at the same root cause: **an agent trying
to drive the merge itself.** So agents no longer merge. At all.

## 1. Your job ends when the PR exists

```bash
git checkout -b fix/<short-slug> origin/main   # ALWAYS branch from fresh main
# ... make the change ...
git add path/to/file path/to/other-file
git commit -m "fix(scope): what changed"
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
historical rescue branches**, each one somebody's work being saved from
somebody else's checkout. Branch protection cannot help — the damage happens
before anything is pushed.

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

No caller commits in the shared clone. Release automation consumes reviewed
commits; it does not create them or copy Club Arena output through World Hub.

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
| `git pull --rebase origin main` on the Mac clone                                   | Strands the clone mid-rebase. Preserve explicit work and continue in a fresh isolated worktree from `origin/main`.                 |
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

## 6a. Merging is not shipping, and nothing used to check

A green tick answers "did it merge". It does not answer "did it reach
production", and three incidents here were merges that never published while
the agent reported success.

`.github/workflows/production-integrity-audit.yml` asks production directly and
compares cache-busted `build-info.json` with `main`. It is read-only: it cannot
retry, dispatch, reconcile, or publish. A mismatch remains red until the sole
Hetzner publisher succeeds for the exact merged SHA.

Do not break `cancel-in-progress: false` on the publisher or the client suite
inside that publisher. Both are pinned in `tests/shipped-invariants.test.ts`.

## 6b. Branch delivery is event-driven

`agent-branch-proposal.yml` records an unprivileged signal for a newly pushed
branch. The trusted default-branch `agent-open-pr.yml` consumes that completed
signal and opens the pull request once. `agent-autopilot.yml` then responds only
to native pull-request events. No schedule scans, relabels, closes, rebases,
retries, or repairs pull-request state in the background.

## 6c. A ref update cannot silently orphan a commit

`.husky/reference-transaction` fires before a ref update lands and refuses one
that would make local commits unreachable. It is read-only: it creates no
snapshot or rescue ref and never repairs an operation after the fact.
`scripts/agent-workspace.sh` creates new branches without moving an existing ref
backward. There is no environment-variable rewind bypass.

To see what is exposed right now:

```bash
bash scripts/agent-trees-audit.sh       # trees holding work that exists once
```

## 7. If something is genuinely stuck

Fix it, or open an issue describing it. Do not hand it to a human, do not write
a handoff asking someone to push, and do not leave work uncommitted — the
Antigravity `git reset --hard origin/main` loop destroys uncommitted work.
