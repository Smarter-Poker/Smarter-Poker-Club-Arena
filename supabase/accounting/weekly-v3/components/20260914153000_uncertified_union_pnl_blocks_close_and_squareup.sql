-- SOURCE/REVIEW ONLY. New hook qualification is UNRUN: the protected local
-- execution adapter is not operational. Requires the P&L reader and N first.
-- No historical invoice, ECO row, baseline, payment or rate is changed here.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';

-- N's resulting pg_get_functiondef MD5 was not captured before the execution
-- policy changed. Compare its EXACT stored body and catalog contract instead.
-- This literal is copied from component 20260914152500, not from an invented
-- postimage hash. Protected qualification must prove the comparison and record
-- the resulting installed-definition hash before this hook is admitted.
DO $guard$
DECLARE v_prepare oid:='public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure;
 v_expected_prepare constant text:=$expected_prepare$
DECLARE clubs uuid[];club uuid;result jsonb;problems jsonb:='[]';from_date date;to_date date;ready boolean;verified boolean;source_check jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to)
  OR p_from IS DISTINCT FROM public.fn_union_week_start(p_from)
  OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days') OR p_to>now()
 THEN RAISE EXCEPTION 'accounting_preparation_requires_closed_week' USING ERRCODE='22023'; END IF;
 from_date:=(p_from AT TIME ZONE 'America/Los_Angeles')::date;to_date:=(p_to AT TIME ZONE 'America/Los_Angeles')::date-1;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) THEN RAISE EXCEPTION 'invalid_accounting_scope' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
  CASE WHEN p_union_id IS NOT NULL THEN 'union-accounting:' ELSE 'club-accounting:' END
   ||COALESCE(p_union_id,p_club_id)::text||':'||extract(epoch FROM p_from)::text||':'||extract(epoch FROM p_to)::text,0));
 -- The source queue is part of this book. Check it under the same week lock,
 -- before discovery, payer locks, calculations, or any financial stage.
 source_check:=public.fn_cash_source_refusals_for_period(p_union_id,p_club_id,p_from,p_to);
 IF source_check->>'status' IS DISTINCT FROM 'ready'
  OR source_check->'count' IS DISTINCT FROM '0'::jsonb
  OR source_check->'sources' IS DISTINCT FROM '[]'::jsonb THEN
  RETURN jsonb_build_object('success',false,'accounting_version',3,
   'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,
   'problems',jsonb_build_array(jsonb_build_object('reason','cash_source_refusals_pending',
    'source_check',source_check)));
 END IF;
 SELECT COALESCE(array_agg(c.club_id ORDER BY c.club_id),ARRAY[]::uuid[]) INTO clubs
  FROM public.fn_accounting_week_clubs(p_union_id,p_club_id,p_from,p_to)c;
 -- Same order as the routing stages, before Round 1 takes any treasury row.
 PERFORM public.fn_lock_rakeback_payer_clubs(clubs);
 FOREACH club IN ARRAY clubs LOOP
  result:=public.fn_rakeback_recompute_periods(club,from_date,to_date,NULL);
  ready:=result->>'accounting_version'='2' AND result->>'club_id'=club::text
   AND result->>'period_start'=from_date::text AND result->>'period_end'=to_date::text
   AND result->>'status'='ready' AND result->>'request_state'='complete' AND result->>'request_recorded'='true';
  SELECT EXISTS(SELECT 1 FROM public.accounting_period_recompute_requests q
   WHERE q.id::text=result->>'request_id' AND q.club_id=club AND q.period_start=from_date AND q.period_end=to_date
    AND to_jsonb(q.requested_at)=result->'requested_at' AND q.status='complete'
    AND q.last_result->>'accounting_version'='2' AND q.last_result->>'status'='ready'
    AND q.last_result->>'club_id'=club::text AND q.last_result->>'period_start'=from_date::text
    AND q.last_result->>'period_end'=to_date::text) INTO verified;
  IF ready IS DISTINCT FROM true OR NOT verified THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('club_id',club,'period_start',from_date,'period_end',to_date,
    'reason',COALESCE(result->>'reason','weekly_calculation_receipt_not_confirmed')));
  END IF;
 END LOOP;
 RETURN jsonb_build_object('success',jsonb_array_length(problems)=0,'accounting_version',3,
  'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',cardinality(clubs),'problems',problems);
