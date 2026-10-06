# Horse Brain Phase 8.2 Strength Evidence, 2026-10-01

Horse Brain only. Status vocabulary: verified now, historical only, implemented but unverified, defective, unavailable external input, not applicable with reason.

Status: **NOT PROMOTED (verified now).** The matrix ran with one league run per uncontended GitHub-hosted Linux runner, with hydrated, identified solver stores. The real promotion contract, `summarizeTournamentPromotion` over every retained run, returns `promoted: false`, so the qualification file says `qualified: false` and the Phase 8 candidate stays unselected (shadow) by evidence. Nothing was shrunk, reseeded or dropped. Two runs (pko 8103307 and mtt 8102203) lost their GitHub runners to a shutdown signal before they wrote any result; each was rerun from scratch with the same source, seed and pair count, as recorded in the host table below. No result was ever discarded.

## Machine Record

| File                                                                                                                                                                                                                                           | Contents                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`evidence/phase8/strength-2026-10-02/strength.json`](evidence/phase8/strength-2026-10-02/strength.json)                                                                                                                                       | Contract, source identity, hosts, every run's counts and interval, defective runs, whole-matrix verdict, production context                                                                                                                                                  |
| [`evidence/phase8/phase8-qualification-2026-10-02.json`](evidence/phase8/phase8-qualification-2026-10-02.json)                                                                                                                                 | `horse-phase8-qualification-v1`, `qualified: false`, sha256 of `strength.json` `d9a7f1f7d4b466a115bb94be5ad4b8eed4fc69127f18b34731168d3a960db656`                                                                                                                            |
| [`evidence/phase8/strength-2026-10-02/runs/`](evidence/phase8/strength-2026-10-02/runs/)                                                                                                                                                       | Each run's result and its `manifest.json`, `summary.json` and `baseline-verification.json`, in the repository Prettier shape; the parsed JSON equals the host bytes and `strength.json` records `sourceSha256` of the host bytes and `committedSha256` of the committed file |
| [`evidence/phase8/strength-2026-10-02/hosts.json`](evidence/phase8/strength-2026-10-02/hosts.json), [`context.json`](evidence/phase8/strength-2026-10-02/context.json), [`defective.json`](evidence/phase8/strength-2026-10-02/defective.json) | Assembler inputs: host record and fixed run assignment, production and Mac context, runs that ended without a result                                                                                                                                                         |

## Verified Now: The Contract Run

- Source: `c0b56ffce7c92a4827d73bbedec21b5b60e541c3` (clean checkout on every runner), server source SHA-256 `eb34bf5c1bf3adfd836f64074789a24048203270a28c5a64f7548e12c7b7b026` over 1,691 files, server lock `ca23ba067ed2c588ef30304d6db05485a9bf8d9c8395d1016e863883ccf64952`. Continuation `horse-tournament-postflop-round1-v4`, policy digest `fc359c40d5c8447ff728036f181d20b106eb96dd07d20f98fd99ab8a73b05254`.
- Runner: `server/src/scripts/horseTournamentEvaluate.ts --output=<dir> --objective=<o> --seed=<s> --promotion`, one process, one log and one output directory per run, children at nice 19 under the qualified Linux launcher.
- Matrix: seeds 8101101, 8102203, 8103307; objectives mtt, sng, spin, satellite, pko, mystery; 1,024 paired tournaments requested per run; 18 distinct runs. One run per runner, fixed by the workflow matrix before any result existed.
- Limits unchanged: `PHASE8_POLICY` work budget 4 ms, wall budget 5 ms, policy budget 2 ms. No budget, gate, seed, pair count or objective was changed.
- Domain: NLH single-board tournament postflop only (`nlh-single-board-tournament-postflop`). Every other variant, multi-board and cash domain is refused by the contract and was not attempted.

### Hosts

