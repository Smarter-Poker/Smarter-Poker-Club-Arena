# Workstream E — cash-cluster tick, horse seat, tournaments lobby

All measurements 2026-09-10 03:05–03:40 UTC on the new 2XL box (pg_stat_statements reset 02:34 UTC), read-only; every write probe was a `DO` block ending in `RAISE EXCEPTION 'PROBE_ROLLED_BACK'` and every one rolled back (all returned the P0001 error, none returned success). No DDL was run. Companion file: `E-tick-horse-lobby.sql`.

New-box baseline for the three targets (pg_stat_statements, ~46 min window):

| target                                                                               | calls             | mean                     | max      | shared blks/call |
| ------------------------------------------------------------------------------------ | ----------------- | ------------------------ | -------- | ---------------- |
| `fn_cash_clusters_tick_all` (RPC)                                                    | 351               | 841 ms                   | 3,581 ms | 78,198           |
| `fn_seat_horse_in_seat_first_game` (RPC)                                             | 1,533             | 590 ms (min 2.4, sd 799) | 5,889 ms | 572              |
| lobby `... club_id = ANY($1) AND status = ANY($2) ORDER BY updated_at DESC LIMIT $3` | 469 recorded      | 427 ms                   | 1,279 ms | 9,633            |
| same query, **timed out at 8 s (not in pg_stat_statements)**                         | **148 in 70 min** | 8,000 ms                 | –        | –                |

---

## 1. `fn_cash_clusters_tick_all` — 841 ms / pass, ~550 passes/h

### 1.1 Anatomy of a pass

- 109 games returned by `fn_cash_clusters_to_tick()`; 77 are "due every pass" (`state='live'`), 32 rest (ticked every 30 s). So ~80 `fn_cash_cluster_tick` + `fn_cash_cluster_balance` per pass.
- Driver query (`to_tick` + the `anyone_seated` EXISTS + the `p_eligible` lookup): **112 ms, 29,196 buffers** (EXPLAIN ANALYZE below).
- A warm per-game tick on the largest game (7 open / 104 total tables, 41 seated): **10–13 ms, ~600 buffers**; balance 2.6 ms; `fn_platform_frozen` ~1 ms (called once per game + once per pass).
- Sum: 112 + 80 × ~9 ≈ 840 ms. Matches the measured mean exactly; the pass is death by a thousand small scans, plus one large intermittent scan (1.3).

### 1.2 The driver query — root cause: no index covers `lifecycle <> 'closed'`

`fn_cash_clusters_to_tick()` body, EXPLAIN (ANALYZE, BUFFERS):

```
Sort (actual 93.5 ms) Buffers: shared hit=17169
  Seq Scan on cash_games g  Filter: (must_move AND (enabled OR (ANY (id = (hashed SubPlan 3).col1))))
    SubPlan 1 (main1_table_id, 109 loops): Index Scan tables_cluster_id_idx, Rows Removed by Filter: 40, Buffers 2837
    SubPlan 3 (hashed): Gather -> Parallel Seq Scan on tables  Filter: (NOT is_deleted AND lifecycle <> 'closed')
                        Rows Removed by Filter: 51519 x4 workers   Buffers: shared hit=13878   (77.9 ms)
```

The EXISTS is de-correlated into a hashed subplan that seq-scans all 206,301 `tables` rows to find the 137 open ones. The `main1_table_id` subquery reads every table the cluster ever had (avg 41, max 107) and discards all but one.

`tick_all`'s own loop query adds the `anyone_seated` EXISTS: hashed subplan, Nested Loop over the 2,701 `left_at IS NULL` seats → `tables_pkey` probe each → **10,809 buffers, 21.5 ms**. Total driver: **112.0 ms, 29,196 buffers**.

Distribution that makes a partial index tiny: `tables` has 206k rows; **137** have `lifecycle <> 'closed'` (122 main + 15 feeder, all clustered); 200,528 are non-cluster rows with `lifecycle IS NULL`; 4,435 are closed cluster tables.

