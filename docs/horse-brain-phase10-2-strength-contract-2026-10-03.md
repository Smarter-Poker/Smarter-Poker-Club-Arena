# Horse Brain Phase 10.2 PLO4 Strength Contract, 2026-10-03

Horse Brain only. Status vocabulary: verified for named evidence, implemented but unverified, defective, unavailable dependency, historical only, not applicable with a reason.

Status: **CONTRACT LOCKED BY MERGE, NOT MEASURED.** This record states the P10.2 contract that a PLO4 strength run must satisfy, and the machinery that runs and judges it. No matrix run has been made. The matrix is dispatched only after this merges, against a commit on main, so every threshold, seed, pair count and interval below was fixed before any held-out hand was dealt. `promotionEligible` stays `false` everywhere. The pack stays `plo4-policy-round1-v3` in shadow.

The contract object is `PLO4_STRENGTH_CONTRACT` (`plo4-strength-contract-v1`) in [`server/src/benchmark/Plo4StrengthContract.ts`](../server/src/benchmark/Plo4StrengthContract.ts). It is deeply frozen, and every run, assembly and qualification file binds its digest (`plo4StrengthContractDigest()`, sha256 of the contract JSON). At this record's commit the digest is `ebdbdbb48336c0425df735fa073a4a28ef4884c199a69006e27909a6bc2b6384`. A shard or assembly made under any other digest is refused by name (`contract_digest_mismatch` or `contract_mismatch`).

## What P10.2 Asks, And Where Each Part Lives

| Requirement (completion plan, P10.2)                                                                                                    | Where it is met                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate cash after-rake improvement from tournament prize and bounty                                                                   | `objectives.cash` (measured) and `objectives.tournament` (refused by name)                                                                                                                                                                                                                                                                                                                                                                                                  |
| Preserve current software-validity and position-coverage controls                                                                       | The existing league counters (illegal actions, conservation, card errors, truncation, fixed work, dealer-relative rotation) are unchanged. The contract adds zero-tolerance settlement, deduction and paired-replay checks, plus exactly balanced position coverage per shard                                                                                                                                                                                               |
| Phase 9 independent rules                                                                                                               | Per hand, both arms: `settleOmahaReference` (OmahaReference.ts) re-settles every showdown, a fold win must pay the sole survivor the contested pot less deductions, a hand that ends with two or more live seats before a full board counts as a mismatch, and `effectiveRake`/`effectiveBbjDrop` (rakeSpec.ts, the arithmetic the database implements) check the deductions. The engine prices the hand with its own `getFullRakeConfig`/`getPlayerCountCaps` and BBJ drop |
| Fixed, source-qualified held-out populations                                                                                            | `population` and `holdout`. Every profile is a six-max table at the published PLO4 1/2 price, with the five production horse styles. Three seeds are used by nothing else, and every PLO4 and Omaha league entry point refuses them except the contract shard runner in contract mode                                                                                                                                                                                       |
| Lock candidate and reference source, seeds, paired sample sufficiency, uncertainty and critical-domain nonregression before measurement | `candidate`, `reference`, `matrix`, `statistic`, `interval`, `thresholds`, `nonregressionCells`, all in the frozen contract, locked by this merge                                                                                                                                                                                                                                                                                                                           |
| Write every new numerical threshold into the contract, without borrowing NLH tournament thresholds or inventing solver authority        | `thresholds` (each justified below). No NLH tournament number is used. The reference is the deployed Horse policy, not a solver                                                                                                                                                                                                                                                                                                                                             |
| Tournament: real Phase 7 objective and a coherent future model, or an unavailable dependency                                            | Refused by name. The reasons are below                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `promotionEligible: false` until contract and evidence support it                                                                       | Unchanged on the league and on every shard. Only `summarizePlo4Strength` over the whole matrix can say `qualified`                                                                                                                                                                                                                                                                                                                                                          |
| Atlas coordinate count and a changed proposal are not strength gates                                                                    | `notStrengthGates`. The verdict never reads either                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Machine Record

