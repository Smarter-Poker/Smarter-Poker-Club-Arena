-- Original full JUDGED failed60s after scalar covers. Group source facts by
-- DISTINCT original deposit key+time, then LEFT JOIN to every original deposit.
-- All typed bags, n0/foreign/time/multiplicity and original ordered aggregates
-- are preserved; no sourceSUM, ledger proof, view, financial or budget change.
-- Native82 and actual rollback wholeSummary170.123s passed; wholeScope unknown.
-- @live-proof: md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure))='61cbf136ccaa855d7e1a41fe483a1b5f'
BEGIN;
SET LOCAL lock_timeout='1s';SET LOCAL statement_timeout='5s';
DO $summary_scope$
DECLARE d text;n text;m jsonb;g text;seal text;v jsonb;
 old_queries constant text[]:=ARRAY[$old0$ ), judged AS (
  SELECT b.*,cg.n+tg.n AS n,COALESCE(cg.total,0)+COALESCE(tg.total,0) AS total,cg.bad+tg.bad AS bad,
   COALESCE(cg.mine,false) OR COALESCE(tg.mine,false) AS mine
  FROM (SELECT * FROM deposits ORDER BY source_type,banked_at,source_group) b
  CROSS JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total,
    count(*) FILTER(WHERE s.club_id IS DISTINCT FROM period.club_id OR s.union_id IS NOT NULL
     OR s.coordinator_union_id IS DISTINCT FROM period.union_id OR s.earned_at IS DISTINCT FROM b.banked_at) AS bad,
    bool_or(s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id) AS mine
   FROM public.accounting_cash_rake_sources s WHERE b.source_type='cash_rake_accrual' AND s.rake_record_id=b.source_group OFFSET 0) cg
  CROSS JOIN LATERAL (SELECT count(*) AS n,sum(s.rake_credit) AS total,
    count(*) FILTER(WHERE s.club_id IS DISTINCT FROM period.club_id OR s.union_id IS NOT NULL
     OR s.coordinator_union_id IS DISTINCT FROM period.union_id OR s.earned_at IS DISTINCT FROM b.banked_at) AS bad,
    bool_or(s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id) AS mine
   FROM public.accounting_payable_earning_sources s WHERE b.source_type='tournament_fee_accrual' AND s.source_type='tournament_fee_accrual'
    AND s.tournament_id=b.source_group OFFSET 0) tg
$old0$];
 new_queries constant text[]:=ARRAY[$new0$ ), deposit_source_keys AS MATERIALIZED (
  SELECT DISTINCT source_type,source_group,banked_at FROM deposits
 ), cash_source_groups AS MATERIALIZED (
  SELECT k.source_group,k.banked_at,count(*) AS n,sum(s.rake_credit) AS total,
   count(*) FILTER(WHERE s.club_id IS DISTINCT FROM period.club_id OR s.union_id IS NOT NULL
    OR s.coordinator_union_id IS DISTINCT FROM period.union_id OR s.earned_at IS DISTINCT FROM k.banked_at) AS bad,
   bool_or(s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id) AS mine
  FROM deposit_source_keys k JOIN public.accounting_cash_rake_sources s ON s.rake_record_id=k.source_group
  WHERE k.source_type='cash_rake_accrual' GROUP BY k.source_group,k.banked_at
 ), tournament_source_groups AS MATERIALIZED (
  SELECT k.source_group,k.banked_at,count(*) AS n,sum(s.rake_credit) AS total,
   count(*) FILTER(WHERE s.club_id IS DISTINCT FROM period.club_id OR s.union_id IS NOT NULL
    OR s.coordinator_union_id IS DISTINCT FROM period.union_id OR s.earned_at IS DISTINCT FROM k.banked_at) AS bad,
   bool_or(s.club_id=period.club_id AND s.coordinator_union_id IS NOT DISTINCT FROM period.union_id) AS mine
  FROM deposit_source_keys k JOIN public.accounting_payable_earning_sources s ON s.tournament_id=k.source_group
  WHERE k.source_type='tournament_fee_accrual' AND s.source_type='tournament_fee_accrual'
  GROUP BY k.source_group,k.banked_at
 ), judged AS (
  SELECT b.*,COALESCE(cg.n,0)+COALESCE(tg.n,0) AS n,COALESCE(cg.total,0)+COALESCE(tg.total,0) AS total,
   COALESCE(cg.bad,0)+COALESCE(tg.bad,0) AS bad,
   COALESCE(cg.mine,false) OR COALESCE(tg.mine,false) AS mine
  FROM (SELECT * FROM deposits ORDER BY source_type,banked_at,source_group) b
  LEFT JOIN cash_source_groups cg ON b.source_type='cash_rake_accrual' AND cg.source_group=b.source_group
   AND cg.banked_at IS NOT DISTINCT FROM b.banked_at
  LEFT JOIN tournament_source_groups tg ON b.source_type='tournament_fee_accrual' AND tg.source_group=b.source_group
   AND tg.banked_at IS NOT DISTINCT FROM b.banked_at
$new0$];
 i integer;