| Host                                            | Server                                                                                                                                                                                                                                                | CPU                                           | Memory | Runs                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------ | -------------------- |
| mtt-8101101 `gh-runner-mtt-8101101`             | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | AMD EPYC 7763 64-Core Processor               | 16 GB  | 1: mtt-8101101       |
| mtt-8102203 `gh-runner-mtt-8102203`             | GitHub-hosted ubuntu24, 4 runner vCPU, attempt 2: attempt 1 (job 110890435092) lost its runner to a shutdown signal at 2026-10-02T19:03:16Z before writing any result or artifact, and was rerun from scratch on the same source, seed and pair count | AMD EPYC 7763 64-Core Processor               | 16 GB  | 1: mtt-8102203       |
| mtt-8103307 `gh-runner-mtt-8103307`             | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | AMD EPYC 7763 64-Core Processor               | 16 GB  | 1: mtt-8103307       |
| mystery-8101101 `gh-runner-mystery-8101101`     | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | AMD EPYC 7763 64-Core Processor               | 16 GB  | 1: mystery-8101101   |
| mystery-8102203 `gh-runner-mystery-8102203`     | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | INTEL(R) XEON(R) PLATINUM 8573C               | 16 GB  | 1: mystery-8102203   |
| mystery-8103307 `gh-runner-mystery-8103307`     | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | AMD EPYC 9V45 96-Core Processor               | 16 GB  | 1: mystery-8103307   |
| pko-8101101 `gh-runner-pko-8101101`             | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | AMD EPYC 9V45 96-Core Processor               | 16 GB  | 1: pko-8101101       |
| pko-8102203 `gh-runner-pko-8102203`             | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | AMD EPYC 7763 64-Core Processor               | 16 GB  | 1: pko-8102203       |
| pko-8103307 `gh-runner-pko-8103307`             | GitHub-hosted ubuntu24, 4 runner vCPU, attempt 2: attempt 1 (job 110890435029) lost its runner to a shutdown signal at 2026-10-02T17:42:10Z before writing any result or artifact, and was rerun from scratch on the same source, seed and pair count | AMD EPYC 7763 64-Core Processor               | 16 GB  | 1: pko-8103307       |
| satellite-8101101 `gh-runner-satellite-8101101` | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | INTEL(R) XEON(R) PLATINUM 8573C               | 16 GB  | 1: satellite-8101101 |
| satellite-8102203 `gh-runner-satellite-8102203` | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz | 16 GB  | 1: satellite-8102203 |
| satellite-8103307 `gh-runner-satellite-8103307` | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz | 16 GB  | 1: satellite-8103307 |
| sng-8101101 `gh-runner-sng-8101101`             | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | AMD EPYC 7763 64-Core Processor               | 16 GB  | 1: sng-8101101       |
| sng-8102203 `gh-runner-sng-8102203`             | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | AMD EPYC 7763 64-Core Processor               | 16 GB  | 1: sng-8102203       |
| sng-8103307 `gh-runner-sng-8103307`             | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | AMD EPYC 7763 64-Core Processor               | 16 GB  | 1: sng-8103307       |
| spin-8101101 `gh-runner-spin-8101101`           | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | Intel(R) Xeon(R) 6973P-C                      | 16 GB  | 1: spin-8101101      |
| spin-8102203 `gh-runner-spin-8102203`           | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | Intel(R) Xeon(R) 6973P-C                      | 16 GB  | 1: spin-8102203      |
| spin-8103307 `gh-runner-spin-8103307`           | GitHub-hosted ubuntu24, 4 runner vCPU                                                                                                                                                                                                                 | AMD EPYC 9V74 80-Core Processor               | 16 GB  | 1: spin-8103307      |

Every runner: One league run per GitHub-hosted ubuntu-24.04 runner (.github/workflows/horse-phase8-strength-league.yml, workflow run 37022970018), the 18-job matrix fixed by the workflow before any result; Node 22 (the engine image Node), a clean checkout of the evaluated source with npm ci in server/, league children at nice 19 under the qualified Linux launcher. None is the production engine host.

### Per-Run Results

Pairs are completed of requested. Exit is the process exit code (1 also means the software baseline gate, `fired > 0` and `completed > 0` with the p99 inside 5 ms, was not met). Mean difference is candidate minus baseline on the primary metric; the 99% interval is the contract's (the full support [-1, 1] below 1,024 pairs).

