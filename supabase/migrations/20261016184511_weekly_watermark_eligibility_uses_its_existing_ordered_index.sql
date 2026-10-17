-- Reserved by scripts/new-migration.mjs:20261016184511.
-- The original-week rollback trial timed out at the rakeback watermark read.
-- Its predicate could not use the existing positive-cash partial index and
-- scanned a historical week even though its entire week predates the watermark.
-- Retain the original tuple/NULL/club checks and expose their implied lower bound.
-- A read-only production plan used four blocks and did not call the club reader.
-- The completed predecessor also read 1.72 million cash rows to find two clubs.
-- Walk existing club keys and find each original coordinator/week maximum by
-- ordered index lookup. This preserves historical membership and cutoff rules.
-- Native qualification checks original queries, independent expected boundary
-- sets, actual guarded installation, metadata, rollback and replay refusal.
-- No money, source40, proof lifetime, budget, scheduler or permission changes.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))='f4a350ab6f0fb0dfe627fd81cb506147' AND md5(pg_get_functiondef('public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure))='2d861ca48eea9aba964cda9b4d45f456')
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL THEN RAISE EXCEPTION 'weekly_index_reads_operator_refused';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'weekly_index_reads_freeze_or_override_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'weekly_index_reads_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261016184511') THEN RAISE EXCEPTION 'weekly_index_reads_history_replay';END IF;
 IF NOT EXISTS(SELECT FROM pg_index WHERE indexrelid=to_regclass('public.rake_records_cash_positive_created') AND indisvalid AND indisready AND indislive AND indrelid='public.rake_records'::regclass AND indnkeyatts=2 AND indnatts=2 AND pg_get_indexdef(indexrelid,1,true)='created_at' AND pg_get_indexdef(indexrelid,2,true)='id' AND pg_get_expr(indpred,indrelid)='((rake_amount > (0)::numeric) AND (is_tournament IS NOT TRUE) AND (tournament_id IS NULL))') THEN RAISE EXCEPTION 'weekly_index_reads_cash_index_required';END IF;
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conrelid='public.daemon_state'::regclass AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (daemon)') THEN RAISE EXCEPTION 'weekly_index_reads_watermark_key_required';END IF;
END $guard$;
DO $install_scope$
DECLARE sig regprocedure:='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;def text:=pg_get_functiondef(sig);
 old_query text:=$old_query$IF EXISTS(SELECT 1 FROM public.rake_records rr LEFT JOIN public.daemon_state ds ON ds.daemon='rakeback_settler'
          WHERE NOT COALESCE(rr.is_tournament,false) AND rr.tournament_id IS NULL AND rr.rake_amount>0
            AND rr.created_at>=v_from AND rr.created_at<v_end
            AND (rr.club_id=v_union.id OR EXISTS(SELECT 1 FROM public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc WHERE uc.club_id=rr.club_id))
            AND (ds.high_water_mark IS NULL OR rr.created_at>ds.high_water_mark OR
              (rr.created_at=ds.high_water_mark AND (ds.high_water_mark_id IS NULL OR rr.id>ds.high_water_mark_id)))) THEN
          RAISE EXCEPTION 'weekly_rake_source_not_fully_accrued';
        END IF;$old_query$;
 new_query text:=$new_query$IF EXISTS(SELECT 1 FROM public.rake_records rr LEFT JOIN public.daemon_state ds ON ds.daemon='rakeback_settler'
          WHERE rr.is_tournament IS NOT TRUE AND rr.tournament_id IS NULL AND rr.rake_amount>0
            AND rr.created_at>=COALESCE((SELECT watermark.high_water_mark FROM public.daemon_state watermark WHERE watermark.daemon='rakeback_settler'),v_from)
            AND rr.created_at>=v_from AND rr.created_at<v_end
            AND (rr.club_id=v_union.id OR EXISTS(SELECT 1 FROM public.fn_accounting_week_clubs(v_union.id,NULL,v_from,v_end) uc WHERE uc.club_id=rr.club_id))
            AND (ds.high_water_mark IS NULL OR rr.created_at>ds.high_water_mark OR
              (rr.created_at=ds.high_water_mark AND (ds.high_water_mark_id IS NULL OR rr.id>ds.high_water_mark_id)))) THEN
          RAISE EXCEPTION 'weekly_rake_source_not_fully_accrued';
        END IF;$new_query$;
BEGIN
 IF md5(def)<>'a0ffe85a2f16c82af0221de03202fa26' OR (SELECT proowner<>'postgres'::regrole OR NOT prosecdef OR provolatile<>'v' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' OR proconfig IS DISTINCT FROM ARRAY['search_path=public'] FROM pg_proc WHERE oid=sig) THEN RAISE EXCEPTION 'weekly_index_reads_scope_preimage_authority_refused';END IF;
 IF (length(def)-length(replace(def,old_query,'')))/length(old_query)<>1 THEN RAISE EXCEPTION 'weekly_index_reads_exact_replacement_refused';END IF;
 def:=replace(def,old_query,new_query);
 IF md5(def)<>'f4a350ab6f0fb0dfe627fd81cb506147' THEN RAISE EXCEPTION 'weekly_index_reads_postimage_refused';END IF;
 EXECUTE def;
 IF md5(pg_get_functiondef(sig))<>'f4a350ab6f0fb0dfe627fd81cb506147' THEN RAISE EXCEPTION 'weekly_index_reads_installed_source_refused';END IF;
END $install_scope$;
DO $install_helper$
DECLARE sig regprocedure:='public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure;def text:=pg_get_functiondef(sig);
 old_query text:=$old_query$ SELECT s.club_id,max(s.earned_at) AS latest FROM public.accounting_cash_rake_sources s
 WHERE s.coordinator_union_id=p_union_id AND s.earned_at>=p_from AND s.earned_at<p_to GROUP BY s.club_id$old_query$;
 new_query text:=$new_query$ SELECT w.club_id,latest.earned_at AS latest FROM (WITH RECURSIVE cash_walk(club_id) AS ((SELECT s.club_id FROM public.accounting_cash_rake_sources s WHERE s.club_id IS NOT NULL ORDER BY s.club_id LIMIT 1) UNION ALL SELECT n.club_id FROM cash_walk w CROSS JOIN LATERAL (SELECT s.club_id FROM public.accounting_cash_rake_sources s WHERE s.club_id>w.club_id ORDER BY s.club_id LIMIT 1) n) SELECT cash_walk.club_id FROM cash_walk) w CROSS JOIN LATERAL (SELECT s.earned_at FROM public.accounting_cash_rake_sources s WHERE s.club_id=w.club_id AND s.coordinator_union_id=p_union_id AND s.earned_at>=p_from AND s.earned_at<p_to ORDER BY s.earned_at DESC LIMIT 1 OFFSET 0) latest$new_query$;
BEGIN
 IF md5(def)<>'564c97815954807fb96daaaee7003eeb' OR (SELECT proowner<>'postgres'::regrole OR NOT prosecdef OR provolatile<>'s' OR proacl::text IS DISTINCT FROM '{postgres=X/postgres}' OR proconfig IS DISTINCT FROM ARRAY['search_path=public'] FROM pg_proc WHERE oid=sig) THEN RAISE EXCEPTION 'weekly_index_reads_helper_preimage_authority_refused';END IF;
 IF (length(def)-length(replace(def,old_query,'')))/length(old_query)<>1 THEN RAISE EXCEPTION 'weekly_index_reads_exact_replacement_refused';END IF;
 def:=replace(def,old_query,new_query);
 IF md5(def)<>'2d861ca48eea9aba964cda9b4d45f456' THEN RAISE EXCEPTION 'weekly_index_reads_postimage_refused';END IF;
 EXECUTE def;
 IF md5(pg_get_functiondef(sig))<>'2d861ca48eea9aba964cda9b4d45f456' THEN RAISE EXCEPTION 'weekly_index_reads_installed_source_refused';END IF;
END $install_helper$;
COMMIT;
