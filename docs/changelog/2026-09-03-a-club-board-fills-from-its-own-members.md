# 2026-09-03 - A club board fills from its own members, or it never fills at all

**Dan, 2026-09-01** (the Deep Stack Society directive): heads-up / SNG boards
must open for activated CLUB owners, not just the house board.

**Dan, 2026-09-02:** DSS horses "PLAY OPENLY INSIDE THE DEEP STACK SOCIETY
ONLY."

**Dan, 2026-09-02 and again 2026-09-03:** those boards sit at 1/2 seated
forever.

All three are the same story.

## What was happening

`checkAndLaunchSNGs` was taught (2026-09-01) to open seat-first boards for every
activated club owner. `topUpWithHorses` was never taught to fill them - it
returned 0 for any club that was not the house board. So the platform opened
boards it had forbidden itself to fill.

Measured on production 2026-09-03 08:2x UTC:

| Club                           | Heads-up                          | Spins      |
| ------------------------------ | --------------------------------- | ---------- |
| Midway Union (the house board) | 62 RUNNING                        | 60 RUNNING |
| Deep Stack Society             | 6 REGISTERING, **0 ever RUNNING** | -          |

Every DSS board took a real buy-in from the first player to sit down and then
held it forever. 32 boards stuck since 2026-09-01 18:42; another 32 created
2026-09-02 22:26-22:51 and stuck the same way. Both batches were cancelled and
refunded by hand through `atomic_cancel_tournament` (852.00 back to 32 horses
the first time).

The engine also retried each unfillable board every twelve seconds, and each
retry paid for a `fn_sync_seat_first_player_count` round trip on the way out:
**24,490 calls in 76 minutes, 2,292 seconds of database time** - roughly half a
core, permanently, spent on boards that could not move. That was measured while
the floor was timing out and Dan was reporting stalled hands.

## The rule was right; the code was stricter than the rule

The gate's own comment already said it:

> Membership is explicit. Automated liquidity is permitted on the platform house
> board only; a user-owned club fills its tournaments with users who joined that
> club through Join A Club.

The second half is the rule. The code implemented only the first half, and that
is what contradicted the 09-01 directive.

## Where the rule now lives

In the **pool**, not in a gate. `pickFreeHorses` already narrows every candidate
through `clubMemberIdsForTournament()`: a standalone club draws on its own
members and nothing else; a union event draws on every club in that union. So a
seat-first board fills wherever it was opened, and it can only ever fill with
people who joined that club - DSS boards from DSS horses, exactly as Dan asked,
with no house horse able to wander into a user club's game.

Two changes, both in `topUpWithHorses`:

1. The refusal is now scoped to `!seatFirst`. Automated **registration** for a
   scheduled MTT stays house-only, because that path goes through
   `registerHorses`, whose pool is not club-scoped; opening it would put house
   horses on a user club's entry list. Widening that is a separate decision with
   its own measurement.
2. The refusal no longer calls `fn_sync_seat_first_player_count` on its way out.
   Nothing on that path touched a seat, so there is no counter to reconcile.

`automatedLiquidityMayFill` was renamed `automatedRegistrationIsPermitted`,
because that is now the only thing it decides.

## Verification

`tsc --noEmit` clean. New pins in
`server/src/services/aClubBoardFillsFromItsOwnMembers.test.ts` (7 tests), each
observed **red against the pre-change source** and green after - reverting the
`!seatFirst &&` alone fails the suite. The existing
`clubOwnerSngBoards`, `seatFirstFillOrder`, `seatFirstCountSync` and
`aScheduleCannotCreateASeatFirstGame` suites all still pass (31 tests).
