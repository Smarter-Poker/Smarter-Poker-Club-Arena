# Horse Brain Phase 8.2 Strength Evidence, 2026-10-01

Status: **NOT PROMOTED. No promotion run could start on this Mac.** All 18 required runs were launched through the maintained runner and all 18 were refused before the first paired tournament. The refusals are recorded below; nothing was shrunk, reseeded or replaced with fixture data.

Machine record: [`docs/evidence/phase8/strength-2026-10-01.json`](evidence/phase8/strength-2026-10-01.json) and one summary per run under [`docs/evidence/phase8/strength-2026-10-01/runs/`](evidence/phase8/strength-2026-10-01/runs/).

## Contract Run

- Source: `4948e0ffd527adee5d898426f7abd84be0be09ab` (clean checkout), server source SHA-256 `bb617c83e843a67516a5b7a9faac22777ad9920d927f54cb3dd3a5d2f5199a6f` over 1,651 files.
- Runner: `server/src/scripts/horseTournamentEvaluate.ts --promotion --objective=<objective> --seed=<seed>`, one process and one log per run, exit code recorded.
- Matrix: seeds 8101101, 8102203, 8103307; objectives mtt, sng, spin, satellite, pko, mystery; 1,024 paired tournaments per run; 18 distinct runs.
- Domain: NLH single-board tournament only. Every other variant, multi-board and cash domain is refused by the contract and was not attempted.
- Host: Mac Studio, darwin arm64, 28 physical cores.

## Why Every Run Was Refused

1. **Solver-store credential (unavailable external input).** Promotion mode hydrates the chart, compact postflop and certified V31 stores from project `kuklfnapbkmacvwxktbh`. Both service credentials available to agents on this Mac (the Club Arena server environment file and the shared agent credential file) are rejected by Supabase with `Unregistered API key`. A read-only privilege check shows `gto_postflop_compact` and `fn_gto_v31_active_cells` are granted to `service_role` only, so no publishable key can substitute. Issuing a replacement secret key is a write to production credential configuration and is outside this lane's read-only database authority.
2. **Qualified Linux launcher (unavailable external input).** `HorseLeagueComputeWorkerClient.defaultWorkerFactory` refuses every platform other than Linux: `horse league process requires the qualified Linux launcher`. Its low-priority proof (`HorseLeagueProcessPriority.ts`) is Linux thread-group scope. This Mac has no running Linux instance. The boundary is deliberate, so it is not a runner defect and was not weakened.

Either blocker alone prevents a qualifying run. The worker would additionally refuse promotion with empty stores (`Tournament promotion requires hydrated, identified solver stores`).

## The 18 Runs

| Run               | Seed    | Objective | Pairs completed | Exit | 99% lower bound | Illegal / conservation / truncation | Status                     |
| ----------------- | ------- | --------- | --------------- | ---- | --------------- | ----------------------------------- | -------------------------- |
| mtt-8101101       | 8101101 | mtt       | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| sng-8101101       | 8101101 | sng       | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| spin-8101101      | 8101101 | spin      | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| satellite-8101101 | 8101101 | satellite | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| pko-8101101       | 8101101 | pko       | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| mystery-8101101   | 8101101 | mystery   | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| mtt-8102203       | 8102203 | mtt       | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| sng-8102203       | 8102203 | sng       | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| spin-8102203      | 8102203 | spin      | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| satellite-8102203 | 8102203 | satellite | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| pko-8102203       | 8102203 | pko       | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| mystery-8102203   | 8102203 | mystery   | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| mtt-8103307       | 8103307 | mtt       | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| sng-8103307       | 8103307 | sng       | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| spin-8103307      | 8103307 | spin      | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| satellite-8103307 | 8103307 | satellite | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| pko-8103307       | 8103307 | pko       | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |
| mystery-8103307   | 8103307 | mystery   | 0 of 1,024      | 1    | none            | not measured                        | unavailable external input |

Critical-commitment nonregression, completed versus named-refusal reconciliation and p99 deadline evidence are absent for every run because no tournament was played. Absent is not zero.

## Promotion Verdict

`summarizeTournamentPromotion` over the 18 retained receipts (none of which carries a tournament result) returns `promoted: false` with reasons `missing_or_duplicate_seed` for each of the six objectives and `incomplete_run_matrix`. Every objective bucket has 0 pairs and the full support interval [-1, 1].

| Objective | Pooled pairs | Verdict      |
| --------- | ------------ | ------------ |
| mtt       | 0            | not promoted |
| sng       | 0            | not promoted |
| spin      | 0            | not promoted |
| satellite | 0            | not promoted |
| pko       | 0            | not promoted |
| mystery   | 0            | not promoted |

## Throughput Projection (Not Evidence)

To size the work once the blockers are cleared, `runTournamentLeague` was called in-process in fixture mode with unhydrated stores, 4 pairs per objective, six objectives concurrently on this Mac. This bypasses the qualified process and the solver stores, so it is a timing estimate only.

| Objective | ms per pair | Projected hours per 1,024 pairs |
| --------- | ----------- | ------------------------------- |
| mtt       | 6,322       | 1.80                            |
| sng       | 6,526       | 1.86                            |
| spin      | 2,843       | 0.81                            |
| satellite | 5,722       | 1.63                            |
| pko       | 6,196       | 1.76                            |
| mystery   | 5,936       | 1.69                            |

With 18 runs in parallel on 28 physical cores the matrix projects to roughly two hours of wall time, before any solver-store lookup cost.

## What Unblocks P8.2

1. A registered `service_role` secret for `kuklfnapbkmacvwxktbh` in the canonical local agent credential file, issued by the credential owner.
2. A qualified Linux host for the league process that is not the production engine host, with the solver credential available to it.
3. Then rerun exactly this matrix with no change to seeds, pairs or objectives.

## P8.2 Gate Statuses

| Gate               | Status                     | Reason                                                                                                                                             |
| ------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain          | not applicable with reason | Only the NLH single-board tournament domain is implemented; all other domains are refused. The six declared objectives are the full in-domain set. |
| G2 Inputs          | unavailable external input | Solver-store hydration from the approved project is rejected (`Unregistered API key`).                                                             |
| G3 Calculation     | unavailable external input | No promotion-mode tournament was played.                                                                                                           |
| G4 Authority       | implemented but unverified | Source, seed and solver identities are captured in each manifest; no complete receipt exists to bind them to.                                      |
| G5 Actual use      | not applicable with reason | P8.2 produces offline evidence only; activation belongs to P8.3.                                                                                   |
| G6 Outcomes        | unavailable external input | No completed or refused continuation counts exist for any run.                                                                                     |
| G7 Correctness     | historical only            | Existing league suites cover legality, conservation and forged receipts; no new suite run was needed because no source changed.                    |
| G8 Work and replay | unavailable external input | Frozen seeds and pairs are preserved; no p99 deadline evidence was produced.                                                                       |
| G9 Promotion       | unavailable external input | The contract correctly refuses with zero of 18 runs and no positive lower bound. P8.2 does not promote.                                            |
| G10 Publication    | not applicable with reason | Nothing is activated or deployed by P8.2.                                                                                                          |
