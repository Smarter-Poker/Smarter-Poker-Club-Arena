-- UNRUN. For the protected native owner only, after the full actual catalog,
-- the existing accounting component plan, N, P&L reader, hooks and fairness.
-- Load hooks-seed.sql after the actual lifecycle seed. Wrapper definitions
-- must already have been bound and loaded before the candidate; their missing
-- captured owner/ACL limits these wrapper cases to owner-executed behavior.
-- This is test source, not authorization to execute a direct native fallback.
-- All fixture changes below are rolled back. The actual guarded functions must
-- be installed by the qualified catalog plan; do not replace them with mocks.
BEGIN;
CREATE FUNCTION pg_temp.assert_pnl_hook(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
 IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
 RAISE NOTICE 'PASS: %',label;
END $$;

-- Check source order in addition to runtime refusal: this placement keeps
-- financial locks and mutations outside an uncertified union attempt.
DO $$DECLARE source text;auth_at int;lock_at int;cash_at int;quality_at int;discovery_at int;payer_at int;
BEGIN
 SELECT prosrc INTO source FROM pg_proc WHERE oid='public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure;
 auth_at:=strpos(source,'IF NOT public.fn_caller_is_engine()');
 lock_at:=strpos(source,'PERFORM pg_advisory_xact_lock');
 cash_at:=strpos(source,'source_check:=public.fn_cash_source_refusals_for_period');
 quality_at:=strpos(source,'source_check:=public.fn_union_pnl_close_quality');
 discovery_at:=strpos(source,'SELECT COALESCE(array_agg(c.club_id');
 payer_at:=strpos(source,'PERFORM public.fn_lock_rakeback_payer_clubs');
 PERFORM pg_temp.assert_pnl_hook(auth_at>0 AND auth_at<lock_at AND lock_at<cash_at AND cash_at<quality_at
  AND quality_at<discovery_at AND discovery_at<payer_at,'authorization and week lock precede union quality; discovery and payer work follow it');
 PERFORM pg_temp.assert_pnl_hook(strpos(source,E'IF p_union_id IS NOT NULL THEN\n  source_check:=public.fn_union_pnl_close_quality')>0,
  'P&L quality is conditional on union scope and does not gate standalone preparation');
 SELECT prosrc INTO source FROM pg_proc WHERE oid='public.fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean)'::regprocedure;
 PERFORM pg_temp.assert_pnl_hook(strpos(source,$auth$RETURN jsonb_build_object('success', false, 'error', 'not authorized')$auth$)
  <strpos(source,'PERFORM public.fn_require_union_pnl_evidence')
  AND strpos(source,'PERFORM public.fn_require_union_pnl_evidence')<strpos(source,'INSERT INTO settlement_invoices'),
  'invoice gate follows original authorization and precedes invoice issuance');
 SELECT prosrc INTO source FROM pg_proc WHERE oid='public.fn_union_eco_record(uuid,timestamptz,timestamptz,uuid)'::regprocedure;
 PERFORM pg_temp.assert_pnl_hook(strpos(source,$auth$RETURN jsonb_build_object('success', false, 'error', 'not authorized')$auth$)
  <strpos(source,'PERFORM public.fn_require_union_pnl_evidence')
  AND strpos(source,'PERFORM public.fn_require_union_pnl_evidence')<strpos(source,'INSERT INTO union_eco_ledger'),
  'ECO writer gate follows original authorization and precedes any ledger upsert');
 SELECT prosrc INTO source FROM pg_proc WHERE oid='public.fn_union_eco_adjustment(uuid,timestamptz,timestamptz)'::regprocedure;
 PERFORM pg_temp.assert_pnl_hook(strpos(source,'not authorized to read union reconciliation')
  <strpos(source,'PERFORM public.fn_require_union_pnl_evidence')
  AND strpos(source,'PERFORM public.fn_require_union_pnl_evidence')<strpos(source,'v_exact := (v_prev IS NULL)'),
  'ECO read authorization precedes evidence; missing baseline cannot reach old exactness calculation');
 SELECT prosrc INTO source FROM pg_proc WHERE oid='public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure;
 PERFORM pg_temp.assert_pnl_hook(strpos(source,$predicate$      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3'
        AND public.fn_union_pnl_close_quality(v_union.id,v_from,v_end)->>'status'='ready' THEN$predicate$)>0,
  'old successful union receipt cannot skip the current P&L quality requirement');
 SELECT prosrc INTO source FROM pg_proc WHERE oid='public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)'::regprocedure;
 PERFORM pg_temp.assert_pnl_hook(strpos(source,'IF NOT public.fn_caller_is_engine()')
  <strpos(source,'PERFORM public.fn_require_union_pnl_evidence')
  AND strpos(source,'PERFORM public.fn_require_union_pnl_evidence')<strpos(source,'SELECT * INTO v_existing')
  AND strpos(source,'PERFORM public.fn_require_union_pnl_evidence')<strpos(source,'CREATE TEMP TABLE'),
  'direct core preview, replay and payment all require quality before claims or calculation');
END $$;

DO $$DECLARE q jsonb;detail text;
BEGIN
 q:=public.fn_union_pnl_close_quality('00000000-0000-0000-0000-000000700001','2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM pg_temp.assert_pnl_hook(q->>'status'='blocked' AND q->>'reason'='union_pnl_basis_uncertified'
  AND q->'issues' ? 'canonical_pnl_coverage_manifest_missing','missing source capture blocks union closing quality');
 PERFORM pg_temp.assert_pnl_hook(NOT q ? 'opening_snapshot_candidates' AND NOT q ? 'observed_journal_flows'
  AND NOT q ? 'posted_pnl_payment_evidence','close refusal contains reason codes without financial details');
 BEGIN
  PERFORM public.fn_require_union_pnl_evidence('00000000-0000-0000-0000-000000700001','2026-09-07 07:00Z','2026-09-14 07:00Z');
  RAISE EXCEPTION 'unexpectedly accepted uncertified union';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL;
  PERFORM pg_temp.assert_pnl_hook(detail::jsonb=q,'direct guard raises the same stable structured refusal');
 END;
 q:=public.fn_union_pnl_close_quality('00000000-0000-0000-0000-000000700001',now()-interval '1 day',now()+interval '1 day');
 PERFORM pg_temp.assert_pnl_hook(q->>'status'='blocked' AND q->>'reason'='pnl_requires_closed_supported_period',
  'current-week ECO cannot be recorded as certified closing evidence');
END $$;

-- Actual caller authorization must remain first. The fixture identity must
-- have no union-admin/owner or accounting-read role in the qualified catalog.
DO $$BEGIN
 IF EXISTS(SELECT 1 FROM public.unions WHERE owner_id='00000000-0000-0000-0000-000000700099')
  OR EXISTS(SELECT 1 FROM public.union_admins WHERE user_id='00000000-0000-0000-0000-000000700099')
  OR EXISTS(SELECT 1 FROM public.club_members WHERE user_id='00000000-0000-0000-0000-000000700099') THEN
  RAISE EXCEPTION 'pnl_hook_fixture_identity_conflicts'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000700099',true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000700099","role":"authenticated"}',true);
