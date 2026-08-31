# ██ HEADS-UP PROGRAM — MASTER HANDOFF ██
## Phase 1 of 7 COMPLETE · Phase 2 of 7 IS YOUR NEXT ACTION

**Authored:** 2026-08-31, ~12:15 UTC
**By:** the Cowork/Claude session that ran the complete heads-up audit and built Phase 1
**Audience:** the next agent, starting cold, in a brand-new chat with zero context
**Production at handoff:** World Hub SHA `a23be86e`, Supabase `kuklfnapbkmacvwxktbh`, DB healthy

> **READ SECTIONS 1-4 BEFORE YOU TOUCH ANYTHING.** Section 3 (environment
> landmines) will save you hours; every item in it cost this session real time.
> Section 9 is the exact Phase 2 build spec. Do not improvise the order — Dan
> runs this program one phase at a time and wants a summary and a green light
> between each one.

---

# 1. MISSION, AND HOW WE GOT HERE

## 1.1 The chain of instructions that produced this program
1. Dan: *"do a full audit of the heads up games, every single one of them...
   from sitting down, buying in, waiting for 3 players, spin animation,
   tournament flow, blinds increase, payouts... verify it all doing a live E2E
   test... also check everything within the Create Table functionality."*
2. Then: *"fix any and all issues, fix or remove the dead create table code...
   you run this all yourself."*
3. Then: *"deep dive into the heads up game play... tell me everything that is
   left to do? how else can this be improved, enhanced or optimized still?"*
4. Then: *"what else is there to do besides this inside heads up?"* — this is
   the question that uncovered the SECOND heads-up product (section 2).
5. Then: *"is there anything else you want to add to the heads up todo list?"*
   — produced the VIP/rakeback/anti-cheat findings that became Phase 1.
6. Then: *"take every single thing you just said needed to be done and break
   this down into phases... fully build all of these and make sure they are
   fully wired in and tested before claiming success. you decide the build
   order."*
7. Then: *"start one phase at a time, give me a summary prompt when you're
   finished with each phase."*
8. Then: *"make sure everything from the previous phase(s) was 100% completed...
   check for any and all bugs, gaps, stubs, errors, regressions or wiring
   issues anywhere and everywhere and fix any issues before moving onto phase 2."*

**Standing rules that emerge from that chain, and that you inherit:**
- ONE phase at a time. Summarise. Ask. Wait. Then the next.
- "Fully wired in and tested before claiming success" — a merged PR is NOT
  success. Production behaviour is success.
- Dan expects the agent to run everything itself: credentials are on disk, and
  a handoff is only acceptable for something physically impossible from the
  sandbox (there is exactly one such item — section 8.1).

## 1.2 What this program is
Seven phases, ordered by *player impact and money at risk*, not by difficulty:

| Phase | Theme | Status |
|---|---|---|
| 1 | Money owed to players | **DONE, merged, verified live** |
| 2 | Fairness in the hand | **NEXT — spec in section 9** |
| 3 | Config guardrails (the `headsUpSpec.ts` that does not exist) | not started |
| 4 | Liveness (stalls, leaks, husk tournaments) | not started |
| 5 | Integrity + safety (chip dumping, disconnect protection) | not started |
| 6 | Presentation and UX (15 items) | not started |
| 7 | Product + performance (rematch, HU cash, HU stats, query load) | not started |

---

# 2. THE PRODUCT — THERE ARE **TWO** HEADS-UP PRODUCTS

This is the single most important fact in this document. The first audit pass
covered only the Spin, and Dan's question *"what else is there besides this"*
is what surfaced the second one. Do not repeat that mistake.

| | **Spin & Go** | **Heads-Up duel** |
|---|---|---|
| Shape | 3-max hyper; a wheel draws a multiplier at start | true 2-max SNG |
| DB selector | `tournament_type='SPIN'`, `variant='spin'`, `max_players=3` | `tournament_type='SNG'`, `variant='sng'`, `max_players=2` |
| Names in lobby | "5 Chip Spin NLH", "100 Chip Spin PLO6", 33 distinct | "NLH Heads-Up 10/20/25/50/100", "PLO4 Heads-Up ...", "Heads-Up Hyper Duel" |
| 7-day volume | **20,932** | **10,989** |
| 24h completed (at handoff) | 1,474 | 252 |
| Buy-ins | 1, 2, 3, 5, 10, 20, 50, 100 chips | 1, 2, 5, 10, 19, 23.75, 47.50, 95 (+5% fee) |
| Rake model | **no fee** — the edge is inside the multiplier table (flat 8%) | buy-in **+ 5% fee** on top |
| Payout | winner-take-all up to 5x; 80/12/8 (or 80/20) at 10x+ | winner-take-all, stored not inferred |
| Stacks | 300 / 1,000 / 5,000 by tier, written at DRAW time | 300 / others by board |
| Spec file | `src/config/spinSpec.ts` (+ byte-identical server copy) | **NONE — this is Phase 3's headline** |

**41,641 genuinely heads-up hands were dealt in the 24h before this handoff.**

## 2.1 THE CONTEXT THAT REFRAMES EVERY UX FINDING
In the 24 hours measured, **1,294 Spins ran and exactly ONE contained a
human.** The formats run almost entirely on horses. Consequences you must hold
onto:
- No UX defect below has ever been *felt* by a player. "Someone would have
  noticed" is never valid evidence here.
- Horse-vs-horse play MASKS seat-based unfairness (measured win rate by seat is
  49.94% / 50.06%), which is why the Phase 2 button bug is invisible in
  aggregate stats and still absolutely real.
- Any live UI verification requires a human session. **The browser pane could
  not be logged in during this entire session** (see 3.7) — so no eyes-on
  walkthrough has EVER been performed on these surfaces. Everything below is
  code-read + database-verified.

## 2.2 Live pace and health telemetry (measured, keep for comparison)
Healthy spins only (excluding stalls), 24h window:

| Starting stack | Games | Avg length | Avg hands | Avg level reached |
|---|---|---|---|---|
| 300 (2x-3x tiers) | 1,061 | **14.2 min** | 45.5 | 4.1 |
| 1,000 (4x-5x) | 162 | **21.8 min** | 64.8 | 6.7 |
| 5,000 (10x+) | 1 | 48.2 min | 63.0 | 15.0 |

Spin fill time: median **188 s**, p95 **74 min** (huge spread — Phase 6 item 14).
Duels: median length **11.5 min**, p95 32.7 min, avg 45.6 hands, 4 distinct
stacks, single payout shape `[{place:1,percentage:100}]`.

Multiplier distribution over 7 days (matches `spinSpec` exactly):
2x 48.19% · 3x 39.02% · 4x 9.23% · 5x 2.39% · 10x 1.09% · 25x 0.058% ·
50x 0.010% · 100x 0.010%.

---

# 3. YOUR ENVIRONMENT — THE LANDMINES, IN THE ORDER THEY WILL BITE YOU

## 3.1 Repos, mounts, and what lives where
- `~/Documents/club-arena` → GitHub `Smarter-Poker/Smarter-Poker-Club-Arena`
  - `src/` Vite+React client · `server/src/` the authoritative Node engine
    (deployed to Hetzner) · `supabase/migrations/` · `tests/` (vitest)
  - Sandbox path: `/sessions/<session-id>/mnt/club-arena`
- `~/Documents/Smarter-Poker-World-Hub` → `Smarter-Poker/Smarter-Poker-World-Hub`
  - Next.js Pages Router host for smarter.poker · `pages/api/cron/*` ·
    `scripts/openclaw-cron-dispatcher.py` · serves the built Club Arena bundle
    from `public/hub/club-arena/`
  - Sandbox path: `/sessions/<session-id>/mnt/Smarter-Poker-World-Hub`
