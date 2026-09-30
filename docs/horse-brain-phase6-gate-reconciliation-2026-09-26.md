# Horse Brain Phase 6: Gate Reconciliation Across 6A, 6B, 6C and 6D

> Current qualification: [September 30 serving qualification](horse-brain-phase6-completion-2026-09-30.md). The older dated statuses below are retained as history; use the current record for remaining gates and measured serving behavior.

First written 2026-09-27 against the Phase 6D declaration of 2026-09-26, and updated the same
day after journal capture resumed on the serving release 6b6eabb1 and the 6B and 6C lanes
reported. The file name keeps its first date. Horse Brain only. Every cell carries exactly one
status from the handoff vocabulary (section 8 of `horse-brain-continuation-command.md`):
verified now, historical only, implemented but unverified, defective, unavailable external
input, not applicable with reason. Nothing here is averaged into a percentage, and no stage is
declared complete.

## Sources Read

| Source                                                                                                  | What it says at the time of writing                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine `/health` and `docker inspect club-arena-engine`, read over ssh 2026-09-27T16:47:12Z             | `releaseSha` 6b6eabb1b169aed14fcb9fbd0ae54ee2bc42b2d4, container started 16:06:56Z; `horseJournal.mode` ready, capture running as a ring of 500000 segments |
| `docs/evidence/phase6d/population-2026-09-27.{json,md}`                                                 | serving-release population, declaration committed 16:49:15Z, qualified execution 16:49:23Z to 16:49:59Z                                                     |
| `docs/evidence/phase6d/population-2026-09-26.{json,md}`                                                 | the 2026-09-26 declaration's run, all chains from 778075b4                                                                                                  |
| `docs/horse-brain-phase6b-route-proof-2026-09-26.md` (merged #5417, c8cbe6e6)                           | 6B tests and the bounded route proof on 778075b4                                                                                                            |
| `docs/horse-brain-phase6c-replay-protocol-2026-09-26.md`, section 10, on PR #5456 (head 2a6b2bb6, open) | 6C serving-release replay batch on 6b6eabb1 and the 6C lane's per-gate statuses                                                                             |
| `CURRENT-DELIVERY.json` `phase6Build` and the coordinator's certificate record                          | 6A gates 1 to 3 passed; the certificate for 6b6eabb1, run 36332268785, did not pass the MTT case                                                            |
| `git merge-base --is-ancestor`, run 2026-09-27                                                          | 6b6eabb1 contains 563fac93 and f1059b99 (6A), ee7f3a03 (#5329), bc0cde52 (#5340) and 9e275e1c (#5355); it does not contain c8cbe6e6 (#5417)                 |

## Status Matrix

| Stage | G1                         | G2           | G3                         | G4                         | G5              | G6              | G7           | G8                         | G9                         | G10                        |
| ----- | -------------------------- | ------------ | -------------------------- | -------------------------- | --------------- | --------------- | ------------ | -------------------------- | -------------------------- | -------------------------- |
| 6A    | not applicable with reason | verified now | not applicable with reason | verified now               | verified now    | verified now    | verified now | not applicable with reason | not applicable with reason | implemented but unverified |
| 6B    | verified now               | verified now | verified now               | verified now               | historical only | historical only | verified now | not applicable with reason | not applicable with reason | implemented but unverified |
| 6C    | implemented but unverified | verified now | verified now               | implemented but unverified | verified now    | verified now    | verified now | verified now               | not applicable with reason | verified now               |
| 6D    | verified now               | verified now | verified now               | verified now               | verified now    | verified now    | verified now | implemented but unverified | not applicable with reason | verified now               |

## Phase 6A (1 of 4)

The four-gate record: gates 1 (containing release sealed on 778075b4), 2 (original 16-record
segment custody) and 3 (finite natural observation, 3 hands on 778075b4) passed, as
`CURRENT-DELIVERY.json` and `DELIVERY-VERIFICATION.md` record. Gate 4, the exact-engine
post-deployment certificate, has not passed; its current state is in G10 below.

| Gate                       | Status                     | Evidence                                                                                                                                                                        |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain                  | not applicable with reason | 6A owns context-to-receipt provenance; the atlas domain matrix is stage 6B (`docs/horse-brain-phase6-build-plan-2026-09-18.md`)                                                 |
| G2 Inputs                  | verified now               | 6D serving-release population: request link present on 148 of 148 admitted 6b6eabb1 chains, 139 of them carrying v2 context receipts, each matching its snapshot                |
| G3 Computation             | not applicable with reason | 6A adds no calculation; `HorsePhase6Attribution.ts` records the lookup actually performed; calculation qualification is 6B and 6C                                               |
| G4 Immutable authority     | verified now               | `/health` 2026-09-27T16:47Z serves 6b6eabb1, which contains 563fac93 and f1059b99; the 6D observer confirmed image 5a705fd5 carries that revision before and after its read     |
| G5 Reachability            | verified now               | 80 complete five-link chains from 6b6eabb1 in the 2026-09-27 population (request, calculation, reference, accepted action, completed hand)                                      |
| G6 Outcome receipts        | verified now               | the 2026-09-27 population distinguishes atlas_evaluated 51, unavailable 64 and bypassed 33 attribution receipts on 6b6eabb1 (counts of chains)                                  |
| G7 Independent correctness | verified now               | rerun 2026-09-27: `TournamentBrainContextCache.test.ts` 25, `TournamentBlindSnapshot.test.ts` 22, `HorsePhase6Tournament.test.ts` 43, all passed                                |
| G8 Performance and replay  | not applicable with reason | original-input replay and latency measurement are stage 6C by the build plan                                                                                                    |
| G9 Learning and promotion  | not applicable with reason | Phase 6 activates no learned or promoted candidate                                                                                                                              |
| G10 Publication and use    | implemented but unverified | certificate for 6b6eabb1 run 36332268785 passed SPIN, SNG and the cash network-loss case and failed the MTT case on HUD-clock qualification budget (fixed in PR #5451, pending) |

## Phase 6B (2 of 4)

From merged #5417 (c8cbe6e6), `docs/horse-brain-phase6b-route-proof-2026-09-26.md`.

| Gate                       | Status                     | Evidence                                                                                                                                                        |
| -------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain                  | verified now               | `TOURNAMENT_PREFLOP_ATLAS_DOMAIN` descriptor; 215,424-coordinate totality loop, `HorsePhase6Tournament.test.ts` (44)                                            |
| G2 Inputs                  | verified now               | real-consumer checks: validator, worker, HorseLogic and HorsePreflop read the one domain, `HorsePhase6RouteRefusal.test.ts` (22), `workerRuntime.test.ts` (156) |
| G3 Computation             | verified now               | arithmetic at all 17 anchors under 3 ante modes and M boundaries 1, 5, 10, 20, 40 with half-M hysteresis, `HorsePhase6TournamentArithmetic.test.ts` (70)        |
| G4 Immutable authority     | verified now               | frozen descriptor, domain digest 4a8918a0 recomputed on the deployed build and matched                                                                          |
| G5 Reachability            | historical only            | route proof on 778075b4: 34,697 tournament preflop decisions matching their snapshot                                                                            |
| G6 Outcome receipts        | historical only            | route proof on 778075b4: 1,338 cells observed, 4,305 unobserved, 0 mismatches                                                                                   |
| G7 Independent correctness | verified now               | literal oracle rows; named mismatch refusal at the matcher and the live worker client, `HorsePhase6RouteRefusal.test.ts` (22)                                   |
| G8 Performance and replay  | not applicable with reason | original-input replay and latency belong to 6C                                                                                                                  |
| G9 Learning and promotion  | not applicable with reason | no candidate activation in 6B                                                                                                                                   |
| G10 Publication and use    | implemented but unverified | until a release containing c8cbe6e6 serves; 6b6eabb1 does not contain it                                                                                        |

## Phase 6C (3 of 4)

From PR #5456 (open, head 2a6b2bb6), section 10 of
`docs/horse-brain-phase6c-replay-protocol-2026-09-26.md`: the serving-release batch on 6b6eabb1,
the newest 200 decisions in 16:06Z to 16:41Z, 159 reproduced, 0 diverged, 41 refused by name
(34 `reference_unavailable:solver_store:postflop`, 4 `reference_unavailable:chart_store`, 3
`replay_unsupported:DECIDE_DEEP`). The statuses below are the 6C lane's, cited as that section
states them; they become main's record when #5456 merges.

| Gate                       | Status                     | Evidence                                                                                                                                |
| -------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain                  | implemented but unverified | section 10: the batch covers the observed variants and streets and names every unreplayed cell; the replay coverage matrix is 6D work   |
| G2 Inputs                  | verified now               | section 10: 197 of 200 serving-release records rebuilt from the record digest and decision key; 3 deep second looks refused by name     |
| G3 Computation             | verified now               | section 10: pot odds, M state, ante mode, atlas coordinate and route re-derived independently, agreed on 159 of 159                     |
| G4 Immutable authority     | implemented but unverified | section 10: chart and postflop stores identified by row count only and not loaded offline (unavailable external input for 38 decisions) |
| G5 Reachability            | verified now               | section 10: replay runs through the production worker runtime and HorseLogic on records 6b6eabb1 produced                               |
| G6 Outcome receipts        | verified now               | section 10: every verdict is reproduced, diverged or refused with a finite reason                                                       |
| G7 Independent correctness | verified now               | section 10: the verifier imports no production policy module; substituted action, RNG stream and stale M controls fail                  |
| G8 Performance and replay  | verified now               | section 10: 159 of 159 replayable decisions reproduced exactly at the recorded release, latency and work recorded per decision          |
| G9 Learning and promotion  | not applicable with reason | section 10: 6C learns and promotes nothing                                                                                              |
| G10 Publication and use    | verified now               | section 10: the replay code merged in #5412 (4946473b) is contained in 6b6eabb1 and replayed that release's natural records             |

## Phase 6D (4 of 4)

From the serving-release population `docs/evidence/phase6d/population-2026-09-27.{json,md}`:
declaration `population-declaration-2026-09-27.json` (sha256 b08e3ad3) committed at 16:49:15Z
before any record was read, window 2026-09-27T16:06:00Z to 16:49:00Z, 6b6eabb1 only admitted,
the same 3969 cells, target 3 per cell and 400 hands per stratum as the 2026-09-26 declaration.

| Gate                       | Status                     | Evidence                                                                                                                                                                                                                                    |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain                  | verified now               | 67 declared cells observed on 6b6eabb1 (cash 3, mtt 39, spin 17, hu_sng 8), 3902 unobserved and listed; sng 0 observed; branches open_facing, overcall and squeeze and table sizes 9 and 10 never reached                                   |
| G2 Inputs                  | verified now               | request link present on 148 of 148 admitted chains (lifecycle digest equals the decision snapshot digest)                                                                                                                                   |
| G3 Computation             | verified now               | calculation link present on 148 of 148 (decision receipt, sampling state and compute metadata validated by the serving image's validators)                                                                                                  |
| G4 Immutable authority     | verified now               | declaration committed before the read; the selector refuses an edited or uncommitted declaration and any drifted rerun; observer image 5a705fd5 equals the serving identity before and after                                                |
| G5 Reachability            | verified now               | 80 chains from 6b6eabb1 with request, calculation, reference, accepted action and completed hand all present                                                                                                                                |
| G6 Outcome receipts        | verified now               | 68 incomplete chains name their gap: missing:accepted_hand 54, missing:execution_witness 35, missing:hand_binding:no_witness 14, missing:accepted_action:second_look_unchanged 1 (a chain can carry two marks); all 68 are tournament hands |
| G7 Independent correctness | verified now               | `phase6dPopulation.test.ts`, 12 tests with explicit fixture predicates, passed 2026-09-27; the live link predicates are the image's validators, not an independent oracle                                                                   |
| G8 Performance and replay  | implemented but unverified | frozen population declared and walked; replay and latency on the same release are reported by the open PR #5456                                                                                                                             |
| G9 Learning and promotion  | not applicable with reason | Phase 6 activates no learned or promoted candidate                                                                                                                                                                                          |
| G10 Publication and use    | verified now               | the serving release 6b6eabb1 produced natural accepted receipts: 148 admitted preflop chains, 80 complete, read from its own archive at 16:49Z                                                                                              |

## What The Two 6D Populations Show And Do Not Show

- Serving release, 2026-09-27: `node server/scripts/phase6d-population.mjs run --declaration docs/evidence/phase6d/population-declaration-2026-09-27.json --out docs/evidence/phase6d --date 2026-09-27`. One stratum (16:06Z to 16:49Z) of 400 hands, which reached decisions from 16:14:55Z to 16:21:07Z. Of 911 decision records read, 406 were postflop; 505 preflop decisions were classified, all by 6b6eabb1; 148 were admitted up to the target, the rest counted as overflow per cell.
- The 68 incomplete chains are all mtt, spin or hu_sng hands from 16:17Z to 16:21Z whose completed-hand record or execution witness was absent from the archive at the read, about half an hour after those decisions. This lane records the gap; it does not diagnose or repair it, and it certifies nothing for those hands.
- 2026-09-26 declaration (window 2026-09-25T14:28:38Z to 2026-09-26T14:28:38Z): 193 cells observed, 3776 unobserved, 490 chains admitted, 459 complete, all from 778075b4, because the journal archive stopped at 500000 of 500000 segments at 2026-09-25T19:34:05Z. That run stays historical only; #5355's ring removed the cause and the serving release archives again.
- No cell is filled, estimated or inferred from a neighbour. Unobserved means unobserved.

## Remaining Dependencies

1. 6A G10: a passing exact-engine certificate; the MTT HUD-clock budget fix is PR #5451, pending.
2. 6B G10: a serving release containing c8cbe6e6.
3. 6C: PR #5456 merged, so section 10 becomes main's record.
4. 6D: the 68 tournament chains whose completed hand or witness was absent at the read need their owner's diagnosis; a later declaration can walk more of the serving window.
5. Phase 7 and later are not certified by any of this.
