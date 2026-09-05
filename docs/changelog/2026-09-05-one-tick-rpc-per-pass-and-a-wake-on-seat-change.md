# One tick RPC per pass, dormant games rest at 30 s, and a seat change wakes its game

**Date:** 2026-09-05
**Branch:** `perf/one-tick-rpc-per-pass-and-a-wake-on-seat-change`
**Migration:** `20260905091025_one_tick_rpc_per_pass_and_dormant_games_rest.sql`
(applied to production 2026-09-05 via psql, one transaction, recorded in
`supabase_migrations.schema_migrations`; probed rolled-back first)
**Programme:** Operation Table Stakes, Slice 6 follow-up (OPORD 1.4 section
18.2, the controller). Task #7 on the Table Stakes backlog.

## The shape that did not scale

The cluster controller (`server/src/cluster/ClusterController.ts`) ran every
`CLUSTER_TICK_MS = 5000` on the leader as:

1. one RPC `fn_cash_clusters_to_tick()` for the worklist, then
2. one RPC `fn_cash_cluster_tick(p_game_id, p_eligible_horses)` PER GAME,
   through an eight-wide pool (`CLUSTER_TICK_CONCURRENCY = 8`).

Arithmetic, before:

| quantity                     | value                        |
| ---------------------------- | ---------------------------- |
| games on the worklist        | 120 (149 rows, 119 enabled)  |
| RPCs per pass                | 1 + 120 = **121**            |
| passes per minute            | 12                           |
| RPCs per hour                | 121 x 12 x 60 = **~87,000**  |
| pass wall time (8 in flight) | ~10 s, i.e. over the cadence |
| ticks that changed anything  | a small minority             |

Every one of those RPCs is a PostgREST round trip from Hetzner (~0.85 s each,
measured 2026-09-05 00:08 UTC), most of which read the game's rows, found
nothing to do, and wrote `last_tick_at`.

## What changed

### 1. One RPC per pass: `fn_cash_clusters_tick_all(p_eligible jsonb)`

SECURITY DEFINER, `search_path = public, pg_temp`, revoked from
PUBLIC/anon/authenticated, granted to `service_role`. It reads the worklist
(`fn_cash_clusters_to_tick()`, untouched) and, for every DUE game, calls the
existing `fn_cash_cluster_tick(game_id, eligible)` inside a per-game
sub-block. One game's error is caught (`EXCEPTION WHEN OTHERS`), that game's
tick rolled back, a `cash_cluster_events` row written with kind
`controller_tick_error` and payload `{sqlstate, message, eligible_horses}`,
and the pass continues. Returns
`{ok, games, ticked, errors, rested, results: [{game_id, main1_table_id, enabled, result | error}]}`
so the controller's per-game logging and the 18.4 dealer wake read exactly
what they read before.

`fn_cash_cluster_tick` itself is NOT redeclared here. Another branch (#3113)
owns its body (live md5 `7bd855d7d10b6517c013b63aef5b3b1c`, unchanged after
this migration); this function wraps whatever body is live.

**`p_eligible` is keyed by Main 1 TABLE id**, `{ "<main1_table_id>": <eligible_horses> }`.
The fleet's census is per table (`HorseFleetManager.eligibleCounts()`, new,
beside `eligibleHorseCount(tableId)`), and keying by table lets the controller
send the whole map without first asking which game owns which table. That is
what makes the pass ONE call rather than two. Zero counts are omitted; the
SQL coalesces a missing key to 0.

Measured on production before applying (rolled back):

| pass                                         | server time |
| -------------------------------------------- | ----------- |
| 120 games, empty map (81 due, 39 rested)     | 439 ms      |
| 120 games, every Main 1 eligible 2 (all due) | 725 ms      |

Well inside `service_role`'s 8 s statement_timeout.

### 2. Dormant games rest

A game is due every pass when it is `live`, when it is disabled (its tables
must drain), when ANYONE is seated at any of its non-closed tables (a lone
human at a dormant Main 1 still needs a dealer inside 5 s, and a horse's seat
counts identically - Law 10.5, no `is_horse` anywhere in the function), or
when the fleet reports a horse could sit at it (a horse is a buyer). Otherwise

- dormant, enabled, nobody seated, no horse eligible - it is due when
  `last_tick_at` is null or older than **30 s** (`CLUSTER_DORMANT_REST_S`,
  pinned against the SQL by the law test). On the first probe 39 of 120 games
  rested.

### 3. A seat change wakes its game (in-process, no LISTEN/NOTIFY)

`ClusterController.wake(gameId)` schedules an immediate single-game tick
through the per-game RPC `fn_cash_cluster_tick` with the fleet's eligible
count for that game's Main 1, debounced `CLUSTER_WAKE_DEBOUNCE_MS = 500` per
game and coalesced (25 wakes inside the window = 1 tick). A module-level
`wakeCluster(gameId)` reaches the running controller and is a no-op when none
is running (non-leader); it never throws.

The engine calls it, through `ServerTableEngineBase.wakeClusterGame(reason)`
(cluster tables only, never a tournament), from:

- `ServerTableEngineDealing` load_seats roster diff: an arrival or departure
  seen in the rows (`seat_change`);
- `ServerTableEngineSettlement` end of settlement, after the recount
  (`hand_complete`);
