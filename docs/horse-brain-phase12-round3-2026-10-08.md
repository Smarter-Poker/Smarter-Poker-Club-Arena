# Horse Brain Phase 12 Round 3: Making The Remaining-Variant Packs Win, October 8, 2026

Horse Brain only. Status vocabulary: verified now, historical only, implemented but unverified, defective, unavailable external input, not applicable with reason. Lane WIN-REMAINING of the Phases 6 to 15 finish (`docs/horse-brain-phases6-15-completion-plan-2026-09-17.md`). Owners: `server/src/engine/remainingVariants/*` and the Phase 12 authority, discard (P12-A) and net-action economics (P12-B) code.

**The owner's target.** A strategy upgrade goes live only if it beats the brain horses use today and wins after rake against the opponents horses actually face for money, the human players. Every measured claim below states its opponent population, rake model, sample size and 99% interval.

**Outcome of this record (written before any held-out run of round 3).** The round-1 packs lost to the reference on every locked matrix. Their losses have four named causes, read from the locked matrix cells and from development-seed attribution. Round 3 removes the causes at their source and keeps the one gain the round-1 packs had, and on the confirmation development seed every round-3 pack beats the current brain against the horse population after the published rake. The locked P12.2 matrices are re-run unchanged on the final source; their verdicts and the human-population check decide qualification. Every `PHASE12_PROTECTED_RELEASE_SELECTIONS` entry stays `null` until both pass.

## Measured Starting Point (Historical Only)

The locked P12.2 matrices of October 5, 2026 (`docs/horse-brain-phase12-closure-2026-10-05.md`, source `27174382`): opponent population the horse brain (`HorseLogic.decide`, production style mix, every seat Phase 12 off), the engine's published 1/2 cash rake (10%, cap 5.00, the seat-count cap ladder, BBJ drop where the variant has one), paired candidate minus reference net chips per hand.

| Pack            | Pairs     | Primary cash after rake, bb/100 (99% interval) | Worst cells (bb/100)                                       |
| --------------- | --------- | ---------------------------------------------- | ---------------------------------------------------------- |
| Short Deck      | 1,866,240 | -20.80 [-23.83, -17.77]                        | big blind -86.62, small blind -29.76, early position +30.7 |
| Crazy Pineapple | 3,032,640 | -24.86 [-27.51, -22.20]                        | big blind -90.84, small blind -31.67, early position +10.5 |
| FLH             | 544,320   | -7.75 [-8.59, -6.90]                           | big blind -13.91, small blind -9.38, button -6.18          |
| FLO8            | 411,264   | -4.79 [-5.75, -3.83]                           | big blind -8.24, early -3.30, button -2.89                 |

Street families (diagnostic, first divergence): every street loses in every pack; preflop is the largest share for Short Deck (-12.0), Pineapple (-8.0) and FLH (-5.3), the flop for FLO8 (-1.9) and Pineapple (-9.5).

## Diagnosis

**Method.** `p12r3-diagnose.mts.txt` (in `docs/evidence/phase12/round3/`) plays the real P12.2 league (`playPlo4PolicyHand`, the real `HandController`, `remainingVariantStrengthLeagueProfile`, the same deal seeds, buttons, hero seats, styles and mood clock as `runRemainingVariantStrengthShard`) on development seeds only and refuses every held-out seed of Phases 10 to 13. It wraps `HorseLogic.decide` and attributes each pair's candidate minus reference net chips to the hero's first applied candidate decision, which is where the two arms diverge (before it the arms are identical, seeded per action). No held-out hand was dealt for any of this.

**The round-1 packs on development seeds** (seeds 12101101 and 12102203, every contract profile, 12,960 pairs per profile and seed, FLO8 5,760): Short Deck -14.55 bb/100 [-24.75, -4.35] over 155,520 pairs, Pineapple -29.85 [-41.49, -18.21] over 155,520, FLH -6.79 [-8.16, -5.43] over 181,440, FLO8 -3.72 [-5.85, -1.60] over 80,640. This reproduces the locked verdicts, so the development seeds see the same losses.

**Cause 1, price-blind blind defence (all four packs).** The shared kernel `plo4PreflopChoice` defends with a fixed hand-shape bar that ignores the price, so the big blind folds hands the reference profitably defends. It is the largest single loss in every pack. Contribution to the pack mean on the development seeds (bb/100, 99% half-width, decisions): big blind defence where the reference calls and the pack folds, Short Deck -8.73 ±3.97 (10,964, -1.24 bb each), Pineapple -10.61 ±4.34 (7,986), FLH -2.50 ±0.60 (13,496), FLO8 -0.83 ±0.75 (3,934); where the reference three-bets and the pack only calls, Short Deck -2.60 ±1.52, Pineapple -1.19 ±1.60, FLH -0.24 ±0.12, FLO8 -0.21 ±0.08.

