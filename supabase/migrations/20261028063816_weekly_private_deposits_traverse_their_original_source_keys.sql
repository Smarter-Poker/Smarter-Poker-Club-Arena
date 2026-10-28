-- Traverse the same complete original DISTINCT source keys in their btree order.
-- No source filter, LIMIT, sourceSUM, ledger, financial, ACL or budget change.
-- Native28 retains full6field source groups and originalordered aggregate bags.
-- Actual full86197ID parity and mandatoryrollback wholeSummary168.379s READY
-- passed; cacheconfounded timings do not certify causal/fullScope improvement.
-- @live-proof: md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure))='2f04687065b767f826d08a822cc3174d'
BEGIN;
SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s';
DO $summary_scope$
DECLARE d text;n text;m jsonb;g text;seal text;v jsonb;
 old_queries constant text[]:=ARRAY[$old0$  SELECT DISTINCT source_type,source_group,banked_at FROM deposits
$old0$];
 new_queries constant text[]:=ARRAY[$new0$  SELECT DISTINCT source_type,source_group,banked_at FROM deposits
  ORDER BY source_type,source_group,banked_at
$new0$];
 i integer;
BEGIN
 IF current_user<>'postgres'OR session_user<>'postgres'OR auth.uid()IS NOT NULL OR NULLIF(current_setting('request.jwt.claims',true),'')IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'')IS NOT NULL OR NULLIF(current_setting('ca.break_window_migration_override',true),'')IS NOT NULL THEN RAISE EXCEPTION 'summary_scope_operator_refused';END IF;
 IF public.fn_ca_break_window_refuses_migrations(now())IS NOT NULL OR public.fn_platform_frozen()IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary()IS NOT NULL THEN RAISE EXCEPTION 'summary_scope_window_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0))THEN RAISE EXCEPTION 'summary_scope_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261028063816')THEN RAISE EXCEPTION 'summary_scope_history_replay';END IF;
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO STRICT d,m FROM pg_proc p WHERE p.oid='public.fn_club_weekly_accounting_summary(uuid)'::regprocedure;
 IF m IS DISTINCT FROM ($expected${"oid":"31416606","proacl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_club_weekly_accounting_summary","prorows":0,"pronargs":1,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_period_id"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$expected$::jsonb||jsonb_build_object('oid',m->'oid','prolang',(SELECT oid::text FROM pg_language WHERE lanname='plpgsql'),'proowner','postgres'::regrole::oid::text,'pronamespace','public'::regnamespace::oid::text))THEN RAISE EXCEPTION 'summary_scope_exact_preimage_required';END IF;
 IF md5(d)<>'61cbf136ccaa855d7e1a41fe483a1b5f'OR m->>'proowner'IS DISTINCT FROM'postgres'::regrole::oid::text OR m->>'provolatile'IS DISTINCT FROM's' OR m->'prosecdef'IS DISTINCT FROM'true'::jsonb OR m->'proconfig'IS DISTINCT FROM'["search_path=public"]'::jsonb OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_club_weekly_accounting_summary(uuid)'::regprocedure)IS DISTINCT FROM'{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'summary_scope_exact_preimage_required';END IF;
 FOR i IN 1..1 LOOP IF(length(d)-length(replace(d,old_queries[i],'')))/length(old_queries[i])<>1 THEN RAISE EXCEPTION 'summary_scope_exact_preimage_required';END IF;END LOOP;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'summary_scope_source65_required';END IF;
 g:=smarter_private.original_inventory_basis_generation();seal:=pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure);
 IF g IS NULL THEN RAISE EXCEPTION 'summary_scope_generation_required';END IF;
 SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'definition',pg_get_viewdef(c.oid,true),'catalog',to_jsonb(c))ORDER BY c.oid)INTO v FROM pg_class c WHERE c.oid=ANY(ARRAY['public.accounting_payable_earning_sources'::regclass,'public.accounting_effective_cash_rake_sources'::regclass]);
 n:=d;FOR i IN 1..1 LOOP n:=replace(n,old_queries[i],new_queries[i]);END LOOP;IF md5(n)<>'2f04687065b767f826d08a822cc3174d'THEN RAISE EXCEPTION 'summary_scope_exact_patch_required';END IF;
 EXECUTE n;
 IF md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure))<>'2f04687065b767f826d08a822cc3174d'OR(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE p.oid='public.fn_club_weekly_accounting_summary(uuid)'::regprocedure)IS DISTINCT FROM m OR pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure)IS DISTINCT FROM seal OR smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM g OR(SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'definition',pg_get_viewdef(c.oid,true),'catalog',to_jsonb(c))ORDER BY c.oid)FROM pg_class c WHERE c.oid=ANY(ARRAY['public.accounting_payable_earning_sources'::regclass,'public.accounting_effective_cash_rake_sources'::regclass]))IS DISTINCT FROM v THEN RAISE EXCEPTION 'summary_scope_postimage_required';END IF;
END$summary_scope$;
COMMIT;
