# Lightning Rollout Plan

The staged path from dark to general availability, the evidence that must exist before each stage begins, and the way back from each stage. Written for Lightning Phase 13 (specification Phase 22) on 2026-10-09. The machinery it relies on is migration `20261009235505_lightning_phase_13_rollout_drain_and_rollback.sql`: the operator control door `fn_lightning_operator_control`, the emergency drain, matcher version rollback and the readiness verdict `fn_lightning_rollout_readiness`.

Enabling Lightning for real players is the single biggest outward action in the program. Every stage is entered by an operator action through the control door (reason required, a fresh request id, one audited `operator_<action>` event), never by editing a row by hand, and every stage has a rehearsed way back.

## Ground Rules For Every Stage

- **One door.** Every change is `fn_lightning_operator_control(cluster, action, reason, {request_id, ...})`, called by a platform admin, a club control member (owner, co_owner, admin) or the service. Hand-written config or `cash_games` updates are out of bounds.
- **Never strand a player.** Turning Lightning off on a live Cluster is always the drain (`drain`, `disable_lightning` or `set_flag lightning_v1 false`): joins and formation stop at once, a dealing hand is never cut, every player is released to the seat they never left, MUST-MOVE is rebuilt through the asserted reversion, and all eight steps are events.
- **Readiness first.** Before a Cluster's `enable_lightning`, `fn_lightning_rollout_readiness(cluster)` is read and recorded. `go` is required from Stage 3 on. Stage 1 and Stage 2 may proceed on `insufficient_evidence` only when every reason is evidence-level and is the evidence that stage exists to produce (`NO_AA_CALIBRATION`, `NO_LATENCY_EVIDENCE`, `WORKER_SHADOW_ONLY` in Stage 1). A `no_go` stops the stage.
- **Laws hold throughout.** Horses are players (Law 10.5); no automatic table switch (Law 10.6); no money moves on a mode transition; integrity, shadow, quality and latency data never feed matchmaking; no payload carries a hole card; player-visible terms only.
- **The engine first.** The live engine release must contain the Phase 13 engine change (discovery of `paused` and `draining`, the joins and drain behaviour, the matcher and flag keys) before any Cluster leaves Stage 0. An older engine stops a worker whose Cluster leaves `lightning` / `pending_off`, which would void unsettled hands. Verify with `git merge-base --is-ancestor <engine merge> <shipped target_sha>` against `ca_engine_deploy_attempts`.

## Stage 0: Dark

The state on 2026-10-09: all 166 Clusters `must_move`, `lightning_enabled` false, no pool session open, `worker_mode` off everywhere.

**Go / No-Go Evidence**

- Every Lightning migration applied, every live proof true except the documented expected-false list (`bin/proofs.sh` over each file), and `fn_lightning_rollout_readiness` reporting `migrations.missing = []` and every `invariants` key true.
- The Phase 13 engine and client releases live and verified (engine `/health` liveness ok, latest `table-socket-probe` ok, build-info SHAs containing the merges).
- `lightning-alert-sweep-1m` active and no open `lightning_alerts`, `lightning_formation` or `lightning_settlement` page.
- The harness evidence of the phase: `scripts/dev/test-lightning-phase13-rollout-drain.sh` and the Phase 12 load, stress and chaos rig over the Phase 13 chain green in CI.

**Rollback**

- Nothing to roll back: Stage 0 is the rollback target of every later stage.

## Stage 1: Shadow Worker On One Cluster

One internal pilot Cluster (below), Lightning enabled with the worker in shadow mode and the shadow matcher on, to measure the matcher against its own port (the A/A calibration) and the engine's latency legs on real infrastructure.

**Configuration (through the door)**

- `set_flag {flag: lightning_shadow_matcher, value: true}`, `set_matcher_version {version: m1-port, role: shadow}`.
- `set_worker_mode {mode: shadow}`.
- `enable_lightning`.

**Go / No-Go Evidence**

- Readiness on the pilot Cluster: no blocking reason; `WORKER_SHADOW_ONLY`, `NO_AA_CALIBRATION` and `NO_LATENCY_EVIDENCE` are expected and accepted here.
- The pilot Cluster is non-public (`club_is_public` false, or the game marked private) and seats only internal accounts and horses.
- A shadow worker plans and forms nothing, so pool players receive no hands while it runs. The stage is time-boxed: at most 60 minutes, enough for 30 or more comparison windows (`shadow_window_ms` 60000 → 300000).

**Exit Criteria (Required For Stage 2)**

- `fn_lightning_shadow_report(cluster)` shows the m1 against m1-port pair with at least 30 comparisons and verdict `calibrated` (mean quality delta within 1 point).
- Latency windows recorded for the Cluster with every leg's p95 under its `alert_latency_p95_ms` ceiling.
- No `lightning_drive_error`, no reaper failure, no freeze, no integrity spike in the window; every pool session's reconcile row `ok`.

**Rollback**

