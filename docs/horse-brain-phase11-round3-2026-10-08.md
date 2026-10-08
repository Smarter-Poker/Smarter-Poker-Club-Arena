# Horse Brain Phase 10 And Phase 11, Round 3: Omaha Packs That Beat The Reference (October 8, 2026)

Horse Brain only. Scope: the Phase 10 PLO4 pack and the Phase 11 PLO5, PLO6 and PLO8 packs. Status words are the maintained vocabulary: verified now, historical only, implemented but unverified, defective, unavailable external input, not applicable with reason. Every measured claim names its opponent population, rake model, sample size and 99% interval. No held-out seed was used for anything in the diagnosis or the design; held-out seeds run only in the locked matrices named below.

The owner's target for every strategy upgrade: it beats the brain horses use today, and it wins after rake against the opponents horses actually face for money, the human players. Horse-versus-horse results alone are not the target.

## Starting Point

Closure records: [Phase 10](horse-brain-phase10-completion-2026-10-03.md), [Phase 11](horse-brain-phase11-closure-2026-10-05.md). Every pack lost to the reference on its locked held-out matrix (cash after rake, horse population, published 1/2 rake rows): PLO4 pooled -0.16 bb/100 with the two-dealt profile at -25.6; PLO5 -4.02 [-7.18, -0.86], PLO6 -4.91 [-7.92, -1.91], PLO8 -9.21 [-12.20, -6.23]. Every selection is `null`.

## Method (Development Seeds Only)

Two development tools, committed with this round and refusing every held-out seed:

- `server/src/scripts/omahaLeakDiagnose.ts`: plays the contract league's paired hands (the real `playPlo4PolicyHand`, the contract profile, production styles, published rake, mood clock) and attributes each pair's net difference to the hero's first applied change, where the arms diverge. It also counts HorseLogic's `illegal_candidate` refusals.
- `server/src/scripts/omahaCounterfactual.ts`: a one-step counterfactual of the reference brain. For each pair it plays the reference arm (pack in shadow, receipt recorded), picks one eligible hero decision, then replays the identical deal once per alternative at that decision (fold or check, call, half-pot wager, pot wager) with the reference everywhere else. The difference is Q(state, alternative) minus Q(state, reference) for that one decision.

Opponent population in every development run: the horse population as the locked contracts define it (every seat `HorseLogic.decide` with production styles, empty modifiers, fresh HorseMind, deterministic mood clock). Rake: the published 1/2 rows (`getFullRakeConfig`, player-count caps, BBJ drop where the variant has one). Development seeds: PLO4 10101101, 10102203, 10103307; PLO5, PLO6, PLO8 11101101, 11102203, 11103307. Evidence: `/Volumes/SmarterArchives/agent-evidence/horse-brain-finish-20261008/win-omaha/` (`diag1/`, `cf1/`, `cfhu/`, `cfpost/`, `v1/`, `v2hu/`, `v2ring/`, the analysis scripts `analyze2.py` and `acf.py`).

## Where The Round 1 Packs Lost

First-divergence attribution, round 1 source, 10,080 pairs per profile per variant on seeds 1 and 2:

- The losses start preflop. The packs replaced the reference's preflop with their own entry atlas. Heads-up they fold hands the reference plays profitably (PLO5 two-dealt: `preflop_entry_declined` raise to fold, 4,370 pairs, -0.52 BB per pair; PLO4 two-dealt: the button fold -0.42 BB and the big blind fold -0.95 BB per pair), and in every profile they open smaller than the reference (PLO4 `rfi` raise to a smaller raise: -1.2 to -2.8 BB per pair in all five profiles).
- Postflop, every call or raise the packs make is priced against `sampleOmahaVariantEquity`, 32 samples drawn from a public-line prior that escapes to a uniform hand after two rejections. Against a betting range this overstates the hand. The counterfactual shows it directly: at six-max, where the reference folds facing a bet, calling instead loses on every variant (PLO4 -10.00 +/- 2.82 BB per decision, n = 764; PLO5 -10.89 +/- 2.19, n = 638; PLO6 -12.17 +/- 4.39, n = 329; PLO8 -8.46 +/- 4.30, n = 244), including where the sampled equity clears the price (PLO5 facing a bet with sampled margin +0.1: call -19.67 +/- 11.90, n = 66).

## The Earlier Defect Class

The 2026-10-05 audit defect (candidate sizes the legalizer rewrites, `illegal_candidate` playing the reference) is fully gone on the round 3 source: 0 `illegal_candidate` refusals over every development pair counted on the final source (63,360 pairs: 40,320 two-dealt and 23,040 four-dealt and six-max, `v2hu/` and `v2ring/`); `OmahaLegalFormCandidates.test.ts` pins it on real heads-up league hands for all four packs.

## River Net-Chip Economics (#6444)

`omahaVariantActionEconomics` is computed after `finish` on the river and recorded on the receipt; it never chooses an action. It settles the same showdowns the sampler drew, so it inherits the sampler's unconditioned opponent range: using it to choose actions would repeat the postflop loss above. It stays recorded only, unchanged by this round.

## The Reference Is Close To Locally Optimal At Four And Six Dealt

One-step counterfactuals at four-dealt and six-max (40, 100 and 200 BB), all variants, about 4,000 to 7,700 probed decisions per variant and street class: no alternative beats the reference at 99% in any preflop class, and none postflop where the reference faces a bet. Of about 40 cells per variant, one is nominally positive (PLO4 checked-to, where the reference bets, a half-pot bet +1.58 +/- 1.18 BB), which is what chance gives across that many cells and did not replicate on the other variants (PLO5 +0.46, PLO6 -0.44, PLO8 +1.20, none significant). No ring deviation is made.