DO $$DECLARE answer jsonb;detail text;
BEGIN
 answer:=public.fn_union_issue_weekly_invoices('00000000-0000-0000-0000-000000700001','2026-09-07 07:00Z','2026-09-14 07:00Z',true);
 PERFORM pg_temp.assert_pnl_hook(answer='{"success":false,"error":"not authorized"}'::jsonb,'unauthorized invoice caller receives only the original denial');
 answer:=public.fn_union_eco_record('00000000-0000-0000-0000-000000700001','2026-09-07 07:00Z','2026-09-14 07:00Z',NULL);
 PERFORM pg_temp.assert_pnl_hook(answer='{"success":false,"error":"not authorized"}'::jsonb,'unauthorized ECO writer receives only the original denial');
 BEGIN
  PERFORM * FROM public.fn_union_eco_adjustment('00000000-0000-0000-0000-000000700001','2026-09-07 07:00Z','2026-09-14 07:00Z');
  RAISE EXCEPTION 'unexpectedly authorized ECO reader';
 EXCEPTION WHEN insufficient_privilege THEN
  GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL;
  PERFORM pg_temp.assert_pnl_hook(COALESCE(detail,'')='','unauthorized ECO reader receives no diagnostic financial details');
 END;
END $$;
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
DO $$DECLARE detail text;before_invoices bigint;before_eco bigint;result jsonb;
BEGIN
 SELECT count(*) INTO before_invoices FROM public.settlement_invoices;
 SELECT count(*) INTO before_eco FROM public.union_eco_ledger;
 BEGIN
  PERFORM public.fn_union_issue_weekly_invoices('00000000-0000-0000-0000-000000700001','2026-09-07 07:00Z','2026-09-14 07:00Z',true);
  RAISE EXCEPTION 'issuer unexpectedly accepted unverified P&L';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL;
  PERFORM pg_temp.assert_pnl_hook(detail::jsonb->>'reason'='union_pnl_basis_uncertified','authorized direct issuer refuses uncertified calculation');
 END;
 BEGIN
  PERFORM public.fn_union_eco_record('00000000-0000-0000-0000-000000700001','2026-09-07 07:00Z','2026-09-14 07:00Z',NULL);
  RAISE EXCEPTION 'ECO writer unexpectedly accepted unverified P&L';
 EXCEPTION WHEN SQLSTATE '55000' THEN
  GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL;
  PERFORM pg_temp.assert_pnl_hook(detail::jsonb->>'reason'='union_pnl_basis_uncertified','authorized direct ECO writer refuses uncertified calculation');
 END;
 result:=public.fn_prepare_accounting_week('00000000-0000-0000-0000-000000700001',NULL,'2026-09-07 07:00Z','2026-09-14 07:00Z');
 PERFORM pg_temp.assert_pnl_hook(result->>'success'='false' AND result->'clubs'='0'::jsonb,
  'authorized union preparation returns durable failure before any payer work');
 PERFORM pg_temp.assert_pnl_hook((SELECT count(*) FROM public.settlement_invoices)=before_invoices
  AND (SELECT count(*) FROM public.union_eco_ledger)=before_eco,'refusal writes no invoices or ECO rows');
