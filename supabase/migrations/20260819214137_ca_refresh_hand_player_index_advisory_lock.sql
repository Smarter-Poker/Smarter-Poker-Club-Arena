-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819214137 "ca_refresh_hand_player_index_advisory_lock"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 446e1e60286345549a0407a046aa317f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The stats page calls this fire-and-forget on every load, so many players
-- opening stats at once would each run a backfill batch and duplicate the work.
-- Take a transaction-scoped advisory lock and no-op if another refresh holds it.
DO $mig$
DECLARE
  src text;
  anchor text := $a$BEGIN
  SELECT idx_floor, idx_ceil, backfill_complete INTO f, c, done$a$;
  guarded text := $g$BEGIN
  -- Only one refresh at a time; everyone else returns immediately.
  IF NOT pg_try_advisory_xact_lock(hashtext('ca_refresh_hand_player_index')) THEN
    RETURN QUERY SELECT 0, 0, NULL::timestamptz, NULL::timestamptz, false;
    RETURN;
  END IF;

  SELECT idx_floor, idx_ceil, backfill_complete INTO f, c, done$g$;
BEGIN
  src := pg_get_functiondef('public.ca_refresh_hand_player_index(int)'::regprocedure);
  IF position(anchor IN src) = 0 THEN RAISE EXCEPTION 'refresh function body not in expected shape'; END IF;
  src := replace(src, anchor, guarded);
  EXECUTE src;
END $mig$;
