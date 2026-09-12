# Diamond Phase 7: The Diamond Arena Deals The Games The Estate Deals

Status: Phase 7 In Progress. Checklist Line One Is Claimed. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

## What The Line Asked

"Enable each intended Club Arena variant only after corresponding Diamond tests."

The chip cash create screen offers nine: `nlh`, `plo4`, `plo5`, `plo6`, `plo8`, `pineapple`, `short_deck`, `flh`, `flo8`. The arena opened with one. Dan's target for the whole phase is a one to one clone, so the intended set is the same nine, and what this line is really asking is what the Diamond tests have to prove before they are admitted.

## The Only Question A New Game Asks

A Diamond does not divide. So the only question another game raises is whether it divides a pot somewhere the cent-denominated code did not have to care about.

Every such place was already made unit-aware while this arena was NLH only: the run-it-twice per-board slice, the multi-board settlement, the tie chop inside one board, the payout unit, and **the hi-lo split**. The last is the one this list newly reaches, and it takes the same `chipUnit` the tie chop takes:

```
loCents = floor(potCents / (2 * unitCents)) * unitCents
hiCents = potCents - loCents
```

So the low half of a Diamond pot is always a whole number of Diamonds, and the odd unit goes to high, which is the standard rule. A pot of exactly one Diamond therefore pays high entirely and the qualifying low hand nothing. That is not a rounding defect to be fixed; it is what an indivisible pot means, and it is the same answer a live room gives with one chip in the middle.

Nothing else divides, and this was checked rather than assumed. Pot-limit sizing is `currentBet + pot + toCall`, pure addition with no rounding on the path at all. Fixed-limit multiplies the big blind by one or two; its two halvings are reopen **thresholds** and are never wagered. Short deck strips the deck and derives no ante. The bomb-pot ante was already Diamond aware.

## One List, In Both Languages

The refusal was written down in five places, and a rule written down five times is how the plain-cash rule had drifted into five rules by this morning. So the games are named exactly twice, once per language: `fn_poker_diamond_cash_variant` in SQL, `DIAMOND_CASH_VARIANTS` in TypeScript. Every door reads one of the two, and a law asserts the two agree.

The law also derives the TypeScript list from `src/config/cashGames.ts`, the chip create screen's own list. The arena is not making an independent product decision about which games exist; it is the same estate in another denomination. Adding a tenth game for chips now fails that law until the arena is told about it too.

## Two Things That Were Quietly Backwards

**The bomb-pot override read the literal `nlh`.** The rule was always "a bomb pot deals the table's own game", and while `nlh` was the only game those two are indistinguishable. They stop being indistinguishable the moment there is a second game: as written it would have refused a Diamond PLO4 table whose bomb variant said `plo4`, and admitted one whose bomb variant said `nlh`. Both backwards. It compares against the table's own variant now, and the matrix asserts it for all nine games against all nine overrides.

**A NULL game was neither admitted nor refused.** `NULL IN (...)` is NULL, not false, so an unset `game_variant` made the whole plain-cash rule return NULL. Every caller today happens to treat unknown as refusal, which is exactly the kind of accident that holds until one of them writes `IF fn(...) = false`. The list is NULL-safe now: an unset game is not a game.

## The Creation Door Names The Game

`fn_poker_diamond_open_cash_table` hardcoded `'nlh'` in its `VALUES` list and had no variant parameter at all. It has one now, defaulting to `nlh` so every existing six-argument call keeps working and keeps meaning what it meant.

The six-argument signature is **dropped** rather than replaced: a default cannot be added by `CREATE OR REPLACE` without leaving an overload behind, and an ambiguous staff door is worse than a missing one. The migration asserts afterwards that exactly one such function exists.

The door also now proves the row it just wrote would be admitted, before returning it. A door that can open a table nobody can sit at is worse than no door, and that is precisely the failure mode this phase found twice already.

## Evidence

**The strongest piece was already written, by someone else, and had been skipping the Diamond arm.** `Phase9MultiboardUnits.test.ts` crosses `plo4`, `plo8` and `flo8` against two and three boards against tournament, Diamond and cash units, and checks the result against an **independent reference allocator** rather than against the engine's opinion of itself. Its Diamond arm asserted the refusal and returned, under a note saying "the settlement repair does not enable Omaha" - true of that repair, and no longer true of this arena. It runs now: 18 tests, six of them Diamond, and `plo8` and `flo8` are the hi-lo games, so the split this line newly reaches is covered there twice over.

**The configuration matrix gained its fourth axis.** It crossed features, statuses and rungs while the arena dealt one game; a game is exactly the kind of thing that works in the cell nobody tested. Every variant is now admitted in every shape at every live status, every variant may bomb in its own game and in no other (nine by nine), and every variant deals a full hand at the top rung and conserves in whole Diamonds. 99 tests.

**In the isolated fixture**, 63 checks, up from 41: the nine games admitted one by one, seven non-games refused including a case-wrong `NLH` and a blank, a NULL game refused, and every SQL door asserted to name its games through the one list and to keep no literal of its own.

## Still Refused, Deliberately

`pineapple_holdem` stays in the refused column list even though `pineapple` is now an admitted table variant, and the two are not the same fact. The column turns an `nlh` table into a hand **dealt** as pineapple, which is the chip schedule reaching into a table this arena declared as hold'em. A Diamond pineapple game is a table that says so.
