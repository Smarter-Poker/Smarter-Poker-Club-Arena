# Horse Brain Winning Contract Addendum, October 8, 2026

Horse Brain only. This addendum is an evaluation contract change, written and committed before any run it governs. It adds a second, independent condition to every strategy pack's qualification, so that no pack can be switched on unless it both beats the brain horses use today and wins money after rake from the players horses actually take money from: human players. It changes no money, settlement or table rule, and no existing opponent profile, seed, threshold or past record. The facts behind it are in `docs/horse-brain-human-population-2026-10-08.md`.

The owner's instruction this contract carries: "THEY NEED TO BE WINNING PLAYERS AND STRATEGY! YOU HAVE TO VERIFY THAT THEY CAN USE THE LOGIC AND BEAT THE RAKE. (BUT THAT CAN'T REALLY BE POSSIBLE IF THEY ARE ALL PLAYING AGAINST EACH OTHER) THE HOUSE WILL ALWAYS WIN IF THERE IS NO OUTSIDE MONEY TO WIN."

## The Rule

From this commit on, a strategy pack (Phase 8, Phases 10 to 13, and any later pack) **qualifies only if both hold**:

**(a) It beats the current brain.** Its phase's existing paired contract passes unchanged: the candidate arm against the reference arm (the same horse with the pack off) on identical cards, seats, button and opponents, at the phase's published rake, with that contract's profiles, held-out seeds, pairs, statistic and thresholds. Nothing in the existing contracts is altered by this addendum.

**(b) It wins after rake against humans.** Its after-rake win rate against the human-calibrated opponent population has a two-sided 99% lower bound above zero, measured as specified below, **and** the population's calibration is adequate on the day of the run.

A pack that passes (a) and not (b) does not qualify; its selection stays `null`. A pack that passes (b) and not (a) does not qualify either.

## Condition (b), Specified