| Run               | Host              | Pairs          | Exit | Eligible | Fired  | Completed | Changed | Named refusals                                                                                        | Illegal / conservation / truncated | p99 ms | Mean difference | 99% interval       | Promotable |
| ----------------- | ----------------- | -------------- | ---- | -------- | ------ | --------- | ------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------- | ------ | --------------- | ------------------ | ---------- |
| mtt-8101101       | mtt-8101101       | 1,024 of 1,024 | 0    | 4,563    | 155    | 155       | 11      | `continuation_operation_budget` 4,345, `budget_exhausted` 32, `continuation_sample_calibration` 31    | 0 / 0 / 0                          | 4.89   | +0.00020        | [-0.0013, +0.0017] | no         |
| sng-8101101       | sng-8101101       | 1,024 of 1,024 | 0    | 12,918   | 600    | 600       | 22      | `continuation_operation_budget` 12,154, `continuation_sample_calibration` 120, `budget_exhausted` 44  | 0 / 0 / 0                          | 4.81   | -0.00132        | [-0.0050, +0.0024] | no         |
| spin-8101101      | spin-8101101      | 1,024 of 1,024 | 0    | 20,496   | 19,595 | 19,595    | 51      | `continuation_operation_budget` 798, `continuation_sample_calibration` 102, `budget_exhausted` 1      | 0 / 0 / 0                          | 4.11   | +0.00586        | [-0.0060, +0.0177] | no         |
| satellite-8101101 | satellite-8101101 | 1,024 of 1,024 | 0    | 4,560    | 366    | 366       | 8       | `continuation_operation_budget` 4,158, `continuation_sample_calibration` 35, `budget_exhausted` 1     | 0 / 0 / 0                          | 4.68   | +0.00000        | [+0.0000, +0.0000] | no         |
| pko-8101101       | pko-8101101       | 1,024 of 1,024 | 1    | 4,841    | 888    | 885       | 14      | `continuation_operation_budget` 3,807, `budget_exhausted` 107, `continuation_sample_calibration` 42   | 0 / 0 / 0                          | 5.21   | -0.00023        | [-0.0022, +0.0017] | no         |
| mystery-8101101   | mystery-8101101   | 1,024 of 1,024 | 0    | 4,825    | 183    | 183       | 11      | `continuation_operation_budget` 4,560, `continuation_sample_calibration` 42, `budget_exhausted` 40    | 0 / 0 / 0                          | 4.95   | -0.00039        | [-0.0020, +0.0013] | no         |
| mtt-8102203       | mtt-8102203       | 1,024 of 1,024 | 1    | 4,480    | 142    | 142       | 5       | `continuation_operation_budget` 4,215, `budget_exhausted` 70, `continuation_sample_calibration` 53    | 0 / 0 / 0                          | 5.15   | +0.00000        | [+0.0000, +0.0000] | no         |
| sng-8102203       | sng-8102203       | 1,024 of 1,024 | 1    | 13,331   | 576    | 575       | 12      | `continuation_operation_budget` 12,435, `budget_exhausted` 205, `continuation_sample_calibration` 116 | 0 / 0 / 0                          | 5.11   | +0.00073        | [-0.0030, +0.0044] | no         |
| spin-8102203      | spin-8102203      | 1,024 of 1,024 | 0    | 20,564   | 15,003 | 14,999    | 41      | `continuation_operation_budget` 5,420, `continuation_sample_calibration` 105, `budget_exhausted` 40   | 0 / 0 / 0                          | 4.44   | +0.00391        | [-0.0056, +0.0134] | no         |
| satellite-8102203 | satellite-8102203 | 1,024 of 1,024 | 1    | 4,454    | 151    | 150       | 7       | `continuation_operation_budget` 4,195, `budget_exhausted` 55, `continuation_sample_calibration` 54    | 0 / 0 / 0                          | 5.05   | +0.00098        | [-0.0016, +0.0035] | no         |
| pko-8102203       | pko-8102203       | 1,024 of 1,024 | 0    | 4,651    | 166    | 165       | 7       | `continuation_operation_budget` 4,411, `continuation_sample_calibration` 57, `budget_exhausted` 18    | 0 / 0 / 0                          | 4.86   | +0.00008        | [-0.0005, +0.0007] | no         |
| mystery-8102203   | mystery-8102203   | 1,024 of 1,024 | 1    | 4,654    | 211    | 210       | 9       | `continuation_operation_budget` 4,247, `budget_exhausted` 140, `continuation_sample_calibration` 57   | 0 / 0 / 0                          | 5.31   | +0.00025        | [-0.0006, +0.0011] | no         |
| mtt-8103307       | mtt-8103307       | 1,024 of 1,024 | 1    | 4,440    | 109    | 107       | 13      | `continuation_operation_budget` 4,227, `budget_exhausted` 66, `continuation_sample_calibration` 40    | 0 / 0 / 0                          | 5.13   | +0.00020        | [-0.0010, +0.0014] | no         |
| sng-8103307       | sng-8103307       | 1,024 of 1,024 | 0    | 13,161   | 616    | 615       | 19      | `continuation_operation_budget` 12,381, `continuation_sample_calibration` 141, `budget_exhausted` 24  | 0 / 0 / 0                          | 4.68   | +0.00107        | [-0.0015, +0.0036] | no         |
| spin-8103307      | spin-8103307      | 1,024 of 1,024 | 0    | 21,103   | 9,534  | 9,519     | 32      | `continuation_operation_budget` 11,402, `continuation_sample_calibration` 124, `budget_exhausted` 58  | 0 / 0 / 0                          | 4.67   | +0.00586        | [-0.0021, +0.0138] | no         |
| satellite-8103307 | satellite-8103307 | 1,024 of 1,024 | 1    | 4,475    | 121    | 120       | 11      | `continuation_operation_budget` 4,196, `budget_exhausted` 124, `continuation_sample_calibration` 35   | 0 / 0 / 0                          | 5.28   | +0.00000        | [+0.0000, +0.0000] | no         |
| pko-8103307       | pko-8103307       | 1,024 of 1,024 | 1    | 4,671    | 125    | 125       | 12      | `continuation_operation_budget` 4,400, `budget_exhausted` 103, `continuation_sample_calibration` 43   | 0 / 0 / 0                          | 5.26   | -0.00039        | [-0.0013, +0.0005] | no         |
| mystery-8103307   | mystery-8103307   | 1,024 of 1,024 | 0    | 4,685    | 1,645  | 1,645     | 21      | `continuation_operation_budget` 2,991, `continuation_sample_calibration` 43, `budget_exhausted` 6     | 0 / 0 / 0                          | 4.44   | -0.00014        | [-0.0014, +0.0011] | no         |

