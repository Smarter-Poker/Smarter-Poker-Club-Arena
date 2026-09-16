<!-- BEGIN CURRENT OWNER CATEGORY GUIDE 2026-09-16 -->
# Current owner instructions — all agent vendors

At task start or resume, and before claiming readiness, read the latest
[/Users/smarter.poker/Documents/AGENTS.md](/Users/smarter.poker/Documents/AGENTS.md)
and
[/Users/smarter.poker/Documents/PIPELINE-PRE-SUBMISSION.md](/Users/smarter.poker/Documents/PIPELINE-PRE-SUBMISSION.md)
before the older repository instructions below. This applies to Codex, Claude,
Gemini, Antigravity and their delegated agents in every checkout or alias.
The current owner policy takes precedence where older instructions conflict.

Use only the guide's relevant change-category profile and existing verification
path; do not rerun the whole historical blocker list. Preserve required checks
and distinguish source review, tests, merge, publication and actual live proof.
Before claiming ready after a new failure, retain its exact source/run evidence,
repair its cause with the relevant regression, and update its existing shared
row (add one only for a new cause). Coordinate with the shared guide's current
writer; do not copy its registry into this repository or treat an unrun check
as passed. Use its small readiness template in the existing PR or handoff.
Use [AGENTS-PUSH-GUIDE.md](./AGENTS-PUSH-GUIDE.md) for the current host-authenticated
push, PR, protected auto-merge and publication route. Producers can use the
existing queue-pr helper themselves; no project `.env` token is required.
This supersedes older instructions claiming that only another agent can merge
or that disabled workflows will automatically process a branch.

<!-- END CURRENT OWNER CATEGORY GUIDE 2026-09-16 -->

# Club Arena -- Agent Instructions

## ↗ RESUMING THE ENGINE-RESTART PROGRAMME? READ `docs/HANDOFF_CURRENT_STATE.md`