| Item                | Specification                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opponent population | `human-calibrated-v1-20261008` (`server/src/benchmark/HumanCalibratedPopulation.ts`): every non-hero seat plays the human-calibrated profile of the variant's family (NLH; Omaha; other) with the committed fitted cutoffs. A later calibration is a new population id and a new committed addendum before its runs.                                            |
| Tables              | each of the phase's existing cash contract profiles, transformed by `withHumanCalibratedOpponents(profile)` (`server/src/benchmark/Plo4PolicyLeague.ts`): same seats, table size, stacks and published pricing, new id `<profile id>--human-calibrated-v1-20261008`                                                                                             |
| Hero                | the candidate arm (the production horse with the pack on, through the phase's own admission and authority path), in the rotating hero seat the phase's contract uses                                                                                                                                                                                            |
| Rake model          | the engine's published rake for the profile's stake and variant, the player-count cap ladder and BBJ drop, exactly as the phase's existing contract prices a hand (`publishedRake`); this is the schedule production charges (`ca_rake_schedule`, `ca_rake_schedule_caps`, `ca_rake_rules`)                                                                     |
| Statistic           | the hero seat's net chips per hand after rake and BBJ drop (final stack minus starting stack), in bb/100; the stratified mean with equal weight per profile, hands pooled within a profile across seeds and shards                                                                                                                                              |
| Interval            | two-sided 99% normal (Wald) interval on the stratified mean, `T +/- z * sqrt(sum w_p^2 s_p^2 / n_p)`, `z = Phi^-1(0.995)`, `s_p^2` the unbiased within-profile variance of the hero net per hand                                                                                                                                                                |
| Gate                | lower bound > 0 bb/100                                                                                                                                                                                                                                                                                                                                          |
| Sample              | at least 10,000 hands per profile in every cell                                                                                                                                                                                                                                                                                                                 |
| Seeds               | held-out seeds `19201101`, `19202203`, `19203307` (`HUMAN_CALIBRATED_HOLDOUT_SEEDS`) for human-calibrated runs only; outside the fitting range (`14100000 + i * 100000 + k`, i at most 20, k below 100000) and the check range (`18900000 + k`); disjoint from every existing held-out seed (pinned by test); never dealt by a test, a fit or a development run |
| Tournaments         | the money objective is prize EV, which no human-calibrated tournament field yet models (Phase 8's `HorseTournamentLeague` seats only `balanced` horses); condition (b) for a tournament pack is **unavailable external input** until a human-calibrated tournament field is added by its own committed addendum, so no tournament pack can qualify before then  |
| Kept runs           | every run under this contract is recorded, favorable or not; no seed, profile, shard or window is chosen after a result                                                                                                                                                                                                                                         |

## Calibration Adequacy (A Precondition Of (b))

A human-calibrated result can only qualify a pack when the population is a calibration of a real player market, not of a handful of accounts. For the variant's family, on the calibration the population was fitted to:

1. at least 10,000 human seat-hands in the family;
2. at least 20 distinct human accounts;
3. no single account above 25% of the human seat-hands;
4. fitted cutoffs that reproduce every measured share within 5 percentage points at every node with at least 300 decisions on the fit's fresh-seed check pass, as recorded in the population's record.

`humanCalibrationAdequacy` checks 1 to 3 in code (`HUMAN_CALIBRATION_MINIMUMS`); 4 is read from the fit record.

On the calibration committed today (October 8, 2026) every family fails 1 to 3: 5 accounts, the most active one 68.5% of human seat-hands, and 1,718 (NLH), 608 (Omaha) and 85 (other) human seat-hands. **Condition (b) is therefore unavailable external input for every pack today, and no pack can qualify.** That is the owner's statement in contract form: with no outside money there is nothing for a winning strategy to win, and the measurement cannot be made honestly. When production has an adequate human population, the population is refitted from it, given a new id, and committed in a new addendum before any qualifying run.

Human-calibrated runs on development seeds are allowed now, to steer development; they are reported as development measurements, never as qualification.

## What Does Not Change

- Every existing contract (`Plo4StrengthContract.ts`, `OmahaVariantStrengthContract.ts`, `RemainingVariantStrengthContract.ts`, `JointStrengthContract.ts`, the Phase 8 tournament matrix), its digest, profiles, seeds, thresholds and recorded evidence.
- The production horse population and its five styles; no league profile names `opponentPopulation` except through `withHumanCalibratedOpponents`.
- Money, settlement, rake and table rules; the 8-day Horse-only hand retention; tournament business rules.
- Selections: every pack stays shadow with selection `null`.

## Where Each Pack Stands Under This Contract

| Pack                                      | (a) beats the current brain (closure records)                 | (b) wins after rake against humans                                                        |
| ----------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Phase 8 NLH tournament continuation       | not met: no significant gain (18-run matrix)                  | unavailable external input (no human-calibrated tournament field; calibration inadequate) |
| Phase 10 PLO4                             | not met (`docs/horse-brain-phase10-completion-2026-10-03.md`) | unavailable external input (calibration inadequate)                                       |
| Phase 11 PLO5, PLO6, PLO8                 | not met: -4.02, -4.91, -9.21 bb/100                           | unavailable external input (calibration inadequate)                                       |
| Phase 12 Short Deck, Pineapple, FLH, FLO8 | not met: -20.80, -24.86, -7.75, -4.79 bb/100                  | unavailable external input (calibration inadequate)                                       |
| Phase 13 joint multiway response          | not met: every variant negative (-98.53 to -973.83 bb/100)    | unavailable external input (calibration inadequate)                                       |

No selection changes. Every pack stays `null`.

## Amendment Of October 9, 2026 (Owner Decision)

The owner decided on October 9, 2026, and confirmed it directly the same day: strategy upgrades do not need to be proven against human players before launch. They cannot be until after launch, because there are almost no human players yet. This amendment, committed before any selection it governs, replaces **The Rule** above. Everything else in this addendum stands as specified, now as the definition of the post-launch check.

**Qualification is condition (a) alone.** A strategy pack (Phase 8, Phases 10 to 13, and any later pack) qualifies when its phase's locked paired contract passes unchanged on its held-out seeds (the assembler's verdict `qualified: true`), measured at the policy digest the engine runs. It is then selected for every horse in its domain through its own phase's protected-release authority path: the qualification file, the strength record it names and any completion record the phase requires, committed under `docs/evidence/` and shipped in the engine image under `server/release-evidence/`; the phase's `PHASE*_PROTECTED_RELEASE_SELECTION*` entry set in a reviewed change; the engine release; natural accepted use verified in production. Every other admission check of that path (contract digest, policy digest, source, evidence hashes, and the completion floor where the phase has one) is unchanged.

**Condition (b) becomes post-launch monitoring that can only withdraw.** Once production has an adequate human population (the Calibration Adequacy minimums above, unchanged), the population is refitted from it under a new id and the measurement in Condition (b), Specified is run for every selected pack on fresh held-out human seeds committed before the run. A selected pack whose after-rake two-sided 99% lower bound against that adequate calibration is below zero is **withdrawn**: a reviewed change sets its selection's `withdrawn` to `{ at, reason }` with reason `condition_b_lost_after_rake`, and the pack returns to shadow at the next engine release. A withdrawn approval generation never returns. A result above zero changes nothing. A result on an inadequate calibration is a development measurement and can neither select nor withdraw.

**No code treats condition (b) as a selection gate.** The assemblers write the qualification file from condition (a) alone and the authorities admit on it; `HumanCalibratedCheck.ts` keeps its statistic, interval, gate and completeness as the monitoring measurement, and its `conditionB` verdict feeds only a withdrawal decision. For a tournament pack, condition (b) stays unavailable external input until a human-calibrated tournament field exists; that no longer blocks selection.

### Where Each Pack Stands Under The Amended Rule (October 9, 2026)

| Pack                                          | Condition (a), locked matrix                                                                                                                                                | Selection                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Phase 10 PLO4 (`plo4-policy-round3-v2`)       | qualified: +6.94 [+6.25, +7.62] bb/100, 2,557,440 pairs on `c8bfc617`                                                                                                       | selected, approval generation 1                                   |
| Phase 11 PLO8 (`plo8-split-round3-v2`)        | qualified: +7.84 [+6.84, +8.84] bb/100, 1,116,288 pairs on `c8bfc617`                                                                                                       | selected once its P11.3 natural completion record meets the floor |
| Phase 11 PLO5 (`plo5-high-round3-v2`)         | qualified: +5.37 [+4.25, +6.49] bb/100, 2,379,456 pairs on `c8bfc617` (run 37837891124, finished October 9)                                                                 | selected once its P11.3 natural completion record meets the floor |
| Phase 12 FLH (`fixed-limit-holdem-round3-v1`) | qualified: +1.11 [+0.70, +1.52] bb/100, 544,320 pairs, re-run unchanged on `c8bfc617` (run 37940882035), because #6526 changed shared policy files after the `022e1e4f` run | selected once its P12.3 natural completion record meets the floor |
| Phase 11 PLO6; Phase 12 Pineapple             | matrices finishing on `c8bfc617`                                                                                                                                            | selected if they qualify                                          |
| Phase 12 Short Deck, FLO8                     | not qualified: trust-check cells                                                                                                                                            | stay `null`                                                       |
| Phase 13 joint multiway response              | not qualified so far; re-run on the running source                                                                                                                          | selected if a variant qualifies                                   |
| Phase 8 tournament continuation               | not qualified (round 2)                                                                                                                                                     | stays `null`                                                      |
