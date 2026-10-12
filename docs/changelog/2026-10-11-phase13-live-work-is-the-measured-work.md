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

Every change here is a Phase 13 policy source file, so every Phase 13 policy digest changes (PLO8 e8aca2339a57... on 1235b47a to 4bf6b5034c1a... on this source). The qualified PLO8 matrix (run 38011357161, measured on 1235b47a) must be re-run on the new source before the PLO8 selection, and a new predeclared natural completion window read on a release with the new digest. Phase 10, 11 and 12 digests are unchanged.

The P13.2 contract's `policy_clock_and_sampling` entry described the old live clock in its `live` text. That one text field now states the live source as it is (the matrix's fixed work, its declared limits, no clock or governor cut); every other field of `JOINT_STRENGTH_CONTRACT` is byte-identical, and the version stays `joint-strength-contract-v1` as in the round 3 revision. The contract digest moves from 1d0dd99be2fedd7e... to 0cd88d970c600fb6..., so the PLO8 re-run is assembled under the new contract.

Tests: `JointSampleAcquisition.test.ts`, `JointLivePolicy.test.ts`, `HorsePhase13Authority.test.ts` and `workerRuntime.test.ts` now pin that a slow clock, a late deadline and a loaded governor each give the fixed-clock receipt.
