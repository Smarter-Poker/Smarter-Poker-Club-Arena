# 2026-09-05 — Cluster autonomy, live audit: the controller was not running

Operation Table Stakes, after Gate 3 (`2026-09-05-cluster-controller-slice-2.md`)
and R10 (#3013). Dan: "DO A DEEP DIVE AND AUDIT AND MAKE SURE THAT THE TABLES
ARE TRULY 'SMART' AND DYNAMIC ... AUTO OPEN, AUTO CLOSE AND DO EVERYTHING THEY
NEED TO DO AUTOMATICALLY WITHOUT ANY HUMAN INTERVENTION."

Audited on the first live build (engine `77a2443f`, booted at the 21:55 UTC
restart, thaw 22:00). Four defects, all fixed here. None of them was
visible from the probe, the tests or the lobby; all four were visible from
`cash_games.last_tick_at`, `tables.settings` and the engine log within
twenty minutes of the thaw.

## BUG 1 — every tick failed: `DELETE requires a WHERE clause` (SQL, applied)

`cash_games.last_tick_at` was NULL on all 78 enabled games six minutes after
the thaw. The engine log had 293 lines of

    [ClusterController.tick_rpc_failed] { code: '21000',
      message: 'DELETE requires a WHERE clause' }

`authenticator` - the role PostgREST connects as, so the session every
service_role RPC runs in - preloads the `safeupdate` extension:

    authenticator | {session_preload_libraries=safeupdate, statement_timeout=5min, ...}

It refuses any UPDATE or DELETE without a WHERE clause, inside SECURITY
DEFINER functions included. `fn_cash_cluster_tick` kept its census in a temp
table cleared with `DELETE FROM pg_temp.cluster_census;` and filled with
`UPDATE pg_temp.cluster_census SET open_unreserved = ...;` - four statements
with no WHERE. The probe never saw it because it runs as `postgres` on a
direct connection, where safeupdate is not loaded (and cannot be:
`LOAD 'safeupdate'` there is "access to library is not allowed").

**Fix: `20260905030000_cluster_tick_survives_safeupdate`** (applied 22:07
UTC, one transaction). The census is now an array of a composite type
(`cash_cluster_census_row`) built by `fn_cash_cluster_census(game, now)`,
read with `unnest(v_census)`, and re-derived where the old code mutated the
table. The temp table was wrong on its own account: `CREATE TEMP TABLE ...
ON COMMIT DROP` once per game every 5 s is ~16 catalog insert+delete cycles
a second forever (pg_class, pg_attribute x 11, pg_type, pg_depend) on a
database whose PostgREST reload is the 2026-08-31 outage class. Every
decision is unchanged; the migration asserts no temp table and no DELETE
remain in the body.

**The probe now checks for it.** `probe-cluster-controller.sql` reads every
`fn_cash_*` body and fails on any UPDATE / DELETE without WHERE (run against
the old body it names exactly the four). 24/24 on the new tick.

First ticks landed at 22:07:46; the first pass reopened 16 Main 1s
(`main1_reopened`) and put 19 empty games to sleep (`game_dormant`).

## BUG 2 — the Stable Hand was retiring the cluster Main 1s (engine, this PR)

25 enabled cluster Main 1s carried `settings.retire_when_empty = true` with no
`retired_reason` - every PLO8, Short Deck, Pineapple, FLH and FLO8 game. The
writer was `StableHandController` step 5, the exotic/limit trim: a standing
cap of TWO tables per exotic variant and two per limit variant, against
Dan's ladder of six per variant (two rungs x Classic / Action / Madness).
The planner picked the least-seated tables over the cap - all cluster Main
1s, since the fleet tables of those variants were already retired - and the
executor flagged them, 25 a cycle.

What the flag then did, every 30 s: the fleet put them in `surplusTableIds`
(no seeding), `HorseSessionRotator` walked their horses out,
`retireSurplusTables` closed them the moment they were empty
(`status='closed'`, lifecycle untouched), and the controller's RECONCILE
reopened them on its next tick (R3: an enabled game always has Main 1). The
`[TableFSM] Invalid transition: closed -> seating` lines in the log were the
same fight seen from the engine. The games could never have filled.

**Fix.** A cluster table's life is its ClusterController's (R9). The Stable
Hand still shapes WHO sits there - a horse is a player everywhere (10.5) and
the population caps apply - but it never closes, parks or duplicates one:

- `StableHandSnapshot` carries `cluster_id`; `TableSnapshot.clusterId`.
- Step 5 skips cluster tables for `close` and, while a variant has a
  cluster, opens no fleet table of that variant (the cluster IS the supply
  and opens its own feeders). Fleet tables of the same variant are still
  trimmed.
- The night park never takes a cluster table (a game thins itself: BREAK).
- `StableHandExecutor.setTableFlag` refuses a row with `cluster_id`, and
  `HorseFleetManager` never counts a cluster table as retiring or parked,
  whatever its settings say - defence in depth for the next writer.
- Data: the 25 flags were removed at 22:12 UTC
  (`settings - 'retire_when_empty' - 'night_parked'` on enabled cluster
  tables). Until this build deploys the old executor re-flags them; the
  same statement is re-run after the deploy and recorded here.

Tests: `StableHandController.test.ts` +4 (never closed, cluster is the
supply, fleet tables beside a cluster still trimmed, never parked);
`TheTablesOpenAndCloseThemselves.law.test.ts` +8 pins (snapshot, planner,
park, executor, fleet, migration, probe, pool).

## BUG 3 — a "5-second" controller with a 66-second pass (engine, this PR)

Once ticks landed, `min(last_tick_at)` to `max(last_tick_at)` across one pass
was 66 s: 78 games, one RPC each, ~0.85 s a round trip from Hetzner, in
series. A seat opening on a Main was noticed a minute late, and a move
planned in one pass expired (60 s) before the next pass could see it done.

**Fix.** `CLUSTER_TICK_CONCURRENCY = 8`: a bounded pool, every game ticked
exactly once per pass, ~10 s a pass. Every game's tick locks only its own
row and touches only its own tables, so eight in flight share nothing. The
summary carries `elapsedMs` and a pass over the cadence is logged. The WAKE
check reads `seated_total` from the tick result, so an empty game no longer
costs a second query per pass.

## BUG 4 — the controller went silent at 22:10:40 and stayed silent (engine, this PR)

Found while shipping BUGs 2-3: `max(cash_games.last_tick_at)` was 22:10:40
UTC and it was 22:21. No `tick_rpc_failed`, no `game_tick_error`, no
`worklist_failed`, no log line of any kind from the controller after
22:08:57; the fleet beside it was cycling normally. Eleven minutes of
nothing, visible only from the database.

The mechanism, from the code rather than a guess. The WAKE step did
`await this.deps.ensureEngine(main1)`. `ensureCashTableEngine` returns
`engine.start()`'s promise, and `start()` resolves only when its
wait-for-players loop breaks - `seatedPlayers.length >= minPlayersToDeal()`,
i.e. two seated. A Main 1 with ONE player seated (there were eleven such
tables on the board) keeps that promise open until a second player sits. So
the worker holding that game never returned, `Promise.all(workers)` never
settled, `inTick` stayed true, and every later tick returned at the guard.
The controller did not crash and did not err; it was waiting for a stranger
to sit down. Before BUG 3's pool it was worse still: the very first
one-seated Main 1 in the list parked the whole serial loop.

**Fix.** The wake is fired, never awaited: `void this.deps.ensureEngine(id)`
with its own `.catch` (`wake_failed`). Nothing is started twice because the
engine is in `tableEngines` from the moment it is constructed, so
`hasEngine()` is true on the next pass. And the latch cannot hold forever:
a pass still open after `CLUSTER_TICK_STALL_MS` (120 s) is reported as
`ClusterController.tick_stalled` and the latch released; an overlapping pass
is safe because every game's tick locks its own row.

Tests: `ClusterController.test.ts` +2 (a wake that takes the life of the
table does not take the pass with it; a stuck pass is reported and released).
`TheTablesOpenAndCloseThemselves.law.test.ts` +2 pins.

Noted, not changed here: `handlers/state.ts` (`GET /actions`, `GET /state`)
and the WebSocket `ensureTable` also `await ensureCashTableEngine`. When the
request itself is what wakes a one-player table, that request waits for the
second player too. Pre-existing, outside this PR's scope; recorded so the
next reader of a hung `/state` knows where to look.

## What the board looks like now (22:1x UTC, before this build)

    78 enabled must-move games, all ticking; 30 disabled, draining
    Main 1 live/waiting 57 (11 seated), live/running 12 (33 seated)
    fleet: 26 retiring tables left, 0 players; the 21:55 boot reseeded 44
    horses into cluster Main 1s in its first cycle

## Still open after this PR

- Feeder open / promote / break / must-move have not yet fired on
  production because no Main 1 has filled since the thaw (the fleet is
  still draining the old floor and the Stable Hand was starving five
  variants). Watch `cash_cluster_events` for `feeder_opened`,
  `feeder_live`, `move_planned`, `seat_moved`, `table_break_started` after
  this build; the probe covers each path, the live proof is the next step.
- The Stable Hand's exotic/limit caps (`EXOTIC_MAX_TABLES_PER_VARIANT`,
  `LIMIT_MAX_TABLES_PER_VARIANT`, `EXOTIC_MAX_BB`) now describe FLEET tables
  only. If Dan wants the same limits on cluster games, that is a
  `cash_games` enable/disable decision, not a table-closing one.
