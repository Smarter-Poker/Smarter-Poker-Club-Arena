# The boards that broke the tick this week are a rolled-back probe harness (2026-09-05, 16:05 CDT)

Branch `fix/the-thaw-arrives-in-installments`, commit 2 of 3. Files:

- `scripts/dev/probe-cluster-boards.sql` - the ten boards
- `scripts/dev/probe-cluster-boards.sh` - the runner (`npm run probe:cluster`)
- `package.json` - the `probe:cluster` script

## What it is

`fn_cash_cluster_tick` was fixed seven times on 2026-09-05 between 03:50 and
15:05 CDT. Every fix started from a board found live and was proven the same
way: a hand-written psql transaction that built the board, ran the tick, read
the result and rolled back. The changelog for that day
(`2026-09-05-the-break-counts-orbits-not-only-minutes.md`, "How it was
proven") describes each of those transactions; none of them was kept. This
harness is those boards written down, plus the three the afternoon added, so
the next change to the tick runs all ten in one command and the pass/fail is
printed rather than remembered.

## Why it is not vitest

The tick is 36 KB of PL/pgSQL driven by `fn_cash_cluster_census`, a dozen
BEFORE/AFTER triggers on `tables` and `table_seats` (the closed-table door,
the one-chair-per-game door, the four-table limit, the seated-table close
guard, the auto-cashout on close) and the real ruleset snapshots. None of that
loads into vitest, and a TypeScript re-implementation of the tick would prove
the re-implementation. The only thing that proves the tick is the tick, on
the real schema, against real games. So the harness is psql, and it runs
against production.

## Everything rolls back

Each board is its own `BEGIN ... ROLLBACK`. Assertions are `RAISE EXCEPTION`
inside a `DO` block, so a failed expectation aborts psql (`ON_ERROR_STOP`,
set both in the file and on the command line by the runner) with the open
transaction rolled back by the server when the session ends. There is no
`COMMIT` in the file. Helpers live in `pg_temp` (CLAUDE.md 11.5 rule 4).

Checked after the run below, on production: 0 new `tables` rows for the two
dormant games the boards built on, 0 `cash_cluster_events` for them in the
window, 0 `hand_history` rows with the synthetic summary, the second-chair
player still holds exactly one live seat and none on the second table, the
Main 1 the boards filled to 9/9 is back to `live/waiting/max_players 9`, and
the table whose `current_players` was set to 99 and 0 reads its seat count.

## What a board may touch

A REAL enabled must-move game, chosen by query at run time. Boards that need
players build them on a DORMANT game (Main 1 open, nobody seated, house board)
so the `FOR UPDATE` the tick takes on `cash_games` never stalls a game people
are playing - `fn_cash_clusters_tick_all` walks every game in one pass and
would wait on that lock. The two boards that must read a live game (8, the
second chair; 10, the headcount column) hold their transaction for well under
a second.

Writes, all rolled back: `tables` rows of the chosen game (status, lifecycle,
max_players, break_eligible_since, current_players); `table_seats` ONLY by
INSERT of copies of live seats from other games, so every door trigger runs
and a refusal is data, not a failure (the four-table limit refused 22
candidates on the first run because it counts tournament bookings too; the
picker now asks `fn_concurrent_game_load` first); synthetic `hand_history`
rows (a copy of a real cash hand with a new id, the candidate table, an empty
player list so the stats triggers have nothing to attribute, and a
hand_number under 1,000,000 so the global unique index is never touched); new
cluster tables through the controller's own `fn_cash_cluster_open_table`.
Never clubs, wallets or chip balances directly: the one board that reaches a
wallet (8b, the second chair cashed out on a waiting table) does so through
the tick's own path, checks the stack arrived (1.90 chips, 13810.44 ->
13812.34) and `fn_unaccounted_seat_exits()` is empty, and is rolled back with
everything else.

Two shapes had to be built the only way they can be, and the file says so:

- Board 2, a live seat on a closed table: the door refuses a seat on a closed
  table, and the status path both refuses to close a seated table
  (`fn_guard_managed_game_lifecycle`) and would cash the seat out
  (`trg_tables_auto_cashout_on_close`). The shape that reached production is
  `lifecycle = 'closed'` with status untouched, and that is what the board
  sets.
