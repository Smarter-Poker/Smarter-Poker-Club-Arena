# Horses Adjust To Maniacs In Real Time (2026-10-22)

## The Order

Dan, verbatim: "IF A PLAYER IS MOVING ALL IN ON EVERY HAND THE HORSES NEED TO RECOGNIZE THIS IN REAL TIME AND ADJUST THERE STRATEGY TO CHANGE FOR THIS AND CALL OFF LIGHTER AND NOT RAISE A HAND WITH THE INTENTION OF FOLDING. SAME GOES IN PLO WHEN AN AGGRESSIVE PLAYER IS PLAYING 75% + VPIP AND POTTING AND RAISING EVERY HAND, THIS NEEDS TO BE ACCOUNTED FOR AND THE STRATEGY ADJUSTED FOR ALL GAMES, LEVELS AND STAKES."

## What Was Measured First

`HorseManiacPressure.test-support.ts` plays real HandController hands: five live horses against one seat that either shoves every hand preflop or pots every street and never folds. Same seeds, 200 hands, read live by the 4th to 6th hand in every run.

| Spot                                                               | Before                                                             | After                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------- |
| NLH cash, shoves called                                            | 30% (K9o folded heads-up getting even money against any two cards) | 43%, every heads-up fold below the price  |
| NLH cash, hands raised then folded to the shover                   | 7.8%                                                               | 1.4%                                      |
| NLH cash, hands raised then folded to the potter                   | 38% (70 of 73 preflop)                                             | 4.6% (no preflop raise-then-fold-preflop) |
| PLO4 heads-up postflop folds holding price plus 5 points of equity | 58%                                                                | 7%                                        |
| NLH heads-up postflop folds holding price plus 5 points            | 68%                                                                | 29%, none over price plus 12              |
| PLO5 heads-up postflop folds holding price plus 5 points           | 50%                                                                | 12%                                       |

## The Causes, Read From The Code

1. **A hold'em read was priced against the wrong range.** `HorseMind.bandFor` turned a read's width (a share of hands) into a band with `lo = 1 - width`. The two-card sampler matches bands against hold'em score values, and the score scale is not a percentile: score 0.19 is the top 60% of hands. A seat shoving 100% of hands was sampled as a top-60% range, so every call was priced against hands far stronger than the shover holds. Hold'em-family bands now take `strengthBarForTopShare(width)` (Short Deck its own combo scale, `shortDeckStrengthBarForTopShare`); Omaha keeps `1 - width`, which its reservoir already maps through its own percentile CDF.
2. **Nothing priced the raise after the first one.** The opener read widened the first raise only. The 5-bet branch folded everything under a fixed premium bar whoever was raising, and a maniac's 4-bet read was halved like a horse's. Hold'em facing a maniac's shove, a maniac re-raise, or a maniac raise costing a quarter of the stack now goes through the V38 equity path (equity against the maniac's measured range against the raked price plus the survival premium), the same path Omaha already used for all-ins.
3. **Every postflop fold path treated a maniac's bet as information.** Solver defence tables, the raise plan made at bet time, line narrowing and board-contact conditioning all assume a bet means strength. `maniacCallDown` now checks every fold facing a maniac's bet, in every variant and street, once more against arithmetic: equity against the maniac's preflop range only, other opponents at their normal read, against the raked price, the survival premium and a realisation margin for streets still to come. It runs inside the reference decision like the VPIP floor call-down, so every later owner sees it as the reference's own choice.
4. **Horses opened hands they would fold to the maniac behind them, and bluff-raised into a player who does not fold.** With a maniac still to act, the open is raised only with a hand that continues against its re-raise (the top half of the maniac's width in hold'em, 70% in Omaha). Bluff 3-bets, squeezes and 4-bet bluffs are off while a maniac raised or is still to act.

## Who Counts As A Maniac

`HorseOpponentExploit.maniacRaiseWidth`: an opponent whose preflop raising is credibly outside the measured horse envelope (the 2026-10-16 read) AND at least 35% of hands raised or 25% re-raised. Postflop, the call-down also requires the seat to bet at least 55% of the time it is checked to; a wide preflop raiser who plays postflop normally keeps its bets' meaning. Every horse-like read returns null, so horse-versus-horse play is unchanged and `HorseOpponentExploitNeutrality.law.test.ts` still holds.

## Every Qualified Pack Is Requalified

`HorseLogic.ts`, `HorseMind.ts`, `HorsePreflop.ts` and `HorseOpponentExploit.ts` are hashed policy sources of every qualified horse pack, so this change moves every policy digest. Following the 2026-10-17 precedent (the VPIP floor call-down), the fix ships now and every pack requalifies. In the same commit every selection is explicitly null, so each pack plays shadow (the reference brain, maniac pressure included, executes) until its locked matrix requalifies the exact new source:

| Pack                | Phase | Retired generation (da94e437) | Next generation |
| ------------------- | ----- | ----------------------------- | --------------- |
| PLO4                | 10    | 4                             | 5               |
| PLO5                | 11    | 4                             | 5               |
| PLO6                | 11    | 3                             | 4               |
| PLO8                | 11    | 4                             | 5               |
| Short Deck          | 12    | 1                             | 2               |
| Crazy Pineapple     | 12    | 2                             | 3               |
| FLH                 | 12    | 5                             | 6               |
| PLO4 joint multiway | 13    | 1                             | 2               |
| PLO8 joint multiway | 13    | 1                             | 2               |

Every retained generation stays committed with its evidence and is pinned as refused (`RETIRED_2026_10_22_*` in `HorsePreviousSelections.test-support.ts`). The strength leagues are dispatched on the merged source.

## Pinned

`server/src/engine/HorseManiacPressure.law.test.ts`, registered in `docs/laws.d/server-src-engine-HorseManiacPressure.md`.
