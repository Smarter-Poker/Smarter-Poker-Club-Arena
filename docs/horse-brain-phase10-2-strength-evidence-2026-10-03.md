# Horse Brain Phase 10.2 PLO4 Strength Evidence, 2026-10-03

Horse Brain only. Status vocabulary: verified now, implemented but unverified, defective, unavailable external input, not applicable with reason, historical only.

Status: **NOT QUALIFIED (verified now).** The locked matrix of `PLO4_STRENGTH_CONTRACT` (`plo4-strength-contract-v1`) ran in full: 111 of 111 shards, each complete on its first attempt, on a clean checkout of one commit on main. The real verdict, `summarizePlo4Strength` over every counted shard, returns `qualified: false` with three named cash reasons. The qualification file says `qualified: false`. `PHASE10_PROTECTED_RELEASE_SELECTION` stays `null`, `promotionEligible` stays `false`, and the pack `plo4-policy-round1-v3` stays in shadow. Nothing was reseeded, shrunk, dropped or rerun. No threshold was changed or reinterpreted.

## Machine Record

| File                                                                                                               | Contents                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`evidence/phase10/strength-2026-10-03/strength.json`](evidence/phase10/strength-2026-10-03/strength.json)         | `horse-phase10-strength-v1`: the contract and its digest, source identity and policy digest, every counted shard with its runner, counts, validity counters, reasons and pair digest, every attempt, the whole-matrix verdict, and the run context                             |
| [`evidence/phase10/phase10-qualification-2026-10-03.json`](evidence/phase10/phase10-qualification-2026-10-03.json) | `horse-phase10-qualification-v1`, `qualified: false`, `evidenceSha256` of `strength.json` `404bc0b71e16ea6ac1ac6fd1f4d1a3fb29cc833c233e44ed285c119bdd5ef263`. File sha256 `8dff71b574879240532eb1f6ec1c260f8d20b26ced965e326451933d8ec426fd`                                   |
| [`evidence/phase10/strength-2026-10-03/runs/`](evidence/phase10/strength-2026-10-03/runs/)                         | For each of the 111 attempts: `runner.json`, `attempt.json`, `manifest.json` and the shard result, in the repository Prettier shape. The parsed JSON equals the host bytes; `strength.json` `files` records `sourceSha256` of the host bytes and `committedSha256` (444 files) |
| [`evidence/phase10/strength-2026-10-03/context.json`](evidence/phase10/strength-2026-10-03/context.json)           | Assembler input: the workflow run's identity and its full job list (112 jobs, every one attempt 1, every one `success`), read from the GitHub jobs API after the run completed. No attempt lost its runner, so `attemptsWithoutArtifact` is empty                              |

Not committed, archived byte for byte at `/Volumes/SmarterArchives/agent-evidence/horse-brain-phase10-strength-20261003/`: the 111 downloaded artifact directories exactly as `gh run download` wrote them, including each shard's process log (which the assembler does not copy), with `runs.sha256` over all 555 files, the raw job list, and the download and assembly logs.

## Verified Now: The Contract Run

