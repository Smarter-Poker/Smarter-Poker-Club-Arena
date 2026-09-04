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

Fix, two parts, both in `20260905040000_the_break_keeps_a_seat_open_and_the_door_refuses_a_closed_table.sql`:

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
