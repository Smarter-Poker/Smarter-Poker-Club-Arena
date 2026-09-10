# CONTINUATION HANDOFF - Club Arena Engine-Restart & Platform-Hardening Programme

## 2026-09-10 Release Authority Addendum

This file contains historical measurements from the engine-restart programme.
The current release authority is `.github/DEPLOYMENT.md` and
`.agent/architecture/deploy-paths.md`. Club Arena frontend and engine releases
run only from reviewed default-branch workflows in this repository and publish
only to Club Arena Hetzner infrastructure. Do not use a World Hub sync, Vercel,
workstation SSH, a local credential file, or an Actions workflow dispatch.

The database deploy dispatcher and its start-marker reconciler are retired by
migration `20260910172000`. Their historical rows are preserved in the locked
`ca_archive` schema, and their crons and callable functions are removed.

## 2026-09-09 Release Blocker Addendum

The 23:55 cutover on September 8 did not occur. A foreign expired 22:53
maintenance record survived the database outage and rejected the replacement
engine's next announcement. The guarded renewal fix is installed as migration
20260909002144, tested with 42 isolated PostgreSQL checks and 82 maintenance
tests. The next scheduled announcement/cutover still needs live acceptance.
Read [the incident and installation evidence](audits/2026-09-09-expired-maintenance-owner.md)
before claiming current server PRs have deployed. Recent direct metrics show
four database CPU cores under sustained pressure; the older two-core statement
in the September 8 addendum is superseded by those measurements.

Last updated: 2026-09-08 ~02:20 UTC (addendum 00); 2026-09-03 (addendum 0); body 2026-09-02 ~22:25 UTC. Author: the "cowork-maintbreak" agent
session (session_01Mcyo7VW3Wdw5oC6qzm4C5y). This file REPLACES the prior
engine-restart handoff (that record is preserved in git history at
docs/HANDOFF_CURRENT_STATE.md before this commit, and the prior programme is
summarized in section 6). Read this top to bottom before touching anything.

Companion document: `docs/ENGINE-RESTART-PROGRAMME.md` (on main) - the 9-phase
plan with per-phase acceptance criteria. This handoff is the live state; that
doc is the map.

---

---

0.  ADDENDUM 2026-09-08 02:20 UTC - THE RE-DIVE. READ BEFORE ADDENDUM 0.

---

Dan, 2026-09-07: "We've had several issues, do a full redive and ensure
everything is working properly before doing anything else." Then: build,
fix and enhance everything found. Everything below is MERGED to main and
serving in production (verified: every merge sha is an ancestor of the
running engine build), and each item was measured after deploy.

STATE OF THE PROGRAMME'S OWN SURFACES (measured 2026-09-08 01:55 UTC):

- 26/26 breaks in 26h opened the gate cleanly (unparked 0), thaw complete in
  1 call on every one, recovery ~60s, hands in freeze 0-1, kill-rebuilds 0.
