# A Diamond Preset Is A Whole Diamond

Status: Phase 7 In Progress. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

## A Button That Did Nothing When You Pressed It

`HandController.performAction` refuses a non-integer amount outright when the table's asset is diamonds. It returns `false`. No error, no toast, no log. So a preset button whose value is half a Diamond is a button that does nothing at all when a player presses it, and there is no way for them to find out why.

Two separate things were producing exactly that, and both have been live on Diamond NLH since the arena opened. Neither was found by a test; both were found while mapping what would have to change to admit PLO and the other variants, which is the work this sits in front of.

**The multiples row.** It carries 2.5X and 3.5X, and two and a half times an odd bet is a half. `finalizeExact` preserved the fractional value deliberately, on stated reasoning: "N times a legal bet is already a legal amount by construction, because the bet it multiplies was itself made of this table's chips." That is true for whole N. It is false for these two, and it was false the moment a table existed whose chip does not divide.

**The grid itself.** The fallback is `bigBlind / 2`, which is the small blind for every standard structure. Three rungs of Dan's Diamond stake ladder are not standard: **10/25, 200/500 and 1000/2500**. Half of 25 is 12.5 and half of 2500 is 1250; the first is half a Diamond. POT and every postflop fraction snapped onto a grid the table cannot pay.

The second is the worse of the two, because it is not confined to two buttons on an odd bet. On a Diamond 10/25 table every derived sizing was off the unit whenever the snap landed on an odd multiple of 12.5.

## One Idea In Two Places

The table's indivisible unit is now a parameter. It is a cent for chips and one Diamond at a Diamond table.

- The grid is rounded onto the unit, so a denomination is always a whole number of units. A grid of half a Diamond can only ever produce amounts the table cannot pay, whatever is done downstream of it.
- The cleaner lands every value on the unit. For chips the unit is a cent and the cleaner already did exactly this, so the chip path is unchanged **by construction** rather than by inspection.

The multiples keep their buttons. A 2.5X that cannot be paid is not replaced by nothing; it is replaced by the nearest amount that can be, which is what the label was always promising.

## Evidence

`tests/unit/aDiamondPresetIsAWholeDiamond.test.ts`, 20 assertions.

All seventeen rungs of the live ladder, preflop and postflop, against three bets faced including an odd one, because 2.5X and 3.5X of an even number are whole by luck and luck is not a guarantee. Every preset on every combination is asserted to be a safe integer, with the failure message naming the button, the rung and the amount the engine would have refused.

The three non-standard rungs are asserted a second time with **no** `smallestChip` supplied, so the `bigBlind / 2` fallback itself is what is under test rather than the value the parent happens to pass.

And the chip table is asserted not to move: 2.5X of a 3 bet is still exactly 7.5 and 3.5X is still 10.5. A fix that silently rounded chip amounts to whole chips would be a worse bug than the one being repaired, so it is pinned rather than assumed.
