# A folded blind is not paid to a stack that never matched it (2026-10-06)

## What was wrong

`HandController.returnUncalledBet()` returns the unique top contributor's
excess over the next contribution before pots are formed. It returned nothing
when that top contributor had folded. The only way a folded seat is the unique
top contributor is a forced bet larger than every stack still in the hand: a
blind facing an all-in for less.

Probe on the old code, heads-up, blinds 0.5/1, big blind all-in for 0.2: the
small blind is given the turn, folds (or times out, which folds for it), and
the big blind is paid 0.7 having put up 0.2. Three-handed with a 0.3 all-in
big blind the short stack was paid 0.8. Routine late in a tournament, where a
big blind shorter than the small blind is common. Chips were conserved, so no
conservation check saw it.

## The fix, at the cause

The folded guard is removed. The part of a contribution that nobody matched
was never at risk to anyone and goes back to the seat that posted it, folded
or not, exactly as it already did when that seat called instead. Money a
folded player put in that was matched (two players level with each other who
both folded) is tied at the top, returns nothing, and stays in the pot as
before.

## What is not in this change

The small blind is still given the turn in that spot although it cannot lose
more than it has already matched. That is a question about who is asked to
act, not about who is paid, and it is left for its own change.

## Proof

`HandController.shortblind.test.ts`, "a folded blind is not paid to a stack
that never matched it": the fold returns 0.3 to the small blind, the big blind
ends with 0.4, the table total is unchanged. The case fails on the previous
code.
