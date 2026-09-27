-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820055038 "union_law_oversight_coverage_fix_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 97295ad1385838575b984b6e669cfdcc of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- UNION LAW — OVERSIGHT COVERAGE FIX (2026-08-20, pass 2)
--
-- BUG I INTRODUCED: the fast-path migration looped over pg_policies while
-- dropping/creating policies inside the loop. PL/pgSQL streams that cursor, so
-- mutating the catalog mid-loop shifted rows and silently dropped the
-- club_member_daily_stats overseer policy (16 -> 15 tables covered).
--
-- Fix: drive the rebuild from an explicit authoritative list, snapshot it into
-- an array before looping, and have the self-test assert that exact list
-- (naming any table that loses its policy) rather than a magic count — the
-- magic count is precisely what let this slip through.
--
-- NOTE: ENABLE ROW LEVEL SECURITY is applied only when RLS is actually off.
-- An unrelated event trigger (xp_ban_guard) rejects any ALTER TABLE touching
-- club_members, and every table here already has RLS enabled, so the no-op
-- ALTER must be skipped rather than issued blindly.
--
-- Checked and NOT a defect: club_agents and club_daily_stats are views with
-- security_invoker=true, so they already inherit their base tables' RLS.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_union_oversight_tables()
 RETURNS text[]
 LANGUAGE sql IMMUTABLE
AS $function$
  SELECT ARRAY[
    'club_members','club_wallets','club_wallet_transactions',
    'club_member_daily_stats','club_financial_summary','player_agent_assignments',
    'agents','sub_agents','chip_transactions','settlement_invoices',
    'settlement_periods','credit_requests','agent_commissions','rake_records',
    'bbj_contributions'
  ]::text[];
$function$;

DO $$
DECLARE
  v_tables text[] := public.fn_union_oversight_tables();  -- snapshot, not a live cursor
  t text;
  v_rls boolean;
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    SELECT c.relrowsecurity INTO v_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relname=t AND c.relkind='r';

    CONTINUE WHEN v_rls IS NULL;  -- not a base table in this schema

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name=t AND column_name='club_id') THEN
      CONTINUE;
    END IF;

    IF v_rls = false THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS union_overseer_read ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY union_overseer_read ON public.%I FOR SELECT TO authenticated
         USING ( (SELECT public.fn_is_any_union_overseer((SELECT auth.uid())))
                 AND public.fn_union_oversees_club(club_id, (SELECT auth.uid())) )', t);
  END LOOP;
END $$;

DROP POLICY IF EXISTS union_overseer_read ON public.table_seats;
CREATE POLICY union_overseer_read ON public.table_seats
  FOR SELECT TO authenticated
  USING ( (SELECT public.fn_is_any_union_overseer((SELECT auth.uid())))
          AND EXISTS (
            SELECT 1 FROM public.tables t
             WHERE t.id = table_seats.table_id
               AND public.fn_is_union_overseer(t.union_id, (SELECT auth.uid()))
          ) );

CREATE OR REPLACE FUNCTION public.fn_union_law_selftest()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_breaches jsonb := '[]'::jsonb;
  v_n bigint;
  v_missing text[];
