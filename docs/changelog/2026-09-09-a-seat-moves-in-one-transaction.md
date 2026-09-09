# A Seat Moves In One Transaction, Or It Does Not Move

2026-09-09

## What Was Wrong

Fourteen RUNNING tournaments were short 1,962,900 play chips. The chips were
not lost. 1,673,900 of them were sitting in `table_seats` rows that had been
stamped `left_at`, belonging to 24 players whose `tournament_players` row still
said `playing`. They held chips, they were still in the event, and they were
seated at no table, so they could not be dealt a hand and every reader that
counts open seats read straight past their stacks. Night Owl Special had not
dealt a hand for 42 minutes.

The remaining 212,500 belonged to 13 registrants who had never been seated at
all.

## How They Got There

`TournamentManager.executePlayerMoves` moved a player with four separate round
trips: read the source stack, stamp `left_at` on the source seat, write the
destination seat, and, if that failed, a fifth to put `left_at` back. Between
trips two and three the player holds no seat anywhere.

1. The destination write was refused by `fn_enforce_four_table_limit`. A player
   mid-move holds no live seat in the event they are playing, so
   `fn_concurrent_game_load` stops counting that event as a seat and starts
   counting their other bookings instead. A horse registered for four imminent
   events reads as a load of 4 while it is between chairs. Proven on the live
   rows: user `ecd88691` (Prime Time Main Event, 370,000 chips stranded) had 0
   live seats and 4 bookings.

2. The compensating restore was refused as well, by
   `ab_refuse_live_seat_on_closed_tournament_table`. A broken table is closed by
   the time the restore runs, and that trigger will not revive a seat on one.
   Probed on eight of the stranded rows: every one returned
   `TOURNAMENT_TABLE_CLOSED`.

3. Neither refusal was error-checked. The engine logged "source seat restored"
   for a rollback the database had rejected.

4. `absorbOrphanedSeats` and `absorbSeatlessPlayers`, the two repairs that
   exist, both call `executePlayerMoves`, so both were refused by the same
   guard. The first reads `left_at IS NULL` and is blind to a player holding no
   seat at all.

The 13 never-seated registrants are the same guard at the other end. The cap is
checked once at registration by `fn_enforce_booking_game_cap` and then AGAIN by
the seat trigger when the field is seated, at a different moment against a
different load. Three of those players were already "committed to 5 games", so
the reading that refused them was not even one the cap had managed to hold.

## What Changed

**The four-game cap is at the door, not at the chair.**
`ca_the_cap_is_at_the_door_not_at_the_chair`. A live tournament seat already
requires an active roster row, because
`trg_lock_and_validate_tournament_live_seat` raises
`TOURNAMENT_SEAT_ROSTER_REQUIRED` without one and runs BEFORE the row is
written. Every tournament seat this cap has ever examined therefore belonged to
somebody the door had already admitted. It could never prevent a commitment; it
could only refuse to honour one. Cash chairs are unchanged, and tournament
entry is still capped by `fn_enforce_booking_game_cap`.

**A move is one transaction.** `fn_ca_move_tournament_seat` vacates the source,
writes the destination, carries the stack, asserts that the chips that arrived
are the chips that left, and repoints the roster inside one transaction. A
refusal at any step unwinds all of it and the player is still sitting where
they were. A compensating write is not a rollback: it is a second write that
can fail on its own, and when it does there is nothing left to compensate with.
There is now no window, so nothing can arrive in it, and a process that dies
mid-move leaves nothing half-done.

Every check the engine used to make by hand now lives in that function, where
it holds for every caller: the source stack read under lock, the refusal to
guess between two live seats (`CA_MOVE_AMBIGUOUS_SOURCE`), the destination
verified to belong to this event and to be open, an occupied chair refused
rather than overwritten, and a player already at the destination treated as a
replay rather than a second move.

**The engine checks the result.** That is the other half of the bug.

**The mid-hand probe stays where it was.** Atomicity protects the mover; it says
nothing about the hand the other eight players are in the middle of, which
lives in the engine and not in the database. `waitForHandComplete` is still
re-probed per move, immediately before the only destructive call, which is now
the RPC itself.

**`fn_ca_return_stranded_to_the_felt`** brings a player with chips and no chair
back, through that same primitive. It is not scheduled, has no cron entry, and
never will: it is called, not run.

## Laws Updated Rather Than Deleted

Three guards in `TournamentFixes.guard.test.ts` and
`aDetectorMayNotCryWolf.law.test.ts` pinned the compensating restore by its
error markers. Those protections did not disappear, they moved into the
database, so the laws now assert the stronger property: `executePlayerMoves`
writes no seat rows at all, never contains a `left_at: null` restore, and does
not count a refused move as a move.

## Proof

|                                 | before     | after   |
| ------------------------------- | ---------- | ------- |
| tournament chip drift           | −1,962,900 | −75,000 |
| tournaments drifting            | 14         | 5       |
| stranded players                | 24         | 0       |
| active registrants never seated | 13         | 0       |

The remaining −75,000 is not missing chips. It is 43 registrants who were never
seated and have since been marked eliminated, whose starting stacks
`fn_tournament_chip_conservation_check` still counts as issued. With seating no
longer refused, every registrant is dealt in and the formula becomes true as
those events finish.

Night Owl Special resumed dealing at 18:01, the minute its players came back.