- Board 8, the second chair: the door refuses it (`ALREADY_IN_GAME`), and that
  refusal is the first assertion. To prove the tick's reconcile the board then
  seats the chair with the executor's own `app.cash_seat_move = on` flag, the
  way the pre-door fleet effectively did, and runs the running-table case in a
  sub-block it undoes before the waiting-table case. Seat rows are unique per
  (table, seat) and a departed one is revived by UPDATE; since this board only
  INSERTs, it picks a seat number with no row at all.

## The runner

Reads `SUPABASE_DB_PASSWORD` from the environment, else from this checkout's
`.env`, else - in a worktree, which has none - from the main checkout's (the
directory holding the shared `.git`; `CA_ENV_FILE` overrides). Refuses to run
without it, never prints it, and hands it to libpq through `PGPASSWORD` so it
is never on a command line. Connects to the direct host first; when that
refuses the connection (it did for the whole afternoon of 2026-09-05, IPv6
only, while the database itself was fine) it falls back to the Supavisor
SESSION pooler on 5432, which holds a real session so `BEGIN ... ROLLBACK`
still spans a board. Never the transaction pooler (6543): 11.5 rule 1.

The preamble stops if `fn_platform_frozen()` is true (the tick returns
`skipped: frozen` during the :53-:00 break and every board would fail for the
wrong reason) and prints the md5 of the tick body it is about to probe.

## The run (production, 21:04 UTC, every transaction rolled back)

Condensed: `CREATE FUNCTION` / `DO` / `BEGIN` / `ROLLBACK` echoes and the 22
door-refusal notices removed; everything else verbatim.