**Proposed:** `idx_tables_cluster_open ON tables (cluster_id, role, main_index, created_at) WHERE lifecycle <> 'closed'` (SQL 1b).

Expected after: SubPlan 3 becomes an index-only scan of ≤137 entries (~2 buffers); SubPlan 1 becomes a 1-row index scan per game; `anyone_seated` probes 137 index entries + their seats. Driver **112 ms → ~5 ms** (−107 ms/pass ≈ −59 s/h). Verified that the planner proves `status IN ('waiting','running')` ⇒ `status <> 'closed'` on the existing `idx_tables_club_open`, so `lifecycle = 'opening'` / `IN ('live','opening')` will match this predicate too.

### 1.3 The big intermittent cost — the 60-second back-off scan (no index)

Per-statement timing of one warm tick (rolled-back probe, µs): roster 1396, seat-change 789, waitlist 595, abandon 547, lifecycle↔status repairs 484+452, headcount 774, census 363, main1 611, **must-move 2517 (LIMIT 0 case)**, seat_change_plan 511, refresh 284, break-clear 286, last_tick 156, **balance 2617**.

The must-move candidate query, when a Main has an open seat (v_n > 0), EXPLAIN (ANALYZE, BUFFERS) on the biggest game's Main 1:

```
Limit (actual 496.147 ms) Buffers: shared hit=89725
  -> Index Scan idx_unique_active_user_per_table on table_seats ts  (rows=6 loops=6)
       Filter: (... AND NOT EXISTS(SubPlan 3))
       SubPlan 3 -> Seq Scan on cash_seat_moves m_1  (loops=33)  Rows Removed by Filter: 110529  Buffers: shared hit=88506
            Filter: (player_id = ts.user_id AND state = 'cancelled' AND created_at > clock_timestamp() - 60s)
```

One scan of `cash_seat_moves` (110k rows, 21 MB) per candidate seat: **15 ms and 2,682 buffers each**. The identical predicate is in `fn_cash_cluster_balance` (mover CTE), the break loop, and `fn_cash_seat_change_plan`. Volume: 1,217 `must_move` + 1,019 `balance` plans in the last 3 h ≈ 740 plans/h, each preceded by one such scan per candidate (5–36). Existing indexes on `cash_seat_moves` are only `WHERE state='pending'` (player_id, from_table_id) and the pkey. State counts: done 107,599 / cancelled 1,902 / expired 1,009 / pending 22.

**Proposed:** `idx_cash_seat_moves_cancelled_player ON cash_seat_moves (player_id, created_at) WHERE state = 'cancelled'` (SQL 1a). Index scan with both keys; 1,902 entries. Per candidate 15 ms → ~0.02 ms. This is also the source of the multi-second passes (max 3.6 s here, the 8 s whole-pass timeouts in the migration header): 36 candidates × 15 ms = 0.5 s for a single open seat on a single game.

### 1.4 The per-cluster `tables` statements (helped by 1b)

Every tick runs ~8 statements shaped `WHERE cluster_id = g.id AND lifecycle ...`; each walks `tables_cluster_id_idx` and discards the cluster's closed tables. Example (headcount subquery), EXPLAIN: `Index Scan tables_cluster_id_idx … Rows Removed by Filter: 97, Buffers: shared hit=144, 1.25 ms`. With 1b: 7 index entries, ~10 buffers. Estimated saving ~1.5–2.5 ms per tick × 80 = **120–200 ms/pass**. Also `fn_cash_apply_ruleset` (0.7 ms warm) and the census (0.27 ms warm, 3 calls per game) use the same predicate.

Optional 1c: the `status_followed_lifecycle` UPDATE (`lifecycle='closed' AND status<>'closed'`, 0.45 ms/tick, 2 matching rows DB-wide) gets its own 1-page partial index.

### 1.5 Should rested games be excluded in `fn_cash_clusters_to_tick`'s SQL?

