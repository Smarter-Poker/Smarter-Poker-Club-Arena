CREATE OR REPLACE FUNCTION public.fn_prepare_accounting_week(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE clubs uuid[];club uuid;result jsonb;problems jsonb:='[]';from_date date;to_date date;ready boolean;verified boolean;source_check jsonb;refusal_key text;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to)
  OR p_from IS DISTINCT FROM public.fn_union_week_start(p_from)
  OR p_to IS DISTINCT FROM public.fn_union_week_start(p_from+interval '8 days') OR p_to>now()
 THEN RAISE EXCEPTION 'accounting_preparation_requires_closed_week' USING ERRCODE='22023'; END IF;
 from_date:=(p_from AT TIME ZONE 'America/Los_Angeles')::date;to_date:=(p_to AT TIME ZONE 'America/Los_Angeles')::date-1;
 IF (p_union_id IS NULL)=(p_club_id IS NULL) THEN RAISE EXCEPTION 'invalid_accounting_scope' USING ERRCODE='22023'; END IF;
 IF p_union_id IS NOT NULL THEN PERFORM public.fn_union_pnl_closed_book_barrier(p_to); END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
  CASE WHEN p_union_id IS NOT NULL THEN 'union-accounting:' ELSE 'club-accounting:' END
   ||COALESCE(p_union_id,p_club_id)::text||':'||extract(epoch FROM p_from)::text||':'||extract(epoch FROM p_to)::text,0));
 -- The source queue is part of this book. Check it under the same week lock,
 -- before discovery, payer locks, calculations, or any financial stage.
 -- ONE REFUSAL CHECK PER ATTEMPT (20261003): inside one union close attempt
 -- (app.accounting_close_memo='on', set only by fn_weekly_accounting_attempt_begin,
 -- cleared by it and by attempt_end) the cascade's preparation repeats the
 -- scheduler's, for the same book, under this same week lock, which the
 -- attempt has held since. A 'ready' answer of this attempt is reused there;
 -- anything else, and every call outside an attempt, asks the queue as before.
 refusal_key:=COALESCE(p_union_id,p_club_id)::text||'|'||p_from::text||'|'||p_to::text;
 IF current_setting('app.accounting_close_memo',true)='on'
  AND current_setting('app.accounting_cash_refusal_memo',true)=refusal_key THEN
  source_check:=jsonb_build_object('status','ready','count',0,'sources','[]'::jsonb);
 ELSE
  source_check:=public.fn_cash_source_refusals_for_period(p_union_id,p_club_id,p_from,p_to);
  IF current_setting('app.accounting_close_memo',true)='on' AND source_check->>'status'='ready'
   AND source_check->'count'='0'::jsonb AND source_check->'sources'='[]'::jsonb THEN
   PERFORM set_config('app.accounting_cash_refusal_memo',refusal_key,true);
  END IF;
 END IF;
 IF source_check->>'status' IS DISTINCT FROM 'ready'
  OR source_check->'count' IS DISTINCT FROM '0'::jsonb
  OR source_check->'sources' IS DISTINCT FROM '[]'::jsonb THEN
  RETURN jsonb_build_object('success',false,'accounting_version',3,
   'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,
   'problems',jsonb_build_array(jsonb_build_object('reason','cash_source_refusals_pending',
    'source_check',source_check)));
 END IF;
 -- The original R0 transition qualifies historical interpretation before any
 -- source-plan reuse or payer stage. Each bounded batch commits no money.
 source_check:=smarter_private.prepare_own_agent_interpretation(p_union_id,p_club_id,p_from,p_to);
 IF source_check->>'ready'IS DISTINCT FROM'true'THEN
  RETURN jsonb_build_object('success',false,'accounting_version',3,'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,'problems',jsonb_build_array(jsonb_build_object('reason','own_agent_source_interpretation_in_progress','source_check',source_check)));
 END IF;
 -- Rakeback is due before club-book settlement (owner, 2026-10-26).
 -- Keep the closed book, source queue, recorded contracts and calculation
 -- receipts here. The original cascade proves P&L after its conserved paid
 -- rounds, before any club period is settled or weekly invoice is issued.
 -- The fee windows belong to fee preparation, before later club books.
 -- Only enter the original advance when its fee prefix has missing work:
 -- that prefix ends its attempt before any P&L branch. Its proof, IDs, row
 -- hashes, refusal path and unchanged time budget remain authoritative.
 IF p_union_id IS NOT NULL
  AND COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on'
  AND current_setting('app.accounting_close_memo',true)='on'
  AND NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NOT NULL
  AND EXISTS(SELECT FROM public.accounting_cash_accrual_cutover WHERE singleton AND starts_at<=p_from)
  AND NOT EXISTS(SELECT FROM public.accounting_routed_settlement_runs r
   WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.round_no=3
    AND r.period_start=p_from AND r.period_end=p_to)
  AND public.fn_accounting_close_certificate('earned_plan',p_union_id,p_from,p_to) IS NULL
  AND EXISTS(SELECT FROM public.fn_accounting_close_windows(p_from,p_to) w
   WHERE NOT EXISTS(SELECT FROM public.accounting_close_partials p
    WHERE p.kind='earned_plan_window' AND p.union_id=p_union_id
     AND p.period_start=p_from AND p.period_end=p_to
     AND p.window_start=w.window_start AND p.window_end=w.window_end
     AND p.computed_at>=p_to
     AND p.computed_at>clock_timestamp()-public.fn_accounting_close_proof_lifetime())) THEN
  IF public.fn_accounting_union_earned_plan_advance(p_union_id,p_from,p_to) IS DISTINCT FROM false THEN
   RAISE EXCEPTION 'earned_fee_window_advance_did_not_stop_after_fee_work' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('success',false,'accounting_version',3,
   'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,
   'problems',jsonb_build_array(jsonb_build_object('reason','earned_fee_certification_in_progress')));
 END IF;
 SELECT COALESCE(array_agg(c.club_id ORDER BY c.club_id),ARRAY[]::uuid[]) INTO clubs
  FROM public.fn_accounting_week_clubs(p_union_id,p_club_id,p_from,p_to)c;
 -- Same order as the routing stages, before Round 1 takes any treasury row.
 PERFORM public.fn_lock_rakeback_payer_clubs(clubs);
 IF p_union_id IS NOT NULL AND EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs r
    WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.round_no=3
     AND r.period_start=p_from AND r.period_end=p_to) THEN
  -- CHUNKED CLOSE (20261003): inside a chunked attempt (job 272 sets
  -- app.weekly_accounting_chunked) a round 3 an earlier attempt committed is
  -- answered from its own receipt, as the cascade answers it, instead of
  -- reading the whole week again to prove it a duplicate.
  IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on' THEN
   SELECT r.result||jsonb_build_object('duplicate',true) INTO source_check FROM public.accounting_routed_settlement_runs r
    WHERE r.scope_kind='union' AND r.scope_id=p_union_id AND r.round_no=3 AND r.period_start=p_from AND r.period_end=p_to;
  ELSE
  source_check:=public.fn_settle_accounting_rakeback_stage('union',p_union_id,p_from,p_to);
  END IF;
  IF source_check->>'success' IS DISTINCT FROM 'true' OR source_check->>'duplicate' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'original_paid_scope_replay_not_confirmed' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('success',true,'accounting_version',3,'union_id',p_union_id,'club_id',p_club_id,
    'period_start',p_from,'period_end',p_to,'clubs',cardinality(clubs),'problems','[]'::jsonb,'paid_scope_replay',true);
 END IF;
 FOREACH club IN ARRAY clubs LOOP
  -- Reuse a receipt that is proven current (20260928233000): complete, ready,
  -- not superseded by a later request, and no earning source of this club
  -- for this week recorded after it. Rounds 2 and 3 re-verify certificates.
  IF EXISTS(SELECT 1 FROM public.accounting_period_recompute_requests q
    WHERE q.club_id=club AND q.period_start=from_date AND q.period_end=to_date
     AND q.status='complete' AND q.attempted_at IS NOT NULL
     AND q.last_requested_at<=q.attempted_at
     AND q.last_result->>'accounting_version'='2' AND q.last_result->>'status'='ready'
     AND q.last_result->>'club_id'=club::text AND q.last_result->>'period_start'=from_date::text
     AND q.last_result->>'period_end'=to_date::text
     AND NOT EXISTS(SELECT 1 FROM (
       SELECT s.earned_at FROM public.accounting_cash_rake_sources s
       WHERE s.club_id=club AND s.recorded_at>q.attempted_at-interval '1 minute' OFFSET 0
      ) s WHERE s.earned_at>=p_from AND s.earned_at<p_to)
     AND NOT EXISTS(SELECT 1 FROM (
       SELECT a.source_id FROM public.accounting_cash_atomic_contract_admissions a
       WHERE a.admitted_at>q.attempted_at-interval '1 minute' OFFSET 0
      ) a CROSS JOIN LATERAL (
       SELECT s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s WHERE s.id=a.source_id OFFSET 0
      ) s WHERE s.club_id=club AND s.earned_at>=p_from AND s.earned_at<p_to)
     AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
       WHERE f.club_id=club AND f.charged_at<p_to AND f.recorded_at>q.attempted_at-interval '1 minute')) THEN
   CONTINUE;
  END IF;
  -- SPLIT RECOMPUTE (20261003): inside a chunked close attempt a closed week
  -- is calculated in parts of its own (fn_rakeback_recompute_split); NULL
  -- everywhere else, and the whole-period call follows as before.
  result:=public.fn_rakeback_recompute_split(club,from_date,to_date);
  IF result->>'status'='in_progress' THEN
   problems:=problems||jsonb_build_array(jsonb_build_object('club_id',club,'period_start',from_date,'period_end',to_date,
    'reason','weekly_calculation_in_progress'));
   CONTINUE;
  END IF;
  IF result IS NULL THEN
  result:=public.fn_rakeback_recompute_periods(club,from_date,to_date,NULL);
  END IF;
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
END $function$
