# A raise is above the bet (2026-10-06)

## What was wrong

`validateAction` (`server/src/engine/PokerEngine.ts`) lets a short stack raise
all-in for less than a full increment. The escape tested only "is this the
seat's whole stack", so a "raise" TO LESS than the bet already made was valid:
28 against a bet of 100. `HandController.performAction` then assigned
`currentBet = 28`. Everyone behind paid 28 instead of 100, and an earlier
bettor who "called" had a negative amount to call, which paid 72 back out of
the pot. Chips were conserved and allocated against the rules.

The main cash and tournament door clamps before the controller
(`ServerTableEngineTurns`), so ordinary tables were not exposed. The Lightning
host forwards the request's amount straight to the controller.

## The fix, at the cause

- `validateAction`: a raise at or under the current bet is refused. A stack
  that cannot exceed the level is a call and arrives as `call` or `all_in`.
- `validateAction`: `call` is refused when there is nothing to call, including
  a negative amount.
- `HandController.performAction`: the level only ever rises
  (`Math.max(currentBet, amount)`).
- `LightningHandHost.applyAction`: a wager of the whole stack is promoted to
  `all_in`, as at every other table door, so a legitimate short shove sent as
  a raise is still played.

## Proof

`HandController.reopening.test.ts`, "A RAISE IS ABOVE THE BET": a 5-chip
stack's raise to 5 (and to 20) against a bet of 20 is refused, the level and
pot do not move, and the same chips are accepted as `all_in`. The case fails
on the previous code and passes on this one.
