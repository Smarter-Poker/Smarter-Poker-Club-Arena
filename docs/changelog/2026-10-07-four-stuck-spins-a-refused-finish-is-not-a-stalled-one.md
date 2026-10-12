# Four stuck Spins: a refused finish is not a stalled one (2026-10-07)

Four three-player chip Spins (87f6d0ee, 9d4067ab, a19b10fe, a6ae23f9) had sat
RUNNING since 15:33 UTC on 2026-10-06, and the engine asked the database about
each of them every ~10.5 s. Three causes, three fixes.

## 1. What still woke them every ~10.5 s (engine)

#6403 made the finish-stage re-arm keep the refusal's own backoff (doubling to
15 minutes). The rate only fell from ~4.6 s to ~10.5 s. The remaining wake is
`GameServer.discoverTournaments`, block STALLED DECIDED-BUT-RUNNING RECOVERY:
every discovery pass (`TOURNAMENT_DISCOVERY_INTERVAL` 5 s plus the pass) it
reads RUNNING events with at most one player `playing` and calls
`idleTm.requestDecidedEliminationSweep('stalled_decided_survivor')` on each live
manager. That goes to `tournamentEliminationScheduler.wake()` with a zero delay,
and the scheduler keeps the EARLIEST pending wake, so every pass pulled the
15-minute retry forward to now. Measured in edge logs at 13:15 UTC: the decided
board read (`tournament_players?select=id,tournament_id&status=eq.playing&tournament_id=in.(a19b10fe,9d4067ab,87f6d0ee,...)`),
then four `fn_complete_tournament_terminal` 500s 110-150 ms apart
(`DECIDED_RECOVERY_STAGGER_MS` = 110), repeating at 13:15:08, :19, :29. In
postgres_logs, 362-364 P0404 refusals per Spin per hour (one every 9.9 s).
The seat-first finish sweep (`seat_first_terminal_stack`, 60 s) had the same
shape.

Fix: the manager now records when the retry it asked for after a proven
refusal is due (`noteFinishRefusal`), and `awaitsItsOwnFinishRetry()` answers
true until then. `requestDecidedEliminationSweep` refuses the wake while it is
true, and both GameServer recoveries skip such a manager before their stagger
and reads. Once the retry is due the recovery may wake it again, so a lost
retry is still found. A committed settlement clears it. Pinned in
`server/src/tournament/aRefusedFinishIsNotAStalledOne.law.test.ts`.

Engine release: activates in the certified :55 window.

## 2. What wrote the NULL sequences (database)

At 15:33:04 a psql session (user postgres) ran the patterned-identity force
drain loop in a session with `session_replication_role = replica` (the
operator's preceding command at 15:32:56 was `SET session_replication_role =
replica; \i force_drain_loop.sql`):

    UPDATE public.tournament_players tp
       SET status = 'eliminated', eliminated_at = clock_timestamp()
      FROM smarter_private.patterned_identity_retirements r
     WHERE r.old_id = tp.user_id AND r.cohort = 'horse'
       AND lower(coalesce(tp.status::text, '')) IN ('registered', 'playing');

Replica mode switches off ordinary triggers, including
`zz_stamp_tournament_elimination_sequence`, so live players went to
`eliminated` with no sequence (4 running Spins, 5 registering events; the same
UPDATE in origin mode at 15:33:34 was refused by the never-started guard). The
maintained producer (`scripts/admin/retire-patterned-identities.sql`, #6315)
already refuses replica mode and never force-drains; that does not bind a
foreign session.

Fix: `20261007132903_the_elimination_stamp_fires_in_every_replication_role`
sets the stamp `ENABLE ALWAYS` (function unchanged, md5 asserted). A session
that bypasses every other trigger still cannot eliminate a player without the
next sequence. Pinned in
`tests/the-elimination-stamp-fires-in-every-replication-role.law.test.ts`.

## 3. Settling the four Spins

Read from rows: in each Spin the retired entrant was removed at 15:33:04,
between 3 and 14 s after the start, during the Spin reveal hold. No hand had
been dealt: every table's first hand started 15:33:08 to 15:33:19 and names
only the other two players. Its chair was closed holding its full paid
starting stack, which is still there. The other two played heads-up; one
busted and the engine recorded that bust as THIRD place, i.e. with the retired
player still in the field. The survivor holds exactly the two stacks that were
in play.

| Spin                                  | prize | retired, never dealt (chair)                | heads-up bust, 3rd   | survivor        |
| ------------------------------------- | ----- | ------------------------------------------- | -------------------- | --------------- |
| 87f6d0ee 10 Chip Spin PLO4            | 30    | lil_pancake 00000000-...-0020, 300 (seat 3) | MIABull, seq 612919  | donkking, 600   |
| 9d4067ab 20 Chip Deep Stack Spin PLO4 | 40    | maniacc 00000000-...-0030, 1000 (seat 2)    | stack111, seq 613492 | MikeL, 2000     |
| a19b10fe 20 Chip Spin PLO4            | 40    | lil_pancake 00000000-...-0020, 300 (seat 2) | xrake, seq 612600    | SDLou, 600      |
| a6ae23f9 20 Chip Spin PLO6            | 40    | slickbear 00000000-...-0025, 300 (seat 2)   | ace.park, seq 612807 | GumboRamen, 600 |

Every one of the twelve is a horse; they are settled exactly as humans would be.

**The paragraph.** In each of the four Spins one paid entrant was taken off the
felt by a platform force drain before a single card was dealt, and never lost
a chip; the other two played heads-up and one of them busted, recorded third.
Those entrants (lil_pancake twice, maniacc and slickbear) get their own chair
back with the stack they still hold, and each Spin is finished by play against
the survivor (donkking, MikeL, SDLou, GumboRamen), the way 62a15104 and
355408fa were. The busted players (MIABull, stack111, xrake, ace.park) keep
third, which is what they earned. Whoever wins the heads-up is paid the drawn
prize (30, 40, 40, 40) once, by the event's own terminal settlement; the loser
is second. Declaring the survivor the winner now would decide by fiat a match
nobody played, and refunding would undo two players' real result. No money is
moved by this repair, nobody is paid twice and nothing is taken back.

`20261007132839_four_retired_spin_entries_return_to_their_chairs`: per Spin,
under the seat door's own lock order and the manager's lease authority, assert
the exact preimage (every id and number above, never dealt, live lease, not
frozen), return the roster row to `playing` and revive the same chair through
`fn_assign_tournament_player_seat_atomic` (which refuses any stack but the paid
starting stack and any total above what was bought in); assert two chairs and a
felt of three starting stacks. Proved twice in self-aborting DO blocks against
production (13:28 and 13:38 UTC): all four restored, felt 900 / 3000 / 900 /
900, rolled back. It writes only `tournament_players` and, through the seat
owner, `table_seats` and `tables.current_players`.

The nine open `financial_alerts` for these four (six
`Tournament.atomic_finish_refused` / drift, three
`fn_ca_tournament_finished_but_not_completed`) are resolved once each Spin has
completed, with the winner and prize in the resolution.

## Not settled here

Five REGISTERING events still hold 50 rows the same force drain marked
`eliminated` with no sequence (0801e005, 28515bbb Six-Card Feature, 4ddcf172,
73ff3bdc Wednesday Feature, 2f906cbc). They never started, so no finish is
waiting on them; they are reported for their owners, not touched.