```
probe-cluster-boards: 2026-09-05T21:04:23Z UTC, direct host first
probe-cluster-boards: direct host unreachable (psql: error: connection to server at "db.kuklfnapbkmacvwxktbh.supabase.co" (2600:1f13:838:); using the session pooler

================================================================
fn_cash_cluster_tick: the ten boards (all rolled back)
================================================================
fn_cash_cluster_tick body md5 5433f92b25cb592c5d9de007b4a94110 ; 120 enabled must-move games ; 17 dormant on house boards

---- BOARD 1: Main 1 exactly full + an empty live feeder: the feeder does NOT arm (strict fit, 20260905040500)
      game 7058024f-22d1-4d61-9233-7fca657ef9c0 : Main 1 58b2c844-9057-445e-ae0b-7850edcf9078 seated 6/6 ; empty live feeder 0ededdcf-7450-4d63-a6bf-c9d760fcda18
      tick: seated=6 tables=2 actions=[{"state": "live"}]
PASS  a full Main 1 (seated_total = capacity) does not arm the empty feeder
PASS  the feeder is still live
PASS  no table_break_started
PASS  the tick opened nothing (one feeder_opened is ours)
      tick: seated=6 tables=2 actions=[{"break_eligible": "0ededdcf-7450-4d63-a6bf-c9d760fcda18"}]
PASS  with one seat kept open on Main 1 (seated_total < capacity) the empty feeder arms
     rolled back

---- BOARD 2: a live seat on a CLOSED table: the tick puts it back to breaking and plans the player out (closed_table_reopened_to_break)
      game 7058024f-22d1-4d61-9233-7fca657ef9c0 : feeder 0d1f994c-0ffa-4695-a927-5f61fe721c1d lifecycle=closed status=waiting with player 6516567b-4394-404e-8170-e2a21dae7b48 on it
      tick: seated=2 tables=2 actions=[{"reopened_to_break": "0d1f994c-0ffa-4695-a927-5f61fe721c1d"}, {"moves_planned": 1}, {"state": "live"}]
PASS  the closed table with a seat is back to breaking
PASS  break_started_at is stamped
PASS  event closed_table_reopened_to_break
PASS  a move is planned for the stranded player onto Main 1 (reason must_move)
     rolled back

---- BOARD 3: the ORBIT arm: s seated, eligible 90 s ago; 2s-1 hands stays eligible, 2s hands breaks (20260905083756)
      game d9a2c707-1fad-4e5d-8bc4-ee3c39a0a7dd : feeder f0d61a00-ae19-4b44-bf97-333c4229a61b seated 2, eligible 90 s ago, 3 hands since
      tick: seated=3 tables=2 actions=[{"moves_planned": 2}, {"state": "live"}]
PASS  3 hands (2s-1) in 90 s: still live, still eligible since the same instant
PASS  no table_break_started yet
      tick: seated=3 tables=2 actions=[{"orbit": 2, "break_started": "f0d61a00-ae19-4b44-bf97-333c4229a61b", "hands_since_eligible": 4}]
PASS  4 hands (2s) in 90 s: breaking
PASS  table_break_started payload hands_since_eligible=4 orbit=2
PASS  and it waited less than the five-minute clock
     rolled back

---- BOARD 4: the CLOCK arm: eligible 6 minutes ago, fewer hands than an orbit pair: breaks
      game d9a2c707-1fad-4e5d-8bc4-ee3c39a0a7dd : feeder 2a18932c-a661-40fa-aabd-fb184925a1ce seated 2, eligible 6 min ago, 3 hands since
      tick: seated=3 tables=2 actions=[{"moves_planned": 2}, {"orbit": 2, "break_started": "2a18932c-a661-40fa-aabd-fb184925a1ce", "hands_since_eligible": 3}, {"state": "live"}]
PASS  breaking on the clock arm
PASS  payload hands_since_eligible=3 orbit=2 (3 < 4, so it was the clock)
     rolled back

---- BOARD 5: the EMPTY table arms first and closes in 60 s (20260905194840)
      game d9a2c707-1fad-4e5d-8bc4-ee3c39a0a7dd : Main 1 71d90586-8b99-4f88-8a88-4920447801b2 (1 seated), Main 2 9d8ef15b-0817-4689-99eb-f428e54ec42f (1 seated), feeder 41777250-ae3b-4582-906b-cbaf015e1452 (empty)
      tick: seated=2 tables=3 actions=[{"moves_planned": 1}, {"break_eligible": "41777250-ae3b-4582-906b-cbaf015e1452"}, {"state": "live"}]
PASS  first tick arms the EMPTY table
PASS  and not the 1-seat table
      tick: seated=2 tables=3 actions=[{"orbit": 0, "break_started": "41777250-ae3b-4582-906b-cbaf015e1452", "hands_since_eligible": 0}, {"closed": "41777250-ae3b-4582-906b-cbaf015e1452"}, {"demoted": "9d8ef15b-0817-4689-99eb-f428e54ec42f"}]
PASS  after 61 s the empty table is closed in the same tick it breaks
PASS  events table_break_started + table_break_completed
PASS  the 1-seat table is still live
     rolled back

---- BOARD 6: a lone live feeder with no live Main: promoted to Main 1 (feeder_promoted_to_main, reason no_live_main)
      game d9a2c707-1fad-4e5d-8bc4-ee3c39a0a7dd : Main 1 71d90586-8b99-4f88-8a88-4920447801b2 closed, feeder c6fccdf8-b310-4891-b004-7e43d6efac65 live with 2 seated
      tick: seated=2 tables=1 actions=[{"feeder_became_main1": "c6fccdf8-b310-4891-b004-7e43d6efac65"}, {"state": "live"}]
PASS  the feeder is main/1 live
PASS  event feeder_promoted_to_main {reason: no_live_main}
PASS  R3 opened no second Main 1 beside it
     rolled back

---- BOARD 7: R3 does not loop (20260905194329): a closed Main 1 next to a live table opens nothing; no live table at all opens exactly one, once
      (a) game d9a2c707-1fad-4e5d-8bc4-ee3c39a0a7dd : Main 1 71d90586-8b99-4f88-8a88-4920447801b2 closed, feeder fa8147e2-54a3-49d7-acef-654dc34d1c21 live and empty
      tick: seated=0 tables=1 actions=[{"feeder_became_main1": "fa8147e2-54a3-49d7-acef-654dc34d1c21"}]
      tick: seated=0 tables=1 actions=[]
PASS  (a) two ticks: main_opened = 0
PASS  (a) the game still has exactly one open table (1)
      (b) game d9a2c707-1fad-4e5d-8bc4-ee3c39a0a7dd : every table closed
      tick: seated=0 tables=1 actions=[{"main1": "opened"}]
PASS  (b) first tick: exactly one Main 1 opened
PASS  (b) it is main/1, live, waiting
      tick: seated=0 tables=1 actions=[]
      tick: seated=0 tables=1 actions=[]
PASS  (b) two more ticks: still one main_opened, still one open table
     rolled back

---- BOARD 8: a second chair in one game: the door refuses it; forced past the door, the tick settles it (20260905090006)
      game 6d0125c8-c055-4532-b48b-a8596ad3d68f : player d33a878b-e189-4bd4-aeb8-d9d4acf6cb34 seated on 0a405fe1-b74c-4127-add4-33f5343edde9 ; second table 9cfebc3f-691b-43a6-a177-9c5b1a84cda1 (running) seat 6
      door: ALREADY_IN_GAME: you already have a seat in this game - the game moves you between its tables itself
PASS  the door refuses a second chair in the same game (ALREADY_IN_GAME)
PASS  with the executor flag the second chair is seated (the pre-door shape)
      tick: seated=10 tables=2 actions=[{"second_chair_leave_pending": "d33a878b-e189-4bd4-aeb8-d9d4acf6cb34"}]
PASS  running table: the newer chair is flagged leave_pending for the hand boundary
PASS  event second_chair_leave_pending names the player
PASS  the older chair is untouched
      tick: seated=9 tables=2 actions=[{"second_chair_cashed_out": "d33a878b-e189-4bd4-aeb8-d9d4acf6cb34"}]
PASS  waiting table: the newer chair is cashed out now
PASS  event second_chair_cashed_out {where: reconcile}
PASS  the stack (1.90) went back to the club wallet (13810.44 -> 13812.34)
PASS  fn_unaccounted_seat_exits() has nothing for that table
PASS  the older chair is still theirs
     rolled back

---- BOARD 9: a disabled game closes its empty tables (table_closed_disabled) and opens nothing
      game d9a2c707-1fad-4e5d-8bc4-ee3c39a0a7dd disabled : Main 1 71d90586-8b99-4f88-8a88-4920447801b2 empty, feeder e1936244-6b34-4a28-8a99-03b61fa0c073 empty
      tick: seated=0 tables=2 actions=[{"break_eligible": "e1936244-6b34-4a28-8a99-03b61fa0c073"}, {"closed_disabled": "71d90586-8b99-4f88-8a88-4920447801b2"}, {"closed_disabled": "e1936244-6b34-4a28-8a99-03b61fa0c073"}]
PASS  the empty feeder is closed
PASS  event table_closed_disabled for it
PASS  every empty table of the disabled game is closed
PASS  nothing was opened (the one feeder_opened is ours)
     rolled back

---- BOARD 10: current_players follows the seats (20260905202112)
      game 37ac7634-69dd-434c-b947-bfcf8941ecf4 : table dbbc148e-384a-4c38-abb6-833b2d2847ff has 9 seats, current_players set to 99
      tick: seated=40 tables=5 actions=[]
PASS  after the tick current_players = 9 = the live seat count
      tick: seated=40 tables=5 actions=[]
PASS  and from 0 (the 22-tables-live shape) it is corrected the same way
     rolled back

================================================================
all ten boards passed; every transaction was rolled back
================================================================
```

