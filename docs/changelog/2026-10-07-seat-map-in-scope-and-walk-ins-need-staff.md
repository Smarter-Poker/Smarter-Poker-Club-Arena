# A seat is read with its table, and a walk-in is entered by staff (2026-10-07)

The two browser-access holes left over from the security fixes Dan approved on
2026-10-06 (#6302, #6303). Decided by Claude on Dan's delegation.

## What was wrong

- **Every signed-in account could read every seat.** `table_seats` carried
  "Public read access" (`FOR SELECT TO PUBLIC USING (true)`). #6303 took the
  read away from a browser with no account, but any signed-in account - free
  to create - still read all 1,441,223 seats: who sits at which club's table,
  and with what stack.
- **Any signed-in account could write a Commander walk-in.** The insert
  policies on `commander_waitlist` and `commander_tournament_entries` admitted
  any row with `player_id IS NULL` (a walk-in), to every role. Measured in a
  rolled-back rehearsal: an account that is staff nowhere inserted a walk-in
  into a venue's waitlist and into a tournament's entries. anon held INSERT on
  both tables too; its attempt failed only by accident, on a helper function
  inside the staff check that anon may not execute.

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

## Proof (rolled-back rehearsals against production, 2026-10-07)

| Probe                                                               | Before                                  | After                     |
| ------------------------------------------------------------------- | --------------------------------------- | ------------------------- |
| Union member (no seats anywhere) reads a Midway Union table's seats | 9 of 9                                  | 9 of 9                    |
| Signed-in account with no club reads that table's seats             | 9 of 9                                  | 0 of 9                    |
| Same account reads a Diamond Arena table's seats                    | 6 of 6                                  | 6 of 6                    |
| Player of another club reads that table (whose row it cannot see)   | 9 of 9                                  | 1 of 9 (their own)        |
| That player reads all of their own seats                            | 202 of 202                              | 202 of 202                |
| Browser with no account reads seats                                 | refused                                 | refused                   |
| Lobby seat map for a running table, as a member                     | 9 of 9                                  | 9 of 9                    |
| No-account walk-in, waitlist / entry                                | refused by accident (a helper function) | refused (no INSERT grant) |
| Non-staff signed-in walk-in, waitlist / entry                       | inserted                                | refused (row security)    |
| Player's own waitlist row / entry                                   | inserted                                | inserted                  |
| Active floor staff walk-in, waitlist / entry                        | inserted                                | inserted                  |

## A policy statement locks the auth tables

Every CREATE/ALTER/DROP POLICY run as postgres takes ACCESS EXCLUSIVE on all 23
tables in `supautils.policy_grants` (auth.users, auth.sessions,
auth.refresh_tokens, storage.objects, realtime.messages, ...) until commit,
whatever table the policy is on. The first rehearsal ran the Commander policies
first and then waited for `table_seats` while holding `auth.users`; the engine
holds `table_seats` and then checks a foreign key into `auth.users` when it
queues a hand's Daily Missions events, so the two deadlocked. The rehearsal
rolled back, and three horses' Daily Missions events were not queued
(`fn_enqueue_hand_daily_missions` caught the error and warned): hand
31742540-51b3-443c-91b0-28e573bf55f2 for 2e49e7e8-346a-49ba-91d3-699f1d9e0d6a,
hand 368ad968-3d0a-4bf2-b388-cb92f6e1c078 for
17e2a4ff-a54a-473d-9982-f7b41a22a9c5, and hand
db650997-3668-43b1-baff-374d9f36ebc0 for 5eaede5f-ddbe-4d8b-b143-d9ec2bd4dd23
(04:05:21 UTC). Not repaired here.

The migration now takes `LOCK TABLE public.table_seats IN ACCESS EXCLUSIVE
MODE` first, while it holds nothing anyone else needs, with a 500 ms ceiling,
and only then runs the policy statements with a 250 ms ceiling. Both are under
`deadlock_timeout` (1 s), so if anything is in the way this transaction gives
up first and no engine transaction is the one that fails. Rehearsed that way:
the whole transaction, probes included, took 329 ms, with no deadlock, lock
timeout or lost event in the database log.

## Law

`tests/seat-map-in-scope-and-walk-ins-need-staff.law.test.ts`.
