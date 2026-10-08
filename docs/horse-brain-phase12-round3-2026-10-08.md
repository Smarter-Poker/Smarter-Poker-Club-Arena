# Horse Brain Phase 12 Round 3: Making The Remaining-Variant Packs Win, October 8, 2026

Horse Brain only. Status vocabulary: verified now, historical only, implemented but unverified, defective, unavailable external input, not applicable with reason. Lane WIN-REMAINING of the Phases 6 to 15 finish (`docs/horse-brain-phases6-15-completion-plan-2026-09-17.md`). Owners: `server/src/engine/remainingVariants/*` and the Phase 12 authority, discard (P12-A) and net-action economics (P12-B) code.

**The owner's target.** A strategy upgrade goes live only if it beats the brain horses use today and wins after rake against the opponents horses actually face for money, the human players; horse-versus-horse results are not the target. Every measured claim below states its opponent population, rake model, sample size and 99% interval. The two populations used are the horse population (`HorseLogic.decide` at the evaluated source, production style mix, the P12.2 league) and the human-calibrated population `human-calibrated-v1-20261008` of the winning contract addendum (`docs/horse-brain-winning-contract-2026-10-08.md`, #6515), both at the engine's published 1/2 cash rake, cap ladder and BBJ drop.

**Outcome of this record (written before any held-out run of round 3).** The round-1 packs lost to the reference on every locked matrix; the losses have three named causes, removed at their source by making each pack a delta on the reference. Round 3 changes the decision only in declared preflop spots that won against both populations on development seeds. Two horse-only exploits that won against horses were measured to lose against the human-calibrated population and were removed. The locked P12.2 matrices are re-run unchanged on the final source; their verdicts decide condition (a). Condition (b) of the winning contract is unavailable external input today (5 human accounts), so every `PHASE12_PROTECTED_RELEASE_SELECTIONS` entry stays `null`.

## Measured Starting Point (Historical Only)

The locked P12.2 matrices of October 5, 2026 (`docs/horse-brain-phase12-closure-2026-10-05.md`, source `27174382`), horse population, published rake, paired candidate minus reference net chips per hand:

| Pack            | Pairs     | Primary cash after rake, bb/100 (99% interval) | Worst cells (bb/100)                                       |
| --------------- | --------- | ---------------------------------------------- | ---------------------------------------------------------- |
| Short Deck      | 1,866,240 | -20.80 [-23.83, -17.77]                        | big blind -86.62, small blind -29.76, early position +30.7 |
| Crazy Pineapple | 3,032,640 | -24.86 [-27.51, -22.20]                        | big blind -90.84, small blind -31.67, early position +10.5 |
| FLH             | 544,320   | -7.75 [-8.59, -6.90]                           | big blind -13.91, small blind -9.38, button -6.18          |
| FLO8            | 411,264   | -4.79 [-5.75, -3.83]                           | big blind -8.24, early -3.30, button -2.89                 |

## Diagnosis

**Method.** `p12r3-diagnose.mts.txt` (in `docs/evidence/phase12/round3/`) plays the real P12.2 league (`playPlo4PolicyHand`, the real `HandController`, `remainingVariantStrengthLeagueProfile`, the same deal seeds, buttons, hero seats, styles and mood clock as `runRemainingVariantStrengthShard`) on development seeds only, refuses every held-out seed of Phases 10 to 13 and of the human-calibrated contract, and attributes each pair's candidate minus reference net chips to the hero's first applied candidate decision, where the two arms diverge. `p12r3-human-calibrated.mts.txt` is the same harness with every non-hero seat replaced by the human-calibrated population (`withHumanCalibratedOpponents`). No held-out hand was dealt for any of this.

**The round-1 packs on development seeds** (horse population, seeds 12101101 and 12102203, every contract profile, 12,960 pairs per profile and seed, FLO8 5,760): Short Deck -14.55 bb/100 [-24.75, -4.35] over 155,520 pairs, Pineapple -29.85 [-41.49, -18.21] over 155,520, FLH -6.79 [-8.16, -5.43] over 181,440, FLO8 -3.72 [-5.85, -1.60] over 80,640, reproducing the locked verdicts.

