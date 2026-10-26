# A short all in is called by a big stack (2026-10-26)

Dan, verbatim: "WHEN A PLAYER SHOVES ALL IN WITH LESS THEN 3 BB A STACK OF 20 OR MORE BB SHOULD BE CALLING WITH ALMOST ANYTHING IN A TOURNAMENT."

## What changed for players

In any tournament (MTT, Sit & Go, Spin, satellite), when someone moves all in for less than 3 big blinds, every horse holding 20 big blinds or more now calls instead of folding. That holds for every horse, every style and every game the horses play in tournaments: hold'em, short deck, PLO4, PLO5, PLO6 and PLO8.

- Before the flop the horse always calls. At that price every starting hand is worth a call, 7-2 offsuit included.
- After the flop the horse calls unless its own odds calculation says the hand is drawing dead (under 5% to win, and under the price it is being laid).
- A horse that already wanted to raise still raises. Only folds are turned into calls.
- Other players in the pot don't change it. The horse still calls the short all in and doesn't re-raise unless it already chose to.
- On an all-in-or-fold table, calling means going all in, so that is what the horse does.
- Cash games, horses with under 20 big blinds, and all ins of 3 big blinds or more are unchanged.

## How it fits with the PLO paired-board fold

Yesterday's rule folds PLO4/5/6 hands without a full house to a committing bet on a paired board. A shove under 3 big blinds into a horse with 20 or more is not a stack-off, so the paired-board fold stands aside in that spot and the horse calls. The paired-board fold still wins whenever the call is a real stack-off: a quarter or more of the chips the horse has left, or all of them.

## A fix found along the way

The paired-board fold and the hold'em premium rule used to run after the brain had sealed its decision record. Whenever either rule changed the action, the record no longer matched it, and the live decision worker threw the decision away as invalid. The table then played its emergency fallback instead, which is a fold whenever there is a bet to face. Both rules (and the new one) now run inside the brain's final step, so the record matches and the decision the rule made is the one that gets played.

## Where it lives

- `server/src/engine/HorseShortAllInCallFloor.ts`: the rule.
- `server/src/engine/HorseLogic.ts`: the last step of every horse decision (`wager_rules`).
- `server/src/engine/ServerTableEngineTurns.ts`: applied again just before the action reaches the table, so an emergency fallback can't fold the spot either.
- Pinned by `server/src/engine/aShortAllInIsCalledByABigStack.law.test.ts` and `server/src/engine/HorseShortAllInCallFloor.test.ts`.
