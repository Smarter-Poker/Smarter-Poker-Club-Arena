# Operation Table Stakes - current state and next actions (2026-09-05 02:45 CDT)

Read this before touching `fn_cash_cluster_tick`, `server/src/cluster/**`,
`server/src/services/HorseFleetManager.ts`, `HorseSessionRotator.ts`,
`SeatMovePresence.ts` or anything under `/hub/club-arena` that draws a cash
game. The plan is `docs/OPORD-1.4-AMENDMENT.md` (section 18 is the
autonomous lifecycle). The Gate 7 recon and Dan's options are
`docs/HANDOFF-TABLE-STAKES-GATE-7.md`. Every fact below was READ from
production or from GitHub at the time stamped above; nothing is assumed.

## 1. Where the programme stands

Gates 0-7 of the OPORD are built. Gates 0-6 are merged and live. Gate 7 is
applied in the database and open as a pull request in the repo (below).

| Gate | What                                                            | PR           | State                                        |
| ---- | --------------------------------------------------------------- | ------------ | -------------------------------------------- |
| 2-4  | Controller, tables open and close themselves (Slices 2 + 6)     | #3008        | merged, live                                 |
| -    | R10: a game counts its players, the fleet seeds it              | #3013        | merged, live                                 |
| -    | Four live defects from the first controller build               | #3021        | merged, live                                 |
| -    | Felt says Classic / Action / Madness; VPIP floor; add-on bubble | #3034        | merged, live                                 |
| -    | Lobby second line + Stakes menu                                 | #3027        | merged, live                                 |
| -    | The break keeps a seat open, the door refuses a closed table    | #3035        | merged, live                                 |
| -    | `ready` is not dealing (`ensureCashTableEngine`)                | #3036        | merged, live                                 |
| -    | The must-move lobby, seat change, join order                    | #3055        | merged, live                                 |
| -    | VPIP counts bomb pots, low-VPIP boot bars for two hours         | #3063        | merged, live                                 |
| 5    | The game snapshot is the rule on every table                    | #3066        | merged, live                                 |
| 6    | Join Game / View Game / Watch Game                              | #3066        | merged, live                                 |
| -    | An opening feeder is seeded first and to two; hold rests        | #3075        | merged, live                                 |
| -    | Deploy gate reaches the break; pins follow the gate             | #3070, #3079 | merged, live                                 |
| 7    | Every cash table is a game (Option A of the Gate 7 recon)       | #3090        | OPEN, auto-merge armed. DB side APPLIED.     |
| -    | Horses use the seat change, presence follows the move           | #3091        | OPEN, auto-merge armed. DB side APPLIED.     |
| -    | The lobby stops reloading under the player                      | #3061        | OPEN (another agent's, not this programme's) |

### The database is ahead of the engine, deliberately, until the next :55

Both open PRs carry migrations that are ALREADY applied and recorded in
`supabase_migrations.schema_migrations`:

- `20260905034937_gate_7_every_cash_table_is_a_game` - 41 games adopted
  from their tables, the CHECK that refuses a cash table with no
  `cluster_id`, the Stable Hand plans games instead of tables.
- `20260905064237_horses_use_the_seat_change_and_presence_follows_the_move`
- `20260905073614_the_seat_move_executors_are_engine_only_and_say_so` -
  added 2026-09-05 02:40 because `check-definer-authorization` refused
  the branch: `064237` re-declared `fn_cash_seat_move_execute` and
  `fn_cash_seat_swap_execute` with no GRANT/REVOKE. Production was never
  exposed (CREATE OR REPLACE keeps the ACL; `authenticated` could not
  execute either, verified with `has_function_privilege`), but a fresh
  database would have been. The new file records the lockdown.

The engine build that is running (`engine_leader.engine_version =
6688dea8`, leader since 01:59 CDT, three commits behind `main`) predates
both PRs. Consequences until the :55 cutover after they merge:

- The old `HorseFleetManager` still has `openPlannedTables` /
  `ensureAllTablesExist` / `spawnOverflowTables`. Any attempt to insert a
  cash table without a `cluster_id` is refused by the Gate 7 CHECK. That
  is the CHECK doing its job; expect refused-insert noise in the engine
  log until #3090 is in the running build, then zero.
- Horses will not press the Seat Change button until #3091 ships.
  `fn_cash_seat_change_request(p_user_id)` already honours the engine's
  `p_user_id` (gated on `fn_caller_is_engine()`), so nothing breaks; the
  behaviour is simply absent.

