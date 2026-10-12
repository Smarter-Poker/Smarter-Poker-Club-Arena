# Lightning Phase 11 Remediation (Engine): An Unbiased Shadow Comparison and a Proven Matcher Port

Date: 2026-10-09. Scope: the engine half of the verified Phase 11 review findings 3, 4, 7, 8 (c), 9 and 11. No migration (the database half ships as 20261009181945 on its own branch). Lightning stays dark: every behaviour here runs only when a Cluster's `lightning_shadow_matcher` or `integrity_telemetry` is on, and both are off on all 166 Clusters.

## Finding 3: The Comparison Is Biased Toward Neither Side

- A pass whose live call failed (error, timeout, invalid answer, function not deployed) is scored on neither side and teaches the pool model nothing. It is counted as `skipped.live_failed` on the shadow payload (the `skipped` object is not validated by fn_lightning_shadow_record; no other key changed). A database outage is no longer a live failure, and the shadow is no longer credited for planning through it.
- `bb_fairness.order_violations` is sent as null on both sides. The shadow's big blinds are the top of its own order by construction; the live side's come from the database's P2 ranks, which the engine snapshot does not carry, so the count could only ever charge the live side. With 20261009181945 nulling a component on both sides when either is null, bb_fairness simply leaves both scores. It returns when the snapshot carries the database's P2 ranks.
- `m1-port` is registered in LIGHTNING_MATCHER_MODELS: the TypeScript m1 plan under its own name. Setting `shadow_matcher_version` to `m1-port` on a Cluster whose live matcher is `m1` records an A/A calibration (live `m1` against shadow `m1-port`); the engine's same-version guard still refuses `m1` against `m1`.

## Finding 4: The M1 Port Is the SQL Plan

- P4 is `ORDER BY sl.idle_since, ps.entered_at, cps.opened_at, player_id`: the port reads the Cluster join (`joinedAtMs`, NULLS LAST) between the pool entry and the player id.
- P2's fourth key is the SLOT's opening (`sl.opened_at`), which is not the pool session's entry: the port reads `slotOpenedAtMs` apart from `enteredAtMs`, and the debt age is `coalesce(bl.debt_since, sl.opened_at)`.
- P5's window is `WHERE h.cluster_epoch = v_epoch ... ORDER BY h.formed_at DESC, h.hand_id`: the port filters hands of another epoch and breaks a formed_at tie by hand id.
- Per-group microsecond stamps: fn_lightning_match_and_form stamps group k of a pass `v_now + (k - 1) microseconds` (the big blind's last_bb_at and the hand's formed_at). The shadow model (LightningShadowRunner.applyLive) and the simulator (LightningMatcherSim) now do the same, so P2's next pass serves the big blinds in the order they were chosen instead of re-sorting each batch by the next key. Times are milliseconds with microsecond fractions; a double holds every microsecond of this century distinctly and in order.
- The heads-up small blind is the button, and its btn_count moves, as the barrier names it.
- P5's band reads a legality-equivalent count: the live answer's `legal_count` (match_and_form) when the snapshot only estimates legality, and in worker 'shadow' mode fn_lightning_match's diagnosis gives every player's legality exactly.

## The Parity Test

`scripts/dev/test-lightning-matcher-parity.sh` (PostgreSQL 17, port 55563, CI on accounting_postgres shard 1 after the Phase 12 load step). It builds the real Lightning chain through 20261009151825 on the grounds the Phase 11, Phase 12 operator and Phase 12 load harnesses prove (read from them), under production's default ACLs and autorevoke trigger, with humans and horses in every Cluster. History comes from real fn_lightning_match_and_form passes and the real barrier, dealt, bound and settled through the real doors. For each fixture it captures, in one statement, the snapshot fn_lightning_match_plan reads (fn_lightning_player_legality's own answer and the raw queue keys, every hand with its players and epoch, the config row) and the real plan; `server/src/lightning/__tests__/lightningMatcherParity.ts` then runs `m1-port` and `m1` on that snapshot and requires the identical plan.

| Fixture                                                                                  | Groups | Legal | Result                                      |
| ---------------------------------------------------------------------------------------- | ------ | ----- | ------------------------------------------- |
| Ties on idle_since and pool entry, the join and the slot decide (thin, 6-max, 16)        | 3      | 16    | identical; the pre-remediation port differs |
| Blind debt of four ages (medium, 6-max, 30)                                              | 5      | 30    | identical                                   |
| Large band with real history, P5 moving seats (6-max, 60)                                | 10     | 60    | identical                                   |
| Nine-handed (medium, 9-max, 40)                                                          | 5      | 40    | identical                                   |
| First-entry rule big_blind with ten newcomers (6-max, 30)                                | 5      | 30    | identical                                   |
| Thin band below the on threshold (6-max, 14)                                             | 3      | 14    | identical                                   |
| Two hands formed at one instant, a one-hand window (large, 6-max, 60)                    | 10     | 60    | identical; the pre-remediation port differs |
| Drained, reverted and reconverted: every remembered hand is of the old epoch (6-max, 60) | 10     | 60    | identical                                   |

Result: 8 fixtures, 51 groups, every group's seat order, big blind, small blind and button identical, the same legal count and pool diversity score, for both `m1-port` and `m1`.

## The Corrected Simulator Table

Same conditions as the Phase 11 changelog: `npm run lightning:matcher-sim`, seed 1, instance 2/9/9, 75% fast folds, 10,000 hands per row; 100,000 hands at 50 players for the long run. The 10 and 25 player rows reproduce the Phase 11 numbers exactly (a pass there rarely forms more than one group, so the per-group stamps change nothing), which confirms the conditions; from 50 players up a pass forms several groups and the strict big blind rotation shows.