END $$;
-- The protected fixture must include at least one real union with a supported
-- floor. The old wrappers are loaded from the captured original metadata, not
-- replaced with a mock that merely calls the desired guard.
DO $$DECLARE u_id uuid;answer jsonb;detail text;signature text;before_claims bigint;
BEGIN
 SELECT u.id INTO u_id FROM public.unions u JOIN public.union_settlement_floor f ON f.union_id=u.id
  WHERE u.id='00000000-0000-0000-0000-000000700002'
   AND f.earliest_period_start='2026-09-07 07:00Z';
 IF u_id IS NULL THEN RAISE EXCEPTION 'pnl_hook_fixture_requires_supported_union'; END IF;
 IF EXISTS(SELECT 1 FROM public.union_pnl_settlements WHERE union_id=u_id) THEN
  RAISE EXCEPTION 'pnl_hook_fixture_must_not_fabricate_baseline_or_claim'; END IF;
 SELECT count(*) INTO before_claims FROM public.union_pnl_settlements;
 FOREACH signature IN ARRAY ARRAY['preview','payment','guarded','weekly','invoice_reader'] LOOP
  BEGIN
   CASE signature
    WHEN 'preview' THEN answer:=public.fn_union_settle_player_pnl(u_id,'2026-09-07 07:00Z','2026-09-14 07:00Z',true);
    WHEN 'payment' THEN answer:=public.fn_union_settle_player_pnl(u_id,'2026-09-07 07:00Z','2026-09-14 07:00Z',false);
    WHEN 'guarded' THEN answer:=public.fn_union_settle_player_pnl_guarded(u_id,'2026-09-07 07:00Z','2026-09-14 07:00Z',NULL);
    WHEN 'weekly' THEN answer:=public.fn_union_settle_player_pnl_weekly(u_id,0);
    WHEN 'invoice_reader' THEN PERFORM * FROM public.fn_union_club_invoice(u_id,'2026-09-07 07:00Z','2026-09-14 07:00Z');
   END CASE;
   RAISE EXCEPTION 'uncertified path % unexpectedly returned %',signature,answer;
  EXCEPTION WHEN SQLSTATE '55000' THEN
   GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL;
   PERFORM pg_temp.assert_pnl_hook(detail::jsonb->>'status'='blocked','actual '||signature||' caller reaches one quality refusal');
  END;
 END LOOP;
 PERFORM pg_temp.assert_pnl_hook((SELECT count(*) FROM public.union_pnl_settlements)=before_claims,
  'manual wrappers and previews cannot insert claims while source evidence is uncertified');
END $$;
SELECT pg_temp.assert_pnl_hook(NOT has_function_privilege('authenticated','public.fn_union_pnl_close_quality(uuid,timestamptz,timestamptz)','EXECUTE')
 AND NOT has_function_privilege('service_role','public.fn_require_union_pnl_evidence(uuid,timestamptz,timestamptz)','EXECUTE'),
 'new close helpers remain private to existing authorized owners');
-- The full fixture restores the later captured owner/ACL through
-- full-weekly-accounting/supplemental-function-access.sql. Preserve that exact
-- authority, including its service grant, rather than the initial withheld ACL.
SELECT pg_temp.assert_pnl_hook((
 SELECT count(*)=2 AND bool_and(
  pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
  AND ARRAY(SELECT a::text FROM unnest(p.proacl) a ORDER BY a::text)
   =ARRAY['postgres=X/postgres','service_role=X/postgres']
  AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
  AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')
  AND has_function_privilege('service_role',p.oid,'EXECUTE'))
 FROM unnest(ARRAY['public.fn_union_settle_player_pnl_guarded(uuid,timestamptz,timestamptz,numeric)',
  'public.fn_union_settle_player_pnl_weekly(uuid,numeric)']) f(signature)
 JOIN pg_proc p ON p.oid=to_regprocedure(f.signature)),
 'both wrappers preserve exact captured owner and ACL with service-only client execution; this is not live authorization proof');
ROLLBACK;
