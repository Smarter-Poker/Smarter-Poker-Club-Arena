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
 PERFORM pg_temp.assert_pnl_hook(strpos(source,'DELETE FROM pg_temp._pnl_tmp WHERE true;')>0
  AND strpos(source,'DELETE FROM pg_temp._pnl_tmp;')=0,
  'installed P&L scratch cleanup carries the predicate required by safeupdate');
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

-- ===========================================================================
-- THE SQUARE-UP QUOTES THE RECORDED ECO, AND THE RAKE LEG NAMES ITS CLUB
-- (20260921023420)
--
-- fn_union_eco_adjustment is a VOLATILE recomputation of the whole week's
-- P&L. fn_union_settlement_cascade runs it several times in one settlement -
-- fn_union_eco_record WRITES union_eco_ledger from one call, and
-- fn_union_club_invoice used to re-derive the ECO from ANOTHER. Under READ
-- COMMITTED those are two snapshots and can be two answers: on 2026-09-14 the
-- square-up for club a41434bb stated 11244.03 against a recorded -11242.82,
-- overstating that club's debt by 1.21 while its other three figures matched
-- the ledger exactly. A money document quotes the record.
-- ===========================================================================
DO $$DECLARE source text;
BEGIN
 SELECT pg_get_functiondef(oid) INTO source
   FROM pg_proc WHERE oid='public.fn_union_club_invoice(uuid,timestamptz,timestamptz)'::regprocedure;
 PERFORM pg_temp.assert_pnl_hook(strpos(source,'FROM union_eco_ledger l')>0
  AND strpos(source,'COALESCE(rec.eco_amount, eco.eco_amount)')>0,
  'the square-up reads the recorded union_eco_ledger row and prefers it over a second live recomputation');
 SELECT prosrc INTO source FROM pg_proc
   WHERE oid='public.fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean)'::regprocedure;
 PERFORM pg_temp.assert_pnl_hook(strpos(source,'union_squareup_eco_not_recorded')>0
  AND strpos(source,'union_squareup_eco_disagrees_with_record')>0
  AND strpos(source,'union_squareup_eco_disagrees_with_record')<strpos(source,'INSERT INTO settlement_invoices'),
  'an ECO-enabled square-up with no recorded ECO, and any square-up that disagrees with its record, is refused before the document is written');
 SELECT prosrc INTO source FROM pg_proc
   WHERE oid='public.atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)'::regprocedure;
 PERFORM pg_temp.assert_pnl_hook(
  (length(source)-length(replace(source,'app.ledger_autoledger_club_id','')))
   /length('app.ledger_autoledger_club_id')=3
  AND strpos(source,'set_config(''app.ledger_autoledger_club_id'', COALESCE(p_club_id::text')>0,
  'the rake producer names the club it was earned in on the autoledger declaration, and clears it before every return so a later union leg cannot inherit it');
END $$;

-- Whatever ECO this fixture has recorded, no square-up may state a different
-- one. Vacuously true for a period with no recorded ECO; never weakened to
-- accept a disagreement.
DO $$DECLARE bad int;
BEGIN
 SELECT count(*) INTO bad
   FROM public.union_eco_ledger l
   CROSS JOIN LATERAL public.fn_union_club_invoice(l.union_id,l.period_start,l.period_end) i
  WHERE i.club_id=l.club_id AND i.eco_enabled
    AND round(i.eco_amount,2) IS DISTINCT FROM round(l.eco_amount,2);
 PERFORM pg_temp.assert_pnl_hook(bad=0,
  format('every recorded ECO is the figure its square-up states (%s disagreeing)',bad));
END $$;