How to know the cutover happened: `engine_leader.engine_version` changes
at ~:58, and `curl -s https://smarter.poker/hub/club-arena/build-info.json`
`.ca_sha` equals the squash commit on `main`. Nothing else counts.

## 2. Production as read at 02:35 CDT

| Measure                                                  | Value                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `cash_games` rows / enabled / ticking in the last minute | 149 / 119 / 119                                                                                                                      |
| Games by state                                           | 97 live, 52 dormant                                                                                                                  |
| Cash tables outside a game                               | **0** (was 105 before Gate 7)                                                                                                        |
| Live cluster tables / seats on them / roster rows        | 149 / 303 / 298                                                                                                                      |
| Controller newest tick                                   | 02:34:39 CDT (ticks every 5 s, 8-wide pool)                                                                                          |
| Events, last 6 h                                         | move_planned 261, seat_moved 226, feeder_opened 81, feeder_live 12, feeder_abandoned 69, breaks 60, game_woken 129, game_dormant 139 |
| Events, last 1 h                                         | feeder_opened 12, feeder_live 2, feeder_abandoned 11, seat_moved 31 / planned 36, breaks 3                                           |
| Client bundle                                            | `ca_sha f167a9a7f` (main minus one docs-and-alerts commit)                                                                           |

Two numbers in that table are the open defects in section 3: 11 of 12
feeders opened in the last hour were abandoned, and roster (298) is five
behind seats (303).

## 3. What is left, in the order to take it

1. **The feeder loop / the break-fleet fight (OPORD 18.3 hysteresis).**
   The open rule fires when every live table is full and two buyers exist;
   the fleet supplies the second buyer within 30 s, the feeder opens,
   nobody sits (the horses that counted as buyers were seated elsewhere by
   then), and it is abandoned. Meanwhile the close rule needs five quiet
   minutes and the fleet refills a chair in thirty seconds, so a table
   almost never breaks while horses are available: games grow but rarely
   shrink. 18.3 specifies hysteresis by orbit (2 completed orbits or 5
   minutes, whichever is SHORTER, on `break_eligible_since`). The tick
   today uses the clock only. Build: `break_eligible_since` cleared the
   moment the condition fails; count orbits from `hand_history`; and make
   `eligibleHorseCount(gameId)` subtract horses the fleet is about to seat
   elsewhere this cycle so a buyer is counted once. Measure with the 6 h
   event counts above; success is feeder_live / feeder_opened well above
   the current 12/81 and breaks_1h > 0 on games that shrank.
2. **Roster drift.** `cash_game_roster` live rows (298) vs seats on cluster
   tables (303). `fn_cash_game_roster_track` is the trigger; find the five
   and the path that seated them without a roster row (probably the
   revive-a-departed-seat UPDATE path, see `20260905041000`).
3. **Event-driven ticks.** 119 games x 12 ticks/min is ~86k RPCs/hour,
   mostly finding nothing. A seat change should `NOTIFY` that game's tick;
   the 5 s poll stays as backstop; dormant games tick every 30 s. And one
   RPC per pass (`fn_cash_clusters_tick_all`) instead of 119 serial calls.
4. **A ladder manager.** Every rung is enabled by hand. Rungs should sleep
   and wake on demand the way tables do (a Madness 2/5 nobody has sat in
   for a day sleeps; a full Classic 1/2 wakes its neighbour).
5. **Observability that pages.** Three silent failures on 2026-09-04/05
   (controller stall, a deploy that "succeeded" and shipped nothing, the
   04:05 engine death under the 04:00 thaw) were all found by hand.
   `/metrics` for pass duration, stalls, moves expired, feeders abandoned;
   alert rules carrying the break guard (CLAUDE.md 13 rule 6); a deploy
   check that fails when `/health.version` does not change after a cutover.
6. **The engine's single core.** It died at 04:05 under the 04:00 thaw
   (318 tables + 402 tournaments resumed together). Stagger the thaw by
   table, or move tournaments to a second process. Biggest reliability risk
   on the platform; not a cluster problem.
7. **Felt polish.** "Moving in N hands" on the felt; per-seat name on the
   must-move list in the corner box; style label on the mobile card;
   per-style counts in the Stakes menu; `last_tick_actions` on the game
   card for staff.
