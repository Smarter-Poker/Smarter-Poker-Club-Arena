# A blind that already covers every all-in is not asked to act (2026-10-06)

## What was wrong

Heads-up, blinds 0.5/1, big blind all-in for 0.2: the small blind was put on
the clock with fold, call and raise. Nobody was left to call a raise, and the
small blind could lose no more than the 0.2 it had already matched. A slow or
disconnected seat was then auto-folded out of a pot it had covered. The same
when the small blind is the short all-in and the big blind covers it, and
three-handed when the button folds and the remaining blind covers the all-in.
Routine late in a tournament.

(What that fold PAID was fixed earlier today in "a folded blind is not paid to
a stack that never matched it". This is the other half: the seat should not
have been asked.)

## The fix, at the cause

`HandController.soleLiveSeatCoversEveryAllIn()`: exactly one seat can still
act, at least one opponent is all-in, and that seat's money on the street is
at least every all-in opponent's. `start()` and `isBettingRoundComplete()`
both read it, so the hand goes straight to the runout: the uncalled excess is
returned and the board is dealt. A seat that does not cover the all-in (a 0.5
small blind against a 0.7 all-in) still decides, and any hand with two seats
able to act is untouched.

## Proof

`HandController.shortblind.test.ts`, "a blind that already covers every all-in
is not asked to act": both heads-up shapes go to `ALL_IN_RUNOUT` with no
`TURN_CHANGE` and the right amount returned (0.3 and 0.6); three-handed, one
fold reaches the runout with 0.2 returned; the two control cases still get a
turn. The uncalled-return rule for a seat that leaves the hand folded is
pinned beside it.
