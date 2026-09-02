-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826205949; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- TIER 2. Grant changes only. No function body is touched.
--
-- Classified all 586 SECURITY DEFINER functions executable by `authenticated`:
--
--   read-only ....................................... 383
--   writers ......................................... 184
--     of those, establish caller identity ........... 169
--     of those, BLIND to identity ...................  15
--
-- A SECURITY DEFINER function runs as its owner, so RLS does not constrain it.
-- One that writes without ever consulting auth.uid() will act on whatever
-- arguments it is handed, for any logged-in caller. All 15 are maintenance and
-- rollup jobs meant to be driven by cron or the engine under service_role -- not
-- things a browser should be able to fire.
--
-- The fix for a daemon function exposed to browsers is to stop exposing it, not
-- to bolt an identity check onto a job that has no user context. service_role
-- and postgres keep EXECUTE, so every real caller is unaffected.
--
-- THREE OF THE 15 ARE DELIBERATELY LEFT ALONE -- each has a live caller that
-- would break:
--
--   get_current_settlement_period()
--     Called from the browser: club-arena/src/services/SettlementService.ts
--     line 122 via supabase.rpc(), reached by SettlementDashboardPage,
--     SettlementPage, UnionDashboardPage and useUnionStore. It DOES insert into
--     settlement_periods with no identity check, so any authenticated user can
--     create a period -- worth fixing, but the fix is deciding who is allowed
--     to, which is a product call and not one to make blind from here.
--
--   reserve_clip(...), reserve_sports_clip(...)
--     World-Hub src/services/{Clip,SportsClip}DeduplicationService.js build
--     their client as
--       SUPABASE_SERVICE_ROLE_KEY || NEXT_PUBLIC_SUPABASE_ANON_KEY
--     so when the service-role key is absent they run as anon/authenticated and
--     a revoke here would break them in exactly the environment where the
--     fallback is load-bearing. The fallback itself is the latent bug; fix that
--     first, then revoke.
--
-- NOTE ON ca_refresh_hand_player_index: its browser call was removed on
-- 2026-08-24 after pg_stat_statements measured it at a 73,901 ms MEAN and it was
-- caught live at 26.9s in IO/DataFileRead, and tests/no-maintenance-from-
-- pageview.test.ts guards the regression at source level. This revoke enforces
-- the same rule at the database, where a source-level test cannot reach.
--
-- ROLLBACK: GRANT EXECUTE ON FUNCTION <signature> TO authenticated;

REVOKE EXECUTE ON FUNCTION public.ca_refresh_hand_player_index(integer)          FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.fn_refresh_member_fee_rollup(integer)          FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.fn_run_horse_daily_audit(date)                 FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.fn_hhr_rollup_add(uuid,date,text,boolean,numeric,text[]) FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.sp_prune_horse_hand_reviews()                  FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.fn_club_rake_rollup_day(uuid,date)             FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.fn_horse_daily_nets_add(jsonb)                 FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(text,integer,integer)         FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.fn_brain_telemetry_add(date,jsonb)             FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.fn_clone_table_row(uuid,text)                  FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.fn_refresh_player_stats(timestamp with time zone) FROM authenticated, anon;
REVOKE EXECUTE ON FUNCTION public.verify_home_games_invariants()                 FROM authenticated, anon;

DO $$
DECLARE v_still int; v_kept int; v_svc int;
BEGIN
  -- The twelve must no longer be reachable by a browser role.
  SELECT count(*) INTO v_still
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.oid::regprocedure::text IN (
       'ca_refresh_hand_player_index(integer)','fn_refresh_member_fee_rollup(integer)',
       'fn_run_horse_daily_audit(date)','fn_hhr_rollup_add(uuid,date,text,boolean,numeric,text[])',
       'sp_prune_horse_hand_reviews()','fn_club_rake_rollup_day(uuid,date)',
       'fn_horse_daily_nets_add(jsonb)','check_rate_limit(text,integer,integer)',
       'fn_brain_telemetry_add(date,jsonb)','fn_clone_table_row(uuid,text)',
       'fn_refresh_player_stats(timestamp with time zone)','verify_home_games_invariants()')
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_still <> 0 THEN
    RAISE EXCEPTION 'assertion failed: % of the twelve are still browser-callable', v_still;
  END IF;

  -- service_role must still be able to run every one of them, or cron breaks.
  SELECT count(*) INTO v_svc
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.oid::regprocedure::text IN (
       'ca_refresh_hand_player_index(integer)','fn_refresh_member_fee_rollup(integer)',
       'fn_run_horse_daily_audit(date)','fn_hhr_rollup_add(uuid,date,text,boolean,numeric,text[])',
       'sp_prune_horse_hand_reviews()','fn_club_rake_rollup_day(uuid,date)',
       'fn_horse_daily_nets_add(jsonb)','check_rate_limit(text,integer,integer)',
       'fn_brain_telemetry_add(date,jsonb)','fn_clone_table_row(uuid,text)',
       'fn_refresh_player_stats(timestamp with time zone)','verify_home_games_invariants()')
     AND has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_svc <> 12 THEN
    RAISE EXCEPTION 'assertion failed: service_role can only run %/12 -- cron would break', v_svc;
  END IF;

  -- The three with live callers must be untouched.
  SELECT count(*) INTO v_kept
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname IN
       ('get_current_settlement_period','reserve_clip','reserve_sports_clip')
     AND has_function_privilege('authenticated', p.oid, 'EXECUTE');
  IF v_kept < 3 THEN
    RAISE EXCEPTION 'assertion failed: a function with a live caller lost its grant (% remain)', v_kept;
  END IF;

  RAISE NOTICE '12 daemon functions revoked from browser roles; service_role intact on all 12; % live-caller functions preserved', v_kept;
END $$;