-- ===========================================================================
-- THE TOURNAMENT RAKE LEG NAMES THE CLUB IT WAS EARNED IN (20260921065613)
--
-- 20260921040847 fixed the CASH rake payer and the union cash rake leg has
-- named its club since ~04:08Z on 2026-09-21. One producer was left: union
-- rake also arrives from a tournament fee. fn_settle_tournament_rake declares
-- the ledger category, the counterparty 'prize_liability' and the
-- counterparty entity for exactly those legs, then credits
-- union_wallets.rake_wallet through increment_union_wallet - and never said
-- which club. union_wallets has no club_id column, so fn_ca_autoledger took
-- the ELSE branch of its club CASE and wrote the leg club-less. Measured on
-- production 2026-09-21 06:50Z: of 436 union rake legs written after the cash
-- fix, 435 came from_type='table_stack' and named their club; the 1 that did
-- not was from_type='prize_liability' - chip_ledger
-- 7c1236b3-5b71-4859-9c30-d0c5dd8bce15, 80.00, club_id NULL - while its
-- sibling union_wallet_transactions row recorded the club perfectly well.
-- from_type on a credit IS the payer's declared app.ledger_counterparty, so
-- it names the producer; that is how the two were told apart.
-- ===========================================================================
DO $$DECLARE source text;
BEGIN
 SELECT prosrc INTO source FROM pg_proc
   WHERE oid='public.fn_settle_tournament_rake(uuid,text)'::regprocedure;
 PERFORM pg_temp.assert_pnl_hook(
  (length(source)-length(replace(source,'app.ledger_autoledger_club_id','')))
   /length('app.ledger_autoledger_club_id')=2
  AND strpos(source,'set_config(''app.ledger_autoledger_club_id'',COALESCE(v_t.club_id::text')>0,
  'the tournament rake payer names the club its fee was earned in on the autoledger declaration, and clears it once');
 -- Order is the whole contract. A declaration made after the credit journals
 -- nothing, and a clear made before it would journal nothing either. Match the
 -- CALL and not the bare name: the declaration's own comment names the helper
 -- too, and strpos would find that comment first.
 PERFORM pg_temp.assert_pnl_hook(
  strpos(source,'set_config(''app.ledger_autoledger_club_id'',COALESCE(v_t.club_id::text')
    < strpos(source,'public.increment_union_wallet(')
  AND strpos(source,'set_config(''app.ledger_autoledger_club_id'','''',true)')
    > strpos(source,'public.increment_union_wallet('),
  'the club declaration and its clear bracket the union credit, so the leg is journalled inside the declared window and no later leg inherits it');
 -- The declaration can only be honest because a club-less tournament fee is
 -- refused before any wallet is touched. If that refusal goes, the payer can
 -- declare an empty club and this assertion must fail rather than pass quietly.
 PERFORM pg_temp.assert_pnl_hook(
  strpos(source,'IF v_t.club_id IS NULL THEN RAISE EXCEPTION ''tournament_fee_bank_club_required''')>0,
  'a tournament fee with no bank club is still refused, so the declared club can never be empty');
END $$;

-- EVERY PRODUCER OF A UNION RAKE CREDIT NAMES THE CLUB IT WAS EARNED IN.
-- Not a list of the two known payers: the rule is derived from the catalog,
-- so a third door added later is caught the day it appears. A union rake
-- credit is a function that increments union_wallets.rake_wallet, or that
-- reaches it through increment_union_wallet. The rakeback payers that
-- DECREMENT the same column (fn_union_weekly_rakeback_close,
-- fn_union_send_to_member_zd3core) are not rake producers and are correctly
-- outside this rule; increment_union_wallet itself holds no club of its own
-- and is only ever reached through a caller this rule covers.
DO $$DECLARE bad text;
BEGIN
 SELECT string_agg(p.proname,', ' ORDER BY p.proname) INTO bad
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f'
    AND p.proname<>'increment_union_wallet'
    AND (p.prosrc ~ 'rake_wallet\s*=\s*[a-zA-Z_.]*rake_wallet\s*\+'
         OR strpos(p.prosrc,'public.increment_union_wallet(')>0)
    AND strpos(p.prosrc,'app.ledger_autoledger_club_id')=0;
 PERFORM pg_temp.assert_pnl_hook(bad IS NULL,
  format('every union rake credit producer declares the club its leg was earned in (%s does not)',
         COALESCE(bad,'none')));
END $$;
ROLLBACK;
