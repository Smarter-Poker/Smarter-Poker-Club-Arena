# A seat is read with its table, and a walk-in is entered by staff (2026-10-07)

The two browser-access holes left over from the security fixes Dan approved on
2026-10-06 (#6302, #6303). Decided by Claude on Dan's delegation.

## What was wrong

- **Every signed-in account could read every seat.** `table_seats` carried
  "Public read access" (`FOR SELECT TO PUBLIC USING (true)`). #6303 took the
  read away from a browser with no account, but any signed-in account - free
  to create - still read all 1,441,223 seats: who sits at which club's table,
  and with what stack.
- **A browser with no account could write a Commander walk-in.** The insert
  policies on `commander_waitlist` and `commander_tournament_entries` admitted
  any row with `player_id IS NULL` (a walk-in), to every role, and anon held
  INSERT on both tables. Any signed-in account could do the same.

## The fix

Migration `20261007034527_seat_map_in_scope_and_walk_ins_need_staff.sql`, one
transaction:

- "Public read access" is replaced by `seat_read_with_table_or_own`, for signed-in
  users only: a seat is readable if its table is readable to the caller, or it
  is the caller's own seat. The table check runs under the caller's own row
  security on `tables`, so no new visibility rule exists: club tables stay with
  their club's members, union tables with the union's members, the Diamond
  Arena's tables with every signed-in player, and a player always sees their own
  seats. `union_overseer_read` and the service-role policy are unchanged.
- Both Commander insert policies move to signed-in users and lose the
  `player_id IS NULL` branch: a row is the player's own, or is written by active
  staff of that venue (which is how a walk-in is entered). anon's INSERT, UPDATE
  and DELETE on both tables are revoked.

## Why nothing in the product breaks

- Every client read of `table_seats` (20 call sites) asks either for the
  caller's own seats or for the seats of a table the caller has already read
  with its own rights. The caller's-rights view and functions that count seats
  all join `tables` under the same rights, so their answers do not change.
  Definer functions, the engine and the backup role do not go through this
  policy; `table_seats` is in no realtime publication.
- Every Commander insert is a server route of the Commander app using the
  service-role key (set in its production environment), which bypasses both the
  grants and the policies. No browser path, database function or edge function
  inserts into either table.

## Proof

Rehearsed against production in one rolled-back transaction, with role probes
for a club member, a signed-in account with no club, a player of another club,
an anonymous browser, a non-staff player and an active floor manager; results
and the lobby seat-map timing are in the pull request.

## Law

`tests/seat-map-in-scope-and-walk-ins-need-staff.law.test.ts`.
