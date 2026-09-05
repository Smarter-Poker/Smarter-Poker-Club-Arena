# 2026-09-05 — The deep dive: the move survives the hand, and a game seats you once

Operation Table Stakes, after `2026-09-05-the-break-keeps-a-seat-open-and-the-door-refuses-a-closed-table.md`.
Dan: "DO A DEEP DIVE AND BUG HUNT ON EVERYTHING YOU'VE BUILT TODAY ... THE WAY
THAT THE FEEDER GAMES START, ADVANCE, MOVE PLAYERS, EXPAND TO MORE PLAYERS."

Everything below was read from production rows and the live function bodies,
not from the tests or the probe. Same branch as #3035, which was red on CI for
two reasons (the FourTableLimit pins now resolve to the 041000 migration, which
redefined the cap function without carrying the trigger, and
`fn_refuse_seat_on_closed_cluster_table` was undeclared in
`scripts/ci/schema-manifest.d/`); both are fixed here.

## What production showed at 00:45 UTC

NLH 0.10/0.25 Madness: Main 1 with ONE player, the opening feeder with ONE
player (a horse), and seventeen `must_move` rows for that horse in
`cash_seat_moves`, one a minute since 00:28, every one `expired`. Two players
in one game, each alone at a table, neither able to play. Then at 01:35 the
same game showed one horse (charles leclercq) holding a chair on Main 1 AND a
chair on the breaking feeder, seated at both by the fleet, and a refused move
cancelled every minute since 01:20 (`idx_unique_active_user_per_table`).

## SQL — `20260905050000_the_move_survives_the_hand_and_a_game_seats_you_once` (applied 01:44 UTC, one transaction, probed rolled-back on the real rows first)

1. **A move lived sixty seconds; a hand often lasts longer.** Planned mid-hand,
   a move had to survive the rest of that hand plus one whole hand. Default
   TTL is three minutes; `fn_cash_seat_move_announce(uuid[])` stamps
   `announced_at` and extends to five minutes when the engine tells the player;
   `fn_cash_seat_moves_pending` returns `announced_at`.
2. **A busted player was moved with nothing.** Planner skips `stack <= 0` and
   `leave_pending`; executor cancels `busted`.
3. **The move carried the wrong entry state.** Mover starts `entry_hold =
'waiting'`, `entry_post_agreed = false` (Dan 2026-08-26: wait for the BB or
   post). A revived chair starts dealt in, as an inserted one already did.
4. **The move exemption was a second-seat door.** The executor declares itself
   (`set_config('app.cash_seat_move', 'on', true)`); `fn_enforce_four_table_limit`
   exempts that and only that; `fn_refuse_seat_on_closed_cluster_table` refuses
   a second live seat in one game (`ALREADY_IN_GAME`) on insert and on revive.
   The planner never plans a player onto a table they sit at. A second chair
   already on a breaking table goes home through the table-close cash-out
   (`atomic_seat_cashout_locked(..., 'forced')`, `second_chair_cashed_out`).
   Live ten seconds after the apply: 26.25 credited to the horse's wallet
   (`credited: true`, key `cashout:d431cbee…`), the empty feeder closed, the
   one-a-minute churn stopped.
5. **An opening feeder nobody came to never closed.** Three minutes empty ->
   `feeder_abandoned`, `promote_pending` withdrawn, OPEN waits two minutes.
6. **Madness anted a big blind from every seat.** "Big Blind Ante" is the
   format where the big blind posts one ante for the table.
   `fn_cash_cluster_open_table` never set `big_blind_ante_enabled`, so the
   engine ran `per_player` with `ante = bb`: on a 6-max, six blinds in the pot
   before a card. Writer fixed; 27 live Madness tables backfilled (engines
   read the row at their next boot; the :55 restart at the latest). This is
   my call on the open question from earlier tonight — the template's own
   words say BB ante — and it is one row per game for Dan to change.
7. **Pre-Slice-2 Main 1s still carried `auto_restart`** (a zombie second Main 1
   via `fn_table_lifecycle_pass`) and 28 cluster rows still carried the Stable
   Hand's `retire_when_empty`/`night_parked`; both backfilled off.

Probe results, rolled back: second chair cashed out (+26.25 to the seat's
club wallet, session closed `system`), feeder closed on the next tick,
abandoned feeder closed and not reopened with 5 buyers inside two minutes,
`ALREADY_IN_GAME` refused an insert and a revive, the GUC path passed the door
and the cap, the executor landed 12.50 with `entry_hold = waiting`, no stack
exit logged, GUC reset after the call, `busted` cancelled.

## Engine (this PR)

- **The wait-for-players loop executes pending moves** (`ServerTableEngineBase`
  start loop). The root of the 17 expired rows: a lone player on a feeder
  waits in that loop, and the move was executed only from the dealing loop,
  which the table never reaches.
- **Announce immediately before the deal; execute announced moves only at
  settlement; execute everything in the idle branch.** The announce used to
  run at `load_seats` on every iteration and the execute in the `leave_pending`
  sweep on every iteration, so a move planned between hands was announced and
  executed milliseconds apart, before the hand the notice named; a move
  planned mid-hand landed unannounced. `announcePendingSeatMoves` writes the
  announcement to the row (`announceSeatMoves`) so a slow hand cannot expire
  it; the idle branch (`idle_seat_moves`) lands any pending move.
- **`eligibleHorseCount` was stale and never reset.** Written only for a
  table with a seat to fill; a FULL Main 1 - the one state in which the OPEN
  rule needs the number - reported whatever it had the last time it had room,
  for ever. Built fresh per cycle (`nextEligible`), swapped whole; a cluster
  table with nothing to fill runs the candidate filter in `countOnly` mode.
- **One seat per game in the fleet's candidate filter** (`clusterByTableId`),
  matching the database door.
- **A planned arrival holds its seat**: pending `cash_seat_moves` count as
  occupied when the fleet seeds a table, so a feeder player is not beaten to
  the Main seat they were planned onto. Mains are seeded before the feeder.
- **Discovery re-checks the engine map after `claimTable` and the stagger
  sleep**, so a controller wake landing inside that window cannot put a
  second engine on one Main 1.
- **The rotator's retirement drain and the 4-hour stale-seat sweep skip
  cluster tables** (a moved player carries `joined_at`, so a 4-hour session
  moved onto a quiet feeder read as an orphan).
- **An engine on a closed, empty cluster table stops itself**
  (`stopIfClusterTableClosed`, once a minute while empty).

Tests: `TheTablesOpenAndCloseThemselves.law.test.ts` 50 (was 22 + 8 + 2; pins
moved with the mechanisms, plus a suite on the 050000 file);
`theClubProgrammeMirrorsTheHouse` two pins moved (fleet select, rotator
select + cluster skip); `FourTableLimit.test.ts` 18/18 against the new
definer.

## Manifest

`scripts/ci/schema-manifest.d/cluster-break-boundary-and-closed-door.json`.

## Still owed (found tonight, not built tonight)

Client: the lobby's chain select drops the cluster columns ~300 ms after
first paint (feeder/Main 2 rows leak, style filter empties); `seat_moved`
navigates from an embedded TablePage and opens a second tab; JOIN always
targets Main 1 and nothing writes `cash_game_waitlist`; no in-table game
list for cash clusters (Dan's corner box); the placard's 375 px override
squashes the style/rules lines to 7 px. Server: the break rule and the fleet
fight (the fleet refills within 30 s of a seat opening, so the 5-minute
window never completes while horses are available) - a decision for Dan; a
table-level waitlist hold pre-empts must-move; presence is not transferred
across a move (the client re-subscribes).