BEGIN
  -- (a) money routers must carry the UNION LAW private routing
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='atomic_distribute_rake'
                    AND p.prosrc LIKE '%UNION LAW%' AND p.prosrc LIKE '%v_is_private%') THEN
    v_breaches := v_breaches || jsonb_build_object('check','atomic_distribute_rake_law_missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='record_tournament_buyin_rake'
                    AND p.prosrc LIKE '%UNION LAW%' AND p.prosrc LIKE '%v_is_private%') THEN
    v_breaches := v_breaches || jsonb_build_object('check','record_tournament_buyin_rake_law_missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_resolve_bbj_pool'
                    AND p.prosrc LIKE '%is_private%') THEN
    v_breaches := v_breaches || jsonb_build_object('check','fn_resolve_bbj_pool_law_missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname='public' AND p.proname='record_rake'
                    AND p.prosrc LIKE '%atomic_distribute_rake%') THEN
    v_breaches := v_breaches || jsonb_build_object('check','record_rake_delegation_missing');
  END IF;

  -- (b) ownership + revival triggers present
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgname IN ('trg_tables_union_ownership','trg_tournaments_union_ownership','trg_tables_block_deleted_revival');
  IF v_n < 3 THEN
    v_breaches := v_breaches || jsonb_build_object('check','ownership_or_revival_trigger_missing','found',v_n);
  END IF;

  -- (c) both crons scheduled and active
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='union-weekly-rakeback-close' AND active) THEN
    v_breaches := v_breaches || jsonb_build_object('check','weekly_close_cron_missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname='union-law-selftest' AND active) THEN
    v_breaches := v_breaches || jsonb_build_object('check','law_selftest_cron_missing');
  END IF;

  -- (d) EXPLICIT oversight coverage — names whichever table lost its policy
  SELECT array_agg(t ORDER BY t) INTO v_missing
    FROM unnest(public.fn_union_oversight_tables() || ARRAY['table_seats']) AS t
   WHERE EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname=t AND c.relkind='r')
     AND NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname='public' AND p.tablename=t
                        AND p.policyname='union_overseer_read');
  IF v_missing IS NOT NULL THEN
    v_breaches := v_breaches || jsonb_build_object('check','oversight_policy_missing','tables',to_jsonb(v_missing));
  END IF;

  -- (e) club-scoped base tables must have RLS enabled
  SELECT array_agg(t ORDER BY t) INTO v_missing
    FROM unnest(public.fn_union_oversight_tables()) AS t
   WHERE EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname=t AND c.relkind='r'
                    AND c.relrowsecurity = false);
  IF v_missing IS NOT NULL THEN
    v_breaches := v_breaches || jsonb_build_object('check','club_table_rls_disabled','tables',to_jsonb(v_missing));
  END IF;

  -- (f) club-data VIEWS must stay security_invoker or they bypass base RLS
  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_missing
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relkind='v'
     AND c.relname IN ('club_agents','club_daily_stats')
     AND COALESCE(array_to_string(c.reloptions,','),'') NOT LIKE '%security_invoker=true%';
  IF v_missing IS NOT NULL THEN
    v_breaches := v_breaches || jsonb_build_object('check','club_view_not_security_invoker','views',to_jsonb(v_missing));
  END IF;

  -- (g) live data: no union-visible game may live in a member club lobby
  SELECT count(*) INTO v_n
    FROM tables t JOIN union_clubs uc ON uc.club_id = t.club_id
   WHERE COALESCE(t.is_private,false)=false AND COALESCE(t.is_deleted,false)=false
     AND t.status IN ('running','waiting','active','open');
  IF v_n > 0 THEN
    v_breaches := v_breaches || jsonb_build_object('check','live_games_in_member_club_lobby','count',v_n);
  END IF;

  -- (h) no private row may carry a union stamp
  SELECT count(*) INTO v_n FROM (
    SELECT id FROM tables WHERE COALESCE(is_private,false) AND union_id IS NOT NULL
    UNION ALL
    SELECT id FROM tournaments WHERE COALESCE(is_private,false) AND union_id IS NOT NULL
  ) x;
  IF v_n > 0 THEN
    v_breaches := v_breaches || jsonb_build_object('check','private_rows_union_stamped','count',v_n);
  END IF;

  IF jsonb_array_length(v_breaches) > 0
     AND NOT EXISTS (SELECT 1 FROM financial_alerts
                      WHERE source='fn_union_law_selftest'
                        AND created_at > now() - interval '20 hours') THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('critical', 'fn_union_law_selftest',
            'UNION LAW self-test failed — the law has been clobbered or breached',
            jsonb_build_object('breaches', v_breaches));
  END IF;

  RETURN jsonb_build_object('healthy', jsonb_array_length(v_breaches)=0, 'breaches', v_breaches);
END $function$;

