# 2026-09-05 — The first live autonomy cycle, and the two defects it showed

Operation Table Stakes, after `2026-09-05-cluster-autonomy-live-audit.md`
(#3021, live from the 22:55 UTC restart on engine `1c0fdb68`).

## What production did on its own

`cash_cluster_events`, NLH 0.10/0.25 Madness, nobody touching anything:

    23:20:49  move_planned  (must_move)      feeder -> Main 1
    23:20:49  seat_moved    stack 26.25, to seat 2
    23:25:51  table_break_started   seated_total 6, remaining_capacity 6
    23:25:51  table_break_completed
    23:25:58  feeder_opened

Move, break, open — the whole cycle the OPORD asked for, executed by the
tick. Also confirmed after the deploy: the 24 `retire_when_empty` flags the
old executor kept re-applying were cleared at 23:41:53 and had not returned
at 23:43:03 (BUG 2 of the audit holds); all 78 games tick within 30 s; the
controller has not stalled since BUG 4's fire-and-forget wake.

Read together, the last three lines above are a defect, and one row that is
not in the event log is a second one.

## BUG 5 — break and open contradict each other at the boundary (SQL, applied)

The break rule fires when everyone fits in the rest: `6 seated <= 6
remaining capacity`, i.e. Main 1 (6-max) exactly full. "Main exactly full"
is also the open rule's trigger (no unreserved seat, buyers >= 2). So the
tick that closed the empty feeder was followed seven seconds later by one
that opened a new one - the same table, a different row, every five minutes
for as long as Main stayed full. A card room with a full main and buyers
waiting keeps its feeder.

Fix: the break condition is strict - the rest must keep at least one seat
open (`v_seated_total < v_remaining_capacity`). The five-minute hysteresis
stays; the by-orbit hysteresis the OPORD intends is still owed.

## BUG 6 — the door lets you buy into a closed table (SQL, applied)

At 23:26:06, fifteen seconds after the feeder closed, a horse (coldcall
king) bought into it. `atomic_table_buyin` checks the buyer's wallet, ban,
VIP, VPIP, seat count and four-table cap and never the TABLE's own state.
The fleet reads the board once per cycle and seats over the next half-minute,
skipping closed tables in memory; the feeder closed between its read and its
write. Three cluster tables were in this state when I looked (two old FLO8
Main 1s and this feeder), and a player on a closed table is invisible to the
census, so nothing would ever have planned them out.

Fix, two parts, both in `20260905040500_the_break_keeps_a_seat_open_and_the_door_refuses_a_closed_table.sql`:

- A `BEFORE INSERT` trigger on `table_seats` refuses a seat on a cluster
  table whose lifecycle is `breaking` (18.3: no new sit-ins) or `closed`,
  whoever asks and whichever RPC they came through
  (`TABLE_CLOSING: this table is closed and takes no new players`). Cluster
  tables only; fleet and tournament tables have no lifecycle to refuse on.
- The tick turns a closed table that still has a live seat back into
  `breaking` (`closed_table_reopened_to_break`); the census sees it, step 5
  plans everyone off, and it closes again when empty. Self-healing rather than
  a manual cashout, because the class recurs whenever any hole in the door
  opens.

Probed in a rolled-back transaction on the real rows before applying: the
door refused `closed` and `breaking` and admitted `live`; one tick on the
game returned `reopened_to_break` for the feeder and planned coldcall king
onto Main 1 (`must_move`). The function body is the live one (md5
`d5603c58…`, byte-identical to `20260905030000`) plus exactly those edits;
the migration's assertions pin all three.

## What the self-heal showed next (00:00–00:10 UTC)

At the 00:00 thaw the tick turned the closed feeder into `breaking` and
planned its player onto Main 1 at 00:00:06. The engine executed at once and
the seat was refused - fourteen times in seventy seconds:

    FOUR TABLE LIMIT: user a7bdfc35-… is already committed to 4 games

## BUG 7 — a move within one game counted as a fifth game (SQL, applied)

`fn_enforce_four_table_limit` counts live seats and tournament bookings and
never asks whether the insert is a MOVE. This horse held two seats and three
bookings (5 - already over the cap, which is its own question), so even
subtracting the chair being left refused him. A player who already holds a
live seat elsewhere in the destination's cluster is changing chairs; the cap
does not apply to a move at all, because refusing one strands them on a
breaking table. `20260905041000_a_move_within_one_game_is_not_a_fifth_game.sql`.

## BUG 7b — a refused move was re-planned every five seconds (SQL, applied)

The planner skipped only PENDING moves; a refused one is `cancelled`, so the
same player was planned again on every tick - ~17,000 rows a day per stuck
player. Both planners (must-move and break) now leave a player alone for
60 s after a cancelled move. Measured: one plan per minute from 00:06:06.
Same migration.

## BUG 7c — the closed-table door had a revive hole (SQL, applied)

`table_seats` keeps departed rows and (table_id, seat_number) is unique, so
most sit-downs are an UPDATE setting `left_at` back to NULL. 040000's guard
was BEFORE INSERT only. A second trigger now covers the revive, same shape as
`zz_restriction_seat_revive_guard`. Same migration.

## BUG 8 — the executor emptied the old chair before taking the new one (SQL, applied)

With BUG 7 fixed the move was still refused once a minute: `fn_cash_seat_move_execute`
set `left_at` on the source seat BEFORE writing the destination, so at the
instant the cap trigger ran the player held no live seat in the game and the
move exemption could never be true. Order is now new chair, then old, in the
same sub-transaction with the same stack-to-zero-before-leave.
`20260905042000_the_new_chair_first_then_the_old.sql`. Probed rolled-back on
the real move (25.93 landed on Main 1 seat 1), then applied; production then
did it on its own at 00:10:15–00:10:21: `move_planned → seat_moved →
table_break_completed`. Feeder closed empty, Main 1 at 2.

Two more seats on closed tables were on Main 1s of DISABLED duplicate ladder
rows (`FLO8 0.50/1 Action` ×2, `FLO8 1/2 Action`), which the controller never
ticks; cashed out through `fn_cashout_seats_for_closing_table` (59.78 and
90.00 returned to the horses' wallets). Zero seats on closed cluster tables
at 00:12 UTC.

Every live-tick function body applied tonight is byte-identical to its
migration file (md5 checked after each apply): tick `d2d98f17…`, executor
`f45f6f09…`.

## Still owed

- Break hysteresis by orbit, not five minutes (OPORD intent).
- Gate 4: one lobby card per game, the cluster waitlist client, JOIN GAME
  auto-seat.
- `ensureCashTableEngine` resolves when the engine can deal, not when it
  exists; `GET /state`, `GET /actions` and the WS `ensureTable` still hang
  on a one-player table.
- The probe script (`scripts/dev/probe-cluster-controller.sql`) has no case
  for either defect here; it needs a "Main exactly full, feeder empty" board
  and a "seat on a closed table" refusal.