## The Actions That Beat The Reference

Heads-up, the same three actions beat the reference on every variant (counterfactual, seeds 1 and 2, two-dealt profile; BB per decision, 99% interval):

| Spot (the reference folds or checks) | Alternative   | PLO4                                           | PLO5                       | PLO6                     | PLO8                     |
| ------------------------------------ | ------------- | ---------------------------------------------- | -------------------------- | ------------------------ | ------------------------ |
| Button, first to act preflop         | minimum raise | +0.62 +/- 0.33 (n = 3,157, quality 0.1 to 0.2) | +0.69 +/- 0.34 (n = 3,736) | +0.49 +/- 0.99 (n = 496) | +0.77 +/- 0.71 (n = 660) |
| Big blind facing the button's raise  | pot three-bet | +0.51 +/- 0.99 (n = 2,232, quality 0.1 to 0.2) | +1.88 +/- 0.78 (n = 3,501) | +2.28 +/- 2.11 (n = 508) | +0.72 +/- 1.77 (n = 415) |
| Button checked to, river             | pot bet       | +4.92 +/- 3.50 (n = 158)                       | +3.21 +/- 2.52 (n = 188)   | (too few)                | (too few)                |
| Button checked to, turn              | pot bet       | +4.59 +/- 3.10 (n = 121)                       | +1.79 +/- 2.30 (n = 141)   | (too few)                | (too few)                |

Each is standard heads-up practice, not a read of the horse brain: open the button, defend the big blind by three-betting rather than folding, and bet in position when checked to late in the hand. The rule set is one shared kernel with the same rules for all four packs, so nothing is tuned per variant.

## The Round 3 Packs

`plo4ReferenceDeviation` (`server/src/engine/plo4/Plo4LivePolicy.ts`) with `OMAHA_REFERENCE_DEVIATIONS` (`omaha-reference-deviations-v1`, `server/src/engine/plo4/Plo4PolicyPack.ts`), used by `evaluatePlo4LivePolicy` and `evaluateOmahaVariantPolicy`. The decision is the reference's, except at a table dealt exactly two seats with one live opponent, where a reference fold or check becomes:

- `heads_up_button_open`: button, first to act preflop, the controller's minimum raise;
- `heads_up_big_blind_three_bet`: big blind facing one raise, a pot-sized three-bet;
- `heads_up_position_stab`: button, checked to on the turn or river, a pot-sized bet.

A wager the legal menu cannot hold retains the reference (never a call). Everything else is `reference_retained`. Every safety gate, refusal, input binding, the 4 ms budget, the sampler and the river economics are unchanged; the receipts still record the equity sample and features. Pack versions: `plo4-policy-round3-v1`, `plo5-high-round3-v1`, `plo6-high-round3-v1`, `plo8-split-round3-v1`; the policy digests move with them, and the contract digests move only through the pack versions they read (PLO4 `ffe57964...0cf1`, Phase 11 `586e4706...d72b`; every other term of both locked contracts is unchanged).

## Development Result On The Final Source

Paired league, horse population, published 1/2 rake rows, bb/100 with 99% interval:

| Pack | Two-dealt, learning seeds (5,040 pairs each, pairs 20,160 on) | Two-dealt, seed 3 (never probed; 10,080 pairs) | Four-dealt and six-max, seed 3 (1,440 pairs per profile) |
| ---- | ------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| PLO4 | +39.6 [+11.7, +67.4]; +43.5 [+14.5, +72.6]                    | +47.2 [+25.4, +69.0]                           | exactly 0 in all four profiles                           |
| PLO5 | +41.3 [+7.1, +75.5]; +51.9 [+17.9, +85.9]                     | +61.7 [+39.5, +83.8]                           | exactly 0                                                |
| PLO6 | +58.8 [+23.5, +94.1]; +60.8 [+25.6, +95.9]                    | +44.2 [+20.9, +67.6]                           | exactly 0                                                |
| PLO8 | +62.7 [+34.1, +91.4]; +57.1 [+27.5, +86.7]                    | +65.0 [+44.3, +85.7]                           | exactly 0                                                |

The contracts pool five profiles with equal weight, so the expected primary estimate is about one fifth of the two-dealt result: about +8 to +13 bb/100. First-divergence attribution on seed 3 puts every rule positive on every variant (BB per firing: button open +0.72 to +1.21, big blind three-bet +0.99 to +1.77, river stab +1.74 to +3.27, turn stab +0.57 to +3.13). The four-dealt and six-max arms are identical hand for hand, so those cells carry a zero difference with zero variance, which the contracts' interval treats as trusted (skewness 0); the two-dealt per-pair skewness (-2.6 to +1.5) keeps every pooled cell's Edgeworth term inside the 0.001 bound at the planned sizes.

## Status

| Item                                                          | Status                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Diagnosis of the round 1 losses                               | verified now (development seeds, above)                                                             |
| `illegal_candidate` defect class gone                         | verified now (0 refusals on 63,360 development pairs; pinned by test)                               |
| River economics used to choose actions                        | not applicable with reason: recorded only; it inherits the uncalibrated sampler range               |
| Round 3 packs beat the reference against the horse population | implemented but unverified until the locked Phase 10 and Phase 11 matrices run on the merged source |
| Winning after rake against the human population               | implemented but unverified until the human-calibrated population check runs                         |
| Selection                                                     | every selection stays `null` until both criteria pass under the committed contracts                 |
