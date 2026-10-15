# Lightning Go-Live Handoff (2026-10-15, 17:30 UTC)

You are picking up the Lightning programme for Club Arena (Smarter Poker). Lightning is the pooled fast-fold cash mode. This document is the complete state of the work and every step left before Lightning can go live for real players. Read it top to bottom before acting. Nothing in it is a summary of a summary: every id, run, migration and rule you need is here.

## 0. First Actions, In Order

1. Read root `CLAUDE.md`, `AGENTS.md`, `AGENT-PLAYBOOK.md`, `docs/agent-policy/REFERENCE-INDEX.md` and `PUBLISHING.md`. They bind you.
2. Read `docs/lightning/FUNCTIONAL-BUILD-PHASES.md` (the 8 phases), `docs/lightning/REMAINING-WORK.md` (R01 to R22), `docs/lightning/ROLLOUT.md` (Stages 0 to 4) and `docs/lightning/FINAL-RELEASE-REVIEW.md` with `docs/lightning/release-gates.json` (gates L01 to L54).
3. Check PR #6992 (section 4.1). If merged and not installed, install it (section 6.3).
4. Check whether the global horse fleet is back on (section 3.4). Lightning cannot progress with the fleet off.
5. Then work Phase 3 (section 5.3) to completion, then Phases 4 to 8 in order.

## 1. Who, Where, What

| Item | Value |
| --- | --- |
| Owner | Dan (Daniel Bekavac). He does no manual steps. Do not offer him options: decide, act, report. No interim updates on long tasks. Written deliverables use Title Case headings and no em dashes. |
| Repository | `Smarter-Poker/Smarter-Poker-Club-Arena`, default branch `main` |
| Production database | Supabase project PokerIQ-Production, ref `kuklfnapbkmacvwxktbh` |
| Engine | Hetzner VPS, `https://engine.smarter.poker/health`. Latest sealed release `3002fe25f06cc958b2708026e80e9904bac6c518`; it contains the Phase 13 engine change (prerequisite met). |
| Client | `https://smarter.poker/hub/club-arena/` (rewrite to `https://ca-static.smarter.poker`), published by `publish-club-arena.yml` |
| Service identity for scripts | `daniel@smarter.poker`, user id `2d1cd6c3-5700-4af9-a271-d4863fdab20d` (role god). Never Dan's personal account. Scripts sign out with `{ scope: 'local' }`. |
| Workflow secrets used | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SP_EMAIL`, `SP_PASS` |

## 2. Rules That Bind Every Step

- **Migrations.** Create with `node scripts/new-migration.mjs "slug words"`, never a hand-picked version. One `BEGIN`/`COMMIT` per file. A migration that creates no new object needs `-- @live-proof: <boolean SQL>` or `tests/a-merged-migration-must-be-live.law.test.ts` fails. A superseded migration carries `-- SUPERSEDED BY <14-digit version>` in its first 400 characters. The database refuses DDL in the break window, minute :50 to :03 UTC.
- **Money probes.** Only inside one Supabase MCP call holding one `DO` block that ends in `RAISE EXCEPTION` (the error is the success case). A transaction never spans two MCP calls. Use `SET CONSTRAINTS ALL IMMEDIATE` to fire deferred guards inside the probe.
- **Never hand-write wallet rows.** Money moves only through platform doors (`fn_seed_horses_to_floor`, `fn_member_leave_to_treasury`, `fn_spin_deactivate`, and so on).
- **Horses are players (CLAUDE.md 10.5).** Same rules, same pay, same timers.
- **Root fixes only (10.11, 10.12).** No sweeps, repair crons, backfills or compensating writes as a fix.
- **No auto table switch (10.6).** **Animations always play.**
- **Lightning control is one door.** `fn_lightning_operator_control(p_cluster_id uuid, p_action text, p_reason text, p_args jsonb)`. Never edit `cash_games` Lightning columns by hand.
- **Changelog.** One new file per change at `docs/changelog/YYYY-MM-DD-slug.md`. Never append to `MIGRATION-CHANGELOG.md`.
- **Law tests** (`*.law.test.*`) each need a file in `docs/laws.d/`.
- **Commit trailers** (end every commit message):
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015XxknTjcJzwq56CE7kd1kR
  ```
  Use your own session URL if you are a different session. PR bodies end with the Claude Code generated line and the session URL.
- **Never schedule anything on the Claude scheduler (10.85).**
- **The auto-mode safety classifier** blocks production actions that are not explicitly approved: workflow dispatches that change production, migrations that move chips beyond approved amounts, fleet policy changes, Lightning installs, roster edits. When blocked: stop, explain in one short message, and ask Dan for approval in his own words. Never work around it.
- **Do not touch the global fleet policy row** unless Dan tells you to. Only the pilot club policy row is yours.