- freeze_conserved TRUE on every break since the balancer fix (#3560); it had
  been flipping false on table-balance moves caught halfway by the :00 mark.
- The former database deploy dispatcher is historical and retired. GitHub's
  Club Arena-owned sealed engine workflow is the only deployment authority.
- Engine logs survive every deploy: /var/log/club-arena-engine/ holds one
  gzipped file per hourly cutover (~14 MB), 14 days / 6 GB retention (#3539).

WHAT WAS FOUND AND FIXED (PR -> measurement):

- #3534 the hourly bounty backpay sweep aborted whole on one escrow-short pool
  (14 consecutive failures) -> each pool in its own exception block; 4/4 runs
  succeed since.
- #3550 + 20260908020500 (#3627): hand_state_snapshots was 9.2 GB / 3.7 M rows
  because COMPLETED snapshots were kept 7 days and nothing reads one. Now 6h,
  pruned in 2,000-row rounds under a 20s budget, every 2 minutes (the "\_2m"
  job had been on a 5-minute schedule). Draining ~8k rows/run under load.
  hand_history (10 GB) is ALREADY within Dan's 7-day horse retention - the
  fleet deals ~530k hands/day now, 2.4x August. The biggest object is
  solved_spots_gold: 80 GB, almost all TOAST, the horse brain's solver
  artifact, read (7.7M idx scans) not churned - Phase 8's next target.
- #3555 seat-first boards could not fill: 615 of 1,000 horses read as "at
  capacity" because a REGISTRATION for an event days away counted as one of
  the horse's four games (108 booked for next Sunday). Bookings now count only
  inside a 30-minute start horizon. "0 of 3 claimable" / "CANNOT FILL" went
  from 200+ per half hour to 0. Boards still wait a median 12-22 min for
  their FIRST horse (~33% within 3 min) and ~4 min from first horse to start:
  that first wait is the deliberate hold-empty share for humans
  (seatFirstHeldEmpty, 33%/50% per 30-min bucket) - Dan's design, left alone.
- #3560 the tournament balancer moved players between PARKED tables inside
  the freeze (26 seats / 571k in one break). Gated; pinned in
  theFreezeIsTotal.law.test.ts.
- #3569 a spin champion owed 100 was refused (escrow_short) because the
  auto-ledger's spin_prize leg was rejected and fell through to
  settlement_suspense. Settled through the one payer (proven rolled back,
  applied with the numbers asserted). The spin disbursement audit compares
  spins against buy_in x multiplier (34 hourly false positives resolved).
- Hygiene: 5 stale revert-guard issues closed; 19 un-landable PRs catalogued
  in #3570 by owner and cause.

FILED, NOT FIXED (other workstreams, with evidence):

- #3568 (chip-standard): fn_ca_autoledger swallows the SQLSTATE of a rejected
  leg and parks it in settlement_suspense with no alert - 1,776 legs / 672k
  chips per day flow there. Two "cancelled spin kept its draw" alerts (23:50)
  belong to the same workstream's open PR #3563.
- Hourly crons still time out under load (ca-stats-witness-audit-15m 5/4h,
  ca-pay-backed-payout-shortfalls 3/4h - it evaluates two expensive functions
  for EVERY completed tournament ever, hourly; refresh-player-stats deadlocks
  2/4h). Root cause is the 2-core database. pg_stat_statements since 09-02:
  the Supabase Realtime WAL poller is the single largest consumer (5,022 min,
  285ms x 1.06M calls) because table_seats (12.5M writes), tournament_players,
  agent_commissions, tables and tournaments are all in the publication AND all
  subscribed by client code, so nothing can be dropped from it; hand_history
  INSERTs are the next (~8,850 min, 200-400ms each through 11 indexes and the
  ca_hand_player_idx fanout). That is the Phase 8 that remains: fewer
  published high-churn tables (lobby off realtime, onto the engine WS),
  fewer hand_history indexes, partitioning.
- Engine instability windows 04-07 and 16-19 UTC daily (autoheal reports
  unhealthy; 16:52 on 09-07 was unreachable ~60s). The saved logs now make
  the next one diagnosable.

NEXT: Phase 8 proper (above), then Phase 6 pins, Phase 5, Phase 7, Phase 9.

0. ADDENDUM 2026-09-03 00:15 UTC - READ THIS FIRST, IT SUPERSEDES SECTIONS 1,
   10, 19, 20, 21, 22 WHERE THEY DISAGREE (second cowork session, same file)

---

WHAT CHANGED SINCE 22:25.

- #2715 (Phases 2+3) and #2703 (thaw indexes) were RED on CI, not merging:
  (a) migration versions 20260902213000 and 20260902194500 collided with other
  agents' same-minute migrations -> renamed to 20260902213100 and
  20260902194600, ledger rows updated to match; (b) MaintenanceBreak.test.ts
  "the real engine treats a maintenance pause as paused" timed out at 10s on
  the shared runner even with the import hoisted -> beforeAll now pays the
  first ServerTableEngine construction, 60s per-case budget; (c) this
  document's 79-char '=' separators matched the pre-push hook's
  conflict-marker regex, so NO branch carrying it could be pushed from a Mac
  -> hyphens now. Both PRs MERGED 23:18 UTC.
- PHASE 4 BUILT, MERGED (#2729, 23:29 UTC) AND BOTH MIGRATIONS APPLIED LIVE:
  20260902232500 (fn_stamp_sit_out_at honours the thaw's shift under
  app.freeze_bypass only; probe 00:00:00 -> 00:05:00) and 20260902233000
  (fn_thaw_platform in checkpointed installments, 4s self-budget per call,
  tournaments step chunked by pk 40/call; engine loop
  server/src/maintenance/thawInstallments.ts, 10 tests). Changelog:
  docs/changelog/2026-09-02-phase4-the-thaw-cannot-time-out.md.
- THE 23:55 RESTART HAPPENED ON A BUILD WITH PHASES 2, 3, 4 (f2cfd4aa) and is
  MEASURED - see the status log in docs/ENGINE-RESTART-PROGRAMME.md. Headline:
  gate opened (ready_for_restart_at 23:55:28, unparked 0/0), 0 hands started
  inside the break on the new engine (was 955-3110), thaw complete in 1 call
  / 697ms, 355 tables resumed, full fleet back inside ~60-90s (was 600-1000s),
  0 kill-rebuilds, 0 horse seat exits. PHASES 2, 3, 4 ACCEPTED.
- NEW P1 FINDING (goes to Phase 6): horses were SEATED during the freeze by
  the new engine - 68 cash seats (boot seeding) + 160 tournament seats
  (late-reg into a running freeroll, eight Spins launched/three completed,
  a 00:00 MTT seating its 34-horse field at 23:59 for 1,020,000 chips).
  freeze_conserved=false (+1.28M) for exactly this reason. The engine-side
  freeze flag does not gate every seating/launch writer. Details and the
  acceptance pin are in the Phase 6 addendum of ENGINE-RESTART-PROGRAMME.md.
- Historical dispatch evidence: GitHub's old 22:40/45/50 cron missed its
  windows and run 33696270143 was manually dispatched at 23:41. That recovery
  route and the database dispatcher are now retired. Current engine recovery
  is a reviewed-default-branch `deploy-club-arena-engine` repository event
  carrying one exact full `ref_sha`; the owner workflow deploys only from this
  repository to Club Arena's Hetzner engine.
- CI runs on the estate runners. The current path is feature branch -> trusted
  default-branch PR automation -> required checks -> protected merge ->
  **publish-club-arena.yml** to `ca-static.smarter.poker`. Credential values
  are never sourced from a workstation file or copied into instructions. The
  World Hub only rewrites the public URL and never receives a Club Arena build.
- Worktrees: cowork-maintbreak (this programme) and cowork-thawidx (#2703
  fix, disposable). Both clean. Node modules in cowork-thawidx are symlinks
  into cowork-maintbreak.

NEXT: Phase 6 (horse continuity + the freeze is total on the engine side),
then Phase 5. Phase 4 is done; do not reopen it unless a live thaw reports
complete:false or THAW FAILED.

---

## 1. EXECUTIVE CONTINUATION BRIEF

---

WHAT IS BEING BUILT. Club Arena (repo Smarter-Poker/Smarter-Poker-Club-Arena)
is an online poker club platform (unions, clubs, agents, cash games,
tournaments, spins) with chip-based accounting, run by Dan. It has a Node/TypeScript game ENGINE running in a
Docker container on a Hetzner host (engine.smarter.poker), a Supabase Postgres
database (project kuklfnapbkmacvwxktbh), and a web client. A fleet of ~1000
"horses" (AI players; profiles.is_horse=true - horses ARE players, never
"bots") plus a few humans play continuously.

THE OBJECTIVE. Dan wants an INVISIBLE HOURLY ENGINE RESTART so that every hour
the newest merged code reaches the live engine WITHOUT losing, orphaning, or
un-publishing any work, and without disrupting the horses (and few humans)
playing. His words (CLAUDE.md section 13): "NO BUY INS, NO CHIP MOVEMENTS ...
EVERYTHING JUST FREEZES, THEN PICKS BACK UP EXACTLY AS IT WAS BEFORE THE FREEZE
AND RESTART." The mechanism: at :53 the engine calls last-hand, at :55 it
parks every table and freezes all money movement in Postgres, a CI workflow
restarts the container into the newest main, the engine thaws every player
clock by the frozen duration, and play resumes at :00.

After analyzing the whole system, this session and Dan agreed the work is a
9-PHASE PROGRAMME (see section 21 and ENGINE-RESTART-PROGRAMME.md). Dan's
directive, verbatim in spirit: "TAKE EVERY SINGLE THING ... BREAK THIS DOWN
INTO PHASES. BUILD ONE PHASE AT A TIME ... FULLY BUILT OUT, CODED, WIRED IN AND
TESTED BEFORE CLAIMING SUCCESS ... report Phase N of X is done ... Ready to
start Phase N+1." Agent chooses the build order.

CURRENT PHASE. Phases 1, 2, 3 are BUILT and TESTED. Phase 1 is MERGED to main
and applied to the production database. Phases 2+3 are in one open PR (#2715)
awaiting green CI + merge. Phase 4 has NOT been started. Phases 5-9 not started.

THE SINGLE MOST IMPORTANT THING THE NEXT AGENT MUST UNDERSTAND. The break has
been failing to stop play for a specific, now-fixed reason, and the fix is NOT
yet on the live engine. The live engine (version 34c6194b, deployed 20:57 UTC)
still deals ~3,000 hands during each break because its DEALING loop never
consulted the maintenance-pause flag (only the start-up loop did). Phase 2's
final commit fixes exactly this. It ships to production at the 23:55 window via
the in-break "straggler escalation" (production crosses 190 minutes behind main
at ~23:47). THE 23:55 RESTART IS THE PIVOTAL EVENT: it is the first restart on
a build that carries ALL of #2713 (no horse reap), #2711 (DB relief), the
Phase 2 park fix, and the Phase 3 stagger. Every acceptance number for Phases
2 and 3 is measured there.

FIRST ACTION FOR THE NEXT AGENT. Run section 22's checklist. Specifically:
confirm PR #2715 (Phases 2+3) merged to main; confirm a deploy run exists /
was dispatched for the 23:55 window; after 00:00 read the scorecard for the
23:55 break (`select * from ca_break_scorecards order by break_ended_at desc`)
and confirm hands_in_window dropped toward ~0 and recovery_seconds <= ~90.
Then start Phase 4 (thaw installments + fn_stamp_sit_out_at fix).

---

## 2. USER REQUIREMENTS AND WORKING PREFERENCES (NON-NEGOTIABLE)

---

Locked, from Dan, treat as binding:

- TOTAL FREEZE at :55: no buy-ins, no chip movements; everything freezes then
  "picks back up EXACTLY as it was." Nothing lost / orphaned / unpublished.
  (CLAUDE.md section 13.)
- HORSES ARE PLAYERS (CLAUDE.md section 10.5). Never excluded, never a
  different deal, TIMING INCLUDED. A restart must NOT remove or reseed horses.
  Verbatim, 2026-09-02 ~21:05: "ALL HORSES WERE REMOVED FROM THE TABLE DURING
  THE 5 MINUTE BREAK AND SNAP REPLACED WITH NEW HORSES AFTER THE BREAK, THAT
  CAN'T HAPPEN, THEY ARE SUPPOSED TO BE FROZEN NOT REMOVED AND RESEEDED."
  (Fixed by #2713 - see section 7.)
- "IF HIGH RISK ... DO NOT BUILD." Do not speculatively rewrite incident-tuned
  code. This directly shaped Phase 3 (the adoption control law was left alone).
- FINANCIAL DEPLOY GATE STAYS ADVISORY. Do not re-arm it to blocking.
- NEVER CLAIM DEPLOYED WITHOUT PRODUCTION EVIDENCE. Read /health, the DB, the
  engine logs. "should be live" is banned.
- NOTHING MERGES WITHOUT DAN in spirit, BUT the repo runs an AUTOPILOT bot
  (smarter-poker-autopilot[bot]) that AUTO-MERGES non-draft PRs once CI is
  green. So to hold a PR you make it a DRAFT. This session's PRs were left
  non-draft deliberately (Dan wants the programme shipped), so they self-merge
  on green. If the next agent wants to hold something, mark it draft.
- REVIEW EVERY PHASE for bugs/gaps/stubs/wiring, and confirm it is pushed and
  published, BEFORE starting the next phase. (Dan's rule, 2026-09-02. This is
  why Phase 1 got a "review fixes" migration - see section 7.)
- Money paths are not touched without an explicit, separately-reviewed reason
  (programme rule). None of phases 1-3 touched a money path.
- Em dashes are NOT the hamburger icon (CLAUDE.md 10.7) - a repo gate rejects
  em dashes in UI text and source; use ASCII hyphens.
- Build ONE phase at a time; report "Phase N of 9 done ... ready for N+1"
  before moving on.

Working-environment preferences that MUST be followed (see the current release
documents named at the top of this file): use an isolated worktree and an
explicit feature branch, preserve the verified Smarter-Poker commit identity,
run every hook, push the feature branch, and let protected automation open and
merge the pull request. Never source credentials from a local `.env`, push
directly to `main`, rebase shared `main`, bypass a hook, or manually publish.

---

## 3. PROJECT AND REPOSITORY IDENTITY

---

Project Name: Club Arena (Smarter Poker) CONFIRMED
Repository (GitHub): Smarter-Poker/Smarter-Poker-Club-Arena CONFIRMED
Repo remote (origin): git@github.com:Smarter-Poker/Smarter-Poker-Club-Arena.git CONFIRMED
Canonical git dir: /Users/smarter.poker/Documents/club-arena/.git CONFIRMED
(This is a normal git dir with many worktrees, NOT
bare. `git rev-parse --is-bare-repository` = false.
A prior handoff wrongly called it bare.)
Working worktree used: /Users/smarter.poker/Documents/.agent-trees/club-arena/cowork-maintbreak CONFIRMED
Active branch (in that worktree at handoff time): feat/engine-restart-programme-phase-2 CONFIRMED
main tip at handoff: 361734436 CONFIRMED
Primary framework: Node.js + TypeScript (engine), React (web client) CONFIRMED
Package manager: npm (server/package-lock.json) CONFIRMED
Runtime: Node v24.15.0 via nvm (NOT on default PATH) CONFIRMED
Database: Supabase Postgres, project kuklfnapbkmacvwxktbh
(a.k.a. "PokerIQ-Production"). NEVER touch
ydsaqnnuwyvtyxgvrnys. CONFIRMED
Engine host: engine.smarter.poker = Hetzner 5.161.252.33,
hostname "club-arena-engine" (verified 2026-09-07), also running
Grafana, Prometheus, sp-autoheal. The retired tenant is absent. Container name
club-arena-engine. CONFIRMED
Hosting (web): Club Arena Hetzner static origin (`ca-static.smarter.poker`),
served publicly through the World Hub's route-only rewrite. The World Hub and
Vercel do not build, copy, mutate, or publish Club Arena assets. CONFIRMED.
CI: GitHub Actions, 8 self-hosted runners on one 4-vCPU
box; plus ubuntu-latest for the deploy workflow. CONFIRMED (prior)
Deploy pipeline: .github/workflows/auto-deploy-hetzner.yml CONFIRMED

---

## 4. REPOSITORY MAP (paths relevant to this programme)

---

server/src/maintenance/MaintenanceBreak.ts
The break state machine (announce at :53, countdown at :55, park, thaw,
resume). MODIFIED in Phase 2 (the restart gate) and Phase 3 (staggered
resume). Production code. Edit here for phases 4-9 that touch break timing.
Key methods: announceLastHand(), beginCountdown(), end() (thaw+resume),
unparkedTables(), readyForRestart(), resumeEveryEngine(), snapshot()
(published on /health). Deps interface: MaintenanceBreakDeps (engines(),
isRunning(), emit(), store, shouldStayPaused?, thaw?, recordOutcome?,
now?, setTimer?, clearTimer?). PausableTableEngine interface: gained
isBetweenHands() in Phase 2.

server/src/maintenance/MaintenanceBreak.test.ts
The break's unit + source-law tests. MODIFIED phases 2+3. 37 tests. Now runs
inside the REQUIRED "Server Engine" CI check's named regression step (Phase
2 added it to .github/workflows/ci.yml). A FakeEngine test double models
pause/park/deal/finishHand. Edit here to pin any new break behavior.

server/src/maintenance/freezeState.ts
setMaintenanceFrozen() - the in-memory flag; not central to phases 1-3.

server/src/maintenance/maintenanceBreakStore.ts
Supabase-backed persistence of the break row (engine_maintenance_break table)
so a kill between :53 and :55 still resumes the break.

server/src/engine/ServerTableEngineDealing.ts
The DEALING loop. MODIFIED in Phase 2 (the addendum commit e0deafc36): both
awaitPauseGate() sites (~line 167 and ~line 725) now consult
this.maintenancePaused. THIS is the fix that actually stops play during the
break. Production code, extremely hot path.

server/src/engine/ServerTableEngineBase.ts
Core table engine. Owns maintenancePaused, handForHandPaused,
handController, isBetweenHands() (handController === null),
isParkedBetweenHands(), isPausedByDesign(), pauseForMaintenance(),
resumeFromMaintenance(), the start-up wait loop (~line 1850) and its park
gate. NOT modified this session (it was modified by #2695 earlier).
handController is set to null at exactly 6 sites (2 in Base, 4 in Dealing) -
all AFTER settlement; isBetweenHands() relies on this.

server/src/GameServer.ts
The fleet manager: boot, table discovery/adoption (discoverCashTables,
~line 2380), the engine-start budget (line 285, 295), the C19/C20 stagger
and budget control (~line 2530-2760), lease heartbeats, and the
MaintenanceBreak wiring (new MaintenanceBreak({...}) at ~line 422).
MODIFIED in Phase 2 (added recordOutcome dep writing
engine_maintenance_break_log) and by #2713 (deleted the boot cash-out reap)
and #2711 (DB-load fixes). The ADOPTION control law (engineStartBudget.ts +
discoverCashTables) is DELIBERATELY NOT TOUCHED by this programme - see
section 15.

server/src/engineStartBudget.ts
Pure control law: ENGINE_START_BUDGET_MAX=25, MIN=5, RECOVER=5.
nextEngineStartBudget(current, distressed). Incident-tuned. DO NOT rewrite
speculatively.

server/src/services/record-... (CI scripts under scripts/ci/):
scripts/ci/record-engine-deploy-attempt.mjs - writes ca_engine_deploy_attempts on run END (pre-existing)
The former database deploy-start recorder was retired with its dispatcher.
scripts/ci/schema-manifest.d/cowork-restart-phase1.json - Phase 1 schema manifest fragment
scripts/ci/schema-manifest.d/cowork-restart-phase2.json - Phase 2 schema manifest fragment
scripts/ci/check-migrations-applied.mjs, check-definer-authorization.mjs,
check-telemetry-exposure.mjs, check-new-migration-version-collisions.mjs,
check-title-case.mjs - the pre-push / CI gates you must satisfy.

.github/workflows/auto-deploy-hetzner.yml
The sole sealed engine deploy path. A schedule stages current `main`; an exact
full merged SHA may be sent with the `deploy-club-arena-engine` repository
event. There is no force input or branch-selectable manual trigger. Concurrency
group `deploy-hetzner` serializes runs. The poll gate waits up
to 14 min for maintenance.readyForRestart; escalates in-break if production
is >=190 min behind main.

.github/workflows/ci.yml
Required checks. Phase 2 added MaintenanceBreak.test.ts to the named
"Freeze + watchdog + restart-gate regression suite" step of the "Server
Engine (typecheck + tests)" job.

supabase/migrations/\*.sql
All DB changes. This session's migrations (all APPLIED live, see section 18):
20260902194600 the_thaw_stops_reading_every_tournament_ever_played (#2703, thaw indexes)
20260902203100 engine_restart_phase1_scorecard_freezeproof_dispatcher
20260902204600 engine_restart_phase1_deploy_start_marker
20260902211500 engine_restart_phase1_review_fixes
20260902213100 engine_restart_phase2_the_gate_counts_a_live_hand

docs/ENGINE-RESTART-PROGRAMME.md The 9-phase plan (on main). READ IT.
docs/HANDOFF_CURRENT_STATE.md This file.
docs/changelog/2026-09-02-\*.md Per-change changelogs (phase2, phase3,
horses-keep-their-seats, engine-stops-hammering-the-database).

CLAUDE.md (967 lines), AGENT-PLAYBOOK.md (560 lines),
.agents/rules/00-agent-playbook.md (147 lines) - binding instructions.
~/Documents/club-arena/.env - secrets (names only in section 17).

---

## 5. APPLICABLE INSTRUCTIONS AND CONSTRAINTS

---

Reread these before editing:

- CLAUDE.md (repo root, 967 lines). Governs everything. Key sections cited
  this session: 10.5 (horses are players), 10.7 (em dashes != hamburger),
  11.5 (never spend real chips / call money-moving functions), 12 (never
  rebase; merge main), 13 (the freeze requirement, verbatim). CLAUDE.md also
  has a pointer at the top to docs/HANDOFF_CURRENT_STATE.md.
- AGENT-PLAYBOOK.md (560 lines) and .agents/rules/00-agent-playbook.md (147
  lines, "binding"). Shipping rules: own worktree via
  scripts/agent-workspace.sh; branch -> push -> PR; NEVER merge yourself
  (autopilot does it on green); never leave work unpushed; no emoji in source;
  horses are never "bots"; commits authored as Smarter-Poker; migrations must
  carry their own REVOKEs (self-contained); definer functions need a caller
  check or be service_role-only (the telemetry-exposure + definer-authorization
  gates enforce this).
- Repo pre-push hook: runs prettier/eslint on staged files, then the guard
  suite (title-case, painted-text-case, nav-title-case, ui-text/em-dash,
  silent-revert, definer-authorization, migrations-applied,
  migration-version-collisions), then tsc + affected tests. Takes 3-6 minutes.
  IMPORTANT SIDE EFFECT: the hook's test run RESETS the worktree git identity
  to test@example.com. ALWAYS re-set the Smarter-Poker identity after every
  push (the setsid push command in section 13 does this).
- Schema-manifest fragments: DO NOT edit supabase-schema-manifest.json
  directly; drop a JSON fragment in scripts/ci/schema-manifest.d/ naming your
  new tables/functions/columns. The nightly refresh dedupes and deletes
  absorbed fragments. check-migrations-applied reads the base snapshot UNION
  every fragment; a function you redefine in a migration must be declared in a
  fragment on your branch (Phase 2 had to declare fn_ca_record_break_scorecard
  because Phase 1's fragment was on an unmerged branch).

CONFLICTS / AMBIGUITIES encountered: the prior handoff said the canonical git
dir was BARE; it is not (it is a normal .git with worktrees). Trust THIS
handoff. Migration version stamps of the form YYYYMMDDHHMMSS collide easily
when two agents ship in the same minute - Phase 1's first stamps collided with
a concurrent #2702 merge and had to be renamed (see section 7 and 15).

---

## 6. COMPLETE DISCOVERY RECORD

---

THE ONE ROOT CAUSE behind almost every symptom: the Supabase database (2
cores) is SATURATED, and everything that runs at :00 hits it at once. Measured
2026-09-02: point read of one `tables` row took 0.4-2.5s; 1,110
supabase_timeout errors in two hours; 10-50 statement timeouts + lock-wait
warnings every five minutes all day, spiking past 200 in the :55-:00 bucket.
This single fact explains the 47-minute horse-seeder cycle, the 8-second thaw
timeout, one-table-per-5-seconds re-adoption after a restart, and the ~480
daily watchdog kill-rebuilds. Fixing restart choreography without relieving the
load only makes the restart fail more politely - which is why the programme has
a dedicated DB-relief phase (Phase 8), and why #2711 (already merged) and
#2704 (already merged) attack it.

DEPLOY / RESTART ARCHITECTURE (current authority; the measurements below are
historical):

- .github/workflows/auto-deploy-hetzner.yml runs at :35 and accepts the
  `deploy-club-arena-engine` repository event from trusted default-branch
  producers. The event must carry an exact full `ref_sha`; selectable-ref
  workflow dispatch is disabled. Concurrency group deploy-hetzner, runs QUEUE
  (cancel-in-progress:false). It: checks out the exact sha; skips if
  production already serves it; runs the server test suite; runs the ADVISORY
  financial health-gate; SSHes to the Hetzner host; builds an immutable image;
  then WAITS for the maintenance break to park every table (polls
  /health.maintenance.readyForRestart up to 14 min); cuts over; verifies; and
  records "deploy truth" in ca_engine_deploy_attempts.
- The gate opens ~6m30s after dispatch, so a run must be dispatched around :41
  for its poll to cover the :55 break.
- If production is >=190 min behind main (STALE_MIN=190) AND a break is
  running with >=120s left (MIN_BREAK_LEFT_S=120), the workflow ESCALATES: it
  restarts INSIDE the break even if a straggler table never parked. This is
  the ONLY path that has been shipping code, because until Phase 2 the gate
  never opened cleanly.
- GitHub's own cron DROPS ticks (observed: 16:40 and 17:40 produced zero
  runs). This is why Phase 1 built a DB-side dispatcher (disarmed).

THE BREAK STATE MACHINE (MaintenanceBreak.ts):

- announceLastHand() at :53 sets phase=last_hand and calls pauseForMaintenance
  on every engine (sets maintenancePaused + holdBeforeNextHand).
- beginCountdown() at :55 sets phase=counting_down, breakStartedAt/EndsAt,
  parks any stragglers, and from here readyForRestart() can open.
- end() at :00 runs the THAW (fn_thaw_platform), then resumes every engine,
  sets phase=idle, broadcasts ended, clears the row.
- /health publishes snapshot(): version, uptime, and maintenance:{phase,
  breakEndsAt, remainingMs, unparkedTables, readyForRestart, reason,
  dbClockSkewMs}. "freeze-build" is detected by dbClockSkewMs present.

THE FREEZE ENFORCEMENT (DB triggers): a zz_freeze_guard BEFORE trigger on
club_members, table_seats, wallets, wallet_transactions, chip_transactions,
chip_ledger, clubs calls fn_refuse_while_frozen(...guarded columns...). While
fn_platform_frozen() is true it RAISES 55006 (PLATFORM_FROZEN) unless the
caller is service_role (the engine) or app.freeze_bypass GUC is on (the thaw).
A pre-existing Phase-4.1.6a guard raises 42501 on direct balance mutation,
which fires BEFORE zz_freeze_guard - so a 55006 CANNOT be observed by direct
SQL on a balance column; probe a NON-balance guarded column (e.g.
table_seats.stack as postgres). A 55006 WAS witnessed inside the 19:57 window
this way.

THE THAW (fn_thaw_platform, migration 20260902091000 + the index fix
20260902194600): shifts every in-flight absolute deadline forward by the
frozen duration (sit_out_at, waitlist holds, tournament addon/level clocks,
chip_transactions.reversible_until, bounty reveal, rebuy prompts, bomb-pot due)
so "picks back up exactly as it was" is true of the CLOCKS. It is idempotent
per freeze (PK on freeze_started_at). It is called by the engine through
PostgREST as service_role, whose statement_timeout is 8s. IT HAD NEVER ONCE
SUCCEEDED before this session because three of its UPDATEs seq-scanned whole
tables (tournaments 124MB, chip_transactions 348MB, tables 79MB); it measured
19.9s. #2703 added three partial indexes (LIVE on the DB since 19:47) -> it now
SUCCEEDS: engine_maintenance_thaws has 2 rows today (21:00 and 22:00 breaks,
both 300 frozen_seconds). BUT a SECOND thaw defect remains (Phase 4): the
BEFORE trigger fn_stamp_sit_out_at fires before zz_freeze_guard and rewrites
NEW.sit_out_at := OLD.sit_out_at for a seat that stays sitting out, so the
thaw's sit-out shift is discarded even when the thaw succeeds (probe:
shifted_by = 00:00:00). Also the tournaments level-clock UPDATE still costs
~32ms/row across seven unconditional UPDATE triggers, so under lock contention
the thaw can still be slow - the Phase 4 plan is to run the thaw in installments
(several sub-8s idempotent calls).

THE BOOT / RECOVERY PATH (GameServer.ts): on restart the engine re-adopts
tables via discoverCashTables at up to ENGINE_START_BUDGET (25) tables per 5s
sweep, staggered 40ms apart; the budget HALVES on any engine-start failure and
recovers +5/sweep, so under DB saturation it ratchets to the floor (the code's
own comment records "budget pinned at 6, 16 tables adopted after 472s"). It
also re-seeds horses. Until #2713, boot ALSO cashed out and vacated every horse
seat (383 seats, 78,575 chips at the 20:57 boot) then reseeded - the removal
Dan reported. Measured recovery of the 20:57 restart: full fleet (~280 tables)
only by :12, about 10-15 minutes.

WATCHDOG: a per-table watchdog kills+rebuilds a table it thinks is stalled
(engine_recovery_events.event='watchdog_kill_rebuild', ~480/day). Because a
paused table looked stalled, the break caused a kill-rebuild wave; #2695 taught
isPausedByDesign() about the break to stop that. TRAP: a kill-rebuild count of
0 is NOT success if tables never paused (nothing looked stalled) - it is only
success when tables genuinely parked.

PRIOR PROGRAMME CONTEXT (before this chat): a large zero-drift chip-integrity
programme ran 08-31/09-01 (see /areas memory + docs). The maintenance-break
freeze system was built and proven "armed" earlier; this session's job was to
MEASURE it and finish the restart. Along the way the whole 9-phase programme
was scoped. #2695 (park fix), #2703 (thaw indexes), #2704 (horse seeder speed +
union-wallet sizing), #2711 (DB load), #2713 (horse reap deleted) are all part
of the same effort and are now on main.

---

## 7. WORK COMPLETED DURING THIS CHAT (grouped by workstream)

---

WORKSTREAM A - THE THAW FINALLY SUCCEEDS (#2703, MERGE STATE: PR OPEN).

- Root-caused: fn_thaw_platform timed out at the 8s PostgREST cap (measured
  19.9s as service_role, rolled back). Three UPDATEs seq-scanned whole tables.
- Fix: three partial indexes (idx_tournaments_addon_period_open,
  idx_tables_bomb_pot_due, idx_chip_transactions_reversible_open). Created LIVE
  with CREATE INDEX CONCURRENTLY at 19:47 UTC (blocked no writer); all three
  indisvalid=true. Recorded as migration 20260902194600. Also proved (pg_temp
  fn + pg_sleep) that a function-level SET statement_timeout does NOT extend a
  running RPC - the comments in RakebackSettlerService (600s) and index.ts
  (30s) are WRONG about that.
- Result: engine_maintenance_thaws now has rows (21:00 and 22:00 breaks, 300s
  each) - the thaw had NEVER succeeded before. Files: the one migration.
  Branch fix/the-thaw-finishes-inside-the-api-budget, PR #2703 (OPEN, CI was
  green, auto-merge armed - VERIFY it merged). Migration APPLIED live.

WORKSTREAM B - PHASE 1: EVERY BREAK IS MEASURED, EVERY DEPLOY FIRES
(#2710, MERGED to main; migrations applied live).

- ca_break_scorecards: one row/break (hands_in_window, tables_dealing,
  thaw_ran + frozen_seconds, kill_rebuilds_after, recovery_seconds,
  pre_break_tables, shipped_sha, shipped, freeze_conserved, freeze_delta,
  verdict, and Phase-2 columns unparked_at_countdown/peak_unparked/
  ready_for_restart_at/gate_opened). fn_ca_record_break_scorecard() fills it;
  cron ca-break-scorecard at :12 (moved from :06 in review - see below).
- Freeze proof: ca_freeze_circulation_marks + fn_ca_capture_freeze_mark('pre'|
  'post') via crons ca-freeze-mark-pre (:55) and ca-freeze-mark-post (:00);
  scorecard asserts post.total == pre.total (member wallets + live felt).
- Failure push: fn_ca_break_scorecard_push - a failed break notifies
  ca_incident_recipients once, deduped by a per-break key
  (type='engine_break_failed').
- Retired automation: the database deploy dispatcher, deploy-start marker,
  associated crons, and callable functions were removed by forward migration
  `20260910172000`. Historical rows were moved to locked `ca_archive` tables.
  The database no longer stores or uses a GitHub deployment token.
- Migrations 20260902203100, 20260902204600, 20260902211500 were applied. Their
  historical dispatcher and deploy-marker machinery was subsequently retired
  by migration 20260910172000; the historical data remains in `ca_archive`.
- Historical verification: scorecards scored 19:00 fail/1224 and 20:00
  fail/1732; freeze marks captured 20:55+21:00; one real failure push was
  deduped. Current release code no longer contains the deploy-start recorder or
  a database-to-GitHub deployment producer.

WORKSTREAM B2 - PHASE 1 REVIEW FIXES (Dan's "review before next phase" rule;
migration 20260902211500, in #2710).

- (a) Migration stamps 20260902203000/204500 COLLIDED with #2702 (chip-std)
  merging in the same minutes -> renamed to 203100/204600; ledger rows updated.
- (b) The :06 scorecard cron scored FUTURE minutes (recovery scan looks 10 min
  past :00; at :06 minutes 7-10 haven't happened) -> moved to :12.
- (c) The :55 pre-freeze mark was taken ~3s before the freeze engaged -> now
  waits for fn_platform_frozen().
- (d) The dispatcher could be armed before its marker-writer merged -> refuses
  with 'no_marker_writer_yet' until a marker has ever been written.
- (e) The 5 crons lived in no migration -> recorded idempotently.
- The ARMED dispatch path was proven in a rolled-back txn (fake vault secret +
  enabled + stale marker -> queues a real net.http_post, request id 1; rollback
  left 0 secrets / 0 queued).

WORKSTREAM C - PHASE 2: THE GATE COUNTS A LIVE HAND (in PR #2715, OPEN).

- Defect: MaintenanceBreak.unparkedTables() used isParkedBetweenHands()
  (= a loop literally blocked on the pause-gate promise), so a table anywhere
  else in its loop (5s sleep, seat load, idle broadcast) read as "unparked"
  with no cards out. On the 17:55 break, with ZERO hands dealt, 64-70 idle
  tables held the gate shut the whole 5 min; the gate had NEVER opened on a
  real break (third wrong version of this predicate).
- Fix: a table holds the gate iff running AND !isBetweenHands()
  (handController !== null - set only after the hand-complete listener settles
  the pot; verified at all 6 null sites). PausableTableEngine gained
  isBetweenHands().
- The break measures itself: new recordOutcome dep hands out
  {unparkedAtCountdown, peakUnparked, readyForRestartAtMs, tablesResumed,
  thawOk}; GameServer writes engine_maintenance_break_log; the scorecard reads
  it (the 4 new columns). Migration 20260902213100 (the table + the 4 columns +
  the updated scorecard fn). APPLIED live.
- Pins: 6 restart-gate tests FAIL on origin/main's MaintenanceBreak.ts, 34/34
  PASS here. MaintenanceBreak.test.ts added to the required Server Engine
  check's named regression step.

WORKSTREAM C2 - PHASE 2 ADDENDUM: THE DEALING LOOP PARKS (commit e0deafc36 in
#2715). Found by WATCHING the 21:55 break (the first on the #2695 build): it
STILL dealt 3,110 hands inside the freeze. Root: #2537 gave the break its own
authority (maintenancePaused, NOT handForHandPaused) and wired it into the
start-up wait loop; #2695 wired it into isPausedByDesign(); NEITHER wired it
into the two awaitPauseGate park gates in the DEALING loop, which still read
handForHandPaused alone. So a table DEALING at :53 finished its hand and dealt
the next; only QUIET tables parked. Every break since #2537 dealt 1.2-3.1K
hands for this reason. Fix: both dealing gates now
`this.maintenancePaused || (...)`. Source-law pin (every awaitPauseGate in the
dealing loop is guarded by maintenancePaused): fails on main, passes here.

WORKSTREAM C3 - MAIN-RED HOTFIX (#2718, MERGED). #2713 deleted GameServer's
boot cash-out, but tests/config/walletCreditIntegrity.test.ts still pinned
atomic_seat_cashout_locked in the boot path -> main red on Client Unit Tests
since 21:05. Moved the pin (boot path has NO cash-out now); fails on the
pre-#2713 engine, passes on main. Unblocked every open PR.

WORKSTREAM D - PHASE 3: THE RESUME IS STAGGERED (#2724, MERGED into the
phase-2 branch, so it rides #2715 to main).

- resumeEveryEngine woke all ~250 tables synchronously at :00 (herd on the
  2-core DB). Now the first batch (RESUME_BATCH_SIZE=25) resumes immediately;
  the rest roll out RESUME_STAGGER_MS=750 apart via the injected setTimer.
  Every table still gets exactly one resumeFromMaintenance; a superseded
  break's stale batch is dropped (resumeToken + phase!=idle guard). Small/test
  fleets (<=25) resume synchronously exactly as before.
- The adoption control law (engineStartBudget.ts, discoverCashTables) was
  DELIBERATELY NOT TOUCHED (Dan's "if high risk do not build"; it is
  incident-tuned and its real constraint is DB load, addressed by #2711 +
  Phase 8).
- Pins: 2 new (stagger fails on synchronous resume; superseded batch dropped).
  37/37 in the file. Files: MaintenanceBreak.ts, MaintenanceBreak.test.ts,
  docs/changelog/2026-09-02-phase3-the-resume-is-staggered.md.

RELATED WORK BY OTHER SESSIONS, now on main (context, not mine):
#2695 the break stopped stopping play (park fix, isPausedByDesign); #2704 the
seeder runs every 30s not every 47 min + union horse no longer sized a zero
buy-in; #2711 the engine stops hammering a saturated database (get_club_home
RPC, seat-first backoff, parallel WS gates); #2713 horses keep their seats
across a restart (boot cash-out reap DELETED).

---

## 8. VISUAL AND PRODUCT DECISIONS

---

NOT APPLICABLE to this programme. No visual/design/asset work was done. The
break has a client-side overlay/banner/countdown that has NEVER been verified
in a browser against a server that actually pauses (see section 16, and the
Phase 9 client-side break test). No images, mockups, or design references are
part of this work. If the next agent is asked for UI work, that is a separate
track from this programme.

---

## 9. FUNCTIONAL AND ARCHITECTURAL DECISIONS (locked / status)

---

- HOURLY :55 BREAK + TOTAL FREEZE: IMPLEMENTED and armed. The freeze triggers
  are live and enforcing (55006 witnessed). The break announces, parks, thaws,
  resumes. LOCKED behavior.
- THE RESTART GATE MEANS "no hand in flight," not "every table object exists":
  IMPLEMENTED (Phase 2, in #2715). LOCKED - do not revert to
  isParkedBetweenHands().
- THE DEALING LOOP MUST CONSULT maintenancePaused: IMPLEMENTED (Phase 2
  addendum). LOCKED and pinned by a required check.
- THE THAW SHIFTS EVERY IN-FLIGHT CLOCK by the frozen duration, idempotent per
  freeze: IMPLEMENTED; now SUCCEEDS (indexes). PARTIALLY correct - the sit-out
  shift is discarded by fn_stamp_sit_out_at (Phase 4 fixes).
- STAGGERED RESUME: IMPLEMENTED (Phase 3, in #2715). LOCKED.
- HORSES ARE FROZEN, NOT REMOVED/RESEEDED across a restart: IMPLEMENTED (#2713
  deleted the boot reap). LOCKED. Phase 6 will PIN it and the other horse
  failure modes (seeder speed from #2704, union-wallet sizing, seat retention).
- FINANCIAL DEPLOY GATE IS ADVISORY: LOCKED. Do not re-arm.
- IN-BREAK STRAGGLER ESCALATION (restart if >=190 min behind main and a break
  is running with >=120s left): IMPLEMENTED (pre-existing). It is currently the
  ONLY path shipping code, and is EXPECTED to become rare once the clean gate
  path works (Phase 2 acceptance is that the deploy takes the CLEAN path).
- DB-SIDE DEPLOY DISPATCHER: IMPLEMENTED but DISARMED (needs Dan's token
  decision). See section 19 (decision point).
- BREAK ONLY WHEN A DEPLOY IS ARMED (skip the pause when nothing changed):
  SPECIFIED ONLY (Phase 5, not started).
- AUTO-ROLLBACK, KILL SWITCH, PER-FEATURE FLAGS: SPECIFIED ONLY (Phase 7).
- DIRECT POSTGRES POOL / REPLICA / PARTITIONING: SPECIFIED ONLY (Phase 8;
  #2711 is a down-payment).
- TWO-ENGINE ROLLING HANDOVER (no break at all): SPECIFIED ONLY (Phase 9).

Money/game architecture (rake, BBJ, tournaments, spins, wallets, agent
hierarchy): governed by the separate zero-drift programme and CLAUDE.md;
UNCHANGED by this work and out of scope here. See /areas memory files
club-arena-zero-drift and -round2 for that state.

---

## 10. EXACT CURRENT STATE

---

- Handoff-writing branch: docs/handoff-2026-09-02-programme-phase-3 (off
  origin/main 361734436). This file is the only change on it.
- The programme worktree (feat/engine-restart-programme-phase-2) is CLEAN
  (git status --porcelain empty). All work committed and pushed.
- main tip: 361734436 (contains Phase 1 #2710, #2695, #2703-indexes-live,
  #2704, #2711, #2713, #2718).
- Phases 2+3 branch feat/engine-restart-programme-phase-2 tip: db8b53bad
  (= Phase 3 merge #2724 into the Phase 2 branch). PR #2715 OPEN, base main,
  mergeable:true, mergeable_state:blocked (CI pending, no conflicts), auto-merge
  armed. CI run for db8b53bad: "CI - Build & Type Safety" queued at handoff.
- #2703 (thaw indexes) OPEN, auto-merge armed. Its indexes are ALREADY live on
  the DB regardless of merge.
- Production engine: version 34c6194b, uptime ~5000s (deployed 20:57 UTC),
  phase idle, freeze-build true. THIS BUILD LACKS the Phase 2 dealing-loop fix
  and #2713 - it still deals ~3000 hands/break and still reaps horses at boot.
  It will be replaced at the 23:55 window by the escalation.
- Migrations applied live (all): 20260902194600, 203100, 204600, 211500, 213000. engine_maintenance_break_log has 0 rows (its writer deploys with
  #2715). engine_maintenance_thaws has 2 rows today (thaw now works).
- Relevant crons: ca-break-scorecard @ :12, ca-freeze-mark-post @ :00, and
  ca-freeze-mark-pre @ :55. The two deploy-dispatch marker crons are retired.
- Latest scorecards: 22:00 fail/3110 hands/thaw 300s/recovery 300s/freeze
  delta -55662 (dealt through the freeze); 21:00 fail/955/thaw 300/shipped
  true; 20:00 fail/1732/thaw did-not-run.
- Running processes: the production engine container (healthy). No dev servers
  left running by this session. Scheduled task "CA: pivotal 23:55 deploy
  window" (trig_01Y5b7fwLCrHCa12Y3yk5rfw) is bound to THIS session
  (session_01Mcyo7VW3Wdw5oC6qzm4C5y) and fires 23:40 UTC - SEE SECTION 19, the
  next agent in a NEW chat will NOT receive it.

---

## 11. CHANGED-FILE LEDGER

---

Legend: Status = Merged(main) / In-PR / Applied(DB). Committed = yes/no.

PHASE 1 (PR #2710, MERGED to main; DB objects applied):
| File | Status | Purpose | Committed |
| supabase/migrations/20260902203100_engine_restart_phase1_scorecard_freezeproof_dispatcher.sql | Merged+Applied | scorecard, freeze marks, dispatcher, start-marker | yes |
| supabase/migrations/20260902204600_engine_restart_phase1_deploy_start_marker.sql | Merged+Applied | deploy start marker table+fn | yes |
| supabase/migrations/20260902211500_engine_restart_phase1_review_fixes.sql | Merged+Applied | cron :12, pre-mark waits for freeze, dispatcher marker guard | yes |
| former deploy-start recorder | Retired | database dispatch reconciliation removed in `20260910172000` | n/a |
| scripts/ci/schema-manifest.d/cowork-restart-phase1.json | Merged | schema manifest fragment | yes |
| .github/workflows/auto-deploy-hetzner.yml | Merged | "Record that this deploy run started" step | yes |
| docs/ENGINE-RESTART-PROGRAMME.md | Merged | the 9-phase plan | yes |

THAW INDEXES (PR #2703, OPEN; indexes applied live):
| supabase/migrations/20260902194600_the_thaw_stops_reading_every_tournament_ever_played.sql | In-PR+Applied | 3 partial indexes so the thaw fits in 8s | yes |

PHASES 2+3 (PR #2715, OPEN; migration applied live):
| server/src/maintenance/MaintenanceBreak.ts | In-PR | gate=live hand; recordOutcome; staggered resume | yes |
| server/src/maintenance/MaintenanceBreak.test.ts | In-PR | +restart-gate pins, +dealing-loop law, +stagger pins (37 tests) | yes |
| server/src/engine/ServerTableEngineDealing.ts | In-PR | both dealing park gates consult maintenancePaused | yes |
| server/src/GameServer.ts | In-PR | recordOutcome writes engine_maintenance_break_log | yes |
| .github/workflows/ci.yml | In-PR | MaintenanceBreak.test.ts in the required regression step | yes |
| supabase/migrations/20260902213100_engine_restart_phase2_the_gate_counts_a_live_hand.sql | In-PR+Applied | engine_maintenance_break_log + 4 scorecard cols + updated fn | yes |
| scripts/ci/schema-manifest.d/cowork-restart-phase2.json | In-PR | schema fragment (declares fn_ca_record_break_scorecard) | yes |
| docs/changelog/2026-09-02-phase2-the-gate-counts-a-live-hand.md | In-PR | changelog | yes |
| docs/changelog/2026-09-02-phase3-the-resume-is-staggered.md | In-PR | changelog | yes |

MAIN-RED HOTFIX (PR #2718, MERGED):
| tests/config/walletCreditIntegrity.test.ts | Merged | moved the boot cash-out pin (no cash-out now) | yes |

HANDOFF DOC (this branch):
| docs/HANDOFF_CURRENT_STATE.md | In-PR (this branch) | this handoff | yes |

NO UNRELATED USER CHANGES are in the programme worktree (it is clean). If the
next agent finds uncommitted changes in ANY worktree under
~/Documents/.agent-trees/, they belong to another agent session - do NOT
overwrite them. `git worktree list` from the canonical repo shows all of them.

---

## 12. ASSET LEDGER

---

NOT APPLICABLE. No visual assets, images, icons, or reference files are part
of this programme.

---

## 13. COMMANDS AND TOOLS USED (the working playbook - reuse these)

---

Use the current repository tools and `.github/DEPLOYMENT.md`; do not reuse the
historical workstation commands that previously occupied this section.

1. Work on an isolated feature branch, stage explicit paths, run the relevant
   tests, and merge current `origin/main` forward without rebasing.
2. Push normally with every hook enabled and open a protected pull request.
3. Let the Club Arena-owned workflows publish only from reviewed `main`.
4. For an exact merged engine SHA, send the
   `deploy-club-arena-engine` repository event with
   `client_payload.ref_sha`. Do not use a branch-selectable workflow trigger.
5. Verify the direct Hetzner endpoint, the public route, and cache-busted engine
   health before reporting a release.

Credential values are never sourced, copied, printed, or documented as part of
the release procedure. Database changes use a reviewed forward migration and
the repository's migration gates; direct host mutation is not a release path.

---

## 14. VERIFICATION AND TEST RESULTS

---

| Verification | Method | Result | Phase | Follow-up |
| tsc (server) | npx tsc --noEmit | PASS (0) | 1,2,3 | - |
| Full server suite | npx vitest run | PASS 3659/3659 (after Phase 3) | 3 | grows as pins added |
| Restart-gate pins vs OLD MaintenanceBreak.ts | swap file, vitest | 6 FAIL (as intended) | 2 | - |
| Restart-gate pins vs NEW | vitest | 34/34 PASS | 2 | - |
| Dealing-loop law vs OLD Dealing.ts | swap file, vitest | 1 FAIL (as intended) | 2 | - |
| Dealing-loop law vs NEW | vitest | PASS | 2 | - |
| Stagger pins vs synchronous resume | hybrid file, vitest | FAIL (as intended) | 3 | - |
| Stagger pins vs NEW | vitest | 37/37 PASS | 3 | - |
| walletCreditIntegrity pin vs pre-#2713 engine | swap file, vitest | 1 FAIL (as intended) | hotfix | - |
| walletCreditIntegrity pin vs main | vitest | 11/11 PASS | hotfix | - |
| DB migrations (all) | psql apply + probe rolled-back | APPLIED, probes green | 1,2,thaw | - |
| Phase 1 scorecard | live cron + manual calls | records real breaks correctly | 1 | - |
| Thaw now succeeds | engine_maintenance_thaws rows | 2 rows today (300s) | thaw | sit-out shift still discarded (Phase 4) |
| 55006 enforcement | probe non-balance guarded col in-window | WITNESSED 19:57:32 | discovery | - |
| CI gates (definer/migrations/telemetry/collisions/title) | node scripts | PASS locally | 1,2 | - |
| PR CI on #2715 (phases 2+3) | GitHub Actions | QUEUED at handoff | 2,3 | VERIFY it goes green + merges |
| PR CI on #2703 (thaw indexes) | GitHub Actions | was green, auto-merge armed | thaw | VERIFY merged |

NOT TESTED / NEVER RUN (be honest):

- Phase 2 CLEAN gate path on a LIVE break: NOT YET (needs #2715 deployed; first
  chance is the 23:55 restart). engine_maintenance_break_log has 0 rows.
- Phase 3 recovery_seconds <= 90 on a LIVE restart: NOT YET (same window).
- The thaw's sit-out shift ACTUALLY moving a deadline: proven BROKEN (Phase 4).
- Client-side break UI (overlay/countdown/resume): NEVER tested in a browser.
- The DB-side dispatcher firing for real: NEVER (disarmed by design).
- Auto-rollback / kill switch / staging / load test / two-engine: not built.
- No E2E, visual, accessibility, or responsive testing of anything here.

---

## 15. SETBACKS, FAILED APPROACHES, AND LESSONS

---

- #2695 was NECESSARY BUT NOT SUFFICIENT. It parked quiet tables and taught the
  watchdog, but the DEALING loop still dealt through the break. Only measuring
  the 21:55 break (3,110 hands) revealed it. LESSON: measure every break; a
  green test suite (3,583 tests passed for #2537) does not prove the break
  stops play - a source-law pin plus a live scorecard does.
- Migration stamp collisions: two agents shipping in the same minute collide on
  YYYYMMDDHHMMSS. Phase 1's first stamps collided with #2702. LESSON: pick a
  free minute; if CI goes red on "unapplied/unrecorded migration" it is usually
  a collision or a stale manifest, not a real gap.
- The pre-push hook resets git identity to test@example.com, which then makes
  the NEXT commit fail the author guard. LESSON: re-set the Smarter-Poker
  identity after every push (baked into the setsid command).
- Autopilot merges main INTO open PRs, so a plain `git push` gets a
  non-fast-forward rejection. LESSON: git fetch; git merge origin/<branch>
  (never rebase); push again.
- Autopilot also auto-merges non-draft PRs on green - #2724 (Phase 3) got
  merged into its base (the Phase 2 branch) automatically, which is FINE (it
  rides #2715 to main) but be aware stacked PRs collapse this way.
- A stash pop after a lost device-link window left a conflicted tree with
  unrelated files; recovered with `git reset --hard HEAD` (the committed work
  was safe, the stash was preserved). LESSON: after a reconnect, check git
  status before trusting the tree.
- DELIBERATELY DID NOT BUILD: a rewrite of the adoption control law
  (engineStartBudget.ts / discoverCashTables). Its comments document several
  production incidents it was tuned through, and its real constraint is DB
  load. Rewriting it speculatively is exactly Dan's "if high risk, do not
  build." The right fix is DB relief (Phase 8) - #2711 is the down-payment.
- The device link (remote-devices bridge) dropped several times mid-work.
  Reconnect via ToolSearch for mcp**remote-devices**\* ; committed+pushed work
  is safe; re-verify the tree after each reconnect.

---

## 16. KNOWN DEFECTS AND ARCHITECTURAL HOLES (prioritized)

---

| P | Defect / hole | Evidence | Impact | Fix | Status |
| P0 | Live engine still deals through the break | 22:00 scorecard 3110 hands | The announced break is a lie until #2715 deploys | Phase 2 addendum, in #2715, ships 23:55 | Fix ready, NOT LIVE |
| P1 | Thaw discards the sit-out shift | probe shifted_by=00:00:00 | Players who sat out at :53 lose the 5 min | Phase 4: fix fn_stamp_sit_out_at ordering | KNOWN, not fixed |
| P1 | Thaw can still be slow under lock contention | 20:00 thaw timed out even after indexes | A slow thaw at :00 delays resume | Phase 4: run thaw in installments (sub-8s calls) | KNOWN, indexes help |
| P1 | Clean gate path never observed on a live break | engine_maintenance_break_log 0 rows | Phase 2 unproven end-to-end | Measure the 23:55 restart | UNVERIFIED |
| P1 | Fast recovery unproven | recovery ~600-1000s historically | "invisible" not yet true | Measure 23:55 (has #2713+#2711+stagger) | UNVERIFIED |
| P0 | The hourly back-pay job times out EXACTLY when little is owed, so residual shortfalls are never reached | `ca-pay-backed-payout-shortfalls-hourly`: **5 of the last 24 runs failed**, `canceling statement due to statement timeout` in `fn_tournament_conservation_delta` statement 1. That function is 9 correlated aggregates (6 over `wallet_transactions`, 1,218 MB / 2.8M rows) measured at **59 ms/call**, and it is called INSIDE the WHERE clause against every COMPLETED tournament - **112,298** of them = **110 minutes** under a 120s timeout. It is also evaluated a SECOND time per row in the SELECT list. The `LIMIT 500` lets Postgres stop early only once 500 rows PASS, so the job succeeds when much is owed and times out when little is | **7 obligations open, 436.37 chips unpaid**, oldest **101 hours** (0.12 / 0.09 / 0.11 rounding dust that four days of hourly runs never reached). One of the seven is a horse - 10.5, paid like anyone | Bound the candidate set before the expensive predicate (but keep the function header's rule that an event can become payable AFTER its pass); stop double-evaluating the delta; make the pass resumable on `ended_at`. The residual amounts still need 10.9's human decision because the escrow was SHORT | **MEASURED, NOT FIXED** - `docs/changelog/2026-09-07-the-back-pay-job-only-succeeds-when-there-is-a-lot-to-pay.md` |
| P2 | DB saturation (root cause) | 1110 timeouts/2h, 200+ locks in :55-:00 | Slow everything at :00 | Phase 8 (direct pool, replica, partitioning); #2711 down-payment | Partially mitigated — BUT SEE P0 BELOW: the 2026-09-07 timeouts were NOT the database |
| P0 | The engine's single JS thread saturates and every table starves on an ordinary read | 2026-09-07 04:05: fleet 480 -> 6 hands/min for ~20 min. **10,688** `deal_step_timeout: load_seats exceeded 20s` in 12 min. Box 3 cores, load 1.25; container **100.8% CPU = exactly one core, pegged**. Postgres: 6 active backends, **0 waiting on a lock**. From the engine box, three timed reads of the very query "exceeding 20s": **200 in 0.133-0.175s**. Not a DDL reload storm (check-ddl-reload-storms silent, correctly). Not volume: hour 04 started **71** tournaments vs 436-515 in each of the previous nine healthy hours. Same shape at 2026-09-06 16:05 | Cash tables are collateral damage of tournament work; players see a dead felt while `/health` says `liveness: ok` | Profile the sweep against a live 120-tournament set; move it off the thread that also serves every human action. Two of three cores are idle | **MEASURED, NOT FIXED** — `docs/changelog/2026-09-07-the-collapse-was-not-the-reload-storm.md` |
| P1 | The elimination sweep is N timers, one per tournament, and the failure feeds itself | `startEliminationChecker` opens a `setInterval` per manager at `ELIMINATION_SWEEP_MS = 5000`. At 120-199 RUNNING tournaments that is **24-40 sweeps a second on one thread**. The overrun warning fires ONCE per episode, so **780 in 15 min = ~780 distinct stuck sweeps**. A sweep that overruns stops its tournament completing, RUNNING accumulates (120 running, only 40 completed in half an hour, against 400-500/hour all night), and each new one adds sweep work | Positive feedback: the busier it gets, the more sweeps pile on | One shared scheduler instead of N timers, and/or off the hot thread. Jitter alone is cosmetic — the problem is average load, not burstiness | **MEASURED, NOT FIXED** |
| P1 | `EquityLoadGovernor` read an empty histogram as an idle loop — FIXED 2026-09-07 | `/health` served `scale: 1, p50Ms: 0.000511, p99Ms: 0.000511` through the whole 04:05 outage; p50 == p99 to six decimals, identical across two processes. `0.000511` is what `percentile()` returns when `count` is 0, and `monitorEventLoopDelay` records only when the loop TURNS — so a pegged loop starves its own sampler | The one guard for this stood down precisely when it was needed | An empty reading is UNKNOWN (scale HELD, `stale: true`); the sampler measures its own lateness, which cannot go blind; scale decided on the worse of the two. New gauge `poker_equity_governor_sampler_late_ms` | **FIXED** — `docs/changelog/2026-09-07-an-empty-histogram-is-not-an-idle-loop.md` |
| P2 | GitHub cron drops deploy ticks | 16:40, 17:40 zero runs | Missed windows -> stale engine hours | Phase 1 DB dispatcher (DISARMED - needs Dan's token) | Built, disarmed |
| P2 | sp-autoheal restarts the engine unannounced (#2651) | autoheal log, shared host | Players dropped mid-hand | Re-measure after #2695/#2713; Dan's call (shared host) | Deferred |
| P3 | Break window costs the 5-min pause even when nothing changed | every hour | Wasted disruption | Phase 5 (break only when armed) | Not started |
| P3 | No auto-rollback / kill switch | - | A bad build rides until a human notices | Phase 7 | Not started |
| P3 | Client break UI never verified | never exercised | overlay/countdown may not match server | Phase 9 client test | Not started |
| P3 | Second pause path (tournament tables) may exist | not audited | a tournament table might deal through a break | audit in Phase 2 follow-up / Phase 6 | UNKNOWN, INSPECT |

---

## 17. SECURITY, SECRETS, AND CREDENTIALS (names only)

---

The release workflows read credential values only from this Club Arena
repository's GitHub Actions secret store:

- Engine: `HETZNER_SSH_PRIVATE_KEY`, `HETZNER_HOST`, `HETZNER_HOST_KEY`.
- Static origin: `CA_ORIGIN_SSH_KEY`, `CA_ORIGIN_HOST`,
  `CA_ORIGIN_HOST_KEY`.
- Database verification uses the narrowly scoped repository secrets named by
  the workflow that performs it.

No Club Arena publisher reads a World Hub secret, Vercel token, workstation
SSH key, or local `.env` value. Local files may hold development credentials,
but they are not release authority and their values must never be copied into
Markdown, commands, logs, or chat. The retired database dispatcher no longer
expects or stores a GitHub token in Supabase Vault.

---

## 18. DATABASE, MIGRATION, AND SEED STATUS

---

Provider: Supabase Postgres, project kuklfnapbkmacvwxktbh. Historical versions
used pg_net for a database deploy dispatcher; that release path is retired.

New tables this session (all RLS-enabled, service_role only, no money path):
ca_break_scorecards (PK break_ended_at)
ca_freeze_circulation_marks (PK window_hour, kind)
The former deploy-dispatch configuration, log, and start-marker tables are
archived outside `public` by migration `20260910172000`.
engine_maintenance_break_log (PK break_started_at) - written by the engine
(deploys with #2715; 0 rows until then)

New/updated functions (all SECURITY DEFINER, revoked from PUBLIC/anon/
authenticated, service_role only):
fn_ca_circulation_total, fn_ca_capture_freeze_mark,
fn_ca_record_break_scorecard (redefined in Phase 2 to read the break log),
fn_ca_break_scorecard_push. The former deploy-dispatch and start-marker
functions are removed by migration `20260910172000`.

New indexes (LIVE, CREATE INDEX CONCURRENTLY, from #2703):
idx_tournaments_addon_period_open, idx_tables_bomb_pot_due,
idx_chip_transactions_reversible_open (all indisvalid).

New scorecard columns (Phase 2): unparked_at_countdown, peak_unparked,
ready_for_restart_at, gate_opened.

Migrations APPLIED to production (verified in supabase*migrations.schema*
migrations): 20260902194600, 20260902203100, 20260902204600, 20260902211500, 20260902213100. Every migration is self-contained (carries its own REVOKEs).
Applied via psql as postgres. ROLLBACK of the DDL was NOT separately tested,
but every function/table is idempotent (CREATE OR REPLACE / IF NOT EXISTS) and
every logic change was proven in a rolled-back transaction BEFORE applying.

Seeds: none written this session. The programme adds no seed data.

Production-data risk: LOW. No money path, no data migration, no destructive
DDL. The indexes were built CONCURRENTLY (no writer blocked). The scorecard/
mark tables are new and empty-to-append. The one behavioral DB change
that touches live reads is the redefined fn_ca_record_break_scorecard, proven
rolled-back.

Local vs remote: there is no local database; all work was against production
(carefully, read-mostly + rolled-back probes + idempotent applies).

---

## 19. CURRENT BLOCKERS AND DECISION POINTS

---

DECISION 1 - CLOSED. The database-side deploy dispatcher must not be armed.
Migration `20260910172000` removes its crons and callable functions and moves
its historical rows to locked `ca_archive`. Default-branch Club Arena GitHub
workflows are the only engine deployment authority.

DECISION 2 (Dan's authority) - the horse-freeroll prize destination, the
buy_in_fee / spins / bounty / VIP restitution questions, and the CERT-FLEET
15.79M wipe-or-keep: these are OPEN money questions from the zero-drift
programme, NOT part of this restart programme, but they are still awaiting Dan.
See /areas memory files.

BLOCKER (technical, self-clearing) - Phases 2+3 are unproven on a live break
until #2715 deploys. It deploys at 23:55 via escalation (production crosses 190
min behind at ~23:47). If #2715 has NOT merged to main by ~23:40, the next
agent should confirm it merged (or help it merge) so the 23:55 build carries
it. No decision needed; just verify.

BLOCKER (process) - the scheduled 23:40 check-in is bound to THIS session, which
the new chat will not inherit. The next agent should either (a) be online near
23:40-00:15 UTC to run section 22's 23:55 checklist, or (b) create a fresh
scheduled task in the NEW session (create_trigger / send_later) to do it. The
work does not block on this - the escalation ships #2715 regardless - but the
MEASUREMENT (the acceptance evidence) needs someone to read it.

---

## 20. REMAINING WORK

---

CRITICAL:

- Verify #2715 (Phases 2+3) merged to main; verify #2703 merged.
- Measure the 23:55 restart: hands_in_window ~0, recovery_seconds <=~90,
  engine_maintenance_break_log.ready_for_restart_at non-null, no horse reap at
  boot, gate took the CLEAN path. This is the acceptance for Phases 2+3.

HIGH:

- Phase 4: thaw in installments + fix fn_stamp_sit_out_at (the sit-out shift).
- Phase 6: pin horse continuity (seat retention, seeder speed, union-wallet
  sizing) with fail-on-revert tests; audit for a second pause path (tournaments).

MEDIUM:

- Phase 5: break only when a deploy is armed.
- Phase 7: auto-rollback + kill switch + hourly freeze-conservation assertion.
- Arm the DB dispatcher (after Dan's token decision).

LOW / LARGER:

- Phase 8: direct Postgres pool, read replica for reporting, partition
  hand_history/hand_state_snapshots, top-10 pg_stat_statements offenders,
  VACUUM/ANALYZE in the freeze window.
- Phase 9: staging engine on a Supabase branch, load test (1000 horses/1100
  tables/1 hour), two-engine rolling handover (no break), client-side break
  test as a required check.

OPTIONAL:

- Prune the ~1000 empty DSS tables (part of the load; Dan's call, flagged in
  #2711's changelog and prior handoffs).

---

## 21. PRIORITIZED NEXT-PHASE EXECUTION PLAN

---

PHASE 0 - RECOVER AND VERIFY (do first, no edits). Run section 22. Confirm main
tip, #2715/#2703 merge state, /health version, and the latest scorecards. Do
NOT edit before this.

PHASE 0.5 - MEASURE THE 23:55 RESTART (the acceptance for phases 2+3).
Prereq: #2715 merged to main; a deploy run dispatched for the 23:55 window
(escalation ships it once production is >=190 min behind, ~23:47). After 00:00:

- /health version = the new main tip; contains the Phase 2 dealing fix.
- select \* from ca_break_scorecards order by break_ended_at desc limit 1;
  hands_in_window should collapse toward ~0 (from 3110); recovery_seconds
  <=~90; unparked_at_countdown ~0; gate_opened true.
- select \* from engine_maintenance_break_log order by break_started_at desc
  limit 1; ready_for_restart_at NON-NULL = the gate opened (Phase 2 done);
  peak_unparked low.
- ca_seat_stack_exits at the boot minute ~0 horse exits (was 383) = #2713
  verified.
  Comment the numbers on the programme doc / to Dan. If hands are still
  non-zero, the dealing-loop fix did not take - inspect ServerTableEngineDealing
  and look for a SECOND pause path (tournament tables) before changing anything.

PHASE 1 (programme Phase 4) - THE THAW CANNOT TIME OUT AND GIVES EVERY CLOCK
BACK. Files: supabase/migrations (new), fn_thaw_platform, fn_stamp_sit_out_at,
GameServer.ts thaw wiring (~line 450), MaintenanceBreak.ts end(). Changes:
(a) split fn_thaw_platform into several idempotent sub-8s calls (the ledger row
keeps it idempotent), OR scope the seven unconditional tournaments UPDATE
triggers to the columns they inspect (touches guard surface - review
separately); (b) fix fn_stamp_sit_out_at so the thaw's sit_out_at shift is not
overwritten (it fires BEFORE zz_freeze_guard and rewrites NEW.sit_out_at). Test:
probe the thaw as service_role rolled-back, assert shifted_by > 0 on a
sit-out seat; assert each installment < 8s. Completion: one
engine_maintenance_thaws row/break, frozen_seconds 280-330, AND a sampled
sit-out/waitlist deadline actually moved forward on a live break. Risk: money-
adjacent tables (chip_transactions.reversible_until) - keep the freeze_bypass
GUC pattern; no balance column is touched, only deadline columns.

PHASE 2 (programme Phase 6) - HORSE CONTINUITY PINNED. Pin (fail-on-revert):
a restart never releases a horse seat/stack (#2713); the seeder runs every 30s
(#2704); union horses are sized by the paying club not the union row (#2704).
Audit whether a tournament table can deal through a break (a second pause path).
Completion: before/after a real restart, horse seat+stack counts match; pins
fail on reverted code.

PHASE 3 (programme Phase 5) - BREAK ONLY WHEN ARMED. The deploy writes an
"armed" flag once the image is built; the engine calls last-hand at :53 only
when armed. Completion: an hour with no server change records NO break.

PHASE 4 (programme Phase 7) - SAFETY NETS. Auto-rollback on a failed-break /
non-recovering scorecard (redeploy :previous); a deploy kill switch + per-
feature DB flags; assert freeze conservation hourly (built on Phase 1 marks).

PHASE 5 (programme Phase 8) - RELIEVE THE DB. Direct Postgres pool off the
PostgREST 8s cap for the hot paths (adoption, thaw, seeder); replica for
reporting; partition hand_history/hand_state_snapshots by day; fix the top-10
pg_stat_statements offenders; VACUUM/ANALYZE in the freeze window; recommend
right-sizing DB compute.

PHASE 6 (programme Phase 9) - TOWARD NO BREAK. Staging engine on a Supabase
branch (one simulated break per merge before production); a load test; the
two-engine rolling handover using the existing lease system (new engine warms
beside the old, claims the fleet in one sweep, no break); a client-side break
test as a required check.

Each phase: build on a branch off latest main (or stacked on the prior
programme branch if unmerged), fail-on-revert pins, tsc + full server suite,
apply DB rolled-back-first, push via setsid, open a non-draft PR (autopilot
merges on green), and MEASURE on the next live break before claiming done.

---

## 22. CURRENT FIRST ACTIONS FOR THE NEXT AGENT

---

1. Work only in a named isolated worktree. Fetch `origin/main`, inspect branch
   and worktree state, and read `.github/DEPLOYMENT.md` plus
   `.agent/architecture/deploy-paths.md` before changing release machinery.
2. Never source a local credential file. GitHub Actions obtains only the named
   repository secrets required by the owning workflow; local tools use their
   configured credential stores without printing values.
3. Push an explicit feature branch and let the trusted default-branch signal,
   required checks, and protected auto-merge path land it. If CI is red, fix
   forward; never weaken a pin, manually merge, or push directly to `main`.
4. Verify the cache-busted Club Arena origin and public `build-info.json`, and
   record their full SHA. For engine work, coordinate with the existing engine
   release owner and verify the cache-busted `/health` version; do not race or
   replace the owner lane.
5. If a validated server-changing `main` SHA is not already represented by an
   active run, the trusted producer emits `deploy-club-arena-engine` immediately
   with that exact full SHA toward the certified :55 window. Never wait for a
   future hourly tick in place of dispatching already-staged work.
   window; if none, dispatch on main WITHOUT force (section 13). NEVER force.
6. After the next :00, run PHASE 0.5's queries (section 21) to measure the
   break. This is the acceptance evidence for phases 2+3.
7. DO NOT MODIFY: other worktrees' uncommitted files; the adoption control law
   (engineStartBudget.ts / discoverCashTables) without a measured reason; the
   freeze triggers; any _.law.test._ or pinned test without moving the pin in
   the same commit; the :previous rollback image.
8. Resume at PHASE 4 (thaw installments + fn_stamp_sit_out_at) once the 23:55
   measurement confirms phases 2+3, OR fix-forward if the measurement shows
   hands still dealt in the break.

---

## 23. ACCEPTANCE CRITERIA

---

The PROGRAMME is done when ALL are observably true on live breaks:

- A break window records ~0 hands in hand_history (baseline 1200-3100).
- The break log reports ~0 tables unparked at countdown; ready_for_restart_at
  is non-null (the gate opened); the deploy takes the CLEAN path, not the
  190-min escalation.
- One engine_maintenance_thaws row per break, frozen_seconds 280-330, AND a
  sampled sit-out/waitlist deadline actually moved forward (not just a row).
- Fleet fully dealing within ~90s of :00 (scorecard recovery_seconds), vs
  ~600-1000s today.
- freeze_conserved true (circulation equal across the freeze edges) on a break
  that genuinely froze.
- No horse removed/reseeded at boot (ca_seat_stack_exits ~0 at the boot minute).
- watchdog_kill_rebuild at :00 stays 0 WITH tables genuinely parked (not the
  false 0 of a break that never paused).
- A break costs the 5-min pause ONLY when a deploy is armed (Phase 5).
- A bad build rolls back automatically (Phase 7); the freeze conservation
  assertion is green hourly.
- One fully ORGANIC hour: cron fires, gate opens cleanly, deploy lands, fleet
  recovers fast, zero manual dispatches.
- Git clean; CI green; the programme PRs merged; no money path touched
  (verified: none were).

Per-phase acceptance is in docs/ENGINE-RESTART-PROGRAMME.md.

---

## 24. RECOMMENDED COMMIT STRATEGY (remaining work)

---

- Phase 4 thaw: TWO commits - (1) fix(db): fn_stamp_sit_out_at stops eating the
  thaw's sit-out shift (migration + rolled-back probe proof); (2) fix(db): the
  thaw runs in installments so it fits the 8s cap (migration + timing probe).
  Keep them separate; test each rolled-back before applying.
- Phase 6 horse pins: test-only commit(s); no source change if #2713/#2704 hold
  - fail-on-revert pins + a "tournament second pause path" audit note.
- Phase 5 armed-break: one engine + one workflow commit.
- Never mix a migration with an unrelated source change. Never mix two phases
  in one PR unless stacked deliberately. Every PR non-draft (autopilot merges
  on green) unless you intend to hold it (then draft).

---

## 25. FINAL CONTINUATION SUMMARY

---

STOPPING POINT: Phases 1, 2, 3 built and tested. Phase 1 MERGED to main and
applied to the production DB. Phases 2+3 in PR #2715 (open, mergeable, CI
pending, auto-merge armed). Thaw indexes in #2703 (open) but already live on
the DB. The live engine (34c6194b) still deals through the break and still
reaps horses at boot - both fixed in code, shipping at the 23:55 window via the
in-break escalation. The worktree is clean; all work is committed and pushed.

WORK ON FIRST: verify #2715/#2703 merged, then MEASURE the 23:55 restart
(section 21 Phase 0.5) - it is the acceptance evidence for phases 2+3. Then
start Phase 4 (thaw installments + fn_stamp_sit_out_at).

MOST IMPORTANT LOCKED REQUIREMENTS: total freeze at :55; horses are players and
must be frozen not reseeded; if high risk do not build; deploy gate stays
advisory; never claim deployed without production evidence; no money path
touched.

GREATEST TECHNICAL RISK: a SECOND pause path (tournament tables) may also deal
through the break, so even after the Phase 2 dealing-loop fix the 23:55 break
could still show hands - audit ServerTableEngineDealing and the tournament
engine before assuming the fix is complete.

GREATEST DATA-INTEGRITY RISK: the thaw's sit-out shift is silently discarded
(Phase 4), so players who sat out at :53 lose the promised minutes; and any
thaw change touches deadline columns near money (keep the freeze_bypass GUC,
touch no balance column).

GREATEST VISUAL RISK: the client break UI has never been verified against a
server that actually pauses (Phase 9); once tables truly park, the overlay/
countdown/resume may misbehave.

DEPLOY DISPATCH DECISION: closed. The database reconciler is retired and must
not be recreated or armed.

HOW TO CONTINUE WITHOUT RESTARTING DISCOVERY: everything you need is in this
file and docs/ENGINE-RESTART-PROGRAMME.md. The working playbook (commands,
paths, credentials by name, gotchas) is section 13; the current state is
section 10; the exact first actions are section 22. All migrations are applied
and recorded; all code is committed and pushed; the worktree is clean. You do
not need this conversation - read this file, run section 22, measure the 23:55
break, and resume at Phase 4.
