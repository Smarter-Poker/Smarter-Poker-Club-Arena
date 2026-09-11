# The Seat-First Fill Skips a Seat the Horse Already Holds

`fn_seat_horse_in_seat_first_game` opens with `fn_ca_lock_tournament_seat_acquisition`, an EXCLUSIVE advisory lock on the single platform-wide key `ca:tournament-terminal-settlement:v1` that every hand settlement (`fn_ca_commit_hand_settlement`) holds SHARED for the whole of its commit. Heavyweight-lock queueing is FIFO, so each seat call waits for every in-flight hand commit and every hand commit arriving after it queues behind the call.

Measured 2026-09-10 03:05-03:40 UTC on the 2XL box (pg_stat_statements, reset 02:34): 1,533 calls, mean 590 ms against a 2.4 ms minimum, sd 799 ms, max 5,889 ms (the hand-commit max is 5,891 ms; it is the same convoy), 572 shared blocks per call, which is under 5 ms of real work. pg_stat_activity sampled at 100 ms through a seeding burst showed the RPC in a Lock wait in 100 of 110 samples. The same window produced at most 579 seats for those 1,533 calls, so at least 60% of the calls answered `already_seated`, `table_full` or `tournament_not_seatable` after taking the lock and stalling the hand path to hear it.

The lock cannot be narrowed on the database side without changing what a concurrent settlement can observe, so this change is caller-side only. There is no migration.

## What changed

`TournamentRecurringService.topUpWithHorses` already read the primary table's live seats to measure the shortfall. It now keeps those rows (`user_id, seat_number`, same index, same `left_at IS NULL` predicate, same count) and, once there are candidates, reads `tables.max_players` by primary key. Three pure functions decide from that ledger before each call:

- `seatFirstSeatLedger` builds the seated set, the occupied seat numbers and the capacity using the RPC's own expression `COALESCE(NULLIF(tables.max_players, 0), tournaments.max_players, 3)`. An unreadable table row leaves the capacity unknown, and an unknown never skips a call.
- `seatFirstSeatPrecheck` answers `already_seated` for a horse in the seated set, `table_full` when no seat number in `1..capacity` is free (checked in the RPC's order: a seated horse at a full table reads `already_seated`), and `call` otherwise.
- `seatFirstNoteSeated` and `seatFirstNoteTableFull` feed the RPC's answers back into the ledger for the rest of the pass, so a seat granted three candidates ago is not offered again and, once the RPC has said `table_full` under its lock, the spare candidates (three per seat, see `seatFirstCandidateCount`) do not queue to hear it again.

Every other horse goes through the same RPC with the same arguments. The RPC remains the authority: it re-checks both conditions under its lock, so a stale ledger costs at most one wasted call and never a wrong seat. The one difference a horse can observe is that a seat it vacated between the read and the now-skipped call is offered on the next five-second pass instead of this one.

`seedOpenSeatTable` is unchanged. It seats onto a table the database just created, empty, with horses `pickFreeHorses` has just verified are unseated, so neither answer can come from there.

One count is corrected on the way: an `{ok:true, already_seated:true}` answer used to be counted as a seat filled (`added++`). It never filled anything, the horse was already inside `liveCount`, and counting it stopped the pass one seat short whenever a seated horse was drawn first, which a small club fleet does pass after pass. It now seats nobody, notes the horse in the ledger and lets the next candidate have the seat. The return value only feeds log lines and GameServer's miss-backoff counter, both of which were being told a seat had been added when none had.

Horses are players (CLAUDE.md 10.5). Nothing here filters on `is_horse` and nothing here denies a horse a seat it would have received. The only calls removed are the ones whose answer was already `already_seated` or `table_full`.

## Where the no-ops come from

`pickFreeHorses` excludes only horses at the four-game cap, so a horse already sitting at this very table is drawn into the pool routinely, most often in a club with a small fleet. That is the `already_seated` population the ledger sees at read time. On 2026-09-10 all 199 open seat-first games had a table capacity equal to their tournament capacity, so a `table_full` answer today is always a race: GameServer discovery, the scheduler and the overlay guard each own a seeder and fill the same game on the same tick. The ledger cannot see that at read time, which is why the RPC's own `table_full` answer is fed back into it.

## Evidence in the engine log

One line per fill pass that had candidates:

    [TournamentRecurring] seat-first-precheck <id8>: rpc_called=N skipped_already_seated=N skipped_table_full=N seated=N rpc_already_seated=N rpc_table_full=N rpc_refused=N rpc_other_noop=N

`skipped_*` are lock acquisitions that did not happen. `rpc_already_seated` and `rpc_table_full` are the residue the ledger could not see (the race within a tick); if those stay high the next lever is a per-process in-flight guard so the three seeders do not fill one game concurrently, which this change deliberately does not add.

## Expected effect

At least 60% of the 1,533 calls per 46 minutes were no-ops. Removing the ones the ledger can see (seated pool draws, and every spare candidate after a `table_full`) should cut the RPC's call count by roughly half and remove that share of exclusive acquisitions from the hand-settlement convoy: about 12 minutes of lock-queue time per hour for the horse calls alone, with correspondingly fewer hand-commit stalls. The remaining calls keep their 590 ms mean until the convoy itself shrinks; the number to watch is `calls` for `fn_seat_horse_in_seat_first_game` in pg_stat_statements per hour against the seat count, and the ratio of `seated` to `rpc_called` in the log line, which should move toward one.

## How verified

`server/src/services/seatFirstSeatPrecheck.test.ts` (24 tests): the ledger reproduces the RPC's capacity expression and both refusal conditions; `topUpWithHorses` run against a mocked client with the candidate pickers stubbed shows a seated horse is never sent to the RPC, an unseated horse goes through the same RPC with `{ p_tournament_id, p_user_id }` exactly as before, a table the rows show full gets no call, an unreadable table row still calls, a `table_full` answer stops the spare candidates, and a stale `already_seated` answer is not counted as a fill; source pins hold the pre-check ahead of the call, `continue` not `break`, no `is_horse` in the path, and the log line. The neighbouring pins (`seatFirstFillOrder`, `seatFirstCountSync`, `aClubBoardFillsFromItsOwnMembers`, `theFreezeIsTotal.law`, `MaintenanceEntrySerialization.guard`, `theSpinTreasuryAndTheStack.law`, `pickFreeHorsesLimits`, `ProducerShutdownOwnership`, `seatFirstHoldRotates`, `seatFirstStartStall`) pass, 153 tests, and `tsc --noEmit` is clean.

Read-only production probe 2026-09-10: `pg_get_functiondef` of `fn_seat_horse_in_seat_first_game` and its two inner layers confirmed the seat check is `table_seats (table_id, user_id) WHERE left_at IS NULL` and the free-seat search is `generate_series(1, COALESCE(NULLIF(tables.max_players,0), tournaments.max_players, 3))` against `(table_id, seat_number) WHERE left_at IS NULL`; the ledger copies both. Across the 199 open seat-first games no table capacity differed from its tournament's and no live seat sat outside `1..capacity`.
