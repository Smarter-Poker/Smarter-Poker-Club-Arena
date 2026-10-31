# Lightning Rollout Plan

> **Owner update, 2026-10-31: the Lightning Internal Pilot is removed.** Lightning runs live in Midway Union. Owner: "REMOVE THE LIGHTNING INTERNAL PILOT, AND ANY AND ALL TRACES OF IT IF ITS NO LONGER NEEDED FOR ANYTHING." Club 95087 is retired (migration `20261031184340`), and its tooling, workflows, engine seat scope and database objects are gone. Every pilot step, run and target below is history only; nothing here should be dispatched again.

The staged path from dark to general availability, the evidence that must exist before each stage begins, and the way back from each stage. Written for Lightning Phase 13 (specification Phase 22) on 2026-10-09. The machinery it relies on is migration `20261009235505_lightning_phase_13_rollout_drain_and_rollback.sql`: the operator control door `fn_lightning_operator_control`, the emergency drain, matcher version rollback and the readiness verdict `fn_lightning_rollout_readiness`.

Enabling Lightning for real players is the single biggest outward action in the program. Every stage is entered by an operator action through the control door (reason required, a fresh request id, one audited `operator_<action>` event), never by editing a row by hand, and every stage has a rehearsed way back.

## Owner Update: Evidence-Based Progression

On 2026-10-12 the owner removed the fixed pilot and limited-club calendar waits. No minimum elapsed-day or batch-age requirement applies. Advance on completed active-play samples, workload coverage, recovery rehearsals and recorded readiness, not time spent with an empty pool. The retained 5,000-hand target, five-club coverage, calibration and latency sample/ceiling requirements remain. (The "both table sizes" coverage that stood here is superseded by the 2026-10-19 six-seat ruling below.) The bounded shadow-stage time box is a safety limit, not a waiting period. Historical handoffs cannot restore the removed waits.

## Owner Update: Eligible Game Styles

On October 16 the owner confirmed that Lightning is available only for Action and Madness. Classic remains normal poker. The earlier Classic private pilots are ineligible and remain disabled. Their historical evidence is retained, but cannot qualify the corrected Action 6-max and Madness 9-max targets. Provision corrected targets through the existing authenticated setup route, preserving Classic games and sessions; record their actual IDs and fresh evidence before activation.

## Owner Update: Six-Seat Only (2026-10-19)

On 2026-10-19 at 19:44 Central the owner ruled, verbatim: "classic games never get lightning games, only action and madness, make all lightning games 6 handed." Lightning exists only on six-seat (handedness 6) Action and Madness games. This supersedes, as of that date, every requirement in this plan for 9-max Lightning or for coverage of "both table sizes": there is no 9-max Lightning to cover, and the 9-max 27/18 thresholds are retired, not open gates. The 6-max 18/12 thresholds are unchanged. Migration `20261020005222_lightning_only_on_six_seat_action_and_madness.sql` refuses any other size by name (`LIGHTNING_TABLE_SIZE_NOT_ALLOWED`) at the operator door, readiness, thresholds, formation and the hand trigger, and the `cash_games_lightning_six_seat_only` constraint refuses enabling or converting one; the engine and the lobby offer Lightning only at six seats. The earlier Madness 9-max target was retired on 2026-10-17 and stays off; the two Classic games in the private pilot club are switched off through the owner's seat-safe switch. The history below is kept as written.

On 2026-10-22 the owner approved sizing the two private six-seat pilots' thresholds to six-seat pool math: Action and Madness pilots switch ON at 12 and OFF at 8 (`20261022052324_lightning_pilots_switch_at_six_seat_pool_math.sql`; two concurrent six-handed hands to start, one full hand plus turnover to stay on, hysteresis 4). This applies to those two games only; the 6-max default 18/12 is unchanged for every other game. See `docs/changelog/2026-10-22-lightning-pilots-switch-at-six-seat-pool-math.md`.

## Ground Rules For Every Stage