## 3. Production State At Handoff

### 3.1 The Pilot Club

| Field | Value |
| --- | --- |
| Name | Lightning Internal Pilot |
| Club id | `e14bc9f7-736d-425f-8f2c-e78305ebac1d` (slug `lightning-internal-pilot-95087`) |
| Visibility | `is_public=false`, `requires_approval=true`, no union |
| Owner | `2d1cd6c3-5700-4af9-a271-d4863fdab20d` (service identity) |
| Treasury | 84,830.64 (read 17:25 UTC) |
| Member wallets total | 14,516.14 (read 17:25 UTC): 72 horses at about 200 each plus owner |
| Spins | Off (`spins_enabled=false`, Spin pool inactive) since migration `20261015152535` |
| House board | Yes: added to `fn_ca_house_board_allows_automation` by Dan's ruling (migration `20261015032740`) |
| Fleet policy (club row) | `occupancy_bias` 9 (migration `20261015141154`) |
| Roster | Owner plus 72 horses: 50 `cash` lane, 22 `both` lane, all `role='player'`, `status='active'`. No other humans. |
| Designated outsider (for access proofs) | `00bc0957-1913-4beb-a4d1-acab94950690` ("tacomaadam"), a horse that is not a member |
| Pilot creation request id | `84ad2b53-990b-4fae-91cf-e7fd5509d105` |

### 3.2 The Pilot Games (Lightning Clusters)

| Field | 6-max | 9-max |
| --- | --- | --- |
| Name | Lightning Pilot NLH 6 | Lightning Pilot NLH 9 |
| Cluster (cash_games) id | `babb43f1-368e-406f-a97a-a0d5013648b2` | `3330ff9f-76ec-4487-b0c9-fc8ad8c2fdbb` |
| Blinds, buy-in | 0.01/0.02, 0.80 to 4.00 | 0.02/0.04, 1.60 to 8.00 |
| Main table | `d78448e2-42da-4bd0-b702-98f8b37d6da7` | `a84ebe4c-020e-41d4-bd2c-898b4c93b7bc` |
| Feeder table | `f018bc61-69d7-4184-81ad-8a8d9e0118d9` (closed) | none |
| Private | `ruleset_snapshot.options.is_private=true` | same |
| `shadow_window_ms` | 60000 (op `aaf6c3a2-b098-4d65-8e47-647a6834900b`) | 60000 (op `fbb0c5d2-5e32-4852-88a1-2077e620a4c3`) |
| Integrity telemetry | on (op `b5e5c106-183e-4f9c-a37b-d72189567369`) | on (op `5ded3c91-dcb0-437a-b192-b072ec7b8ac9`) |
| Thresholds (on / off) | 18 / 12 | 27 / 18 |
| Stage 1 applied | 17:07 UTC, run 38773675895, operation `816d4942-2a60-47ec-a7a5-4fc89499d97c` | same |
| Now | `lightning_enabled=true`, worker `shadow`, `lightning_shadow_matcher` on, shadow version `m1-port`, live matcher `m1`, `cluster_mode='must_move'`, state `dormant`, 0 seated | same |
| Readiness after Stage 1 | `insufficient_evidence`: `WORKER_SHADOW_ONLY`, `NO_AA_CALIBRATION`, `NO_LATENCY_EVIDENCE` (all accepted for Stage 1) | same |

### 3.3 The Classic Games In The Pilot Club (Being Closed)

Nine 0.50/1.00 cash games, all 0 seated, main tables already `closed` by the 16:55 wallet reset but the games still `enabled=true`, `state='live'`:

| Game | Cluster id | Main table |
| --- | --- | --- |
| Classic NLH | `e639c83c-f66a-42f9-9ea1-38eed4e26f27` | `b8e47104-0791-4977-958d-992a6954e3e4` |
| Classic FLH | `60178ffc-883c-4357-b79e-52ccade254ee` | `ee3f3551-1865-4a82-9b1f-8a4f49763237` |
| Classic PLO4 | `abac480c-f049-4e2a-9d62-958304b8188f` | `d2440ad5-f2e7-4e9b-b292-fdd0ea53809b` |
| Classic PLO5 | `9869e373-9cfa-4492-aa97-ba5541dbed9e` | `660d6f21-9c0e-4926-b231-3fdd62858591` |
| Classic PLO6 | `36d337b4-9b1b-434b-92fd-b6ed33e0e3c9` | `2ffc6747-9bcb-4fc0-8fe1-c5a3b29bcad7` |
| Classic PLO8 | `037bc558-ead6-4143-96e4-3e2d641d0daa` | `10f94f40-cfd9-4153-bb2d-bbdab87c61f9` |
| Classic FLO8 | `966d8e6b-74c0-42cd-90f2-743ce7378fde` | `a262d787-4e03-4dc7-b47b-62231efacaf8` |
| Classic Short Deck | `36e26d8d-ca2f-4f32-9f20-3b224796075f` | `c1872504-6e92-4fb9-9273-9730d3179a55` |
| Classic Pineapple | `da86d705-d554-402a-845c-b090d0c72958` | `35085133-43bc-46b2-b621-3a0b335a2318` |