END $expected_prepare$;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=v_prepare AND p.prosrc=v_expected_prepare
   AND p.prosecdef AND p.provolatile='v' AND p.prorettype='jsonb'::regtype
   AND p.proconfig=ARRAY['search_path=public']::text[]) THEN
  RAISE EXCEPTION 'post_cash_refusal_preparation_source_changed'; END IF;
 IF md5(pg_get_functiondef('public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz)'::regprocedure))
    IS DISTINCT FROM '501b5a243800f96ef549aa4b137bc7bf'
  OR md5(pg_get_functiondef('public.fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean)'::regprocedure))
    IS DISTINCT FROM 'aef6d2b4583dafbe291bab39e52953c6'
  OR md5(pg_get_functiondef('public.fn_union_eco_adjustment(uuid,timestamptz,timestamptz)'::regprocedure))
    IS DISTINCT FROM '4bef87530456c7c0d291c59c70eb41cd'
  OR md5(pg_get_functiondef('public.fn_union_eco_record(uuid,timestamptz,timestamptz,uuid)'::regprocedure))
    IS DISTINCT FROM '1ce954a9cc4e55ad191e9c40fb4a56d5'
  OR md5(pg_get_functiondef('public.fn_union_reconciliation_report(uuid,timestamptz,timestamptz)'::regprocedure))
    IS DISTINCT FROM '630e87c9842a423e6a5198551623dec0'
  OR md5(pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure))
    IS DISTINCT FROM '63f8248cd6d804f450a0b8f0fbc05e77'
  OR md5(pg_get_functiondef('public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)'::regprocedure))
    IS DISTINCT FROM 'a7eb35f0906ad77fd5eb0975d90023b7'
  OR md5(pg_get_functiondef('public.fn_union_club_invoice(uuid,timestamptz,timestamptz)'::regprocedure))
    IS DISTINCT FROM 'bee79493a9a724e043b658ba328d663f' THEN
  RAISE EXCEPTION 'union_pnl_quality_hook_preimage_changed'; END IF;
END $guard$;

CREATE FUNCTION public.fn_union_pnl_close_quality(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE evidence jsonb;
BEGIN
 IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end)
  OR p_start<'2026-09-07 07:00:00+00'::timestamptz OR p_end<=p_start OR p_end>statement_timestamp()
  OR p_end-p_start>interval '8 days' THEN
  RETURN jsonb_build_object('status','blocked','reason','pnl_requires_closed_supported_period','issues',jsonb_build_array('invalid_pnl_evidence_period'));
 END IF;
 evidence:=public.fn_union_pnl_evidence_report(p_union_id,p_start,p_end);
 IF evidence->'report_version' IS DISTINCT FROM '1'::jsonb
  OR evidence->>'status' IS DISTINCT FROM 'ready' OR evidence->'basis_certified' IS DISTINCT FROM 'true'::jsonb
  OR evidence->'issues' IS DISTINCT FROM '[]'::jsonb THEN
  -- No player identities, source amounts, balances or invoice contents cross
  -- this gate. Callers retain their original authorization before evaluation.
  RETURN jsonb_build_object('status','blocked','reason','union_pnl_basis_uncertified',
   'issues',CASE WHEN jsonb_typeof(evidence->'issues')='array' THEN evidence->'issues'
    ELSE jsonb_build_array('pnl_evidence_contract_missing') END);
 END IF;
 RETURN jsonb_build_object('status','ready','issues','[]'::jsonb);
