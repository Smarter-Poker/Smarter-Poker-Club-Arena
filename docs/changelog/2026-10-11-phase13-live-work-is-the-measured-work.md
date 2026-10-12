# Phase 13 Live Work Is The Measured Work

**Date:** 2026-10-11

The Phase 13 joint owner (`server/src/engine/multiway/`) now does, on every live decision, exactly the fixed work the P13.2 matrix priced. No clock and no load signal decides how much of that work is done.

## What Was Wrong

The matrix prices every proposal on a fixed clock with the equity governor off: the full sample count (16 through four dealt players, 8 above), every sample drawn, every candidate priced through the bounded response tree. Live, three things cut that work short, and each cut decision executed the baseline instead of the measured policy:

- a 4 ms wall-clock budget (`JOINT_LIVE_DOMAIN.liveBudgetMs`) checked inside the response tree and again when the proposal finished (reason `work_budget`);
- a 2.5 ms wall-clock deadline on the sampler (`samplingDeadlineMs`, counted as sampler budget exhausted);
- the equity governor scaling the sample request (counted as governor-reduced).

On the engine host the priced decisions (nothing to call) cost about 4 ms at the median, so the budget cut about half of them whatever the load. In the predeclared PLO8 natural window on release f47ad93c (2026-10-11 20:02 to 20:50Z) 220 of 1,295 eligible decisions were cut by the budget, 94 were governor-reduced and 8 were cut by the sampler deadline; no street and no board count met the P13.3 completion floor (Wilson lower bounds flop 0.41, turn 0.27, river 0.34, preflop 0.89). The decision workers were not waiting for a CPU (run-queue wait 1% of their run time); the cut decisions were real work.

## What Changed

- `JointLivePolicy.ts`: the proposal is never replaced by the baseline because of elapsed time, and the response tree's continue check is constant. `latencyMs` is still measured and journaled.
- `JointSampleAcquisition.ts`: the request is always `jointFullSamples(dealtPlayers)`, never scaled by the governor (the #6592 rule for the Omaha and remaining-variant samplers), and the sampler is never stopped by a clock. `samplingMs` is still measured. `jointRequestedSamples` is removed.
- The work stays bounded by the declared limits the matrix also enforces, never by time: the full sample count, `JOINT_RANGE_PACK.rejectionAttempts` (3) per opponent per sample, at most 12 legal candidates (`joint_action_no_legal_candidates`), one bounded raise per tree and at most 32 terminal branches per candidate (`joint_response_branch_unavailable`). No new ceiling was added: these already are deterministic work counts the matrix runs under.
- `JOINT_LIVE_DOMAIN.liveBudgetMs` and `samplingDeadlineMs` are removed: nothing in the live path reads them. `JOINT_SAMPLE_WORK_BUDGET_MS` stays 4 ms as Phase 7's own tournament allowance in `HorseLogic.ts`, which this change does not touch.
- The completion definition (`horse-phase13-completion-definition-v2`) is unchanged; its `workBudget`, `samplerBudgetExhausted` and `governorReduced` fields still classify receipts of earlier releases and should read zero on this source.

## Proof That The Measured Policy Is Unchanged

On development seeds only (13101101 and 13102203; never a held-out seed of `JointStrengthContract.ts`), with a fixed clock and the governor off, the P13.2 league was played with the measured source (1235b47a) and with this source, 40 pairs per profile, 21 profiles covering all nine variants (one to three boards, 3 to 9 dealt, 100 to 1,000 BB). Both arms of every hand ended with identical nets, and at every one of 33,269 eligible cash decisions the joint policy's decision, proposal and full receipt (latencyMs removed) were identical text. A second run (seed 13102203, ten PLO8 and NLH profiles, 60 pairs) priced both builds on the same frozen state in one process: 10,124 decisions, 0 differences. On a fixed clock with the governor off the removed cut-offs could never fire, which is why the 1235b47a matrix result reproduces on this source.

The largest work seen in those decisions was 21 terminal branches for one candidate (the declared limit is 32) and 9 candidates (limit 12).

## Live Cost

Measured with Node 22.23.3 (the engine runs 22.23.2) on the development Mac, single first calls per decision, process warm-up excluded, then scaled to the engine host by the ratio of production to local time for decisions facing a wager, which the old budget never cut (PLO8 1.10 / 0.46 ms, factor 2.37; NLH 0.63 / 0.20 ms, factor 3.21):

|                                                        | PLO8 nothing to call        | NLH nothing to call         |
| ------------------------------------------------------ | --------------------------- | --------------------------- |
| Local p50 / p90 / p99 / max (ms)                       | 1.61 / 2.13 / 2.75 / 7.80   | 1.28 / 1.68 / 2.54 / 7.75   |
| Projected host p50 / p90 / p99 (ms)                    | 3.8 / 5.0 / 6.5             | 4.1 / 5.4 / 8.1             |
| Share that the 4 ms budget cut                         | 40% (production window 63%) | 56% (production window 44%) |
| Extra host CPU per previously cut decision, mean / p90 | 0.76 / 1.52 ms              | 0.91 / 1.91 ms              |

Decisions facing a wager are unchanged (host p50 1.15 ms PLO8, 0.59 ms NLH). About 298,000 decisions a day were cut by the budget on 2026-10-10 (NLH 198,029, PLO6 36,672, PLO5 31,016, PLO4 23,779, PLO8 7,403, FLO8 867), so finishing them costs about 4 to 5 minutes of decision-worker CPU a day; drawing the full sample where the governor used to reduce it adds about 0.5 to 3 minutes more, depending on how often the governor is below 1. Together that is roughly 0.2 to 0.3% of the two decision workers' day. The workers are already busy (queue depth near 150 at peak), so this is added queueing, not free time; the worst single decision seen locally after warm-up projects to about 18 to 25 ms on the host.

## Records

Every change here is a Phase 13 policy source file, so every Phase 13 policy digest changes (PLO8 e8aca2339a57... on 1235b47a; the final value on the integrated source is in the table below). The qualified PLO8 matrix (run 38011357161, measured on 1235b47a) must be re-run on the new source before the PLO8 selection, and a new predeclared natural completion window read on a release with the new digest. Phase 10, 11 and 12 digests are unchanged.

The P13.2 contract's `policy_clock_and_sampling` entry described the old live clock in its `live` text. That one text field now states the live source as it is (the matrix's fixed work, its declared limits, no clock or governor cut); every other field of `JOINT_STRENGTH_CONTRACT` is byte-identical, and the version stays `joint-strength-contract-v1` as in the round 3 revision. The contract digest moves from 1d0dd99be2fedd7e... to 0cd88d970c600fb6..., so the PLO8 re-run is assembled under the new contract.