- Workflow run [37131597196](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37131597196), `.github/workflows/horse-phase10-strength-league.yml`, `workflow_dispatch` from main at 2026-10-03T14:59:05Z, run attempt 1, conclusion `success`. Plan job 14:59:08Z to 14:59:44Z; the 111 league jobs ran from 15:00:03Z to 16:10:39Z (about 71 minutes of wall time).
- Source: `ac4ecfb1231ab96fd34849d1e02b9929e9ccf492` (main after #5977, P10.3), clean on every runner (`dirty: false`, `sourceUnchanged: true` on every shard). Server source SHA-256 `673e6493c193a9a62badb825f10a03a211571c12f7937e0166f3ba8daa91513f` over 1,723 files; server lock `ca23ba067ed2c588ef30304d6db05485a9bf8d9c8395d1016e863883ccf64952`. Identical on all 111 manifests.
- Contract: `plo4-strength-contract-v1`, digest `ebdbdbb48336c0425df735fa073a4a28ef4884c199a69006e27909a6bc2b6384` (merged in #5969, record corrected in #5978). Every manifest and result carries it, and it equals the digest of the contract in the assembling checkout.
- Pack `plo4-policy-round1-v3`. Policy digest `a3d924450b7f8f05d1dd79242170c5c2d1c38443412e11ab2bcf114dda25c221`: sha256 at `ac4ecfb1` of `Plo4PolicyPack.ts`, `Plo4LivePolicy.ts`, `Plo4PolicyLeague.ts` and `Plo4StrengthContract.ts`, computed from git at the runs' head (`policyDigestAt`). It identifies the run; it does not bind running code. It omits `HorseLogic.ts`, `HorsePolicyRegistry.ts` and the other files on the candidate path, and nothing in the engine compares it with its own code (defective on `ac4ecfb1`, fix in flight on branch `agent/codex-horse-brain/phase10-authority-binding-20261003`; see G4).
- Mode: contract mode on every shard. Held-out seeds 10201109, 10202231, 10203347.
- Matrix: the contract's five profiles × three held-out seeds × 2, 8, 4, 8 and 15 shards; 23,040 pairs per shard; 2,557,440 pairs in all. Every shard completed 23,040 of 23,040 pairs.
- Attempts: 111 artifacts, all `-a1`, all complete, every exit code 0. No incomplete, cancelled or lost attempt, so no replay comparison arose and nothing is declared defective (`matrixComplete: true`, `defectiveShards: []`).
- Runners: one shard per GitHub-hosted runner, image `ubuntu24` `20260927.320.1`, 4 vCPU, kernel `6.17.0-1022-azure`, Node `v22.23.3`. CPUs: AMD EPYC 7763 (55 shards), AMD EPYC 9V74 (21), AMD EPYC 9V45 (18), Intel Xeon Platinum 8370C (7), Intel Xeon Platinum 8573C (6), Intel Xeon 6973P-C (4). Shard durations 2.5 to 15.6 minutes, inside the 120-minute job timeout. None is the production engine host.
- Assembly: from `server/` in a worktree of main at `d2b09ef47dfd5cfa2842544051474f3ba8c1de67`. The contract, assembler, league and PLO4 policy sources are unchanged between `ac4ecfb1` and that commit. The assembler exited 0 with no refusal.

## Verified Now: Software Validity

Per-shard zero tolerance, summed over all 111 shards. Every count is zero and no shard has any reason from `plo4StrengthShardReasons` (no identity, scope, completeness, coverage, strata, validity, `fixed_work_not_proven` or `shard_claims_promotion` reason).

| Counter                  | Total |
| ------------------------ | ----- |
| Illegal actions          | 0     |
| Conservation errors      | 0     |
| Card errors              | 0     |
| Truncated hands          | 0     |
| Settlement mismatches    | 0     |
| Deduction mismatches     | 0     |
| Paired replay mismatches | 0     |

Independent checks: 1,071,524 showdowns re-settled by `settleOmahaReference` and 4,043,356 fold wins checked against the sole-survivor rule, with the rake and BBJ deduction checked on every hand.

| Profile                  | Shards | Pairs     | Changed pairs | Eligible  | Changed | Decisions  | Showdowns checked | Fold wins checked |
| ------------------------ | ------ | --------- | ------------- | --------- | ------- | ---------- | ----------------- | ----------------- |
| `p10c-6max-2dealt-100bb` | 6      | 138,240   | 54,464        | 119,452   | 57,179  | 602,758    | 13,809            | 262,671           |
| `p10c-6max-4dealt-100bb` | 24     | 552,960   | 186,466       | 555,574   | 193,384 | 7,027,613  | 179,935           | 925,985           |
| `p10c-6max-40bb`         | 12     | 276,480   | 69,921        | 286,321   | 73,208  | 5,063,649  | 134,739           | 418,221           |
| `p10c-6max-100bb`        | 24     | 552,960   | 154,636       | 574,651   | 160,536 | 10,670,044 | 252,893           | 853,027           |
| `p10c-6max-200bb`        | 45     | 1,036,800 | 309,663       | 1,083,148 | 320,211 | 20,704,714 | 490,148           | 1,583,452         |
| **Total**                | 111    | 2,557,440 | 775,150       | 2,619,146 | 804,518 | 44,068,778 | 1,071,524         | 4,043,356         |

## Verified Now: Cash After Rake

All figures are candidate minus reference, hero net chips after the engine's rake and BBJ drop, in bb/100, from `summarizePlo4Strength`. Intervals are the contract's two-sided 99% (z = 2.5758293035489004).

### Primary

| Cell    | Pairs     | Estimate   | Standard error | 99% interval       | Threshold       | Result    |
| ------- | --------- | ---------- | -------------- | ------------------ | --------------- | --------- |
| primary | 2,557,440 | **−0.162** | 0.861          | **[−2.38, +2.06]** | lower bound > 0 | **fails** |

### Seed Blocks

| Seed     | Pairs   | Estimate | Standard error | 99% interval   | Threshold          | Result    |
| -------- | ------- | -------- | -------------- | -------------- | ------------------ | --------- |
| 10201109 | 852,480 | −2.383   | 1.494          | [−6.23, +1.47] | point estimate > 0 | **fails** |
| 10202231 | 852,480 | +0.754   | 1.483          | [−3.07, +4.57] | point estimate > 0 | passes    |
| 10203347 | 852,480 | +1.143   | 1.498          | [−2.71, +5.00] | point estimate > 0 | passes    |

### Nonregression Cells

Threshold: every cell's 99% lower bound ≥ −10 bb/100. 17 of 18 cells pass; one fails. The four street cells cannot fail in practice: each is a street's contribution diluted over all pairs, and their intervals lie within about ±2.3 bb/100 against the −10 floor. Only the 14 profile, position and depth cells are effective critical cells, a contract v2 design item (see the [contract record](horse-brain-phase10-2-strength-contract-2026-10-03.md#thresholds-and-their-justification)).

| Family   | Cell                          | Profiles | Pairs     | Estimate | 99% interval     | Lower bound | Result    |
| -------- | ----------------------------- | -------- | --------- | -------- | ---------------- | ----------- | --------- |
| Profile  | `p10c-6max-2dealt-100bb`      | 1        | 138,240   | −25.589  | [−31.02, −20.15] | **−31.02**  | **fails** |
| Profile  | `p10c-6max-4dealt-100bb`      | 1        | 552,960   | −0.025   | [−4.56, +4.51]   | −4.56       | passes    |
| Profile  | `p10c-6max-40bb`              | 1        | 276,480   | +5.509   | [+1.25, +9.77]   | +1.25       | passes    |
| Profile  | `p10c-6max-100bb`             | 1        | 552,960   | +8.097   | [+3.01, +13.18]  | +3.01       | passes    |
| Profile  | `p10c-6max-200bb`             | 1        | 1,036,800 | +11.198  | [+5.83, +16.57]  | +5.83       | passes    |
| Position | button                        | 5        | 518,400   | +2.351   | [−2.85, +7.55]   | −2.85       | passes    |
| Position | small blind                   | 4        | 449,280   | +1.666   | [−3.82, +7.16]   | −3.82       | passes    |
| Position | big blind                     | 5        | 518,400   | −3.396   | [−8.74, +1.95]   | −8.74       | passes    |
| Position | cutoff                        | 4        | 449,280   | +11.954  | [+6.35, +17.56]  | +6.35       | passes    |
| Position | middle                        | 3        | 311,040   | +8.570   | [+2.37, +14.77]  | +2.37       | passes    |
| Position | early                         | 3        | 311,040   | +7.524   | [+1.29, +13.75]  | +1.29       | passes    |
| Depth    | short (40)                    | 1        | 276,480   | +5.509   | [+1.25, +9.77]   | +1.25       | passes    |
| Depth    | standard (100: 2, 4, 6 dealt) | 3        | 1,244,160 | −5.839   | [−8.74, −2.93]   | −8.74       | passes    |
| Depth    | deep (200)                    | 1        | 1,036,800 | +11.198  | [+5.83, +16.57]  | +5.83       | passes    |
| Street   | preflop divergence            | 5        | 2,557,440 | +0.128   | [−2.06, +2.31]   | −2.06       | passes    |
| Street   | flop divergence               | 5        | 2,557,440 | −0.120   | [−0.46, +0.22]   | −0.46       | passes    |
| Street   | turn divergence               | 5        | 2,557,440 | −0.127   | [−0.253, −0.001] | −0.25       | passes    |
| Street   | river divergence              | 5        | 2,557,440 | −0.043   | [−0.13, +0.04]   | −0.13       | passes    |

The street contributions (+0.128, −0.120, −0.127, −0.043) and the no-divergence contribution (exactly 0) sum to the primary estimate, −0.162. The big-blind and standard-depth lower bounds (−8.7408 and −8.7449) differ beyond the second decimal.

### Interval Trust

Every one of the 22 cells above (primary, three seed blocks, 18 nonregression cells) is `intervalTrusted: true`. No cell is refused as `interval_not_trusted`.

| Check                                                                                                 | Limit                 | Observed across all cells                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Edgeworth coverage error, `\|κ\|(2z²+1)φ(z)/6`                                                        | ≤ 0.001               | 5.2 × 10⁻⁶ (standard depth) to 5.2 × 10⁻⁴ (river divergence); primary 1.17 × 10⁻⁵                                                                                                                                                                                                                            |
| Estimator skewness κ                                                                                  | (via the error above) | −3.1 × 10⁻³ to +1.5 × 10⁻² (river divergence); primary −3.4 × 10⁻⁴                                                                                                                                                                                                                                           |
| Pairs per profile in each cell                                                                        | ≥ 10,000              | minimum 46,080 (any seed block or position cell); 138,240 in the primary and street cells                                                                                                                                                                                                                    |
| Realised kurtosis K = m4 / m2² per group (not a contract gate; the 10,000-pair floor assumes K ≤ 100) | —                     | per profile 26.8 (40 BB) to 102.1 (2-dealt); up to 114.7 inside the primary, seed, profile, position and depth cells (variance relative standard error at most 4.7% at the realised n); 7,889, 17,480 and 63,537 in the flop, turn and river street-contribution groups (relative standard error 24% to 68%) |

The kurtosis row comes from [`phase10-2-kurtosis.py`](evidence/phase10/phase10-2-kurtosis.py), added 2026-10-03. `strength.json` holds no power sums, so the script reads S1 to S4 from the 111 committed shard results, checks each against its `committedSha256`, and reproduces every cell's mean, standard error and skewness above (largest relative difference 3.5 × 10⁻¹⁵). The verdict never reads S4, so this assumption is not checked by the contract. The 2-dealt profile's K of 102.1 is above the assumed 100; at its 138,240 pairs the variance estimate's relative standard error is 2.7%, so nothing changes. The skewness-based coverage bound holds in every cell, and the second-order Edgeworth terms the guard omits add at most 1.7 × 10⁻⁴ (river street cell). The street cells' heavy tails make their standard errors imprecise, but those cells are the near-vacuous ones.

## Verified Now: Tournament Objective

Refused by name, as the contract fixes it: `status: "unavailable dependency"`, `qualified: false`, in `tournament.reasons` and in the qualification file's `objectives.tournament.reasons`, and not in the top-level `reasons`:

- `tournament:plo4_whole_tournament_outcome_model_unavailable`
- `tournament:qualified_plo4_tournament_reference_population_unavailable`
- `tournament:plo4_tournament_thresholds_not_specified`

## Verified Now: Verdict

`summarizePlo4Strength` over the 111 counted shards (imported from `server/src/benchmark/Plo4StrengthContract.ts`, not reimplemented) returns `qualified: false`, `shardsUsed: 111`, `promotionEligible: false`. The qualification file's `objectives.cash` is `{ qualified: false, status: "measured" }`.

Reasons, exactly as the contract returns them:

- `cash:primary:lower_bound_not_above_zero`: the pooled 99% lower bound is −2.38 bb/100, not above 0.
- `cash:seed:10201109:point_estimate_not_above_zero`: that seed block's estimate is −2.383 bb/100.
- `cash:profile:p10c-6max-2dealt-100bb:regression_margin_exceeded`: that profile's 99% lower bound is −31.02 bb/100, below −10 (its whole interval lies below −20).

No shard, matrix or interval-trust reason was returned. No strength claim is made beyond this verdict. The reference is the Horse policy with the pack off, not a solver. It is the same path as live shadow (300 paired deals, off versus shadow: 0 trace and 0 net differences), and the candidate arm runs the same `HorseLogic` candidate path P10.3 would select. Both arms play under harness conditions, not live ones: mood off, empty style modifiers, a fresh HorseMind sandbox per hand, a fixed policy clock (so the 4 ms fallback never fires), no deep second look, and every opponent seat off, whereas activation would switch all cash horses together. The opponents are therefore `HorseLogic.decide` seats with the pack off, not the live Horse population's state. These limits do not affect `qualified: false`; they limit what a future `qualified: true` would mean and are for a contract v2 before any promotion. See the [contract record's Harness Versus Live](horse-brain-phase10-2-strength-contract-2026-10-03.md#harness-versus-live-disclosed-2026-10-03).

## Selection Unchanged

`PHASE10_PROTECTED_RELEASE_SELECTION` stays `null` and nothing in `server/src/engine` is touched. A `qualified: false` file is refused by `admitHorsePhase10QualifiedAuthority` as `not_qualified` in any case, so every live PLO4 decision stays in shadow on the reference action.

## Exact Commands

```text
gh workflow run horse-phase10-strength-league.yml --ref main -f source_sha=ac4ecfb1231ab96fd34849d1e02b9929e9ccf492
# run 37131597196: plan job + 111 league jobs, all success on attempt 1

gh run download 37131597196 --dir <scratch>/runs
# 111 directories p102-<profile>-<seed>-s<shard>-a1, every one with a complete result

cd server && npx tsx scripts/phase10-strength-assemble.mjs \
  --runs=<scratch>/runs \
  --out=../docs/evidence/phase10/strength-2026-10-03 \
  --context=../docs/evidence/phase10/strength-2026-10-03/context.json
# exit 0: qualified false, the three reasons above, evidenceSha256 404bc0b7...
```

## P10.2 Gate Statuses

| Gate               | Status                                                                                                                   | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1 Domain          | verified now                                                                                                             | The measured domain is the contract's: six-max PLO4 cash at the published 1/2 price, 2, 4 and 6 dealt, 40 to 200 BB, the five production styles, Horse population. Every excluded intersection stays named; the tournament objective is refused by name                                                                                                                                                                                                                                                |
| G2 Inputs          | verified now                                                                                                             | All 111 manifests bind the same head, source hash (1,723 files), server lock, contract digest and pack version, in contract mode on held-out seeds from a clean checkout; the assembler checked each against the others and the running contract and refused nothing                                                                                                                                                                                                                                   |
| G3 Calculation     | verified now                                                                                                             | 111 of 111 shards completed 23,040 of 23,040 pairs; the power sums were merged exactly and the verdict is the real `summarizePlo4Strength`; the street contributions sum to the primary estimate                                                                                                                                                                                                                                                                                                       |
| G4 Authority       | verified now for the run identity (git-computed at the run head); runtime binding defective on `ac4ecfb1`, fix in flight | `horse-phase10-qualification-v1` carries source, pack, contract version and digest, domain, policy digest and the sha256 of `strength.json`, and says `qualified: false`. The policy digest is computed from git at `ac4ecfb1` over four files and omits `HorseLogic.ts`, `HorsePolicyRegistry.ts` and the rest of the candidate path; the running engine never compares it, or the source SHA, with its own code. Fix in flight (branch `agent/codex-horse-brain/phase10-authority-binding-20261003`) |
| G5 Actual use      | not applicable with reason                                                                                               | P10.2 is offline evidence; with `qualified: false` there is nothing to select, and the selection stays `null`                                                                                                                                                                                                                                                                                                                                                                                          |
| G6 Outcomes        | verified now                                                                                                             | Per shard: pairs, changed pairs, eligible, changed, decisions, showdowns and fold wins checked, every validity counter and every attempt. 112 jobs, all `success` on attempt 1; 111 complete attempts, none incomplete or lost                                                                                                                                                                                                                                                                         |
| G7 Correctness     | verified now                                                                                                             | Every validity counter is 0 on every shard; 1,071,524 showdowns and 4,043,356 fold wins were independently re-settled with zero settlement or deduction mismatches, and zero paired replay mismatches                                                                                                                                                                                                                                                                                                  |
| G8 Work and replay | verified now                                                                                                             | Fixed seeds and contiguous pair slices, exact balanced position coverage and fixed work proven on every shard (no coverage or `fixed_work_not_proven` reason); runs retained with both hashes. Each shard had a single attempt, so the attempt rule's replay comparison was not exercised                                                                                                                                                                                                              |
| G9 Promotion       | verified now                                                                                                             | `qualified: false` with three named cash reasons; `promotionEligible: false`; the candidate stays in shadow. A future `qualified: true` under this contract would still carry the harness limits and only 14 effective critical cells, for a contract v2 before any promotion. Tournament: unavailable external input, refused by name                                                                                                                                                                 |
| G10 Publication    | not applicable with reason                                                                                               | Evidence only; no runtime change, nothing selected, activated or deployed                                                                                                                                                                                                                                                                                                                                                                                                                              |