- Supabase project ref `kuklfnapbkmacvwxktbh`. The Supabase MCP works and is
  the sanctioned path for `execute_sql` and `apply_migration`.
- Club Arena reaches production through the World Hub: a merge to CA `main`
  triggers `build-for-world-hub.yml`, which commits a
  `chore(club-arena): sync build <sha>` into the World Hub, which triggers
  Vercel. **A CA merge is therefore ~2 deploys away from being visible.**

## 3.2 Credentials — WHERE, never the values
| What | Where | Notes |
|---|---|---|
| GitHub token that WORKS | `GITHUB_TOKEN` in `club-arena/.env` | verified `api.github.com/user` → `Smarter-Poker` |
| GitHub MCP servers | **DEAD** | both `mcp__github__*` and the plugin one return `Authentication Failed: Bad credentials`. Do not retry them; use REST/GraphQL from bash |
| `CRON_SECRET` production accepts | `World-Hub/.env.vercel.prod.local` | several other `.env*` files hold STALE secrets; only this one returned 200 |
| Supabase service role + URL | `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL` in `club-arena/.env` | needed by `scripts/ci/gen-schema-manifest.mjs` |
| Test player account | `daniel@bekavactrading.com`, password in `World-Hub/.env.local` as `TEST_USER_PASSWORD` | agents must NOT type passwords into a browser |
| SSH key for the Hetzner dispatcher VM | **DOES NOT EXIST in the sandbox** | `~/.ssh` is absent; `deploy-openclaw.sh` needs `~/.ssh/openclaw_ed25519` on the Mac |

## 3.3 How to actually ship (this exact recipe worked ~12 times today)
Both repos protect `main` with a ruleset: no direct pushes, squash-only,
required status checks, `bypass_actors: []` (an admin cannot merge around it).

```python
# 1 blob -> 2 tree -> 3 commit -> 4 branch -> 5 PR -> 6 auto-merge -> 7 verify
# Author/committer MUST be exactly this or Vercel refuses to build the commit:
author = {'name':'Smarter-Poker',
          'email':'254329056+Smarter-Poker@users.noreply.github.com'}
# POST /repos/{o}/{r}/git/blobs   {'content': <text>, 'encoding':'utf-8'}
# POST /repos/{o}/{r}/git/trees   {'base_tree': <sha>, 'tree':[{path,mode:'100644',type:'blob',sha}]}
# POST /repos/{o}/{r}/git/commits {'message':..., 'tree':..., 'parents':[main], 'author':a,'committer':a}
# POST /repos/{o}/{r}/git/refs    {'ref':'refs/heads/<branch>','sha':<commit>}
# POST /repos/{o}/{r}/pulls       {'title','head','base':'main','body'}
# GraphQL enablePullRequestAutoMerge(input:{pullRequestId:$id, mergeMethod:SQUASH})
# then poll GET /pulls/<n> until merged==true
```
`scripts/git-safe-push.sh` is the documented house path but requires the Mac
host; from the sandbox the API flow above is what works. **Never** force-push,
never rebase `main` (there is a `pre-rebase` hook forbidding it, and an
incident behind it).

## 3.4 LANDMINE — the local worktree is wiped without warning
An Antigravity loop on Dan's Mac periodically runs `git reset --hard
origin/main`. **It destroyed my in-progress edits twice during this session.**
- Symptom: files you just wrote are simply gone; `git status` looks clean.
- Rule: commit/push within minutes of writing. Never hold work locally.
- Recovery: fetch your file back from the PR branch
  (`GET /contents/<path>?ref=<branch>`) — that is how I recovered both times.

## 3.5 LANDMINE — GitHub secondary rate limits
Rapid blob creation begins returning `403 API rate limit exceeded` **while
`/rate_limit` still shows 5000/5000** (it is the content-creation bucket, not
the core quota). Blocked me for ~20 minutes mid-Phase-1. Back off 3-5 minutes
between pushes; do not thrash; batch files into ONE tree per commit.

## 3.6 LANDMINE — sandbox disk and DB timeouts
- `/sessions` reaches 100% and `vitest` dies with `ENOSPC`. Fix:
  `TMPDIR=/tmp npx vitest run ...`; `rm -rf ~/.npm/_cacache`.
- Supabase statement timeouts on wide aggregates. Narrow the window or LIMIT.
  Concretely: `fn_detect_double_dealing(20160)` times out; `(60)` and `(120)`
  return instantly — that fact IS a Phase 1 bug fix (section 7.4).
- **PostgREST silently caps a select at 1000 rows.** This produced a WRONG
  MONEY NUMBER in a cron I wrote (reported 1,000 pending rakeback periods /
  113,122.34 chips instead of the true 2,456 / 278,579.42). Always page with
  `.range()` when a count or a sum matters.

## 3.7 LANDMINE — you cannot see the product
- `https://engine.smarter.poker/health` is NOT reachable from the sandbox — the
  proxy answers `{"error":"Not Found"}` with HTTP **200**, which will fool a
  naive check. Verify engine deploys through Supabase behaviour instead
  (per-minute hand counts, fleet table creation).
- The Claude browser pane's smarter.poker session is expired. Agents must not
  type passwords. Dan was asked twice to sign in and did not, so **no live UI
  walkthrough has ever been done on any of these surfaces**. If you need one,
  ask him to sign in to the pane and say so plainly.
- Claude-in-Chrome was offline this session (extension not connected).

## 3.8 CI gates that will fail your PR (know them before you write)
**club-arena**
- `check-definer-authorization.mjs` — any `SECURITY DEFINER` function that
  WRITES and is executable by a browser role must either revoke EXECUTE or
  consult `auth.uid()/auth.role()/auth.jwt()`. **It reads the migration file
  that DECLARES the function**, so the guard must be in THAT file, not only in
  a later one. This gate caught a genuine hole I introduced (section 7.3).