**No — not behavior-identical.** `tick_all` returns every rested game as an identity row in `rested_games` ("A RESTED GAME STILL ANSWERS 'WHO ARE YOU'", 2026-09-05: the controller builds its per-game map from that list and the 18.4 dealer wake needs `main1_table_id`/`enabled` for dormant games). Filtering them out of the SQL would empty that list. Their cost is also negligible once 1b is in: a rested game costs only its row in the driver query (no tick). Left as is.

### 1.6 Other observations (no change proposed)

- `fn_cash_cluster_census`, `fn_cash_clusters_to_tick`, `fn_platform_frozen`, `fn_club_scope_ids` are `LANGUAGE sql` and not inlinable, so PG17 re-plans them on every call (census: 10.8 ms cold / 0.27 ms warm; planning alone touched 831 buffers). `fn_platform_frozen` is ~1 ms warm × 81 calls/pass ≈ 80 ms/pass; it is called once per pass in `tick_all` and again per game in `fn_cash_cluster_tick`. Dropping the per-game call would not be identical under READ COMMITTED (a freeze landing mid-pass stops later games today), so not proposed.
- `tables` and `cash_games` have never been autovacuumed since the box move (`tables`: 2,533 dead, `cash_games`: 474 dead in 150 live rows, 3.6 MB heap for 150 rows). `table_seats` index-only scans show `Heap Fetches` on every probe (visibility map stale). A `VACUUM (ANALYZE)` of `tables`, `cash_games`, `table_seats`, `cash_seat_moves` is maintenance, not DDL, and would trim every plan above; orchestrator's call.

### 1.7 Estimate

Per pass: driver −107 ms, per-tick `tables` scans −120..200 ms, cancelled-scan −50..500 ms when a seat opens (avg ≈ −100 ms/pass at 740 plans/h). **841 ms → ~350–450 ms mean**, and the 3–8 s tail disappears. At ~550 passes/h: **≈ 3.5–4.5 min of DB time saved per hour** (of ~7.7 min/h now).

### 1.8 Behavior identity / risk

Indexes only; no function or output changes. `idx_tables_cluster_open` columns (`cluster_id, role, main_index, created_at`) do not change on the engine's per-hand `current_players` update (that column is already indexed by `idx_tables_platform_open`, so HOT-ability is unchanged). Each `CREATE INDEX CONCURRENTLY` on `tables` (108 MB) / `cash_seat_moves` (21 MB) / `tournaments` (202 MB) is seconds; each triggers the ~28 s PostgREST reload — batch them.

---

## 2. `fn_seat_horse_in_seat_first_game` — 590 ms mean, 2.4 ms min

### 2.1 What it does

Only one overload exists now (`p_tournament_id uuid, p_user_id uuid`); the second overload from the old-box stats has been dropped. Chain: `fn_seat_horse_in_seat_first_game` → `fn_ca_lock_tournament_seat_acquisition` → `..._before_terminal_seat_gate` → `..._before_maintenance_gate` (the body: `tournaments FOR UPDATE`, `fn_tournament_primary_table`, seat lookups by `(table_id, seat_number)`/`(table_id, user_id) WHERE left_at IS NULL`, `tournament_players` by (tournament_id, user_id), INSERT/UPDATE seat, `fn_sync_seat_first_player_count`). Every read is by pkey, `idx_tables_tournament_id`, or the unique seat indexes: **there is no query to index**.

### 2.2 Root cause: a global exclusive advisory lock, first thing

`fn_ca_lock_tournament_seat_acquisition` begins with
`pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0))` — one key for the whole platform, exclusive, held to commit — then `pg_advisory_xact_lock_shared(530090,1)`, `fn_lock_daily_mission_user` (per-user advisory + `profiles FOR UPDATE`), `tournament_launch_receipts FOR UPDATE`, `tournaments FOR UPDATE`.

