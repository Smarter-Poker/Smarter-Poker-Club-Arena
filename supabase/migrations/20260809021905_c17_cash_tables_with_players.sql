-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260809021905 "c17_cash_tables_with_players"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 75dcc0b857ec5957741ace3aeb99f726 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- C17: cash-table discovery was an N+1.
--
-- Every 5 seconds the sweep read every waiting/running cash table, then issued a
-- separate `count(*)` on table_seats FOR EACH ONE — 500 to 1,000 serial round
-- trips per sweep after a restart, when every table is simultaneously
-- engine-less and therefore every table gets counted. That is the exact moment
-- the database is already under the most pressure.
--
-- One grouped query replaces the whole loop. PostgREST cannot express
-- `GROUP BY ... HAVING`, hence an RPC. The partial unique index
-- idx_unique_active_user_per_table (table_id, user_id) WHERE left_at IS NULL
-- already covers the grouping.
CREATE OR REPLACE FUNCTION public.cash_tables_with_players(p_min integer DEFAULT 2)
 RETURNS TABLE(table_id uuid, player_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT ts.table_id, count(*) AS player_count
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
   WHERE ts.left_at IS NULL
     AND t.tournament_id IS NULL
     AND t.status IN ('waiting', 'running')
   GROUP BY ts.table_id
  HAVING count(*) >= p_min;
$function$;