8. **Tests that run the tick against a board.** `scripts/dev/probe-cutover.sql`
   and the probe in `docs/changelog/2026-09-05-the-break-keeps-a-seat-open-*`
   have the harness. The two boards from 2026-09-05 (Main exactly full +
   empty feeder; a seat on a closed table) belong in vitest, not only the
   text pins.
9. **Definers.** Audit the whole `fn_cash_*` family once against
   `scripts/ci/check-definer-authorization.mjs --all` rather than one per
   PR. `audit-live-definer-exposure.mjs` reads production.
10. **Madness ante** is one BB for the table (another agent's call, matching
    the label). Dan confirms the price or changes the template.

## 4. Traps this programme has already paid for

- **The break rule and the open rule both fired on the same board** when
  Main was exactly full (`>=` vs `>`); the feeder broke and re-opened 7 s
  later. Fixed in `20260905040500`. Boundary conditions in the tick need a
  probe, not a reading.
- **The fleet seated a horse on a `closed` feeder 15 s after it closed**
  (stale snapshot). `atomic_table_buyin` never checked table status. The
  door now refuses `closed` / `breaking` on INSERT and on the revive
  UPDATE. If you add a third way to occupy a seat, add the guard.
- **The four-table limit counted a within-game move as a fifth game**
  and refused every move, and the executor vacated the old seat BEFORE
  taking the new one so the "already holds a seat here" exemption never
  saw it. `20260905041000` + `20260905042000`. A move is not a leave.
- **A cancelled move was re-planned every 5 s** with no back-off (17k
  rows/day per stuck player). Back-off is in the tick now. If you see
  `move_planned` far above `seat_moved`, that is the shape.
- **`ensureCashTableEngine` resolved when the engine could deal, not when
  it existed.** A lone player waited on a promise that could not settle.
  `ServerTableEngineBase.ready` settles at `waiting`; #3036.
- **Two migrations on the same 14-digit version, both green alone, red on
  main.** Always `node scripts/new-migration.mjs "<slug>"`.
- **A transaction does not span two Supabase MCP calls.** One call, one
  `DO` block that ends in `RAISE EXCEPTION`; success means it committed.
  `execute_sql` DOES honour an explicit multi-statement `BEGIN ...
ROLLBACK` inside one call; that is how the probes above were run.
- **Pushing from the shared clone is refused by a guard; pushing from a
  worktree without `node_modules` skips tsc loudly.** Provision with
  `cp -Rc <clone>/node_modules <tree>/.nm.tmp && mv` for root and
  `server/` (APFS clone, no disk), then push detached
  (`nohup ... & disown`) and poll the log; the hook takes ~3 minutes and
  the host tool kills the process group on timeout.
- **Squash-merged branches look "N ahead of main" forever.** Ask GitHub
  (`pulls?state=all&head=Smarter-Poker:<branch>`) before re-pushing one.
- **`check-definer-authorization` reads COMMITTED migrations only** (it
  diffs `origin/main...HEAD`); a staged fix still reads as blocked.

## 5. Where things are

- Tick: `fn_cash_cluster_tick(p_game_id, p_eligible_horses)` (26 KB,
  source mirrored in the latest `supabase/migrations/*cluster*` file);
  `fn_cash_clusters_to_tick()`, `fn_cash_cluster_census`,
  `fn_cash_cluster_open_table`.
- Moves: `fn_cash_seat_change_plan/request/cancel/status`,
  `fn_cash_seat_move_execute`, `fn_cash_seat_swap_execute`
  (engine-only), `server/src/services/supabase/seatMoves.ts`,
  `seatChange.ts`, `SeatMovePresence.ts`.
- Controller: `server/src/cluster/**`,
  `TheTablesOpenAndCloseThemselves.law.test.ts`.
- Fleet: `HorseFleetManager.ts` (Gate 7 removes its table writers),
  `HorseSessionRotator.ts`, `HorseBehavior.ts`, `StableHandPlanBus.ts`.
- Lobby: `src/lib/lobbyEntries.ts`, `arenaGameCardActionsForEntry`, the
  must-move lobby (#3055), `AddOnBubble.ts` + `ChatBubble` `notice`
  variant (#3034).
- Event log: `cash_cluster_events(game_id, table_id, kind, payload, at)`;
  it is the only witness of what the tables did.
- Worktrees on Dan's Mac for this programme:
  `~/Documents/club-arena/.cowork-trees/{agent-horseseat,claude-*}`,
  `/tmp/wt-gate7`, `/tmp/wt-handoff`. All pushed; all disposable.
