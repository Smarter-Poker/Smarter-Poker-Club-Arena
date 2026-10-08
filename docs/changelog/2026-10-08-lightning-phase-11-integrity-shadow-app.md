# Lightning Phase 11 (App): The Shadow Matcher, Integrity Telemetry And The Matcher Simulator

Date: 2026-10-08
Scope: engine (`server/src/lightning/`) and an offline script, the app side of
the spec's Phases 18 (integrity, bot and collusion telemetry) and 19 (the
shadow matcher). The DB side (`fn_lightning_shadow_record`,
`fn_lightning_integrity_report` and the `quality_weights` config key) ships in
parallel on `agent/claude-lightning-p11/lightning/integrity-shadow-db`.
Everything here tolerates those functions being absent (deploy window): a
missing function makes the feature quietly unavailable for ten minutes, never
a crash loop and never an effect on live play. Lightning is off in
production, and both new flags default to off.

## What Was Built

### Engine

1. **The matcher as a pure function, by version** (`LightningMatcherModel`,
   new). The live matcher stays SQL (`fn_lightning_match_plan`). The model is
   its TypeScript twin for the two jobs that must never touch the database:
   - `m1` ports the live plan line for line: P1 group sizes
     (`fn_lightning_group_sizes`), P2 big blinds by the barrier's blind
     order, the first-entry rule, P4 queue order for the other seats, P2 again
     for the small blinds, P5's diversity assignment
     (`fn_lightning_diversity_assign`, the same bands and weights) and P3's
     position order from the button backward;
   - `m2` is the candidate: m1 with P5's diversity also weighing in the
     thin band (half the medium weight), every band's weight scaled by a
     diversity knob, and a P3 tie going to the longest wait. Its knobs are its
     own (`LightningMatcherParams.candidate`, swept from the simulator); the
     DB's `quality_weights` are the comparison's scoring weights, computed by
     the database, and never a matcher input.
     A future candidate is one more entry in `LIGHTNING_MATCHER_MODELS`; a
     version the engine does not model leaves the shadow side idle and says so.

2. **The shadow runner** (`LightningShadowRunner`, new, one per Cluster
   worker). After a live pass has returned (its hands already with their
   hosts) the worker hands it the pass's presence snapshot, its `now` and the
   live decision, synchronously and inside a try/catch, and reads nothing
   back. The runner builds a fresh population snapshot (the anchor engines'
   players minus whoever this process has in a hand, with the queue keys
   learned from the hands it formed), runs the shadow version on its own copy
   (no RPC, no reservation, no seat, no hand), scores both decisions against
   that same snapshot, and only then applies the live outcome to its model.
   Compared per window, for both sides: formation success, failure rate,
   wait (p50/p95/avg), BB fairness (hands since the last BB, P2 order
   violations), position fairness (button count before the button), opponent
   diversity (repeat pair rate) and instance occupancy, with both matcher
   versions on the record.

3. **One record per Cluster per window.** Windows are aligned to the wall
   clock (`shadow_window_ms`, five minutes by default). Closing one makes one
   `fn_lightning_shadow_record` call and, with integrity on, one
   `fn_lightning_integrity_report`, off the pass's path, one flush in flight
   at a time (a window that closes behind a slow flush is dropped and
   counted). Stopping a worker flushes its open window once, inside the
   existing stop drain bound.

4. **CPU bound.** A snapshot over `shadow_max_players` (500 by default) is
   not planned; a shadow pass over `shadow_pass_budget_ms` (50 ms by default)
   skips the next passes in proportion, at most ten.

5. **Integrity telemetry, engine half** (`LightningIntegrity`,
   `LightningTelemetry`, new). The hand host reports, per Cluster, the time
   from a turn being offered to the action that answered it (a pre-action
   and a timeout are not decisions; a timeout is counted as one), when each
   hand is dealt and when it ends. Per window: per player decisions,
   timeouts, p50/p95/mean/stddev, coefficient of variation (abnormally
   constant) and fast share (under 500 ms, abnormally fast); per pair dealt
   together, hands together, back-to-back actions, fast follows and the
   correlation of their per-hand decision times. Timing only: no card,
   board, amount, stack or action type. Horses are timed exactly as humans
   (nothing asks who is one). The matcher reads none of it: the model has no
   imports and its snapshot no field the telemetry could fill.

6. **Action latency telemetry.** The legs the Prometheus histogram already
   measures (fold request to ack, ack to idle pool, idle pool to match, match
   to hand creation, fast, normal and Fold & Watch fold to next hand) are now
   attributed to their Cluster and aggregated per window into the shadow
   record's live side as p50/p95 per leg, the same pipeline. Hand creation to
   first client render is not measured: the client sends no render
   acknowledgement today (`first_render_measured: false`).

