# 2026-09-05 - The Must Move Lobby: a seat change, the order you joined, and the floor is for winners

Operation Table Stakes, after `2026-09-05-the-move-survives-the-hand-and-a-game-seats-you-once.md`.

Dan: "EACH AND EVERY PLAYER GETS A SEAT CHANGE BUTTON WHEN THEY SIT DOWN AT ANY
'FEEDER GAME', AND ARE ALLOWED TO USE IT ONCE TO CHANGE TABLES. (NEVER TO THE
MAIN GAME) ... IF THERE ARE NO SEATS ... THEY BECOME '1ST ON THE LIST' ... IF
TWO PEOPLE WANT TO CHANGE TABLES, YOU SWITCH THOSE TWO PLAYERS. PLAYERS SHOULD
ALSO BE ABLE TO REQUEST A SPECIFIC FEEDER TABLE ... (SEAT CHANGE ALWAYS RE POSTS
THE BB WHEN GETTING TO A NEW TABLE). IF THEY ARE AUTO MOVED, NO POST ... YOU
ALSO NEED TO RECORD AND POST THE ORDER OF WHEN A PLAYER 'JOINED THE GAME' THATS
THE MUST MOVE ORDER ... IF THEY LEAVE A TABLE AND JOIN THE SAME GAME AND STAKES
AGAIN, THEY GO TO THE BOTTOM OF THE LIST, BUT RATHOLE PROTECTION IS IN PLACE."
And: "RATHOLE ONLY APPLIES TO WINNING PLAYERS."

"The main game" is Main 1. Every other table of the game (the feeder and the
Mains promoted from it) is a feeder game in Dan's words.

## SQL - `20260905060000_the_must_move_lobby_a_seat_change_and_the_order_you_joined`

Applied to production 02:43 UTC in five lock-timed transactions (two additive
ALTERs, the two tables, the trigger, the functions); Part 2c probed rolled back
on the real rows first (`scripts/dev/probe-must-move-lobby.sql`, 10/10:
roster order, Main 1 draws from the whole list, moved entry, seat change now,
the refusals, listed then swap planned, swap executed both sides, cancel and
rejoin-to-bottom, winner-only floor, the lobby read). 78/78 games ticking on
the new body within 12 s of the apply.

1. **The roster** (`cash_game_roster`): one open row per player per game from
   the first chair to the last, `joined_at` carried across every move (the
   executor declares itself; the AFTER trigger on `table_seats` lets a
   declared move through and can never refuse a seat). Leave and come back =
   a new row at the bottom. 91 seated players backfilled.
2. **The must-move order is the roster.** The planner fills a **Main 1** seat
   from the WHOLE list (every table but Main 1) and a Main N seat from the
   feeder, both ordered by the roster's `joined_at` rather than the chair's,
   which reset on every move. `fn_cash_game_must_move_list(game)` posts it
   with positions; a player on Main 1 is off it.
3. **The seat change** (`cash_seat_change_requests`): once per roster row,
   from any table but Main 1 to any other table but Main 1, "any" or a
   specific one. `fn_cash_seat_change_request(game, to_table)`: a chair open
   now -> a `seat_change` move planned at once; none -> first on that table's
   list, and the tick (step 2b, after Main seats are filled and before a
   feeder is opened) gives the next unreserved chair to the list before
   anyone new. Two requests that would take each other's table are
   **swapped**: two moves linked by `swap_move_id`. `fn_cash_seat_change_cancel`
   gives the button back; leaving the game cancels the request; a move that
   dies puts the request back at its old place.
4. **The swap** (`fn_cash_seat_swap_execute`, routed from the executor): each
   side is executed at its own table's hand boundary; the first to arrive is
   marked `ready_at` and its player HELD out of the deal (not sat out), the
   second lands both chairs in one transaction and reports the partner. A
   swap is not a reservation: every count of pending moves to a table now
   excludes linked rows (open-seat door, planner, break step, fleet).
5. **Entry by reason.** `seat_change` arrives `entry_hold = 'waiting'`,
   `entry_post_agreed = true` (posts the big blind, held until clear between
   the button and the blind). `must_move` / `break` arrive `entry_hold =
'moved'`: dealt in on the next deal, nothing owed, the blind when it comes.
6. **The floor is for winners.** `fn_cash_session_close` wrote a rejoin floor
   for ANY stack above zero; it now writes one only above the session
   baseline (buy-in plus add-ons). 92 floors that closed sessions showed were
   written for non-winners were expired.
7. **`fn_cash_game_lobby(game)`**: the one read behind the lobby - every table
   with every chair and stack, the list, the waitlist count, per-table
   seat-change queues, and the caller's own state (position, pending move,
   seat change available / listed / used, waitlist place when not seated).

## Engine (same PR)

- `seatMoves.ts`: the third reason, swap and held fields, `SeatMoveOutcome`
  (done + held), the notices ("Seat Change Granted. Moving To Main 2 After
  This Hand." / "... Swapping To ...").
- `ServerTableEngineBase`: `heldForSwap` (out of the deal, out of the
  liveness count; released when the move is gone), `seat_move_held` event, a
  swap landed from this side tells the partner's table with a `seat_moved`.
- `ServerTableEngineDealing`: on arrival `entry_hold = 'moved'` is not
  registered as waiting and owes nothing; `waiting` + agreed goes through the
  standing post agreement. The gone-player prune releases a held side.
- `HorseFleetManager`: swaps are not reservations.
- `TheTablesOpenAndCloseThemselves.law.test.ts` 62 (+12). Server suite 5593.

## Client (same PR)

- **The Must Move box** (`CashClusterHUD`) in the upper-right corner of every
  must-move table, where the tournament level bar sits: MUST MOVE LOBBY,
  PLAYERS, TABLES, YOU ARE #N. The bar opens the lobby. Under it, **SEAT
  CHANGE** exactly while the database says it is available; "Seat Change:
  #N On The List" once listed; for a viewer holding a waitlist place,
  "Waitlist: #N Of M" and "Chair Open: Take A Seat" the moment one opens.
- **The Must Move Lobby** (`MustMoveLobbyModal`, the tournament lobby's 3/4
  geometry): the game with players / tables / waiting / must move, YOUR SEAT
  with the pending move stated in the engine's words and the seat change
  (Request Any Table, Cancel Request, used), every table with lifecycle,
  seated/max, every chair's name and stack, the queue on it and REQUEST on
  the tables a change may go to, and the must-move list in join order.
  Polled every 5 s while open (the tick's cadence).
- **JOIN GAME** on a must-move row calls `fn_cash_game_join` (shortest live
  Main with an unreserved chair, then the feeder, else the game waitlist with
  "The Next Table Opens When One More Player Sits") instead of opening Main 1.
- **The tab follows the chair**: an embedded TablePage reports
  `movedToTableId` and MultiTablePage re-points that tab in place (never
  `activeIndex`); a standalone page navigates as before. Fixes "seat_moved
  opens a second tab".
- **The lobby chain select keeps the game columns**: it selects
  `cluster_id, role, main_index, lifecycle` itself and overlays onto the rows
  on screen instead of replacing them, so `cluster_players` / `cluster_tables`
  from `get_club_home` survive and feeder / Main 2 rows no longer leak back
  onto the board ~300 ms after first paint.
- `tests/must-move-lobby.test.tsx` 13.

## Still owed

Placard 375 px squash (style / rules lines at 7 px); a "moving in N hands"
countdown; horses using the seat change like humans (same button, same once,
same list); presence not carried across a move; the break/fleet fight.