- **One door.** Every change is `fn_lightning_operator_control(cluster, action, reason, {request_id, ...})`, called by a platform admin, a club control member (owner, co_owner, admin) or the service. Hand-written config or `cash_games` updates are out of bounds.
- **Never strand a player.** Turning Lightning off on a live Cluster is always the drain (`drain`, `disable_lightning` or `set_flag lightning_v1 false`): joins and formation stop at once, a dealing hand is never cut, every player is released to the seat they never left, MUST-MOVE is rebuilt through the asserted reversion, and all eight steps are events.
- **Readiness first.** Before a Cluster's `enable_lightning`, `fn_lightning_rollout_readiness(cluster)` is read and recorded. `go` is required from Stage 3 on. Stage 1 and Stage 2 may proceed on `insufficient_evidence` only when every reason is evidence-level and is the evidence that stage exists to produce (`NO_AA_CALIBRATION`, `NO_LATENCY_EVIDENCE`, `WORKER_SHADOW_ONLY` in Stage 1). A `no_go` stops the stage.
- **Laws hold throughout.** Horses are players (Law 10.5); no automatic table switch (Law 10.6); no money moves on a mode transition; integrity, shadow, quality and latency data never feed matchmaking; no payload carries a hole card; player-visible terms only.
- **The engine first.** The live engine release must contain the Phase 13 engine change (discovery of `paused` and `draining`, the joins and drain behaviour, the matcher and flag keys) before any Cluster leaves Stage 0. An older engine stops a worker whose Cluster leaves `lightning` / `pending_off`, which would void unsettled hands. Verify with `git merge-base --is-ancestor <engine merge> <shipped target_sha>` against `ca_engine_deploy_attempts`.

## Stage 0: Dark

The state on 2026-10-09: all 166 Clusters `must_move`, `lightning_enabled` false, no pool session open, `worker_mode` off everywhere.

**Go / No-Go Evidence**

- Every Lightning migration applied, every live proof true except the documented expected-false list (evaluate each declared `@live-proof` through the configured read-only database tool, recording every documented supersession separately), and `fn_lightning_rollout_readiness` reporting `migrations.missing = []` and its evaluated invariants (`seven_tables`, `anti_manipulation`, `law_10_5`, `no_anon_door`) true. `proofs_evaluated_in_sql` must remain false: the readiness call does not evaluate live proofs. Separate exact installed-migration proof readback is required; the readiness badge cannot replace it.
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
- A shadow worker plans and forms nothing, so pool players receive no hands while it runs. The stage is time-boxed: at most 60 minutes. Before starting, verify the effective `shadow_window_ms` can produce at least 30 nonempty comparisons within that budget (a 60000ms setting can; 300000ms windows cannot). The installed default is 300000ms. Before starting the pilot, use `set_shadow_window {shadow_window_ms: 60000}` through `fn_lightning_operator_control`, while drained in MUST-MOVE with the worker off. An unsuitable configuration must be corrected through its maintained qualified path before the stage starts; never extend the time box or fabricate comparisons.

**Exit Criteria (Required For Stage 2)**

- `fn_lightning_shadow_report(cluster)` shows the m1 against m1-port pair with at least 30 comparisons and verdict `calibrated` (mean quality delta within 1 point).
- Hand-latency evidence is collected in Stage 2, not fabricated in Stage 1. The shadow worker forms no hands: its `LightningLatencyLedger` writes no window when it has no hand samples. `NO_LATENCY_EVIDENCE` remains expected at this boundary; zero samples are missing evidence, never a passing p95. Existing measured regressions still stop progression.
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

- At least 5,000 actual completed Lightning hands on the pilot Cluster with: zero `LIGHTNING_*_MOVED_MONEY`, zero unexplained freeze, zero orphan reservation on the dashboard, zero open `lightning_alerts` page older than its resolution, every settled hand's replay check passing (`fn_lightning_operator_hand_replay`).
- Actual hand-latency windows cover every configured leg with nonzero samples; p95 stays under every ceiling over the last `alert_latency_windows` windows during the tested workloads. An absent leg is missing evidence, never a zero or a pass. The verdict of record is the read-only `Lightning Latency Qualification` workflow (`scripts/ops/lightning-latency-qualification.mjs`): per leg, the most recent `alert_latency_windows` consecutive closed windows each with at least `alert_latency_min_samples` samples and p95 under the ceiling, with no later measured breach; PASS on all eight legs is required.
- No high-severity integrity signal left open.
- Readiness `go`.

