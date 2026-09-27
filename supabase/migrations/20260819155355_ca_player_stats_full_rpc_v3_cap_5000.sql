-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819155355 "ca_player_stats_full_rpc_v3_cap_5000"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 369cdfecefa388334940980631eae432 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v3: lower hand cap 10000 -> 5000. Measured ~1.3ms/hand; authenticated
-- statement_timeout is 8s, so 10k-hand horses timed out. Recreates the
-- function from its live definition with only the LIMIT changed, keeping
-- the repo file (20260819_ca_player_stats_full_rpc.sql) as source of truth.
DO $$
DECLARE src text;
BEGIN
  src := pg_get_functiondef('public.ca_player_stats_full(uuid)'::regprocedure);
  IF src NOT LIKE '%LIMIT 10000%' THEN
    RAISE EXCEPTION 'ca_player_stats_full: expected LIMIT 10000 in live definition, aborting';
  END IF;
  src := replace(src, 'LIMIT 10000', 'LIMIT 5000');
  EXECUTE src;
END $$;
