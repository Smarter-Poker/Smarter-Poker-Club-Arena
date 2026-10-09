# Horse Brain Phase 10 And Phase 11, Round 3: Omaha Packs That Beat The Reference (October 8, 2026)

Horse Brain only. Scope: the Phase 10 PLO4 pack and the Phase 11 PLO5, PLO6 and PLO8 packs. Status words are the maintained vocabulary: verified now, historical only, implemented but unverified, defective, unavailable external input, not applicable with reason. Every measured claim names its opponent population, rake model, sample size and 99% interval. No held-out seed was used for anything in the diagnosis or the design; held-out seeds run only in the locked matrices named below.

The owner's target for every strategy upgrade: it beats the brain horses use today, and it wins after rake against the opponents horses actually face for money, the human players. Horse-versus-horse results alone are not the target.

## Starting Point

Closure records: [Phase 10](horse-brain-phase10-completion-2026-10-03.md), [Phase 11](horse-brain-phase11-closure-2026-10-05.md). Every pack lost to the reference on its locked held-out matrix (cash after rake, horse population, published 1/2 rake rows): PLO4 pooled -0.16 bb/100 with the two-dealt profile at -25.6; PLO5 -4.02 [-7.18, -0.86], PLO6 -4.91 [-7.92, -1.91], PLO8 -9.21 [-12.20, -6.23]. Every selection is `null`.

## Method (Development Seeds Only)

Two development tools, committed with this round and refusing every held-out seed:

- `server/src/scripts/omahaLeakDiagnose.ts`: plays the contract league's paired hands (the real `playPlo4PolicyHand`, the contract profile, production styles, published rake, mood clock) and attributes each pair's net difference to the hero's first applied change, where the arms diverge. It also counts HorseLogic's `illegal_candidate` refusals.
- `server/src/scripts/omahaCounterfactual.ts`: a one-step counterfactual of the reference brain. For each pair it plays the reference arm (pack in shadow, receipt recorded), picks one eligible hero decision, then replays the identical deal once per alternative at that decision (fold or check, call, half-pot wager, pot wager) with the reference everywhere else. The difference is Q(state, alternative) minus Q(state, reference) for that one decision.

Opponent population in every development run: the horse population as the locked contracts define it (every seat `HorseLogic.decide` with production styles, empty modifiers, fresh HorseMind, deterministic mood clock). Rake: the published 1/2 rows (`getFullRakeConfig`, player-count caps, BBJ drop where the variant has one). Development seeds: PLO4 10101101, 10102203, 10103307; PLO5, PLO6, PLO8 11101101, 11102203, 11103307. Evidence: `/Volumes/SmarterArchives/agent-evidence/horse-brain-finish-20261008/win-omaha/` (`diag1/`, `cf1/`, `cfhu/`, `cfpost/`, `v1/`, `v2hu/`, `v2ring/` for the first source; `hc1/` for its human-calibrated check; `v3-horse/`, `v3-ring/`, `v3-human/`, `v3-ring-human/` for the final source; the analysis scripts `analyze2.py` and `acf.py`).

## Where The Round 1 Packs Lost

First-divergence attribution, round 1 source, 10,080 pairs per profile per variant on seeds 1 and 2:

- The losses start preflop. The packs replaced the reference's preflop with their own entry atlas. Heads-up they fold hands the reference plays profitably (PLO5 two-dealt: `preflop_entry_declined` raise to fold, 4,370 pairs, -0.52 BB per pair; PLO4 two-dealt: the button fold -0.42 BB and the big blind fold -0.95 BB per pair), and in every profile they open smaller than the reference (PLO4 `rfi` raise to a smaller raise: -1.2 to -2.8 BB per pair in all five profiles).
- Postflop, every call or raise the packs make is priced against `sampleOmahaVariantEquity`, 32 samples drawn from a public-line prior that escapes to a uniform hand after two rejections. Against a betting range this overstates the hand. The counterfactual shows it directly: at six-max, where the reference folds facing a bet, calling instead loses on every variant (PLO4 -10.00 +/- 2.82 BB per decision, n = 764; PLO5 -10.89 +/- 2.19, n = 638; PLO6 -12.17 +/- 4.39, n = 329; PLO8 -8.46 +/- 4.30, n = 244), including where the sampled equity clears the price (PLO5 facing a bet with sampled margin +0.1: call -19.67 +/- 11.90, n = 66).

