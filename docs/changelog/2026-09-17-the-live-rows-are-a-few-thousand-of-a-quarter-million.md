# The Live Rows Are A Few Thousand Of A Quarter Million

**2026-09-17** · `tournament_players`, `tables`, `cron_execution_log`, `clubs` · performance checklist audit, phase 1 of 6

## What Was Measured

Live `pg_stat_statements`, top-level PostgREST shapes, before this change:

| Query (engine sweep)                                                                   | Calls  | Buffers per call | Mean   |
| -------------------------------------------------------------------------------------- | ------ | ---------------- | ------ |
| `tournament_players` status IN (registered, playing), embed `tournaments`, ORDER BY id | 8,224  | 176,890          | 335 ms |
| same, with `start_time <= now()`                                                       | 3,506  | 324,355          | 569 ms |
| same, with `start_time IS NULL`                                                        | 3,505  | 293,139          |        |
| same, keyset `id > last`                                                               | 10,105 | 45,410           |        |
| `tables` tournament_id IS NOT NULL AND status <> closed ORDER BY id                    | 4,369  | 148,930          | 308 ms |
| workers stale-run sweep on `cron_execution_log` status = running                       | 1,107  | 7,823            | 177 ms |

`EXPLAIN (ANALYZE, BUFFERS)` on production for the first shape:

```
Index Scan using tournament_players_pkey on tournament_players tp
  Filter: (status = ANY ('{registered,playing}'::text[]))
  Rows Removed by Filter: 130470
  Buffers: shared hit=132465
Execution Time: 319.542 ms
```

and for the `tables` shape:

```
Parallel Seq Scan on tables   Workers Launched: 3
  Filter: ((tournament_id IS NOT NULL) AND (status <> 'closed'::text))
  Rows Removed by Filter: 63286   Buffers: shared hit=17811
Execution Time: 119.254 ms
```

The live subsets are tiny: 6,086 of 617,429 `tournament_players` rows are
registered or playing; 1,130 of 254,070 `tables` are open tournament tables.
Every index the planner had was keyed on something else, so it walked history
to find the present.

## The Change

Migration `20260917173357_the_live_rows_are_a_few_thousand_of_a_quarter_million.sql`:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tournament_players_live_by_id
  ON public.tournament_players (id) WHERE status IN ('registered', 'playing');
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tables_live_tournament_by_id
  ON public.tables (id) WHERE tournament_id IS NOT NULL AND status <> 'closed';
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cron_execution_log_running_started
  ON public.cron_execution_log (started_at) WHERE status = 'running';
DROP INDEX CONCURRENTLY IF EXISTS public.idx_clubs_one_platform;
```

Partial on exactly the predicate each query carries, so each index holds the
live rows only: 208 kB, 56 kB and 16 kB respectively.

The dropped index was one of two identical UNIQUE partial indexes on
`clubs(is_platform) WHERE is_platform` (advisor: duplicate_index). The
survivor, `ca_clubs_one_platform_club` from `20260908114501`, carries the
ruling-16 comment and is UNIQUE on the same expression, so "one platform club"
is enforced exactly as before. Neither index had ever been scanned.

## Measured After

Same statements, same database, immediately after the build:

| Query                                   | Before               | After                     |
| --------------------------------------- | -------------------- | ------------------------- |
| `tournament_players` live, ORDER BY id  | 319.5 ms, 132,465 buf | **19.6 ms, 2,761 buf**   |
| `tables` open tournament, ORDER BY id   | 119.3 ms, 17,811 buf  | **11.1 ms, 1,054 buf**   |
| `cron_execution_log` stale-run sweep    | 176.8 ms, 7,823 buf   | **0.09 ms, 1 buf**       |

The planner chose all three without hints (`idx_tournament_players_live_by_id`,
`idx_tables_live_tournament_by_id`, `idx_cron_execution_log_running_started`
appear in the plans). `pg_indexes` reports all three `indisvalid`.

## Applied

Applied to production 2026-09-17 17:38 UTC via psql (22 s for all four
statements), because `CREATE INDEX CONCURRENTLY` cannot run inside a
transaction block and the migration tool wraps one. Outside the :50-:03 UTC
break window. Recorded in `supabase_migrations.schema_migrations` as
`20260917173357` with this file's name.

## What This Does Not Change

Nothing about any function or any query. The engine asks the same questions of
an index that can answer them.

## Recorded, Not Changed (outside this phase's scope)

Two things the same profiling turned up, for their owners:

1. `atomic_table_buyin` has a lifetime mean of 1.76 s, and a 12-minute sample
   on 2026-09-17 (17:15 to 17:27 UTC: 37 calls, 203 s) put its recent mean at
   about 5.5 s per buy-in. The read side of the chain was timed directly
   against production and is not it: `fn_nit_check` 116 ms, `fn_cash_rejoin_floor`
   29 ms, `fn_seat_club_for_user` 19 ms, `fn_entry_purchases_frozen` 55 ms,
   the seat and blacklist reads under 1 ms. The remainder is on the write side
   (the `club_members` debit, `table_seats` insert and their triggers, or a
   wait on the `table_seat:`/`table_cap:` advisory locks or the shared
   maintenance lock 530090). `pg_stat_statements.track = top`, so nested
   statements are not attributed; finding the line needs `track = all` for a
   short window or a rolled-back probe with an impersonated session.
2. `tournament_payouts` shows 480,789 sequential scans reading 95 billion
   rows over the database's life, roughly one full table per scan. No
   top-level statement does this; it is inside the per-minute reconcile
   functions (`fn_ca_auto_reconcile_*`, `fn_reconcile_tournament_denormals`),
   which join the whole table each tick. Those functions are band-aid debt
   under CLAUDE.md 10.12 and are slated for removal with their root fixes, so
   indexing for them was not done here.

The same 12-minute sample showed `fn_eliminate_tournament_player_atomic` at a
recent mean of about 45 ms (112 calls, 5 s), confirming that #4455's index on
2026-09-12 fixed it; the 2.7 s lifetime mean in the advisor is history.
