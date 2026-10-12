# Horse Brain Phase 8 Round 2, October 8, 2026

Horse Brain only. Status vocabulary: verified now, historical only, implemented but unverified, defective, unavailable external input, not applicable with reason. Counts, not percentages, except where a share is quoted from its source.

The owner's target for every strategy upgrade is that it beats the brain horses use today and wins after rake against the opponents horses actually face for money. Every measured claim below names its opponent population, prize model, sample size and 99% interval. A tournament's fee is taken at entry, not per hand, so the league's funded-pool return carries no per-hand rake term.

## Outcome

| Item                                                                 | Status                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safety latch switching Phase 8 off for most of each engine process   | verified now: fixed at the root ([#6506](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6506), merged `e687427d`, serving in `44c44900`); 0 `disabled_eligible_but_silent` in the declared production window, was 8,645 of 13,034                                 |
| Exact speed-up of `PokerEngine.calculatePots`                        | verified now: exact (oracle over 60,000 tables; identical Phase 8 digests on 182 and 823 decisions)                                                                                                                                                                               |
| Scoped refusal of tables whose next hand deals more than three seats | verified now in production: 1,571 full-table MTT decisions refused by name in the window, the latch never tripped                                                                                                                                                                 |
| Does the continuation's utility choose actions?                      | verified now: no; the one fix tried (a paired change test) trended negative on development seeds and was not shipped                                                                                                                                                              |
| 18-run strength matrix on the final source `e687427d`                | verified now: not promoted. 17 of 18 runs completed all 1,024 pairs; `sng-8102203` reached the hosted job time limit with no result (defective, kept). Spin pooled +0.00684, 99% interval [+0.0013, +0.0124]; every other objective 0.0000 because the candidate never acts there |
| Human-population (winning contract) check for tournaments            | unavailable external input: the merged winning contract ([#6515](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6515)) declares condition (b) unavailable for every tournament pack                                                                               |
| Qualification and selection                                          | `qualified: false` (`phase8-qualification-2026-10-08.json`); `PHASE8_PROTECTED_RELEASE_SELECTION` stays `null`; every Phase 8 decision stays in shadow                                                                                                                            |

## 1. The Latch

### Root Cause, Read From Production Rows

Source: read-only copies of the production Horse decision journal on 2026-10-08, window 1 [09:00Z, 10:00Z) and window 2 [13:00Z, 13:30Z), engine `4fadb520`. Population: every NLH tournament postflop decision whose Phase 8 ledger says eligible (6,579). Seats are the seats the continuation's next hand is dealt to.

| Seats | Eligible | Completed | Stopped at the 4 ms work budget | Formats                       |
| ----- | -------: | --------: | ------------------------------: | ----------------------------- |
| 2     |    2,920 |     2,753 |                             148 | HU Sit and Go 2,743, Spin 177 |
| 3     |      890 |       801 |                              87 | Spin                          |
| 5     |        3 |         0 |                               3 | MTT                           |
| 6     |       14 |         0 |                              14 | MTT                           |
| 7     |      294 |        15 |                             271 | MTT                           |
| 8     |    1,648 |        81 |                           1,524 | MTT                           |
| 9     |      810 |        12 |                             769 | MTT                           |

At five or more seats the median refused decision had completed 2 or 3 of 8 candidates (`work.candidatesCompleted`), about a third of its work, at latency 4.01 ms. `HorsePhase8Safety` latches Phase 8 off for the rest of a process after 32 eligible decisions in a row without a fire, so a run of full-table MTT spots on a worker switched it off: in window 2, 8,645 of 13,034 Phase 8 domain decisions were tallied `disabled_eligible_but_silent`, heads-up and Spin spots included. The P8.2 matrix's own diagnostics on idle GitHub runners agree: completed 145 of 201 at 2 seats, 305 of 591 at 3, 28 of 153 at 4, 84 of 910 at 5, 142 of 2,753 at 6 (first 256 decisions of each run).

### Exact Speed-Up First

`PokerEngine.calculatePots`, the canonical pot partition and the hottest shared helper in the continuation (an allocation-light version cut the full Phase 8 work sum by about 7% in the P8.1 host C experiment), now builds each level in one pass, finds distinct levels with a sorted copy, and compares eligible lists element by element instead of as JSON. It changes no result:

- `PokerEngine.calculatePotsExact.test.ts`: the previous implementation, kept verbatim, is the oracle over 60,000 seeded random tables (folds, all-ins, ties, full and short individual antes, Big Blind Antes, dead blinds, the `bet` fallback, dead-money-only hands): bit-identical amounts and identical pots, order and eligible lists.
- `phase8-useful-completion.mjs digest` (clock frozen; every decision, distribution, utility moment, work counter and receipt): before and after are identical on the 182-decision P8.1 population (`484989a4...a143a`) and on 823 production decisions (every 8th eligible decision of the two windows, kept only in the evidence archive because it carries production identities; `b13cbffd...cd868e`).
- Paired timing on the 823 production decisions (`compare`, one process, A-B-B-A, clock frozen, Mac at load about 4): the whole horse decision summed to 10,514.8 ms before and 10,192.0 ms after (3.1% of the entire decision, Phase 8 included), 477 of 823 decisions faster, all 823 digests identical.

A gap of about three times the budget at five or more seats cannot be closed by removing redundant work, so the scoped refusal follows.

### Scoped Refusal

`PHASE8_POLICY.maxFutureHandSeats = 3`. `futureHandSeats(gs)` counts seats with chips behind (sitting out included, a tournament deals them in) plus unfolded seats with chips in the pot. A larger table returns `future_hand_seats_outside_work_budget` before `eligible` is set: no work is spent, the baseline decision stands, and the decision neither counts toward nor resets a run of eligible silence. The silence latch (32), the budget-breach latch (3) and the 4 ms, 5 ms and 2 ms budgets are unchanged; real eligible silence still latches. Continuation version `horse-tournament-postflop-round2-v1`. Delivered in [#6506](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6506), merged `e687427d`.

What this gives up, stated plainly: Phase 8 no longer computes at full tables, so its deep one-pair guard (the only thing it ever changed, below) no longer reaches full-table MTT spots such as the four captured production lines, which are now pinned as refused. Before this change it reached them only when a decision happened to complete (4% of full-table spots in production) and only until the latch tripped.

### Production After Release

Declared before the release and before any read (`verify-window-declaration.md` in the evidence archive): window [19:05Z, 19:35Z) on the engine serving after the 18:55Z break. That engine is `44c44900b3181e03e1daa36b7615b5307571d360`, which contains `e687427d` (`git merge-base --is-ancestor`), one process from 18:55:14Z (`/health` uptime 2,313 s at 19:33:47Z and 2,425 s at 19:35:40Z). Source: read-only tar copy of both decision shards' segments (144,490 segments), parsed off the host.

| Measure                                 | Before (window 2, engine `4fadb520`)             | After (engine `44c44900`)                                               |
| --------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| Phase 8 domain ledgers                  | 13,034                                           | 6,966                                                                   |
| `disabled_eligible_but_silent`          | 8,645                                            | **0**                                                                   |
| `phase8SafetyDisabledReason`            | latched at 13:05:12Z                             | `null` on every record                                                  |
| `future_hand_seats_outside_work_budget` | (did not exist)                                  | 1,571 (all MTT)                                                         |
| Eligible / fired / completed            | 1,822 / 532 / 532                                | 1,255 / 1,162 / 1,162 (all two-seat Sit and Go)                         |
| Eligible refusals                       | `continuation_operation_budget` 1,249 and others | `continuation_operation_budget` 84, `continuation_sample_calibration` 9 |
| Changed (shadow)                        | 0                                                | 0                                                                       |

Every eligible ledger carries `horse-tournament-postflop-round2-v1`. Status: verified now.

## 2. Does The Continuation Choose Actions?

No. Two independent reads:

- Production, every fired decision of both windows (3,663 fired, engine `4fadb520`): the continuation's highest-utility action differed from the baseline on 3,053, and its change test (two separate 99.9% intervals: chosen lower bound above the strongest alternative's upper bound) kept the baseline on all 3,053. Median utility gap 2.65 funded-pool points, median summed half-width 43.7, median per-candidate standard error 3.85. The disagreements were mostly heads-up: check over the baseline's bet (HU Sit and Go 766, Spin 263), check over all-in (486, 162), smaller and larger bet sizes.
- The P8.2 matrix (18 runs, 18,432 paired tournaments, source `c0b56ffc`): 306 changed decisions over 50,186 fired, and every one was a prevented deep one-pair commitment (`changed` equals `preventedCommitments` in all 18 runs). The utility itself never moved an action.

So the 18-run gain could not appear: apart from the catastrophe guard, the candidate was the baseline.

### The Fix Tried, On Development Seeds Only

Every candidate is valued on the same outcome samples, future-hand draws and ICM trials, so the separate-interval test counts shared sampling error twice. A paired change test (weighted mean and variance of the per-sample utility difference against the baseline, same 99.9% level, both sides' ICM and option estimate error charged in full, the equity error when exactly one side folds) was built with six tests ([#6519](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6519)) and measured, clock frozen so every eligible decision computes in full:

| Population                                                        | Separate intervals (current)                                            | Paired test                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| 823 production decisions, 441 fired                               | 0 changed                                                               | 5 changed                       |
| League Spin, development seed 7101101, 256 pairs, league entrants | 14 changed (all the guard); paired funded-pool return 0.0000, SE 0.0055 | 127 changed; -0.0195, SE 0.0141 |
| League Sit and Go, development seed 7101101, 64 pairs             | 0 changed; 0.0000                                                       | 1 changed; 0.0000               |

With 256 pairs neither Spin result is significant, but letting the utility choose moved the return the wrong way. It was not shipped; #6519 is closed and the separate-interval test stays. Its conservatism is protecting against a utility whose rankings are not reliable.

### Where Tournament Equity Should Come From, And The Next Root Cause

Inside the scope the continuation now runs on exactly the spots where ICM pressure is largest: heads-up and three-handed play, Spins, and the last three of a Sit and Go or MTT. It cannot yet add equity there for two measured reasons: sixteen outcome samples rarely separate two actions even when paired (5 of 441), and when allowed to act its ranking loses on development seeds. Both trace to the rollout model (one opening wager per street, responders calling on a strength cutoff, own-board-contact strength), which is not calibrated to how the opponents actually respond. The owner's population finding ([WIN-POP](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6515)) adds that real humans limp, call and fold very differently from every league population. The next root cause to fix is that response model, fitted to observed opponents, before any selection rule is loosened.

## 3. The Matrix On The Final Source

Contract unchanged (`summarizeTournamentPromotion` and `tournamentRunCanPromote` in `server/src/benchmark/HorseTournamentLeague.ts`, imported by the assembler, not reimplemented): seeds 8101101, 8102203, 8103307; objectives mtt, sng, spin, satellite, pko, mystery; 1,024 paired tournaments per run; every run's 99% lower bound must be above zero. Opponent population: the league's own entrants (horses of the `balanced` style), so this is horse-against-horse evidence only. Prize model: the league's funded-pool return (prize share plus paid bounty over the funded pool; satellite seat equity), no per-hand rake.

- Source `e687427d202e11266b3713038ecd4a66f788cf26`, server source SHA-256 `8b28624d...fcaca` over 1,896 files, continuation `horse-tournament-postflop-round2-v1`, policy digest `c65ffa53...decbb3`.
- Workflow `horse-phase8-strength-league.yml`, run [37802068859](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37802068859), dispatched 2026-10-08T15:35:52Z on the merge of #6506 and recorded on that PR; one run per GitHub-hosted 4-vCPU runner, Node 22, hydrated solver stores.
- Machine record: [`evidence/phase8/strength-2026-10-08/strength.json`](evidence/phase8/strength-2026-10-08/strength.json) (sha256 `67f06fe1...fed373`), the 17 run results with their manifests and receipts, `hosts.json`, `context.json`, `defective.json`, and [`phase8-qualification-2026-10-08.json`](evidence/phase8/phase8-qualification-2026-10-08.json) (`qualified: false`).

| Run               | CPU                                           | Pairs          | Exit | Eligible |  Fired | Completed | Changed | Named refusals                                                                                      | Illegal / conservation / truncated | p99 ms | Mean difference | 99% interval       | Promotable                |
| ----------------- | --------------------------------------------- | -------------- | ---- | -------: | -----: | --------: | ------: | --------------------------------------------------------------------------------------------------- | ---------------------------------- | -----: | --------------: | ------------------ | ------------------------- |
| mtt-8101101       | AMD EPYC 7763 64-Core                         | 1,024 of 1,024 | 1    |        0 |      0 |         0 |       0 | none                                                                                                | 0 / 0 / 0                          |   0.11 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| sng-8101101       | AMD EPYC 7763 64-Core                         | 1,024 of 1,024 | 0    |      403 |     40 |        40 |       0 | `continuation_operation_budget` 358, `continuation_sample_calibration` 5                            | 0 / 0 / 0                          |   4.02 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| spin-8101101      | AMD EPYC 9V74 80-Core                         | 1,024 of 1,024 | 1    |   20,513 | 11,849 |    11,761 |      42 | `continuation_operation_budget` 8,344, `budget_exhausted` 317, `continuation_sample_calibration` 91 | 0 / 0 / 0                          |   5.15 |        +0.00488 | [-0.0067, +0.0165] | no                        |
| satellite-8101101 | AMD EPYC 7763 64-Core                         | 1,024 of 1,024 | 1    |        0 |      0 |         0 |       0 | none                                                                                                | 0 / 0 / 0                          |   0.10 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| pko-8101101       | Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz | 1,024 of 1,024 | 1    |        0 |      0 |         0 |       0 | none                                                                                                | 0 / 0 / 0                          |   0.10 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| mystery-8101101   | AMD EPYC 7763 64-Core                         | 1,024 of 1,024 | 1    |        0 |      0 |         0 |       0 | none                                                                                                | 0 / 0 / 0                          |   0.10 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| mtt-8102203       | AMD EPYC 9V45 96-Core                         | 1,024 of 1,024 | 1    |        0 |      0 |         0 |       0 | none                                                                                                | 0 / 0 / 0                          |   0.10 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| spin-8102203      | AMD EPYC 7763 64-Core                         | 1,024 of 1,024 | 0    |   20,564 |  2,500 |     2,497 |      37 | `continuation_operation_budget` 17,903, `continuation_sample_calibration` 95, `budget_exhausted` 69 | 0 / 0 / 0                          |   4.73 |        +0.01074 | [+0.0017, +0.0198] | yes                       |
| satellite-8102203 | AMD EPYC 7763 64-Core                         | 1,024 of 1,024 | 1    |        0 |      0 |         0 |       0 | none                                                                                                | 0 / 0 / 0                          |   0.11 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| pko-8102203       | AMD EPYC 9V45 96-Core                         | 1,024 of 1,024 | 1    |        0 |      0 |         0 |       0 | none                                                                                                | 0 / 0 / 0                          |   0.10 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| mystery-8102203   | AMD EPYC 9V74 80-Core                         | 1,024 of 1,024 | 1    |        0 |      0 |         0 |       0 | none                                                                                                | 0 / 0 / 0                          |   0.12 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| mtt-8103307       | Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz | 1,024 of 1,024 | 1    |        0 |      0 |         0 |       0 | none                                                                                                | 0 / 0 / 0                          |   0.10 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| sng-8103307       | AMD EPYC 9V74 80-Core                         | 1,024 of 1,024 | 0    |      304 |     25 |        25 |       0 | `continuation_operation_budget` 245, `budget_exhausted` 32, `continuation_sample_calibration` 2     | 0 / 0 / 0                          |   4.02 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| spin-8103307      | AMD EPYC 7763 64-Core                         | 1,024 of 1,024 | 0    |   21,007 |  2,736 |     2,736 |      29 | `continuation_operation_budget` 18,150, `continuation_sample_calibration` 120, `budget_exhausted` 1 | 0 / 0 / 0                          |   4.42 |        +0.00488 | [-0.0027, +0.0125] | no                        |
| satellite-8103307 | AMD EPYC 9V45 96-Core                         | 1,024 of 1,024 | 1    |        0 |      0 |         0 |       0 | none                                                                                                | 0 / 0 / 0                          |   0.12 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| pko-8103307       | AMD EPYC 7763 64-Core                         | 1,024 of 1,024 | 1    |        0 |      0 |         0 |       0 | none                                                                                                | 0 / 0 / 0                          |   0.11 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| mystery-8103307   | INTEL(R) XEON(R) PLATINUM 8573C               | 1,024 of 1,024 | 1    |        0 |      0 |         0 |       0 | none                                                                                                | 0 / 0 / 0                          |   0.15 |        +0.00000 | [+0.0000, +0.0000] | no                        |
| sng-8102203       | AMD EPYC 7763 64-Core                         | no result      | -    |        - |      - |         - |       - | -                                                                                                   | -                                  |      - |               - | -                  | defective: job time limit |

| Objective | Pooled pairs | Mean difference | 99% interval           |
| --------- | -----------: | --------------: | ---------------------- |
| mtt       |        3,072 |         0.00000 | [0.0000, 0.0000]       |
| sng       |        2,048 |         0.00000 | [0.0000, 0.0000]       |
| spin      |        3,072 |    **+0.00684** | **[+0.0013, +0.0124]** |
| satellite |        3,072 |         0.00000 | [0.0000, 0.0000]       |
| pko       |        3,072 |         0.00000 | [0.0000, 0.0000]       |
| mystery   |        3,072 |         0.00000 | [0.0000, 0.0000]       |

What the matrix says:

- **Spin (three seats, every decision inside the scope): a measured gain over the current brain, against league horses.** Pooled over 3,072 paired Spins the candidate returned +0.00684 of the funded pool per tournament more than the baseline, 99% interval +0.0013 to +0.0124. Every one of the 108 changes was a prevented deep one-pair commitment (`changed` equals `preventedCommitments` in every run); the continuation's utility moved nothing. All six Spin runs across both rounds are positive (+0.0059, +0.0039, +0.0059 on `c0b56ffc`; +0.0049, +0.0107, +0.0049 here). One run (`spin-8102203`) passes the per-run contract on its own; `spin-8101101` fails on its interval and on its p99 latency (5.15 ms on its runner), `spin-8103307` on its interval.
- **The five eighteen- and six-entrant objectives cannot qualify inside this scope.** Their tables seat six, so a decision becomes eligible only once a table is down to three seats with chips, which the league's short schedule (blinds double every six hands, at most 96 hands) reaches almost only in Sit and Go: 0 eligible decisions in all twelve mtt, satellite, pko and mystery runs, 403 and 304 in the two complete Sit and Go runs, none changed. The candidate is the baseline there, so the contract's per-run conditions (`changed > 0`, a positive lower bound) cannot hold.
- `sng-8102203` reached the workflow's 355-minute job limit (GitHub-hosted jobs stop at 360) at 21:34:39Z without writing a result; GitHub cancelled it. It is recorded as defective in `defective.json` and was not rerun: the verdict does not depend on it.
- No illegal action, conservation error or truncated hand in any of the 17,408 completed paired tournaments.

## 4. Human-Population Check

The winning-contract addendum merged as `f184a99d` ([#6515](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/6515), `docs/horse-brain-winning-contract-2026-10-08.md`). Its condition (b), after-rake win rate against the human-calibrated population with a 99% lower bound above zero, is stated there as **unavailable external input** for every tournament pack: a tournament's money objective is prize equity and no human-calibrated tournament field exists (the Phase 8 league seats only `balanced` horses), and on top of that the human calibration itself fails its adequacy precondition (5 human accounts, the most active 68.5% of human seat-hands; 99.988% of horse seat-hands from October 1 to 8 had no human seated). So the check cannot be run honestly for Phase 8 today, and by that contract no tournament pack can qualify until a human-calibrated tournament field is added by its own committed addendum. Status: unavailable external input.

## 5. Verdict

- Condition (a), the unchanged 18-run paired contract: **not met** (`promoted: false`; 1 of 17 completed runs promotable; matrix incomplete by one defective run).
- Condition (b), winning after rake against humans: **unavailable external input**.
- Therefore `qualified: false`, `PHASE8_PROTECTED_RELEASE_SELECTION` stays `null`, nothing is selected, and every Phase 8 decision stays in shadow. Natural accepted use and the withdrawal path are not applicable with reason: nothing can be selected.

Measured gap and next root cause, in order:

1. **The only part of Phase 8 that wins is the deep one-pair guard, and the guard does not need the continuation.** It produced every change in both rounds and the Spin gain above. A next candidate should run that guard on Phase 7's own candidates at every table size, with no future-hand work, so full-table MTT and Sit and Go spots get it inside a fraction of a millisecond; it then needs its own matrix on its own source.
2. **The continuation's utility does not rank actions reliably.** Its separate-interval change test never lets it act, and the paired test that does let it act lost on development seeds (Spin -0.0195, standard error 0.0141, 127 changes). The rollout's response model (one wager per street, responders on a strength cutoff) has to be fitted to how opponents actually respond before any selection rule is loosened.
3. **Qualification against humans needs humans.** Condition (b) stays unavailable until a real human population exists and a human-calibrated tournament field is added by its own addendum.

## Gate Statuses

| Gate               | Status                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 Domain          | verified now: NLH single-board tournament postflop; tables whose next hand deals more than three seats refused by name before eligibility                         |
| G2 Inputs          | verified now: production journal reads declared before reading; matrix hydrated solver stores on every runner (240 charts, 7,747 postflop cells)                  |
| G3 Calculation     | verified now: 17 runs complete at 1,024 of 1,024 pairs; verdict from the real contract; one run defective (job time limit), kept                                  |
| G4 Authority       | verified now: `phase8-qualification-2026-10-08.json` binds source, continuation `round2-v1`, policy digest and evidence hash, and says `qualified: false`         |
| G5 Actual use      | not applicable with reason: nothing qualified, so nothing can be selected or controller-accepted; production stays shadow                                         |
| G6 Outcomes        | verified now: eligible, fired, completed, changed and every named refusal per run and in the production window                                                    |
| G7 Correctness     | verified now: 0 illegal, 0 conservation, 0 truncated across 17,408 paired tournaments; calculatePots exact over 60,000 tables; 1,124 tests over 27 files on #6506 |
| G8 Work and replay | verified now: 4 ms, 5 ms and 2 ms budgets unchanged; fixed seeds, pairs and one run per runner; digests identical before and after the speed-up                   |
| G9 Promotion       | verified now: not promoted                                                                                                                                        |
| G10 Publication    | verified now: #6506 published in engine `44c44900` (contains `e687427d`) at the 18:55Z break; production window verified                                          |

## Exact Commands

```text
# production journal (read-only), evidence archive horse-brain-finish-20261008/win-p8/
tools/grabwin.sh "<start CDT>" "<end CDT>" <dir>          # tar of both shards' segments over the read-only SSH route
W0=<window start ms> WLEN=<ms> python3 tools/p8extract.py <dir>/segments.tar <rows.pkl>
python3 tools/p8seats.py; python3 tools/p8util.py; python3 tools/p8verify.py <rows.pkl>

# exactness and timing (server/, each tree compiled with tsc)
P81_DIST=<tree> node scripts/phase8-useful-completion.mjs digest --population=<population> --out=<file>
node scripts/phase8-useful-completion.mjs compare --population=<population> --a=dist-base --b=dist-pots --reps=3 --out=<file>
npx vitest run src/engine/PokerEngine.calculatePotsExact.test.ts

# development seeds only (clock frozen), never a contract seed
npx tsx tools/devleague.mts <worktree> spin 7101101 256 <out>

# matrix and assembly
gh workflow run horse-phase8-strength-league.yml -f source_sha=e687427d202e11266b3713038ecd4a66f788cf26
cd server && npx tsx scripts/phase8-strength-assemble.mjs --runs=<17 run directories> \
  --hosts=../docs/evidence/phase8/strength-2026-10-08/hosts.json \
  --context=../docs/evidence/phase8/strength-2026-10-08/context.json \
  --defective=../docs/evidence/phase8/strength-2026-10-08/defective.json \
  --out=../docs/evidence/phase8/strength-2026-10-08
```