| File                                                                                                            | Contents                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`server/src/benchmark/Plo4StrengthContract.ts`](../server/src/benchmark/Plo4StrengthContract.ts)               | The contract, its digest, the profiles and held-out seeds, the exact interval (`plo4CellStatistic`), the per-shard refusals (`plo4StrengthShardReasons`) and the whole-matrix verdict (`summarizePlo4Strength`)                                                                                              |
| [`server/src/benchmark/Plo4PolicyLeague.ts`](../server/src/benchmark/Plo4PolicyLeague.ts)                       | `runPlo4StrengthShard`: the contract shard runner over the existing paired league. Also `plo4IndependentHandChecks`, published pricing, production styles, `plo4DivergenceStreet`, and the refusal of held-out seeds in `runOmahaPolicyLeague` (behind `runPlo4PolicyLeague` and the Phase 11 to 13 leagues) |
| [`server/src/scripts/plo4StrengthEvaluate.ts`](../server/src/scripts/plo4StrengthEvaluate.ts)                   | One shard per process. Contract mode needs a clean checkout. It writes `manifest.json` and the shard result, and a SIGTERM still writes an incomplete receipt                                                                                                                                                |
| [`server/scripts/phase10-strength-assemble.mjs`](../server/scripts/phase10-strength-assemble.mjs)               | Assembler. It imports the contract, refuses by name, and writes `strength.json` and `horse-phase10-qualification-v1`                                                                                                                                                                                         |
| [`.github/workflows/horse-phase10-strength-league.yml`](../.github/workflows/horse-phase10-strength-league.yml) | Manual dispatch, from main only, for one commit on main. The matrix is read from the contract. One shard per job, attempts recorded                                                                                                                                                                          |
| `Plo4StrengthContract.test.ts`, `Plo4PolicyLeague.test.ts`, `phase10StrengthAssemble.test.ts`                   | Contract, interval, verdict, shard machinery, independent checks and assembler refusals                                                                                                                                                                                                                      |

## Objectives

**Cash after rake (measured).** The metric is the paired difference of the hero seat's net chips per hand: final stack minus starting stack, after the engine's rake and BBJ drop, candidate minus reference, reported in bb/100. The candidate is `HorseLogic.decide` with `phase10Plo4: 'candidate'` (Plo4LivePolicy over `plo4-policy-round1-v3`). The reference is the same call with `phase10Plo4: 'off'`, which is the deployed reference proposal. Both arms of a pair use the same deal seed: identical cards, hero seat, button and seat styles. BBJ jackpot awards are excluded, because the database pays them from the external pool after the hand. They are not part of hand settlement.

**Tournament prize and bounty: unavailable dependency, refused by name.** The verdict returns these reasons in `tournament.reasons`, and the qualification file carries them in `objectives.tournament.reasons`. They are never in the top-level `reasons`, which hold cash failures only and decide `qualified`: cash qualification stays possible while the tournament objective refuses.

- `tournament:plo4_whole_tournament_outcome_model_unavailable`. The only coherent future and outcome model in source for a tournament objective is the Phase 8 paired whole-tournament league: `HorseTournamentLeague.ts`, with `realizedTournamentReturn` over the funded pool. It deals NLH only (`gameVariant: 'nlh'`). The Phase 7 owner, `HorseTournamentUtility.evaluateTournamentUtilityDetailed`, prices single decisions inside a hand. The existing PLO4 league tournament profile measures single-hand chip EV (`single_hand_chip_ev_only_not_tournament_prize_ev`). Relabelling that as a prize objective is what P10.2 forbids.
- `tournament:qualified_plo4_tournament_reference_population_unavailable`. No source-qualified PLO4 tournament structure population exists: field sizes, payout tables, bounty formats.
- `tournament:plo4_tournament_thresholds_not_specified`. NLH tournament strength thresholds are not borrowed, and no PLO4 tournament number is invented before an outcome model exists.

The contract can grant only the cash qualification. The qualification file reports the tournament objective separately, as `qualified: false` with these reasons. P10.3 keeps Phase 7 as the tournament owner.

## Population And Source Qualification