## Verified Now: Whole-Matrix Verdict

`summarizeTournamentPromotion` over the 18 retained results (imported from `server/src/benchmark/HorseTournamentLeague.ts`, not reimplemented) returns `promoted: false`. 0 of 18 retained runs pass `tournamentRunCanPromote`; 10 pass the software baseline gate.

Reasons, exactly as the contract returns them:

- `mtt:8101101:not_promotable`
- `mtt:8102203:not_promotable`
- `mtt:8103307:not_promotable`
- `sng:8101101:not_promotable`
- `sng:8102203:not_promotable`
- `sng:8103307:not_promotable`
- `spin:8101101:not_promotable`
- `spin:8102203:not_promotable`
- `spin:8103307:not_promotable`
- `satellite:8101101:not_promotable`
- `satellite:8102203:not_promotable`
- `satellite:8103307:not_promotable`
- `pko:8101101:not_promotable`
- `pko:8102203:not_promotable`
- `pko:8103307:not_promotable`
- `mystery:8101101:not_promotable`
- `mystery:8102203:not_promotable`
- `mystery:8103307:not_promotable`

| Objective | Pooled pairs | Mean difference | 99% interval       | Verdict      |
| --------- | ------------ | --------------- | ------------------ | ------------ |
| mtt       | 3,072        | +0.00013        | [-0.0005, +0.0008] | not promoted |
| sng       | 3,072        | +0.00016        | [-0.0018, +0.0021] | not promoted |
| spin      | 3,072        | +0.00521        | [-0.0005, +0.0109] | not promoted |
| satellite | 3,072        | +0.00033        | [-0.0005, +0.0012] | not promoted |
| pko       | 3,072        | -0.00018        | [-0.0009, +0.0006] | not promoted |
| mystery   | 3,072        | -0.00009        | [-0.0008, +0.0007] | not promoted |

No strength, promotion or solver-quality claim is made beyond this verdict. The league reference is Phase 7 action utility, not an external solver.

## Exact Commands

Per run, one job per runner in `.github/workflows/horse-phase8-strength-league.yml` (one process, one log, one new output directory):

```text
gh workflow run horse-phase8-strength-league.yml -f source_sha=<sha>
# each of the 18 jobs: cd server && npm ci && npx tsx src/scripts/horseTournamentEvaluate.ts --output=$RUNNER_TEMP/p82/<objective>-<seed> --objective=<objective> --seed=<seed> --promotion
```

Assembly, from `server/` after `gh run download <run id>` of the 18 run artifacts:

```text
npx tsx scripts/phase8-strength-assemble.mjs \
  --runs=<directory with the 18 <objective>-<seed> directories> \
  --hosts=../docs/evidence/phase8/strength-2026-10-02/hosts.json \
  --context=../docs/evidence/phase8/strength-2026-10-02/context.json \
  --superseded=../docs/evidence/phase8/strength-2026-10-02/superseded.json \
  --out=../docs/evidence/phase8/strength-2026-10-02
```

## P8.2 Gate Statuses