Why they matter: an enabled game is stake supply to the horse fleet (`HorseFleetManager.ts` builds `bandsWithAGameByHost` from every open table of an enabled game). Their 'low' band supply stopped the pilot's low and mid band horses from projecting down to the micro pilot games (`projectStakeBandOnto` in `HorseBehavior.ts` steps a horse down only when its own band has no game on that host). That is why the pilot fill stalled at 8 and 8. Dan approved closing them at 12:19 Chicago. Fix: PR #6992 (section 4.1). Also present in the pilot: 3 "Daily 25 Chip Freezeout" MTTs in REGISTERING with 0 players. Tournaments are not cash stake supply, so they do not block; leave them unless a later fact says otherwise.

### 3.4 The Platform-Wide Fleet Shutdown (Another Session's Operation)

- At 16:52:38 UTC another session (actor `47965354-0e56-43ef-931c-ddaab82af765`) set the GLOBAL `ca_horse_fleet_policy` row `enabled=false`. Its note: "Owner horse wallet reset (Dan, 2026-10-15): fleet off from the 16:55 UTC break for one hour while every cash table is closed and each horse wallet is reset to 10,000. Restore enabled=true afterwards."
- All 453 cash seats on the platform (16 in the pilot) were vacated at 17:01 UTC. Heartbeat reason: `fleet_disabled`.
- At 17:25 UTC the pilot horse wallets were still about 200 each (total 14,516.14). If the reset reaches the pilot, each horse will hold 10,000 and the treasury and wallet numbers above are stale: re-read them, and the bankroll gate (`canSit`) and aggregate exposure gate stop mattering for the pilot.
- **Do not change the global row.** Wait for the other session to restore `enabled=true` (expected around 18:00 UTC). Check with:
  ```sql
  select scope, scope_id, enabled, updated_at, notes from ca_horse_fleet_policy
   where scope='global' or scope_id='e14bc9f7-736d-425f-8f2c-e78305ebac1d';
  ```
- If it is still off long after its stated hour, ask Dan in one line whether to wait or proceed; do not flip it yourself.

### 3.5 Populated House Board Clusters (Used By The Qualification Report)

Before the shutdown: `563279fc-c09a-48a6-b487-c4f34f289095` (NLH 1/2 Madness, 6-max, Midway), `195fd21c-c0ca-40d8-ad89-1ab069320e87` (NLH 1/2 Action, 6-max, 54 seated), `bc1a347f-2b85-49df-b3b3-40a498a6e51b` (NLH 1/2 Classic, 9-max, 80 seated). Re-read after the fleet returns.

## 4. Everything Done (With Evidence)

### 4.1 Open: PR #6992 (Classic Games Closed)

- Branch `lightning-pilot-classic-games-closed`. Files: `supabase/migrations/20261015172330_lightning_pilot_classic_games_are_closed.sql`, `docs/changelog/2026-10-15-lightning-pilot-classic-games-are-closed.md`, this handoff.
- The migration closes the nine games by id with the write `fn_close_managed_game('table', main)` makes (`enabled=false`, `state='dormant'`, `closed_at`, `closed_by` owner) and closes their tables. It calls the door itself as the owner (via `request.jwt.claims`) for any main table still open; the door answers `already_closed` on a closed table and would leave the game enabled, which is why the direct write exists. Refuses on any seat, active session or waitlist entry. Asserts both pilot games, every other club's games, pilot wallets and treasury unchanged.
- Rolled-back probe at 17:25 UTC passed: door calls 0, wallets 14,516.14 and treasury 84,830.64 unchanged.
- Remaining: required CI green, protected squash merge, install (section 6.3), then verify with its `@live-proof` and that the fleet heartbeat no longer shows the pilot's horses refused on band.

### 4.2 Phase 1: Operator Configuration Controls (Done And Verified)

- PR #6769 (sha `12ea01a4`): `fix(lightning): own operator requests and verify control receipts`.
- Installed migrations: `20261012040746_lightning_shadow_calibration_window_control`, `20261012112753_lightning_integrity_telemetry_operator_control`, `20261012143829_lightning_operator_request_ownership_is_global`.
- Files: `src/lightning/lightningOperatorControls.ts`, `scripts/ops/prepare-lightning-private-pilot.mjs` (+ test), `tests/lightning/lightning-phase-13-operator-controls.test.tsx`, `docs/changelog/2026-10-12-lightning-phase1-deep-review.md`.