Tests: `JointSampleAcquisition.test.ts`, `JointLivePolicy.test.ts`, `HorsePhase13Authority.test.ts` and `workerRuntime.test.ts` now pin that a slow clock, a late deadline and a loaded governor each give the fixed-clock receipt.

## Final Digests On The Integrated Source

This change is integrated, unpushed, with the Phase 12 round 4 change (exact sampler kernels, one contract per pack) on branch `agent/claude-horse-brain/p13-work-budget-20261011`, rebased onto `origin/main` `e5303503`. Phase 10 and Phase 11 equal `origin/main`.

| Phase | Pack or variant  | Digest                                     | Value                                                            |
| ----- | ---------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| 10    | PLO4             | policy (equals main)                       | 7f7968b11afd353646de507a381c188f131f241191ad1eb6fb33f563fb0ceadb |
| 10    | PLO4             | contract                                   | 83ab185b2a2df72876b73d61ece6ea8c2f03f364ce252deecbfcde392ae5f838 |
| 11    | PLO5             | policy (equals main)                       | 9d5b1ed11d1ec000ae84ceb3cd1c0ff6df36d573e7371e8d9b74a0f151cda5ba |
| 11    | PLO6             | policy (equals main)                       | 2f3c66713a7d3d237d9fe7e4e0461da9d36d0bd3a8f51078ed1271099c139df0 |
| 11    | PLO8             | policy (equals main)                       | db899eb1b9fb64061f55816f31c82cb282b10d14eae0e669d6bd16320eefa62f |
| 11    | PLO5, PLO6, PLO8 | contract                                   | 5b93ae20962ff79798b998f437ed43d2bd224a64995d86e34ed63d7bb22057fc |
| 12    | Short Deck       | policy                                     | 87db1f17b03e4a8b8f4325f9389f66b0200228fbf6b42df891baef341b1fd340 |
| 12    | Short Deck       | contract                                   | 6c50e71707addc7b9f740493840e5d59053773d63ea7af5cdf33a6108036b16f |
| 12    | Crazy Pineapple  | policy                                     | ee16b3cf1e05969d6fcccb23b774b295e6a3ffb829d5ab9374b2245f50ffc005 |
| 12    | Crazy Pineapple  | contract                                   | 6c50e71707addc7b9f740493840e5d59053773d63ea7af5cdf33a6108036b16f |
| 12    | FLH              | policy                                     | d1c536a9f1b6889478da2ad4c5d5d985a130a47fb794169ddf6f420a6ccde8fb |
| 12    | FLH              | contract                                   | fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0 |
| 12    | FLO8             | policy                                     | 663a3ae7bca1729cdbcaf8b170646f4c0815fc69cb5739a47249023678d18a98 |
| 12    | FLO8             | contract                                   | 6c50e71707addc7b9f740493840e5d59053773d63ea7af5cdf33a6108036b16f |
| 13    | NLH              | policy                                     | 1a6a831343bb4ca7f60aca2067df02090df5c68d39fc493cbb521b066dc3d87d |
| 13    | PLO4             | policy                                     | 9c6afc09f81d400b913f63e663ad35bcf65661a441a04fbfcf3fe2305853aefa |
| 13    | PLO5             | policy                                     | af2b49e8c364a80089327e8a39ff7bbc318038c9a9b54794239200d0895ad837 |
| 13    | PLO6             | policy                                     | 95ba3d1afed28e0fb62acc839f54238b18543f352b2c6ca82b33aacdf2c32d05 |
| 13    | PLO8             | policy                                     | ca120931043d80031982abae93276023e59947e280792246c8de7ea83ba0fc26 |
| 13    | FLO8             | policy                                     | d2dbd6590ddbb1648843c2461161ea2d21f37f24d25ff8e1d0941cde2a53f11a |
| 13    | FLH              | policy                                     | 4d9cb504bbc30d70a033e4385c1f35efcecccea1796252624d5ac044cbfe6904 |
| 13    | Crazy Pineapple  | policy                                     | 769e86b32e41f97e543098bc5e246fd6d65056f82ff61f8fee01b9fee1bb3cb1 |
| 13    | Short Deck       | policy                                     | 0a8205ec01ad65538107da2f9835f50caabbed8078b4d027531024f9abaaa555 |
| 13    | all nine         | contract (PHASE13_RUNNING_CONTRACT_DIGEST) | 0cd88d970c600fb64933337672af349e9d106402d4edfcc3510e1f26374741f8 |
