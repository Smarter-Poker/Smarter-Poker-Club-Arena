# Horse Brain Phase 6C: Exact-Input Replay Protocol (2026-09-26)

Phase 6C (3 of 4) of the Phase 6 tournament work: a recorded Horse decision is replayed from its exact original inputs through the published decision code, the calculations and references it claims are qualified independently, and a fixed-shape verdict says what was reproduced, what diverged and what was refused, with a named reason. This document is the evaluation protocol. The implementation is `server/src/engine/horseDecision/replay/` and the batch tool is `server/scripts/phase6c-replay.mjs`; evidence lives under `docs/evidence/phase6c/`.

Deterministic replay is not GTO strength. A reproduced decision proves that the published code repeats itself on its exact original inputs and that its stated arithmetic is right. It certifies nothing about whether the action was good.

## 1. What Is Replayed

One journal record of kind `decision` whose snapshot is a `DECIDE_FAST` request (the phase 15 decision journal, `server/src/services/HorseDecisionJournal.ts`). The record is identified by its journal `eventId`; the verdict calls it `decisionId`.

The exact original input is rebuilt from the record alone. Every declared input must be present or the replay is refused with `replay_input_incomplete:<field>`; nothing is ever substituted with a default. The fields and their journal sources:

| Input          | Journal field                                                                                                                                       | Refusal                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Actor          | `snapshot.player` (seat, identity, private cards)                                                                                                   | `replay_input_incomplete:actor`          |
| Persona        | `snapshot.style`                                                                                                                                    | `replay_input_incomplete:persona`        |
| Profile        | `snapshot.mods` (authored modifiers and leaks)                                                                                                      | `replay_input_incomplete:profile`        |
| Public history | `snapshot.gameState.actionHistory`                                                                                                                  | `replay_input_incomplete:public_history` |
| Field          | `snapshot.gameState.players` and `dealtSeatIds`; the `tournament` block for a tournament decision                                                   | `replay_input_incomplete:field`          |
| Source         | `tournament.contextProvenance` (the exact cache generation the decision read; a null source is a recorded fact, a missing provenance record is not) | `replay_input_incomplete:source`         |
| Atlas inputs   | `tournament.m`, `contextStatus`, `anteType` for a tournament preflop decision                                                                       | `replay_input_incomplete:atlas`          |
| Solver stores  | `readiness.solverStores` and `readiness.solverPolicyArtifact` reported by the worker beside the decision                                            | `replay_input_incomplete:solver_stores`  |
| RNG stream     | `rngBefore` and `rngAfter` (unsigned 32-bit xorshift states)                                                                                        | `replay_input_incomplete:rng`            |
| Governor       | `governorScale` in (0, 1]                                                                                                                           | `replay_input_incomplete:governor`       |
| Opponent reads | `readFrame` (the private read view captured beside the decision)                                                                                    | `replay_input_incomplete:read_frame`     |
| Binding        | `snapshot.decisionKey` must equal the Phase 5 digest recomputed from the rebuilt input                                                              | `replay_input_incomplete:decision_key`   |

A record whose own digest does not hold is refused as `replay_input_incomplete:record` before its body is read. A `DECIDE_DEEP` second look is refused as `replay_unsupported:DECIDE_DEEP`: it borrows the FAST decision's stream and reads and is not an original decision.

## 2. How It Is Replayed

The rebuilt request is sent through `HorseDecisionWorkerRuntime`, the same runtime that serves live FAST decisions, with production's `HorseLogic.decide`, `HorseMind.captureDecisionEffects` and the HorseEval RNG. The runtime performs its own envelope validation, canonical-state and Phase 6 M assertions, RNG seed derivation, effect validation and compute clock. Three bindings are replay-specific and are the same ones production's own deep second look uses (`workerRuntime.executeDeep`):

1. the opponent reads are decoded from the journaled read frame into a HorseMind sandbox, and observation is off, because the frame was captured after the original observation and observing again would count the hand twice;
2. the equity governor is pinned to the journaled `governorScale`;
3. nothing is journaled and no plan effect is applied.

The RNG seed is derived by the runtime from the decision key exactly as it was live. If the derived seed differs from the journaled `rngBefore`, the verdict is `refused` with `rng_stream_mismatch`: the code no longer derives the stream the original used, so the run is not an exact replay.

## 3. What Is Compared