| Element          | Value                                                                                                                                              | Source                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Table            | Six-max PLO4 cash, single board, no ante, no straddle                                                                                              | Every production Omaha cash table is six-max and locked. No seven- or eight-seat Omaha table has opened since 2026-09-08 ([Phase 9 completion](horse-brain-phase9-completion-2026-10-03.md), G5) |
| Stake and rake   | 1/2, 10%, cap 5.00 chips; heads-up 5% with cap 2.50; three or more dealt at six-max use the full cap; no flop, no drop                             | `getFullRakeConfig(1, 2, 'plo4')`, `getPlayerCountCaps(5, 6)`, `calculateRake` heads-up ceiling, as `ServerTableEngineBase.getRakeConfig` builds a cash hand                                     |
| BBJ drop         | 0.25 BB per flop with 3 or more dealt; payout floor 10 BB                                                                                          | `getFullRakeConfig(...).bbjFeeBB` and `rules`, as `ServerTableEngineBase` builds `bbjConfig`                                                                                                     |
| Depth            | 40, 100 and 200 BB                                                                                                                                 | `CASH_MIN_BB`, standard, `CASH_MAX_BB` (`config/cashBuyIn.ts`)                                                                                                                                   |
| Styles           | Every seat, hero included, uniform over tag, lag, balanced, tricky and grinder, by `plo4StrengthSeatStyle(dealSeed, seat)`. Identical in both arms | Production horses get these five styles uniformly by id hash (`HorseLogic.ts` style fallback, `HorseOnboarding.ts` `brainFor`)                                                                   |
| Opponents        | The production Horse population (`HorseLogic.decide`) at the evaluated source                                                                      | Same commit as the candidate                                                                                                                                                                     |
| Human population | Unavailable dependency. The cash qualification is scoped to the Horse population                                                                   | P14-D owns qualified human references and independent holdouts                                                                                                                                   |

Excluded from the qualified domain, by name in `population.excludedFromQualifiedDomain`:

- antes and straddles (the development `straddle-ante-100bb` profile stays software validity only);
- tables above six seats, three or five dealt, and other stakes;
- depth outside 40 to 200 BB;
- bomb pots, multi-board and run it twice (Phase 13 boundaries);
- every tournament format.

**Held-out seeds.** The seeds are 10201109, 10202231 and 10203347. They are disjoint from the development seeds `PLO4_LEAGUE_SEEDS` (10101101, 10102203, 10103307) and from the Phase 8 seeds. A test checks that none of the first 4,096 deal seeds of each held-out seed equals any of the first 32 deal seeds (the development league maximum) of a development seed. `runOmahaPolicyLeague`, and with it `runPlo4PolicyLeague` and the Phase 11 to 13 leagues, throws on a held-out seed. `runPlo4StrengthShard` refuses a development seed in contract mode and a held-out seed in development mode. No test, timing run or pilot has dealt a held-out hand.

## The Locked Matrix

Five profiles × three held-out seeds × the profile's shards. Each shard plays pair indices `[k × 23,040, (k + 1) × 23,040)` of its (profile, seed) cell, so each shard is a fixed, contiguous slice of one deterministic sequence. 23,040 = 40 × 576, and 576 is a multiple of every profile's seats² (4, 16, 36), so every shard visits each (hero seat, button) pair the same number of times. Position coverage is therefore exact and balanced per shard. The workflow's plan job reads this matrix from the contract at the evaluated commit.

| Profile                  | Dealt / table | Stack  | Depth band | Shards per seed     | Pairs per profile   | Pilot SD (BB/hand) | Est. minutes per shard (hosted) | Est. runner minutes per (profile, seed) |
| ------------------------ | ------------- | ------ | ---------- | ------------------- | ------------------- | ------------------ | ------------------------------- | --------------------------------------- |
| `p10c-6max-2dealt-100bb` | 2 / 6         | 100 BB | standard   | 2                   | 138,240             | 7.61               | 8                               | 17                                      |
| `p10c-6max-4dealt-100bb` | 4 / 6         | 100 BB | standard   | 8                   | 552,960             | 16.07              | 18                              | 141                                     |
| `p10c-6max-40bb`         | 6 / 6         | 40 BB  | short      | 4                   | 276,480             | 9.20               | 22                              | 86                                      |
| `p10c-6max-100bb`        | 6 / 6         | 100 BB | standard   | 8                   | 552,960             | 13.49              | 22                              | 177                                     |
| `p10c-6max-200bb`        | 6 / 6         | 200 BB | deep       | 15                  | 1,036,800           | 21.38              | 24                              | 353                                     |
| **Total**                |               |        |            | **37 (111 shards)** | **2,557,440 pairs** |                    |                                 | **about 39 runner-hours**               |

**Run time.** Measured on the development Mac (design pilot, below): 8.8 to 24.5 ms per pair, so a 23,040-pair shard takes about 3.4 to 9.4 minutes. The hosted estimate budgets 2.5 times that: about 8 to 24 minutes per shard, plus about 2 to 3 minutes for checkout and `npm ci`. With `max-parallel: 20`, the 111 jobs run in about six waves, roughly 2.5 to 3 hours of wall time. Every job sits far inside its 120-minute timeout. A runner lost to a shutdown signal, as happened twice on 2026-10-02, costs one short shard.

