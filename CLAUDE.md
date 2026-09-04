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
`.github/scripts/engine-watchdog.sh`. It records three separate guards that
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

Club Arena is a Vite + React SPA that lives inside the smarter.poker Next.js app.
It deploys through the World Hub repo, NOT directly.

### 1.1 How your work reaches production (rewritten 2026-09-03 - the World Hub is no longer in the path)

There is exactly ONE route from a commit to a player, and every step of it is
automatic. Your job ends at step 2.

1. **Work on a branch in your own worktree.** Any name is fine - `fix/<slug>`
   is the convention. Never commit on `main`; it is a protected mirror.
2. **Push the branch** over SSH (`git push origin HEAD:refs/heads/<branch>`).
   **That is the end of your job.** Do not open the pull request yourself, do
   not merge, do not watch CI (10.8.3). Report the branch name and stop.
3. `agent-open-pr.yml` opens the pull request within seconds of the push - on
   `create` AND on `push`, for any branch name.
4. `agent-autopilot.yml` enables squash auto-merge. The required checks run on
   the estate's own Hetzner runners (`vars.CI_RUNNER`), and GitHub merges when
   they are green. Red checks never merge (5.8).
5. **`publish-club-arena.yml` publishes - to Club Arena's own origin.** On
   merge it builds the bundle, runs the four-way sharded test gate, and
   rsyncs `dist/` to the static origin (Caddy on `estate-ci-1`,
   `ca-static.smarter.poker`) as `/srv/club-arena/releases/<ca_sha>/`, then
   swaps the `current` symlink atomically. The World Hub carries ONE rewrite,
   `/hub/club-arena/*` -> that origin, so the player is still on
   `smarter.poker` and the shared session (`smarter-poker-auth`) still works.
   A publish takes seconds. Nothing is committed to the World Hub repo any
   more, and Vercel does not rebuild the World Hub for a Club Arena merge.
   Rollback is re-pointing the symlink; ten releases are kept.
6. **Verify** by reading, never by assuming:
   `curl -s https://smarter.poker/hub/club-arena/build-info.json` - `ca_sha`
   must equal the squash commit on `main`. Nothing else counts as deployed.

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
`/fonts/*` are served from an ADDITIVE pool the publisher never `--delete`s,
pruned by age (30 days) only. Do not "clean up" the pool by removing what is
not in the current bundle - that is the 404 the old sync's retention logic
existed to prevent.

**Three nets catch a publish that fails, all automatic:** the `*/30` catch-up
cron inside the publisher, `publish-watchdog.yml` (re-dispatches up to three
times, then raises an in-app notification), and the orphan sweep in
`agent-autopilot.yml`. If production is behind `main` for more than ~25
minutes, something is genuinely broken - read the watchdog issue it filed.

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

### 1.1.7 THE RUNNERS (rescaled 2026-09-04)

| Box              | Type  | Cores | Runners | Serves                         |
| ---------------- | ----- | ----- | ------- | ------------------------------ |
| `estate-ci-eu-1` | cpx62 | 16    | 12      | Club Arena                     |
| `estate-ci-eu-2` | cpx62 | 16    | 12      | World Hub (6) + Club Arena (6) |
| `estate-ci-eu-3` | cpx62 | 16    | 12      | Club Arena                     |
| `estate-ci-1`    | cpx31 | 4     | 3       | World Hub + Club Arena         |

52 cores, 33 Club Arena runners. The three EU boxes were 8-core (cpx42) until
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

    GH_PAT=... node scripts/ci/apply-main-ruleset.mjs --stage=1   # block force-push + deletion
    GH_PAT=... node scripts/ci/apply-main-ruleset.mjs --stage=2   # + PR required, checks must pass

Stage 1 changes nothing about how you work and would have prevented the
2026-08-21 rewind that dropped four commits already serving in production.
Stage 2 is the one that makes a red test impossible to land - and it ends
direct pushes to main, so read section 1.3 again after it is applied. The two
required checks (`TypeScript Check`, `Client Unit Tests (vitest)`) already exist
in ci.yml and already run on pull_request.

The token also needs `Administration: Read and write`; one that can push code
cannot change protection rules. The script says which of the two is missing.

### 1.2 Vercel Project