| Gate               | Status                     | Reason                                                                                                                                                                                                                                        |
| ------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain          | verified now               | NLH single-board tournament postflop only; the six declared objectives are the full in-domain set and every other domain is refused by the contract.                                                                                          |
| G2 Inputs          | verified now               | Every run hydrated the approved solver stores (240 charts, 7,747 postflop cells) read once with the repository's Supabase service secret (no database write); source, seeds and pairs are identical across runs and checked by the assembler. |
| G3 Calculation     | verified now               | All 18 runs completed 1,024 of 1,024 pairs on the evaluated source; the verdict is the real contract's, not a reimplementation.                                                                                                               |
| G4 Authority       | verified now               | The qualification file binds source, continuation version, pack, domain, policy digest and the sha256 of `strength.json` in the fields the P8.3 authority admits, and says `qualified: false`.                                                |
| G5 Actual use      | not applicable with reason | P8.2 produces offline evidence only; with `qualified: false` there is nothing to select.                                                                                                                                                      |
| G6 Outcomes        | verified now               | Eligible, fired, completed, changed and every named refusal are recorded per run.                                                                                                                                                             |
| G7 Correctness     | verified now               | No illegal action, conservation error or truncated hand in any run; the assembler's refusals are pinned by its tests.                                                                                                                         |
| G8 Work and replay | verified now               | Budgets unchanged, p99 recorded per run, fixed seeds and pairs, host assignment fixed before any result, results retained with both hashes.                                                                                                   |
| G9 Promotion       | verified now               | `promoted: false`; the candidate is not qualified and stays unselected.                                                                                                                                                                       |
| G10 Publication    | not applicable with reason | Evidence only; no runtime change, nothing activated or deployed.                                                                                                                                                                              |

## Historical Only: The 216a383f Hetzner Matrix

The first full rerun after the bounty fix ran on source `216a383f389429ca070ff94d19ce5c32a48de4ba` on two Hetzner hosts from 2026-10-02T07:10Z, with several league runs sharing each host's cores (seven on a shared 8-vCPU cpx41, four on a dedicated 4-vCPU ccx23). Its 11 completed runs (1,024 pairs each, no illegal action, conservation error or truncated hand) were all not promotable, but the comparison measured core contention as much as the candidate: a league run is two busy processes, and with the cores shared the continuation rarely completed inside its 4 ms work budget. The P8.1 x86 investigation that followed found redundant bookkeeping in the continuation and removed it exactly ([#5825](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/5825)), and production tournament context was completed for hands dealt one level behind ([#5827](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/5827)). The remaining 7 runs were stopped and the matrix above was run on the source containing both, one run per uncontended runner. The 216a383f results are kept in the agent evidence archive and are not part of the verdict.

## Historical Only: The Superseded 88217ac6 Matrix

The first Linux matrix ran on source `88217ac61335385b6127dbb04b8bcac3bea4a380` on the same two hosts from 2026-10-01T22:21Z until it was stopped at 2026-10-02T05:20Z. Its league harness paid a full bounty to every winner of a split knockout pot (`attributeKnockout` gives each splitter weight 1), so one knockout was paid more than once: mystery runs ended early at the champion residual conservation check (seed 8102203 pair 36 paid 19,000 from an 18,000 pool, on both sides) and PKO returns were overstated on both sides. Fixed in [#5786](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/5786). Its 16 league results are kept byte for byte with the defect, the per-run numbers and the runs that produced no result in [`evidence/phase8/strength-2026-10-01-88217ac6-superseded/`](evidence/phase8/strength-2026-10-01-88217ac6-superseded/README.md). They are not part of the verdict above.

Two measured facts from that matrix still stand as historical observations: across its 10 complete runs every 99% lower bound was at or below 0 (fired 49 to 963 of 4,443 to 20,580 eligible, p99 4.75 to 6.36 ms, no illegal action, truncation or conservation error), and three runs on host C failed solver-store hydration with `supabase_timeout` when four processes hydrated at once; the staggered starts used for the current matrix hydrated cleanly.

## Historical Only: The First Attempt On The Mac

On 2026-10-01 all 18 runs were launched on the development Mac from source `4948e0ffd527adee5d898426f7abd84be0be09ab` and all 18 were refused before the first paired tournament: the solver-store credential was rejected (`Unregistered API key`) and the league launcher refuses every platform other than Linux. Both blockers were cleared for the matrix above (a dedicated `sb_secret_` key in the canonical agent credential file, and two Linux hosts). The 18 refusal receipts stay in [`evidence/phase8/strength-2026-10-01/`](evidence/phase8/strength-2026-10-01/runs/) with [`strength-2026-10-01.json`](evidence/phase8/strength-2026-10-01.json).