The same key is taken **shared by `fn_ca_commit_hand_settlement`** (11,272 calls / 46 min, 260 ms mean, held for the whole hand-commit transaction) and **exclusive by ~30 money-path functions** (`fn_complete_tournament_terminal` 1,155 ms mean / 23k blocks, `fn_settle_tournament_places`, `fn_register_horse_for_tournament` 391 ms mean, `process_tournament_rebuy`, `atomic_cancel_tournament`, …). Heavyweight-lock queueing is FIFO: an exclusive requester waits for every in-flight hand commit, and every hand commit arriving after it queues behind it.

Evidence:

- pg_stat_statements: horse RPC min 2.4 ms, mean 590 ms, sd 799 ms, **max 5,889 ms — identical to `fn_ca_commit_hand_settlement`'s max 5,891 ms** (same convoy). 572 shared blocks/call = <5 ms of real work.
- pg_stat_activity sampling (100 ms, `pg_stat_clear_snapshot()` per sample) during a seeding burst: horse RPC **100 samples in `Lock` wait vs 10 on CPU** (90 % waiting). Outside bursts: 0 samples (nothing to see; the function is instantaneous).
- Seeding is bursty: 73/160/117/104/103 tournament seats per minute 03:04–03:08, then ≤5/min. 1,533 RPC calls produced ≤579 seats: **≥60 % of calls are no-ops** (`already_seated`, `table_full`, `tournament_not_seatable`) that still take the global exclusive lock and stall the hand path while queued.

### 2.3 What is safe to propose