- Accepted action: `action` and `amount` of the original decision receipt against the replayed receipt.
- Reference route: `tournamentPreflopAttribution.route` (legacy_preflop, chart_open_jam, chart_bb_defend, variant_price, intent_engine), original against replay.
- Atlas cell: `tournamentPreflopAttribution.lookup.policy.cell`, original against replay.
- RNG stream: `rngBefore` (must match) and `rngAfter` (reported).
- Receipt digest: SHA-256 of the whole decision receipt with wall-clock fields removed (`*elapsedMs`, `*latencyMs`, the execution witness) and with shadow-mode policy receipts removed (a policy that ran under a wall-clock work budget without owning the action: `jointPolicy`, `plo4Policy`, `omahaVariantPolicy`, `remainingVariantPolicy`, `tournamentPostflop` when `applied` is false or `mode` is `shadow`, and the outcome of a shadow `policyOwnership`). Informational: a differing digest on a reproduced decision is reported as `receipt_digest_differs`.
- Authority: the module that produced the accepted action, read from the decision's own policy graph: the last node whose transition changed the action, else the node that produced it (`reference`), qualified by the reference route (`reference:intent_engine`, `reference:chart_open_jam`, `reference:postflop`) or the variant owner (`variant_policy:phase10`). `brain_exception` names the safety net. Original and replay owners are both reported and compared.

## 4. Independent Qualification

`independentQualification.ts` re-derives the calculations the decision claims from the journaled inputs and compares them with the claims. It imports nothing from HorseLogic, HorsePreflop, HorseTournamentPreflop, HorsePhase6Attribution or PokerEngine; a test pins that import list. The rules are restated from the published Phase 6 domain (`TOURNAMENT_PREFLOP_ATLAS_DOMAIN`, revision `horse-tournament-preflop-v1`):

| Check              | Independent derivation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Claim compared                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pot_odds`         | `toCall = max(0, currentBet - hero.bet)`; hero's contestable pot after a hypothetical call from the seats' live and dead investments (dead pool, every live level hero's investment reaches, orphaned levels folded into the main pot, minus the call); break-even equity `call / (contestable + call)`                                                                                                                                                                                                                                               | canonical `gameState.toCall` (0.005) and `gameState.contestablePot` (0.01)        |
| `m_state`          | orbit cost from blinds and ante (per-player ante times clamped seats; big-blind ante authored as a total when ante >= big blind, capped at two big blinds), real M, effective M scaled by seats/10, next-level projection, projected stack in BB, velocity per minute, covering opponents, Harrington zone with half an M of hysteresis on the crossed boundary only                                                                                                                                                                                  | `tournament.m` (1e-8 on every number, exact zones and covering list)              |
| `ante_mode`        | ante type implied by the hand (`bigBlindAnte` true, `ante` > 0, none)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tournament.anteType` and the atlas coordinate's `anteType`                       |
| `atlas_coordinate` | table size, hero and raiser positions clockwise from the dealer on the published ring, preflop line (raises, limpers, callers, callers of the previous raise, first and last raiser, imputed raise when the history is empty and the current bet exceeds the big blind), branch classification, effective depth in BB against the last raiser, depth bracket on the anchor grid, game family, context status, fallback precedence (invalid coordinate, unsupported variant, incomplete context), velocity urgency and the cell string `phase6-v1:...` | `lookup.coordinate` and `lookup.policy.cell`, `source`, `fallbackReason`, `depth` |
| `route`            | the set of routes the snapshot admits under the published gates (legacy when the intent reference is off; chart open-jam and BB-defend gates; variant price gate; intent engine always)                                                                                                                                                                                                                                                                                                                                                               | `tournamentPreflopAttribution.route` must be in the set                           |

Checks outside their domain are `not_applicable` with the reason (`outside_tournament`, `postflop`, `no_lookup:<route>`). The atlas shift values inside a cell are deliberately not restated: they are the production atlas's claim, and section 5 checks that the published atlas still resolves the coordinate to that exact cell and those exact shifts.

Qualification is `agreed` only when every applicable check agreed and every cited reference is available.

## 5. Cited References Are Refused, Not Skipped

Every reference the decision cites must exist in the published source the replay runs against, or the replay is refused with `reference_unavailable:<ref>` and the decision code is not run:

- `variant:<name>`: the variant must be registered in `HorsePolicyRegistry` and match the decision's `policyOwnership.variant`.
- `atlas_cell:<cell>`: the atlas revision must be the published one and `tournamentPreflopPolicy` must resolve the cited coordinate to the identical cell, source, fallback reason and shifts.
- `chart_store`: when the route is a chart route, or a chart route was admissible for the snapshot (the decision may have consulted the store and drawn from the stream), the chart store must hold the same number of charts the worker reported when it decided. The batch tool loads charts from a file with `--charts`; without one, such decisions are refused.
- `solver_store:postflop` and `postflop_v31:<dataset>`: when a hold'em heads-up postflop open node may have consulted the warehouse, the postflop store must hold the reported row count and the same promoted V31 dataset.