**Cause 2, line-blind postflop calls.** `RemainingVariantSampler` draws opponent holdings under a prior conditioned on preflop hand shape and action counts only, never on board contact, so the range of a player who bets is far too wide and the hero's sampled equity against it is overstated. Every street of calls the pack made against a bet the reference folded lost: Short Deck flop -3.66, turn -2.35, river -1.38 bb/100 (729 decisions; the big blind's flop calls -18.05 bb each); Pineapple flop -8.73, turn -4.26, river -1.50 (710 decisions); FLH -0.23, -0.58, -0.37 (912 decisions).

**Cause 3, line-blind value bets.** For the same reason the pack's own value bets lose: exploratory development run, seed 12101101, Short Deck turn value bets -8.49 bb each (102 decisions), river -3.04 (149); Pineapple turn -5.28, river -1.59.

**The one gain, and a reference leak.** First-in opens the reference makes from early, middle, cutoff and (three or more dealt) button positions with a hand below the pack's own open bar lose against this population; folding them wins: Short Deck early +3.57 ±2.67, middle +3.33 ±2.50, cutoff +1.02, button +1.23; Pineapple middle +3.58 ±2.66, early +1.63, cutoff +0.91, button +1.40 (seeds 12101101 and 12102203, round-1 pack). Heads-up the button fold is no gain (Short Deck +0.03 bb per decision; FLH -0.65, FLO8 -0.81, losses). In no limit the reference's flop bet into a checked pot also loses to checking it (round-1 pack: Short Deck button +0.76, cutoff +0.75).

## Round 3: A Delta On The Reference

Round 3 keeps the reference action everywhere it was measured to be worse. That removes causes 1 to 3 at their source: no price-blind defence bar, no line-blind sampled call, raise or value bet is ever substituted for the reference. It changes the decision only in declared spots, each a named property of the pack (`REMAINING_VARIANT_PACKS[variant].round3`, hashed in the Phase 12 policy digest):

| Rule                                                                                                                      | No limit (Short Deck, Pineapple)        | Fixed limit (FLH, FLO8)          |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------- |
| `openTighten`: first in, reference opens, quality below the pack's open bar: fold                                         | early, middle, cutoff, button; 3+ dealt | middle, cutoff, button; 3+ dealt |
| `flopCheckBelow`: checked to on the flop, reference bets, sampled equity below: check                                     | 0.95                                    | none                             |
| `headsUpOpenBelowBar`: heads-up button first in, reference does not open, quality at least bar minus: open                | none                                    | 0.15                             |
| `smallBlindStealBelowBar`: folded to the small blind, 3+ dealt, reference does not open, quality at least bar minus: open | none                                    | 0.2                              |
| `bigBlindDefendBelowCallBar`: big blind facing one raise, reference folds, quality at least call bar minus: call          | none                                    | 0.15                             |

Everything else is `round3_reference_retained`: the reference's own legal action, in the legalizer's form (`remainingVariantLegalForm`, idempotent on an already legal reference). Versions: `short-deck-round3-v1`, `crazy-pineapple-round3-v1`, `fixed-limit-holdem-round3-v1`, `fixed-limit-omaha8-round3-v1`. Budgets and gates are unchanged: the 4 ms live budget, the 2.5 ms sampling deadline, 32 samples, every eligibility refusal, the input binding, the P12-B river economics and the `illegal_candidate` guard. Pineapple discards stay with the existing chooser in both arms. Nothing is calibrated (`calibratedConfidence: null`).

**How the rules were chosen (development seeds only).** Seed 12101101 ran every candidate rule at once (open tightening in all four positions, a check below 0.95 equity on every street, value bets above 0.55, value raises above 0.6, folds of reference calls priced out), attributed per rule over 38,880 no-limit, 45,360 FLH and 20,160 FLO8 pairs: in no limit the flop check (Short Deck +5.23, Pineapple +16.87 bb/100) and the open tightening (+9.83, +13.08) won, while turn checks (-0.66, -0.79), river checks, turn and river value bets (Short Deck -2.71 and -1.98) and value raises did not; in fixed limit every postflop check lost (FLH flop -2.11, turn -1.11; FLO8 flop -3.10, turn -2.31), value bets and raises were within noise of zero, and only the open tightening won (FLH +1.19, FLO8 +0.28; by position, middle and cutoff gained while the heads-up button lost). Seed 12102203 tested the refined no-limit set (Short Deck +24.21 [+12.24, +36.18], Pineapple +26.89 [+12.71, +41.07] over 38,880 pairs each; big blind defence widening -0.18 and +1.39, not kept) and the fixed-limit preflop additions: heads-up button opens FLH +0.96 and FLO8 +0.29, small blind steals FLH +0.36 and FLO8 +0.16 (kept); cutoff steals FLH -1.64 and three-handed-plus button steals FLH -0.37 (dropped). Seed 12103307 then confirmed the final rules, untouched by the selection:

