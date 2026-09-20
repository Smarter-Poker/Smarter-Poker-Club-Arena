-- Candidate only: unresolved cash sources prevent weekly close before payer work.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $guard$
BEGIN
 IF (SELECT md5(pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)))
  IS DISTINCT FROM 'eb7124bc10101dafa7f85c52c7bfd796' THEN
  RAISE EXCEPTION 'accounting_preparation_preimage_changed';
 END IF;
 IF (SELECT md5(pg_get_functiondef('public.fn_cash_source_refusals_for_period(uuid,uuid,timestamptz,timestamptz)'::regprocedure)))
  IS DISTINCT FROM 'ac7d777693e79eca6a13084b51cd1305' THEN
  RAISE EXCEPTION 'cash_source_refusal_checker_preimage_changed';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_prepare_accounting_week(p_union_id uuid,p_club_id uuid,p_from timestamptz,p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
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
END $function$;
REVOKE ALL ON FUNCTION public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
UPDATE public.ca_money_rpc_registry
 SET notes='Private single-coordinator preparation requires zero unresolved cash source receipts before any discovery, payer lock or weekly calculation. Complete durable period certificates remain mandatory.'
 WHERE proname='fn_prepare_accounting_week';
COMMIT;
