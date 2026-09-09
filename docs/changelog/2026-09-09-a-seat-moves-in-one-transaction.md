# The Chair, The Cap, And The Blind Level That Was Not One

2026-09-09

Database-side work from the drift-incident sweep. The engine half of the
atomic move landed independently on `main` the same day and is better than the
version this branch originally carried, so that version was dropped in the
merge and `main`'s kept. See the closing section.

## What Was Wrong

Fourteen RUNNING tournaments were short 1,962,900 play chips. The chips were
not lost. 1,673,900 of them sat in `table_seats` rows stamped `left_at`,
belonging to 24 players whose `tournament_players` row still said `playing`:
in the event, holding chips, seated at no table, unable to be dealt a hand and
invisible to every reader that counts open seats. Night Owl Special had not
dealt a hand for 42 minutes. A further 212,500 belonged to 13 registrants who
had never been seated at all.

By 22:31 the same day it was 73 players and 6,126,000 chips.

## Three Root Causes, All Proven On Live Rows

### 1. The four-game cap was enforced at the chair instead of the door

`executePlayerMoves` stamped `left_at` on the source seat before writing the
destination. Between those two writes the player holds no seat, so
`fn_concurrent_game_load` stopped counting the event they were playing and
started counting their other bookings instead. A horse registered for four
imminent events read as a load of 4 while it was between chairs, and
`fn_enforce_four_table_limit` refused the destination write. Proven: user
`ecd88691` (Prime Time Main Event, 370,000 chips stranded) held 0 live seats
and 4 bookings.

`fn_enforce_booking_game_cap` already owns the cap before an event starts and
says so in its own comment. So a player was measured at registration,
admitted, then measured AGAIN at seating against a different load. And a live
tournament seat already requires an active roster row
(`trg_lock_and_validate_tournament_live_seat`, BEFORE ROW), so every
tournament seat this cap ever examined belonged to somebody the door had
already admitted. It could never prevent a commitment; it could only refuse to
honour one. Thirteen registrants were refused a chair entirely, three of them
already "committed to 5 games" — a reading the cap itself had not held.

Fixed in `ca_the_cap_is_at_the_door_not_at_the_chair`: an active entrant taking
a chair in their own event is that entry being honoured. Cash chairs and the
booking cap are unchanged, and a seat for somebody with no roster row is still
counted and still capped.

### 2. The compensating restore was refused, silently

The engine's rollback — `UPDATE table_seats SET left_at = NULL` on the source —
was itself refused by `ab_refuse_live_seat_on_closed_tournament_table`, because
a broken table is closed by the time the restore runs. Probed on eight of the
stranded rows: every one returned `TOURNAMENT_TABLE_CLOSED`. Neither the
vacate nor the restore was error-checked, so the engine logged "source seat
restored" for a rollback the database had rejected.

A compensating write is not a rollback. It is a second write that can fail on
its own, and when it does there is nothing left to compensate with.

### 3. A capped blind level was not a blind level

This is why two events could not be repaired at all, and it is the most
consequential of the three.

`$100 Freeroll 12:00 PM` was 29.6 hours into level 258 and `Turbo Tuesday PKO`
19.6 hours into level 183, both far past the end of their ladders in
`fn_resolve_tournament_blinds`'s `mtt_overflow` branch. That branch clamps
smallBlind, bigBlind and ante to 10,000,000 **independently**. The overflow
factor is `ratio ^ up to 40`, which at ratio 1.6 reaches ~1.3e8, so all three
hit the same ceiling; the chip cap then scales all three by one factor and
preserves the equality it inherited. Both events came out with
`small_blind = big_blind = ante` (125,250 and 116,600).

Two live consequences:

- `fn_ensure_late_registration_capacity` refuses `v_sb >= v_bb` with
  "Tournament current blind level is invalid", so a RUNNING event past its
  ladder can **never** be given another table. The balancer went on
  consolidating anyway: the freeroll ended with 62 active entrants, ONE open
  nine-seat table and 42 closed ones, and 32 players holding 1,658,520 chips
  with nowhere to sit. No seat repair could place them, and no felt could be
  built to place them on.
- The engine deals from this same function, so those tables were being dealt
  with a small blind equal to the big blind.

Fixed in `ca_a_capped_blind_level_is_still_a_blind_level`: the invariant is
enforced after the clamps rather than trusted to survive them — a big blind of
at least 2, a small blind strictly below it, a non-negative ante. The 40-step
factor cap and the 10,000,000 ceiling are left alone; they stop the numbers
running away and they do that correctly. What they were missing is that a
ceiling shared by three related numbers destroys the relationship between them.

## What Else Shipped

**`fn_ca_move_tournament_seat`** — one transaction: vacate, write, carry the
stack, assert that the chips that arrived are the chips that left, repoint the
roster. Refuses `CA_MOVE_AMBIGUOUS_SOURCE` rather than guessing between two
live seats, treats a player already at the destination as a replay, and takes
the terminal authority through `fn_ca_lock_tournament_seat_acquisition` like
every other seat door, so
`fn_tournament_live_seat_acquisition_requires_authority` permits it.

**`fn_ca_return_stranded_to_the_felt`** — brings a player with chips and no
chair back through that same primitive. It reads the returned jsonb rather
than only catching exceptions, because that function can now decline without
raising and a decline must not be counted as a success. Not scheduled, no cron
entry, and it never will be: it is called.

**`fn_ca_restore_tournament_felt`** — the other half. A chair needs a table.
Rather than reopen a closed one (deliberately irreversible, and rightly so),
it delegates to `fn_ensure_late_registration_capacity`, the canonical capacity
door, which writes the capacity receipts the origin validator demands.

**Two measurement fixes.** `fn_ca_drift_metrics.suspense_today` and the
burn-in gate's `zero_suspense_flow` both summed rows touching
`settlement_suspense` GROSS. `chip_ledger` is a transfer journal: a chip that
enters suspense and later leaves writes two rows, and a correction cancelling
an auto-ledger twin writes two more. The dashboard read 82,229.96 on a day
whose net residual was 0.00 at every hour, and it DOUBLED at 11:00:50 — the
exact minute the corrections landed. Fixing drift made the alarm louder. Both
now net, with the gross kept beside the residual as traffic.

## Proof

|                            | before     | after   |
| -------------------------- | ---------- | ------- |
| stranded players           | 73         | 0       |
| stranded chips             | 6,126,000  | 0       |
| tournament chip drift      | −6,201,000 | −75,000 |
| events short of felt       | 2          | 0       |
| registrants never dealt in | 13         | 0       |
| unclassified flow today    | 82,229.96  | 0.00    |

The residual −75,000 is not missing chips: it is 43 registrants who were never
issued a stack and have since been marked eliminated, whose starting stacks
`fn_tournament_chip_conservation_check` still counts as issued. With seating no
longer refused, every registrant is dealt in and the formula becomes true as
those events finish.

## The Engine Half Was Superseded, Deliberately

This branch originally replaced `executePlayerMoves` with a single checked call
to the move RPC. While it was in review, `main` landed a materially better
implementation of the same idea: `runWithTournamentSeatMoveAuthority`,
per-source hand-boundary claiming probed in parallel rather than serially,
request ids with immutable receipts, an explicit
`TournamentSeatMoveOutcomeUnknownError` with a pending-outcome redrive, and
refused-source tracking so one bad source does not invalidate a whole batch.

That is a better answer to the same problem, including the
committed-but-errored case this branch only detected. Keeping this branch's
version would have regressed it, so the merge took `main`'s for
`TournamentManager.ts` and for both guard tests, and this branch carries only
the database work. The laws on `main` are the current laws.
