-- Original full private-deposit aggregate still exceeded90s after the exact
-- scalar cash covers. Retained exact C2 completes43.611s/86197ordered IDs,
-- bad0/private3552.70. Apply ONLY its four already-qualified source deltas:
-- exclusive nullable key branches and materialize non-skipped verdict once.
-- Every raw judged field and all original non-skipped verdict/three aggregate
-- outputs/ordered ledger JSON remain identical. Skipped issue fields need not
-- be evaluated. No bulk group rewrite, view, money, grant, source65/GEN change.
-- @live-proof: md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure))='b00039e968bc69a56046c2fe0634fc8b'
BEGIN;
SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s';
DO $summary_scope$
DECLARE d text;n text;m jsonb;g text;seal text;v jsonb;
 old_queries constant text[]:=ARRAY[$old0$UNION SELECT s.rake_record_id FROM public.accounting_cash_rake_sources s WHERE s.club_id=period.club_id AND s.union_id IS NULL
    AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id AND s.earned_at>=period.start_at AND s.earned_at<period.end_at$old0$,$old1$UNION SELECT s.tournament_id FROM public.accounting_payable_earning_sources s WHERE s.source_type='tournament_fee_accrual'
    AND s.club_id=period.club_id AND s.union_id IS NULL AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id
    AND s.earned_at>=period.start_at AND s.earned_at<period.end_at$old1$,$old2$verdict AS ($old2$,$old3$  FROM judged j
 )$old3$];
 new_queries constant text[]:=ARRAY[$new0$UNION SELECT s.rake_record_id FROM public.accounting_cash_rake_sources s WHERE s.club_id=period.club_id AND s.union_id IS NULL
    AND period.union_id IS NULL AND s.coordinator_union_id IS NULL AND s.earned_at>=period.start_at AND s.earned_at<period.end_at
   UNION SELECT s.rake_record_id FROM public.accounting_cash_rake_sources s WHERE s.club_id=period.club_id AND s.union_id IS NULL
    AND period.union_id IS NOT NULL AND s.coordinator_union_id=period.union_id AND s.earned_at>=period.start_at AND s.earned_at<period.end_at$new0$,$new1$UNION SELECT s.tournament_id FROM public.accounting_payable_earning_sources s WHERE s.source_type='tournament_fee_accrual'
    AND s.club_id=period.club_id AND s.union_id IS NULL AND period.union_id IS NULL AND s.coordinator_union_id IS NULL
    AND s.earned_at>=period.start_at AND s.earned_at<period.end_at
   UNION SELECT s.tournament_id FROM public.accounting_payable_earning_sources s WHERE s.source_type='tournament_fee_accrual'
    AND s.club_id=period.club_id AND s.union_id IS NULL AND period.union_id IS NOT NULL AND s.coordinator_union_id=period.union_id
    AND s.earned_at>=period.start_at AND s.earned_at<period.end_at$new1$,$new2$verdict AS MATERIALIZED ($new2$,$new3$  FROM judged j
  WHERE NOT(j.n>0 AND NOT j.mine)
 )$new3$];
 i integer;
BEGIN
 IF current_user<>'postgres'OR session_user<>'postgres'OR auth.uid()IS NOT NULL OR NULLIF(current_setting('request.jwt.claims',true),'')IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'')IS NOT NULL OR NULLIF(current_setting('ca.break_window_migration_override',true),'')IS NOT NULL THEN RAISE EXCEPTION 'summary_scope_operator_refused';END IF;
 IF public.fn_ca_break_window_refuses_migrations(now())IS NOT NULL OR public.fn_platform_frozen()IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary()IS NOT NULL THEN RAISE EXCEPTION 'summary_scope_window_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0))THEN RAISE EXCEPTION 'summary_scope_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261028032621')THEN RAISE EXCEPTION 'summary_scope_history_replay';END IF;
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO STRICT d,m FROM pg_proc p WHERE p.oid='public.fn_club_weekly_accounting_summary(uuid)'::regprocedure;
 IF md5(d)<>'5225ca603c36cc72e905c337c94f3eae'OR m->>'proowner'IS DISTINCT FROM'postgres'::regrole::oid::text OR m->>'provolatile'IS DISTINCT FROM's' OR m->'prosecdef'IS DISTINCT FROM'true'::jsonb OR m->'proconfig'IS DISTINCT FROM'["search_path=public"]'::jsonb OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_club_weekly_accounting_summary(uuid)'::regprocedure)IS DISTINCT FROM'{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'summary_scope_exact_preimage_required';END IF;
 FOR i IN 1..4 LOOP IF(length(d)-length(replace(d,old_queries[i],'')))/length(old_queries[i])<>1 THEN RAISE EXCEPTION 'summary_scope_exact_preimage_required';END IF;END LOOP;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'summary_scope_source65_required';END IF;
 g:=smarter_private.original_inventory_basis_generation();seal:=pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure);
 IF g IS NULL THEN RAISE EXCEPTION 'summary_scope_generation_required';END IF;
 SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'definition',pg_get_viewdef(c.oid,true),'catalog',to_jsonb(c))ORDER BY c.oid)INTO v FROM pg_class c WHERE c.oid=ANY(ARRAY['public.accounting_payable_earning_sources'::regclass,'public.accounting_effective_cash_rake_sources'::regclass]);
 n:=d;FOR i IN 1..4 LOOP n:=replace(n,old_queries[i],new_queries[i]);END LOOP;IF md5(n)<>'b00039e968bc69a56046c2fe0634fc8b'THEN RAISE EXCEPTION 'summary_scope_exact_patch_required';END IF;
 EXECUTE n;
 IF md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure))<>'b00039e968bc69a56046c2fe0634fc8b'OR(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE p.oid='public.fn_club_weekly_accounting_summary(uuid)'::regprocedure)IS DISTINCT FROM m OR pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure)IS DISTINCT FROM seal OR smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM g OR(SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'definition',pg_get_viewdef(c.oid,true),'catalog',to_jsonb(c))ORDER BY c.oid)FROM pg_class c WHERE c.oid=ANY(ARRAY['public.accounting_payable_earning_sources'::regclass,'public.accounting_effective_cash_rake_sources'::regclass]))IS DISTINCT FROM v THEN RAISE EXCEPTION 'summary_scope_postimage_required';END IF;
END$summary_scope$;
COMMIT;
