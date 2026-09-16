---
description: The one and only way agents ship code in this repo. Binding on Claude, Antigravity, Cowork and every other agent.
trigger: always_on
---

> **Current owner instruction (September 16):** Read [AGENTS.md](../../AGENTS.md) before this historical playbook. Task `01a0ab39-71ca-7821-825d-4943a0a6a0a3` retains sole integration and publication authority. Use the original GitHub/Vercel/Hetzner paths. After verified and reported restoration, that owner may deliver the six pending workstreams in the exact order recorded there. Retired local/custom pipelines and external error telemetry must not return. Historical autopilot, automatic-merge, watchdog and repair directions below are inactive. Preserve pending application work and use the configured credential store.

# RULE 1 — VERIFICATION PASS. Do not take your own word for it.

Every claim below needs a command behind it, and you must paste the output.

PART A — IS IT ACTUALLY SHIPPED?
git status --porcelain # must be empty of tracked files
git log --oneline origin/main..HEAD # must be empty
git branch -r --contains HEAD # must name your branch
gh pr list --head <your-branch> # must show a PR, or explain why not

# Use the configured GitHub CLI credential store. Never scrape a token from a

# local `.env`, sibling repository, remote URL, or documentation file.

# And MERGED IS NOT LANDED - the tick is not evidence, the files are:

# git fetch origin main && git cat-file -e origin/main:<path> && echo on-main

If any of those is wrong, you are not finished. Fix it before continuing.

PART B — DID YOU FOLLOW THE RULES?
pwd # must be under .agent-trees/
git log -1 --format='%an <%ae>' # must be Smarter-Poker # <254329056+...@users.noreply.github.com>
git log --oneline origin/main..HEAD | wc -l
Confirm that every commit and push ran the repository hooks and that no guard was bypassed.

PART C — IS THE CODE ACTUALLY DONE? (THE INTERROGATION)
You must re-read your own diff before answering: `git diff origin/main...HEAD`

1. STUBS & MOCKS — Are there any TODO, FIXME, `throw new Error('not implemented')`, empty catch blocks, or hardcoded placeholders left behind? Run a search. Do not rely on memory.
2. WIRING & EXECUTION — Is every new function actually CALLED? Is every new component actually rendered? Is every route reachable? Name the exact caller for every single addition. Dead code is unacceptable.
3. DATABASE STATE — Did you write a migration? Was it actually APPLIED to production via the Supabase MCP? A migration file that hasn't run is a feature the database doesn't know exists.
4. COLLATERAL DAMAGE — What existing behavior did this change alter? Did you update the tests in the SAME commit, or did you leave them asserting the old rules?
5. HOSTILE STATE & CACHE — What happens if the user's `localStorage` is stale? What happens if they enter via a 6-month-old bookmark? Show exactly where the fallback or transition is handled in your code.
6. USER INTENT VERIFICATION — Did you actually solve the specific complaint the user raised? Explain step-by-step how your code definitively prevents the user's exact reported error sequence from ever happening again.

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

Every rule below exists because work was lost, a deploy was blocked, or the
platform stopped publishing. They are not preferences and they are not
negotiable. `AGENT-PLAYBOOK.md` at the repository root is the long form and is
byte-identical in all seven repos; `estate-integrity` checks that contract.

---

## RULE 1 — YOU MUST PUSH AND PUBLISH. FINISHING IS MERGING.

A task is not finished when the code is written. It is finished when the commit
is on GitHub, the CI checks are green, and the PR is MERGED.

```bash
git push origin HEAD:refs/heads/<your-branch>
```

The push starts the unprivileged `Agent Branch Proposal` signal. The trusted
default-branch `agent-open-pr.yml` workflow consumes that signal and opens the
pull request for any eligible branch name. Use the configured GitHub client to
inspect it; never source or copy a token from a workstation `.env`.

**YOU MUST NOT ORPHAN OR ABANDON YOUR WORK** - and you avoid that by PUSHING,
not by waiting. Push, report the branch and the pull request number, and END
YOUR SESSION. Native repository events open it, Autopilot arms protected merge,
and the owning publisher ships it. Read-only production audits provide
independent evidence; they never repair or re-dispatch a failed release.

**NEVER SET A TIMER, AND NEVER USE THE `schedule` TOOL.** This block used to
say the opposite - "Call `schedule` with `DurationSeconds=300`" - and it broke
two binding laws while not working:

- Club Arena `CLAUDE.md` 10.85 / World Hub 10.9, Dan verbatim: "MAKE IT A HARD
  LAW THAT NO OTHER AGENT SCHEDULES ANY CRITICAL TASK, WATCH DOG OR ANYTHING
  ELSE THERE". A scheduled task belongs to ONE Claude account and Dan works
  across several, so one installed from your session is unreachable from the
  next. It does not error and does not warn: it reports `enabled: true` and
  never fires again. `smarter-poker-cron-health` sat exactly like that from
  2026-06-17 for two and a half months while reading as healthy.
- Club Arena `CLAUDE.md` 10.8 rule 3: "NEVER SET A TIMER TO WATCH CI ... 'I've
  set another brief timer and will be back shortly' is the forbidden
  `wait_and_merge.sh` written in prose."

Checking ONCE at the end to say why something is BLOCKED is fine. Sitting in a
loop is not, and neither is force-pushing to make a red branch go green.

**MERGED IS NOT LANDED.** Autopilot squash-merges the moment the required
checks pass - under two minutes on a small change - so a SECOND push to that
branch lands on a closed pull request, exits 0, and reaches nobody. World Hub
#1387 shipped 1 of its 3 commits that way. A follow-up commit needs a NEW
BRANCH off current `main`, and you verify with the files rather than the tick:

```bash
git fetch origin main && git cat-file -e origin/main:<path> && echo on-main
```

## RULE 2 — STRICT GSD COMPLIANCE (WORKTREES ONLY).

**NEVER DEVELOP INSIDE THE SHARED CLONE (`~/Documents/club-arena` or `~/Documents/Smarter-Poker-World-Hub`).**
You must ALWAYS use the `/gsd-new-workspace` workflow (or the `scripts/agent-workspace.sh` script) to spin up an isolated Git worktree for your tasks.

```bash
cd ~/Documents/club-arena
git pull --ff-only
eval "$(bash scripts/agent-workspace.sh <your-name> fix/<short-slug>)"
```

If you make commits inside the shared clone, you break the estate. Work in `.agent-trees/` only.

## RULE 3 — ENFORCE SOURCE OF TRUTH (NO MANUAL COMPILED ASSETS).

Agents must NEVER commit compiled or minified Club Arena assets to `Smarter-Poker-World-Hub`.
Every Club Arena update must flow through a reviewed PR in this repository, followed by the Club Arena-owned Hetzner publisher. World Hub only routes the public URL; it does not build, synchronize, mutate, or publish Club Arena.

## RULE 4 — WHEN A GUARD REFUSES YOU, READ IT.

**`--no-verify` is FORBIDDEN.** It disables protections and causes work to be lost. Read the error and fix the problem (e.g., failing tests, bad commit author).

## RULE 5 — NEVER EVER ASK A HUMAN TO DO A TASK.

**DO NOT EVER ASK THE USER TO MANUALLY DO A TASK.**
You have every single credential (CLI, backend, DB access, GitHub, Supabase) to do every single task yourself.

- If a database migration needs to be run, apply the reviewed migration through
  the configured database client without exposing or relocating credentials.
- If the database is timing out, diagnose and fix the cause through the owning
  reviewed database path. Do not create a timer, watcher, or alternate writer.
- If an already-staged engine SHA needs deployment, coordinate with its current
  owner and immediately send the exact SHA through the trusted Club Arena
  repository-dispatch lane; never restart it by SSH or race an active owner run.
- If a PR needs to be merged, fix its required checks and let the protected
  auto-merge path merge it. Never invoke a merge bypass yourself.
  Never tell Dan to run a command, pull a branch, start a server, open a PR, merge anything, or run a SQL query. If a step needs doing, DO IT YOURSELF.

## RULE 6 — REPORT ONLY WHAT YOU VERIFIED.

No claim without a command behind it. "Tests pass" means you ran them and can
paste the count. "It is deployed" means you checked what production serves.

## RULE 7 — FIX YOUR OWN BUILD. DO NOT WAIT FOR HELP.

If your PR fails CI, has a merge conflict, or gets blocked from deploying, **YOU MUST FIX IT YOURSELF IMMEDIATELY.**
Do not abandon the PR. Do not wait for another agent to fix it. Do not wait for a human to fix it.
Read the failing check, fix the cause, and push the fix.

Three corrections to how that used to read (2026-09-06):

- **Not `schedule`.** See RULE 1 - the tool is banned by `CLAUDE.md` 10.85 and
  silently never fires. Push the fix and end the session; autopilot re-runs the
  checks and merges when they are green.
- **Not a force-push, by default.** If your branch's pull request is still open,
  an ordinary push updates it. Force-pushing is what rewound `main` and dropped
  four commits already serving in production.
- **If the pull request already MERGED, a push to that branch changes nothing**
  and exits 0. Make a NEW BRANCH off current `main`. `scripts/guard-merged-branch.sh`
  refuses that push from `.husky/pre-push` and prints the recovery.

## RULE 8 — THE ZERO-ASSUMPTION DOCTRINE (PROOF OF RESOLUTION)

A green CI pipeline and a merged PR only prove your code does not crash. It **DOES NOT** prove you fixed the user's problem. You are forbidden from claiming success until you have verified the resolution in production.

- **NO SURFACE-LEVEL PATCHES:** You must track the bug to its absolute root cause. Fixing a symptom without checking for structural contagion (e.g., stale cache, inherited state, nested URL parameters) is a failure of your duty.
- **HOSTILE ENVIRONMENT TESTING:** You must assume the user's browser is a hostile environment: old `localStorage` data, expired tokens, stale bookmarks, and mid-flight network drops. If your fix relies on a pristine, freshly-cleared browser state to work, your fix is invalid.
- **BURDEN OF PROOF:** You may not tell the user "I fixed it." You must explicitly explain exactly _how_ you proved their exact edge case is eradicated.

## APPENDIX A — CI PIPELINE & REVERT GUARDS

Required (a PR cannot merge until these are green):

- **TypeScript Check**
- **Client Unit Tests (vitest)**
- **Server Engine (typecheck + tests)**
- **Production Build** — vite build + bundle budget. Deterministic.
- **CSS Beat E2E (multi-table + animations)** — Playwright against this commit's own build.

A green tick answers "did it merge". It does not answer "did it reach production". The owning repository's read-only production integrity audit compares immutable live provenance against `main`; it cannot publish or retry.

## APPENDIX B — A RESET CAN NO LONGER DESTROY A COMMIT OR AN EDIT

`.husky/reference-transaction` fires before any ref update lands and refuses one that would orphan local commits. It writes a recoverable reference under `refs/wip/orphan-guard/<stamp>` before refusing the destructive update. There is no bypass: preserve the work on a feature branch and merge forward.