## The Earlier Defect Class

The 2026-10-05 audit defect (candidate sizes the legalizer rewrites, `illegal_candidate` playing the reference) is fully gone: 0 `illegal_candidate` refusals on every development pair counted on the final source (176,256 pairs over both populations: 60,480 two-dealt and 23,040 four-dealt and six-max against horses, 60,480 two-dealt and 32,256 four-dealt and six-max at the human-calibrated table), and `OmahaLegalFormCandidates.test.ts` pins it on real heads-up league hands for all four packs.

## River Net-Chip Economics (#6444)

`omahaVariantActionEconomics` is computed after `finish` on the river and recorded on the receipt; it never chooses an action. It settles the same showdowns the sampler drew, so it inherits the sampler's unconditioned opponent range: using it to choose actions would repeat the postflop loss above. It stays recorded only, unchanged by this round.

## The Reference Is Close To Locally Optimal At Four And Six Dealt

One-step counterfactuals at four-dealt and six-max (40, 100 and 200 BB), all variants, about 4,000 to 7,700 probed decisions per variant and street class: no alternative beats the reference at 99% in any preflop class, and none postflop where the reference faces a bet. Of about 40 cells per variant, one is nominally positive (PLO4 checked-to, where the reference bets, a half-pot bet +1.58 +/- 1.18 BB), which is what chance gives across that many cells and did not replicate on the other variants (PLO5 +0.46, PLO6 -0.44, PLO8 +1.20, none significant). No ring deviation is made.

## The Actions That Beat The Reference

Heads-up, three actions beat the reference against the horse population on every variant (counterfactual, seeds 1 and 2, two-dealt profile; BB per decision, 99% interval):

| Spot (the reference folds or checks) | Alternative   | PLO4                                           | PLO5                       | PLO6                     | PLO8                     |
| ------------------------------------ | ------------- | ---------------------------------------------- | -------------------------- | ------------------------ | ------------------------ |
| Button, first to act preflop         | minimum raise | +0.62 +/- 0.33 (n = 3,157, quality 0.1 to 0.2) | +0.69 +/- 0.34 (n = 3,736) | +0.49 +/- 0.99 (n = 496) | +0.77 +/- 0.71 (n = 660) |
| Big blind facing the button's raise  | pot three-bet | +0.51 +/- 0.99 (n = 2,232, quality 0.1 to 0.2) | +1.88 +/- 0.78 (n = 3,501) | +2.28 +/- 2.11 (n = 508) | +0.72 +/- 1.77 (n = 415) |
| Button checked to, river             | pot bet       | +4.92 +/- 3.50 (n = 158)                       | +3.21 +/- 2.52 (n = 188)   | (too few)                | (too few)                |
| Button checked to, turn              | pot bet       | +4.59 +/- 3.10 (n = 121)                       | +1.79 +/- 2.30 (n = 141)   | (too few)                | (too few)                |

## The Human-Calibrated Check Removed One Of Them