A refused decision still carries its original action, its independent qualification and its authority, so the reason is visible beside the evidence it would have needed.

## 6. Verdict

```
{ decisionId, engineSha, recordedRelease, status: 'reproduced'|'diverged'|'refused', reason?,
  originalAction, replayedAction,
  qualification: { status, checks: { pot_odds, m_state, ante_mode, atlas_coordinate, route },
                   references[], route, atlasCell, rng, receiptDigest },
  latency: { wallMs, computeMs, originalComputeMs },
  work: { nodeVisits, originalNodeVisits, equityCalls, equitySamples, telemetryFires, governorScale },
  authority: { original, replayed, same },
  context }
```

- `reproduced`: same accepted action AND same reference route AND same atlas cell AND the independent qualification agreed AND every cited reference was available AND the RNG seed matched. `reason` may still carry `rng_after_differs` or `receipt_digest_differs` as information.
- `diverged`: the replay ran on the exact inputs and any of action, route, atlas cell or qualification differ; `reason` lists which.
- `refused`: the replay did not run or cannot be trusted; `reason` is one of `replay_input_incomplete:<field>`, `replay_unsupported:<type>`, `reference_unavailable:<ref>`, `runtime_rejected:<message>`, `rng_stream_mismatch`.

`engineSha` is the git SHA of the decision code that executed the replay. `recordedRelease` is the release that made the original decision. They are different facts and both are reported; a batch states whether they are equal.

## 6a. Negative Controls

Substituted or stale evidence must fail, and the tests in `server/src/engine/horseDecision/replay/` pin that it does:

- a record whose bytes no longer match its own digest, or whose snapshot no longer matches the decision key that bound it, is refused before anything runs (`replay_input_incomplete:record`, `replay_input_incomplete:decision_key`);
- every declared input removed in turn is refused with its own field name, and no default is substituted;
- a substituted RNG stream is refused as `rng_stream_mismatch`, because the runtime derives the seed from the decision key and not from the claim;
- a substituted recorded action, re-signed so the record itself is valid, replays to the original action and is reported `diverged` with reason `action`;
- a stale M state, re-signed with a valid decision key around it, is disagreed by the independent `m_state` check and is never `reproduced`;
- an atlas cell, chart store or variant the published source does not hold is refused as `reference_unavailable:<ref>`.

## 7. Latency and Work

`latency.computeMs` is the runtime's own compute clock for the replayed decision, `originalComputeMs` the same clock recorded in the journal, `wallMs` the harness round trip through the runtime (start, receive, drain). `work.nodeVisits` is the number of policy-graph transitions (eight for a completed graph), `equityCalls` and `equitySamples` the simulateEquity calls and Monte Carlo iterations granted during the replay (HorseEval work counters), `telemetryFires` the brain telemetry fires. Replay latency is measured on the machine that ran it and is not a production latency claim; production observation remains the `horse_decision_latency` telemetry.

## 8. Batch Evidence

`node server/scripts/phase6c-replay.mjs <journal-path|copy> --engine-sha <sha> --limit N [--since <iso>] [--charts <json>] [--label <name>] [--note <text>]` replays the predeclared batch: the newest N journaled decision records at or after `--since`, in journal order. The journal path is either a journal directory (`archive/horse-journal-archive.sqlite` and `archive/segments/`), opened read-only, or an NDJSON copy exported read-only from one. The tool writes `docs/evidence/phase6c/phase6c-replay-<label>-<time>.json` (summary and every verdict) and `.md` (summary tables and one row per decision) with the exact command line, the batch rule, the declared serving engine SHA, the SHA of the code that ran, the releases on the replayed rows, the solver stores visible to the replay, and the decision-code files (engine and gto sources, tests and the replay module excluded) that differ between the serving engine and the code that ran and between each recorded release and the code that ran. A `--note` records an observation made at run time, such as the journal capture state read from `/health`.

When the journal holds no rows for the serving engine (for example because capture is paused at its segment quota), the evidence says `unavailable external input` for the serving engine and replays the newest rows that exist, stating their release. Nothing is averaged into a completion percentage; the statuses and reasons are counted as they are.

## 9. Known Limits