- `hub-vanguard` (`prj_op66GkZyZcygXQKm76iyycfVFAQx`) -- THE REAL ONE. Aliased to `smarter.poker`.
- `smarter-poker` (`prj_FNUaJmcjRnwCSh1JzblIUYuOXDGK`) -- DEAD DUPLICATE. Disconnected. Do not touch.
- There are NO deploy hooks. The Vercel git integration auto-deploys on push to main.

### 1.2.5 HOW A PUSH LANDS NOW (changed 2026-08-21)

The command is unchanged:

    bash scripts/git-safe-push.sh "feat(ca): what changed"

What it does underneath is not. main is protected by a ruleset now, so the
script pushes a branch, opens a pull request, waits for the required checks and
merges it. You do not open the PR yourself and you do not push to main directly.

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

If it refuses to land, NOTHING was force-pushed and nothing was lost. Read the
output: a hook failure is yours to fix, a `dirty` state means a real conflict
with main, and a timeout leaves the PR open for you to merge by hand.

### 1.3 Never Do

- Never run `vercel deploy` or `vercel --prod` in the Club Arena directory
- Never push to or test on `club-arena.vercel.app`
- Never call any deploy hook URL
- Never add iframe code (`window.parent`, `postMessage`, `ClubArenaEmbed`)
- Never add `VITE_` prefixed secret keys (use server-side API routes)
- Never re-create `public/hub/club-arena/` in the World Hub. It was DELETED on
  2026-09-02 when Club Arena moved to its own origin, and Next.js serves
  `public/` BEFORE the rewrite, so a file there silently shadows the live
  bundle. `tests/club-arena-is-a-rewrite.test.mjs` in the World Hub fails CI if
  it comes back.

### 1.4 Claiming Success

You may ONLY say a change is deployed after `git-safe-push.sh` exits 0.
Never say "should be live in a few minutes" or "deploy triggered."

---

## 2. INFRASTRUCTURE

| Service  | Purpose                          | Location                                        |
| -------- | -------------------------------- | ----------------------------------------------- |
| Vercel   | Frontend hosting (smarter.poker) | World Hub repo -> auto-deploys via hub-vanguard |
| Hetzner  | Poker engine server (Node.js)    | `server/` directory, deployed via SSH + PM2     |
| Supabase | Database + Auth + Realtime       | `kuklfnapbkmacvwxktbh.supabase.co`              |

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

### Supabase

- PostgreSQL: tables, table_seats, table_hole_cards, hand_history
- Auth: JWT-based, shared with smarter.poker frontend
- Realtime: WebSocket broadcasts to connected clients
- RLS: Protects hole cards (users can only read own cards)
- Schema changes MUST be SQL migration files in `supabase/migrations/`

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
   not fail a report - it stops the World Hub sync for every agent and every
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

NO iframe. NO postMessage. NO proxy. Everything from smarter.poker.

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

## 10.8 LAWS LIVE IN docs/LAWS.md, AND YOU NEVER WAIT ON CI (added 2026-09-01, binding)

**1. THE LAW REGISTRY.** Every `*.law.test.*` file must have a row in
`docs/LAWS.md` — `tests/law-registry.law.test.ts` enforces it. Before
enforcing any law, confirm it exists on **current `origin/main`**, never in
your local tree: stale worktrees carrying retired laws are how the hamburger
revert war ran for two days. If two laws (or two CLAUDE.md copies) demand
opposite things, STOP and ask Dan; never write a third law and never delete
the other side on your own authority.

**2. INTENTIONAL REVERTS NEED A HUMAN.** The Silent Revert Guard no longer
accepts `[allow-revert]` or the word "revert" in a commit message on its own —
on 2026-08-31 an agent amended the token into its own message to get past the
guard. A detected revert merges only when Dan applies the `revert-approved`
label to the PR (the check re-runs itself on labeling, and the guard files an
issue asking for it). If main is broken, prefer a forward fix; it needs no
label. Do not edit commit messages to route around the guard.

**3. NEVER SET A TIMER TO WATCH CI.** Playbook 7b is binding: push, open the
PR, report the PR number, END YOUR SESSION. Autopilot merges it, the publisher
ships it, the watchdogs verify it — all server-side. "I've set another brief
timer and will be back shortly" is the forbidden `wait_and_merge.sh` written
in prose; it burns tokens and adds nothing. Checking ONCE at the end to say
why something is BLOCKED is fine. Sitting in a loop is not.