**Cause 1, price-blind blind defence (all four packs).** The shared kernel `plo4PreflopChoice` defends with a fixed hand-shape bar that ignores the price, so the big blind folds hands the reference profitably defends. It is the largest single loss in every pack. Contribution to the pack mean (bb/100, 99% half-width, decisions): big blind defence where the reference calls and the pack folds, Short Deck -8.73 ±3.97 (10,964, -1.24 bb each), Pineapple -10.61 ±4.34 (7,986), FLH -2.50 ±0.60 (13,496), FLO8 -0.83 ±0.75 (3,934); where the reference three-bets and the pack only calls, Short Deck -2.60 ±1.52, Pineapple -1.19 ±1.60, FLH -0.24 ±0.12, FLO8 -0.21 ±0.08.

**Cause 2, line-blind postflop calls.** `RemainingVariantSampler` draws opponent holdings under a prior conditioned on preflop hand shape and action counts only, never on board contact, so a bettor's range is far too wide and the hero's sampled equity against it is overstated. Every street of calls the pack made against a bet the reference folded lost: Short Deck flop -3.66, turn -2.35, river -1.38 bb/100 (729 decisions; the big blind's flop calls -18.05 bb each); Pineapple flop -8.73, turn -4.26, river -1.50 (710); FLH -0.23, -0.58, -0.37 (912).

**Cause 3, line-blind value bets.** For the same reason the pack's own value bets lose (seed 12101101, all rules on): Short Deck turn value bets -8.49 bb each (102 decisions), river -3.04 (149); Pineapple turn -5.28, river -1.59.

## Round 3: A Delta On The Reference

Round 3 keeps the reference action everywhere it was measured to be worse. That removes causes 1 to 3 at their source: no price-blind defence bar, no line-blind sampled call, raise or value bet is substituted for the reference, and every postflop decision is the reference's (the sampled equity is still bound, recorded and priced by P12-B; it decides nothing). The pack changes the decision only in these declared preflop spots, each a property of the pack (`REMAINING_VARIANT_PACKS[variant].round3`, hashed in the Phase 12 policy digest):

| Rule                                                                                                                               | Short Deck, Pineapple | FLH, FLO8              |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------- |
| `openTighten`: first in, 3+ dealt, reference opens, quality below the pack's open bar: fold                                        | none                  | middle, cutoff, button |
| `headsUpOpenBelowBar`: heads-up button first in, reference does not open, quality at least the open bar minus: open                | 0.15                  | 0.15                   |
| `smallBlindStealBelowBar`: folded to the small blind, 3+ dealt, reference does not open, quality at least the open bar minus: open | none                  | 0.2                    |
| `bigBlindDefendBelowCallBar`: big blind facing one raise, reference folds, quality at least the call bar minus: call               | 0.15                  | 0.15                   |

Everything else is `round3_reference_retained`: the reference's own legal action, in the legalizer's form (`remainingVariantLegalForm`, idempotent on an already legal reference). Versions: `short-deck-round3-v1`, `crazy-pineapple-round3-v1`, `fixed-limit-holdem-round3-v1`, `fixed-limit-omaha8-round3-v1`. Budgets and gates are unchanged: the 4 ms live budget, the 2.5 ms sampling deadline, 32 samples, every eligibility refusal, the input binding, the P12-B river economics and the `illegal_candidate` guard. Pineapple discards stay with the existing chooser in both arms. Nothing is calibrated (`calibratedConfidence: null`).

## How The Rules Were Chosen (Development Seeds Only)

**Against horses.** Seed 12101101 ran every candidate rule at once (open tightening in four positions, a check below 0.95 sampled equity on every street, value bets above 0.55, value raises above 0.6, folds of reference calls priced out), attributed per rule over 38,880 no-limit, 45,360 FLH and 20,160 FLO8 pairs: in no limit the flop check (Short Deck +5.23, Pineapple +16.87 bb/100) and the open tightening (+9.83, +13.08) won, while turn checks (-0.66, -0.79), river checks, turn and river value bets (Short Deck -2.71 and -1.98) and value raises did not; in fixed limit every postflop check lost (FLH flop -2.11, turn -1.11; FLO8 flop -3.10, turn -2.31) and only the open tightening won (FLH +1.19, FLO8 +0.28; the heads-up button fold lost). Seed 12102203 added the fixed-limit preflop rules: heads-up button opens FLH +0.96 and FLO8 +0.29, small blind steals FLH +0.36 and FLO8 +0.16 (kept); cutoff steals FLH -1.64 and three-handed-plus button steals FLH -0.37 (dropped). Seed 12103307 confirmed that set: Short Deck +14.65 [+3.06, +26.24], Pineapple +12.36 [-1.74, +26.45], FLH +3.22 [+1.77, +4.68], FLO8 +2.85 [+0.91, +4.78] bb/100 (6,480 pairs per profile, FLO8 2,880).

**Against the human-calibrated population, the no-limit exploits fail.** The same rules against `human-calibrated-v1-20261008` (seeds 12101101 and 12103307, every contract profile, the winning contract's statistic: equal weight per profile, two-sided 99% normal interval): Short Deck -69.54 [-84.22, -54.85] and Pineapple -54.61 [-73.91, -35.30] bb/100 against the reference, with losses in every no-limit rule (Short Deck flop checks on the button -17.23, big blind -10.89, early opens folded -12.14; Pineapple early opens folded -26.61, button flop checks -14.79). Against horses, which defend and continue too widely, a tight open and a flop check win; against players who fold and limp more, they forfeit pots. They exploit horse-versus-horse play and are not upgrades, so they were removed. The fixed-limit rules gained against both populations: FLH +1.20 [+0.32, +2.09], FLO8 +1.08 [+0.14, +2.01].

**No-limit rules that win against both.** The fixed-limit preflop rules were tried in no limit against both populations, horse / human paired bb/100: seed 12101101 Short Deck +0.41 / +2.39, Pineapple +3.83 / +8.58; seed 12102203 Short Deck -0.59 / +2.73, Pineapple -0.66 / +5.57. By rule over the two seeds, the heads-up button open (Short Deck -0.33, +0.04 / +1.11, +1.98; Pineapple +0.48, -0.06 / +7.76, +7.64) and the big blind defence (Short Deck +0.83, -0.18 / +1.10, +0.92; Pineapple +1.79, +1.13 / +0.71, -1.20) were kept; the small blind steal lost against horses on the second seed (Short Deck -0.45, Pineapple -1.74) and was dropped. Wider offsets (0.25, 0.3, 0.25 on seed 12102203: Short Deck -1.05 / +5.33, Pineapple +0.43 / +6.93) gained nothing against horses and were not kept.

**Final rules on the confirmation seed 12103307** (6,480 pairs per profile, every contract profile, paired against the reference; the fixed-limit human-calibrated figures pool seeds 12101101 and 12103307):

| Pack            | Horse population, bb/100 (99%) | Human-calibrated, bb/100 (99%) | Human-calibrated, candidate absolute after rake |
| --------------- | ------------------------------ | ------------------------------ | ----------------------------------------------- |
| Short Deck      | +1.40 [-1.29, +4.09]           | +1.55 [-1.62, +4.72]           | +381.43 [+321.12, +441.75]                      |
| Crazy Pineapple | +1.77 [-2.41, +5.95]           | +7.63 [-0.39, +15.64]          | +638.29 [+549.60, +726.97]                      |
| FLH             | +3.22 [+1.77, +4.68]           | +1.20 [+0.32, +2.09]           | +5.31 [+1.14, +9.49]                            |
| FLO8            | +2.85 [+0.91, +4.78]           | +1.08 [+0.14, +2.01]           | -13.57 [-18.15, -8.99]                          |

Every point estimate is positive against both populations. The no-limit intervals on 38,880 pairs include zero; the locked matrices deal 48 (Short Deck) and 78 (Pineapple) times as many pairs, and only the few pairs a declared spot changes carry any variance. The human-calibrated absolute numbers measure a calibration the winning contract itself declares inadequate (5 accounts), so they steer development and are not evidence of real human win rates: they say no-limit horses take a great deal from that population with either brain, FLH horses win after rake, and FLO8 horses lose after rake with either brain (reference -14.65 [-19.32, -9.98]).

**The committed source is what was measured.** The rules were explored with a development-only switch on a separate copy of the policy (`p12r3-experiment-policy.patch.txt`, never committed to source). The committed source was run on the confirmation seed and profiles against the horse population; its runs are identical to the experiment pair for pair, in every paired difference and every attributed rule (`dev-production-source-12103307.json`).

## Evaluation Contract For Round 3 (Committed Before Any Held-Out Run)

- **Condition (a), the locked P12.2 matrices, unchanged:** every profile, held-out seed, pairs per shard, shard count, regression margin (no limit -10, fixed limit -4 bb/100), planned gating cell, interval and trust check of `REMAINING_VARIANT_STRENGTH_CONTRACT` (`remaining-variant-strength-contract-v1`). Its digest moves only through the four pack versions it reads: replacing the round-3 versions with the round-1 ones in the contract JSON gives the round-1 digest `d85d7569…19f1` exactly; the new pinned digest is `fafbba8dc23ebc59b5aadf78fdcc47cd6f504baf9bcd10b07970ad7fbea501c0`. Opponent population: the horse brain at the evaluated source, production style mix; rake: the published 1/2 cash rows.
- **Seed disclosure:** the held-out seeds are the round-1 seeds. Only the committed cell-level aggregates of the round-1 held-out runs (`strength.json` per pack) were read for the diagnosis; no held-out hand, pair or shard result was read per hand, and every rule and threshold was chosen on development seeds and confirmed on a development seed before this record. Whatever the verdicts, they are recorded as measured; unfavourable runs are kept.
- **Condition (b), the winning contract:** a pack qualifies only if its after-rake win rate against the human-calibrated population has a 99% lower bound above zero on the contract's held-out human seeds and the calibration is adequate. The calibration is not adequate today: **unavailable external input** for every pack. The human-calibrated held-out seeds are not dealt here; the development measurements above steer only.
- **Selection path:** only through the P12.3 authority (`admitHorsePhase12ReleaseAuthority`): the qualification file shipped in the engine image, `PHASE12_PROTECTED_RELEASE_SELECTIONS` set in a reviewed PR, the engine release, then natural accepted use and the withdrawal path verified in production. Not reachable while (b) is unavailable.

## Gate Statuses At This Commit

| Gate            | Status                      | Reason                                                                                                     |
| --------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| G1 Domain       | verified now (source tests) | Unchanged P12.2 domain; the round-3 rules apply inside it                                                  |
| G2 Inputs       | verified now (source tests) | Input binding unchanged; the policy digest classifies every runtime import                                 |
| G3 Calculation  | verified now (development)  | Round-1 losses reproduced and attributed; round-3 rules positive against both populations on seed 12103307 |
| G4 Authority    | verified now (source tests) | Every selection `null`; the `illegal_candidate` guard tested on round-3 changes                            |
| G5 Actual use   | not applicable with reason  | Shadow only; no pack can qualify while condition (b) is unavailable                                        |
| G6 Outcomes     | implemented but unverified  | Locked matrices not yet run on this source                                                                 |
| G9 Promotion    | unavailable external input  | Condition (b) needs an adequate human calibration                                                          |
| G10 Publication | implemented but unverified  | This PR; the engine release serves the round-3 packs in shadow                                             |

## Evidence

In `docs/evidence/phase12/round3/`: the harnesses (`p12r3-diagnose.mts.txt`, `p12r3-human-calibrated.mts.txt`), the runner and summarizers (`p12r3-run-all.sh.txt`, `p12r3-summarize.py.txt`, `p12r3-human-calibrated-summarize.py.txt`), the experiment switch (`p12r3-experiment-policy.patch.txt`), and one summary per run with every pack, profile and attributed rule: `dev-round1-candidate-12101101-12102203.json`, `dev-exp1-all-rules-12101101.json`, `dev-exp2-refined-12102203.json`, `dev-exp3-fixed-limit-12102203.json`, `dev-exp4-horse-rules-12103307.json`, `dev-human-calibrated-horse-rules-12101101-12103307.json`, `dev-no-limit-preflop-horse-12101101.json`, `dev-no-limit-preflop-human-12101101.json`, `dev-no-limit-preflop-horse-12102203.json`, `dev-no-limit-preflop-human-12102203.json`, `dev-no-limit-preflop-wider-horse-12102203.json`, `dev-no-limit-preflop-wider-human-12102203.json`, `dev-final-no-limit-horse-12103307.json`, `dev-final-no-limit-human-12103307.json` and `dev-production-source-12103307.json`. The human-calibrated runs were made on a scratch tree (never pushed) of this branch's first commit `096708dd` with the WIN-POP population (`56325d06`, #6515) and its whole-stack call fix (`a96361cf`, #6505) merged, and a development-only switch over the round-3 rules (`p12r3-human-calibrated-switch.patch.txt`); without that engine fix the six-handed no-limit human-calibrated hands did not complete. Raw per-pair files are retained under `/Volumes/SmarterArchives/agent-evidence/horse-brain-finish-20261008/win-remaining/`.

## Results

Pending: recorded by the results PR with run links, verdicts, cells and the selection decision.