### 4.3 Phase 2: Private Pilot Admission And Qualification Report (Built; Two Items Open)

- PR #6881 (sha `2afacf72`): 6-max and 9-max pilot setup, the qualification report, entry-guidance fixes. Files: `.github/workflows/lightning-pilot-qualification.yml`, `scripts/ops/lightning-pilot-qualification.mjs` (+ test), `scripts/ops/prepare-lightning-private-pilot.mjs`, `src/lightning/lightningSession.ts`, `src/pages/LightningEntryPage.tsx`, `tests/lightning/LightningEntryPage.test.tsx`, `docs/changelog/2026-10-12-lightning-phase2-private-pilot.md`.
- Setup workflow `.github/workflows/lightning-private-pilot-setup.yml` run 38670442619: success (created the 9-max).
- Qualification run 38671072947: success; artifact `lightning-pilot-qualification-report`. Owner allowed (`club_member`), outsider refused (`membership_required`) on both pilot tables. Blockers it listed then: `NO_RECORDED_SETTLED_LIGHTNING_HANDS`, `WORKER_OFF`, `NO_AA_CALIBRATION`, `NO_LATENCY_EVIDENCE`, `PARTICIPANTS_NOT_ESTABLISHED`, `ENGINE_FULL_REVISION_NOT_ESTABLISHED`, `AUTHENTICATED_OUTSIDER_BROWSER_AND_SOCKET_PROOF_REQUIRED`, `ALL_54_RELEASE_GATES_NOT_CERTIFIED`. `WORKER_OFF` is now cleared; `PARTICIPANTS_NOT_ESTABLISHED` should clear with the horse roster.
- Open: R02 authenticated outsider browser and WebSocket proof; rerun the report after the fleet returns.

### 4.4 Pilot Roster, Funding And Fill Fixes (All Installed)

| PR | Migration | What | Installed |
| --- | --- | --- | --- |
| #6910 | `20261015032740_the_lightning_pilot_club_is_a_house_board` | Pilot added to `fn_ca_house_board_allows_automation`; 72 horses admitted via `join_club` source; funded to 40 | yes |
| #6910 | none | `scripts/ops/lightning-pilot-stage.mjs` (+ test), `.github/workflows/lightning-pilot-stage.yml`; setup script accepts owner plus admitted horses | merged |
| #6919 | `20261015053941_..._funded_to_the_fleet_bankroll_floo` | Top-up to 200; refused by the ledger guard; marked `SUPERSEDED BY 20261015093554` | never applied |
| #6930 | `20261015093554_horse_treasury_funding_locks_the_wallets_it_reads_pilot_top_` | Root fix: `fn_seed_horses_to_floor` locks the club row and horse wallets first; then top-up to 200 (moved 11,826.30; treasury 96,820.00 to 84,993.70) | 13:06 UTC |
| #6956 | `20261015121542_lightning_phase_12_load_chaos_a_seat_waits_for_the_mode_chan` | Race fix: per-cluster advisory lock `hashtextextended('lightning_cluster_mode:'||cluster_id,0)`, shared in the seat trigger, exclusive in the three mode-commit functions. Regression `scripts/dev/fixtures/lightning-mode-change-race.sql` (M1 to M6) in section MR of `scripts/dev/test-lightning-phase12-load-chaos.sh` | 15:24 UTC |
| #6963 | `20261015141154_lightning_pilot_tables_are_kept_full` | Pilot club fleet policy `occupancy_bias` 9 | 15:05 UTC |
| #6971 | `20261015152535_lightning_pilot_spins_are_switched_off` | `fn_spin_deactivate` on the pilot | 16:05 UTC |
| #6971 | `20261015152540_lightning_pilot_roster_plays_cash` | 25 events-lane horses left via `fn_member_leave_to_treasury`; 25 idle cash-lane horses joined; all funded to 200 | 16:26 UTC |
| #6982 | none | Stage tool reads readiness after preparation, before `enable_lightning` | merged 16:53 |

Race fix verified postimage `md5(prosrc)`: trigger fn `b6c664923a5407e83a1f41de840fa9a7`, commit_lightning `4d0f4e028c7a0411ac19ca598167a0cb`, abort_pending_off `4ed812c85c1e419f1d6e868463409629`, commit_must_move `0fa9c8d280bcbfd48a72375869b5cf87`.

### 4.5 Horse Retention Package (Not Lightning, Closed)