**Design pilot (disclosed).** The pilot sized the shard counts. It ran `runPlo4StrengthShard` in development mode on development seed 10101101, 576 pairs per profile, and recorded only the paired-difference standard deviation and the time per pair. No held-out seed was used. No mean difference was computed or looked at. All validity counters were zero, and 1,155 showdowns and 4,605 fold wins (5,760 hands) were independently re-settled.

## Statistic And Uncertainty

- **Unit.** Exact integer chip cents per pair. bb/100 = mean cents / 200 × 100.
- **Strata.** Each shard keeps exact integer power sums `n, S1, S2, S3, S4` per dealer-relative offset × divergence street. The assembler merges them exactly, as BigInt, so no per-pair data is needed and nothing is lost.
- **Divergence street.** This is the street of the first action at which the two arms' traces differ: none, preflop, flop, turn or river. Both arms are deterministic given the deal seed, so this partitions the sample space before the run. It is not a post-treatment selection. Identical traces with a nonzero difference count as a paired replay mismatch, which is a validity failure.
- **Estimator.** The stratified mean `T = Σ w_p · mean_p`, with equal weight `w_p` per profile among the profiles a cell contains. Pairs are pooled within a profile across seeds and shards.
- **Interval (exact method).** Two-sided 99% normal (Wald) interval: `T ± z · sqrt(Σ w_p² s_p² / n_p)`. Here `z = Φ⁻¹(0.995) = 2.5758293035489004` and `s_p²` is the unbiased within-profile variance, computed exactly from the power sums (`n(n−1)s² = n·S2 − S1²`).
- **Validity of the normal approximation.** An interval is trusted only if both of these hold:
  1. Edgeworth skewness guard. The first Edgeworth term of a one-sided bound's coverage error, `|κ|(2z² + 1)φ(z)/6`, is at most 0.001. Here κ is the skewness of the estimator itself, `Σ w³ μ3_p / n_p² ÷ Var(T)^1.5`, with μ3 taken exactly from `n²S3 − 3nS1S2 + 2S1³`. This keeps the one-sided 0.5% error below 0.6%.
  2. Every profile in the cell has at least 10,000 pairs. With heavy tails, the variance estimate's own relative standard error is about `sqrt((kurtosis − 1)/n)`, which stays under 10% for kurtosis up to 100 at n = 10,000. The pilot measured kurtosis from 15 to 102.

  A cell that fails either guard is `interval_not_trusted` and refused, never relaxed.

## Thresholds And Their Justification

| Gate                          | Threshold                                                                                                                                               | Justification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary, cash after rake      | 99% lower bound **> 0 bb/100**, all five profiles pooled with equal weight                                                                              | Zero is break-even after the house's take. Any positive value means the horse keeps more money than the reference against the same population at the published rake and BBJ drop. The lower end of a two-sided 99% interval bounds a false promotion at 0.5%. No positive effect-size floor is set, because no calibrated cost of switching exists in source                                                                                                                                                                                              |
| Seed replication              | Each held-out seed block's pooled point estimate **> 0 bb/100**                                                                                         | Three independent replication blocks, fixed in advance. Requiring each to point the same way keeps the result from resting on one block. A zero true effect passes all three with probability 1/8, on top of the primary bound                                                                                                                                                                                                                                                                                                                            |
| Critical-domain nonregression | Every cell's 99% lower bound **≥ −10 bb/100**                                                                                                           | 10 bb/100 is one 100 BB buy-in per 1,000 hands, about the size of a whole winning edge in PLO cash. A domain that may lose more than that against the reference could turn a break-even reference into a clear loser there, whatever the pooled result says. The shard counts plan every cell's 99% half-width at or below 8.5 bb/100 (1.2 × pilot SD), so a cell that truly breaks even can show it. No multiplicity relief is applied: every cell must pass at 99% (intersection-union), so passing them all together is no easier than passing any one |
| Interval validity             | Edgeworth coverage error ≤ 0.001; ≥ 10,000 pairs per profile in each cell                                                                               | See the uncertainty section                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Software validity, per shard  | Illegal actions 0, conservation errors 0, card errors 0, truncated hands 0, settlement mismatches 0, deduction mismatches 0, paired replay mismatches 0 | Any nonzero count means the measurement is not of the policy. Zero is the only defensible tolerance                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Nonregression cells** (18 in all; planned 99% half-widths at 1.2 × pilot SD):