The winning contract ([addendum](horse-brain-winning-contract-2026-10-08.md), #6515) adds a second condition: a pack must also win after rake at the human-calibrated table (`human-calibrated-v1-20261008`). Its qualifying form is unavailable external input today (calibration inadequate: 5 human accounts, 608 Omaha human seat-hands), but development runs at that table are allowed and were made here, on the same development seeds, through `omahaLeakDiagnose.ts --population=human`.

The first round 3 source (#6513, `omaha-reference-deviations-v1`, all three actions) beat the reference heads-up against horses by +44 to +65 bb/100 and LOST to it at the human-calibrated table (seed 3, 5,040 pairs each: PLO4 -17.7 +/- 27.1, PLO5 -18.9 +/- 27.4, PLO6 -11.4 +/- 23.8, PLO8 -24.6 +/- 22.7). First-divergence attribution names the cause: the big-blind three-bet lost 5.1 to 6.1 BB every time it fired at the human-calibrated table, on every variant (PLO4 -5.06 +/- 2.59, n = 435; PLO5 -6.12 +/- 2.28, n = 420; PLO6 -6.03 +/- 2.63, n = 368; PLO8 -5.15 +/- 2.22, n = 429), while the button open (+0.64 to +1.33 BB per firing) and the turn stab (+2.0 to +5.7) still won there. The three-bet won against horses only because the reference horse over-folds to three-bets; that is a read of the horse brain, not a winning strategy, and it was removed at the root (`omaha-reference-deviations-v2`, pack versions `round3-v2`).

## The Round 3 Packs (v2)

`plo4ReferenceDeviation` (`server/src/engine/plo4/Plo4LivePolicy.ts`) with `OMAHA_REFERENCE_DEVIATIONS` (`omaha-reference-deviations-v2`, `server/src/engine/plo4/Plo4PolicyPack.ts`), used by `evaluatePlo4LivePolicy` and `evaluateOmahaVariantPolicy`. The decision is the reference's, except at a table dealt exactly two seats with one live opponent, where a reference fold or check becomes:

- `heads_up_button_open`: button, first to act preflop, the controller's minimum raise;
- `heads_up_position_stab`: button, checked to on the turn or river, a pot-sized bet.

A wager the legal menu cannot hold retains the reference (never a call). Everything else, the big blind included, is `reference_retained`. Every safety gate, refusal, input binding, the 4 ms budget, the sampler and the river economics are unchanged; the receipts still record the equity sample and features. The same rules apply to all four packs, so nothing is tuned per variant. Pack versions: `plo4-policy-round3-v2`, `plo5-high-round3-v2`, `plo6-high-round3-v2`, `plo8-split-round3-v2`. The policy digests move with them, and the contract digests move only through the pack versions they read (PLO4 `83ab185b...f838`, Phase 11 `5b93ae20...57fc`); every other term of both locked contracts is unchanged.

## Development Result On The Final Source

Paired league, published 1/2 rake rows, bb/100 with 99% interval, 5,040 two-dealt pairs per seed (seed 3 was never probed by the counterfactual):

| Pack | Against the horse population, seeds 1, 2, 3    | Against the human-calibrated table, seeds 1, 2, 3 |
| ---- | ---------------------------------------------- | ------------------------------------------------- |
| PLO4 | +37.5 +/- 18.9; +40.3 +/- 17.1; +42.1 +/- 18.4 | +24.4 +/- 12.9; +30.5 +/- 16.6; +26.0 +/- 14.4    |
| PLO5 | +32.8 +/- 17.9; +33.3 +/- 21.8; +30.6 +/- 18.9 | +27.9 +/- 13.9; +26.6 +/- 15.2; +32.1 +/- 18.7    |
| PLO6 | +21.8 +/- 23.9; +10.7 +/- 19.7; +31.9 +/- 19.5 | +18.4 +/- 16.9; +19.1 +/- 12.9; +32.6 +/- 12.7    |
| PLO8 | +37.9 +/- 18.4; +38.1 +/- 19.1; +40.5 +/- 15.3 | +29.8 +/- 13.7; +16.9 +/- 13.4; +19.3 +/- 11.3    |

At four-dealt and six-max (seed 3, 1,440 pairs per profile against horses and 2,016 at the human-calibrated table) the arms are identical hand for hand: exactly 0. Attribution on the final source puts every rule positive in both populations (BB per firing; horses: button open +0.72 to +1.15, turn stab +1.28 to +3.16, river stab +1.57 to +4.77; human-calibrated: button open +0.74 to +1.07, turn stab +1.75 to +5.27, river stab +0.91 to +7.15 on 34 to 56 firings).

Pooled with equal weight over the five contract profiles (seed 3), the candidate minus the reference at the human-calibrated table is PLO4 +5.2 [+2.3, +8.1], PLO5 +6.4 [+2.7, +10.2], PLO6 +6.5 [+4.0, +9.1], PLO8 +3.9 [+1.6, +6.1] bb/100. The absolute after-rake result of the candidate there, the contract's condition (b) statistic, is PLO4 +34.8 [-62.7, +132.2], PLO5 -2.6 [-83.0, +77.7], PLO6 +44.9 [-41.3, +131.1], PLO8 +30.8 [-41.7, +103.3]: a development measurement on a few thousand hands, far from the 10,000 hands per profile and the adequate calibration a qualifying claim needs.

Against the horse population the expected primary estimate of each locked matrix is about one fifth of the two-dealt result (about +4 to +8 bb/100). At the matrix sizes the planned intervals and the interval trust checks hold: the two-dealt per-pair skewness is -0.4 to -5.1 (button offset -0.8 to -2.4), so every cell's Edgeworth term is at most 0.0005 against the 0.001 bound, and every cell without a deviation (the big blind, four-dealt, six-max) carries a zero difference with zero variance.

## Evaluation Contract For The Held-Out Runs (Committed Before Any Run It Governs)

- **Condition (a), the locked matrices, unchanged.** `PLO4_STRENGTH_CONTRACT` (`plo4-strength-contract-v1`) and `OMAHA_VARIANT_STRENGTH_CONTRACT` (`omaha-variant-strength-contract-v1`): every profile, held-out seed, pairs per shard, shard count, statistic, threshold, interval and trust check as committed; the digests move only through the pack versions they read (PLO4 `83ab185b...f838`, Phase 11 `5b93ae20...57fc`). Opponent population: the horse brain at the evaluated source with the production style mix; rake: the published 1/2 cash rows. Dispatched once on the merge commit `c8bfc617` (#6526): PLO4 [run 37824479137](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37824479137) and PLO8 [run 37824483446](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37824483446) at 2026-10-08T18:27Z, PLO5 [run 37837891124](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37837891124) and PLO6 [run 37837895674](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/37837895674) at 2026-10-08T20:14Z. Each pack's verdict is the real assembler's (`server/scripts/phase10-strength-assemble.mjs`, `server/scripts/phase11-strength-assemble.mjs`), recorded whatever it shows.
- **Seed disclosure.** The held-out seeds are the round-1 seeds. Only the committed cell-level aggregates of the round-1 held-out runs were read for the diagnosis; every rule was chosen and confirmed on development seeds before #6513 and #6526.
- **Condition (b), the winning contract, run once.** `server/src/scripts/omahaHumanCalibratedCheck.ts`, with the statistic, interval, gate and completeness of `server/src/benchmark/HumanCalibratedCheck.ts` (the Phase 12 check's, unchanged): every Phase 10 and Phase 11 cash contract profile (five per pack) through `withHumanCalibratedOpponents`, opponent population `human-calibrated-v1-20261008` in every non-hero seat, the held-out human seeds 19201101, 19202203 and 19203307, the strength league's deal and seat rotation, 3,456 hands per seed (six rotation blocks of 576; 10,368 hands per profile, at least the contract's 10,000), the candidate arm in the rotating hero seat at the profile's published rake (cap ladder and BBJ drop), and the reference arm on the same deals as context outside the gate. Statistic: the hero's net after rake in bb/100, equal weight per profile, two-sided 99% Wald interval; gate: lower bound above zero on an adequate calibration. It runs on the merge commit of the pull request that adds the script; the packs, leagues and policy digests there are those of `c8bfc617` (no file under `server/src/engine` or `server/src/benchmark` that plays a hand has changed since). The human-calibrated held-out seeds are dealt by nothing else, and every run is kept.
- **What a result can do.** The calibration is inadequate today (608 Omaha human seat-hands against 10,000, 5 accounts against 20, the most active account 68.5% of human seat-hands against 25%), so condition (b) reads **unavailable external input** for every pack whatever its interval, and no pack can qualify. Every selection stays `null`.

## Status

| Item                                                         | Status                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diagnosis of the round 1 losses                              | verified now (development seeds, above)                                                                                                                                           |
| `illegal_candidate` defect class gone                        | verified now (0 refusals on 176,256 development pairs; pinned by test)                                                                                                            |
| River economics used to choose actions                       | not applicable with reason: recorded only; it inherits the uncalibrated sampler range                                                                                             |
| Round 3 v2 beats the reference against the horse population  | implemented but unverified until the locked Phase 10 and Phase 11 matrices on the merged source are assembled                                                                     |
| Round 3 v2 beats the reference at the human-calibrated table | verified now as a development measurement only (above); not a qualifying claim                                                                                                    |
| Winning contract condition (b), qualifying                   | unavailable external input: the human calibration is inadequate (5 accounts, the most active 68.5% of human seat-hands, 608 Omaha human seat-hands), so no pack can qualify today |
| Selection                                                    | every selection stays `null`: no pack can meet condition (b)                                                                                                                      |