- `ServerTableEngineBase.executePendingSeatMoves` when a move landed
  (`seat_move`; one wake covers both tables of the game);
- `ServerTableEngineSeating.leaveTable` both between-hands cash-out doors
  (`seat_left`).

So a dormant game's 30 s rest never delays a seat that just filled, and a
must-move plan or a break decision follows the hand boundary rather than the
clock.

### 4. The controller pass

`tick()` builds the eligible map from `deps.eligibleCounts()`, makes ONE call,
and runs the unchanged per-game logic (actions log, 18.4 `hasEngine` /
`seatedCount` / `ensureEngine` never awaited) over `results`. The summary
gains `rested` and `rpcs` (the law says 1). `CLUSTER_TICK_CONCURRENCY` and the
worker pool are gone; there is nothing left to pool.

Arithmetic, after:

| quantity                        | value                                              |
| ------------------------------- | -------------------------------------------------- |
| RPCs per pass                   | **1**                                              |
| RPCs per hour (passes)          | 12 x 60 = **720** (from ~87,000)                   |
| plus wakes                      | one per seat change / hand end per game, debounced |
| pass wall time                  | ~0.5-0.8 s server-side, one round trip             |
| dormant empty game tick cadence | 30 s (from 5 s); any seat or wake = now            |

### Pins moved (same commit, deliberately)

`server/src/cluster/TheTablesOpenAndCloseThemselves.law.test.ts`:

- "ticks games in a bounded pool, not one after another" (pinned
  `CLUSTER_TICK_CONCURRENCY = 8`, `Promise.all(workers)`) is now "ticks every
  game in ONE call": the pass body calls `fn_cash_clusters_tick_all` and
  neither `fn_cash_cluster_tick` nor `fn_cash_clusters_to_tick`; the pool
  constants are absent. The behaviour guarded (a pass inside the cadence at
  any game count) is what the new shape delivers.
- "passes the horse demand for Main 1" now also pins
  `rpc('fn_cash_clusters_tick_all', { p_eligible: eligible })`; the per-game
  `p_eligible_horses: eligible` pin stays true through the wake path.
- New describe: the SQL worklist/due rule, the caught error row, the 30 s
  rest, the freeze, the grants, safeupdate, "the controller never makes N RPCs
  for N games", the unchanged 18.4 wake, the debounced leader-only wake, and
  every engine call site.

`ClusterController.test.ts` rewritten for the new shape (28 tests): one RPC
per pass, eligible map keyed by Main 1 with zeros omitted, per-game results
still logged and dealer-woken, SQL-caught errors counted, wake debounce and
coalescing, wake no-op when not running / stopped / frozen, wake never throws,
stall latch and no-overlap unchanged.

## How to verify on production

1. **Round trips.** After the engine deploys, the controller log has ONE
   `fn_cash_clusters_tick_all` call per pass. Compare PostgREST request
   volume (or `pg_stat_statements` calls of `fn_cash_cluster_tick` vs
   `fn_cash_clusters_tick_all`) over ten minutes: the wrapper at ~120/10 min,
   the per-game function called only from inside it plus wakes.
2. **`cash_games.last_tick_at` spread.**

   ```sql
   SELECT state, enabled,
          count(*),
          round(avg(extract(epoch FROM now() - last_tick_at))) AS avg_age_s,
          max(extract(epoch FROM now() - last_tick_at))::int AS max_age_s
     FROM public.cash_games WHERE must_move
    GROUP BY 1, 2 ORDER BY 1, 2;
   ```

   Live games: max age under ~6 s. Dormant enabled games with nobody
   seated: ages spread up to ~35 s. Nothing older than 40 s unless frozen.

3. **Wakes.** Seat a player at a dormant Main 1 and watch
   `cash_cluster_events` for `game_woken` within ~1 s of the seat row (not up
   to 30 s); the controller log shows `(wake)` beside the actions line.
4. **Errors are rows.** `SELECT * FROM cash_cluster_events WHERE kind = 'controller_tick_error' ORDER BY at DESC LIMIT 20;`
   should be empty in steady state; if not, the payload says which game and
   why, and the other games kept ticking (`ticked` in the summary).
5. **The per-game body is untouched.**
   `SELECT md5(prosrc) FROM pg_proc WHERE proname = 'fn_cash_cluster_tick'`
   is `7bd855d7d10b6517c013b63aef5b3b1c` until #3113 lands its own.

## Tests

- `cd server && npx tsc --noEmit -p . && npx vitest run`: 399 files, 5738
  tests, green.
- root `npx vitest run tests/`: 995/996 files, 13,680 tests green; the one
  failure is the pre-existing `sharp` import in
  `tests/the-media-optimizer-remembers-and-is-idempotent.law.test.ts`
  (environment, unrelated).

## Left open

- The wake looks up a game's Main 1 (for its horse demand and the dealer
  wake) from the last pass's results. A game the controller has never seen in
  a pass is woken with zero horses and its dealer left to the next pass (at
  most 5 s). A hint, not a decision; nothing else is remembered between ticks.
- The whole pass is one transaction, so every due game's row lock is held
  until it returns (~0.7 s worst case measured). A seat-change request or a
  wake wanting one game's lock waits at most that long.
- `/metrics` does not yet expose `rested`, `rpcs` or wake counts (backlog #8).