- `check-migrations-applied.mjs` — a repo migration declaring an object that is
  missing from `scripts/ci/supabase-schema-manifest.json` fails the build.
  Regenerate with `node scripts/ci/gen-schema-manifest.mjs` (needs
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` exported) **in the same PR**.
- Required checks on `main`: TypeScript Check · Client Unit Tests (vitest) ·
  Server Engine (typecheck + tests) · Production Build · CSS Beat E2E ·
  Silent Revert Guard.
- House bans: emoji in source, `.single()` (use `.maybeSingle()`), red tests.
**World Hub**
- `pages/api/cron/` file count cap **45** (currently **32** — you have room).
- **Never add entries to `vercel.json` crons** (CI CHECK 6 fails). New
  schedules go to Open Claw.
- CHECK 15: commit author must resolve to a GitHub user or Vercel BLOCKS the
  deployment with no build logs at all.

## 3.9 Useful, non-obvious facts about the platform
- `tables.game_type` is the **format** (`'cash'|'tournament'`), NOT the
  variant. There is now a CHECK constraint enforcing it (I added it).
- `fn_caller_is_engine()` = `COALESCE(auth.role(),'service_role')='service_role'`
  — true for the engine, for pg_cron, for psql, for a migration; false for any
  browser role. It is the house pattern for "server-only".
- Idempotency keys are the platform's anti-double-pay mechanism, e.g.
  `tourney:{id}:prize:place:{position}` — **place-scoped, not user-scoped**
  (there is a 120%-of-pool incident behind that).
- `public.wallets` is DEAD (732,591,994.33 chips frozen since 2026-08-21).
  The live chip pool is `club_members.chip_balance`. If you find a money path
  writing to `wallets`, that path is broken.
- HORSES ARE PLAYERS is binding law (CLAUDE.md 10.5). Never write an
  `is_horse` filter that denies a horse something a human would get.
- Animation Law + no-auto-table-switching are binding (CLAUDE.md 10.6) and
  pinned by `tests/animations-always-play.law.test.ts` and
  `tests/no-auto-table-switch.law.test.ts`. Never weaken a pin.

---

# 4. COMPLETE LEDGER OF WORK ALREADY SHIPPED

Everything in this section is **merged and live**. Do not redo any of it.
Verify with section 11 if you doubt it.

## 4.1 Pre-phase: the 2026-08-30 spin + create-table audit
**PRs: CA #2011, WH #1051. Migrations: `20260830_spin_flat_rake_sweep_seats_and_table_game_type_law.sql`, `20260831_table_creation_guard_replaces_dead_create_table_api.sql`.**

| # | What was wrong | Fix shipped |
|---|---|---|
| 1 | **`fn_spin_rake_rate` was still banded 8/7/6/5%** by buy-in while the engine books a flat 8% (Dan retired the bands 2026-08-27). The *recovery sweep* and the *engine* therefore booked different rake and different reserve deposits for the same spin. | Flattened to a single `SELECT 0.08` |
| 2 | `fn_spin_sweep_unbooked` settled on `count(tournament_players)` while the engine forces `SPIN_SEATS = 3` | Sweep now settles at 3 |
| 3 | **`tables.game_type` carried the VARIANT** (`'NLH'`,`'PLO6'`) from `TableConfigPage`, but the platform-wide contract is the FORMAT (`'cash'`). The sit-out and zero-chip eviction sweeps gate on `game_type='cash'`, so **owner-created tables never evicted anyone** and their zombie seats held an engine forever | Writer fixed to `'cash'`; 3 live rows backfilled; `CHECK (game_type IN ('cash','tournament'))` added |
| 4 | `SPIN_BLIND_STRUCTURE` was a hand-typed 15-level, 2-minute ladder that diverged from `spinSpec.SPIN_BLINDS` (10 levels, 3-minute) from level 5 up. The engine rewrites blinds from spinSpec at start, so **play was right but the pre-start Blinds tab showed a ladder that would never be played** | Derived from `SPIN_BLINDS`; the pinning test in `tests/unit/TournamentService.test.ts` updated in the same commit |
| 5 | `HorseOrchestrator.launchSpin` — no production caller, registered horses via `registerPlayer` instead of selling seats, then **overwrote `current_players`** (the documented "0/3 with paid seats" incident shape) | Retired; refuses loudly. Test pin moved from "creates safely" to "does not create at all" |
| 6 | **World Hub `pages/api/club-arena/create-table.js` was DEAD CODE** — zero callers. Every table an owner creates comes from a direct client insert, so the route's rate limiting, role checks, stakes validation and rake/BBJ auto-fill **never ran**, and its `VALID_VARIANTS` was missing `flo8` | Route DELETED + its RateLimiter entry; validation ported into the DB as `fn_tables_creation_guard` (BEFORE INSERT on `tables`): cash seat law (plo6 6 / plo5 7 / plo4,plo8,flo8 8 / else 9), positive+ordered blinds, `min_buy_in <= max_buy_in`, action time 10-120, name trim/60/angle-bracket strip. Probed live: refuses 10-max PLO6 and inverted blinds, accepts legal 6-max PLO6, leaves no probe rows |
| 7 | Client action-time slider allowed 5s against an engine floor of 10s | Floor raised to 10 in both slider instances |
| 8 | Emoji in a create-table notification title (house rule 7) | Removed with the route |

**Also proven during that audit (2,698 completed spins over 48h):** every
winner paid exactly `buy_in × multiplier` via `fn_credit_and_log`; 0 unpaid;
0 wrong amounts; multi-row payouts only on 10x+ premium splits by design;
reserve pool solvent (`can_draw_100x = true`); 0 unpaid settlements; 0
draw-booking gaps since 2026-08-25; all 41 historical shortfall backpays paid.

## 4.2 PHASE 1 — "Money owed to players" (COMPLETE)
**PRs: WH #1083, #1084, #1090, #1094 · CA #2117 · Migrations `20260831a`, `20260831b`, `20260831c`.**

### 4.2.1 The headline bug: 55% of games earned no loyalty at all
Both VIP award sites converted a player's rake share to points with `floor()`:
- `fn_award_vip_points_from_rake` (trigger on `rake_records`)
- `fn_attribute_tournament_rake` (tournament settlement)

So **any game where a player's share of the rake was under 1 chip awarded ZERO
points and wrote no ledger row** — while the rake was still taken. Measured on
production across 48h, by buy-in:

| Buy-in | HU duels | Spins | VIP points awarded |
|---|---|---|---|
| 1 / 2 / 5 / 10 chips | 610 | 1,870 | **0** |
| 19 / 23.75 / 47.50 / 95 chips | 610 | 1,176 | 2 - 24 |

That is ~55% of all games on both flagship formats, at exactly the stakes a new
player starts on: they grind the low boards, pay rake every game, and their VIP
bar never moves.

**The fix (live):** a per-user CARRY.
- `20260831a` — `vip_points_carry(user_id PK, carry numeric(14,4) CHECK 0<=carry<1, updated_at)`
  with RLS (`read own`), plus `vip_points_ledger.credit numeric(14,4)` so the
  exact credit behind every award is auditable.
  *Split from step B deliberately*: the ALTER takes an AccessExclusiveLock and
  `vip_points_ledger` is written ~23k times/day — the combined migration
  **deadlocked against live traffic** on the first attempt.
- `20260831b` — `fn_award_vip_credit(user, credit, source_type, source_id, reason)`:
  banks the fraction, awards the whole part, and is **idempotent** because it
  inserts the ledger row FIRST with 0 points, `ON CONFLICT DO NOTHING` against
  the existing unique `(user_id, source_type, source_id)`, and only moves the
  carry if that insert won. Both award sites rewired to call it.
  In-migration assertions proved: 0.50 banks → 0 pts; +0.50 → 1 pt; +0.25 →
  banks; replay of source 1 → 0 pts (no double credit); carry lands at exactly
  0.25; every probe row unwound.
- **Side effect accepted on purpose:** ~13.5k zero-point ledger rows/day are
  now written where none were before. They are the audit record of a credit
  banked rather than paid, and **no player-facing surface lists ledger rows**
  (checked: only an admin economy-stats page counts them).

### 4.2.2 The security hole I introduced, and CI caught
`fn_award_vip_credit` is `SECURITY DEFINER`, writes to three tables, and
EXECUTE was left on the default grant — **any authenticated browser session
could have called it through PostgREST and minted itself VIP points with a
`source_id` of its own choosing.** The `floor()` version it replaced was a
trigger body with no callable entry point, so the exposure arrived *with the
fix*. `check-definer-authorization` failed the PR and was right.

`20260831c` closes it two ways (either alone is one mistake from open):
1. `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role`
2. the body refuses anyone but `fn_caller_is_engine()`

The guard was ALSO carried back into `20260831b` so a clean replay is never the
exposed version. Verified after apply: both browser roles cannot execute; the
engine path kept awarding normally (54 rows in the next 4 minutes).

### 4.2.3 Two crons that had never existed
Open Claw had been firing `/api/cron/rakeback-period-settle` and
`/api/cron/player-stats-refresh` **on schedule, for weeks, at handlers that do
not exist** — they were written for `smarter-poker-workers`, a repo Phase 2B
has never created. Every fire hit a 404, and **a 404 looks exactly like a
healthy job** to a scheduler.

Cost, measured: 2,456 pending rakeback periods, **281,108.01 chips owed to 589
players**, oldest period ended 2026-07-20, nothing settled since 2026-08-23;
plus stale `player_stats` feeding leaderboards, the leak finder and the
nit/VPIP eviction rules.

- **`rakeback-period-settle.js`** — pages the pending set (see the 1000-row
  trap), calls `settle_club_rakeback(club_id)` per club so one club's refusal
  cannot abort the rest, returns `partial`+500 when any club refuses, and
  supports **`?dry=1`** so the first production run of a job that moves a
  quarter-million chips moves nothing. It deliberately does NOT call
  `fn_run_pending_rakeback_settlement`, which gates on `auth.uid()` being an
  admin — a service-role cron has no `auth.uid()`.
- **`player-stats-refresh.js`** — calls `fn_refresh_player_stats(p_since)`
  (idempotent: `hands_played` takes `GREATEST`). 26-hour window on an hourly
  cadence so a full day of missed ticks self-heals. Live run: **504 users,
  44,298 hands**.
- **`WORKERS_PREFERRED` fix**: the dispatcher was routing both to
  `WORKERS_BASE_URL` (the never-built VM). Removed both entries. *Requires
  `deploy-openclaw.sh` from the Mac to reach the VM.*

### 4.2.4 A regression found during the completion sweep
`spin-sweep` had been returning **500 on every single run**. Root cause: its
double-dealing forensic scan passed the sweep's own **14-day** `LOOKBACK_MINS`
to `fn_detect_double_dealing`, which self-joins `hand_history` on overlapping
play windows — millions of rows, statement timeout every time, caught, and
filed as a bare `double_deal_check_failed`. **The platform's only forensic
check for two engines dealing one table had been reporting nothing but its own
failure.** Fixed with a dedicated `DOUBLE_DEAL_LOOKBACK_MINS = 120` (eight
overlapping passes at the 15-min cadence) and the alert now names the error
code instead of a bare flag. Production alerts went **3 → 1**.

### 4.2.5 Two house-rule gaps closed in the same sweep
- Migrations `20260831a/b` had been applied to production but **never
  committed** (RULE 2 requires apply AND commit). Now committed, with all three
  schema manifests regenerated so the migration gate sees `fn_award_vip_credit`
  and `vip_points_carry`.
- The dispatcher change + a full runbook handoff were committed
  (`World-Hub/.agent/handoffs/2026-08-31-openclaw-secret-and-dispatcher-deploy.md`).

### 4.2.6 Phase 1 verification, taken from production at handoff
```
browser roles can execute fn_award_vip_credit ....... false  (locked out)
vip ledger rows, last 60 min ........................ 884
of those, sub-1 credits BANKED ...................... 299
players now carrying a fractional balance ........... 450
chips of credit banked instead of destroyed ......... 199.92
carry rows violating 0 <= carry < 1 ................. 0
probe rows left behind .............................. 0
player-stats-refresh (live call) .................... 200, 504 users / 44,298 hands
rakeback-period-settle?dry=1 ........................ 200, 2,456 periods / 278,579.42 owed
spin-sweep alerts ................................... 3 -> 1 (double_deal_check_failed gone)
fn_detect_double_dealing(120) ....................... returns 0 rows, instant
table creation guard trigger ........................ present
fn_spin_rake_rate(1) = fn_spin_rake_rate(100) ....... 0.08
GET /api/club-arena/create-table .................... 404 (dead route gone)
```

## 4.3 Every PR this program has merged
| Repo | PR | Title |
|---|---|---|
| CA | #2011 | 2026-08-30 heads-up/spin audit fixes |
| CA | #2117 | Phase 1 record: commit the applied VIP migrations + refresh manifests |
| CA | #2160 | Handoff doc (this program) |
| WH | #1051 | Remove dead club-arena create-table API route |
| WH | #1083 | Phase 1: restore the two dead money/stats crons |
| WH | #1084 | Phase 1 fix: page the rakeback pending read (PostgREST 1000-row cap) |
| WH | #1090 | Fix: double-dealing forensic scan timing out every run |
| WH | #1094 | Fix: route the two rebuilt crons to Vercel, not the workers VM |

## 4.4 Every migration this program applied (all live)
`20260830_spin_flat_rake_sweep_seats_and_table_game_type_law` ·
`20260831_table_creation_guard_replaces_dead_create_table_api` ·
`20260831a_vip_carry_table_and_ledger_credit_column` ·
`20260831b_vip_points_fractional_accrual` ·
`20260831c_vip_award_credit_is_engine_only`

---

# 5. BLOCKED ON DAN — NOT ON YOU (do not burn time trying to route around these)

## 5.1 The entire Open Claw fleet is 401ing (HIGH, live since ~09:00 UTC)
The Hetzner dispatcher VM's `CRON_SECRET` no longer matches production, so
**every Open-Claw-scheduled job is failing authentication.** A prior agent
diagnosed it at 09:05
(`World-Hub/.agent/handoffs/2026-08-31-cron-secret-mismatch-openclaw-401.md`);
I re-confirmed it **independently at 11:15 UTC by a method that needs no VM
access**: in that single minute every **Vercel-native** cron ran
(`recovery-probe`, `login-probe`, `sentry-signup-bridge`, `marketplace-health`,
`trivia-tournament-tick` — all present in `vercel.json`) and every
**Open-Claw-only** cron did not (`push-dispatch`, `waitlist-sweep`,
`spin-sweep`, and both Phase 1 jobs). The split falls exactly along "who
authenticates the request".

**Blast radius:** ~85 jobs, including all push notifications, waitlist
advancement, spin pool health, bounty/BBJ detection, and every automated
integrity check.

**Fix (human, one trip):**
```bash
ssh root@178.104.160.250
#  set CRON_SECRET in /etc/openclaw.env to the value in
#  ~/Documents/Smarter-Poker-World-Hub/.env.vercel.prod.local
systemctl restart openclaw
journalctl -u openclaw -n 50 --no-pager    # expect 200s
cd ~/Documents/Smarter-Poker-World-Hub && git pull && bash scripts/deploy-openclaw.sh
```
Do BOTH in one trip: the secret alone leaves the two Phase 1 jobs pointed at a
dead VM; the deploy alone leaves them 401ing. **No sandbox agent has an SSH
key — `~/.ssh` does not exist here. This is the only genuinely human-only item
in the entire program.**

## 5.2 The rakeback payout — 278,579.42 chips to 589 players
Endpoint built and dry-run verified; firing it moves real money, which is Dan's
decision, not an agent's:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://smarter.poker/api/cron/rakeback-period-settle?dry=1"   # report only
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://smarter.poker/api/cron/rakeback-period-settle"          # pays
```
It will also fire automatically Mondays 10:30 UTC once 5.1 is fixed.

## 5.3 VIP back-pay for what `floor()` destroyed — NOT YET COMPUTED
The carry fixes the future, not the past. The historical loss is computable
(sum the sub-1 credits that were dropped, per user, from `rake_records` +
`tournaments`), but **minting points is a financial decision**. Offer Dan the
number; do not mint unilaterally. Sketch of the query: replay
`fn_allocate_rake_credits` over `rake_records` in the affected window and
subtract what `vip_points_ledger` actually granted.

## 5.4 Four product rulings only Dan can make
1. **Spin pace.** Median 14.2 min / 45.5 hands on a 15bb 3-max "hyper". Options:
   2-minute levels, a steeper ladder, or a shallower start. He has not ruled.
2. **Heads-up horse thinking speed.** Horses think 15% faster heads-up, one
   shared cadence across the fleet — defensible, but it is the exact spot a
   human watches 50 consecutive decisions. Keep or randomise per horse?
3. **Stakes schedule + rake/BBJ tier auto-fill** (carried by the deleted
   create-table route). Live tables already sit outside those rules, so a guard
   would start refusing legitimate tables. Needs a ruling before enforcement.
4. **Human liquidity.** 1 human spin in 24h. Does he want a canary human
   account playing so these surfaces are exercised at all?

## 5.5 Already ruled — DO NOT re-open
- `sp_prune_hand_history` keeps horse-only hands 7 days, human hands forever.
  Dan ruled 2026-08-27 that this **stays**. It is a storage decision, it is a
  config row, and it is the one sanctioned asymmetry in the HORSES ARE PLAYERS
  law. Do not "fix" it.
- The 5-second rebuy pause applies to horses too ("timing is part of the
  treatment"). No "equal outcome by a different mechanism" arguments.
- `HeadsUpOverlay` is deliberately suppressed for Spins (a Spin is 3-handed
  from the first card, so the third bust is the last hand, not a milestone).
  Keep the suppression; Phase 6 item 11 replaces it with a non-blocking pill.

---

# 6. THE REMAINING PHASES — FULL SPECIFICATIONS

Line numbers are from the audit reads on 2026-08-31; re-grep before editing, as
files move. Everything below is *evidence-backed*, not speculation.

## PHASE 2 — FAIRNESS IN THE HAND  ← **YOUR NEXT BUILD**

### 2.1 The heads-up first button is never randomised (fairness, money)
- **Where:** `server/src/tournament/TournamentManagerBase.ts` ~:2914 holds a
  secure-random first-button draw — **inside the Spin reveal path only**.
- **What happens instead:** a 2-max SNG never reaches that code and falls back
  to `buttonSeats[0]`, the lowest occupied seat. The seat-first opener always
  puts the horse in the lowest free seat, so seat 1 is effectively always the
  horse's, and the button is effectively always assigned the same way.
- **Why it matters:** heads-up, the button IS the small blind — acts first
  preflop, last postflop. It is the single largest positional edge in poker,
  and duels are frequently decided in a handful of hands.
- **Why stats look fine:** measured win rate by seat is 49.94% / 50.06%,
  because horse-vs-horse play cancels it out. A human sits in seat 2.
- **Fix:** call the same secure draw for EVERY 2-handed start (duel and spin
  heads-up alike). Persist the drawn button so a restart cannot re-draw it.
- **Test:** a new spec asserting the first button is not deterministic across
  N simulated starts, plus the persistence-across-restart case.

### 2.2 The 3→2 dead button — one player posts the big blind twice
- **Where:** `server/src/engine/ServerTableEngineDealing.ts` ~:1313-1336.
- **What happens:** when the **button** busts in a 3-handed spin, the BB stays
  the BB. TDA Rule 33's dead-button adjustment is not implemented, and the
  "button must move" correction is explicitly disabled at 2 players.
- **Impact:** roughly 1 in 3 spins that reach heads-up; a full big blind of EV
  taken from one player and handed to the other. This is exactly the kind of
  thing a grinder notices and a horse never reports.
- **Fix:** implement the dead-button rule for the 3→2 transition; the button
  moves, a dead button is allowed, and no player posts the same blind twice
  consecutively.
- **Test:** table-driven spec over which of the three seats busts, asserting
  the blind sequence for the two survivors.

### 2.3 `resume()` reads the blind level by array index
- **Where:** `server/src/tournament/TournamentManagerBase.ts` ~:2315.
- **What happens:** it indexes the blind array directly instead of calling
  `resolveBlindLevel()` — the one caller that ignores that function's own
  warning comment. After an engine restart, a late-stage game resumes on the
  wrong clock and blinds jump.
- **Fix:** route through `resolveBlindLevel()`. One-line class of change, but
  add a regression spec since restarts are frequent (auto-deploy on `server/**`).

**Phase 2 exit criteria:** all three fixed; new specs green; `npx tsc --noEmit`
clean; server tests green; shipped via PR; and — because CA merges take two
hops to production — confirm the World Hub received a
`chore(club-arena): sync build <sha>` containing your commit, then verify a
DB-visible behaviour change (e.g. observed button-seat distribution across new
duels is no longer constant).

## PHASE 3 — CONFIG GUARDRAILS

### 3.1 Create `src/config/headsUpSpec.ts` (+ byte-identical server copy)
The 2-max product has **no spec file**. Its truth is scattered across
`SNG_BOARD_SHAPES`, `BLIND_STRUCTURES.HEADS_UP_3MIN`, two `SCHEDULE_*_PRESETS`
maps, and a JSON blob inside a migration. Almost every Phase 3 and Phase 4 bug
is a symptom of that absence. Mirror the Spin pattern exactly: one file, seats,
stacks, blinds, rake, timings, payouts; a server copy; and a test asserting the
two copies are byte-identical (`tests/config/spinSpec.test.ts` is the model).

### 3.2 The 5% heads-up rake is a convention, not a rule
- DB cap is a flat **10%** (`supabase/migrations/20260821_tournament_rake_cap.sql` ~:42).
- Two live paths hardcode `0.1`: the restart-clone fee re-cut and
  `clampRakeToCap`'s default.
- History proves it bites: through 25 Aug, **1,869 duels were charged 10%, 464
  at 8%, 9 at 6.67%**; everything since 26 Aug is 5%. So this is a **latent
  regression with no guard**, not an active overcharge.
- Fix: a DB CHECK pinning `max_players <= 2` to 5%, and kill both hardcoded
  paths. The Spin fee already has a constraint protecting it; heads-up does not.

### 3.3 The Duel's blind ladder is 5 levels then doubles every 2 minutes
`ScheduledTournamentService.ts` ~:344 inherits an MTT hyper-turbo preset while
the rest of the codebase assumes 10-12 levels. Level 6 is 1600/3200 against a
5,000 stack. It is also the only heads-up game that violates the house rule
that speed stays constant and only the stack changes.

### 3.4 Dead constants and write-only columns
- `BLIND_STRUCTURES.SPIN` still exists and contradicts `spinSpec` — delete it
  before it misleads the next person "fixing the spin blinds".
- `is_premium_spin` is written (`TournamentManagerBase.ts` ~:1718, and a repair
  migration) and **read by nobody**; premium payouts actually come from
  `spinTier().payouts`. Remove or wire.
- `SPIN_FREQ_DENOMINATOR` totals 10,000,099 while the comment says
  10,000,000 — displayed "1 in N" odds are off by ~1e-5. Cosmetic; decide.

### 3.5 The lobby's "seat-first" definition disagrees with the server's
SQL and the server say `variant='spin' OR max_players<=2`; the client's
`classifyTournament` (`src/components/lobby/lobbyEntries.ts` ~:1419) treats ANY
SNG as seat-first, so a 6-max or 9-max SNG renders a Sit Down affordance the
server will not honour.

### 3.6 Row/doc/engine conflict on synchronized breaks
The Duel seed writes `synchronized_breaks = true`, the docs say heads-up takes
the :55 break, and the engine correctly refuses it. The engine is right; the
row and the docs are drift.

## PHASE 4 — LIVENESS

### 4.1 There is no "RUNNING but not dealing" watchdog  ← the big one
- **Measured:** 141 of 20,900 Spins over 7 days (0.67%) ran longer than an
  hour; **120 of those had fewer than 30 hands**; average **22 minutes** of
  dead table after the last hand; worst case **11 hours, 13 hands, blind level
  158**.
- **Evidence row:** tournament `0dc034bc-5b71-4ef8-92a0-612a26a6d452` — last
  hand 09:20, still `RUNNING` at 20:33, two horses seated with real stacks
  (720.00 and 300.00), neither sitting out, `left_at` only stamped at the very
  end.
- **Why nothing caught it:** the 180-second zombie reaper rebuilds the engine
  but never asks whether hands actually resumed; the four existing stall
  watchdogs all cover other shapes.
- **Fix:** a watchdog keyed on "status RUNNING and `max(hand_history.created_at)`
  older than N minutes" → force a hand, or finish and settle the tournament
  through the normal path. It must count horses as players (law 10.5).

### 4.2 Stuck-COMPLETING recovery has no age threshold
`server/src/GameServer.ts` ~:2929-2938 — the 5-minute rule exists **only in
the comment**. Safe on a single instance; under `ShardManager` a second
instance would begin paying a tournament the first is mid-finish, and only the
place-scoped idempotency keys stand between that and a double-paid winner.

### 4.3 `tournamentOwnedTables` never has entries removed
`server/src/GameServer.ts` ~:169 — ~7,000 UUIDs/day leaked, and hub rooms for
dead spin tables are never dropped.

### 4.4 The scheduled "Heads-Up Hyper Duel" is born broken every cycle
`ScheduledTournamentService` writes the tournament row but **never inserts a
`tables` row** (there is no `from('tables')` call in the file). Every instance
is a husk — REGISTERING, unjoinable, self-wedging — until the *other* service's
repair pass rescues it, which then overwrites the advertised start time and
injects a horse the schedule explicitly asked zero of. Net effect: a human gets
roughly **1-3 minutes of joinability per ~35-minute cycle** on a game the lobby
advertises as available.

## PHASE 5 — INTEGRITY AND SAFETY

### 5.1 Chip-dump detection is dead, and heads-up is what it exists for
- Last `CHIP_DUMP` scan **14 Aug**; last win-rate scan **18 Aug**;
  `anti_cheat_events` has **0 rows in 7 days**.
- The handlers `/api/cron/anti-cheat-{chip-dump,bot-timing,multi-account}` and
  `/api/cron/collusion-scan` **return 404 in production** — same never-built
  workers repo as the Phase 1 crons.
- Worse: **there is no SQL function that WRITES chip-dump flags.**
  `detect_collusion_pairs` only READS `collusion_tracking`, and requires a
  browser admin (`auth.uid()`), so a cron cannot even call it as written. The
  detector itself has to be built.
- A 2-max game where both seats are the same person is the easiest way to move
  chips between accounts, and it has the least coverage on the platform.

### 5.2 The scoring is calibrated to noise
Of 169,523 flags ever raised, **169,505 were auto-cleared at an average
suspicion score of 96.8**. "Almost certainly collusion" is the normal case, so
the signal is worthless. Recalibrate before adding volume.

### 5.3 No re-entry or cooldown limits on duels
Lose, re-enter the same board immediately, repeat. No cooldown, no daily cap,
no same-opponent limit. Combined with 5.1 that is precisely the shape a dumping
pair would use.

### 5.4 No heads-up disconnect protection and no time bank
Zero heads-up branches anywhere in the disconnect or time-bank engines. A
tournament sit-out is dealt in, posts blinds and is auto-folded by design; at
2 players with 2-minute levels a 30-second signal drop is a lost buy-in, with
no all-in protection, no pause, and no notice to either player.

### 5.5 Related: sit-out auto-folds fire at 0 ms
Every other action has a deliberate beat (horses 350-1250 ms, pre-actions
900 ms, settle 650 ms). Against a disconnected opponent heads-up, hands resolve
at machine speed — a pacing tell in the opposite direction from the usual one.

### 5.6 Insurance / Run-It-Twice are not gated at 2 players
They simply work, which is fine for cash but means a heads-up tournament could
in principle offer insurance on an all-in. Decide deliberately rather than
discover later.

## PHASE 6 — PRESENTATION AND UX (15 items, none ever seen by a human)

| # | Item | Evidence | Player-visible effect |
|---|---|---|---|
| 1 | **Every Spin card says "300 chips / Turbo"** | recycler seeds `starting_chips: 300` (`TournamentRecurringService.ts` ~:1401, :3432); real stack written at draw time (`TournamentManagerBase.ts` ~:1661, :1712); card reads the raw column (`arenaGameCardAdapter.ts` ~:69/91/98, `lobbyEntries.ts` ~:1249-1279) | 12.6% of games actually deal 1,000 or 5,000. A 100x is 5,000 chips at 250bb — the OPPOSITE of Turbo. Seated players watch the stack jump 300→5,000 with no explanation. Fix: show the range from `SPIN_TIERS` pre-draw ("Stack 300-5,000, set by the wheel") |
| 2 | **The 100x celebration is 2/3 invisible** | `SpinWheel.css` ~:608 spreads confetti with a magic `4.16%` tuned for 24 pieces; tiers now use 16/32/48/72 | any piece with index ≥24 lands off-screen and is clipped, so 50x and 100x render **identically to a 25x**. Also `animation-delay` at index 71 is 3.9 s against a 4.8 s hold. Fix: pass the count as a CSS var and cap the delay |
| 3 | **Tile view: one table's wheel blanks all four** | `MultiTablePage.tsx` ~:3559-3600; `SpinWheel.css` ~:17-25 (`position:fixed; z-index:99997; pointer-events:auto`, no `isActive` gate) | a Spin firing on tile 3 blocks tiles 1, 2 and 4 for the full ~15 s hold — you can be timed out on another table behind a wheel you are not watching |
| 4 | **Reduced motion → 14 s of dead felt** | `SpinWheel.tsx` ~:485/:514/:594 total ≈2.4 s; the engine's deal hold is ≈16.6 s and does not shrink | wheel unmounts, then an empty table with 0-chip seats and nothing explaining the wait. Fix: hold the result card or show "Dealing in N…" |
| 5 | **Late reconnect = 4-frame flash, then never again** | `SpinWheel.tsx` ~:448-452 (`at(offset)=max(0, offset-elapsed)` → every phase resolves to 0) and `markSpinRevealPlayed` is stamped | the defining moment of the format is spent on a flicker and then suppressed for that tab. Fix: if remaining < flash threshold, mount straight into `phase='result'` |
| 6 | **Animation-speed preference ignored by the wheel** | `SpinWheel.tsx` ~:425-441 — `getAnimationSpeed()` is consulted only on the no-shared-clock branch, which never happens in production | the code's own comment promises the opposite. Fix: `Math.min(factor, getAnimationSpeed(), 1)` |
| 7 | **Fallback wheel animates off a different column** | `TablePage.tsx` ~:1113-1132 uses `tournaments.started_at`; the socket path uses `d.reveal_at`/`d.hold_until` (~:12116) | a fallback client can be out of step with the two seats that got the broadcast — the exact "three players, three wheels" failure the shared clock exists to prevent — and its `hold_until` clamp is disabled |
| 8 | **"Play Again" can land you on a full table** | `TournamentRankingHost.tsx` ~:191-208 filters on status/club/stake/game but **not capacity**; every other surface uses `seatFirstJoinable` (`lobbyEntries.ts` ~:1200) | Spins fill in seconds → "That Seat Was Just Taken". Its fallback URL `/tournaments?type=spin` (~:161) carries a filter `TournamentPage` never reads |
| 9 | **After the wheel, nothing says what the prize is** | `TablePage.tsx` ~:19152-19165 (badge is just "4x"); `TournamentHUD.tsx` ~:527-536 carries Level/Blinds/Next/Rank/Left/Avg | at 10x+ second and third are PAID (80/12/8 or 80/20) and after 3.2 s the player cannot learn that. Fix: swap "Avg" for **Prize** on spins, badge → "4x · 40", ladder in the lobby popup |
| 10 | **Paid 2nd/3rd exit through the "you busted" door** | `TablePage.tsx` ~:10504-10540 — only `position===1` gets a celebration hold | a 100x runner-up takes 20% of the pool and gets the standard 2.5 s bust animation. `CoinShower.tsx` already exists |
| 11 | **Heads-up is never announced on a Spin** | suppression at `TablePage.tsx` ~:10406-10414 is correct and should stay | nothing replaced it. Add a non-blocking ~1.5 s felt-edge pill: `HEADS UP · PLAYING FOR 40` |
| 12 | **Accessibility** | `SpinWheel.tsx` ~:618-624 `role="dialog" aria-modal` with no focus move and an `aria-hidden` result; `TablePage.tsx` ~:20079-20099 `role="table"` over plain divs; buy-in sheet ~:20022-20040 has no Escape/focus trap | a screen-reader user learns nothing about the draw; an incomplete ARIA table is worse than none |
| 13 | **Landscape / short viewports clip the reveal** | `SpinWheel.css` has **zero** `max-height` media queries; `.sw__tree { top:-132px }`; `.seat-buyin-confirm` has no `overflow-y` | at 375 px height the NASCAR tree renders at ≈-10 px and is clipped; the buy-in confirm button can go off-screen unreachable |
| 14 | **No seat-fill indicator and no ETA while waiting** | `TablePage.tsx` ~:20251-20280 (footer text only); spectator footer says "N Of 3 Seats Taken" while a seated player's says "Waiting For 1 More Player" | add a persistent `● ● ○ 2/3` and a real ETA — measured fill is median 188 s, p95 74 min |
| 15 | **Registration RPC wrapped in `retryAsync`, no idempotency key** | `src/services/TournamentService.ts` ~:995-1000 with `src/utils/retryAsync.ts` ~:14-30 retrying on network/timeout/503/429 | a blip AFTER a committed buy-in returns `already_registered`, so the player is told "Already registered" having just been charged. (Spins primarily use `fn_take_seat_and_buy_in`, which is not wrapped, so severity is lower — but it is a money path) |

## PHASE 7 — PRODUCT AND PERFORMANCE

### Product gaps
1. **Rematch does not exist.** "Rematch"/"run it back" appears nowhere in the
   client; the winner is auto-navigated back to the lobby. For a 2-max format
   this is the highest-leverage retention feature there is.
2. **Heads-up CASH does not exist.** The engine supports it
   (`minPlayersToDeal()` returns 2 for tournaments and honours
   `auto_start_players` for cash), but there are **zero** 2-max cash tables and
   the horse fleet never creates one. Anyone wanting HU cash has nothing.
3. **Heads-up is invisible in stats.** `player_stats` has **no format
   dimension at all** — no HU/SNG/Spin columns, no HU leaderboard, no HU
   achievements. A duel specialist has no record of being one.
4. **No matchmaking / challenge-a-player.** There is a waitlist system for cash
   tables but nothing to challenge a named player to a duel — the feature most
   associated with heads-up elsewhere.
5. **Two heads-up products under one banner.** Different stacks (300/1000 vs
   5000), different blinds (10/20 3-min vs 50/100 2-min), different cadence
   (always-open boards vs one instance respawning 30 min after the last ends),
   one shared name in the lobby. Decide whether the scheduled Duel should exist
   at all, given the always-on boards are what actually serve players.

### Performance (numbers measured, not guessed)
6. **The elimination sweep is 8-12 queries every 5 s per tournament.** At 200
   concurrent spins that is ~**400 queries/second** of pure polling to watch
   3 rows. A spin needs none of late-reg seating, table balancing, final-table
   deal or dynamic expansion. A spin fast path plus a push from settlement
   would cut it to near zero **and** shorten the gap between the last hand and
   the winner's result card.
7. **Three DB round-trips before a card is dealt, per table, per hand:**
   `refreshBlinds()` re-reads the whole table row every hand for three columns
   that change every 3 minutes (and the engine already receives a `level_up`
   push); `releaseDeadTournamentSeats()` polls unconditionally for a rare
   condition; plus hand-number allocation.
8. **The HUD fetches ~100 columns per table on a 45 s poll**
   (`TournamentHUD.tsx` ~:116-120/:245-253 via `TournamentService.ts` ~:387)
   for a game that lives 3 minutes. A narrow select would also make Phase 6
   item 9 free.
9. **Horse brain treats a spin as an MTT for the first ~20 s** —
   `max_players === 3` falls through to the `mtt` default until the brain
   context resolves.
10. **Wheel effect re-runs if `playSounds` flips mid-reveal**
    (`SpinWheel.tsx` ~:460-482/:607) — `ambientSoundsAllowed` changes when you
    switch active table in multi-table, tearing down and rebuilding the effect,
    double-firing `playSpinStart()`. Read it from a ref.

---

# 7. THINGS ALREADY VERIFIED CLEAN — DO NOT RE-AUDIT

- **Spin money path.** 2,698 completed spins in 48h: every winner paid exactly
  `buy_in × multiplier` through `fn_credit_and_log`; 0 unpaid; 0 wrong amounts;
  multi-row payouts only on 10x+ premium splits (26× 10x, 4× 25x, 2× 50x).
- **Reserve pool.** Solvent (balance ~60,938, `can_draw_100x` true), 0 unpaid
  settlements, 0 draw-booking gaps after 2026-08-25, 41/41 historical
  shortfalls paid.
- **Draw integrity.** RPC error is read; an unreadable draw is retried 3× then
  stands down with **no invented tier**; pre-draw ledger check and
  `already_settled` multiplier adoption both wired; the wheel fires immediately
  after the draw, before settle/table build, with `reveal_at`/`hold_until`/
  `replay_until`, and the client reads all three.
- **Reserve booking math** books `round(buy_in × multiplier, 2)` — the historic
  under-booking bug is NOT present; the draw locks the pool `FOR UPDATE` and
  subtracts drawn-but-unsettled prizes.
- **`spinSpec.ts` client and server copies are byte-identical** (md5 verified).
- **Duels.** 10,996 completed in 7 days, **0 unpaid winners**, payout structure
  stored not inferred, 5% in-hand cash rake correct, refunds unwind pool, rake,
  count and seat idempotently.
- **Heads-up mechanics from hand one are correct**: button = SB, acts first
  preflop and last postflop, correct BTN/BB labels, alternation cannot desync
  in a game that STARTS 2-handed, restored from hand history on restart.
- **HORSES ARE PLAYERS**: every `is_horse` filter in the spin/tournament path
  gives horses something (auto-rebuy, seat fills, fleet picking). None denies a
  horse anything.
- **Four independent stall watchdogs** cover the 2-handed case; I could not
  construct a state all four miss. (The Phase 4.1 gap is a different shape:
  "running but not dealing".)
- Multiplier frequency distribution matches spec over 20,706 games.
- Payout exactness, blind escalation, start rules, animation law and
  hand-completion law suites all green (101 server + 451 client + 45 + 26).

---

# 8. THE DECISION LOG — why things are the way they are

Read this before "improving" something that looks odd; several of these were
arrived at the hard way.

1. **Zero-point ledger rows are intentional.** `fn_award_vip_credit` writes the
   ledger row FIRST with 0 points as the idempotency marker, then updates it.
   ~13.5k/day extra rows is the price of a replay-safe carry. No player-facing
   surface lists ledger rows, so it is invisible.
2. **`?dry=1` exists on the rakeback cron** because the first production run of
   a job that moves 278k chips should move nothing. Keep that property.
3. **The rakeback cron does not call `fn_run_pending_rakeback_settlement`**
   even though that looks like the entry point: it gates on `auth.uid()` being
   an admin, and a service-role cron has no `auth.uid()`.
4. **Migrations `a`/`b` are split** because the combined one deadlocked against
   live traffic (AccessExclusiveLock vs a table written 23k times/day).
5. **The double-deal scan got its OWN window** rather than shrinking the
   sweep's: the sweep is idempotent and wide is free; the scan is a self-join
   and wide is fatal.
6. **`launchSpin` was retired rather than fixed** — a second creation path for
   a money format is a liability even when correct; `TournamentRecurringService.createSpin`
   is the one true path.
7. **The create-table route was deleted rather than wired up** — its validation
   had never run in production, and RLS + a trigger enforce the same rules for
   every writer, not just for callers who remember to use the route.
8. **The seat law lives in the DB now** because the engine's failure mode for
   an over-seated table is `PokerEngine.deal()` THROWING mid-hand, not
   degrading — an unplayable table, forever.
9. **`HeadsUpOverlay` stays suppressed on Spins** (Dan's 2026-08-23 call) and
   Phase 6 item 11 replaces it with something non-blocking.
10. **Nothing was minted, refunded or paid without Dan.** Two probes were run
    against production; both were unwound in the same transaction block, and
    the migration asserts zero probe rows remain.

---

# 9. YOUR FIRST 30 MINUTES — EXACT SEQUENCE

```bash
# 1. House law (both repos, in this order)
cat ~/Documents/club-arena/AGENT-PLAYBOOK.md
cat ~/Documents/club-arena/CLAUDE.md
cat ~/Documents/Smarter-Poker-World-Hub/CLAUDE.md

# 2. Token check
TOK=$(grep -m1 '^GITHUB_TOKEN=' ~/Documents/club-arena/.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOK" https://api.github.com/user | head -3

# 3. What production is serving right now
curl -s https://smarter.poker/api/health
```

```sql
-- 4. Phase 1 must still be healthy. Anything false here is your first job.
select (not has_function_privilege('authenticated',
        'public.fn_award_vip_credit(uuid, numeric, text, uuid, text)','EXECUTE')) as browser_locked_out,
       (select count(*) from vip_points_ledger where created_at > now()-interval '10 minutes') as awards_10m,
       (select count(*) from vip_points_ledger where created_at > now()-interval '10 minutes' and points=0) as banked_10m,
       (select count(*) from vip_points_carry where carry >= 1 or carry < 0) as carry_violations,
       (select count(*) from vip_points_ledger where source_type like 'zz_probe%') as probe_leftovers;

-- 5. Spin money integrity (both numbers must be 0)
with s as (select id, prize_pool from tournaments
           where tournament_type='SPIN' and status='COMPLETED' and created_at > now()-interval '24 hours')
select count(*) filter (where not exists (select 1 from wallet_transactions w
         where w.category='prize' and w.related_entity_id::uuid = s.id)) as unpaid_winners,
       count(*) filter (where prize_pool <> 0 and prize_pool is null) as null_pools
from s;

-- 6. Phase 4 baseline you are about to improve (expect ~0.6-0.7%)
select count(*) as spins_7d,
       count(*) filter (where extract(epoch from (ended_at-started_at))/60 > 60) as stalls
from tournaments where tournament_type='SPIN' and status='COMPLETED'
  and ended_at > now()-interval '7 days';
```

6. **Say this to Dan, verbatim:** "Phase 1 of 7 is verified complete. Ready to
   start Phase 2 of 7 — fairness in the hand: heads-up button randomisation,
   the 3→2 dead-button big-blind bug, and the `resume()` blind-level index."
   **Then wait.** He runs this one phase at a time.
7. Build Phase 2 per section 6. Ship via section 3.3. Verify in production.
   Summarise. Ask before Phase 3.

---

# 10. HOW TO CLAIM SUCCESS (the house standard, and Dan's explicit ask)

A merged PR is **not** success. For every phase, produce:
1. the production SHA (`/api/health`) that contains your commit — and for
   club-arena changes, the World Hub `chore(club-arena): sync build <sha>`
   commit that carried it;
2. a **behavioural** observation proving the change is live — a DB query whose
   result could not have been produced by the old code, an endpoint response,
   or a bundle grep (I verified my client fixes by pulling the deployed
   `TableConfigPage-*.js` chunk from production and grepping for `min:10` and
   `game_type:"cash"`);
3. the tests you added or updated, green;
4. an honest list of what you did NOT do and why.

**Never** say "should be live shortly", "deploy triggered", or "pushed
successfully". Say what production served, and when.

---

# 11. QUICK REFERENCE — IDs, PATHS, MAGIC NUMBERS

```
Supabase project ......... kuklfnapbkmacvwxktbh
Vercel project ........... hub-vanguard (prj_op66GkZyZcygXQKm76iyycfVFAQx)
Production ............... https://smarter.poker   (health: /api/health)
Club Arena ............... https://smarter.poker/hub/club-arena/
Engine ................... https://engine.smarter.poker (UNREACHABLE from sandbox)
Dispatcher VM ............ root@178.104.160.250, /etc/openclaw.env, systemd unit "openclaw"
Cron file cap ............ 45 (currently 32)
Spin seats ............... 3 (SPIN_SEATS)   Spin rake: flat 0.08
Spin stacks .............. 300 / 1,000 / 5,000 by tier, written at DRAW time
Spin levels .............. 10 published, 3 minutes each, then ~1.4x continuation
Duel rake ................ 5% on top of buy-in (convention only — Phase 3.2)
Seat law (cash) .......... plo6 6 · plo5 7 · plo4/plo8/flo8 8 · else 9
Prize idempotency key .... tourney:{id}:prize:place:{position}   (PLACE-scoped)
Live chip pool ........... club_members.chip_balance   (public.wallets is DEAD)
Engine-only guard ........ fn_caller_is_engine()
```

**Key files**
```
club-arena/src/config/spinSpec.ts                  the Spin's single source of truth
club-arena/server/src/config/spinSpec.ts           byte-identical mirror (test-enforced)
club-arena/server/src/tournament/TournamentManagerBase.ts    draw, start, settle, resume
club-arena/server/src/tournament/TournamentManagerEliminations.ts  payouts, bounties
club-arena/server/src/engine/ServerTableEngineDealing.ts     blinds, button, dealing
club-arena/server/src/GameServer.ts                          fleet, reaper, COMPLETING
club-arena/src/pages/TablePage.tsx                 the felt (~20k lines; grep, don't read)
club-arena/src/components/tournament/SpinWheel.tsx / .css    the reveal
club-arena/src/components/lobby/lobbyEntries.ts    lobby card data
club-arena/src/services/TournamentService.ts       client registration/buy-in
World-Hub/pages/api/cron/*.js                      cron handlers (32 files, cap 45)
World-Hub/scripts/openclaw-cron-dispatcher.py      the scheduler (deploy via deploy-openclaw.sh)
```

---

# 12. THE ONE-PARAGRAPH VERSION, IF YOU READ NOTHING ELSE

There are two heads-up products (3-max Spins, 20,932/week; true 2-max duels,
10,989/week) and they run almost entirely on horses — one human spin in 24
hours — so nothing below has been felt by a player and no live UI walkthrough
has ever been possible. Phase 1 of 7 is shipped and verified: sub-1 rake
credits no longer vanish (they were destroying loyalty on ~55% of all games),
a SECURITY DEFINER hole I introduced was caught by CI and locked down, two
crons Open Claw had been firing at non-existent handlers now exist (revealing
278,579.42 chips of rakeback owed to 589 players, awaiting Dan's go-ahead), and
a forensic double-dealing scan that had been silently timing out on every run
was fixed. Phase 2 is fairness in the hand — the heads-up button is never
randomised, one player can post the big blind twice when a 3-handed spin goes
heads-up, and `resume()` reads the blind level by array index. Phases 3-7 are
config guardrails (a `headsUpSpec.ts` that does not exist), liveness (0.67% of
spins hang, worst 11 hours), integrity (chip-dump scanning dead since 14
August, and no function even writes the flags), presentation (15 items), and
product/performance (no rematch, no HU cash, no HU stats, ~400 q/s of polling).
One item is human-only: the Hetzner dispatcher's CRON_SECRET no longer matches
production, so every Open-Claw job is 401ing — the runbook is committed and
waiting.