## What the boards pin

| Board | Migration it guards | Shape                                                    | Expected                                                                                                                               |
| ----- | ------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 20260905040500      | Main 1 exactly full, empty live feeder                   | feeder does NOT arm; with one seat open on Main 1 it does                                                                              |
| 2     | 20260905040500      | a live seat on a `lifecycle = closed` table              | back to `breaking`, `closed_table_reopened_to_break`, move planned onto Main 1                                                         |
| 3     | 20260905083756      | feeder s=2, eligible 90 s, 2s-1 then 2s hands            | stays eligible, then breaks with `hands_since_eligible = 4, orbit = 2`                                                                 |
| 4     | 20260905083756      | eligible 6 min, 3 hands                                  | breaks on the clock arm, payload says 3 / 2                                                                                            |
| 5     | 20260905194840      | Main 1 (1), Main 2 (1), empty feeder                     | the EMPTY table arms first; 61 s later it breaks and closes in one tick                                                                |
| 6     | 20260905083756      | Main 1 closed, live feeder with 2 seated                 | `feeder_promoted_to_main {reason: no_live_main}`, no `main_opened`                                                                     |
| 7     | 20260905194329      | (a) Main 1 closed beside a live table; (b) no live table | (a) two ticks, 0 `main_opened`; (b) exactly one, and two more ticks add none                                                           |
| 8     | 20260905090006      | a second chair in one game                               | door refuses `ALREADY_IN_GAME`; forced past it: `leave_pending` on a running table, cashed out on a waiting one, older chair untouched |
| 9     | 20260905010500      | disabled game, empty tables, 9 eligible horses           | `table_closed_disabled`, nothing opened                                                                                                |
| 10    | 20260905202112      | `current_players` set to 99, then 0                      | follows the seat count both times                                                                                                      |

If a future change to the tick turns one of these red, the board names the
migration whose behaviour it re-broke.
