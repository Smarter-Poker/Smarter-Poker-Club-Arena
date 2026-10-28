-- Original weekly summary preserves all earning sources and contracts. An
-- exclusive NULL/non-NULL coordinator partition exposes original index keys
-- and prevents a one-row estimate from scanning funding admissions per source.
-- No view, financial rule, certificate, source65/GEN, grant or budget changes.
-- Actual EXPLAIN cost199488->41189; this is not live full-scope capacity proof.
-- @live-proof: md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure))='5225ca603c36cc72e905c337c94f3eae'
BEGIN;SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s';
DO $summary_scope$
DECLARE d text;n text;m jsonb;g text;seal text;v jsonb;
 old_query constant text:=$old$ FROM public.accounting_payable_earning_sources s WHERE s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id
  AND s.earned_at>=period.start_at AND s.earned_at<period.end_at;$old$;
 new_query constant text:=$new$ FROM (
  SELECT * FROM public.accounting_payable_earning_sources a
   WHERE period.union_id IS NULL AND a.coordinator_union_id IS NULL
  UNION ALL
  SELECT * FROM public.accounting_payable_earning_sources a
   WHERE period.union_id IS NOT NULL AND a.coordinator_union_id=period.union_id
 )s WHERE s.club_id=period.club_id
  AND s.earned_at>=period.start_at AND s.earned_at<period.end_at;$new$;
BEGIN
 IF current_user<>'postgres'OR session_user<>'postgres'OR auth.uid()IS NOT NULL OR NULLIF(current_setting('request.jwt.claims',true),'')IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'')IS NOT NULL OR NULLIF(current_setting('ca.break_window_migration_override',true),'')IS NOT NULL THEN RAISE EXCEPTION 'summary_scope_operator_refused';END IF;
 IF public.fn_ca_break_window_refuses_migrations(now())IS NOT NULL OR public.fn_platform_frozen()IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary()IS NOT NULL THEN RAISE EXCEPTION 'summary_scope_window_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0))THEN RAISE EXCEPTION 'summary_scope_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261028005400')THEN RAISE EXCEPTION 'summary_scope_history_replay';END IF;
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO STRICT d,m FROM pg_proc p WHERE p.oid='public.fn_club_weekly_accounting_summary(uuid)'::regprocedure;
 IF md5(d)<>'1d1d9f44deea098a45c2b11dd613c858'OR m->>'proowner'IS DISTINCT FROM'postgres'::regrole::oid::text OR m->>'provolatile'IS DISTINCT FROM's' OR m->'prosecdef'IS DISTINCT FROM'true'::jsonb OR m->'proconfig'IS DISTINCT FROM'["search_path=public"]'::jsonb OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_club_weekly_accounting_summary(uuid)'::regprocedure)IS DISTINCT FROM'{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'OR(length(d)-length(replace(d,old_query,'')))/length(old_query)<>1 THEN RAISE EXCEPTION 'summary_scope_exact_preimage_required';END IF;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'summary_scope_source65_required';END IF;
 g:=smarter_private.original_inventory_basis_generation();seal:=pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure);
 IF g IS NULL THEN RAISE EXCEPTION 'summary_scope_generation_required';END IF;
 SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'definition',pg_get_viewdef(c.oid,true),'catalog',to_jsonb(c))ORDER BY c.oid)INTO v FROM pg_class c WHERE c.oid=ANY(ARRAY['public.accounting_payable_earning_sources'::regclass,'public.accounting_effective_cash_rake_sources'::regclass]);
 n:=replace(d,old_query,new_query);IF md5(n)<>'5225ca603c36cc72e905c337c94f3eae'THEN RAISE EXCEPTION 'summary_scope_exact_patch_required';END IF;
 EXECUTE n;
 IF md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure))<>'5225ca603c36cc72e905c337c94f3eae'OR(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE p.oid='public.fn_club_weekly_accounting_summary(uuid)'::regprocedure)IS DISTINCT FROM m OR pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure)IS DISTINCT FROM seal OR smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM g OR(SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'definition',pg_get_viewdef(c.oid,true),'catalog',to_jsonb(c))ORDER BY c.oid)FROM pg_class c WHERE c.oid=ANY(ARRAY['public.accounting_payable_earning_sources'::regclass,'public.accounting_effective_cash_rake_sources'::regclass]))IS DISTINCT FROM v THEN RAISE EXCEPTION 'summary_scope_postimage_required';END IF;
END$summary_scope$;
COMMIT;
