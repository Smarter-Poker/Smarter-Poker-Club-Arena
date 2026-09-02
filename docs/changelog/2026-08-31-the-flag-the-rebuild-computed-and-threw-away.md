# The flag the rebuild computed and threw away

**2026-08-31** — second pass over the same factory, after Dan asked what was
left.

The first pass found the rebuild's tabs missing `kind`, which made the stale-tab
prune inert. Auditing the rest of the factory found the identical shape one
field over.

## What was wrong

`additions` derived whether the row is a tournament, handed it to
`gameCode({ isTournament })`, and then did not put it on the tab. Four readers
depend on the tab carrying it, and `undefined` reads as "cash" at every one:

| Reader                 | Consequence when the flag is missing                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sitOutStartedMessage` | A tournament player is told "Your Seat Is Held For Up To 5 Minutes". There is no 5-minute hold in a tournament; they are blinded off.                                       |
| `handleSitOutAll`      | Counts the tournament as a cash seat on an eviction clock, overstating the money-relevant warning.                                                                          |
| Profit aggregation     | Includes the tournament, against Dan 2026-08-30: "THE PROFIT COUNTER ... SHOULD NEVER WORK OR ENGAGE OR TRACK ANYTHING FOR TOURNAMENTS, THIS IS A 'CASHGAME ONLY FEATURE'." |
| Tile raise slider      | `sliderUnitFor(!!table.isTournament, ...)` steps in cash increments.                                                                                                        |

## Severity, stated honestly

This is a WINDOW, not a permanent state. TablePage reports `isTournament` up
through `updateTableInfo` once its engine state loads, and every tab is mounted
(the container renders all of them; `isActive` only marks focus), so each tab
self-corrects.

The window is not empty, though. It opens on every reload and every balancer
move, and the profit aggregation's first `compute()` runs inside it — the
effect calls `compute()` immediately and only then starts its 5s interval. So
the cash-only rule is broken for one cycle each time, on a chip that is showing
the player a number.

The fix costs one variable: the row already knew.

## Also done

`isTournamentRow(row)` now lives in `src/utils/tabSlots.ts` with the other
tab-factory predicates and is pinned behaviourally — including the case that
would have been easy to get wrong by hand, a table carrying `tournament_id`
with no `game_type`, which reading only `game_type` would misfile as cash.
The balancer-move branch sets the flag explicitly; it is tournament-only by
construction, which is why `gameCode` already hardcoded it there.

## Verification

- `npx tsc --noEmit` clean.
- Full client suite, worktree containing only these four files on top of
  `origin/main`: **9798 passed / 9798, 0 failed.**