**Rollback**

- `drain`; then `disable_lightning` is implied (a drained Cluster ends with `lightning_enabled` false).
- A matcher regression: `disable_matcher_version` for the offending version (the live one rolls back to the previous enabled version) or `rollback_matcher_version`.
- A single feature misbehaving: `set_flag lightning_fold_watch false` or `set_flag lightning_fast_fold false` (the engine's action door refuses that fold with a clear code), `set_flag lightning_auto_rebuy false`, `set_flag lightning_multi_table false`.
- Too many arrivals: `disable_joins` (seated players continue).

## Stage 3: Limited Clubs

Lightning enabled on a small set of Clusters in clubs that opt in, a few Clusters at a time. Six-seat only (superseded 2026-10-19: this stage previously named both 6-max and 9-max).

**Go / No-Go Evidence (Per Cluster)**

- Readiness `go` read and recorded immediately before `enable_lightning`.
- The club's control members have the operator dashboard and know the drain, pause and joins controls.
- The previous batch has completed the applicable active-play, latency and recovery checks with the Stage 2 exit criteria holding for each of its Clusters. There is no minimum batch-age wait.
- Candidate shadow evidence (m1 against m2) is informational only: the live matcher stays m1 until a matcher change is proposed with at least 30 comparisons and verdict `shadow_leads`, and that change ships as its own reviewed phase, not as a flag.

**Rollback**

- One Cluster: `drain` that Cluster.
- One club: `drain` each of its Clusters (each is its own drain; the dashboard shows progress per Cluster).
- Everywhere: `drain` every Lightning Cluster; Lightning returns to Stage 0 with every player at their seat.

## Phase 14: Final Regression And Production Release Review

[The 54-item requirement catalog](release-gates.json) maps the original final gate to maintained qualification sources. [The release review](FINAL-RELEASE-REVIEW.md) records execution evidence and what remains pending. Source presence and an isolated test do not complete the active-play pilot or limited-club qualification. An unavailable, cancelled, skipped or stale result is not PASS. Starting Phase 14 does not enable a Cluster or change the rules above.

## Stage 4: General

Lightning available to every club whose Clusters pass readiness.

**Go / No-Go Evidence**

- Stage 3 has completed active-play qualification across at least five clubs, on six-seat Clusters (the earlier "both table sizes" requirement is superseded by the 2026-10-19 six-seat ruling), with the Stage 2 exit criteria holding everywhere. There is no minimum elapsed-day wait.
- The Final Release Gate checklist (Phase 14) passes with evidence, including emergency drain, Cluster freeze, rollback, shadow matcher, alerts and the operator dashboard.

**Rollback**

- As Stage 3, Cluster by Cluster or estate-wide. The alert sweep keeps paging on freezes, stuck conversions, drive errors, reaper failures, integrity spikes and latency regressions throughout.

## The Pilot Cluster

The pilot must be a non-public Cluster that no real player outside the team can reach. Read from PokerIQ-Production on 2026-10-09: no non-public club exists (the two clubs with cash games, Midway Union and Deep Stack Society, are public; Diamond Arena is the platform club and has no cash game). Several Midway Union must-move Clusters have had no human seated in 14 days and only horses now (for example NLH 1/2 Action, 6-max, about 53 horses; NLH 1/2 Classic, 9-max, about 81 horses), but they are in a public club, so they are not pilot candidates as they stand. The pilot therefore needs a Cluster made private first (a non-public test club, or the game's `ruleset_snapshot.options.is_private` set through the reviewed path), which is an owner decision recorded before Stage 1. This dated reconnaissance is superseded by the private pilot prepared on 2026-10-12: club `e14bc9f7-736d-425f-8f2c-e78305ebac1d`, Cluster `babb43f1-368e-406f-a97a-a0d5013648b2`, private NLH 6-max, effective `shadow_window_ms` 60000. Preparation leaves Lightning and the worker off; participant admission, authenticated access checks and actual play remain pending.

## Evidence Record

For each stage transition, keep in the change record: the readiness answer (verdict and reasons), the request ids and `operator_*` event ids of every control action, the dashboard rows before and after, the shadow report, the latency windows, and for every drain its eight `lightning_drain_step` events and final `drain` state.
