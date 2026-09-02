-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830234343; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- THE EVICTOR IS NOT A PUBLIC API (2026-08-30)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_evict_sitting_out_cash_players()` is SECURITY DEFINER, takes no
-- arguments, and was EXECUTE-able by `anon`. It walks every cash table and
-- calls `player_leave_table` on anyone sitting out — which unseats them and
-- moves their remaining stack back to their wallet.
--
-- So an UNAUTHENTICATED browser could POST to /rest/v1/rpc/ and force
-- platform-wide eviction, on demand, as fast as it liked, moving other
-- players' chips. Not theft — the chips go to their own owner — but it is a
-- stranger operating other people's seats, and repeated at will it is a
-- denial of the cash game itself.
--
-- Same class as `reconcilers_are_not_public_api` (2026-08-24): a maintenance
-- sweep that only ever needed to be reachable by the scheduler was left on
-- the browser's surface because PostgREST exposes every public function by
-- default and Postgres grants EXECUTE to PUBLIC by default.
--
-- WHY THIS CANNOT BREAK THE SWEEP: it runs from pg_cron
-- (`sp_evict_sitting_out_cash_players`, every minute) as `postgres`, which
-- OWNS all three functions. A function owner keeps EXECUTE regardless of
-- grants, so the scheduled path is untouched. Verified before applying.
--
-- Two neighbours found in the same pass and closed with it:
--   fn_snapshot_player_stats_if_missing() — self-heal, called by the World
--     Hub cron route with the service role. Idempotent, but no reason for a
--     browser to trigger a stats snapshot.
--   fn_next_player_number() — burns `player_number_seq` on every call. Only
--     referenced by initialize_player_profile, trg_profiles_assign_player_number
--     and economy_invariants, all server-side, all of which call it with
--     their own privileges.
--
-- service_role keeps EXECUTE on all three: it is a server-only key, never
-- shipped to a browser, and it is what the Hub's cron routes authenticate as.
--
-- TIER 2: grants only. No schema change, no behaviour change for any
-- legitimate caller.

REVOKE EXECUTE ON FUNCTION public.fn_evict_sitting_out_cash_players()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_snapshot_player_stats_if_missing()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_next_player_number()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_evict_sitting_out_cash_players() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_snapshot_player_stats_if_missing() TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_next_player_number() TO service_role;

DO $$
DECLARE
  v_fn text;
  v_owner text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'fn_evict_sitting_out_cash_players()',
    'fn_snapshot_player_stats_if_missing()',
    'fn_next_player_number()'
  ] LOOP
    IF has_function_privilege('anon', 'public.' || v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can still execute %', v_fn;
    END IF;
    IF has_function_privilege('authenticated', 'public.' || v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated can still execute %', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', 'public.' || v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role LOST execute on % — server callers would break', v_fn;
    END IF;
  END LOOP;

  -- The scheduler's role must still be able to run the sweep.
  SELECT pg_get_userbyid(p.proowner) INTO v_owner
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_evict_sitting_out_cash_players';
  IF v_owner <> 'postgres' THEN
    RAISE EXCEPTION 'evictor owner is %, not postgres — the cron job may lose access', v_owner;
  END IF;
  IF NOT has_function_privilege('postgres', 'public.fn_evict_sitting_out_cash_players()', 'EXECUTE') THEN
    RAISE EXCEPTION 'postgres cannot execute the evictor — the every-minute sweep is broken';
  END IF;
END $$;

-- ROLLBACK:
--   GRANT EXECUTE ON FUNCTION public.fn_evict_sitting_out_cash_players()   TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_snapshot_player_stats_if_missing() TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.fn_next_player_number()               TO anon, authenticated;