- A wall-clock work budget inside a shadow policy (joint policy, variant shadow utility) changes that policy's receipt from run to run; the accepted action, route, RNG stream and atlas cell do not depend on it. The receipt digest excludes shadow receipts for that reason and is informational.
- Chart and postflop stores are database-hydrated in production. Without a chart file the tool refuses decisions that may have consulted them rather than replaying a different decision.
- A replay under a later engine SHA than the recorded release is a replay of that later code on the original inputs; the two SHAs are both reported, and the batch header says when they differ.
- The journal is the only source of the original inputs; a decision the journal did not capture (capture paused or gapped) cannot be replayed and is not counted as anything.

## 10. Serving-Release Batch 2026-09-27

Predeclared batch: the newest 200 decision records made by release `6b6eabb1b169aed14fcb9fbd0ae54ee2bc42b2d4` (serving since 2026-09-27T16:06Z) in the window 2026-09-27T16:06:00Z (inclusive) to 16:41:00Z (exclusive, the minute the journal was copied). The copy was read from the engine-host archive segments without opening the catalog and holds every decision by that release in the window: 2,967 records (2,915 `DECIDE_FAST`, 52 `DECIDE_DEEP`), the first at 16:14:55Z. Evidence: `docs/evidence/phase6c/phase6c-replay-serving-6b6eabb1-replayed-at-6b6eabb1-2026-09-27T16-41-49-769Z.{md,json}` and `...-replayed-at-main-2026-09-27T16-42-43-790Z.{md,json}`, each with its exact command line.

| Replay code                                             | Recorded release | Decision-code files that differ                                                                                  | Reproduced | Diverged | Refused |
| ------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- | ---------- | -------- | ------- |
| `6b6eabb1b169` (the serving release, detached checkout) | `6b6eabb1b169`   | none                                                                                                             | 159        | 0        | 41      |
| `0c6bda56d5f3` (origin/main, adds Phase 6B #5417)       | `6b6eabb1b169`   | HorseLogic, HorsePhase6Attribution, HorsePreflop, HorseTournamentPreflop, horseDecision client and workerRuntime | 159        | 0        | 41      |

Refusals, identical in both runs: 34 `reference_unavailable:solver_store:postflop`, 4 `reference_unavailable:chart_store`, 3 `replay_unsupported:DECIDE_DEEP`. The two runs return the same status, reason, replayed action and receipt digest on all 200 decisions, and each of the 159 reproduced decisions has a receipt digest equal to the original's. Independent qualification agreed on 159 and disagreed on none; the owning module was identical in original and replay on all 159. Across the 200 originals the owners were 121 `reference:intent_engine`, 72 `reference:postflop`, 3 `reference:chart_bb_defend`, 2 `reference_legality`, 1 `reference:variant_price` and 1 `reference:chart_open_jam`. Replay computeMs median 2.11 and p95 15.97 at the release; the original computeMs median 5.49 and p95 65.67 were measured on the production host under load.

Phase 6C gate status (handoff section 8 vocabulary):

| Gate                       | Status                     | Basis                                                                                                                                                                                                                         |
| -------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain                  | implemented but unverified | The natural batch covers the observed cash and tournament variants and streets, and every unreplayed cell is named by its refusal; a complete domain matrix for replay coverage is 6D work.                                   |
| G2 Inputs                  | verified now               | Every declared input is rebuilt from the record, bound by the record digest and the Phase 5 decision key, and refused by name when missing; 197 of 200 serving-release records rebuilt (3 are deep second looks).             |
| G3 Computation             | verified now               | Pot odds, M state, ante mode, atlas coordinate and route re-derived independently and agreed on 159 of 159; disagreement cases are tested.                                                                                    |
| G4 Immutable authority     | implemented but unverified | Record digest, decision key and atlas revision are checked; chart and postflop stores are identified by row count only and were not loaded offline (unavailable external input for the 38 decisions that could consult them). |
| G5 Reachability            | verified now               | The replay runs through the production worker runtime and HorseLogic on records the serving release produced.                                                                                                                 |
| G6 Outcome receipts        | verified now               | Each verdict names reproduced, diverged or refused with a finite reason; the join to the controller-accepted execution and completed hand is 6D work.                                                                         |
| G7 Independent correctness | verified now               | The verifier imports no production policy module (pinned by test); negative controls show substituted action, substituted RNG stream and stale M evidence fail.                                                               |
| G8 Performance/replay      | verified now               | 159 of 159 replayable serving-release decisions reproduced exactly at the recorded release, with latency and work recorded per decision.                                                                                      |
| G9 Learning/promotion      | not applicable with reason | 6C learns nothing and promotes nothing; an offline replay never enables a live candidate.                                                                                                                                     |
| G10 Publication/use        | verified now               | The replay code merged in #5412 (`4946473b`), is contained in the serving release `6b6eabb1`, and replayed that release's natural records.                                                                                    |
