# 2026-09-02 — horse brain audit, phase 2: the games are different games (V35)

Dan: "ALL THE LOGIC NEEDS TO BE DIFFERENT FOR EACH GAME, NLH, PLO, PLO4, PLO5,
PLO6, PLO8o, SHORT DECK, PINEAPPLE ... AND UNDERSTANDS THE DIFFERENCE BETWEEN
CASH GAME STRATEGY AND TOURNAMENT STRATEGY."

## What differentiates the games today (verified, line by line)

`variantInfo()` gives every decision hole count, Omaha, hi-lo, short deck, pot
limit and (new) fixed limit. Strength is scored per variant
(`holdemPreflopScore` with short-deck terms, `omahaPreflopScore` with the
hi-lo low bonus and the plo5/plo6 hole-count shift, `pineapplePreflopScore`),
then mapped onto one ladder by quantile so a bar picks the same QUALITY of
hand in every game. Postflop: Monte Carlo equity per variant (Omaha 2+3,
short-deck rankings, hi-lo split with scoop/quarter atoms), Omaha nut
discipline (which flush, which straight, whose boat), Omaha draw quality,
plo5/plo6 small-ball sizing and multiway tightening, plo8 low-only draw
discipline, the short-deck value/draw overlays, NLH nut status and the NLH
solver layers, PLO tournament commitment zone and reshove.

Cash vs tournament: explicit `gameMode`, antes and the real orbit cost,
Harrington M-zones, push/fold + the PioSolver charts, Malmuth-Harville ICM
from live stacks and payouts, bubble / final-table / heads-up adjustments,
PKO and mystery-bounty pricing, the blind clock, rake in cash only, deep-stack
cash discipline, tournament open sizing. All present and wired.

## What was NOT different, and is now

### Every variant played hold'em preflop frequencies

The quantile map made the bars mean the same rank in every game — and the
same FREQUENCY. Probe, before this change: PLO4, PLO6, PLO8, short deck and
pineapple all opened the button 41-43%, all folded the big blind 46-49% to a
button open, all 3-bet 7-9%. The V8 overlay even TIGHTENED Omaha by 3%. PLO
plays more hands than hold'em, not fewer; PLO 3-bets are narrower (AAxx and
premium double-suited), not the same; 6+ opens and defends far wider; fixed
limit wider still and bluffs almost never.

`HorseVariantProfile.ts` is one row per game — preflop bar shifts (open,
3-bet, 4-bet, cold call, blind defence) and postflop temperament (bluff,
slowplay, check-raise, call-down) — applied in `HorsePreflop` and the V8
overlay. Hold'em is the zero row, so every existing hold'em pin is untouched.
PLO4/5/6 no longer share one bluff trim: the volume falls with every card.
Fixed limit (flh, flo8) gets the overlay it never had.

### Pineapple was scored with all three cards to the river

`simulateEquity` evaluated a pineapple flop hand as best five of EIGHT. One
card is thrown away before the turn; the honest read is the best two-card
keep, for hero and for every opponent. `scoreBestTwoOfThree` does that (three
evaluations of seven cards, flop only). A 5-6-7 on 8-9-2 read as a made
straight; it is a draw.

### Hold'em solver cells were answering pineapple and fixed-limit hands

After the discard a pineapple hand holds two cards, so it passed the V29/V30/
V32 gates and was answered from hold'em cells whose ranges assume two dealt
cards. Fixed limit has no bet size to read and no jam for the V27 charts.
All solver gates now require `holeCount === 2 && !isFixedLimit`.

### Tournament 3-bets were cash-sized

A 3.8x 3-bet from a 30bb stack is a third of it. At 40bb or less a tournament
3-bet is half a unit smaller (2.5x IP / 3.3x OOP), the sizes solver MTT
ranges use at those depths.

## Solver coverage, stated honestly

`solved_spots_gold.game_type` statistics (2026-09-02): spin, mtt_icm,
mtt_chipev, cash, hu_cash and their 3/6/9-max and HU variants — 100% hold'em.
There is no PLO, PLO8, short deck or pineapple solver data on the platform.
Those games are decided by Monte Carlo equity against read ranges, the nut
discipline layers and the variant profiles above. A PLO or 6+ export, when it
exists, belongs in a store like `GtoPostflop`, never in a heuristic file.

## Tests

`HorseV35Variants.test.ts` (13 pins). Full horse/GTO suites green.
