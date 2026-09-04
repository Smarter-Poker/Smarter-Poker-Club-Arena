# 2026-09-05 — The tables open and close themselves (Slice 2 + Slice 6, Gate 3)

Operation Table Stakes, Gate 3. OPORD 1.3 sections 9.2, 9.5, 9.8 as amended
by OPORD 1.4 section 18. Follows `2026-09-04-cash-games-slice-1-hardening.md`.

Dan's question that started the operation: "HOW DO WE MAKE THE TABLES SMART?
TO OPEN AND CLOSE AUTOMATICALLY WITHOUT ANY HUMAN DOING ANYTHING EVER?" This
is the answer, for every must-move game (R9): a controller on the leader
ticks every 5 seconds and one SQL function derives every decision from rows.

## What a must-move game does now, with nobody touching it

- **Main 1 is always there.** If anything closes it while the game is
  enabled, the next tick reopens it (R3), and the two row flags that used to
  carry that are gone from cluster tables.
- **A seat opening on a Main pulls the longest-seated player off the
  feeder** (1.3 s9.5). The controller plans the move; the player's engine
  tells them once at the start of the next hand - "Seat Open On Main 2.
  Moving After This Hand." - and executes it at the end of it. Chair, chips,
  chip-continuity session (baseline, clock, window) and seniority (joined_at)
  all travel. No wallet is touched. A player is never asked anything. Their
  browser follows them to the new felt.
- **A feeder opens** when every live table is full and there are two buyers
  (a human on the game waitlist, or a horse the fleet could seat - Law 10.5).
  One buyer holds for 60 s; no ghost table.
- **A feeder goes live at two seated**, and the feeder before it becomes
  Main N+1.
- **The newest table breaks** when everyone fits in the rest at the floor (3
  per table on 6-max, 4 on 9-max) and that has held for 5 minutes. Its
  players are moved at their hand boundaries; when the last chair empties
  it closes. Main 1 is never the candidate. One failure of the condition
  resets the window.
- **Roles renumber**: oldest is Main 1; with two or more tables and no
  feeder, the newest becomes the feeder.
- **live | dormant is derived**: zero seated and zero eligible horses is
  dormant; anything else is live.
- **enabled = false**: no opening; empty tables close.
- **The freeze** stops the controller before any I/O and the SQL again; the
  thaw gives back `break_eligible_since` and pending-move expiry (18.5).

## Migrations on production

| version        | name                       | applied   | how                                                                          |
| -------------- | -------------------------- | --------- | ---------------------------------------------------------------------------- |
| 20260905010000 | cluster_columns_slice_2    | 21:47 UTC | three lock-timed transactions; attempt 5 of a retry loop (see the lock note) |
| 20260905010500 | cluster_controller_slice_2 | 22:20 UTC | one transaction, functions only, after the probe                             |

**The lock note.** `public.tables` is in the realtime publication. An
`ALTER TABLE tables` asks for an exclusive lock on realtime's `subscription`
relation while a live realtime worker holds it and is waiting to read
`tables`: Postgres kills the migration as the deadlock victim. It happened on
the first two attempts (once with the whole DDL in one transaction, once
split). The columns file is therefore three small transactions with
`lock_timeout = '3s'` and an apply loop that retries; the functions file has
no table locks and was probed inside a rolled-back transaction first. A
probe that holds `ACCESS EXCLUSIVE` on `tables` for its whole run parks every
reader of `tables` behind it - never put an ALTER TABLE inside a probe again.

## Probe (rolled back): 23/23

`scripts/dev/probe-cluster-controller.sql`, owner 47965354-..., club
fade0000-...0001 (Midway Union), eight idle funded members:

```
CREATE main 1 via the cluster writer: ext=f restart=f lifecycle=live role=main idx=1 opened_at=t PASS
A6.9 empty + 0 horses: state=dormant PASS
A6.9 0 seated + 2 eligible horses: state=live PASS
SETUP main 1 seated=6 PASS
A6.2 one buyer: opening rows=0 hold=t PASS
A6.2 hold expired after 60 s: events=1 PASS
A6.1 two buyers: feeder=t lifecycle=opening name=Probe Cluster Feeder PASS
A6.6/idempotent: tables after a second tick=2 PASS
PROMOTE feeder at 2 seated: lifecycle=live live_at=t PASS
MUST-MOVE planned: player=t to=main1:t reason=must_move PASS
MUST-MOVE one plan per open seat: pending=1 PASS
MOVE executed: ok=true pending_seen_by_engine=1 at=main1:t stack=400.00 session_follows=t felt 3200.00->2800.00 exits_logged=0 wallet_rows=0 PASS
MOVE expiry: expired=1 re-planned pending=1 PASS
A6.4 break needs the window: eligible=t lifecycle=live PASS
A6.4 condition failed once: window reset=t PASS
A6.3 feeder breaks after the window and closes empty: lifecycle=closed status=closed PASS
A6.5 main 1 survives: main1 role=main idx=1 lifecycle=live; feeder=closed/closed PASS
EMIT break events=2 PASS
A6.10 disabled: no feeder opened with 9 buyers: opening=0 PASS
R3 main 1 reopened by the controller: live main 1 rows=1 PASS
A6.9 last seat emptied, no horses: state=dormant PASS
A6.8 thaw carries the cluster clocks: break_eligible=t move_expires=t PASS
A6.8 frozen tick: frozen PASS
```

(The felt 3200 -> 2800 is the one voluntary cash-out of 400 that opened the
seat; the move itself moved 400 and lost none.)

## Objects

- `tables` + `opened_at, live_at, break_started_at, break_eligible_since,
promote_pending`; `cash_games` + `opening_hold_since, last_tick_at,
last_tick_actions`.
- `cash_seat_moves` (planned by the tick, executed by the engine, 60 s
  expiry, one pending per player), `cash_game_waitlist` (the cluster
  waitlist; Gate 4 gives it a client), `cash_cluster_events` (every
  transition, as it was made).
- `fn_cash_cluster_open_table(game, role, main_index, lifecycle, by)` - the
  one writer of a cluster table; `fn_cash_game_create` opens Main 1 through
  it and no longer sets `auto_extension`/`auto_restart`.
- `fn_cash_seat_moves_pending(table)`, `fn_cash_seat_move_execute(move)`.
- `fn_cash_cluster_tick(game, eligible_horses)`, `fn_cash_clusters_to_tick()`.
- `fn_thaw_platform` + two steps. `fn_managed_game_contract_document`
  excludes the lifecycle columns; `fn_capture_managed_game_contract`
  survives A -> B -> A (see below).
- `server/src/cluster/ClusterController.ts` (5 s, leader, beside the
  fleet), `server/src/services/supabase/seatMoves.ts`,
  `HorseFleetManager.eligibleHorseCount(tableId)`, engine hooks in
  `ServerTableEngineBase` (announce / execute), `Settlement` (after the
  leavers) and `Dealing` (announce at deal start; execute on the idle
  tick). `TablePage` shows the notice to the one player and follows the
  hero to the new table on `seat_moved`.

## Two pre-existing hazards found and fixed on the way

1. **`fn_capture_managed_game_contract` raised on A -> B -> A.** The contract
   version ledger has a unique key on (kind, game, hash); a table whose
   contract returned to an earlier state (a feeder promoted and demoted, a
   name edited and edited back) hit that key and the whole UPDATE failed -
   every tick, forever. The trigger now `ON CONFLICT DO NOTHING` on that key
   and the document excludes the controller's lifecycle columns.
2. **`(table_id, seat_number)` is unique across departed rows**, so a chair
   that has been sat in before must be REVIVED (as `atomic_table_buyin`
   does), not inserted. The move does that.

## Scope, honestly

- Manages `cash_games.must_move = true` only. The fleet's `DEFAULT_TABLES`,
  `spawnOverflowTables`, `retireSurplusTables`, `fn_table_lifecycle_pass`
  and every hand-made (R9 manual) table are untouched until the Gate 7
  cutover; the fleet now explicitly keeps cluster tables out of its name
  families and seeds no breaking table.
- The break window is 5 minutes; the "2 completed orbits" alternative in
  18.3 needs an orbit counter the engine does not persist yet.
- A6.11 (rotator balance floor) and A6.12 (horse rejoin floor) are not in
  this slice. The rejoin floor is already enforced for horses and humans
  alike by `fn_cash_rejoin_floor` (Slice 0); the rotator rule is Gate 3
  follow-up.
- `eligibleHorseCount` is the fleet's last-cycle count of horses that could
  sit at Main 1 - 30 s stale at worst, which is the fleet's own cadence.

## Tests

- `server/src/cluster/ClusterController.test.ts` (12),
  `server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts` (22),
  registered in `docs/LAWS.md`.
- `theClubProgrammeMirrorsTheHouse` pin moved: the fleet's table select
  carries `cluster_id, lifecycle`.
- Server suite 374/374; client suite green (see the PR).
