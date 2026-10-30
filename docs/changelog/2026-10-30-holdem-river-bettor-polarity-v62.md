# Hold'em river bettor polarity (V62): the range model behind the river call

**Date:** 2026-10-30
**Scope:** `server/src/engine/HorseEval.ts`, `HorseMind.ts`, `HorseLogic.ts`,
`HorseDataLedger.ts`; test `HorseRiverBettorPolarity.test.ts`; the
exploit-neutrality corpus keeps an explicit off arm.
**Option:** `v62RiverBettorPolarity` (default on; `false` is the historical arm).
**Receipt:** `v62_river_bettor_polarity`.

## What was wrong

Checklist item 13 asked for the range model behind a Hold'em river call. V61
(#8705) is a price shade on top of whatever read the V38 verdict is handed; it
is not the model. The model was the V12/V16 contact sampler: a river bettor's
hand was rejection-sampled toward "connects with the board" (category 2, any
pair; two pair for a big bet) with a bounded number of tries inside the
preflop band. Two things follow on the river:

1. a middle pair or a weak top pair is contact, but a river bettor seldom
   holds one at half a pot or more - a river wager is value that expects to
   be paid, or a bluff;
2. on a dry board most of a band is air, and the bounded tries left much of
   that air in the sampled range, where it never bets.

Measured offline against the sampler at 4,000 samples (band top ~40%, bettor
three streets, 0.75 pot on the river): top pair top kicker on K-9-7-6-2 with
three hearts read **85%** equity; top pair weak kicker **65%**; an overpair
on T-9-8-7-2 **44%**. Those reads are why one-pair river calls won 14-22% in
production against prices demanding 20-40% (the V61 measurement).

## What changed

When single-board Hold'em hero faces a river wager from an opponent whose
exploit read does not say they over-bluff (`callDownMod <= 1`), HorseLogic
marks that opponent's postflop read `riverPolar` (HorseMind now records
`lastStage`, the newest street they bet or raised). For a marked opponent the
sampler builds one index per call of every two-card combo inside their band
that is still possible (hero's cards, the board and known dead cards
excluded), bucketed by `v62ValueClass`: two pair or better made by the hole
cards, top pair / an overpair, a weaker pair, no pair. Each sample then draws
a target stratum and places a hand from it exactly:

| size class | bluff share | value mix: two pair+ / top pair / weaker pair |
| ---------- | ----------- | --------------------------------------------- |
| small (< 0.4 pot) | 0.25 | 0.35 / 0.45 / 0.20 |
| medium (0.4-0.7) | 0.22 | 0.55 / 0.38 / 0.07 |
| large (>= 0.7, a big bet, or any river raise) | 0.18 | 0.75 / 0.22 / 0.03 |

The bluff shares sit a little above the measured pool (one-pair calls won
17-18 / 21-22 / 14% by size class) so a credible mix is still called down; the
value mix is the prior that a large wager is mostly two pair or better and a
small one is often merged. A stratum the board cannot make falls to the
nearest made class, never to air. A collision with cards already dealt to
another opponent keeps the contact-sampled hand. The index costs ~0.6 ms per
decision and the sampler ~1.6 ms more at 1,000 samples, river only.

Same probe after the change: TPTK on K-9-7-6-2hhh vs 0.75 pot **38%**
(price 30%; with the V61 shade on top it folds), TPWK **23%** (fold),
overpair JJ on T-8-5-3-2 **32%**, two pair K7 on K-7-2-4-9 **61%** (call),
set **89%**, middle pair **20%** (fold); facing a third of the pot, TPTK
**66%**, TPWK **44%**, middle pair **35%** (all calls at a 25% price). A
river raise reads as the large class, which covers the `river_raise_paidoff`
leak (horse bets, is raised, pays off: -1,275 vs +366 won in human-seated
cash) through the same model.

The committed branch's V21 scare margin (+5 points of required equity on a
runout that completed a draw hero does not hold) is not added when V62 has
conditioned the bettor: the polar value stratum already carries the completed
draws, and adding both folded a top-pair call-once at 32.7% against a 34.8%
bar (`HorseHeadsUpCommitment` river case) that is 29.8% without the double
count. The V38 verdict path keeps its small `dangered` respect shift.

Not in scope: Omaha, short deck, fixed limit, multiple boards and bomb pots
keep their own sampling; a measured over-bluffer keeps the full contact
range; the decision above the verdict (value raise, V51 flat, V54) is
unchanged except through the equity it reads. V61 (#8705) yields to this model: when
the bettor was sampled polar the price shade is withheld in both the verdict
path and the committed branch (stacking both folded a top-pair call-once
against a river raise at 32.7% versus a 35.1% bar), and V61 keeps every path
V62 cannot reach - no opponent reads, `mind: false`, the V62 off arm.

## Interaction with recorded corpora

The exploit-neutrality corpus carries `v62RiverBettorPolarity: false` like
V57/V60. The tournament corpus digests, the captured Phase 8 replays and the
journal review fixtures decide with `mind: false`, which builds no opponent
reads, so V62 cannot engage there and they need no arm.

## Re-recorded golden

`HorseV54RiverBluff.golden.json` pins that the V54 flag is inert when off by
digesting the brain's river decisions, RNG trail included. Its one spot that
faces a river bet in Hold'em (`nlh_air_facing_bet`, hero air) decides through
the V62 sampler now, which consumes RNG differently: the 24 recorded seeds
still split 20 folds / 4 all-in bluff-raises, at different seeds. That entry
alone is re-recorded from the V62 brain, the same way #8456 re-recorded the
file; the other 27 entries are byte-identical and the V54 flag-off test still
passes against them.

## Verification

`HorseRiverBettorPolarity.test.ts`: classification, size class, target shares
and fallback order, the per-call index (dead cards excluded, two pair present
inside a band on a dry board), sampler equity shape (bluff-catch read for top
pair at a large size, less polar at a small size, set still ahead, worse pair
behind, raise = large, inert before the river or without the mark), and the
decision: TPTK facing 0.75 pot folds through the V38 verdict with the receipt
while the off arm calls; tournaments and a set fire alike; Omaha, short deck
and an over-bluffer do not. Server compiler clean; the engine and services
suites were run before the PR was opened (result recorded in the PR).

Activation follows the daily 04:00 America/Chicago engine cutover.