| Family                                      | Cells                                                                                         | Planned half-width (bb/100)       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------- |
| Profiles                                    | the five profiles                                                                             | 5.4 to 6.7                        |
| Positions (pack names, `positionForOffset`) | button, small blind, big blind, cutoff, middle, early                                         | 5.9, 7.1, 5.9, 7.1, 8.3, 8.3      |
| Depth bands                                 | short (40), standard (100: 2, 4 and 6 dealt), deep (200)                                      | 5.4, 3.6, 6.5                     |
| Street families                             | preflop, flop, turn, river divergence, each measured as its contribution to the pooled bb/100 | about the primary's (2.7) or less |

The street contributions and the no-divergence pairs (exactly zero) sum to the primary estimate.

## What Refuses By Name, And Why

**The verdict** (`summarizePlo4Strength`) names every failure. Nothing is dropped:

- `<shard>:missing_shard`, `duplicate_shard`, `unexpected_shard`: the matrix must be exactly the contract's 111 shards.
- Per-shard reasons from `plo4StrengthShardReasons`:
  - identity: `schema_mismatch`, `contract_version_mismatch`, `contract_digest_mismatch`, `pack_version_mismatch`;
  - mode and scope: `not_contract_mode`, `unknown_profile`, `not_holdout_seed`, `shard_outside_matrix`, `first_pair_mismatch`, `pairs_below_contract`;
  - completeness and coverage: `incomplete`, `position_coverage_incomplete`, `position_coverage_unbalanced`, `offset_count_mismatch`;
  - strata: `strata_pair_count_mismatch`, `unknown_stratum`, `paired_replay_mismatch`;
  - validity: each nonzero validity counter by its own name;
  - other: `fixed_work_not_proven`, `shard_claims_promotion`.
- `cash:primary:lower_bound_not_above_zero`, `cash:seed:<seed>:point_estimate_not_above_zero`, `cash:<cell>:regression_margin_exceeded`, `cash:<cell>:interval_not_trusted`.
- The three tournament reasons above, always, in `tournament.reasons`. They are never in the top-level `reasons`, which hold cash failures only and decide `qualified`.

**The shard runner** (`runPlo4StrengthShard`) throws before dealing a hand when it gets:

- a held-out seed in development mode, or a development seed in contract mode;
- a contract shard with a changed pair count;
- a shard outside the profile's range;
- an unknown profile;
- a load-scaled equity governor (`EQUITY_GOVERNOR=off` and scale 1 are required, as before).

Through the CLI such a refusal leaves only `manifest.json` and no result, so it can never be counted as an attempt. The CLI refuses an unknown profile before writing anything, and refuses contract mode in a dirty checkout. It records `sourceUnchanged`, the before-and-after source fingerprint.

**The assembler** exits 2, names every reason and writes nothing when it finds:

- `unexpected_run_directory`, `unexpected_shard`, `missing_runner_record`;
- `missing_complete_result` (unless a `--defective` record names the shard; the shard then stays missing in the verdict and the matrix is not qualified);
- `declared_defective_but_has_result`;
- `manifest_scope_mismatch`, `result_identity_mismatch`, `receipt_mismatch`;
- `not_contract_mode`, `dirty_checkout`, `contract_mismatch`, `pack_version_mismatch`;
- `source_changed_during_run`, `identity_mismatch:<head|sourceSha256|sourceFiles|serverLockSha256>`;
- `nondeterministic_replay`;
- `missing_runs_directory`, `no_complete_shards`, `unknown_defective_shard`, `invalid_defective_record`, `source_head_unknown`;
- `output_exists`, `output_name_must_be_strength-YYYY-MM-DD`, `evidence_outside_docs/evidence/phase10/`, `prettier_unavailable`, `policy_source_unreadable`.

Development-mode assemblies (tests only) refuse contract runs (`not_development_mode`) and always write `qualified: false`, with `development_mode_never_qualifies`.

**The workflow** refuses:

- a dispatch from any ref but main (both jobs are gated on `refs/heads/main`);
- a `source_sha` that is not 40 hex, or not an ancestor of `origin/main`;
- a commit without the contract file;
- a plan whose shard count differs from `requiredShards`.

It uses no secret and reads no database.

**Attempt rule (fixed now).** Each shard counts its earliest complete attempt. Any later complete attempt must replay it exactly, with the same pair digest and strata, because the run is deterministic. Incomplete or cancelled attempts are recorded in `strength.json` `attempts` with their runner, attempt number and exit code, and are never counted. An attempt whose runner died before uploading leaves no artifact. It is recorded from the workflow run's job list in the assembly's `--context` file, as the Phase 8 host table did.

