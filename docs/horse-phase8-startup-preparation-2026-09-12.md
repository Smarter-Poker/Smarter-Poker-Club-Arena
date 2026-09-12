# Phase 8 fixed card preparation before worker readiness

The first eligible Phase 8 decisions previously populated the rollout model's card-fact cache on their action clocks. The worker now prepares its complete bounded population after initial hydration and before readiness: 32 outcome indices times 2–10 surviving seats, or 288 entries. Preparation computes only identity-free cards, street contact scores and showdown scores. It does not execute betting, settlement, observations or telemetry. Draws exposed to a decision remain copies, and out-of-range samples retain uncached deterministic handling.

The shared builder preserves shuffle order, scores and settlement inputs. Candidate generation, ICM trials, sampled outcomes, error bounds, deadline checks, safety latches and shadow-only activation are unchanged. No live private cards or player state enter preparation.

## Verification

Tested source: `20c7ebba2e37df3c0cd64aed3de72bbd32e7c902`, production implementation `1187191a01cdf64d4dd5c1e2f9f92caaa43f7c0e`, based on `5c0d00b82ed1a214fddccb2cecb36db2da6513d0`.

- Build passed. Full server suite: 10,979 passed, 145 existing skips; 754 files passed and one skipped. The first build caught a test loader returning `void` instead of `number`; the fixture was corrected before this full run.
- Focused coverage includes all 864 combinations of bounded draws, 2–10 seats and three ante modes, identical lazy/prepared results, input ownership, repeated preparation, uncached fallback indices, readiness ordering and service drainage on preparation failure. All supported prepared decisions performed zero additional card scoring.
- Frozen pre-change native modules matched 5,832 complete funded results and 5,616 caller-visible draw maps across lazy/prepared execution, 36 sample indices, nine seat counts, three ante modes, three stack patterns and unchanged remote field entries.
- All 24 captured complete decisions matched before/after. Four counterbalanced fresh-process runs completed 140/256 decisions before and 159/256 after under the real work deadline; the first 32 decisions in each run improved from 26/128 to 33/128. Preparation took 8.86–9.61 ms before decision admission.
- The larger 36-case comparison retained every complete decision. Warm real-deadline completion was 3,020/3,600 before and 3,016/3,600 after: no demonstrated steady-state completion improvement. Worst case p99 without cooperative cancellation was 9.208 ms before and 8.880 ms after; with real deadlines it was 4.766 ms before and 4.950 ms after. The large-field 4 ms/completion gate remains open. The expanded 200/1,000-player fields are declared stress populations, including non-production Spin configurations.
- The offline actual-controller baseline passed all six objectives with legal actions, chip conservation and unchanged source. It used the same fixed-card preparation before action clocks, four pairs and seed 901791 per objective. Confidence intervals remained [-1, 1] with zero measured advantage; this is software-baseline evidence and does not satisfy strength promotion. Several objectives retained decisions after deadline stops.

## Release and acceptance limits

This is a startup-cost repair, not first-round certification. The earlier forecast-reuse PR #4443 is protected-merged and published in engine `4a5fa3fb3ffc734aab0596b30314c63248540187` (strict receipt attempt 457, shipped=true). A healthy same-leader natural window at 12:39–12:41 UTC had 19 shared native table samples, 15 advancing, and 196 new Phase 8 receipts, all disabled by `eligible_but_silent`. No Phase 8 firing occurred. The startup repair requires its own protected review, publication and natural recovery proof; existing safety is not reset or relaxed to manufacture evidence.

Final release certification also remains open: the fc38 E2E run failed four tests because health removed `tableLiveness` while the consumer still requires it. Later page E2E runs stopped before specs because their required engine successor had not published. These are separate release evidence gaps; assertions and engine infrastructure are unchanged here.

The previous exact-cache, hoisted-cache and exact-compaction experiments remain held and unpublished because their measured deadline completion was inconsistent or worse. Their correctness and negative timing evidence are retained; none is included in this change.