- **DB side: nothing behavior-identical.** Reordering the status check ahead of the lock, or narrowing the lock, changes what a concurrent settlement can observe; per RULES I stop rather than propose a weaker guard. (If Dan wants it evaluated: an early `tournament_not_seatable` return before the lock is safe only if COMPLETED/CANCELLED can never return to a seatable status — not verified here.)
- **Caller side (engine / HorseFleetManager, no DB change):** before calling the RPC for a horse, read `EXISTS (table_seats WHERE user_id = :horse AND table_id = :table AND left_at IS NULL)` (served by `idx_table_seats_live_user`, <0.1 ms, no lock) and skip the call when true. The RPC returns `{ok:true, already_seated:true}` for exactly that row today, so the end state is identical; the only difference is that a seat vacated between the read and the (skipped) call is re-attempted on the fleet's next cycle instead of this one. Horses get exactly what they get today (CLAUDE.md 10.5) — the change only removes calls that would not have seated anyone.
- Estimated effect: −60 % of ~2,000 global-lock acquisitions per hour → ~12 min/h less lock-queue time for horse calls, and correspondingly fewer hand-commit stalls (hand commits are 2,936 s / 46 min of DB time; how much of that is this convoy needs the hand-commit workstream's numbers).
- Secondary: `fn_entry_purchases_frozen` (SQL function, re-planned per call, ~1 ms) is evaluated twice per seat; harmless.

---

## 3. Tournaments lobby query — 148 statement timeouts in 70 min

### 3.1 The statement

Issued by `src/components/tournament/TournamentStartingTicker.tsx` (operations strip) via PostgREST as role `authenticated`, on every poll tick:

```
SELECT id,name,status,start_time,started_at,ended_at,updated_at,guaranteed_prize,prize_pool,current_players,
       late_reg_levels,late_reg_mins,current_level,blind_structure,level_started_at,max_players
  FROM tournaments
 WHERE club_id = ANY($1)            -- the player's active/approved club_members.club_id
   AND status  = ANY($2)            -- ['ANNOUNCED','REGISTERING','RUNNING','LATE_REG','LATE_REGISTRATION','COMPLETED']
 ORDER BY updated_at DESC LIMIT 80
```

`COMPLETED` is in the list, so for a member of Midway Union (112,056 tournaments) or Deep Stack Society (22,327) the candidate set is 130k+ rows.

Log evidence (postgres_logs 02:34–03:45 UTC): `canceling statement due to statement timeout` × 173, of which **148 are this exact statement** (`authenticator`). Those never reach pg_stat_statements; the 469 recorded calls (427 ms) are the survivors (small-club users).

### 3.2 Root cause: RLS calls a plpgsql function per row

Policies on `tournaments` for `authenticated`:

- RESTRICTIVE `poker_arena_tournament_access`: `(club_id IS NULL AND union_id IS NULL) OR fn_poker_can_read_games(COALESCE(union_id, club_id))`
- PERMISSIVE `tournaments_select_scoped`: `coalesce(is_private,false)=false OR …` (short-circuits: all 144,382 rows are non-private)
- PERMISSIVE `poker_arena_diamond_tournaments`: hashed EXISTS on diamond clubs (0 tournaments) AND `fn_poker_can_read_games(club_id)`

`fn_poker_can_read_games(uuid)` is plpgsql STABLE SECURITY DEFINER: reads `clubs`, then `club_members` with `fn_club_scope_ids()` (a SQL function re-planned on each call) or `fn_union_oversees_club()`. Measured 1.29 ms per call (1,000 calls = 1,290 ms). Its argument is a column, so it cannot be an initplan.

EXPLAIN (ANALYZE, BUFFERS) as `authenticated` with a real 4-club member's JWT (`SET LOCAL role authenticated; SET LOCAL request.jwt.claims=…`):

```
Limit (actual time=66700.826..66700.848 rows=80)  Buffers: shared hit=2777599
  -> Sort (top-N heapsort)  Sort Key: updated_at DESC
     -> Index Scan idx_tournaments_status_start_time  Index Cond: status = ANY(...)  rows=135615
          Filter: club_id = ANY(...) AND (((club_id IS NULL) AND (union_id IS NULL)) OR fn_poker_can_read_games(COALESCE(union_id, club_id))) AND (...)
```

**66.7 s, 2.78 M buffers: 135,615 function calls.** The generic (PostgREST prepared) plan is BitmapAnd(club_id, status) with the same per-row Filter — same cost (timed out at 20 s in the probe).

### 3.3 Fix A — evaluate the function once per club, not once per row (policy rewrite, SQL 3a)

```
USING ( (club_id IS NULL AND union_id IS NULL)
     OR COALESCE(union_id, club_id) IN (SELECT c.id FROM public.clubs c WHERE public.fn_poker_can_read_games(c.id)) )
```

Same query, same JWT, rewritten predicate inline (run as table owner so RLS is not double-applied):

```
Limit (actual time=339.601..339.619 rows=80)  Buffers: shared hit=137228
  -> Sort (top-N)  -> Index Scan idx_tournaments_status_start_time  rows=135616
       Filter: (... OR (ANY (COALESCE(union_id, club_id) = (hashed SubPlan 1).col1))) AND club_id = ANY(...) ...
       SubPlan 1 -> Index Only Scan clubs_pkey  Filter: fn_poker_can_read_games(id)  rows=5  (9.97 ms)
```

**66,700 ms → 340 ms.** The function now runs 5 times (one per club, ~10 ms total) and each tournament row is a hash probe.

### 3.4 Why the rewrite is behavior-identical on every row

Let `k = COALESCE(union_id, club_id)`. Original admits the row iff `(club_id IS NULL AND union_id IS NULL) OR f(k)`. Rewritten admits iff `(...) OR k IN (SELECT id FROM clubs WHERE f(id))`.

- `k` is a `clubs.id`: `f(k)` is computed on the same value with the same `auth.uid()` in the same statement (`f` is STABLE) → identical.
- `k` not in `clubs`: `f(k)` does `SELECT * INTO v_club FROM clubs WHERE id = k` → NOT FOUND → `false`; `k IN (…)` → false. Identical.
- `k IS NULL` (both columns NULL): first disjunct is already true in both forms; and `f(NULL)` = false, `NULL IN (…)` = NULL → false. Identical.
- The subquery reads `public.clubs` as the invoking role. `clubs` has policy `Anyone can view clubs` (`SELECT`, `{public}`, `USING (true)`), so the subquery sees every club, exactly the set the SECURITY DEFINER function would test. If that clubs policy is ever tightened, this equivalence must be re-checked (or the subquery moved into a SECURITY DEFINER helper returning `uuid[]`).
- `fn_poker_can_read_games` never raises, so no error-path difference. Same policy name, same roles, same RESTRICTIVE kind; `ALTER POLICY … USING` changes only the expression.
- The `tables` policy `poker_arena_table_access` has the identical shape; SQL 3c is the same rewrite, commented out for the `tables` workstream/orchestrator to decide.

### 3.5 Fix B — index for the ORDER BY (SQL 3b)

After Fix A the plan still touches 130k rows and sorts (340 ms). `tournaments` has no `updated_at` index. PG17 still cannot return ordered output from a `(club_id, updated_at)` index when `club_id = ANY(array)` (verified on `idx_tournaments_management_union_page`: Sort node retained), so the right index is the single-column `tournaments (updated_at DESC)`: backward scan, filter club/status/RLS-hash, stop at 80 rows. Stand-in measurement with the existing `start_time` index and the same filters:

```
Limit (actual time=12.654..14.183 rows=80)  Buffers: shared hit=1515
  -> Index Scan Backward using idx_tournaments_start_time  Filter: (... hashed SubPlan 1 ...)   rows=80
```

**~14 ms**, 12.6 of which is the five `fn_poker_can_read_games` calls. Worst case is a member of a club with few/zero tournaments under the generic plan (the backward scan walks further before finding 80): bounded by one pass over the index, ~150–300 ms, versus 8 s + timeout today.

### 3.6 Estimate

Today: 148 × 8,000 ms + 469 × 427 ms ≈ 1,384 s per 70 min ≈ **1,190 s/h (33 % of one core)**, and union members never get the operations strip at all. After A+B: ~620 calls/h × ~15 ms ≈ **9 s/h**. The other two lobby variants (`union_id = $1 OR (club_id = $2 AND is_private = $3) … ORDER BY start_time` at 116 ms and the `LEFT JOIN clubs` variant at 336 ms) run through the same policy and get the same per-row → per-club reduction.

### 3.7 Rollback

`ALTER POLICY poker_arena_tournament_access ON public.tournaments USING (((club_id IS NULL) AND (union_id IS NULL)) OR fn_poker_can_read_games(COALESCE(union_id, club_id)));` — original text pasted in the .sql ROLLBACK section; `DROP INDEX CONCURRENTLY` for the indexes.

---

## Summary table

| #   | change                                                                        | kind                                      | before                                                        | after (measured / est.)       |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- | ----------------------------- |
| 1a  | `cash_seat_moves (player_id, created_at) WHERE state='cancelled'`             | index                                     | 15 ms × candidates per move plan (496 ms measured)            | ~0.02 ms × candidates         |
| 1b  | `tables (cluster_id, role, main_index, created_at) WHERE lifecycle<>'closed'` | index                                     | driver 112 ms / 29k blks; ~8 cluster scans/tick at 0.4–1.2 ms | driver ~5 ms; scans ~0.05 ms  |
| 1c  | `tables (cluster_id) WHERE lifecycle='closed' AND status<>'closed'`           | index, optional                           | 0.45 ms/tick                                                  | ~0.02 ms/tick                 |
| 1   | `tick_all` pass                                                               | —                                         | 841 ms mean, 3.6 s max                                        | est. 350–450 ms mean, no tail |
| 2   | horse seat                                                                    | none safe in DB; caller skips no-op calls | 590 ms mean (≥98 % lock wait), ≥60 % no-op calls              | −60 % lock acquisitions       |
| 3a  | policy `poker_arena_tournament_access` hashed-IN rewrite                      | ALTER POLICY                              | 66,700 ms (4-club member)                                     | 340 ms                        |
| 3b  | `tournaments (updated_at DESC)`                                               | index                                     | 340 ms after 3a                                               | ~14 ms                        |
| 3   | lobby ops query                                                               | —                                         | 148 timeouts/70 min + 427 ms survivors ≈ 1,190 s/h            | ≈ 9 s/h                       |