## Procedure After Merge

```text
# 1. dispatch the locked matrix for the merge commit (from main only)
gh workflow run horse-phase10-strength-league.yml --ref main -f source_sha=<40-hex merge commit on main>

# 2. re-run any job lost to a runner shutdown (its new attempt uploads as -a<N>)
gh run rerun <run id> --failed

# 3. download every attempt and assemble with the real contract
gh run download <run id> --dir <runs>
cd server && npx tsx scripts/phase10-strength-assemble.mjs \
  --runs=<runs> --out=../docs/evidence/phase10/strength-YYYY-MM-DD \
  [--context=<context.json>] [--defective=<defective.json>]
```

The assembler writes `docs/evidence/phase10/strength-YYYY-MM-DD/strength.json`, the formatted attempt receipts with source and committed hashes, and `docs/evidence/phase10/phase10-qualification-YYYY-MM-DD.json`. The qualification file is `horse-phase10-qualification-v1` and carries `qualified`, `sourceSha`, `packVersion`, `contractVersion`, `contractDigest`, `domain` (`plo4-cash-single-board-after-rake-horse-population`), `policyDigest` (sha256 of the PLO4 policy, league and contract source at the runs' head), the objectives, `evidencePath`, `evidenceSha256` and `reasons`.

## P10.2 Gate Statuses

| Gate               | Status                                 | Reason                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain          | verified for named evidence (contract) | The cash domain is six-max PLO4 at the published 1/2 price, 2, 4 and 6 dealt, 40 to 200 BB, the five production styles. Every excluded intersection is named, and the tournament objective is refused by name. The domain is evaluated only when the matrix runs                                                                                          |
| G2 Inputs          | verified for named evidence (tests)    | Published rake, cap ladder and BBJ are read from the engine's own lookup. Held-out seeds are refused outside contract mode. Source, contract digest, pack version and lock fingerprint are bound in every manifest and checked by the assembler                                                                                                           |
| G3 Calculation     | implemented but unverified             | The paired league, power sums, stratified interval and verdict are tested on development and synthetic data (the interval is checked against a direct computation). The matrix itself has not run                                                                                                                                                         |
| G4 Authority       | verified for named evidence (tests)    | The contract is deeply frozen and digest-bound. The qualification file binds source, pack, contract digest, policy digest and evidence hash. A development assembly can never qualify                                                                                                                                                                     |
| G5 Actual use      | not applicable with a reason           | P10.2 is offline evidence. Selection and activation belong to P10.3 through S4                                                                                                                                                                                                                                                                            |
| G6 Outcomes        | implemented but unverified             | Per shard: eligible, changed, changed pairs, decisions, showdowns and fold wins checked, every validity counter, and every attempt with its status. Reconciled when the matrix runs                                                                                                                                                                       |
| G7 Correctness     | verified for named evidence (tests)    | Independent settlement (OmahaReference re-settles every showdown; fold wins are checked against the sole-survivor rule) and deduction (rakeSpec) checks run on every contract hand. A wrong-seat payout and a wrong rake are caught in tests, and the pilot re-settled 5,760 hands with zero mismatches. The assembler's refusals are pinned by its tests |
| G8 Work and replay | verified for named evidence (tests)    | Fixed-work policy clock, governor off at scale 1, fixed seeds and pair indices. A development shard replays identically apart from its wall-clock duration (test). The attempt rule requires replays to match. Shards are sized well inside the job timeout                                                                                               |
| G9 Promotion       | implemented but unverified             | The prespecified per-domain criteria and automatic refusal are locked here. The untouched holdout is reserved. `promotionEligible: false` remains until the assembled matrix says `qualified: true`. Tournament: unavailable dependency                                                                                                                   |
| G10 Publication    | implemented but unverified             | Protected checks and merge of this contract. The workflow runs only against a commit on main. No runtime change, nothing activated or deployed                                                                                                                                                                                                            |

## Verification For This Record

From `server/` in the task worktree:

- `npx vitest run src/benchmark/Plo4StrengthContract.test.ts src/benchmark/Plo4PolicyLeague.test.ts src/benchmark/phase10StrengthAssemble.test.ts`: 34 tests pass.
- `npx tsc --noEmit -p tsconfig.json`: clean.
- Prettier and ESLint run on the changed files.