| Version         | Players | Hands/Hour | Avg Wait (s) | P95 Wait (s) | P99 Wait (s) | BB/100 SD | Max BB Gap | Repeat Group | Utilization |
| --------------- | ------- | ---------- | ------------ | ------------ | ------------ | --------- | ---------- | ------------ | ----------- |
| m1              | 10      | 886        | 1.26         | 3.90         | 11.37        | 3.51      | 7          | 58.0%        | 25.9%       |
| m2              | 10      | 876        | 1.26         | 3.91         | 12.14        | 3.41      | 7          | 54.8%        | 26.0%       |
| m1              | 25      | 2191       | 0.61         | 1.62         | 2.62         | 3.67      | 11         | 7.1%         | 34.3%       |
| m2              | 25      | 1984       | 0.66         | 1.79         | 2.87         | 4.08      | 11         | 9.8%         | 32.6%       |
| m1              | 50      | 3052       | 0.51         | 0.98         | 1.73         | 3.05      | 15         | 0.8%         | 44.4%       |
| m2              | 50      | 3195       | 0.50         | 0.97         | 1.62         | 2.36      | 14         | 0.5%         | 46.9%       |
| m1              | 100     | 4178       | 0.48         | 0.95         | 0.99         | 2.23      | 19         | 0.0%         | 64.6%       |
| m2              | 100     | 4219       | 0.48         | 0.95         | 0.99         | 2.07      | 23         | 0.0%         | 65.5%       |
| m1              | 500     | 16268      | 0.48         | 0.95         | 1.00         | 1.80      | 24         | 0.0%         | 90.0%       |
| m2              | 500     | 16537      | 0.49         | 0.95         | 1.00         | 1.86      | 25         | 0.0%         | 90.4%       |
| m1 (100k hands) | 50      | 3057       | 0.51         | 0.98         | 1.71         | 3.06      | 15         | 0.9%         | 44.7%       |
| m2 (100k hands) | 50      | 3092       | 0.51         | 0.98         | 1.68         | 2.88      | 16         | 0.8%         | 45.1%       |

What changed in the reading: the Phase 11 table credited m2 with a lower big blind spread at 50 players over 100,000 hands (max gap 15 against 18). With the barrier's stamps modelled, m1's own rotation is strict and the long run shows m1 at 15 and m2 at 16, with BB/100 SD 3.06 against 2.88. The m2 advantage on BB spread is smaller than reported and the max gap advantage is gone; this is still a signal for the shadow record to confirm on real pools, not a recommendation to switch.

## Finding 7: Every Window's Evidence Reaches the Database

The database now stores each window's per-player and per-pair evidence and decides DECISION_LATENCY and TIMING_CORRELATION over the rolling 24 hours (20261009181945). The engine reported a pair only after three shared hands in one window, which a pair at 25 → 50 players rarely reaches in five minutes; it now reports every pair that shared a hand (busiest first, up to the report's 200), and keeps the latency correlation null below three shared decisions. The payload keys are unchanged.

## Finding 8 (c): Fold to Next Hand Starts at the Fold Request

Verified against LightningLatencyLedger (#6587): the ledger only aggregates what LightningMetrics observes, and LightningMetrics started fast_fold_to_next_hand and normal_fold_to_next_hand at the idle moment after the database acknowledged the fold, and fold_watch_to_next_hand at the hand's end. Fixed: the host records the fold request (the action door's receipt, else the fold itself for a turn fold, a horse's decision or a timeout, timed alike) and every \*\_to_next_hand leg starts there; ack_to_idle and idle_to_match keep their own starts. (a), (b) and (d) are verified closed: the ledger reports n/p50/p95/p99, runs under its own `latency_telemetry` key independent of the shadow flag, and hand_to_first_render is measured from RENDER_ACK.

## Finding 9: The Final Window Survives a Stop

stop() now awaits the flush in flight before closing the final window (one flush in flight used to drop it). A restart inside an aligned window reports [start, stop) from the old process and [start, end) from the new one: two rows that overlap, keyed apart by window_to. That is accepted and documented here.

## Finding 11: The CPU Bound Costs Nothing

The shadow's size cap reads the presence (connected, disconnected and unknown) before any snapshot is built, and a pass the shadow skips (size cap, overrun, unknown version) is scored on neither side, so both sides are always scored on exactly the same passes. A window that only skipped is still recorded, so the skip counters remain the evidence.

## Unchanged

- The matcher input holds no telemetry, shadow, quality or latency data; no live body changed.
- Law 10.5: nothing reads is_horse or horse_id; horses are timed, pooled and compared exactly as humans.
- No card data in any payload or log.
- Payload contracts of fn_lightning_shadow_record, fn_lightning_integrity_report and fn_lightning_latency_report are unchanged (one additive counter inside the unvalidated `skipped` object).

## Tests

- `server/src/lightning/LightningPhase11RemediationApp.test.ts`: every finding above, including a real LightningHandHost fold whose acknowledgement takes 250 ms.
- `LightningPhase11IntegrityShadowApp.test.ts`: the model registry lists `m1`, `m1-port`, `m2`; a size-capped pass is scored on neither side.
- `tests/lightning-matcher-parity.test.ts`: the parity harness, its fixtures, its CI step and this changelog.
- `scripts/dev/test-lightning-matcher-parity.sh`: the parity proof above; CI step on accounting_postgres shard 1, with the `cash-native-hosted.manifest.json` pin of ci.yml.