7. **Config** (`LightningConfig`): `lightning_shadow_matcher`,
   `shadow_matcher_version` (default `m2`), `shadow_window_ms`,
   `shadow_max_players`, `shadow_pass_budget_ms` and `integrity_telemetry`
   (the DB branch's names, defaults and bounds), beside the plan keys the
   model reads. A candidate named the same as the live matcher sends no
   record (the database refuses `SAME_VERSION`). Both flags off is
   zero work: the runner is unregistered from the telemetry intake, holds no
   state and returns at its first line.

### Simulator

`server/src/lightning/LightningMatcherSim.ts` and
`npm run lightning:matcher-sim` (`server/src/scripts/lightningMatcherSim.ts`)
drive the same matcher models over a synthetic population: player count,
arrivals, departures, folds, sit-outs, disconnects and reconnects, conversion
thresholds, instance size, matcher version, hands and seed. Output: hands per
hour, average/P95/P99 wait, BB/SB/BTN per player, BB per 100 spread, max BB
gap, BB gap std dev, position distribution, repeat-opponent and repeat-group
rates, instance utilisation and conversion frequency, as JSON and a table.
Deterministic per seed. CI runs only a 2,000 hand smoke.

Results, seed 1, defaults (instance 2/9/9, 75 percent fast folds, one
departure, half a sit-out and 0.3 disconnects per player-hour, one pass a
second), 10,000 hands per row:

| Version | Players | Hands/Hour | Avg Wait s | P95 Wait s | P99 Wait s | BB/100 SD | Max BB Gap | BB Gap SD | BTN Share | Repeat Opp | Repeat Group | Avg Size | Utilization | Conv/Hour |
| ------- | ------- | ---------- | ---------- | ---------- | ---------- | --------- | ---------- | --------- | --------- | ---------- | ------------ | -------- | ----------- | --------- |
| m1      | 10      | 886        | 1.26       | 3.90       | 11.37      | 3.51      | 7          | 0.99      | 43.0%     | 38.5%      | 58.0%        | 2.33     | 25.9%       | 0         |
| m2      | 10      | 876        | 1.26       | 3.91       | 12.14      | 3.41      | 7          | 1.01      | 42.7%     | 37.6%      | 54.8%        | 2.34     | 26.0%       | 0         |
| m1      | 25      | 2191       | 0.61       | 1.62       | 2.62       | 3.67      | 11         | 1.51      | 32.4%     | 24.4%      | 7.1%         | 3.09     | 34.3%       | 0.66      |
| m2      | 25      | 1984       | 0.66       | 1.79       | 2.87       | 4.08      | 11         | 1.42      | 34.1%     | 25.0%      | 9.8%         | 2.93     | 32.6%       | 0.6       |
| m1      | 50      | 3029       | 0.52       | 0.99       | 1.74       | 3.11      | 15         | 1.97      | 25.4%     | 20.9%      | 0.9%         | 3.94     | 43.8%       | 0         |
| m2      | 50      | 3159       | 0.51       | 0.98       | 1.66       | 2.48      | 14         | 2.06      | 24.2%     | 20.4%      | 0.6%         | 4.13     | 45.9%       | 0         |
| m1      | 100     | 4343       | 0.48       | 0.95       | 0.99       | 2.21      | 17         | 2.82      | 16.8%     | 15.3%      | 0.0%         | 5.96     | 66.3%       | 0         |
| m2      | 100     | 3981       | 0.48       | 0.95       | 0.99       | 2.17      | 19         | 2.66      | 17.9%     | 16.8%      | 0.0%         | 5.6      | 62.2%       | 0         |
| m1      | 500     | 16260      | 0.48       | 0.95       | 1.00       | 1.74      | 23         | 3.52      | 12.3%     | 4.6%       | 0.0%         | 8.14     | 90.4%       | 0         |
| m2      | 500     | 16854      | 0.49       | 0.95       | 1.00       | 1.7       | 24         | 3.45      | 12.3%     | 4.5%       | 0.0%         | 8.13     | 90.3%       | 0         |

And 100,000 hands at 50 players:

| Version | Players | Hands/Hour | Avg Wait s | P95 Wait s | P99 Wait s | BB/100 SD | Max BB Gap | BB Gap SD | BTN Share | Repeat Opp | Repeat Group | Avg Size | Utilization | Conv/Hour |
| ------- | ------- | ---------- | ---------- | ---------- | ---------- | --------- | ---------- | --------- | --------- | ---------- | ------------ | -------- | ----------- | --------- |
| m1      | 50      | 3128       | 0.51       | 0.98       | 1.64       | 2.86      | 18         | 2.08      | 24.3%     | 20.5%      | 0.7%         | 4.12     | 45.8%       | 0         |
| m2      | 50      | 3064       | 0.51       | 0.98       | 1.70       | 2.63      | 15         | 2.01      | 25.0%     | 20.8%      | 0.8%         | 4        | 44.5%       | 0         |

What it shows: with `instance_min` 2 the live plan seats every legal player
each pass, so waits stay near half a pass interval at every size, and the
price is small tables in small pools (2.3 players a hand and a 58 percent
repeat-table rate at 10 players). The candidate's BB spread is lower at 50
players (max gap 15 against 18 over 100,000 hands) and otherwise close to m1.
That is a signal for the shadow record to confirm on real pools, not a
recommendation to switch.

## Tests And Checks

- `LightningPhase11IntegrityShadowApp.test.ts` (19): the same seeded
  scenario with the shadow on and off makes the same live calls and deals
  the same hands, and the shadow calls no writer; a throwing candidate is
  contained; one record per closed window with both versions, and one more on
  stop; flags off is zero work (no registration, no plan, no call), and
  switching off at runtime drops all state; a missing function is one try per
  ten minutes; the size cap and the overrun skip; latency legs aggregate per
  Cluster with exact p50/p95; a real dealt hand's integrity report carries
  timing only; constant fast timing and correlated pairs are flagged, and a
  horse and a human with the same timing produce the same signals; the
  matcher reads nothing the telemetry produces; no Phase 11 file reads
  `is_horse`; scoring and config parsing.
- `LightningMatcherSim.test.ts` (4): a 2,000 hand smoke for both versions,
  determinism per seed, the table and the command line.
- The whole `server/src/lightning` suite, `tsc --noEmit` (server), and the
  local house-rule gates.
