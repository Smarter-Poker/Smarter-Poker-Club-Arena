-- Reserved by the root allocator:20261017012658.
-- The actual normal coordinator spent13.922809s+39.418480s (53.341289s total)
-- in WHOLE completed-predecessor helper calls, not measured fee subcomponents.
-- Cash-accepted clubs do not need a fee witness to survive the final UNION.
-- R4 separately repeats non-NULL earning clubs already returned by this helper;
-- retain only the raw NULL branch so existing NULL/error behavior is unchanged.
-- Preserve all source/cutoff/history predicates, financial rows, money rules,
-- budgets, memo permissions, ACLs, triggers, source40 and sealed generation.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure))='e5ec460a159bfb46735d99be1a0738a3' AND md5(pg_get_functiondef('public.fn_issue_scope_weekly_accounting(text,uuid,timestamptz,timestamptz)'::regprocedure))='51d21522a5768dfd49eb6ae13a688260' AND smarter_private.original_inventory_proof_sources_match() IS TRUE)
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $weekly_club_reads$
DECLARE def text;sig regprocedure;generation text;
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'') IS NOT NULL THEN RAISE EXCEPTION 'weekly_club_reads_operator_refused';END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL OR public.fn_platform_frozen() IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN RAISE EXCEPTION 'weekly_club_reads_freeze_or_override_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN RAISE EXCEPTION 'weekly_club_reads_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261017012658') THEN RAISE EXCEPTION 'weekly_club_reads_history_replay';END IF;
 generation:=smarter_private.original_inventory_basis_generation();
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR generation IS NULL THEN RAISE EXCEPTION 'weekly_club_reads_inventory_seal_required';END IF;
 IF md5(pg_get_viewdef('public.accounting_payable_earning_sources'::regclass,true)) IS DISTINCT FROM '8eafef6d8f5e0d615b83baf14d1c0da4' THEN RAISE EXCEPTION 'weekly_club_reads_view_drift';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)') AND md5(pg_get_functiondef(p.oid))='2d861ca48eea9aba964cda9b4d45f456' AND md5(p.prosrc)='a3dfb7f9917b68ea42e9334eb3e5a9a7' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='s' AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'weekly_club_reads_helper_preimage_authority_refused';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_issue_scope_weekly_accounting(text,uuid,timestamptz,timestamptz)') AND md5(pg_get_functiondef(p.oid))='ade66e4785ed51541db707feabb8f4cc' AND md5(p.prosrc)='d8b1bc638aace9f3dfc9cad716b1e843' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v' AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'weekly_club_reads_statement_preimage_authority_refused';END IF;
 sig:='public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)'::regprocedure;def:=pg_get_functiondef(sig);
 IF (length(def)-length(replace(def,$old_0$), accepted_earnings AS (
 SELECT c.club_id FROM cash_clubs c LEFT JOIN earning_cutoffs b ON b.club_id=c.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE c.latest>=b.cutoff END
 UNION ALL
 SELECT t.club_id FROM tournament_clubs t LEFT JOIN earning_cutoffs b ON b.club_id=t.club_id
 WHERE EXISTS$old_0$,'')))/length($old_0$), accepted_earnings AS (
 SELECT c.club_id FROM cash_clubs c LEFT JOIN earning_cutoffs b ON b.club_id=c.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE c.latest>=b.cutoff END
 UNION ALL
 SELECT t.club_id FROM tournament_clubs t LEFT JOIN earning_cutoffs b ON b.club_id=t.club_id
 WHERE EXISTS$old_0$)<>1 THEN RAISE EXCEPTION 'weekly_club_reads_exact_replacement_refused';END IF;
 def:=replace(def,$old_0$), accepted_earnings AS (
 SELECT c.club_id FROM cash_clubs c LEFT JOIN earning_cutoffs b ON b.club_id=c.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE c.latest>=b.cutoff END
 UNION ALL
 SELECT t.club_id FROM tournament_clubs t LEFT JOIN earning_cutoffs b ON b.club_id=t.club_id
 WHERE EXISTS$old_0$,$new_0$), accepted_cash AS MATERIALIZED (
 SELECT c.club_id FROM cash_clubs c LEFT JOIN earning_cutoffs b ON b.club_id=c.club_id
 WHERE CASE WHEN b.cutoff IS NULL THEN true ELSE c.latest>=b.cutoff END
), tournament_candidates AS MATERIALIZED (
 SELECT t.club_id FROM tournament_clubs t WHERE NOT EXISTS(SELECT FROM accepted_cash ac WHERE ac.club_id=t.club_id)
), accepted_earnings AS (
 SELECT c.club_id FROM accepted_cash c
 UNION ALL
 SELECT t.club_id FROM tournament_candidates t LEFT JOIN earning_cutoffs b ON b.club_id=t.club_id
 WHERE EXISTS$new_0$);
 IF md5(def)<>'e5ec460a159bfb46735d99be1a0738a3' THEN RAISE EXCEPTION 'weekly_club_reads_postimage_refused';END IF;
 EXECUTE def;
 sig:='public.fn_issue_scope_weekly_accounting(text,uuid,timestamptz,timestamptz)'::regprocedure;def:=pg_get_functiondef(sig);
 IF (length(def)-length(replace(def,$old_1$  UNION SELECT s.club_id FROM public.accounting_payable_earning_sources s WHERE s.earned_at>=p_from AND s.earned_at<p_to
   AND (s.coordinator_union_id=scope.union_id OR (scope.standalone_club_id=s.club_id AND s.coordinator_union_id IS NULL))$old_1$,'')))/length($old_1$  UNION SELECT s.club_id FROM public.accounting_payable_earning_sources s WHERE s.earned_at>=p_from AND s.earned_at<p_to
   AND (s.coordinator_union_id=scope.union_id OR (scope.standalone_club_id=s.club_id AND s.coordinator_union_id IS NULL))$old_1$)<>1 THEN RAISE EXCEPTION 'weekly_club_reads_exact_replacement_refused';END IF;
 def:=replace(def,$old_1$  UNION SELECT s.club_id FROM public.accounting_payable_earning_sources s WHERE s.earned_at>=p_from AND s.earned_at<p_to
   AND (s.coordinator_union_id=scope.union_id OR (scope.standalone_club_id=s.club_id AND s.coordinator_union_id IS NULL))$old_1$,$new_1$  UNION SELECT s.club_id FROM public.accounting_payable_earning_sources s WHERE s.earned_at>=p_from AND s.earned_at<p_to
   AND (s.coordinator_union_id=scope.union_id OR (scope.standalone_club_id=s.club_id AND s.coordinator_union_id IS NULL)) AND s.club_id IS NULL$new_1$);
 IF md5(def)<>'51d21522a5768dfd49eb6ae13a688260' THEN RAISE EXCEPTION 'weekly_club_reads_postimage_refused';END IF;
 EXECUTE def;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_accounting_week_clubs(uuid,uuid,timestamptz,timestamptz)') AND md5(pg_get_functiondef(p.oid))='e5ec460a159bfb46735d99be1a0738a3' AND md5(p.prosrc)='07f9a6d2e68d8b42d1184d302d3d25f5' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='s' AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'weekly_club_reads_helper_installed_authority_refused';END IF;
 IF NOT EXISTS(SELECT FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_issue_scope_weekly_accounting(text,uuid,timestamptz,timestamptz)') AND md5(pg_get_functiondef(p.oid))='51d21522a5768dfd49eb6ae13a688260' AND md5(p.prosrc)='e903450f61c13dd4651a8764ac0854ac' AND p.proowner='postgres'::regrole AND p.prosecdef AND p.provolatile='v' AND p.proacl::text='{postgres=X/postgres}' AND p.proconfig=ARRAY['search_path=public']) THEN RAISE EXCEPTION 'weekly_club_reads_statement_installed_authority_refused';END IF;
 IF smarter_private.original_inventory_proof_sources_match() IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation() IS DISTINCT FROM generation THEN RAISE EXCEPTION 'weekly_club_reads_inventory_seal_changed';END IF;
END $weekly_club_reads$;
COMMIT;