- `drain` (reason required), then `set_worker_mode {mode: off}`. The drive releases every player to their seat and rebuilds MUST-MOVE; confirm `drain` reaches `phase: complete, outcome: drained` on the dashboard row and the eight `lightning_drain_step` events exist.
- If the A/A verdict is `calibration_bias`: `disable_matcher_version {version: m1-port}` (the engine records no shadow), fix the port, repeat Stage 1.

## Stage 2: Internal Pilot Cluster With Form Mode

The same pilot Cluster, now forming real hands with the live SQL matcher (m1), internal accounts and horses only.

**Configuration (through the door)**

- `set_worker_mode {mode: form}`.
- `enable_lightning` (if drained after Stage 1); keep `lightning_shadow_matcher` on with `shadow_matcher_version` m2 to start candidate evidence.

**Go / No-Go Evidence**

- Readiness `go`, or `insufficient_evidence` with `NO_LATENCY_EVIDENCE` alone (form-mode latency is what this stage produces).
- Stage 1 exit criteria met and recorded.
- Rehearsals done on the pilot Cluster before players are invited: `pause` then `resume` (returns to lightning at the same epoch); `disable_joins` then `enable_joins`; `drain` with a hand mid-deal (the hand settles, every session exits `lightning_drained`, stacks unchanged across the reversion); `freeze` then a platform admin's `unfreeze`; `rollback_matcher_version` answered `ALREADY` while m1 is live.

**Exit Criteria (Required For Stage 3)**

- At least 7 days and 5,000 Lightning hands on the pilot Cluster with: zero `LIGHTNING_*_MOVED_MONEY`, zero unexplained freeze, zero orphan reservation on the dashboard, zero open `lightning_alerts` page older than its resolution, every settled hand's replay check passing (`fn_lightning_operator_hand_replay`).
- Latency p95 under every ceiling over the last `alert_latency_windows` windows, every day.
- No high-severity integrity signal left open.
- Readiness `go`.

**Rollback**

- `drain`; then `disable_lightning` is implied (a drained Cluster ends with `lightning_enabled` false).
- A matcher regression: `disable_matcher_version` for the offending version (the live one rolls back to the previous enabled version) or `rollback_matcher_version`.
- A single feature misbehaving: `set_flag lightning_fold_watch false` or `set_flag lightning_fast_fold false` (the engine's action door refuses that fold with a clear code), `set_flag lightning_auto_rebuy false`, `set_flag lightning_multi_table false`.
- Too many arrivals: `disable_joins` (seated players continue).

## Stage 3: Limited Clubs

Lightning enabled on a small set of Clusters in clubs that opt in, a few Clusters at a time, both 6-max and 9-max.

**Go / No-Go Evidence (Per Cluster)**

- Readiness `go` read and recorded immediately before `enable_lightning`.
- The club's control members have the operator dashboard and know the drain, pause and joins controls.
- The previous batch has run at least 72 hours with the Stage 2 exit criteria holding for each of its Clusters.
- Candidate shadow evidence (m1 against m2) is informational only: the live matcher stays m1 until a matcher change is proposed with at least 30 comparisons and verdict `shadow_leads`, and that change ships as its own reviewed phase, not as a flag.

**Rollback**

- One Cluster: `drain` that Cluster.
- One club: `drain` each of its Clusters (each is its own drain; the dashboard shows progress per Cluster).
- Everywhere: `drain` every Lightning Cluster; Lightning returns to Stage 0 with every player at their seat.

## Stage 4: General

Lightning available to every club whose Clusters pass readiness.

**Go / No-Go Evidence**

- Stage 3 has run at least 14 days across at least five clubs and both table sizes with the Stage 2 exit criteria holding everywhere.
- The Final Release Gate checklist (Phase 14) passes with evidence, including emergency drain, Cluster freeze, rollback, shadow matcher, alerts and the operator dashboard.

**Rollback**

- As Stage 3, Cluster by Cluster or estate-wide. The alert sweep keeps paging on freezes, stuck conversions, drive errors, reaper failures, integrity spikes and latency regressions throughout.

## The Pilot Cluster

The pilot must be a non-public Cluster that no real player outside the team can reach. Read from PokerIQ-Production on 2026-10-09: no non-public club exists (the two clubs with cash games, Midway Union and Deep Stack Society, are public; Diamond Arena is the platform club and has no cash game). Several Midway Union must-move Clusters have had no human seated in 14 days and only horses now (for example NLH 1/2 Action, 6-max, about 53 horses; NLH 1/2 Classic, 9-max, about 81 horses), but they are in a public club, so they are not pilot candidates as they stand. The pilot therefore needs a Cluster made private first (a non-public test club, or the game's `ruleset_snapshot.options.is_private` set through the reviewed path), which is an owner decision recorded before Stage 1.

## Evidence Record

For each stage transition, keep in the change record: the readiness answer (verdict and reasons), the request ids and `operator_*` event ids of every control action, the dashboard rows before and after, the shadow report, the latency windows, and for every drain its eight `lightning_drain_step` events and final `drain` state.