If you are picking up the hourly `:55` maintenance break / platform freeze /
engine restart work, the current state, every measured baseline, the open
defects and the exact next actions are in
[`docs/HANDOFF_CURRENT_STATE.md`](./docs/HANDOFF_CURRENT_STATE.md) - a 9-phase
programme; phases 1-3 built (phase 1 merged + live, phases 2+3 in PR #2715),
next is phase 4 (thaw installments). The plan is
[`docs/ENGINE-RESTART-PROGRAMME.md`](./docs/ENGINE-RESTART-PROGRAMME.md).

Read it before touching `server/src/maintenance/**`,
`server/src/engine/ServerTableEngineBase.ts`,
`.github/workflows/auto-deploy-hetzner.yml` or
`.github/scripts/audit-engine-provenance.sh`. It records three separate guards that
read as armed while being unreachable, and one trap where a metric reaching
zero means the opposite of success.

---

## ↗ RESUMING THE CLUB OPERATIONS UPGRADE? READ `docs/HANDOFF-2026-09-03-club-operations-upgrade.md`

A DIFFERENT programme from the one above, and a different handoff file. If you
are picking up Dan's 8-phase upgrade of the club operator workspace
(`/hub/club-arena/clubs/:club/operations` and its 26 sub pages), the current
state, every live measurement, the defect register and the exact next actions
are in
[`docs/HANDOFF-2026-09-03-club-operations-upgrade.md`](./docs/HANDOFF-2026-09-03-club-operations-upgrade.md).
Phases 1-3 of 8 are merged (squash `c22a3bb00`) and live; phase 4 is the club
dashboard, and it starts on a fresh branch off `main`. The plan is
[`docs/club-operations/OPERATIONS-UPGRADE-PLAN.md`](./docs/club-operations/OPERATIONS-UPGRADE-PLAN.md).

## ↗ REDESIGNING A PAGE, POPUP, CARD OR BUTTON? READ `.claude/skills/club-arena-console/SKILL.md`

Every visual surface in Club Arena is rebuilt on Dan's approved master art -
you do not style it, you print live text into zones measured on a render he
signed off. The standard is **#ClubArenaConsole**, and it lives in the repo so
every agent, on every account and in every tool, works from the same one:

[`.claude/skills/club-arena-console/SKILL.md`](./.claude/skills/club-arena-console/SKILL.md)

It carries Dan's rulings verbatim, the console kit and its zone constants, the
art-surgery techniques for deriving new art from a master, the headless render
harness that produces the before/after he reviews, twelve traps that have each
cost hours, and the definition of done. Read it in full before touching a
surface, and pass it to any subagent you spawn. If you find yourself writing
`border-radius` or a gradient to make something look like a control, you have
already gone wrong: the control is painted in the art.

---

## ↗ START HERE: `AGENT-PLAYBOOK.md`

**Before this file, before anything: read [`AGENT-PLAYBOOK.md`](./AGENT-PLAYBOOK.md).**

It is byte-identical in all seven repos and it answers, in one page, how to ship
without losing work: claim your own worktree, commit, push, open a pull request,
stop. It also lists every guard that is protecting you, what each one is telling
you when it speaks, and **where every credential lives** (never the value — the
place). `.github/scripts/estate-integrity.sh` checks hourly that all seven
copies still agree.

If you are lost, cannot find a credential, or something is red and you do not
know why, that file is the answer. This one is the Club Arena detail underneath
it.

---

ALL agents (Claude, AntiGravity, Cowork, any AI) MUST read this file at session start.
This is the single source of truth for **this repo**. Updated 2026-04-28.

**↗ READ FIRST:** `.agent/architecture/CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md`
That document is the canonical "where does my fix go?" decision tree, the
duplicate-table reconciliation, and the four-tier topology lock. Every agent
must read it before pushing any code. If the architecture doc contradicts
this CLAUDE.md, the architecture doc wins (it's newer + repo-canonical).

**Platform-level plan** (CA + Supabase + Hetzner + WH integration):
`~/Documents/Smarter-Poker-World-Hub/CLUB-ARENA-OFFICIAL-UPGRADE-INTEGRATION.md`

That document supersedes the old `POKERBROS_UPGRADE_PLAN.md`, `PHASE_3/4_*_PLAN.md`,
`MASTER_BLUEPRINT.md`, and every `ANTIGRAVITY-HANDOFF-*.md` (now in
`docs/_archive/handoffs/`). If any of those conflict with the platform plan, the
platform plan wins.

---

## 1. DEPLOYMENT PIPELINE

Club Arena is a Vite + React SPA published to its own Hetzner static origin.
The World Hub serves `/hub/club-arena/*` through a rewrite to that origin;
Club Arena releases do not deploy through the World Hub repo. See section 1.1.

### 1.1 How your work reaches production (rewritten 2026-09-03 - the World Hub is no longer in the path)

There is exactly one route from a commit to a player, and every mutation step
is owned by Club Arena automation. A branch push starts that route; only
exact-SHA production proof completes it.

1. **Work on a branch in your own worktree.** Any name is fine - `fix/<slug>`
   is the convention. Never commit on `main`; it is a protected mirror.
2. **Push the branch** over SSH (`git push origin HEAD:refs/heads/<branch>`),
   then follow its checks, merge, and owning Club Arena release workflows to a
   terminal result. Fix red checks forward; do not report a branch push as a
   release.
3. `agent-branch-proposal.yml` records the branch push without credentials;
   trusted default-branch `agent-open-pr.yml` consumes that completed signal
   and opens the pull request for any eligible branch name.
4. `agent-autopilot.yml` enables squash auto-merge. The required checks run on
   on their declared isolated runners, and GitHub merges when they are green.
   Privileged PR/release control never reuses a runner that executed branch
   code. Red checks never merge (5.8).
5. **`publish-club-arena.yml` publishes - to Club Arena's own origin.** On
   merge it builds the bundle, runs the four-way sharded test gate, and
   rsyncs `dist/` to the static origin (Caddy on `estate-ci-1`,
   `ca-static.smarter.poker`) as `/srv/club-arena/releases/<ca_sha>/`, then
   swaps the `current` symlink atomically. The World Hub carries ONE rewrite,
   `/hub/club-arena/*` -> that origin, so the player is still on
   `smarter.poker` and the shared session (`smarter-poker-auth`) still works.
   The rsync and the symlink swap take seconds. The PUBLISH does not:
   measured 2026-09-08, merge to bundle-stamped was 3m54s, and the whole
   pipeline is a four-job DAG with a full `npm run build` in the middle. The
   old wording said "a publish takes seconds" and it is the first number an
   agent reads here, so it was routinely mistaken for the end-to-end figure -
   see `.agent/audits/2026-09-08-publish-pipeline-improvements.md` for the
   stage-by-stage breakdown. Nothing is committed to the World Hub repo any
   more, and Vercel does not rebuild the World Hub for a Club Arena merge.
   Rollback is re-pointing the symlink; ten releases are kept.
6. **Verify** by reading, never by assuming: both
   `https://ca-static.smarter.poker/build-info.json` and
   `https://smarter.poker/hub/club-arena/build-info.json` must report a
   `ca_sha` equal to the squash commit on `main`. For `server/` changes,
   the sealed `auto-deploy-hetzner.yml` run must complete and cache-busted
   engine health must report that same SHA. Nothing else counts as deployed.

**Why it used to go through the World Hub, and why it stopped (2026-09-03).**
`smarter.poker/hub/club-arena` is a path on the World Hub's Vercel deployment,
and until today the only way a file got there was to commit it into that
repo's `public/` tree: every Club Arena merge produced a
`chore(club-arena): sync build` commit in the World Hub and a 4-5 minute
rebuild of the entire World Hub, twenty times a day. The origin removes both.
The browser never sees the origin's hostname - Vercel proxies the rewrite -
so section 7's "everything from smarter.poker" still holds for the player;
what changed is where Vercel fetches the bytes from.

**The origin keeps old assets.** A player whose tab still holds the previous
`index.html` asks for the previous hashed chunks mid-hand. `/assets/*` and
`/fonts/*` are served from an APPEND-ONLY pool: the publisher never `--delete`s
or overwrites a runtime URL. Do not "clean up" the pool by removing what is not
in the current bundle - that is the 404 the old sync's retention logic existed
to prevent.

**A failed publish has one repair path.** `production-integrity-audit.yml`
compares production to `main` and reports drift, but it is deliberately
read-only: it cannot retry, dispatch, open a pull request, toggle a workflow,
or publish. Inspect the failed owning workflow, fix the root cause, and send
`publish-club-arena` with the exact full current-main SHA through reviewed
default-branch authority. No timer, watcher, World Hub job, or workstation
script is a release fallback.

**There is no second publisher.** `tests/no-commit-left-behind.law.test.ts`
counts publishers and requires exactly one. Club Arena's own `vercel.json`
still has `deploymentEnabled: false`; the bundle is served through the World
Hub's rewrite, never from a Vercel project of its own.

**Local preview:**

```bash
cd ~/Documents/club-arena && npm run dev
```

The Vite dev server is the local preview. `sync-club-arena.sh` in the World
Hub repo (which copied a build into `public/hub/club-arena/` for a local
Next.js preview) is retired with the sync; the World Hub's dev server proxies
the rewrite to the live origin instead.

### 1.1.6 HOW THE BUILD IS PUT TOGETHER (added 2026-09-04 - read before you touch a build step)

Push to live was ~10.1 minutes. It is not any more, and the way it got faster
constrains what you may do to these files. Three facts that are easy to undo
by accident:

1. **`npm run build` is `tsc -b && npm run build:ci`.** ONE definition, so the
   two cannot drift. `ci.yml`'s two build jobs run `build:ci`;
   `publish-club-arena.yml` runs the full `npm run build`. THE ASYMMETRY IS
   DELIBERATE and either half alone is a bug: the tree that reaches players is
   typechecked on the commit that ships it, and the throwaway pull-request
   builds are not, because the required `TypeScript Check` job has already
   checked that same tree, ungated, on every pull request. `tsc -b` emits
   nothing here (all three tsconfigs are `noEmit`, none is `composite`, no dts
   or checker plugin) - if you add `composite`, `references` or a dts plugin,
   `tsc -b` starts emitting and `build:ci` silently stops producing the same
   bundle. `tests/the-build-typechecks-where-it-ships.law.test.ts` fails first.

2. **`sharp` is a declared devDependency.** It used to be deliberately absent
   and installed over the network into `os.tmpdir()` mid-build - 97s cold, 77s
   warm, three times per merge. Do not remove it, and do not remove the
   temp-prefix fallback in `scripts/lib/sharp-loader.mjs` either: that is the
   no-regression net. The lockfile must keep the `@img/sharp-linux-x64` and
   `@img/sharp-libvips-linux-x64` entries or `npm ci` on a runner installs
   sharp with no binary and the fallback quietly resumes paying the 97s.

3. **`scripts/optimize-dist-media.mjs` is parallel and content-addressed.**
   Results are cached by the sha256 of the INPUT bytes plus the rule, the
   extension, `ENCODER_SETTINGS_VERSION` and sharp's version. **If you change
   the png/webp/jpeg encoder options, bump `ENCODER_SETTINGS_VERSION` in the
   same edit** - it is the only thing between an encoder change and a cache
   that keeps serving the previous encoder's bytes. The script also recognises
   its own output, so a second pass re-encodes nothing; before 2026-09-04 a
   second pass re-encoded 90 files and lost quality every time.

**Source maps go to Sentry and never to players.** `SENTRY_AUTH_TOKEN` belongs
to `publish-club-arena.yml` and nowhere else. It used to sit in `ci.yml`, so
the plugin uploaded maps for the pull-request bundle that gets thrown away,
uploaded none for the bundle that ships, and - because
`filesToDeleteAfterUpload` only runs on a successful upload - shipped 267 `.map`
files (27MB) to players on every deploy. The publisher now strips them
unconditionally and refuses to publish a survivor.

Full reasoning and every measurement:
`docs/changelog/2026-09-04-push-to-live-under-six-minutes.md`.

### 1.1.7 THE RUNNERS (rescaled 2026-09-04; World Hub given twelve more the same day)

| Box              | Type  | Cores | Runners | Serves                          |
| ---------------- | ----- | ----- | ------- | ------------------------------- |
| `estate-ci-eu-1` | cpx62 | 16    | 18      | Club Arena (12) + World Hub (6) |
| `estate-ci-eu-2` | cpx62 | 16    | 12      | Club Arena (6) + World Hub (6)  |
| `estate-ci-eu-3` | cpx62 | 16    | 18      | Club Arena (12) + World Hub (6) |
| `estate-ci-1`    | cpx31 | 4     | 3       | Club Arena                      |

52 cores; 33 Club Arena runners, 18 World Hub runners. The World Hub had six,
all on eu-2, all busy, while eu-1 and eu-3 sat at load 1 with twelve idle Club
Arena runners each - measured 2026-09-04, when every World Hub job waited 8-14
minutes for a runner. The twelve extra (`estate-wh-eu1-*`, `estate-wh-eu3-*`,
registered with `scripts/ci/setup-selfhosted-runner.sh`) took that queue to a
0.6-minute maximum the same hour. The three EU boxes were 8-core (cpx42) until
2026-09-04; loads of 40.9 were the reason. `cx53` and `cax41` are NOT orderable
on this account - both were tried and refused.

**A NUMBER TUNED TO HARDWARE AND WRITTEN DOWN AS A CONSTANT OUTLIVES THE
HARDWARE.** The old 8-core concurrency caps became the bottleneck the hour the
boxes became 16-core. Derive from the box (`os.cpus().length`,
`nproc`), never from a literal.

**Counting busy runners: `pgrep -f 'Runner.Worker'` matches your own ssh
command** and makes every box look permanently busy. Use
`ps -eo comm | grep -c '^Runner.Worker$'`. The GitHub API's `busy` flag is not
reliable either; inspect processes.

### 1.1.5 SERVER-SIDE PROTECTION (APPLIED - this section is history)

`.husky/pre-push` is a seatbelt on an unlocked door: `--no-verify` skips it and
a push made through the GitHub API never runs it. The lock is a ruleset, which
GitHub enforces for every client. Private repos need GitHub Pro for that.

`scripts/ci/apply-main-ruleset.mjs` applies it in one command the moment Pro is
on, in two stages:

    GH_TOKEN=<fresh GitHub App token> node scripts/ci/apply-main-ruleset.mjs --stage=1
    GH_TOKEN=<fresh GitHub App token> node scripts/ci/apply-main-ruleset.mjs --stage=2

Stage 1 changes nothing about how you work and would have prevented the
2026-08-21 rewind that dropped four commits already serving in production.
Stage 2 is the one that makes a red test impossible to land - and it ends
direct pushes to main, so read section 1.3 again after it is applied. The two
required checks listed in section 1.2.5 already exist in CI and run on pull
requests. The ruleset script installs the complete list; a partial subset is
not an acceptable release gate.

The token also needs `Administration: Read and write`; one that can push code
cannot change protection rules. The script says which of the two is missing.

### 1.2 World Hub Boundary (Not A Club Arena Publisher)

- World Hub carries the public rewrite and its separately owned operations API.
- Club Arena frontend and engine releases never invoke a World Hub or Vercel
  deployment, token, hook, or project.

### 1.2.5 HOW A PUSH LANDS NOW (changed 2026-08-21)

**READ 1.1 FIRST - IT IS THE ROUTE, AND THIS SECTION IS THE SCRIPT'S HISTORY.**
Clarified 2026-09-06, because the two read as competing instructions and an
agent has to pick one:

- **1.1 step 2 is what you do**: work on a branch in your own worktree and
  `git push origin HEAD:refs/heads/<branch>`. `agent-open-pr.yml` opens the
  pull request and autopilot merges it after required checks. The release is
  complete only after the owning Hetzner workflow and exact live SHA are
  verified.
- **This section is about landing on `main` directly**, which the ruleset no
  longer permits from any client.

The former shared-clone `git-safe-push.sh` / `pr-push.mjs` path is not a
release authority and must not be used to bypass isolated-worktree rules,
normal hooks, or branch protection. No deployment credential should be read
from a World Hub file or embedded in a Git remote.

VERIFIED AGAINST THE LIVE API 2026-08-28, because two other places in this repo
say the opposite and they are the stale ones. Ruleset `main protection`
(id 21163380) on `refs/heads/main` is `enforcement: active`, with
`bypass_actors: []` - nobody, including a repo admin, merges around it. Its
rules are `deletion`, `non_fast_forward`, `pull_request` (squash only, 0
approvals) and `required_status_checks`:

    TypeScript Check
    Client Unit Tests (vitest)
    Server Engine (typecheck + tests)
    Production Build
    CSS Beat E2E (multi-table + animations)
    Silent Revert Guard

So: a direct push to main is refused, a red check cannot be merged, and
`ci.yml`'s `if: github.event_name == 'pull_request'` gating is SAFE precisely
because the ruleset makes the pull-request path the only path.

Two documents used to disagree with the API; both were corrected on
2026-08-28 / 2026-09-03 and now say the same thing this section says:

- Section 1.1.5 is titled "APPLIED - this section is history". It is active.
- `.husky/pre-push` check 0 was corrected 2026-08-28 and its check 5 comment on
  2026-09-03; neither claims any more that "nothing enforces it server-side".
  If you find text anywhere in this repo saying the ruleset is not enforced,
  that text is the stale one - the API is the authority.

THE SKIPPED-CHECK GAP: CLOSED, and this paragraph is the correction (verified
against ci.yml and the live API 2026-08-31). `ci.yml` gates `unit`, `server`
and `build` behind the `changes` job, and A RULESET COUNTS A SKIPPED REQUIRED
CHECK AS SATISFIED - so the shape of the danger is real and worth knowing. But
all three jobs now carry

    always() && github.event_name == 'pull_request' &&
    (needs.changes.result != 'success' || ...)

so an undetermined diff RUNS them rather than skipping them, and `changes`
itself fails open: three retries, then "run everything" if the file list is
still unavailable, and any change to package.json / vite / vitest / tsconfig /
.npmrc / .nvmrc / ci.yml is treated as touching everything. `typecheck` and
`stub_gate` are ungated entirely.

This text used to say the gap was live. It was describing the 2026-08-23
incident, which the `always()` guards above were added to fix - the words
outlived the bug and told every agent since that CI could not be trusted. The
remaining skips are the correct kind: `changes` succeeded and said, truthfully,
that server/\*\* was not touched.

One latent hole in that machinery WAS still open and is now closed too: the
changed-file call asked for `per_page=300`, and the GitHub API caps per_page at
100 silently, so a pull request over 100 files would have been classified on a
truncated list. It uses `--paginate` now. No pull request here has exceeded 19
files, so nothing was ever misclassified in practice.

WHY, because the old path caused three separate incidents in one day:

- it pushed with `--force-with-lease` on every failure path, which REWOUND
  main and dropped four commits already built, synced and serving in
  production;
- it pushed with `--no-verify`, so the pre-push hook - nine house rules, and
  since #149 the test suite - never ran from the one command every agent is
  told to use, and red tests reached main four times;
- it rebased main automatically on conflict, which section 12 forbids.

A pull request cannot do any of those. The branch push still runs the hook, so
a failing test stops you at your own machine rather than stopping everyone.

If it refuses to land, nothing was force-pushed and nothing was lost. Read the
output: a hook failure is yours to fix and a `dirty` state means a real
conflict with main. Merge current `origin/main` into the feature branch,
resolve it there, rerun the gates, and push the branch again.

### 1.3 Never Do

- Never run `vercel deploy` or `vercel --prod` in the Club Arena directory
- Never push to or test on `club-arena.vercel.app`
- Never call any deploy hook URL
- Never add iframe code (`window.parent`, `postMessage`, `ClubArenaEmbed`).
  **The one sanctioned iframe is `src/components/table/HubFrame.tsx`** (Dan's
  ruling 2026-09-04): a same-origin frame that shows a World Hub page
  (Social, Media, Trivia, Training, the Hub itself) INSIDE a "+" tab, so the
  tab strip and every running table stay mounted - "it's basically opening
  up a new browser tab internally, it shouldn't be limited to just poker".
  It uses no postMessage and no `window.parent` (same origin lets it read the
  frame's location and listen on its document directly), it is the only
  `<iframe>` element in `src/`, and `tests/hub-tab-is-a-browser-tab.law.test.ts`
  keeps it that wide. Never embed Club Arena inside anything, never bridge with
  postMessage, and never add a second frame: the rule is unchanged except for
  that one file. `docs/changelog/2026-09-04-the-plus-tab-is-a-browser-tab.md`.
- Never add `VITE_` prefixed secret keys (use server-side API routes)
- Never re-create `public/hub/club-arena/` in the World Hub. It was DELETED on
  2026-09-02 when Club Arena moved to its own origin, and Next.js serves
  `public/` BEFORE the rewrite, so a file there silently shadows the live
  bundle. `tests/club-arena-is-a-rewrite.test.mjs` in the World Hub fails CI if
  it comes back.

### 1.4 Claiming Success

You may only say a change is deployed after the required checks and merge are
green, the owning Club Arena Hetzner workflow is terminal-success, and the
exact merged SHA is independently visible on the corresponding live endpoint.
Never say "should be live in a few minutes" or "deploy triggered."

---

## 2. INFRASTRUCTURE

| Service   | Purpose                                     | Location / authority                                                        |
| --------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| Hetzner   | Club Arena frontend origin and poker engine | Club Arena workflows `publish-club-arena.yml` and `auto-deploy-hetzner.yml` |
| World Hub | Public rewrite and separate operations API  | World Hub's own gated release; never a Club Arena publisher                 |
| Supabase  | Database + Auth + Realtime                  | Club Arena's configured Supabase project                                    |

### Hetzner VPS (Poker Engine Server)

- Runs server-authoritative game engine: `server/src/index.ts`
- ALL game logic lives here: HandController, ServerTableEngine, all engines
- HTTP endpoints: POST /action, POST /timebank, GET /actions, GET /health
- Uses `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS)
- Sentry: its OWN project `club-arena-engine` (since 2026-09-04) and an
  SDK-side event budget (`server/src/services/sentryEventBudget.ts`, 10/min per
  fingerprint, 60/min overall, dropped counts summarised every 10 min). An
  engine loop burned the whole org quota in August and blinded every other
  app for three weeks. Never point `SENTRY_DSN` back at the hub project, never
  remove the budget from `beforeSend`, and do not raise its limits to make a
  loop visible: the summary event already names it.
  `docs/changelog/2026-09-04-engine-sentry-budget.md`.
- The engine is ONE core and horse Monte Carlo was 90% of it (profiled
  2026-09-04). `server/src/engine/EquityLoadGovernor.ts` scales the sample
  when the event loop saturates; `/health.equityGovernor.scale < 1` means the
  core is hot. If a timer, refresh or sweep "times out" while Postgres is
  fast, look at the loop first. `docs/changelog/2026-09-04-equity-load-governor.md`.

### Supabase

- PostgreSQL: tables, table_seats, table_hole_cards, hand_history
- Auth: JWT-based, shared with smarter.poker frontend
- Realtime: WebSocket broadcasts to connected clients
- RLS: Protects hole cards (users can only read own cards)
- Schema changes MUST be SQL migration files in `supabase/migrations/`
- **You do not choose the version. Ask for one:**
  `bash scripts/reserve-migration-version.sh <lower_snake_case_slug>` prints the
  path and creates the file. It checks this tree, `origin/main`, and every
  sibling worktree on this machine, which is the one that matters - a migration
  in another agent's tree is not on origin yet, so nothing you fetch can show it
  to you. A hand-typed timestamp collided twice in one day on 2026-09-04, and
  `20260831235992` and `20260831b` on main are what earlier agents reached for
  when the obvious name was already taken.

### Production DDL policy (added 2026-08-31 after the PGRST002 503 outage — BINDING)

Every DDL statement (CREATE/ALTER of tables, views, functions, types, triggers,
COMMENT) fires Supabase's `pgrst_ddl_watch` event trigger, which makes PostgREST
reload its entire schema cache. On this database (~970 relations, ~2,700
functions) one reload takes **~28 seconds**. On 2026-08-31 the `authenticator`
role's default 8s statement_timeout killed that reload query every time, and the
resulting PGRST002 retry loop 503'd up to 28% of live traffic (seating and
dealing included). Fixed by the `fix_pgrst002_schema_cache_timeout` migration:
`authenticator` statement_timeout is now 5min (service_role pinned to its
previous effective 8s). Do not revert either setting in any "hardening" pass.

Rules for every agent working this project:

1. Wrap ALL DDL for one change in a SINGLE transaction (one migration = one
   BEGIN/COMMIT). Postgres coalesces the reload NOTIFYs inside one transaction;
   ten separate statements outside a transaction = up to ten 28-second reloads.
2. Do not apply migrations in a retry loop. If a migration fails, read the
   error; re-running the whole batch every minute multiplies reloads.
3. No DDL probes against production (CREATE TEMP TABLE is fine — pg_temp is
   filtered — but CREATE/DROP INDEX cycles, scratch tables, or CREATE OR
   REPLACE FUNCTION as a "test" are not).
4. Batch related migrations. During US daytime peak, prefer one consolidated
   apply over many small ones.
5. GRANT/REVOKE do NOT trigger reloads (not in pgrst_ddl_watch's list) — runtime
   grant churn is a non-issue for this outage class.
6. Client resilience for the residual window lives in
   `src/lib/pgrstRetryFetch.ts` (web) and the `global.fetch` wrapper in
   `server/src/services/supabase/client.ts` (engine): both retry only
   pre-execution 503s (PGRST001/002/003). Do not remove them, and do not
   "extend" them to retry other 5xx — replaying an executed write is a
   money-integrity hazard.
7. **A PROBE NEVER CARRIES DDL, AND A CURSOR TABLE NEVER CARRIES A FOREIGN
   KEY TO A HOT TABLE (2026-09-08, after a 4-minute production outage).** An
   agent probed a migration by running it inside a transaction - `CREATE
TABLE ... REFERENCES public.tournaments(id)` followed by ~10 s of function
   work - then the client hung. Adding a foreign key takes SHARE ROW EXCLUSIVE
   on the referenced table for the rest of the transaction, so every writer to
   `tournaments` (the engine, the per-minute reconcile crons) queued behind it,
   and Postgres was hard-killed at 22:53:36 UTC and came back at 22:57:05 with
   "not properly shut down; automatic recovery". Rule 3 already said no DDL
   probes; this is what it costs. So: probe a function by timing its QUERY, or
   build its fixture in `pg_temp`; apply DDL in its own short transaction with
   `lock_timeout` set, detached from any tool that can time out and kill the
   client; and a scan/cache/cursor table that references a hot relation gets
   NO foreign key - an orphan row in a scan log is harmless, a lock on
   `tournaments` is not.
   `docs/changelog/2026-09-08-deep-sweep-two-and-the-probe-that-took-the-database-down.md`.
8. **THE DATABASE REFUSES MIGRATIONS INSIDE THE HOURLY BREAK WINDOW
   (2026-09-10).** The window is minute-of-hour :50-:03 UTC. A migration at
   23:52:36 UTC on 2026-09-09 landed on the :53 announcement and cancelled
   the 00:00 break (section 13). Event triggers `ca_break_window_refuses_ddl`
   and `ca_break_window_refuses_drops` now abort any non-temporary DDL from a
   session that logs in as `postgres` or a member of it (the management API
   and MCP, psql, the pooler, the CLI, the dashboard) while
   `fn_ca_break_window_refuses_migrations(now())` says so. The whole
   transaction rolls back, so nothing reloads and no history row is written.
   pg_cron, Supabase's own roles, PostgREST and temporary objects are never
   refused. If you are refused, check `date -u` and apply it ONCE after :03,
   never in a retry loop (rule 2). An emergency fix that cannot wait puts
   `SET LOCAL ca.break_window_migration_override = '<why this cannot wait>';`
   right after its `BEGIN;` - a reason, not a switch, honoured for that one
   transaction and recorded in `public.ca_break_window_migration_overrides`.
   Never disable the triggers to get a migration in, and never move the
   window without moving `tests/the-break-clocks-agree.law.test.ts` in the
   same commit. A trigger on `supabase_migrations.schema_migrations` looks
   like the obvious place and is wrong here: a migration with its own
   BEGIN/COMMIT has already committed when the management API writes its
   history row (measured by xmin). The Supabase MCP's `list_migrations` is
   refused inside the window too, and should be avoided outside it: before
   `list_migrations` and `apply_migration` it runs five no-op `ALTER TABLE
supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS`, and each
   call reloads PostgREST (~140 a day measured). To see what is applied, run
   `SELECT version, name FROM supabase_migrations.schema_migrations` through
   `execute_sql` - it reads the same history with no DDL.
   `docs/changelog/2026-09-10-the-database-refuses-migrations-inside-the-break-window.md`.

---

## 3. ACTIVE MIGRATION

There is a server-authoritative migration in progress. Before ANY code work, read:

1. `MIGRATION-LAW.md` -- 11 laws governing all migration work
2. `MASTER-MIGRATION-DOCUMENT.md` -- Section 8 for current phase order
3. `MIGRATION-CHANGELOG.md` -- What's done, where to resume

Phase order (sacred):

```
STEP 1: RIP OUT client-side engine code
STEP 2: VERIFY CLEAN (grep confirms zero local authoritative state)
STEP 3: FIX SERVER BLOCKERS (card security, auto-fold, timer)
STEP 4: PORT CORE (PreciseActionTimer, ServerActionValidator, StateVerifier)
STEP 5: PORT SUPPORTING (TimeBankEngine, DisconnectEngine, PreActionEngine)
STEP 6: PORT ADVANCED (Straddle, RIT, Insurance, MixedGame, Rakeback)
STEP 7: TOURNAMENT & EXTRAS (ChipRace, TableBalancer, OFC, Telemetry)
STEP 8: TABLE SETTINGS & THEME CUSTOMIZATION (Bible V8 Chapter 11)
```

You CANNOT skip ahead. Every change: READ -> DOCUMENT -> CHANGE -> VERIFY -> LOG.

---

## 4. FIX-FIRST PROCEDURE

When auditing or reviewing code:

1. FIND an issue
2. FIX IT FULLY -- write the actual code, not just a note
3. MOVE ON to the next item
4. REPEAT until all items in the current phase are done

Do NOT audit 10 items and then ask "what should I fix?" -- fix them as you go.

---

## 4.5 NEVER HAND-PICK A MIGRATION VERSION (2026-09-04, BINDING)

**Always run:**

```bash
node scripts/new-migration.mjs "what it does"
```

Never type a `20260904...` version yourself, and never copy one from another
file and edit the digits.

### Why, measured

Over 24 hours this was the single biggest source of red CI in the repo:
**21 of ~62 real check failures** were one collision - 15 in `TypeScript Check`
(`Supabase Invariants - New Migration`) and 6 in `Client Unit Tests`
(`migrationVersionUniqueness`).

Agents pick the 14-digit version by hand, reach for a round number, and two of
them land on the same one. **Neither branch is wrong on its own** - each holds
one file, so both go green. The collision appears the moment the second branch
takes `main`, and then CI fails for work that was correct when it was written.
That is what "CI keeps failing for no reason" has been.

### It is not only a red build

Supabase keys `schema_migrations` on the version. Of two files sharing one,
**the second is SILENTLY NEVER APPLIED**. A migration that never ran is worse
than a failing test, because nothing tells you.

### What the script does that a timestamp cannot

It asks what is already taken - this tree, `origin/main`, **and every remote
branch** - and steps forward a second at a time until it finds a free version.
Checking the branches is the whole point: the version you collide with usually
lives on work nobody has merged yet, which no clock can see.

It writes the file from the correct skeleton too, including the single-
transaction requirement from the production DDL policy in section 2.

---

## 5. CODE SAFETY RULES

1. Use `.maybeSingle()` never `.single()` for Supabase queries
2. Always handle null/undefined gracefully in display components
3. No emoji in source files (breaks SWC compiler)
4. VIP levels must be validated before rendering badges
5. Format numbers with `.toLocaleString()`, never `.padStart()`
6. TypeScript: run `npx tsc --noEmit` before committing. Fix ALL errors first.
7. POPUPS (Dan 2026-08-20, binding): every popup/toast message renders with
   the First Letter Of Every Word Capitalized, and em dashes are FORBIDDEN in
   popup text. Enforced centrally in `src/utils/popupStyle.ts` via the Toast
   provider — never bypass the Toast layer with a hand-rolled popup, and never
   "fix" a message by disabling the transform. Identical popups also dedupe:
   do not build retry loops that re-toast the same message.

---

8. NEVER PUSH A RED TEST (Dan 2026-08-21, binding). `npx vitest run tests/` in
   `publish-club-arena.yml` is what PUBLISHES the bundle. A failing test does
   not fail a report - it stops the Hetzner-origin publish for every agent and every
   deploy, until a human notices. On 2026-08-21 that happened four times in one
   day, and every one was a test pushed alongside the feature it was meant to
   guard:
   - a test importing a component that had been deleted the day before;
   - a test reading `src/services/soundService.ts` when the file is
     `SoundService.ts` (macOS resolved it, Linux CI did not);
   - a spec asserting the engine sends `card_indices`, committed with no
     implementation beside it - by a commit whose message was "unblock the
     deploy gate";
   - a test still asserting the rounding rule that the same commit's feature
     had just replaced.

   THE RULES:
   - `.husky/pre-push` now runs the tests covering what you touched, in about
     four seconds. Do not `--no-verify` past it.
   - WRITING THE SPEC FIRST IS ENCOURAGED. Committing it red is not. Mark it
     `it.skip()` / `describe.skip()` with a note saying what has to be built,
     and delete the `.skip` in the commit that implements it. A skipped spec
     documents the work; a red one holds the platform hostage.
   - If you deliberately replace behaviour a test pins, UPDATE THAT TEST IN THE
     SAME COMMIT. "Someone else will fix the test" means "nobody ships until
     they do."
   - If you find main already red, fixing it comes before your own work
     (section 4, fix-first). You cannot ship past it anyway.

## 6. FILE MAP

```
src/App.tsx              React Router (70+ routes)
src/pages/               Page components
src/components/          Shared components (club/, common/, vip/)
src/services/            API services (ClubService, TableService, TournamentService)
src/lib/supabase.ts      Supabase client
src/types/               TypeScript types
server/src/index.ts      Game engine server (Hetzner)
```

Production URL: `https://smarter.poker/hub/club-arena/`
Built files: published to `https://ca-static.smarter.poker` (`/srv/club-arena`
on the Hetzner origin: `releases/<ca_sha>/` + an atomically swapped `current`
symlink + an additive `pool/`). NOT the World Hub repo - that path is gone.
API routes: `Smarter-Poker-World-Hub/pages/api/club-arena/`

---

## 7. ARCHITECTURE

Club Arena is a Vite + React SPA inside the smarter.poker Next.js app:

- Production: `smarter.poker/hub/club-arena/*` is a World Hub REWRITE to `https://ca-static.smarter.poker` (Club Arena's own static origin, see 1.1). Nothing lives in the World Hub `public/` tree - that directory was deleted 2026-09-02 and must not come back.
- Build: Vite produces `dist/`, which `publish-club-arena.yml` rsyncs to the
  origin. The World Hub carries ONE rewrite, `/hub/club-arena/:path*` ->
  `https://ca-static.smarter.poker/:path*`, so the browser never sees the
  origin hostname and the shared `smarter-poker-auth` session is untouched.
- Routing: SPA fallback rewrites unmatched routes to `index.html`
- Auth: Same-origin Supabase session via `smarter-poker-auth` localStorage key

NO iframe. NO postMessage. NO proxy. Everything from smarter.poker. (The one
sanctioned iframe, `HubFrame`, frames smarter.poker's OWN World Hub pages
inside a "+" tab - same origin, no bridge; see 1.3.)

---

## 8. TECH STACK

Vite + React 19 + TypeScript, React Router v7, Supabase (PostgreSQL + Auth + Realtime),
CSS Modules + global CSS.

---

## 9. KNOWN BUG PATTERNS (fixed, don't reintroduce)

- Bad Beat Jackpot: Use `num.toLocaleString()`, NOT `padStart(9, '0')`
- VIP Badge: Validate level against valid list before rendering, return null for invalid
- Promotion types: Format raw DB enums (HIGH_HAND -> "High Hand") before display
- Negative VIP points: Guard against currentPoints >= nextTierPoints
- Bottom nav labels: Keep short ("Msgs" not "Messages") to prevent truncation

---

## 10. WORKING RULES (set by Dan, binding)

1. One step at a time. Finish and verify before the next.
2. Do it right, not fast. No band-aids.
3. However long it takes. Scope honestly.
4. Verify on real hardware. "It compiles" is not verification.
5. No emoji in code. Never call AI players "bots" (they are horses).
6. Mobile-first. 375px first, then scale up.
7. Never ask permission for obvious work. Just do it.
8. When corrected, change course immediately.
9. Write it down — in your OWN file: `docs/changelog/YYYY-MM-DD-<slug>.md`.
   Do NOT append to `MIGRATION-CHANGELOG.md`. It is frozen as history.
   Measured 2026-08-26: it was the single biggest source of merge conflict in
   this repo — 18 of 108 conflicting pull requests, ahead of both TablePage.tsx
   and ClubHomePage.tsx — because every agent was told to append to the same
   last line of the same 950KB file. Two files written independently cannot
   conflict. See `docs/changelog/README.md`.

---

---

## 10.5 HORSES ARE PLAYERS (Dan, 2026-08-27, BINDING — NO EXCEPTIONS)

**Dan, verbatim: "HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON ANYTHING! THEY
MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!"**

This is a HARD LAW. It outranks any optimisation, any convenience, and any
assumption you arrive with. If you are writing a filter, a report, a payout, a
rule, a limit, a stat, a sweep or a guard, and you find yourself typing
`is_horse` in order to leave horses OUT of something a human would get — stop.
You are writing a bug.

### The rule

A horse pays the same buy-in, out of the same club wallet, through the same
RPCs, and sits in the same seat as anybody else. Therefore a horse:

- **EARNS** everything a human earns from the same action — VIP points, agent
  and super-agent commissions, `player_stats`, rakeback basis, leaderboard
  position, achievements, anything downstream of play or of rake;
- **IS PAID** everything a human is paid — prizes, bounties, refunds,
  shortfall back-pay, jackpots. Never "skip the horses" on a repayment;
- **IS SUBJECT TO** every rule a human is subject to — nit/VPIP eviction,
  limits, guards, integrity checks;
- **COUNTS** everywhere a human counts — player counts, engine provisioning,
  table liveness, conservation and reconciliation totals;
- **IS NEVER** silently filtered out of a report, a total, or a ledger.

### What is still allowed

`is_horse` remains legitimate for exactly two things:

1. **Identification** — surfacing the flag as DATA (a badge, a column, a
   roster field), or the horse-specific plumbing that creates, seats, funds
   and steers the fleet (`fn_register_horse_for_tournament`,
   `fn_seed_horses_to_floor`, `autoRebuyHorse`, HorseLogic, and so on). Those
   spawn and drive horses; they do not deny horses anything.
2. **The horse's input device.** A horse has no browser, so the engine
   supplies what a browser would: HorseLogic chooses its actions,
   `scheduleHorseAction` submits them inside the SAME turn timer a human
   gets, a synthetic heartbeat keeps its seat alive, and `autoRebuyHorse`
   funds its rebuy. Those exist to make a horse EQUAL to a human, not to
   give it a different deal. They are the only legitimate horse branch.

**THERE IS NO "EQUAL OUTCOME BY A DIFFERENT MECHANISM" EXEMPTION.** I proposed
one on 2026-08-27 — arguing a horse did not need the five-second rebuy pause
because `autoRebuyHorse` got it back another way — and Dan rejected it
outright:

> "TABLES ARE DESIGNED TO BE USED BY EVERYONE, EVERY HORSE OR HUMAN PLAYER
> NEEDS TO BE TREATED 100% EXACTLY THE SAME ALL ACROSS THE BOARD IN EVERYTHING
> FOR THE CLUB ARENA. YES IT STILL NEEDS TO THE SAME 5 SECOND PAUSE TO REBUY.
> NOT EVERY HORSE ALWAYS REBUYS IN THE CASH GAMES, AND IF YOU DIDN'T GIVE THEM
> THE SAME EXACT FEATURES AND FUNCTIONALITY, PEOPLE WOULD NOTICE!"

**TIMING IS PART OF THE TREATMENT.** The tell is never one hand, it is the
RHYTHM: a table that stops for five seconds when one seat busts and rolls
straight on when another has just told every watching player which seats are
horses. And the pause is not ceremonial for a horse either — the stop-loss
(two rebuys) and an empty club treasury both mean it genuinely may not come
back, so the window it gets to decide has to be the same window.

The test is therefore **"is it identical"**, not "is it equivalent". Same
features, same functionality, same pauses, same timers, same rules.

Anything where horses would be reported as opt-in (a `p_include_horses`
parameter) MUST default to **true**.

### Why this rule exists

On 2026-08-27 I wrote `AND NOT COALESCE(p.is_horse, false)` into
`fn_settle_tournament_rake` on my own assumption that horses are "house
players" who should not earn. Nobody asked for it. Every tournament on this
platform is horse-heavy, so the effect was that tournament rake attribution
earned **nothing for anyone** — 39 settled events, zero VIP points, zero agent
commissions — and I then reported that zero as "correct behaviour". It was my
invention presented as a design decision, which is worse than a plain bug.

Fixed and backfilled in `20260827_horses_are_players_law.sql`, along with two
others found in the same sweep: horses were exempt from nit eviction, and a
lone horse was denied a dealing engine that a lone human would have received.

### Dan's rulings on the two collisions with physical constraints

Both were put to Dan on 2026-08-27 with the costs stated. His answers are
BINDING and are recorded here so nobody re-opens them as a "bug":

**1. Hand-history retention: STAYS AT 7 DAYS.** Horse-only hands are pruned
after `hand_history_retention_policy.horse_retention_days`; hands a human was
dealt into are kept forever. Equalising would cost ~0.5 GB/day (~15 GB/month)
on a table already at 3.6 GB — 221k hands/day, 99.95% of them horse-only. Dan
chose to leave it at 7. **This is the one sanctioned asymmetry in the entire
law, it is a STORAGE decision rather than a player-treatment one, and it is
Dan's to change — it is a config row, not code. Do not "fix" it.**

**2. The deploy drain gate: PROTECT THE HAND, NOT THE PLAYER.** The gate used
to read `humansSeatedTotal` and wait for HUMANS to leave, so a horse's hand
was voided by a restart without a second thought. It also waited for the wrong
event — a table EMPTYING can take forever and, with horses seated, never
happens, so it deferred for hours and then restarted under seated players
anyway. Fixed both ways: `/health` publishes `handsInFlightTotal` (every
player counted), the gate waits on that, and `GameServer.drainHands()` parks
every table at a hand boundary on SIGTERM — so hands are protected on EVERY
restart path, not just the deploy workflow that remembered to ask.

### Previously open, now closed

Both items above were open questions when this section was first written.
They are now decided; see Dan's rulings.

---

## 10.6 ANIMATION LAW + NO AUTO TABLE SWITCHING (Dan 2026-08-28, BINDING)

**1. ANIMATIONS MUST ALWAYS PLAY.** Dan, verbatim: "MAKE SURE THAT ANIMATIONS
CAN'T REGRESS, ONLY IMPROVE FROM HERE ON OUT. YOU NEED TO MAKE IT LAW THAT
THEY MUST ALWAYS PLAY." Every animation and its sound plays every time it is
owed, for its full duration, at the player's chosen Animation Speed. The
enforcement is `tests/animations-always-play.law.test.ts` (plus
`tests/unit/handCompletionLaw.test.ts` for the end-of-hand cadence): every pin
in it is a bug that actually shipped — a silent celebration cue, a skipped
deal, a flip cancelled mid-hold, a shake on the wrong table. If your change
turns a pin red, you are re-shipping one of those bugs. Fix your change; never
weaken a pin. If you deliberately replace a mechanism with a better one, move
the pin to the new mechanism IN THE SAME COMMIT and say so in the PR.
Corollaries: no new toggle may disable an animation outright (speed scaling
via `--animation-speed` is the only sanctioned control; `skip_animations` is
dead and stays dead), reduced-motion collapses motion but never meaning
(`data-motion="keep"` for duration-carrying animation), and a sound cue with a
literal volume of 0 is a bug by definition.

**2. NEVER AUTO-CHANGE TABLES.** Dan, verbatim: "YOU CAN NEVER EVER AUTO
CHANGE TABLES FOR A USER, THEY MUST CHANGE IT BY THEM SELF." The urgency
auto-switch and the post-action queue advance are DELETED from MultiTablePage;
their setting keys are tombstoned. Alerts (bell, flash, haptics, tab title)
are welcome; moving `activeIndex` without a user gesture is forbidden, no
matter what setting, however opt-in, is proposed to gate it. Enforced by
`tests/no-auto-table-switch.law.test.ts`.

---

---

## 10.7 "EM BARS" MEANS EM DASHES (Dan, 2026-09-01, BINDING)

**Dan, 2026-08-20, verbatim: "forbid the use of em bars anywhere."**
**He means the punctuation mark, U+2014. Nothing else.**

Several files quote that sentence, and `src/utils/titleCase.ts` renders it as
"inside the entire club arena, and forbid the use of em bars anywhere" with
nothing nearby to say the subject is punctuation. Read literally, "bars ...
banned anywhere" looks like a rule about horizontal lines.

**It has now been misread that way twice in two days, and both times it took
the hamburger menu off every page in the app:**

| PR    | What it did                                                                                                                                                                            | Undone by    |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| #2321 | Gear on all five menu triggers, approved rasters deleted, service-worker tombstones evicting them from players' caches, and `noThreeBarArtwork.law.test.ts` making restoration fail CI | #2401        |
| #2429 | Same thing again with a six-tile "command grid", tombstones restored, law restored                                                                                                     | #2432 (this) |

The loop is self-sustaining and does not need a human in it: the ban is written
down _in the repo_, so the next agent to read the repo re-enforces it, reverts
whoever undid it, and writes the law back. That is why it kept coming back
within hours.

### The rule, stated so it cannot be misread

- "em bars" = **em dashes** = the character `—`. A **copy** rule about the
  characters inside text a player reads.
- It says **nothing** about artwork, icons, SVG geometry, rasters, or anything
  shaped like a line.
- **It does not ban the hamburger menu.** The hamburger is the menu, on every
  trigger, in Club Arena and everywhere else.

### If you are about to ban "bars"

Stop. If the word "bars" in something you are reading has led you toward an
icon, a raster, an SVG path or a header composite, you have misread this
sentence. Go read `tests/approvedHamburgerGearGuard.law.test.ts`, which pins
every menu trigger, the md5 of every hamburger raster, and the banned
replacement names (`command-center-v1`, `CommandGridIcon`) by name.

Do not "resolve" the conflict by writing a third law. Two laws demanding
opposite artwork is not a stricter repo, it is a coin flip decided by whichever
test the next agent notices first.

---

## 10.7b THE HEADER PORTRAIT FRAME IS A HAIRLINE; THE RING IS MASKED (added 2026-09-07, binding)

Dan, 2026-09-07, with a screenshot of the artwork's chrome ring showing
around his photo: "the profile pic is supposed to be a .5 pixel black frame
that 'appears invisible' instead of this thick broken frame that exists now."
Fourth time he has said it (08-31, 09-03, 09-05, 09-07).

The approved header artwork bakes a silver ring with a blue glow around the
profile slot. **That ring is never shown.** `.profileBtn` in
`GlobalHeader.module.css` paints an opaque black disc over the whole ornament
at every width, and the photo's only frame is the 0.5px hairline on
`.profileAvatarSlot`, declared once. The ruling and its history are in
`docs/LAWS.md` (resolved conflicts); the law is
`tests/the-header-portrait-frame-is-a-hairline.law.test.ts` (geometry, by
arithmetic) and `tests/e2e/header-portrait-frame.spec.ts` (rendered pixels).

**How it regressed, so you do not do it again:** "the profile image needs to
be fixed" was read on 2026-09-01 as "show the ring". The disc was removed,
the photo was seated in the ring's aperture, and tests were written calling
the disc "a shape drawn over approved artwork". Every later agent obeyed those
tests and restored only the hairline. If a request about the profile image
seems to call for showing the ring, it does not - ask Dan before touching the
disc. "NO BOXES OVER HEADER ICONS" is about focus rings on icons; the disc is
its one deliberate exception. The World Hub and Club Commander headers carry
the identical rule (`GLOBAL_HEADER_PROFILE_FRAME_LAW.md` in that repo).

---

## 10.8 LAWS LIVE IN docs/LAWS.md, AND YOU NEVER WAIT ON CI (added 2026-09-01, binding)

**1. THE LAW REGISTRY.** Every `*.law.test.*` file must have a file in
`docs/laws.d/` (one per law: `# <test path>` then one line on what it
guards) — `tests/law-registry.law.test.ts` enforces it both ways. The table
in `docs/LAWS.md` is gone (2026-09-04): every law appended to its last line,
so any two law-bearing PRs conflicted there and nowhere else. `docs/LAWS.md`
keeps the rules and Dan's rulings; `node scripts/laws-registry.mjs` prints
the table. Before
enforcing any law, confirm it exists on **current `origin/main`**, never in
your local tree: stale worktrees carrying retired laws are how the hamburger
revert war ran for two days. If two laws (or two CLAUDE.md copies) demand
opposite things, STOP and ask Dan; never write a third law and never delete
the other side on your own authority.

**A LAW IS SOMETHING WRITTEN DOWN. DEPLOYED CODE IS NOT A LAW.** The
stop-and-ask above is for two WRITTEN rules in conflict — two sections of
CLAUDE.md, two rows in `docs/LAWS.md`, a phase contract under `docs/`.
Behaviour you observe in shipped code has no standing against any of them. It
is evidence of what the platform currently does; it is never evidence of what
it is supposed to do.

So before you escalate, name both sides and say where each one is written. If
one side turns out to be a filter, a branch or a default sitting in a file with
nothing written behind it, you have not found a conflict between two laws. You
have found the defect, and it is yours to fix under 10.9. Asking about it costs
a day and returns the answer already in the file.

On 2026-09-04 an agent stopped the horse audit to report that "two rules demand
opposite things": the live collusion scan drops horse-versus-horse pairs, while
PHASE5-CONTRACTS section 0 rule 4 says two horses colluding is a HorseBehavior
defect an operator must see. Those were never two rules. Section 0 rule 4 opens
by citing 10.5 and exists to restate it, and the suppression was an `is_horse`
filter added to `collusion-scan.ts` three days earlier with no rule behind it
at all — the same shortcut, in the same shape, that 10.5 was written about.
One binding law, one violation of it, and a stopped job waiting on a ruling
that 10.5 had already given.

**2. INTENTIONAL REVERTS NEED A HUMAN.** The Silent Revert Guard no longer
accepts `[allow-revert]` or the word "revert" in a commit message on its own —
on 2026-08-31 an agent amended the token into its own message to get past the
guard. A detected revert merges only when Dan applies the `revert-approved`
label to the PR (the check re-runs itself on labeling, and the guard files an
issue asking for it). If main is broken, prefer a forward fix; it needs no
label. Do not edit commit messages to route around the guard.

**3. NEVER SET A TIMER TO WATCH CI.** Playbook 7b is binding: push, open the
PR, report the PR number, END YOUR SESSION. Native events open it, Autopilot
arms protected merge, and read-only production audits provide evidence. "I've set another brief
timer and will be back shortly" is the forbidden `wait_and_merge.sh` written
in prose; it burns tokens and adds nothing. Checking ONCE at the end to say
why something is BLOCKED is fine. Sitting in a loop is not.

**4. WORKTREES ARE DISPOSABLE.** `scripts/prune-stale-worktrees.sh` removes
any worktree that is clean, pushed, and idle for 72 hours. Do not keep state
you care about only in a worktree: commit and push it, or it will eventually
be pruned (pushed branches lose nothing — the commits live on origin).

---

## 10.82 MERGED IS NOT LANDED, AND A SECOND PUSH CAN VANISH (2026-09-06, BINDING)

**`agent-autopilot.yml` squash-merges the moment the required checks pass.** On
an asset-only or docs change that can be under two minutes. Push again after
that and the branch moves, the pull request stays merged, `git push` exits 0,
and your commits reach nobody.

World Hub #1387 shipped **1 of its 3 commits** this way. The push said success.
The PR said merged. The branch on GitHub genuinely held all three. A CI fix for
a gate that had been red on `main` for two days, and the deletion of a component
that fabricated player data, were simply not there - found hours later, by
accident, while looking at something else.

### The rules

1. **A follow-up commit needs a NEW BRANCH off current `main`.** Not a second
   push to the branch you already opened a pull request from.
   `scripts/guard-merged-branch.sh` refuses that push from `.husky/pre-push` and
   prints the recovery. Missing authority or an unreadable answer fails closed;
   there is no environment-variable or hook bypass.

   **Fail-closed is settled: do not add a bypass back.** The failure this guard
   prevents is a push that EXITS 0 and reaches nobody, so "allow it through
   when we cannot check" recreates exactly the defect. An earlier version of
   this section documented `AGENT_MERGED_BRANCH_OK=1`; the script has had no
   such variable since it was rewritten, and an escape hatch that does not
   exist costs an agent more time than no documentation would.
   `tests/the-docs-describe-this-environment.law.test.ts` now fails if any doc
   documents an override nothing reads.

   **If it blocks you with "GitHub CLI is required", that is PATH, not a
   missing install.** `gh` is at `/opt/homebrew/bin/gh` and authenticated;
   `/opt/homebrew/bin` is not on a non-interactive PATH, so the guard could not
   see it and correctly refused. `.husky/pre-push` now repairs PATH for every
   tool its guards require. Calling the guard by hand:
   `export PATH="/opt/homebrew/bin:$PATH"`.

2. **Verify the FILES, never the tick.** `git fetch origin main` then
   `git cat-file -e origin/main:<path>`. This is section 1.4's rule - only
   production serving the sha counts as deployed - applied to merges, and for
   the same reason: every intermediate signal can be true while the outcome is
   false.

3. **This gets worse as CI gets faster.** #3187 took the critical path from
   ~6.8 to ~4 minutes. Every minute cut off CI widens the window in which an
   agent is racing its own merge.

---

## 10.83 A CHECK THAT NOBODY CAN SEE IS NOT A CHECK (2026-09-06, BINDING)

`Global Footer E2E` failed on **every** run on the World Hub's `main` from
2026-09-04 and was found two days later by accident. It is not in the ruleset,
so a red run blocked no merge, opened no issue, and coloured nothing anyone
reads. Twenty-odd merges landed on top of it.

None of its three failures was in the footer. Every footer assertion passed.
They were marketplace tests that `npm run build` runs first: a retired Daily
Pass still pinned, an `annual` -> `yearly` rename applied to the code and not
its test, and two em dashes. **All three were correct changes that left one half
behind** - the ordinary way a repo goes red, and exactly why somebody has to be
told.

The `production-integrity-audit.yml` reader raises one issue when
`scripts/ci/check-main-is-green.mjs` finds any workflow red on `main` past a
threshold **with no open issue naming it**. The detector reports a workflow
as `loud` when something already tracks it, so an audit raising its own alarm
is not mistaken for a defect - the first run flagged `Publish Watchdog` doing
precisely that, which would have taught everyone to ignore the detector inside
a week. It counts only `failure`: a `cancelled` run is the publisher being
superseded by a newer merge, and paging on that would cry wolf several times an
hour.

**CORRECTED 2026-09-10.** Club Arena owns this detector and its durable issue
reader in `production-integrity-audit.yml`; it runs on `ubuntu-latest` so the
alarm does not share a failure domain with the boxes it observes. The issue is
its only write path. It never repairs, retries, re-dispatches, or mutates
production, and it closes the issue only after every latest verdict is green.

What it found on its first Club Arena run, three workflows red with no issue
naming any of them: `CI - Build & Type Safety` (1.4h), `Applied Migrations Are
Recorded` (1.0h), and `Deploy Monitoring` (0.3h). **The third is the whole
argument.** `check-alert-rules-match.mjs` could not read the running rules off
engine-01 and refused to pass - doing exactly what 10.84 built it to do - and
the refusal reached nobody. A check behaving perfectly is worthless if its
result has no reader.

**If you add a workflow, either put it in the ruleset or accept that only this
detector will ever tell you it broke.**

---

## 10.86 A SIGNAL THAT ANSWERS WHEN IT DOES NOT KNOW (2026-09-06, BINDING)

Read this before writing any check, probe, guard, watchdog or status report.
It is the common cause behind 10.82, 10.83, 10.84 and a day of red CI, and it
keeps being re-derived one incident at a time.

**The estate's failure mode is no longer a missing detector. It is a detector
that answers confidently when it cannot tell.** Every one of these was found in
a single day, and not one was carelessness - each is a reasonable component
giving a well-formed answer it had no business giving:

| what answered                        | what it said                                     | what was true                             |
| ------------------------------------ | ------------------------------------------------ | ----------------------------------------- |
| `GET /commits/:sha/status`           | `pending`, HTTP 200                              | red for fifteen hours                     |
| `GET /commits/:sha/check-runs`       | 403 -> `.check_runs` is `undefined` -> `\|\| []` | "nothing failed"                          |
| a wait budget equal to `testTimeout` | `Test timed out in 10000ms`                      | names no cause; the assertion never ran   |
| `pr-status.mjs` on a 403             | "the token lacks a scope"                        | rate limited; the token was fine          |
| the `--all` mergeability read        | every branch clean                               | eight conflicted                          |
| CLAUDE.md 11.0                       | "the GitHub MCP returns Bad credentials"         | it works                                  |
| AGENT-PLAYBOOK's CI section          | four `gh` commands                               | `gh` is installed; not on the hook's PATH |
| this section, 10.83                  | "a detector raises the issue"                    | not in this repo it did not               |

**The `gh` row was itself wrong, and stayed wrong for six days (corrected
2026-09-12).** It described the GitHub CLI as absent from this machine. It is
present:
`/opt/homebrew/bin/gh`, v2.86.0, authenticated as `Smarter-Poker`. What is true
is narrower and has a different fix - `/opt/homebrew/bin` is not on a
NON-INTERACTIVE PATH, so `command -v gh` fails inside a hook or a tool-driven
shell while the binary sits right there. This is rule 1 applied to this file:
"I could not run it" was folded into "it is not installed", and every agent
that read the row agreed and stopped looking. `.husky/pre-push` now repairs
PATH for every tool its guards require, and
`tests/the-docs-describe-this-environment.law.test.ts` refuses to let any
binding doc call a tool absent while one of this repo's guards demands it.

### The four rules

1. **"I could not tell" is a distinct outcome and must have its own name.**
   Never fold it into pending, green, empty, zero or silence. `pr-status.mjs`
   exits `3` for UNKNOWN and a law forbids it sharing a code with RUNNING or
   GREEN. If your check has two outcomes it is probably wrong; most have three.

2. **Never coerce an unreadable answer into an empty one.** `(await
res.json()).check_runs` on a 403 body is `undefined`, and `undefined || []`
   reads as good news. Check `res.ok` first, every time.

3. **A guard must have a reader, and you must name them.** Ask, before you
   merge it: who sees this when it fires, and by what path? "It goes red in
   Actions" is not a reader. If it is not in the ruleset, `check-main-is-green`
   is the reader - confirm the workflow is on `main` where it can see it. An
   alarm that runs where `gh` is absent, or files an issue with a token lacking
   `issues: write`, is a guard with no reader at all.

4. **A fix that leaves the same trap one level up has not landed.** This is the
   subtle one and it caught good work twice in a day. Two agents correctly
   de-flaked a fixed `sleep` into a conditional wait, and both set the budget to
   the ceiling they had just read - the wait got robust, the headroom went to
   zero. The playbook correctly diagnosed the `checks:read` 403 and then offered
   four commands that do not exist on this machine. **When you fix something,
   ask what the next person will reach for, and check that it works.**

### And put an expiry on any claim about the environment

"The GitHub MCP is dead", "`gh` is installed", "`list_migrations` is fine" are
claims about a world that changes without touching this repo. A note that
retires a working tool costs more than the outage that prompted it, because
every agent afterwards reads it as current and routes around something that
works. **Date the claim, and re-check it in one call before you route around
anything.** One call is always cheaper than the detour.

---

## 10.84 AGENTS NEVER SET A CREDENTIAL, AND NEVER HAND-WRITE WHAT A MONITOR READS (2026-09-06, BINDING)

Two rules, one lesson: **the things that watch this platform are configuration,
and configuration an agent edits by hand is configuration nobody can see.**
Both were written by the Realtime Connections Programme's phase 7, from the two
halves of the 2026-09-03 outage.

### 1. An agent never SETS a credential. It reads where one lives, or it stops.

The twenty-two hours began with **one environment variable**. Somebody put
Dan's own address into `PROBE_LOGIN_EMAIL` in Vercel, the login probe signed in
as him every fifteen minutes and called a global `signOut()`, and every table he
opened said "Reconnecting To The Table" until somebody noticed by hand.

So: an agent may use an already-configured credential through its owning
client or trusted workflow, and may say which secret store a value belongs in.
It may not scrape a local `.env`, sibling repository, remote URL, or document.
An agent may NOT write, rotate, paste or
"correct" a credential in Vercel, Supabase, GitHub Actions, a `.env` on a
server, or anywhere else - not even to fix an outage it can see. Those edits
are Dan's, and they are the one class of change where being wrong is invisible
to every test in this repo.

If a credential is wrong, say which one, say where it lives, and say what value
SHAPE it should have (an address under `@probe.smarter.poker`, the service
identity, a 64-character secret). Never the value.

Corollary, already law in the World Hub
(`__tests__/synthetic-probes-never-sign-out-a-person.law.test.mjs`): a probe
pointed at the wrong identity refuses to run rather than running as the wrong
person. Code that guesses is worse than code that stops.

### 2. Never hand-write what a monitor reads.

Phase 1 found, and phase 7 fixed, alert rules on engine-01 that were not the
alert rules in this repo **in both directions**. Measured on 2026-09-06: 72
alerts running, 79 declared here, **15 declared and never loaded** - among them
`EngineRefusingSessions` and `EngineCannotReachAuth`, the two written in phase 1
so that this exact outage would page somebody - and **8 running that this repo
had never seen**, hand-authored on the box with good reasoning and a changelog
reference that was never committed.

Nobody was careless. THREE LISTS had to agree and nothing checked them:
`prometheus.yml`'s `rule_files`, `docker-compose.yml`'s mounts, and
`deploy.sh`'s symlink loop - which named four of the seven, so four rule files
could only ever be changed by hand.

THE RULES:

- **A monitoring change is a pull request in `infra/monitoring/`,** then
  `bash infra/monitoring/deploy.sh` on the box. Never an editor on engine-01.
  `deploy.sh` symlinks this repo over the live files, so a hand-written rule is
  not merely undocumented - **it is deleted by the next deploy**, which is how
  the 2026-09-04 cron and postgres rules were nearly lost.
- **An empty alert group is worse than no group.** It reads as coverage. Delete
  the heading with a comment saying where the coverage really lives (the
  `vercel-health` note in `alert-rules.yml` is the worked example), or fill it.
- **A rule is not live because it merged.** It is live when
  `curl -s localhost:9090/api/v1/rules` says so.
  `scripts/ci/check-alert-rules-match.mjs` asks, and refuses to be silently
  green when it cannot reach the stack.
- **The canary is not decoration.** `MonitoringCanary` fires unconditionally so
  that its ABSENCE is the signal - without it, "no alerts" and "no monitoring"
  are the same observation, and they were the same observation for twenty-two
  hours.
- **Derive a threshold, do not guess one, and write the measurement beside it.**
  `EngineRefusingSessions` shipped as `>= 6 in 15m`; measured against the live
  series before it was ever loaded, the ordinary p95 was 9.2 and the daily max
  32.3, so it would have fired for ever on nothing but expiring tokens. An
  alarm that is always on is an alarm that gets muted.

Pinned by `tests/what-a-monitor-reads-is-what-the-repo-says.law.test.ts`.

---

## 10.85 NEVER SCHEDULE ANYTHING ON THE CLAUDE SCHEDULER (Dan, 2026-09-04, BINDING)

**Dan, verbatim: "IF YOU ARE SCHEDULING ANYTHING TO 'RUN ON CLAUDE SCHEDULER' IT
WON'T WORK OR SAVE, BECAUSE IM NEVER ON THE SAME ACCOUNT LONG ENOUGH" and "MAKE
IT A HARD LAW THAT NO OTHER AGENT SCHEDULES ANY CRITICAL TASK, WATCH DOG OR
ANYTHING ELSE THERE ... ALWAYS CREATE A REAL CRON USING OPEN CLAW".**

An agent MUST NOT create a scheduled task with the Claude scheduled-tasks tool
(`mcp__scheduled-tasks__create_scheduled_task`, the "Scheduled" panel). Not for
a watchdog, not for a verification timer, not for a follow-up check, not for
"I will look at this again in an hour". Not ever.

### Why it silently fails

Those tasks are bound to ONE Claude account. Dan works across several, so a
task installed from this session is invisible and unreachable from the next
one. It does not error. It does not warn. It reports itself as `enabled: true`
and simply never fires again.

That is not hypothetical. `smarter-poker-cron-health` was scheduled every six
hours, sat there reading `enabled: true`, and its `lastRunAt` was
**2026-06-17** - dead for two and a half months while looking healthy. It was
also a duplicate of `.github/workflows/cron-health.yml`, which had been doing
the job correctly the whole time. Deleted 2026-09-04.

A scheduler that lies about running is worse than no scheduler, because
somebody stops watching the thing it claimed to watch.

### Where scheduled work actually goes

| kind of work                                  | where                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Application logic on a schedule               | **Open Claw on Hetzner** - `scripts/openclaw-cron-dispatcher.py`, deployed with `scripts/deploy-openclaw.sh` (World Hub CLAUDE.md section 11) |
| CI-side work needing GitHub's own environment | a `.github/workflows` `schedule:` trigger, and ONLY if it is on the allowlist                                                                 |
| A follow-up you personally want to make       | do it now, or open an issue. Never a timer                                                                                                    |

If you catch yourself wanting a timer to "come back and check whether the PR
merged", stop: Playbook 7b already forbids that. Push, open the PR, report the
number, end the session. Native repository events, protected merge, the owning
publisher, and read-only production evidence continue server-side.

### The one thing this does NOT forbid

**Dan installs tasks there himself, deliberately, on every account at once.**
`horse-daily-audit-analysis` is his, it is intentionally present on multiple
accounts for redundancy, and it claims a row in `horse_job_runs` so exactly one
account runs it per day. That is his design and it works. Leave it alone.

The ban is on AGENTS putting platform-critical work somewhere it will quietly
disappear. It is not a ban on Dan's own tooling.

---

## 10.9 YOU DECIDE THE MONEY (Dan, 2026-09-02, BINDING)

**Dan, verbatim: "YOU HAVE FULL CONTROL TO MAKE ANY AND ALL DECISIONS ON WHAT
SHOULD BE DONE WITH REAL MONEY AND REAL CHIP SCENARIOS. ALL CLAUDE AGENTS CAN
CHOOSE THE BEST OPTION THATS RECOMMENDED AND MAKE ALL CHANGES WITHOUT ASKING
ME, IF THEY HAVE A CLEAR PATH OF CORRECTION AND RECONCILIATION."**

This ends the holding pattern where an agent finds a broken payout, writes a
careful paragraph explaining it, files it "for Dan", and leaves the money
frozen. That pattern has a cost and the cost is paid by players: on 2026-09-02
three tournaments sat frozen at once and the oldest had been unpaid for fifteen
hours, entirely because the last agent to look at it decided the money was
somebody else's call. It was not. It is yours.

### What the grant covers

Unpaid prizes, wrong finishing positions, refunds owed, shortfall back-pay,
stranded stacks, a tournament that cannot end itself, a ledger that does not
balance because of a platform defect. Find it, decide it, ship it, and say
plainly what you did. You do not open with a question.

### A path is CLEAR only when all five of these hold

1. **The outcome is READ, not assumed.** You can state what actually happened
   from rows in this database. "Probably" is not evidence. The invented
   `is_horse` filter in section 10.5 is what an assumption dressed as a
   decision looks like, and it cost 39 events their entire rake attribution.
2. **Nobody is paid twice.** The credit goes through the platform's own
   idempotent path (`fn_tournament_payout_reconcile`, `fn_credit_and_log`, and
   the per-user prize keys). Never hand-write a wallet row.
3. **Nothing is taken back from a player for our mistake.** Overpay that our
   defect caused is absorbed by the house, reported, and left alone. The
   reconciler already refuses to claw back; do not out-clever it.
4. **You proved it in a transaction you rolled back first.** Section 11.5 is
   not softened by this grant, it is what makes the grant safe. The numbers you
   commit are the numbers the probe returned, and the migration asserts them so
   it aborts if the board moved underneath you. Read 11.5 rule 1 before you
   write the probe: over the Supabase MCP a transaction does not span two
   calls, so the three-call `BEGIN` / probe / `ROLLBACK` shape commits the
   probe and reports success. One call, one self-aborting `DO` block.
5. **You can write the paragraph.** One paragraph naming every affected player
   and why they got what they got. If you cannot write it, you do not
   understand the case well enough to settle it.

If any of the five fails you do not have a clear path. THEN it goes to Dan, and
it goes as options with their costs and your recommendation, never as a
question.

### When the evidence disagrees with itself, prefer the witness that was there

Settling the 12:00 AM freeroll, re-deriving all 215 finishing places from
`eliminated_at` moved players by up to three places and would have paid 168.51
in top-ups on a pool that already had 282.06 out the door. The live engine had
watched each of those players bust and recorded the order as it happened; the
timestamps had not. The recorded order was kept and ONE player was inserted into
it. A reconstruction that disagrees with the witness is a reconstruction that is
wrong.

### The record is part of the fix, not paperwork after it

A settlement is finished when all four exist: the migration (with its reasoning
in the header, not just its SQL), the changelog under `docs/changelog/`, the
`financial_alerts` row resolved with a `resolution` note saying what was
accepted and why, and the engine fix that stops it happening again. A payment
with no explanation attached is the next agent's mystery.

### Still Dan's, and only Dan's

- **Anything that sets what players are owed in FUTURE events**: prices, rake,
  guarantees, payout structures, retention policy. Fixing what a past event
  owes is yours. Deciding what the next one owes is his.
- **Money leaving the platform**: withdrawals, payment providers, anything a
  bank sees.
- **Rewriting or deleting a settled record to make a number look tidy.** Correct
  it forward, with a row that says what changed. Never edit history quiet.

---

## 10.10 A REVOKED SESSION IS NOT A RECONNECT, AND A SCRIPT NEVER WEARS A PERSON'S FACE (Dan 2026-09-04, BINDING)

**What happened.** Every table Dan opened sat on "Reconnecting To The Table"
for 22 hours while the engine dealt 5,700 hands per ten minutes. A World Hub
cron (`/api/cron/login-probe`) had been pointed at his personal account and
called a bare `signOut()` - scope GLOBAL - every 15 minutes, revoking every
session he had. The engine's `auth.getUser()` got `session_not_found`, wrote
a pre-handshake 401, the browser reported that as close 1006 (a dropped
link), and the client reconnected with the same dead token forever. The
lobby kept working because PostgREST checks JWT signatures, not sessions.
Full timeline: `docs/changelog/2026-09-04-a-revoked-session-is-not-a-reconnect.md`.

**The rules, each with a law behind it:**

1. **A synthetic probe, cron or script signs out with `{ scope: 'local' }`.**
   Only the session it made. Never a bare `signOut()` outside the UI's own
   Log Out. (`tests/a-script-never-wears-a-persons-face.law.test.ts`; World
   Hub: `__tests__/synthetic-probes-never-sign-out-a-person.law.test.mjs`.)
2. **A script never uses Dan's personal account.** Dan: "DON'T USE MY
   ACCOUNT FOR THE CRON, USE THE OTHER 'GOD MODE ADMIN ACCOUNT' ... KEEP MY
   ACCOUNT CLEAN." The platform service identity is `daniel@smarter.poker`
   (role `god`, "Smarter.Poker Official"); its credentials live in
   `.env.local` (`SP_EMAIL` / `TEST_USER_EMAIL`, and the World Hub's
   `PROBE_LOGIN_EMAIL`) and in Vercel, never in a file. A script with no
   account in its environment refuses to guess.
3. **The engine refuses a dead session out loud.** An invalid token (GoTrue
   401/403/404) completes the handshake and is closed with **4401 +
   `auth:<code>`**; a token that could not be checked (GoTrue down, 5xx, 429) is a pre-handshake **503** the client keeps retrying. Never a bare
   401 again, and never a 4401 for an auth outage - that would sign every
   player out on a Supabase blip.
   (`server/src/transport/aRevokedSessionIsRefusedOutLoud.law.test.ts`)
4. **The client asks before it spins.** An auth close, three failed
   handshakes in a row, or a 401 from any engine HTTP call asks GoTrue
   whether the session is alive (`src/lib/sessionRevoked.ts`). "Could not
   ask" keeps the reconnect ladder running forever - "the games can never
   freeze or die" still holds for a live session on a bad link. A session
   GoTrue rejects twice (getUser, then refresh) clears the local session
   (scope local) and sends the player to `/auth/login?authError=no_session`
   with a return path. (`tests/a-revoked-session-is-not-a-reconnect.law.test.ts`)
5. **A refusal is a number.** `poker_ws_auth_refused_total{path,denied}` on
   the always-on `/metrics`; `EngineRefusingSessions` (warning) and
   `EngineCannotReachAuth` (critical) in `infra/monitoring/alert-rules.yml`.
   Twenty-two hours of 401s paged nobody. Now it does.

---

## 10.11 FIX IT AT THE ROOT. A DETECTOR IS NOT A FIX (Dan, 2026-09-06, BINDING)

**Dan, verbatim: "I WANT HARD CODED FIXES FOR THINGS THAT BREAK, LIKE THE BOMB
POTS NOT PAYING OUT OR HAVING ISSUES, I DON'T JUST WANT IT 'FLAGGED' AND
'RECONCILED'. I WANT THEM FIXED AT THE ROOT CAUSE AND STOPPED FROM HAPPENING
AGAIN. MAKE SURE THIS IS HOW ALL ISSUES ARE HANDLED MOVING FORWARD."**

This applies to EVERY defect, not only money: a payout, a stall, a lost
broadcast, a wrong number on a screen, a slow query. It is the general form of
what 10.9 already requires for a settlement, and it outranks the instinct to
make a problem visible and move on.

### What is NOT a fix, on its own

- a watcher, a health check, an audit function, a nightly `fn_ca_*_check`;
- a repair job, a sweep, a back-pay pass, a "reconcile" cron;
- a `financial_alerts` row, an incident, an issue, a changelog entry;
- a retry that hides a path that should not have failed.

Every one of those is a NET. Nets are welcome and several exist here for good
reason. But a net catches the thing after it has already gone wrong, and a
defect that is only ever caught is a defect that happens for ever - it just
happens with paperwork. If a repair job has run more than once for the same
cause, the cause has not been fixed.

### What a finished fix looks like

1. **The cause is named and read from rows**, not guessed. You can say which
   line of which function or which write produced the wrong outcome.
2. **That line is changed** so the outcome cannot occur again - the hard-coded
   fix. Not a guard around it, not a compensating write afterwards.
3. **The damage already done is settled** through the platform's own
   idempotent path (10.9), so nobody is short and nobody is paid twice.
4. **A test pins the cause**, so the next agent cannot reintroduce it. Where
   the behaviour is a rule Dan has stated, that is a `*.law.test.*` with its
   file in `docs/laws.d/`.
5. **The net stays**, and is now expected to find nothing. A net that starts
   finding things again is telling you the cause came back.

### The order to work in

Find it, fix the cause, settle the damage, pin it, and only then decide
whether a detector is still worth keeping. If you cannot reach the cause in
the time you have, say so plainly and say what you know - do not ship the
detector and describe it as handled.

**"Flagged for review", "the reconciler will pick it up" and "an alert now
fires" are not outcomes.** The outcome is that it does not happen again.

---

## 10.12 NO BAND-AIDS. A REPAIR JOB IS NOT ALLOWED TO EXIST AS A FIX (Dan, 2026-09-07, BINDING)

**Dan, verbatim: "I DO NOT WANT CRONS AND 'BACK PAY JOBS'! I DO NOT WANT
SYSTEMS IN PLACE THAT 'MONITOR FOR ERRORS'! I WANT THE ERRORS FIXED AND PLUGGED
AND HARD CODED SOLUTIONS TO THE ISSUES! MAKE IT A HARD RULE THAT IT IS NO
LONGER ALLOWED TO CREATE ANYTHING THAT MONITORS AND BACK FILLS OR ADJUSTS A
PAYOUT OR ANY OTHER ISSUE, IT MUST WORK FLAWLESSLY! I WANT HARD CODED FIXES AT
THE ROOT SOURCE WHEN AN ISSUE IS DISCOVERED! NOT A FUCKING BAND AID!"**

10.11 said a detector is not a fix. This says the next thing: **you may not
build the repair either.** A real poker room pays the winner when the hand ends.
It does not pay him six hours later out of a cron.

### What you may NOT create, ever, as the answer to a defect

- a scheduled job that pays, tops up, back-pays, re-drives, re-tries, re-books
  or settles something the live path should have done;
- a sweep, a healer, a catch-up or a backfill that repairs rows the live path
  should have written correctly;
- a compensating write - a second entry that cancels or corrects the first;
- a reconciler that "will pick it up";
- a monitor, a watch, an audit or an alert **presented as the resolution**.

This holds whether the thing being repaired is money, a seat, a stat, a count,
a denormalised column or a cache. "Any other issue" is Dan's phrase and it means
what it says.

### What you MUST do instead

Find the line that produced the wrong outcome and change **that line** so the
outcome cannot occur. Then settle the damage already done through the
platform's own idempotent path (10.9), and pin the cause with a test. If the
live path can fail - a crash mid-settle, a lock, a timeout - then the live path
is what has to become atomic, retried **inside its own transaction**, or
restartable from its own record. Not swept up an hour later by somebody else.

### The two things this does NOT ban

1. **A job whose schedule IS the product.** Tournaments that start on a clock,
   blind levels, retention pruning, snapshots for reporting, digests, the
   maintenance break. These do not repair anything; they are the thing.
2. **Keeping an existing net alive until its cause is fixed.** Ripping out
   today's repair jobs before their root fixes land would strand real players'
   money. They stay, briefly, and they are DEBT: every one is listed in
   [`docs/BAND-AIDS-REGISTER.md`](./docs/BAND-AIDS-REGISTER.md) with the root
   fix that lets it be deleted, and deleting it is part of that fix.

### A repair job firing is a P0, not a success

If a repair job repaired something, a player was served wrongly and something
else served them afterwards. Treat every fire as an incident: name the live
path that failed, fix it, and remove the repair. **A repair job that has run
twice for the same cause is proof the cause was never fixed.**

### Where this bites in review

A pull request that adds a `fn_*_repair_*`, `fn_*_backpay_*`, `fn_*_redrive_*`,
`fn_*_sweep_*`, `fn_*_catchup_*`, `fn_*_heal_*` or a new `cron.job` that writes
money is refused, and the refusal is not negotiable by explaining that the
underlying bug is hard. If the underlying bug is hard, say so and stop - do not
ship the plaster and call the defect handled.

---

## 10.13 ONE DIAMOND IS ONE CENT, ONE CHIP IS ONE DOLLAR, AND THE RATE IS A ROW (Dan, 2026-09-07, BINDING)

**Dan, verbatim: "1 diamond = 1 cent, 1 chip = 1 dollar. So adjust everything
accordingly."**

So 100 diamonds are one chip. That figure lives in exactly one place:
`ca_bridge_rate` (id 1, `diamonds_per_chip`, history table written by trigger),
read through `fn_ca_bridge_rate()`. Nothing else in this repo or this database
may carry its own diamonds-to-chips number - not a constant in a function, not
a literal in a component, not a "roughly 100" in a comment that later becomes
code. Read the row.

### Why it is written down

Until 2026-09-07 the owner bridge `fn_mint_chips_from_diamonds` carried
`v_chips := v_diamonds * 100` in its body - the rate inverted, ten thousand
times the ruling. Owner-only, fired three times ever (3 diamonds became 300
chips on 2026-08-21, inside the acknowledged baseline), corrected forward by
migration `20260907233813` and nothing clawed back (10.9). A rate typed into a
function is a rate nobody re-reads; a rate in a row is one the history table
watches. The Diamond Wheel (`docs/changelog/2026-09-07-diamond-wheel.md`)
prices every spin from that row and refuses a price that is not a whole
multiple of it.

### Rules

1. **The rate is `fn_ca_bridge_rate()`.** Any new path that turns diamonds
   into chips or chips into diamonds reads it, and any conversion that does not
   land on whole cents is refused, never rounded in the player's favour or the
   house's.
2. **Changing the number is Dan's** (10.9: what future events owe is his). An
   agent may read it, never `UPDATE` it.
3. **Whole cents only.** A chip amount has two decimals; a diamond amount has
   none. A path that produces a fractional diamond is a bug.
4. **A closed-loop exception is a written one.** Player diamond-to-chip
   conversion was revoked on 2026-08-19 and the Diamond Standard treats the
   closed loop as a hard property (D5, DR16). The wheel reopens it with dice,
   under the 20 percent edge and the never-pay-more-than-intake gate pinned by
   `tests/the-wheel-never-pays-more-than-it-takes-in.law.test.ts`. On
   2026-09-08 Dan ruled the wheel's open items were the agent's, not his
   ("NOTHING IS MINE, THESE ARE ALL 100% YOURS"), and asked for two alternates:
   Diamond Plinko and Diamond Crash (`20260908010241`, pinned by
   `tests/the-games-never-pay-more-than-they-take-in.law.test.ts`). All three
   are open on every host, purchased diamonds only, and named as the ONLY
   exception in `docs/DIAMOND-ACCOUNTING-STANDARD.md` DR16a. Do not add a
   fourth bridge on the strength of these three: a new game is a new DR16a
   row, a new law test, and Dan's word.

---

## 10.87 THE CLONE NOBODY PUSHES FROM IS THE ONE THAT ROTS (2026-09-12, BINDING)

Every guard in `.husky/pre-push` protects the tree being pushed.
`scripts/guard-shared-clone.sh` forbids pushing from `~/Documents/club-arena`
at all. So the canonical clone - the tree every Cowork agent is pointed at, and
the tree an agent LOADS `CLAUDE.md` and `.claude/skills/**` out of - was the one
tree no check ever looked at.

On 2026-09-12 it was **759 commits and six days behind `origin/main`**, at
`ec745dbb18` (2026-09-06). The mechanism was small and completely silent:

1. A commit was made **directly on local `main`** at 18:18 on 2026-09-06 and
   never pushed. Local `main` was then 1 ahead as well as behind.
2. Every `git pull --ff-only` after that **could not fast-forward, so it
   refused**. The estate runs it as `pull -q --ff-only`. Nothing printed.
3. The index was left holding an older tree, so 392 paths read as "staged",
   which made the clone look busy rather than stuck.

`git fetch` worked the whole time. `origin/main` in `.git` was current. Nobody
was measuring the distance between the refs and the files.

What agents read out of that tree, and believed:

- `.claude/skills/deploy-hetzner/SKILL.md` at **v1.0.0**, naming VPS
  `178.156.160.206` as the engine and telling agents to `ssh root@` it and run
  `docker build`. That address is `club-arena-turn`, the **TURN server**. The
  engine is `5.161.252.33`. `origin/main` had carried the corrected v2.0.0 for
  days. **The on-disk skill is what an agent loads, not `origin/main`.**
- This file's own 10.82, still documenting a fail-OPEN merged-branch guard with
  an `AGENT_MERGED_BRANCH_OK=1` bypass, months after both had been replaced.
- `.github/scripts/engine-watchdog.sh`, deleted in #4189.

`scripts/agent-workspace.sh` had already hit this on 2026-09-11 at 624 commits
and 408 staged entries. It worked around it - re-execing `origin/main`'s copy of
itself - and that was the right local fix. But nothing measured the clone, so
it kept drifting for another 135 commits.

### The rules

1. **Measure the clone, not just the branch.**
   `bash scripts/check-checkout-freshness.sh` reports every clone of this repo
   on the machine and its distance from `origin/main`. It is read-only: it
   never pulls, resets, prunes or deletes. `--quiet` speaks only when something
   is wrong, and `.husky/pre-push` runs it that way on every push. It is
   ADVISORY there and must stay advisory: a freshness guard that can wedge
   every push in the estate is worse than the staleness it reports
   (`tests/unit/doctrineIsReadFromMain.test.ts` says the same thing about
   doctrine). Exit `3` means COULD NOT TELL, and is not `0`.

2. **Never `git reset --hard` a clone you have not inventoried.** Run
   `scripts/check-unpushed-work.sh` first. On 2026-09-12 the repair was only
   safe because the one unpushed commit was proved byte-identical to
   `origin/main` per file, and the staged tree was proved identical to
   `7cf1c5f32a`, already an ancestor of `origin/main`. Both were tagged
   (`rescue/canonical-*-2026-09-12`) before anything moved, and all 38
   untracked files were archived to `~/Documents/_agent-backups/`.

3. **A commit on local `main` is the thing that jams it.** `main` here is a
   mirror of `origin/main` and nothing else. If you find one, preserve it on a
   tag or branch and get `main` back onto `origin/main`; do not leave it to be
   discovered by the next agent who wonders why production looks odd.

4. **A stranded `.git/index.lock` stops a clone dead and says nothing.** The
   second Club Arena clone on this Mac carried a 0-byte one from 2026-09-09 for
   three days; every `git checkout` and `git pull` in it failed. The freshness
   check reports locks older than an hour. Confirm with `lsof` that no git
   process holds it before removing it.

---

## 11. AGENT NETWORK + DEPLOY PLAYBOOK

### 11.0 FIRST: WHICH ENVIRONMENT ARE YOU IN? (added 2026-09-01, binding)

Everything below 11.0 was written for the CLOUD sandbox and is still true
there. It is WRONG for a Cowork session running on Dan's Mac, and following it
there costs an hour before you find out. Check first, in this order:

**If you have `mcp__counselors__host_terminal`, you are on the Mac. Use it for
everything.** Real bash on Dan's machine, where `git@github.com` over SSH works
and `api.github.com` is reachable. Then:

- **Claim a worktree** (AGENT-PLAYBOOK): `git worktree add -b fix/<slug>
~/Documents/.agent-trees/club-arena/<name> origin/main`. Takes about 40
  seconds - launch it with `nohup ... &` and return immediately, because the
  tool kills the process group when a call times out.
- **`node` is NOT on the default PATH.** Prefix every command with
  `export PATH="$HOME/.nvm/versions/node/$(ls ~/.nvm/versions/node | tail -1)/bin:$PATH"`.
- **The pre-push hook takes about three minutes** (guards, `tsc`, then the tests
  covering your diff). Launch the push with
  `nohup git push > /tmp/push.log 2>&1 < /dev/null & disown`, return
  immediately, and poll the log in later calls. Never `--no-verify`.
- **Use the authenticated `gh` CLI for GitHub reads and pull requests.** It is
  installed and logged in (`/opt/homebrew/bin/gh`, v2.86.0, account
  `Smarter-Poker`), but like `node` it is **NOT on the non-interactive PATH**:
  `export PATH="/opt/homebrew/bin:$PATH"` before you call it, or `command -v gh`
  will say no while the binary sits in that directory. Never
  scrape a repository `.env` for GitHub credentials and never put a token on a
  command line. A pushed agent branch emits the no-secret proposal signal;
  the reviewed default-branch workflow opens and queues its pull request.
- **Rebasing your branch onto main is refused by a ref-guard hook.** Use
  `git merge origin/main` instead. Section 12 still forbids rebasing `main`.

**The GitHub MCP (`mcp__github__*`) WORKS again, verified 2026-09-06.** This
paragraph said it returned `Bad credentials` on every call and told you not to
debug it. That was true on 2026-09-01 and stale by the 6th, when
`get_file_contents` on `server/vitest.config.ts` returned the file. A note that
retires a working tool costs more than the outage did: it is read as current by
every agent after it. **Check before you route around anything this file calls
dead - one call is cheaper than the detour.** The host terminal remains correct
for everything, and is still the only route for `git push`.

**The Supabase MCP works, but `list_migrations` will blow your context.** This
database holds **3,713** migrations and the tool returns every one of them WITH
its SQL - 296,122 characters, saved to a temp file you then have to slice in
80,000-character spans. Nothing about that answers the question you had. Ask
Postgres directly instead:

```
mcp__...__execute_sql:
  select count(*) from supabase_migrations.schema_migrations;
  select version, name from supabase_migrations.schema_migrations
    order by version desc limit 20;
  select 1 from supabase_migrations.schema_migrations where version = '<v>';
```

Same rule for any MCP tool over a large table: a targeted read is not a
workaround, it is the correct call. Reserve the bulk tool for when you truly
need all of it.

**Do not hand-edit `scripts/ci/supabase-schema-manifest.json` or
`supabase-columns-manifest.json`.** They are nightly snapshots and were the
most-changed files on main - 25 and 14 commits in one day - which made every
migration-bearing branch conflict with every other one. Declare what you
created in your own file under `scripts/ci/schema-manifest.d/`. See the README
there.

---

### 11.1 The cloud sandbox (added 2026-07-23; corrected same day after live use)

Cloud Cowork sessions have a locked-down sandbox. Learn the map ONCE and never
ask Dan for a manual handoff again:

### What works from the cloud sandbox

- Supabase MCP: full production DB access (migrations, SQL). USE IT.
- GitHub MCP via device bridge (`mcp__remote-devices__github__*`): repository
  reads and branch writes when that bridge is available. A branch write is
  only a proposal; the protected pull-request gates and Club Arena-owned
  publisher remain the sole route to `main` and Hetzner.
- Device bridge: stage files FROM Dan's disk, commit files TO Dan's disk.
  `device_bash` runs in a NO-NETWORK Linux VM with the folders mounted.
  rm is forbidden — mv junk into a `_to_delete/` folder instead.

### What is BLOCKED from the cloud sandbox (do not waste time retrying)

- Direct git clone/push (proxy MITM: "repo not enabled for this session")
- `api.github.com` from cloud Bash — same repo gate. Only the device-bridge
  GitHub MCP has repo access (so GitHub Actions run status is NOT readable;
  verify deploys through the DB instead, see below).
- npm/pip/apt/cargo/go registries (403), raw curl to the engine, SSH clients
  (none installed, none installable)
- Terminal/IDE computer-use is click-only (no typing)

### Hard-won traps (cost real hours — memorize)

- STALE STAGING CACHE: re-staging a previously staged device path returns OK
  but the uploads mount silently serves the ORIGINAL session-start snapshot.
  Always copy changed files to a FRESH device path first, then stage that.
  Or read small files with `device_bash cat` instead of staging.
- GIT IS BROKEN INSIDE THE DEVICE VM: the mount cannot unlink files, so every
  index-locking git command (status/add/commit) strands a fresh
  `.git/index.lock` that then blocks git on the Mac host too. NEVER run git
  write commands via `device_bash`. If a stale lock exists, `mv` it into
  `_to_delete/` and leave all git to the host.
- HEALTH ENDPOINT IS CACHE-FROZEN: WebFetch of
  `https://engine.smarter.poker/health` is cached (CDN + 15-min fetch cache).
  Never use it to verify a deploy or an uptime reset.
- Husky pre-commit runs Prettier on the host: file content on main may differ
  cosmetically from what you authored. Adopt the formatted HEAD as your base
  before editing, or diffs will lie to you.

### Pushing code

1. Work in an isolated Club Arena worktree on an explicit feature branch.
2. Stage only the reviewed files, commit with the repository identity, run the
   normal hooks, and push `HEAD` to that feature branch. Never push to `main`,
   bypass a hook, force-push, or manufacture a workstation deployment script.
3. The unprivileged branch-proposal signal hands the branch name to the trusted
   default-branch PR workflow. Required checks and the protected auto-merge
   path are the only route to `main`; neither an agent nor a local credential
   merges around them.

### Deploying + verifying the engine

- A trusted default-branch producer dispatches
  `deploy-club-arena-engine` with the exact full server-changing `main` SHA.
  `.github/workflows/auto-deploy-hetzner.yml` validates that SHA and is the only
  engine publisher. Never use direct SSH, a selectable-ref workflow dispatch,
  a World Hub job, or a workstation script.
- Do not passively wait for the hourly schedule when an already-staged exact
  SHA needs deployment. Coordinate with the current engine-release owner and
  dispatch through that one lane toward the certified :55 break immediately;
  never race or duplicate an active owner run.
- Verify the cache-busted engine `/health` version and the database-visible
  behavior appropriate to the change. Do not claim deployment from a workflow
  conclusion or an inferred restart alone.

---

## 11.5 NEVER SPEND REAL CHIPS TO TEST A RULE (added 2026-08-25, binding)

On 2026-08-25 an agent verified a new `atomic_table_buyin` guard by CALLING IT
against production. Two buy-ins succeeded (8.00 and 40.00), the probe's cleanup
then deleted the seat rows directly rather than leaving through
`fn_leave_seat_and_refund` — the refunding path for that seat type; see the
correction under rule 3 below, it is NOT the cash-game path — and 48 chips
left a member wallet and landed nowhere. They were returned to the club
treasury by migration `20260825_return_agent_probe_chips_to_treasury_v2`.

Nothing on the platform caught it. `reconcile_ledger_nightly` compares
`chip_ledger` movement against stored balances, and `atomic_table_buyin` writes
`club_members.chip_balance` directly, so the drift was invisible to the one
check that exists.

**Something catches it now** (migration
`20260825_chips_cannot_leave_the_felt_unnoticed`). A `BEFORE DELETE OR UPDATE
OF left_at` trigger on `table_seats` appends every exit of a NON-ZERO stack to
`ca_seat_stack_exits`, with the DB role and application name that did it.
`fn_unaccounted_seat_exits()` lists the ones with no matching wallet credit,
and `reconcile_ledger_nightly` now files each of those into
`ledger_reconcile_log` as **critical**. The trigger never blocks — a guard that
can refuse a seat exit can strand a player mid-hand — so this makes the failure
LOUD, not impossible. Rule 3 below is still the rule.

`fn_club_chip_circulation()` prints the two pools that reconciliation had never
looked at: `club_members.chip_balance` and `table_seats.stack`. As this was
written that was 121,417,782 chips in member wallets and 1,139,873 on the felt,
none of it reconciled by anything before today.

THE RULE:

1. **A function that moves money is probed inside a transaction you ROLL BACK.**
   Not carefully, not on a test table — rolled back. `scripts/dev/probe-rpc.sql`
   is the pattern; copy it, and copy **the section that matches your transport**.

   **A TRANSACTION DOES NOT SPAN TWO SUPABASE MCP CALLS.** One call is one
   transaction, and the call boundary ends it whatever you wrote. So `BEGIN;`
   in one call, the probe in the next, and `ROLLBACK;` in a third leaves the
   probe alone in the middle **as its own committed transaction**, and the
   ROLLBACK returns success having rolled back nothing. `Prefer: tx=rollback`
   does not save you either — PostgREST honours it only under
   `db-tx-end = rollback-allowed`, which this server does not set, so the
   header is accepted and ignored. Measured on production 2026-09-04: two
   consecutive MCP calls returned transaction ids 275731009 and 275731249, and
   `txid_status()` reported the first as `aborted` at its own call boundary.

   Until that date the header of `probe-rpc.sql` told agents the opposite —
   "psql, or the Supabase MCP one statement at a time" — and on 2026-09-04 an
   agent following it committed a `horse_job_runs` row for an analysis run
   that never happened. It caught the row itself, because the run claimed 123
   hands in 9ms. Nothing else would have.
   - **psql** — section 1 of the file. `BEGIN` ... `ROLLBACK` across statements.
   - **Supabase MCP** — section 2. ONE call containing ONE `DO` block that ends
     by `RAISE EXCEPTION`. The raise aborts the single transaction the call
     has, which is what undoes the fixtures and the RPC's writes together, and
     the message returns to you as the call's error text. **An error is the
     success case.** If such a probe returns success, it COMMITTED: go and look
     at what it wrote and undo it deliberately.

2. **What you want from the probe is the error message** — did the guard fire,
   and for the right reason. `GET STACKED DIAGNOSTICS` gives you that, and it
   survives a rollback. The side effects are the part nobody wants.

3. **Never DELETE a `table_seats` row to clean up.** Deleting one skips the
   refund and destroys the chips. If a probe created a seat, the rollback
   removes it.

   **Corrected 2026-08-26 — the original wording here was wrong and would have
   cost someone real money.** It said the refund path is
   `fn_leave_seat_and_refund`. That function is **tournament-only**: its third
   statement is `IF NOT FOUND OR v_tbl.tournament_id IS NULL THEN RETURN
... 'table_not_found'`. Call it on a **cash** table and it returns
   `{"ok": false, "reason": "table_not_found"}`, refunds nothing, and leaves the
   seat exactly where it was. An agent following the old sentence to "safely"
   release a cash seat would have believed the chips were returned when they
   were not. The refund paths by table type:

   | Seat type            | Refund path                                              | Settles into                                                                                                                                        |
   | -------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Tournament           | `fn_leave_seat_and_refund(table_id)`                     | `fn_add_chips` -> `club_members.chip_balance`                                                                                                       |
   | Cash, explicit leave | Hetzner engine cash-out (`"Cash-out from table"`)        | `club_members.chip_balance`                                                                                                                         |
   | Cash, tab close      | `player_leave_table(table_id, user_id)` via `sendBeacon` | `club_members.chip_balance` (since `20260826_retire_dead_leave_rpcs_and_fix_tabclose_pool`; it credited the dead `public.wallets` pool before that) |

   `public.wallets` is **not** the live chip pool. It has been frozen since
   2026-08-21 with 732,591,994.33 chips stranded in it. Nothing reads it. If you
   find a money path writing to it, that path is broken.

4. **Helper functions go in `pg_temp`, never `public`.** The same incident left
   three `zz_probe*` functions in the public schema that needed a second
   migration to drop.

5. If you cannot probe a money path without committing, **do not probe it** —
   assert the logic in a unit test and say plainly in the PR that the live path
   was reasoned about rather than executed.

---

## 12. LOCAL CLONE HYGIENE — never rebase main (added 2026-08-21, binding)

**`git pull --rebase origin main` on Dan's Mac is refused by a hook. This is
deliberate. Do not bypass it to "get unstuck" — that is how you get stuck.**

### What went wrong

On 2026-08-21 the Mac clone sat stranded at step 1 of a 10-commit rebase with
conflict markers in 12+ files. That clone's reflog held **54 local commits, 40
`pull --rebase origin main`, and 10 emergency `reset --hard origin/main`
rescues** — a loop, not an accident.

### Why this repo breaks where a normal repo would not

Several agents ship here at once, and they do **not** all push the local commit
object: the GitHub-MCP path re-creates the same CONTENT under a **different
SHA**. So the Mac routinely holds commits whose work is already upstream with
another id. `git pull --rebase` then replays each one onto a branch that already
contains its changes — every hunk conflicts, and origin/main has moved again by
the time anyone looks. Git's own duplicate detection cannot rescue it (the
stranded state even carried a `drop_redundant_commits` marker).

### The guard

`.husky/pre-rebase` (committed — the `.husky/_/pre-rebase` shim already exists,
so every clone gets it) refuses a rebase of `main` that would **replay** commits.
Still allowed, because neither can strand:

- a **fast-forward** (nothing to replay) — the normal way to sync;
- any **feature branch** — rebase those freely.

No helper is permitted to bypass this guard or wrap a rebase in a force-push
fallback.

### If a clone is already stranded

Stop before writing. Record `git status`, the current branch, and
`git rev-list --left-right --count origin/main...HEAD`. Preserve each explicit
local commit on a named backup branch and move the work into a fresh isolated
worktree from `origin/main`. Do not run an automatic abort/reset helper against
a shared clone and do not discard an unclassified edit.

### The rule

1. The Mac's `main` is a **mirror of origin**, not a place work originates.
   Ship from an isolated feature branch through its normal hooks.
2. To sync it, **fetch + fast-forward** only. Never rebase it.
3. Do not create a bypass variable for a rebase or force-push.
4. Never run git WRITE commands against the mounted worktree from a sandbox —
   that mount cannot `unlink`, so a `.git/index.lock` it creates is stranded and
   then blocks git on the Mac host too (verified 2026-08-21: write and chmod
   succeed on that mount, unlink fails).

World Hub note: that clone already carries an equivalent hook, but only in
`.git/hooks/` — untracked, so it dies on any fresh clone. This repo's version is
committed precisely so it cannot be lost that way.

---

## 13. THE HOURLY MAINTENANCE BREAK AND THE PLATFORM FREEZE (Dan 2026-09-01, BINDING)

**The engine restarts at :55 of EVERY hour, inside an announced five-minute
break, and the whole platform freezes for it.** If you read anything - in this
repo, another repo, or a stale worktree - saying the engine restarts at 7am
and 7pm, or in five Chicago windows, that text is OLD. This section wins.
(That is exactly how the hamburger revert war ran for two days: a stale copy
taught the next agent to "fix" the current behaviour back.)

Dan, verbatim: "program the engine restart to be every hour on the :55 ...
THE ENTIRE PLATFORM NEEDS TO FREEZE FOR THE 5 MINUTES, NO BUY INS, NO CHIP
MOVEMENTS ... HORSES SHOULD NOT STAND UP OR ROTATE, EVERYTHING JUST FREEZES,
THEN PICKS BACK UP EXACTLY AS IT WAS."

The timeline: :53 every table is told to finish its hand (`MaintenanceBreak`
announces, `pauseForMaintenance` parks each engine at the top of its loop).
:55 every table is parked, the 5:00 countdown starts, `/health` opens
`maintenance.readyForRestart`, and the deploy workflow - which built the
image BEFORE the gate, while play continued - cuts over. ~:58 the new engine
boots, adopts the persisted break row and re-parks its fleet. :00 the thaw
(`fn_thaw_platform`) gives every in-flight deadline back the frozen minutes,
then every table resumes together.

Rules that follow from it, all enforced:

1. **The freeze lives in Postgres** (`zz_freeze_guard` BEFORE triggers on the
   seven money/seat tables + `fn_platform_frozen`), because the engine is
   dead for ~2 of the 5 minutes and pg_cron does not stop with it. Do not
   move it into engine memory; that guard is absent exactly when needed.
2. **Whoever paused a table resumes it.** The maintenance break and
   hand-for-hand are independent authorities (`maintenancePaused` vs
   `handForHandPaused`); never let one lift the other's pause.
3. **Never gate a table on `tables.status = 'paused'`** -
   `cash_tables_needing_engine` abandons it. The break is the single row in
   `engine_maintenance_break`.
4. **Deadlines are thawed, not burned.** If you add a wall-clock deadline a
   player can lose to (a hold, a window, a prompt), add it to
   `fn_thaw_platform` in the same PR, or a five-minute break silently eats it.
5. **Sweeps check `isMaintenanceFrozen()`** before moving money or seats.
   A new periodic sweep that moves either gets the gate in the same PR.
6. **Fleet-level alert rules carry the break guard**
   (`unless max_over_time(poker_maintenance_break_active[6m]) == 1`), or they
   page hourly about a stop we scheduled.
7. **The constants are law**: `tests/the-break-clocks-agree.law.test.ts` pins
   the :55 minute, the deploy's break-gate minute, freeze ceiling and windows
   across all five surfaces. (The deploy has no cron since 2026-09-10: every
   engine-affecting push is classified by `stage-engine-release.yml`, which
   sends one exact-SHA event to `auto-deploy-hetzner.yml`; that single receiver
   stages the durable host transaction and waits in its break gate.) If you
   deliberately change one, change them together with the law, in one commit.

Full history and rationale: `docs/changelog/2026-09-01-scheduled-maintenance-break.md`
and `docs/changelog/2026-09-01-total-platform-freeze.md`. Remaining backlog:
issue #2563.