PR #6883 merged (`8d2e9884`), migration `20261014231333` installed by run 38658161738; its seq-scan defect fixed by the other session's #6890 (`20261015001555`); my duplicate #6889 closed. `20261012111944_audit_default_off_flags_are_not_silent_layers` installed by run 38658480529. Backlog caught up, acceptance 0 raw rows on retired hands, prune md5 `70231d2cc066971c13a269b5cc374be8`.

## 5. Everything Left, Phase By Phase

Phase reporting rule (`FUNCTIONAL-BUILD-PHASES.md`): report "Phase N Of 8 Is Done" only after implementation, wiring, checks and installed/published/live proof. Otherwise state the exact remaining outcome.

### 5.1 Phase 1: Done

### 5.2 Phase 2: Finish

- 2a. R02: authenticated outsider proof in a real browser and a real WebSocket (discovery, pending membership, direct URL, join attempt, socket refusal) against both pilot tables, with the designated outsider and the owner. Use an authorized synthetic session for the outsider; never invent an identity, never Dan's account. Gates L35, L49.
- 2b. Rerun `lightning-pilot-qualification.yml` with `designated_outsider_id=00bc0957-1913-4beb-a4d1-acab94950690`, `populated_cluster_ids` set to the three clusters in 3.5 (re-read first), `report_from` the Stage 1 start time. Record which blockers remain; `PARTICIPANTS_NOT_ESTABLISHED` and `WORKER_OFF` should be gone.

### 5.3 Phase 3: Calibration And First Real Lightning Hands (In Progress)

Order:
1. **3a. PR #6992** merged and installed (4.1).
2. **3b. Fleet back on** (3.4). Then confirm the pilot fills: live eligible at least 18 on the 6-max and 27 on the 9-max. Read `fn_cash_cluster_live_eligible(cluster)` and seated counts. Read `ca_horse_fleet_heartbeat` (`detail->>'reason'`, `detail->'gates'`) and `ca_horse_fleet_state` for the 72 pilot horses to see why any horse is not seated (band, rest day, daily cap, activity window `isActiveNow`, four-game limit, one seat per game).
   - If still short after the Classic closure: the next levers each need Dan's own-words approval: swap horses that are busy elsewhere for idle cash-lane horses with suitable activity windows (same pattern as `20261015152540`), or add horses. Do not change the global policy.