**4. WORKTREES ARE DISPOSABLE.** `scripts/prune-stale-worktrees.sh` removes
any worktree that is clean, pushed, and idle for 72 hours. Do not keep state
you care about only in a worktree: commit and push it, or it will eventually
be pruned (pushed branches lose nothing — the commits live on origin).

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
number, end the session. Autopilot merges it and the watchdogs verify it, all
server-side, on infrastructure that does not care which account you were.

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
   it aborts if the board moved underneath you.
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
- **`gh` is not installed.** Open pull requests with `curl` against the REST
  API. The token is `GITHUB_TOKEN` in `~/Documents/club-arena/.env`.
- **Rebasing your branch onto main is refused by a ref-guard hook.** Use
  `git merge origin/main` instead. Section 12 still forbids rebasing `main`.

**The GitHub MCP (`mcp__github__*`) returns `Bad credentials` as of
2026-09-01.** Every call fails, including read-only ones. Do not debug it and
do not build a plan around it; use the host terminal. If you are reading this
long after that date, one call will tell you whether it is back.

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
- GitHub MCP via device bridge (`mcp__remote-devices__github__*`): full repo
  read/write with Dan's token. `push_files` works for files up to ~65KB each
  (HorseLogic.ts at 63KB pushed clean). Branch -> PR -> merge = ONE deploy.
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

### Pushing code (in order of preference)

1. Files < ~65KB: GitHub MCP `push_files` to a branch, then
   `create_pull_request` + `merge_pull_request`. One merge = one deploy.
2. Large files (e.g. ServerTableEngine.ts, 227KB): CHUNK them. Write base64
   chunks to Dan's disk via device_commit_files, reassemble with `device_bash`
   (cat chunks | base64 -d > file). Commit/push must then happen on the Mac
   HOST (VM git is broken, see traps): the Antigravity CLI on the host
   (`agy run "cd ~/Documents/club-arena && git add -A && git commit -m msg && git push"`)
   — agy is NOT in the VM PATH; it must be invoked through an
   Antigravity-reachable surface, not device_bash.
3. Last resort: write an executable `deploy.command` to Dan's Desktop with the
   exact commands so the handoff is one double-click, never copy-paste.

### Deploying + verifying the engine

- Push to `main` touching `server/**` auto-deploys Hetzner via
  `.github/workflows/auto-deploy-hetzner.yml`. No SSH needed. Docs-only
  pushes (CLAUDE.md, MIGRATION-CHANGELOG.md) do NOT trigger a deploy.
- VERIFY VIA SUPABASE, never the health endpoint: per-minute hand counts in
  `hand_history` show a restart dip right after the workflow finishes, and
  boot-time effects (fleet table creation/reactivation in `tables`, new
  variant tables seating horses) prove the new code is executing. Do NOT
  claim deployed until a DB-visible behavioral change confirms it.
- After deploy, mirror the exact pushed content back to Dan's working tree
  with device_commit_files so his next host-side `git pull` is clean.

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
   is the pattern; copy it.

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

`scripts/git-safe-push.sh` exports `CA_GIT_GUARD_ALLOW=1` and is unaffected: it
wraps its own rebase in an abort-and-force-push fallback.

### If a clone is already stranded

```bash
bash scripts/git-unstick.sh
```

Aborts any rebase/merge/cherry-pick, clears a stale `index.lock` (only when no
git process is running), saves local-only commits to a dated `backup/unstick-*`
branch, stashes uncommitted edits, and resets `main` to `origin/main`. **Nothing
is deleted** — the backup branch and the stash are both printed at the end.

### The rule

1. The Mac's `main` is a **mirror of origin**, not a place work originates.
   Ship through `scripts/git-safe-push.sh` or the GitHub MCP.
2. To sync it, **fetch + fast-forward** (or `git-unstick.sh`). Never rebase it.
3. Deliberate override, when you actually know why:
   `CA_GIT_GUARD_ALLOW=1 git pull --rebase origin main`.
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
   the :55 minute, cron ticks, freeze ceiling and windows across all five
   surfaces. If you deliberately change one, change them together with the
   law, in one commit.

Full history and rationale: `docs/changelog/2026-09-01-scheduled-maintenance-break.md`
and `docs/changelog/2026-09-01-total-platform-freeze.md`. Remaining backlog:
issue #2563.