| Pack (seed 12103307, 6,480 pairs per profile, FLO8 2,880) | Pairs  | Paired mean bb/100 (99% interval) | By rule (bb/100)                                                    |
| --------------------------------------------------------- | ------ | --------------------------------- | ------------------------------------------------------------------- |
| Short Deck                                                | 38,880 | +14.65 [+3.06, +26.24]            | flop checks +9.62, open folds +5.03                                 |
| Crazy Pineapple                                           | 38,880 | +12.36 [-1.74, +26.45]            | flop checks +13.24, open folds -0.89                                |
| FLH                                                       | 45,360 | +3.22 [+1.77, +4.68]              | open folds +2.10, steals +0.57, heads-up opens +0.46, defence +0.10 |
| FLO8                                                      | 20,160 | +2.85 [+0.91, +4.78]              | open folds +2.67, steals +0.17, heads-up opens and defence +0.01    |

Every profile of every pack is positive on that seed (lowest: FLO8 six-max heads-up +0.08, FLO8 eight-max +0.14). The rules were explored with a development-only switch on a separate copy of the policy (`p12r3-experiment-policy.patch.txt`, never committed to source). The committed source was then run on the same confirmation seed and profiles: all 26 runs are identical to the experiment pair for pair, in every paired difference and every attributed rule (`dev-production-source-12103307.json`).

Evidence in `docs/evidence/phase12/round3/`: the diagnostic harness (`p12r3-diagnose.mts.txt`), its runner and summarizer (`p12r3-run-all.sh.txt`, `p12r3-summarize.py.txt`), the experiment switch (`p12r3-experiment-policy.patch.txt`), and one summary per run with every pack, profile and attributed rule: `dev-round1-candidate-12101101-12102203.json` (the round-1 packs, attributed by street, position, role and reference to candidate action), `dev-exp1-all-rules-12101101.json`, `dev-exp2-refined-12102203.json`, `dev-exp3-fixed-limit-12102203.json`, `dev-exp4-final-rules-12103307.json` and `dev-production-source-12103307.json`. Raw per-pair files are retained under `/Volumes/SmarterArchives/agent-evidence/horse-brain-finish-20261008/win-remaining/`.

## Evaluation Contract For Round 3 (Committed Before Any Held-Out Run)

- **Matrices:** the locked P12.2 matrices, unchanged: every profile, held-out seed, pairs per shard, shard count, regression margin (no limit -10, fixed limit -4 bb/100), planned gating cell, interval and trust check of `REMAINING_VARIANT_STRENGTH_CONTRACT` (`remaining-variant-strength-contract-v1`). Its digest moves only through the four pack versions it reads: replacing the round-3 versions with the round-1 ones in the contract JSON gives the round-1 digest `d85d7569…19f1` exactly; the new pinned digest is `fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0`.
- **Opponent population and rake:** the horse brain at the evaluated source, production style mix, the published 1/2 cash rake and BBJ rows, as in P12.2.
- **Seed disclosure:** the held-out seeds are the round-1 seeds. Only the committed cell-level aggregates of the round-1 held-out runs (`strength.json` per pack) were read for the diagnosis; no held-out hand, pair or shard result was read per hand, and every rule and threshold was chosen on development seeds and confirmed on a development seed before this record. Whatever the verdicts, they are recorded as measured; unfavourable runs are kept.
- **Human population:** a pack qualifies for selection only if it also wins after rake against the human-calibrated population (`docs/horse-brain-human-population-2026-10-08.md`, lane WIN-POP) under that lane's winning contract. At the time of writing that record is not on main: **unavailable external input**. Until it exists and the pack passes it, the pack's selection stays `null` whatever its horse-population verdict.
- **Selection path:** only through the P12.3 authority (`admitHorsePhase12ReleaseAuthority`): the qualification file shipped in the engine image, `PHASE12_PROTECTED_RELEASE_SELECTIONS` set in a reviewed PR, the engine release, then natural accepted use and the withdrawal path verified in production.

## Gate Statuses At This Commit

| Gate            | Status                      | Reason                                                                             |
| --------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| G1 Domain       | verified now (source tests) | Unchanged P12.2 domain; the round-3 rules apply inside it                          |
| G2 Inputs       | verified now (source tests) | Input binding unchanged; the policy digest classifies every runtime import         |
| G3 Calculation  | verified now (development)  | Round-1 losses reproduced and attributed; round-3 rules confirmed on seed 12103307 |
| G4 Authority    | verified now (source tests) | Every selection `null`; the `illegal_candidate` guard tested on round-3 changes    |
| G5 Actual use   | not applicable with reason  | Shadow only until a pack qualifies                                                 |
| G6 Outcomes     | implemented but unverified  | Locked matrices not yet run on this source                                         |
| G9 Promotion    | implemented but unverified  | Needs the matrix verdict and the human-population check                            |
| G10 Publication | implemented but unverified  | This PR; the engine release serves the round-3 packs in shadow                     |

Results of the locked matrices and the human-population check are recorded in the section below by the follow-up PR.

## Results

Pending: recorded by the results PR with run links, verdicts, cells and the selection decision.