3. **3c. Conversion.** With `lightning_enabled=true`, the cluster tick converts a cluster to `lightning` once live eligible reaches the on threshold. Watch `cash_games.cluster_mode` go `must_move` to `pending_on` to `lightning`. The race fix (#6956) is now under real load: watch for `lightning_drive_error` and any orphan.
4. **3d. Stage 1 calibration.** The 60-minute shadow time box starts at conversion (the shadow worker forms no hands, so pool players get no hands while it runs). Collect at least 30 nonempty m1 vs m1-port comparisons with verdict `calibrated` (mean quality delta within 1 point). Read via `lightning-pilot-stage.yml` with `stage=report` (calls `fn_lightning_shadow_report`, service role only). Also confirm: no `lightning_drive_error`, no reaper failure, no freeze, no integrity spike, every pool reconcile row `ok`.
   - If 60 minutes pass without calibration, or the verdict is `calibration_bias`: dispatch `stage=drain` (expect phase complete, outcome drained, eight `lightning_drain_step` events), then `set_worker_mode off`. For bias: `disable_matcher_version m1-port`, fix the port, repeat.
5. **3e. Stage 2 rehearsals before form traffic** (ROLLOUT Stage 2): `pause` then `resume`; `disable_joins` then `enable_joins`; `freeze` then platform admin `unfreeze`; `rollback_matcher_version` answered `ALREADY` while m1 is live. The `drain` with a hand mid-deal is done once form mode deals (Phase 5 R17).
6. **3f. Stage 2 form mode.** Dispatch `lightning-pilot-stage.yml` `stage=form` with a NEW operation uuid and a reason. The tool gates readiness: it accepts only `NO_LATENCY_EVIDENCE` and `WORKER_SHADOW_ONLY`, so it refuses until calibration is recorded. Optionally keep the shadow matcher on with `set_matcher_version {version: m2, role: shadow}` for candidate evidence (informational only).
7. **3g. First real hand.** Verify an instance formed, seats reserved, the hand dealt through the existing engine and settled: `hand_history` row, settlement, rake, wallet conservation, replay via `fn_lightning_operator_hand_replay`.
8. Report "Phase 3 Of 8 Is Done" only after 3g.

Dan already approved Stage 1 and Stage 2 on the pilot ("run Stage 1 and Stage 2 on the pilot"). That approval covers the stage workflow dispatches for shadow, report, form and drain on the two pilot clusters.

### 5.4 Phase 4: Complete Player And Financial Flows

- R06: 9-max coverage (target exists; needs live play).
- R07: conversion and hysteresis across 18/12 and 27/18; concurrent joins and exits; pending conversion; low liquidity; MUST-MOVE rebuild. No stack, baseline, stay-clock, rejoin or session-history change caused by conversion (L04 to L16).
- R08: dealing, betting, showdown, Fast Fold, Fold and Watch, next-hand arrival, time bank, pre-actions; no stale action across hands (L21, L22, L24, L25, L28).
- R09: multi-table and device limits (desktop, tablet, mobile at 375px), independent hands and timers, manual table selection, reconnect, touch controls; never auto-switch tables (L23 to L27, L41, L54).
- R10: wallet, cash session, rake, opt-in rebuy and cash-out conservation; duplicates idempotent (L01 to L03, L11 to L15, L32, L33, L38).
- R11: matcher fairness and pool behavior under active play: P0 to P6, blind and button fairness, opponent diversity, thin-pool fallback, queue aging, churn, no starvation (L17 to L20, L39).

### 5.5 Phase 5: Recovery, Security And Operator Operation

- R12: disconnect and reconnect during idle, reservation and dealing; duplicate connection; stale or revoked session; restart and the :55 maintenance break (L26 to L28, L32, L33, L48).
- R13: history, event ledger, replay and forensics agree with settlement; card visibility correct (L29 to L31, L45).
- R14: auth, RLS, actor scope, hidden cards, spectator and replay visibility, duplicate request protection, the same secure RNG (L34, L35).
- R15: responsible gaming: excluded or ineligible players, limits, sit-out, leave, disconnect, stop conditions; auto-rebuy is off, qualify only where enabled, same for horses and humans (L37, L38).
- R16: operator dashboard and every control with pending, unknown, replayed and refused outcomes, authority, reasons and event ids (L43 to L45, L49, L51).
- R17: mid-hand drain and rollback rehearsal: the hand finishes and settles, sessions close, every player returns with stack intact, MUST-MOVE rebuilt, eight drain step events (L11 to L16, L43, L44, L48, L51).
- R18: telemetry and alerts reflect real events; integrity telemetry is on in the pilot; `lightning-alert-sweep-1m` active (L36, L39, L40, L45, L50).
- Also: the race-fix gaps the #6956 author recorded: a seat without an open cash session committing after the orphan check makes the conversion roll back whole (next drive aborts PENDING_ON cleanly); a REPEATABLE READ seat writer would still race (Supabase uses READ COMMITTED); `fn_cash_clusters_tick_all` can still deadlock across clusters (pre-existing); the `tests/sql/diamond-concurrency-doors` snapshot of the seat trigger is stale and should be refreshed.

### 5.6 Phase 6: Measured Performance And Capacity

- R19: real latency samples on all eight configured legs, minimum sample counts, recent windows, p95 under every ceiling; optimize only measured bottlenecks (L40, L41).
- R20: capacity, surge and overload on the serving engine; event loop, DB and reservation pressure; admission limits (L42, L47, L48). The engine is one core; `/health.equityGovernor.scale < 1` means it is hot.

### 5.7 Phase 7: Active-Play Release Coverage

- R21: 5,000 completed Lightning hands with conservation and replay, zero `LIGHTNING_*_MOVED_MONEY`, no unexplained freeze or orphan reservation, no open high integrity signal, latency coverage, readiness `go`. At least five participating clubs and both table sizes, in bounded batches. No calendar waits (removed 2026-10-12). No fabricated hands.
- Stage 3 (limited clubs) happens here: per cluster, readiness `go` read and recorded immediately before `enable_lightning`; club control members must know drain, pause and joins. Enabling Lightning in public clubs is a new outward action: get Dan's own-words approval naming the clubs.

### 5.8 Phase 8: Final Launch Verification

- R22: evidence-backed review of every gate L01 to L54 in `FINAL-RELEASE-REVIEW.md`; final browser and live-table checks; temporary account cleanup; verified serving identities (engine and client SHAs); operator and player documentation; explicit GO verdict; enable qualified targets through the audited door (Stage 4). Dan approves general availability in his own words.

### 5.9 Release Gate Catalog (L01 To L54)

L01 wallet authoritative; L02 cash session authoritative; L03 rake authoritative; L04 every game starts MUST-MOVE; L05 6-max 18 threshold; L06 6-max 12 reversion; L07 9-max 27 threshold; L08 9-max 18 reversion; L09 hysteresis; L10 conversion races safe; L11 stacks invariant; L12 baseline invariant; L13 stay clock invariant; L14 rejoin obligations invariant; L15 VPIP and session history continuous; L16 MUST-MOVE rebuild; L17 matcher P0 to P6; L18 BB fairness; L19 position fairness; L20 repeat suppression without starving; L21 Fast Fold; L22 Fold and Watch; L23 multi-table limits; L24 no pre-action leak; L25 time bank; L26 disconnect and reconnect; L27 duplicate connection; L28 formation barrier; L29 history survives instance destruction; L30 replay; L31 event ledger; L32 settlement idempotency; L33 reservation idempotency; L34 RNG; L35 hidden cards; L36 integrity telemetry; L37 responsible gaming; L38 auto-rebuy where enabled; L39 pool health; L40 latency telemetry; L41 first-hand path; L42 surge protection; L43 emergency drain; L44 cluster freeze; L45 replay and forensics; L46 shadow matcher; L47 load test; L48 chaos test; L49 operator dashboard; L50 alerts; L51 rollback tested; L52 documentation; L53 no prohibited competitor terminology; L54 final regression green. Each gate's qualification files are in `docs/lightning/release-gates.json`.

## 6. How To Do Things

### 6.1 Tool Access

- This container's `gh` token can read, push and merge, but cannot dispatch workflows or rerun jobs (403). Use `gh api` REST; GraphQL is refused here (so `gh pr create` fails; create PRs with `gh api repos/Smarter-Poker/Smarter-Poker-Club-Arena/pulls -f head=... -f base=main -f title=... -f body=...`).
- Dispatch and rerun through Dan's Mac: the remote device tool `counselors__host_terminal` has an authenticated `gh` (cwd `/Users/smarter.poker`). It times out at about 60 seconds; keep commands short. Read Actions logs there too (the container cannot download log blobs).
- Container `curl` to `smarter.poker` and `ca-static.smarter.poker` is blocked by the proxy.
- Supabase MCP `execute_sql` runs as postgres: fine for reads; Lightning RPCs answer `NOT_AUTHORIZED` to postgres (they need the authenticated owner or service role, which the workflows supply).
- `npm` installs in the container fail through the proxy; CI runs the tests.

### 6.2 CI And Merge

- Required checks: CSS Beat E2E, Client Unit Tests (vitest), Money trigger declaration authority, Production Build, Server Engine (typecheck + tests) (aggregate that also needs the Accounting transactions PostgreSQL 17 shards), TypeScript Check.
- Runners queue 60 to 90 minutes. Do other work meanwhile.
- Merge: `gh api -X PUT repos/Smarter-Poker/Smarter-Poker-Club-Arena/pulls/N/merge -f merge_method=squash -f sha=<head>`.
- "Installed and merged migrations agree" is red main-wide for other teams' migrations; it is not required and not Lightning's.
- Any edit to `.github/workflows/ci.yml` must re-record the six pinned qualification bindings (bytes and sha256): `scripts/qualification/weekly-initial-selector/source-binding.json`, `scripts/qualification/original-flow-eligibility/source-binding.json`, `scripts/qualification/cash-native-hosted.manifest.json`, `scripts/qualification/weekly-standalone-selector/source-binding.json`, `scripts/qualification/weekly-cohort-cutoff/source-binding.json`, `scripts/qualification/cash-original17/source-binding.json`. Current `ci.yml`: 225,112 bytes, sha256 `bd79793d22be38b73aa77ace9091c975c772494623da76b903b5f26bdfecd853`.
- Accounting shard flakes: rerun failed jobs from the host terminal after the run completes.
- After GitHub auto-deletes a merged branch, the stop hook flags the local branch: confirm main has the files, then delete the local branch.

### 6.3 Installing A Merged Migration

Outside minute :50 to :03 UTC, from the host terminal:

```
gh workflow run apply-merged-migration.yml -R Smarter-Poker/Smarter-Poker-Club-Arena --ref main -f migration=<file name>
```

Then confirm with `SELECT version, name FROM supabase_migrations.schema_migrations WHERE version='<version>'` and evaluate the file's `@live-proof`. A refusal "engine maintenance announcement owns the DDL boundary" is a transient lock: retry once explicitly, never in a loop.

### 6.4 The Stage Tool

- Workflow `.github/workflows/lightning-pilot-stage.yml` (dispatch only, main only). Inputs: `stage` (`report`, `shadow`, `form`, `drain`), `operation_id` (uuid; reuse the same one to retry safely), `reason` (at least 12 chars), `targets` (`6,9`, `6` or `9`). Artifact `lightning-pilot-stage-<stage>` holds `lightning-pilot-stage.json`.
- Script `scripts/ops/lightning-pilot-stage.mjs`: `STAGE_PLAN` shadow prepares `set_flag lightning_shadow_matcher true`, `set_matcher_version m1-port shadow`, `set_worker_mode shadow`, then gates readiness, then `enable_lightning`; form gates then `set_worker_mode form`; drain is ungated `drain`; report reads only. Request ids are `stageRequestId(operation, cluster, action)`. It refuses anything but the two named private pilot games.
- Example: `gh workflow run lightning-pilot-stage.yml -R Smarter-Poker/Smarter-Poker-Club-Arena --ref main -f stage=report -f targets=6,9`.

### 6.5 Control Door Reference

Actions: `pause`, `resume`, `disable_joins`, `enable_joins`, `drain`, `freeze`, `unfreeze`, `enable_lightning`, `disable_lightning`, `set_matcher_version`, `disable_matcher_version`, `enable_matcher_version`, `rollback_matcher_version`, `set_flag`, `set_worker_mode`, `set_shadow_window`, `set_integrity_telemetry`. Arg keys: `request_id`, `flag`, `value`, `version`, `role`, `mode`, `shadow_window_ms`, `actor_id`. Flags: `lightning_v1`, `lightning_fast_fold`, `lightning_fold_watch`, `lightning_multi_table`, `lightning_pool_health`, `lightning_repeat_suppression`, `lightning_session_stats`, `lightning_shadow_matcher`, `lightning_auto_rebuy`, `lightning_adaptive_liquidity`. Matcher versions `m1`, `m1-port`, `m2`; live `m1`.

Readiness `fn_lightning_rollout_readiness(cluster)` returns `verdict` (`go`, `insufficient_evidence`, `no_go`), `reasons[{code, severity, detail}]` and `evidence`. Reason codes: `AA_CALIBRATION_BIAS`, `CLUSTER_BUSY`, `CLUSTER_FROZEN`, `CLUSTER_NOT_READY`, `GAME_DISABLED`, `INTEGRITY_HIGH_SIGNALS_OPEN`, `INVARIANT_FAILED`, `LATENCY_ABOVE_CEILING`, `MATCHER_VERSION_INVALID`, `MIGRATION_LEDGER_UNREADABLE`, `MIGRATIONS_MISSING`, `NO_AA_CALIBRATION`, `NO_LATENCY_EVIDENCE`, `NOT_A_MUST_MOVE_GAME`, `NOT_AUTHORIZED`, `NOT_FOUND`, `OPEN_ALERTS`, `WORKER_OFF`, `WORKER_SHADOW_ONLY`.

### 6.6 Horse Fleet Mechanics That Decide Whether The Pilot Fills

- `server/src/services/HorseFleetManager.ts`: seeding cycle every 30 seconds.
- Bankroll gate `HorseBankroll.ts` `canSit`: roll at least reference buy-in times `buyInsToSit` (nit 40, standard 25, gambler 12). Reference buy-in 2.00 (6-max) and 4.00 (9-max). Aggregate exposure: roll times fraction (nit 0.03, standard 0.05, gambler 0.10) times 4, across all clubs.
- Four-game limit `MAX_TABLES_PER_HORSE=4` (counts tournament seats and bookings). One seat per game per horse.
- Lanes `profiles.horse_profile->>'lane'`: `events` never sits at cash.
- Stake bands `HorseBehavior.ts` `stakeBandAllows` / `projectStakeBandOnto`.
- Activity window `isActiveNow` (10 to 17 hours a day by hash), `rest_day`, `daily_cap`.
- Policy: `ca_horse_fleet_policy`, set via `fn_ca_fleet_set_policy(scope, scope_id, patch, actor, reason)`, read via `fn_ca_fleet_policy_effective(club)`.
- New cluster tables open by the `fn_cash_cluster_tick` rule (migration `20260906015029`, lines 363 to 384).

## 7. Approvals Dan Has Given (Verbatim)

1. "Approved: add the Lightning pilot club to the horse allowlist, admit 72 horses, and fund them from its treasury."
2. "Approved: top up the 72 pilot horses to 200 chips each from the pilot treasury (about 11,534 chips."
3. "Approved: set the Lightning pilot club's horse fleet policy to keep its tables full (occupancy_bias 9), pilot club only."
4. "Approved: install the Lightning race fix, turn off Spins in the pilot club, swap the 25 tournament-only pilot horses for 25 cash-only horses funded to 200 from the pilot treasury, and run Stage 1 and Stage 2 on the pilot."
5. "Approved: close the 9 empty Classic games in the Lightning pilot club. and anything else thats blocking you needs to get fixed."

Anything beyond these (new horses, more chips, policy changes outside the pilot row, enabling Lightning in any public club, general availability) needs a new approval in his own words.

## 8. Definition Of Go-Live

Lightning is live when: Phases 3 to 8 are each reported done with evidence; the pilot has 5,000 settled hands meeting the Stage 2 exit criteria; Stage 3 covered at least five clubs and both sizes; every L01 to L54 gate has executed, installed or live evidence in `FINAL-RELEASE-REVIEW.md`; readiness is `go` on each target immediately before its `enable_lightning`; and Dan has approved general availability.
