---
description: The one and only way agents ship code in this repo. Binding on Claude, Antigravity, Cowork and every other agent.
trigger: always_on
---

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
State plainly whether you used --no-verify at any point. If you did, say where and why.

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

Every rule below exists because work was lost, a deploy was blocked, or the
platform stopped publishing. They are not preferences and they are not
negotiable. `AGENT-PLAYBOOK.md` at the repository root is the long form and is
byte-identical in all seven repos; `estate-integrity` checks that hourly.

---

## RULE 1 — YOU MUST PUSH AND PUBLISH. FINISHING IS MERGING.

A task is not finished when the code is written. It is finished when the commit
is on GitHub, the CI checks are green, and the PR is MERGED.

```bash
git push -u origin HEAD && gh pr create --fill
```

**YOU MUST NOT ORPHAN OR ABANDON YOUR WORK.** Do not exit immediately after pushing! You must verify the PR actually goes green and merges. You must automatically do all push and publish procedures. If you don't do this, you are explicitly violating the playbook.
Use the **`schedule`** tool:

1. Call `schedule` with `DurationSeconds=300` (5 minutes) and `Prompt="Check if the PR went green and merged. If it failed, fix it, and push again."`
2. End your turn. The system will wake you up when the timer fires.
3. Check `gh pr status` and `gh run list --branch <branch>`.
   - If **Merged**: You are done!
   - If **Pending**: Set another timer and go back to sleep.
   - If **Failed/Blocked**: Fix the issue, force-push, and set a new timer.
4. **Never report task complete** to the user until the PR is verified green and merged.
5. You must run the clock checks to ensure it actually pushes, publishes, and leaves github with zero errors ALWAYS, without the user having to specifically ask you to check.

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

Agents must NEVER manually commit compiled or minified `assets/*.js` files directly to `Smarter-Poker-World-Hub`.
Any updates to Club Arena must STRICTLY flow through a merged PR on the `club-arena` repository, followed by a clean, automated build-and-sync process (Vercel/GitHub Actions). Do not attempt to bypass the pipeline by copying bundled files into World Hub manually.

## RULE 4 — WHEN A GUARD REFUSES YOU, READ IT.

**`--no-verify` is FORBIDDEN.** It disables protections and causes work to be lost. Read the error and fix the problem (e.g., failing tests, bad commit author).

## RULE 5 — NEVER EVER ASK A HUMAN TO DO A TASK.

**DO NOT EVER ASK THE USER TO MANUALLY DO A TASK.**
You have every single credential (CLI, backend, DB access, GitHub, Supabase) to do every single task yourself.

- If a database migration needs to be run, YOU run it via `psql` or `supabase` CLI.
- If the database is timing out, YOU set a background cron/schedule to keep retrying until it works. Do not abandon the task and do not ask the user to "paste this in the Supabase SQL editor".
- If a server needs to be restarted, YOU restart it.
- If a PR needs to be merged, YOU merge it or wait for autopilot.
  Never tell Dan to run a command, pull a branch, start a server, open a PR, merge anything, or run a SQL query. If a step needs doing, DO IT YOURSELF.

## RULE 6 — REPORT ONLY WHAT YOU VERIFIED.

No claim without a command behind it. "Tests pass" means you ran them and can
paste the count. "It is deployed" means you checked what production serves.

## APPENDIX A — CI PIPELINE & REVERT GUARDS

Required (a PR cannot merge until these are green):

- **TypeScript Check**
- **Client Unit Tests (vitest)**
- **Server Engine (typecheck + tests)**
- **Production Build** — vite build + bundle budget. Deterministic.
- **CSS Beat E2E (multi-table + animations)** — Playwright against this commit's own build.

A green tick answers "did it merge". It does not answer "did it reach production". `.github/workflows/publish-watchdog.yml` asks production directly — it compares `build-info.json` against `main` after every publish attempt.

## APPENDIX B — A RESET CAN NO LONGER DESTROY A COMMIT OR AN EDIT

`.husky/reference-transaction` fires before any ref update lands and refuses one that would orphan local commits — and it writes them to `refs/wip/orphan-guard/<stamp>` first. `scripts/agent-trees-snapshot.sh` does the same for uncommitted edits every ten minutes.
If you deliberately need to move a ref backwards, say so: `AGENT_REF_GUARD_OK=1`.
