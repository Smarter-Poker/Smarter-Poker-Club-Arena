-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820123008 "union_law_selftest_money_paths_and_provenance"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e94ac42e3254b5dfc897c14e1fca5424 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


CREATE OR REPLACE FUNCTION public.fn_union_law_selftest()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_breaches jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_n bigint; v_missing text[];
BEGIN
  -- (a) rake routers keep the private-game rule
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='atomic_distribute_rake'
                    AND p.prosrc LIKE '%UNION LAW%' AND p.prosrc LIKE '%v_is_private%') THEN
    v_breaches := v_breaches || jsonb_build_object('check','atomic_distribute_rake_law_missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='record_tournament_buyin_rake'
                    AND p.prosrc LIKE '%UNION LAW%' AND p.prosrc LIKE '%v_is_private%') THEN
    v_breaches := v_breaches || jsonb_build_object('check','record_tournament_buyin_rake_law_missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_resolve_bbj_pool'
                    AND p.prosrc LIKE '%is_private%') THEN
    v_breaches := v_breaches || jsonb_build_object('check','fn_resolve_bbj_pool_law_missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='record_rake'
                    AND p.prosrc LIKE '%atomic_distribute_rake%') THEN
    v_breaches := v_breaches || jsonb_build_object('check','record_rake_delegation_missing');
  END IF;

  -- (a2) ownership triggers keep the house-club fallback
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_stamp_table_union_ownership'
                    AND p.prosrc LIKE '%FROM clubs c WHERE c.id = NEW.club_id%') THEN
    v_breaches := v_breaches || jsonb_build_object('check','table_stamp_house_club_fallback_missing');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_stamp_tournament_union_ownership'
                    AND p.prosrc LIKE '%FROM clubs c WHERE c.id = NEW.club_id%') THEN
    v_breaches := v_breaches || jsonb_build_object('check','tournament_stamp_house_club_fallback_missing');
  END IF;

  v_n := public.fn_union_house_club_stamp_check();
  IF v_n > 0 THEN
    v_breaches := v_breaches || jsonb_build_object('check','house_club_games_unstamped','count',v_n);
  END IF;

  -- (a3) EVERY money path must route through the club wallet when scoped on
  IF public.fn_club_scoped_chips_enabled() THEN
    SELECT array_agg(fn ORDER BY fn) INTO v_missing FROM public.fn_union_money_path_check();
    IF v_missing IS NOT NULL THEN
      v_breaches := v_breaches || jsonb_build_object('check','money_path_not_club_scoped','functions',to_jsonb(v_missing));
    END IF;
  END IF;

  -- (b) triggers
  SELECT count(*) INTO v_n FROM pg_trigger
   WHERE tgname IN ('trg_tables_union_ownership','trg_tournaments_union_ownership',
                    'trg_tables_block_deleted_revival','trg_table_seats_stamp_club',
                    'trg_tournament_players_stamp_club');
  IF v_n < 5 THEN
    v_breaches := v_breaches || jsonb_build_object('check','required_trigger_missing','found',v_n);
  END IF;

  -- (c) crons
  SELECT count(*) INTO v_n FROM cron.job
   WHERE jobname IN ('union-weekly-rakeback-close','union-law-selftest','union-seat-provenance-heal')
     AND active;
  IF v_n < 3 THEN
    v_breaches := v_breaches || jsonb_build_object('check','required_cron_missing','active',v_n);
  END IF;

  -- (d) oversight coverage
  SELECT array_agg(t ORDER BY t) INTO v_missing
    FROM unnest(public.fn_union_oversight_tables() || ARRAY['table_seats']) AS t
   WHERE EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname=t AND c.relkind='r')
     AND NOT EXISTS (SELECT 1 FROM pg_policies p
                      WHERE p.schemaname='public' AND p.tablename=t AND p.policyname='union_overseer_read');
  IF v_missing IS NOT NULL THEN
    v_breaches := v_breaches || jsonb_build_object('check','oversight_policy_missing','tables',to_jsonb(v_missing));
  END IF;

  -- (e) RLS on club tables
  SELECT array_agg(t ORDER BY t) INTO v_missing
    FROM unnest(public.fn_union_oversight_tables()) AS t
   WHERE EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname='public' AND c.relname=t AND c.relkind='r' AND c.relrowsecurity=false);
  IF v_missing IS NOT NULL THEN
    v_breaches := v_breaches || jsonb_build_object('check','club_table_rls_disabled','tables',to_jsonb(v_missing));
  END IF;

  -- (f) club views stay security_invoker
  SELECT array_agg(c.relname ORDER BY c.relname) INTO v_missing
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind='v' AND c.relname IN ('club_agents','club_daily_stats')
     AND COALESCE(array_to_string(c.reloptions,','),'') NOT LIKE '%security_invoker=true%';
  IF v_missing IS NOT NULL THEN
    v_breaches := v_breaches || jsonb_build_object('check','club_view_not_security_invoker','views',to_jsonb(v_missing));
  END IF;

  -- (g) no union game in a member club lobby
  SELECT count(*) INTO v_n FROM tables t JOIN union_clubs uc ON uc.club_id=t.club_id
   WHERE COALESCE(t.is_private,false)=false AND COALESCE(t.is_deleted,false)=false
     AND t.status IN ('running','waiting','active','open');
  IF v_n > 0 THEN
    v_breaches := v_breaches || jsonb_build_object('check','live_games_in_member_club_lobby','count',v_n);
  END IF;

  -- (h) no private row union-stamped
  SELECT count(*) INTO v_n FROM (
    SELECT id FROM tables WHERE COALESCE(is_private,false) AND union_id IS NOT NULL
    UNION ALL SELECT id FROM tournaments WHERE COALESCE(is_private,false) AND union_id IS NOT NULL) x;
  IF v_n > 0 THEN
    v_breaches := v_breaches || jsonb_build_object('check','private_rows_union_stamped','count',v_n);
  END IF;

  -- WARNINGS
  IF NOT public.fn_club_scoped_chips_enabled() THEN
    v_warnings := v_warnings || jsonb_build_object('check','club_chips_commingled',
      'detail','union.club_scoped_chips is off: buy-ins use the global player wallet.');
  END IF;

  SELECT count(*) INTO v_n FROM table_seats WHERE left_at IS NULL AND club_id IS NULL;
  IF v_n > 0 THEN
    v_warnings := v_warnings || jsonb_build_object('check','seats_without_provenance','count',v_n);
  END IF;

  IF jsonb_array_length(v_breaches) > 0
     AND NOT EXISTS (SELECT 1 FROM financial_alerts
                      WHERE source='fn_union_law_selftest' AND created_at > now() - interval '20 hours') THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('critical','fn_union_law_selftest',
            'UNION LAW self-test failed — the law has been clobbered or breached',
            jsonb_build_object('breaches', v_breaches));
  END IF;

  RETURN jsonb_build_object('healthy', jsonb_array_length(v_breaches)=0,
                            'breaches', v_breaches, 'warnings', v_warnings);
END $function$;