BEGIN
 IF current_user<>'postgres'OR session_user<>'postgres'OR auth.uid()IS NOT NULL OR NULLIF(current_setting('request.jwt.claims',true),'')IS NOT NULL OR NULLIF(current_setting('request.jwt.claim.role',true),'')IS NOT NULL OR NULLIF(current_setting('ca.break_window_migration_override',true),'')IS NOT NULL THEN RAISE EXCEPTION 'summary_scope_operator_refused';END IF;
 IF public.fn_ca_break_window_refuses_migrations(now())IS NOT NULL OR public.fn_platform_frozen()IS DISTINCT FROM false OR public.fn_active_maintenance_release_boundary()IS NOT NULL THEN RAISE EXCEPTION 'summary_scope_window_refused';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0))THEN RAISE EXCEPTION 'summary_scope_scheduler_owned';END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261028053643')THEN RAISE EXCEPTION 'summary_scope_history_replay';END IF;
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO STRICT d,m FROM pg_proc p WHERE p.oid='public.fn_club_weekly_accounting_summary(uuid)'::regprocedure;
 IF m IS DISTINCT FROM ($expected${"oid":"31416606","proacl":["postgres=X/postgres","authenticated=X/postgres","service_role=X/postgres"],"probin":null,"procost":100,"prokind":"f","prolang":"13573","proname":"fn_club_weekly_accounting_summary","prorows":0,"pronargs":1,"proowner":"16384","proconfig":["search_path=public"],"proretset":false,"prosecdef":true,"prorettype":"3802","prosqlbody":null,"prosupport":"-","proargmodes":null,"proargnames":["p_period_id"],"proargtypes":["2950"],"proisstrict":false,"proparallel":"u","protrftypes":null,"provariadic":"0","provolatile":"s","proleakproof":false,"pronamespace":"2200","proallargtypes":null,"proargdefaults":null,"pronargdefaults":0}$expected$::jsonb||jsonb_build_object('oid',m->'oid','prolang',(SELECT oid::text FROM pg_language WHERE lanname='plpgsql'),'proowner','postgres'::regrole::oid::text,'pronamespace','public'::regnamespace::oid::text))THEN RAISE EXCEPTION 'summary_scope_exact_preimage_required';END IF;
 IF md5(d)<>'b00039e968bc69a56046c2fe0634fc8b'OR m->>'proowner'IS DISTINCT FROM'postgres'::regrole::oid::text OR m->>'provolatile'IS DISTINCT FROM's' OR m->'prosecdef'IS DISTINCT FROM'true'::jsonb OR m->'proconfig'IS DISTINCT FROM'["search_path=public"]'::jsonb OR(SELECT proacl::text FROM pg_proc WHERE oid='public.fn_club_weekly_accounting_summary(uuid)'::regprocedure)IS DISTINCT FROM'{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}' THEN RAISE EXCEPTION 'summary_scope_exact_preimage_required';END IF;
 FOR i IN 1..1 LOOP IF(length(d)-length(replace(d,old_queries[i],'')))/length(old_queries[i])<>1 THEN RAISE EXCEPTION 'summary_scope_exact_preimage_required';END IF;END LOOP;
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true THEN RAISE EXCEPTION 'summary_scope_source65_required';END IF;
 g:=smarter_private.original_inventory_basis_generation();seal:=pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure);
 IF g IS NULL THEN RAISE EXCEPTION 'summary_scope_generation_required';END IF;
 SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'definition',pg_get_viewdef(c.oid,true),'catalog',to_jsonb(c))ORDER BY c.oid)INTO v FROM pg_class c WHERE c.oid=ANY(ARRAY['public.accounting_payable_earning_sources'::regclass,'public.accounting_effective_cash_rake_sources'::regclass]);
 n:=d;FOR i IN 1..1 LOOP n:=replace(n,old_queries[i],new_queries[i]);END LOOP;IF md5(n)<>'61cbf136ccaa855d7e1a41fe483a1b5f'THEN RAISE EXCEPTION 'summary_scope_exact_patch_required';END IF;
 EXECUTE n;
 IF md5(pg_get_functiondef('public.fn_club_weekly_accounting_summary(uuid)'::regprocedure))<>'61cbf136ccaa855d7e1a41fe483a1b5f'OR(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE p.oid='public.fn_club_weekly_accounting_summary(uuid)'::regprocedure)IS DISTINCT FROM m OR pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure)IS DISTINCT FROM seal OR smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR smarter_private.original_inventory_basis_generation()IS DISTINCT FROM g OR(SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'definition',pg_get_viewdef(c.oid,true),'catalog',to_jsonb(c))ORDER BY c.oid)FROM pg_class c WHERE c.oid=ANY(ARRAY['public.accounting_payable_earning_sources'::regclass,'public.accounting_effective_cash_rake_sources'::regclass]))IS DISTINCT FROM v THEN RAISE EXCEPTION 'summary_scope_postimage_required';END IF;
END$summary_scope$;
COMMIT;
