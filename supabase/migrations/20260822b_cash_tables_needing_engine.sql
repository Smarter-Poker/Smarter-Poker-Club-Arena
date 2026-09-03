-- A lone seated HUMAN needs an engine, even though they cannot be dealt to yet.
--
-- discoverCashTables() spawns engines from cash_tables_with_players(p_min => 2).
-- Below two occupants no engine exists, so the first person to sit at an empty
-- table gets WS close 4404 from the engine transport and sits on "connecting"
-- until somebody else arrives. There is nothing to connect TO.
--
-- The engine is what publishes the idle snapshot (stage 'waiting', seats and
-- stacks), so its mere existence is the difference between a real table and an
-- eternal spinner. A table of horses alone still does not need one.
--
-- Returns human_count as well so the caller can keep the two ideas separate:
-- "needs an engine" is NOT the same question as "should be dealing", and the
-- zombie reaper must keep asking the second one. A table with one human makes
-- no progress by design and would be reaped every 180s otherwise.
--
-- NOTE ON HORSE DETECTION: table_seats.horse_id is dead -- 278 seated horses in
-- production, zero of them with it populated. profiles.is_horse is the only
-- source of truth, which is what loadSeatedPlayers() already joins for.
--
-- Grouped server-side exactly like cash_tables_with_players, because PostgREST
-- cannot express HAVING and the C17 fix (2026-08-08) exists to keep this sweep
-- from becoming 500-1,000 serial round trips every five seconds.
--
-- APPLIED TO PRODUCTION 2026-08-22 via Supabase MCP apply_migration, before the
-- branch was pushed, so scripts/ci/check-migrations-applied.mjs (CHECK 17) sees
-- it in the live schema. Verified on apply: old RPC 44 tables, new RPC 44
-- tables, 0 lone-seat tables added -- a no-op under current conditions, active
-- only for the case it exists to fix.
CREATE OR REPLACE FUNCTION public.cash_tables_needing_engine(p_min integer DEFAULT 2)
 RETURNS TABLE(table_id uuid, player_count bigint, human_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT ts.table_id,
         count(*) AS player_count,
         count(*) FILTER (WHERE p.is_horse IS NOT TRUE) AS human_count
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
    LEFT JOIN profiles p ON p.id = ts.user_id
   WHERE ts.left_at IS NULL
     AND t.tournament_id IS NULL
     AND t.status IN ('waiting', 'running')
   GROUP BY ts.table_id
  HAVING count(*) >= p_min
      OR count(*) FILTER (WHERE p.is_horse IS NOT TRUE) >= 1;
$function$;

GRANT EXECUTE ON FUNCTION public.cash_tables_needing_engine(integer) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'cash_tables_needing_engine'
  ) THEN
    RAISE EXCEPTION 'cash_tables_needing_engine was not created';
  END IF;
END $$;

-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.cash_tables_needing_engine(integer);
--   ...and revert GameServer.discoverCashTables to cash_tables_with_players.