END $$;
CREATE FUNCTION public.fn_require_union_pnl_evidence(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE quality jsonb;
BEGIN
 quality:=public.fn_union_pnl_close_quality(p_union_id,p_start,p_end);
 IF quality->>'status' IS DISTINCT FROM 'ready' THEN
  RAISE EXCEPTION 'union_pnl_basis_uncertified' USING ERRCODE='55000',DETAIL=quality::text;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.fn_union_pnl_close_quality(uuid,timestamptz,timestamptz),
 public.fn_require_union_pnl_evidence(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;

-- Register changed established financial doors before replacing their bodies.
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_prepare_accounting_week','approved','Union books require certified P&L source/ownership/boundary evidence under the week lock before any discovery or payer work. Standalone preparation is unchanged. Uncertified capture remains an explicit blocker.'),
 ('fn_union_issue_weekly_invoices','approved','After original owner/admin authorization, require certified union P&L before the legacy square-up issuer can compute or write any invoice. Existing issued history is not changed.'),
 ('fn_union_eco_record','approved','After original owner/admin authorization, require certified P&L before any ECO ledger insert/upsert. No historical ECO row or rate is changed.'),
 ('fn_union_eco_adjustment','approved','Preserve inherited reconciliation-reader authorization before requiring certified P&L. Missing baseline cannot be promoted to exact ECO evidence.'),
 ('fn_process_weekly_accounting_scope','approved','Same private weekly coordinator. Previously reported union completion is skipped only while P&L source/ownership/boundary quality is certified; otherwise normal durable preparation records failure. Standalone skip is unchanged.'),
 ('fn_union_settle_player_pnl','approved','Same P&L writer; original authorization/window/floor checks and scope locks precede mandatory quality. Both preview and payment, including manual wrappers, refuse uncertified source evidence before claims, temporary calculation or money writes.')
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;

DO $patch$
DECLARE source text;needle text;replacement text;
BEGIN
 source:=pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 needle:=$needle$ SELECT COALESCE(array_agg(c.club_id ORDER BY c.club_id),ARRAY[]::uuid[]) INTO clubs$needle$;
 replacement:=$replacement$ -- P&L/ECO is part of a union's full weekly close. A diagnostic gap must
 -- stop this book before any payer stage, even when rake sources are ready.
 IF p_union_id IS NOT NULL THEN
  source_check:=public.fn_union_pnl_close_quality(p_union_id,p_from,p_to);
  IF source_check->>'status' IS DISTINCT FROM 'ready' THEN
   RETURN jsonb_build_object('success',false,'accounting_version',3,
    'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,
    'problems',jsonb_build_array(jsonb_build_object('reason','union_pnl_basis_uncertified','pnl_evidence',source_check)));
  END IF;
 END IF;
 SELECT COALESCE(array_agg(c.club_id ORDER BY c.club_id),ARRAY[]::uuid[]) INTO clubs$replacement$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'pnl_preparation_hook_location_changed'; END IF;
 EXECUTE replace(source,needle,replacement);

 source:=pg_get_functiondef('public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)'::regprocedure);
 needle:=$needle$  SELECT * INTO v_existing FROM public.union_pnl_settlements$needle$;
 replacement:=$replacement$  -- Preview, replay and payment share one quality gate after original auth,
  -- window/floor validation and scope locks. No historical record is changed.
  PERFORM public.fn_require_union_pnl_evidence(p_union_id,p_start,p_end);
  SELECT * INTO v_existing FROM public.union_pnl_settlements$replacement$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'pnl_core_hook_location_changed'; END IF;
 EXECUTE replace(source,needle,replacement);

 -- A stored success cannot bypass new source-quality requirements. This is
 -- the only coordinator transform in this component. The following fairness
 -- component may reverse this exact predicate solely to check J's known MD5;
 -- its emitted coordinator must preserve this guard.
 source:=pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure);
 needle:=$needle$      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3' THEN$needle$;
 replacement:=$replacement$      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='3'
        AND public.fn_union_pnl_close_quality(v_union.id,v_from,v_end)->>'status'='ready' THEN$replacement$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'pnl_prior_completion_hook_location_changed'; END IF;
 EXECUTE replace(source,needle,replacement);

 source:=pg_get_functiondef('public.fn_union_issue_weekly_invoices(uuid,timestamptz,timestamptz,boolean)'::regprocedure);
 needle:=$needle$  /* THE GUARDS LIVE HERE, NOT ONLY IN THE CASCADE (Phase 6 verification,$needle$;
 replacement:=$replacement$  -- Original owner/admin authorization above remains the first disclosure gate.
  PERFORM public.fn_require_union_pnl_evidence(p_union_id,v_from,v_to);

  /* THE GUARDS LIVE HERE, NOT ONLY IN THE CASCADE (Phase 6 verification,$replacement$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'pnl_invoice_hook_location_changed'; END IF;
 EXECUTE replace(source,needle,replacement);

 source:=pg_get_functiondef('public.fn_union_eco_record(uuid,timestamptz,timestamptz,uuid)'::regprocedure);
 needle:=$needle$  INSERT INTO union_eco_ledger (union_id, club_id, period_start, period_end,$needle$;
 replacement:=$replacement$  -- Preserve original authorization; refuse before any existing ECO row can be upserted.
  PERFORM public.fn_require_union_pnl_evidence(p_union_id,p_start,p_end);

  INSERT INTO union_eco_ledger (union_id, club_id, period_start, period_end,$replacement$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'pnl_eco_writer_hook_location_changed'; END IF;
 EXECUTE replace(source,needle,replacement);

 source:=pg_get_functiondef('public.fn_union_eco_adjustment(uuid,timestamptz,timestamptz)'::regprocedure);
 needle:=$needle$BEGIN
  IF v_mode NOT IN$needle$;
 replacement:=$replacement$BEGIN
  -- This is the exact authorization predicate inherited from the original
  -- fn_union_reconciliation_report call below. Check it before diagnostics,
  -- without widening the population or revealing financial evidence.
  IF auth.uid() IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unions u WHERE u.id=p_union_id AND u.owner_id=auth.uid())
     AND NOT EXISTS (SELECT 1 FROM union_admins ua WHERE ua.union_id=p_union_id AND ua.user_id=auth.uid())
     AND NOT EXISTS (SELECT 1 FROM union_clubs uc JOIN club_members cm ON cm.club_id=uc.club_id
       WHERE uc.union_id=p_union_id AND cm.user_id=auth.uid() AND cm.role IN ('owner','co_owner','admin','super_agent')) THEN
    RAISE EXCEPTION 'not authorized to read union reconciliation' USING ERRCODE='42501';
  END IF;
  PERFORM public.fn_require_union_pnl_evidence(p_union_id,p_start,p_end);
  IF v_mode NOT IN$replacement$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'pnl_eco_reader_hook_location_changed'; END IF;
 EXECUTE replace(source,needle,replacement);
END $patch$;
-- CREATE OR REPLACE preserves the existing ACLs and owners. The original
-- private preparation stays private; new helpers have no client grants.
REVOKE ALL ON FUNCTION public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
