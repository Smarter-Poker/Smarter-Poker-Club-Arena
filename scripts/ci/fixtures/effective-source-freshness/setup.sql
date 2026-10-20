\set ON_ERROR_STOP on
SET client_min_messages=warning;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE TABLE public.accounting_period_recompute_requests(id uuid,club_id uuid,period_start date,period_end date,status text,attempted_at timestamptz,last_requested_at timestamptz,last_result jsonb);
CREATE TABLE public.accounting_cash_rake_sources(id uuid PRIMARY KEY,rake_record_id uuid,player_id uuid,club_id uuid,union_id uuid,coordinator_union_id uuid,earned_at timestamptz,rake_credit numeric,contract jsonb,recorded_at timestamptz);
CREATE INDEX accounting_cash_rake_sources_club_recorded ON public.accounting_cash_rake_sources(club_id,recorded_at) INCLUDE(earned_at);
CREATE INDEX accounting_cash_rake_sources_period ON public.accounting_cash_rake_sources(club_id,earned_at,player_id);
CREATE TABLE public.accounting_cash_atomic_contract_admissions(source_id uuid PRIMARY KEY,admitted_contract jsonb,admitted_at timestamptz);
CREATE TABLE public.accounting_tournament_fee_sources(club_id uuid,charged_at timestamptz,recorded_at timestamptz);
CREATE INDEX accounting_tournament_fee_sources_club_recorded ON public.accounting_tournament_fee_sources(club_id,recorded_at) INCLUDE(charged_at);
CREATE TABLE public.ca_money_rpc_registry(proname text PRIMARY KEY,status text,notes text);
INSERT INTO public.ca_money_rpc_registry VALUES('fn_prepare_accounting_week','approved','Local qualification copied existing approved registry identity');
CREATE VIEW public.accounting_effective_cash_rake_sources AS  SELECT s.id,
    s.rake_record_id,
    s.player_id,
    s.club_id,
    s.union_id,
    s.coordinator_union_id,
    s.earned_at,
    s.rake_credit,
    COALESCE(a.admitted_contract, s.contract) AS contract,
    GREATEST(s.recorded_at, a.admitted_at) AS recorded_at
   FROM accounting_cash_rake_sources s
     LEFT JOIN accounting_cash_atomic_contract_admissions a ON a.source_id = s.id;
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
 -- P&L/ECO is part of a union's full weekly close. A diagnostic gap must
 -- stop this book before any payer stage, even when rake sources are ready.
 IF p_union_id IS NOT NULL THEN
  source_check:=public.fn_union_pnl_close_quality(p_union_id,p_from,p_to);
  IF source_check->>'status' IS DISTINCT FROM 'ready' THEN
   RETURN jsonb_build_object('success',false,'accounting_version',3,
    'union_id',p_union_id,'club_id',p_club_id,'period_start',p_from,'period_end',p_to,'clubs',0,
    'problems',jsonb_build_array(jsonb_build_object('reason','union_pnl_basis_uncertified','pnl_evidence',source_check)));
  END IF;
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
     AND NOT EXISTS(SELECT 1 FROM public.accounting_effective_cash_rake_sources s
       WHERE s.club_id=club AND s.earned_at>=p_from AND s.earned_at<p_to AND s.recorded_at>q.attempted_at-interval '1 minute')
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
;
CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_split(p_club_id uuid, p_period_start date, p_period_end date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
-- A CLOSED WEEK'S RECOMPUTE IN PARTS (20261003). Inside a chunked close
-- attempt: the whole-period call of fn_rakeback_recompute_periods for this
-- club-week, made of parts kept across attempts (see the migration header).
-- Answers 'in_progress' while parts remain, or exactly what
-- fn_rakeback_recompute_periods returns, with the request row it records.
-- NULL outside a chunked close attempt, for an open or pre-cutover week and
-- for an unknown club: the caller then makes the whole-period call itself.
DECLARE v_from timestamptz; v_to timestamptz; cutover timestamptz; began timestamptz; did boolean:=false;
 oldest timestamptz; w record; v jsonb; pages jsonb; n_pages integer; i integer; ids uuid[];
 tq jsonb; ev bigint; inc bigint; dr bigint; issue_count bigint; receipt jsonb; result jsonb;
 request public.accounting_period_recompute_requests%ROWTYPE; request_state text;
BEGIN
 IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')<>'on'
  OR NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'') IS NULL
  OR p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
  OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
  OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6 THEN
  RETURN NULL;
 END IF;
 v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
 v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
 SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
 IF v_to>clock_timestamp() OR cutover IS NULL OR v_from<cutover
  OR NOT EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id) THEN
  RETURN NULL;
 END IF;
 -- The calculator's own club-week lock, for every part and the receipt.
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 began:=NULLIF(current_setting('app.weekly_accounting_scope_deadline',true),'')::timestamptz
  -COALESCE(NULLIF(current_setting('app.weekly_accounting_scope_budget',true),''),'8 minutes')::interval;
 -- At least one part per attempt (not per club): a union book asks for each
 -- of its clubs in one attempt.
 did:=COALESCE(current_setting('app.accounting_split_did',true),'')='on';
 -- Parts are kept only while no source of this club-week was recorded after
 -- the oldest of them (the preparation's reuse rule), for 12 hours, and only
 -- when made after the week closed.
 SELECT min(computed_at) INTO oldest FROM public.accounting_recompute_split_parts
  WHERE club_id=p_club_id AND period_start=p_period_start;
 IF oldest IS NOT NULL AND (oldest<v_to OR oldest<clock_timestamp()-interval '12 hours'
   OR EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND period_end<>p_period_end)
   OR EXISTS(SELECT 1 FROM public.accounting_effective_cash_rake_sources s
     WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to AND s.recorded_at>oldest-interval '1 minute')
   OR EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
     WHERE f.club_id=p_club_id AND f.charged_at<v_to AND f.recorded_at>oldest-interval '1 minute')) THEN
  DELETE FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start;
 END IF;
 -- 1. The player pages.
 IF NOT EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='players') THEN
  IF did AND clock_timestamp()>began+interval '90 seconds' THEN
   RETURN jsonb_build_object('status','in_progress','club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'stage','players');
  END IF;
  WITH p AS (SELECT s.player_id,count(*) AS n FROM public.accounting_payable_earning_sources s
    WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to GROUP BY s.player_id),
  q AS (SELECT p.player_id,((sum(p.n) OVER(ORDER BY p.player_id)-p.n)/20000)::bigint AS pg FROM p)
  SELECT COALESCE(jsonb_agg(x.ids ORDER BY x.pg),'[]'::jsonb) INTO pages
   FROM (SELECT q.pg,jsonb_agg(q.player_id ORDER BY q.player_id) AS ids FROM q GROUP BY q.pg) x;
  INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
  VALUES(p_club_id,p_period_start,p_period_end,'players',0,jsonb_build_object('pages',pages));
  did:=true; PERFORM set_config('app.accounting_split_did','on',true);
 END IF;
 SELECT value->'pages' INTO pages FROM public.accounting_recompute_split_parts
  WHERE club_id=p_club_id AND period_start=p_period_start AND kind='players' AND part=0;
 n_pages:=jsonb_array_length(pages);
 -- 2. The tournament gate, six hours at a time.
 FOR w IN SELECT (row_number() OVER(ORDER BY g)-1)::int AS idx,g AS ws,LEAST(g+interval '6 hours',v_to) AS we
   FROM generate_series(v_from,v_to-interval '1 microsecond',interval '6 hours') g ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='tq' AND part=w.idx);
  IF did AND clock_timestamp()>began+interval '90 seconds' THEN EXIT; END IF;
  INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
  VALUES(p_club_id,p_period_start,p_period_end,'tq',w.idx,public.fn_accounting_tournament_week_quality(p_club_id,w.ws,w.we));
  did:=true; PERFORM set_config('app.accounting_split_did','on',true);
 END LOOP;
 -- 3. The source-evidence counts, two hours at a time.
 FOR w IN SELECT (row_number() OVER(ORDER BY g)-1)::int AS idx,g AS ws,LEAST(g+interval '2 hours',v_to) AS we
   FROM generate_series(v_from,v_to-interval '1 microsecond',interval '2 hours') g ORDER BY 1 LOOP
  CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='counts' AND part=w.idx);
  IF did AND clock_timestamp()>began+interval '90 seconds' THEN EXIT; END IF;
  INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
  VALUES(p_club_id,p_period_start,p_period_end,'counts',w.idx,public.fn_rakeback_split_counts(p_club_id,v_from,v_to,w.ws,w.we));
  did:=true; PERFORM set_config('app.accounting_split_did','on',true);
 END LOOP;
 IF (SELECT count(*) FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='tq')
    <>(SELECT count(*) FROM generate_series(v_from,v_to-interval '1 microsecond',interval '6 hours'))
  OR (SELECT count(*) FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='counts')
    <>(SELECT count(*) FROM generate_series(v_from,v_to-interval '1 microsecond',interval '2 hours')) THEN
  RETURN jsonb_build_object('status','in_progress','club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'stage','windows');
 END IF;
 -- The whole-period call's receipt and its tests, in its order.
 receipt:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'written',0,'status','blocked');
 SELECT p.value INTO tq FROM public.accounting_recompute_split_parts p
  WHERE p.club_id=p_club_id AND p.period_start=p_period_start AND p.kind='tq' AND p.value->>'status' IS DISTINCT FROM 'ready'
  ORDER BY (p.value->>'tournament_id')::uuid NULLS LAST,p.part LIMIT 1;
 IF tq IS NOT NULL THEN
  result:=receipt||tq||jsonb_build_object('written',0);
 ELSE
  SELECT sum((value->>'evidence')::bigint),sum((value->>'incomplete')::bigint),sum((value->>'drifted')::bigint) INTO ev,inc,dr
   FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='counts';
  IF ev>0 THEN result:=receipt||jsonb_build_object('reason','cash_earning_evidence_incomplete','source_count',ev); END IF;
  IF result IS NULL THEN
   SELECT count(*) INTO issue_count FROM public.rakeback_periods rp
    WHERE rp.club_id=p_club_id AND rp.period_start<=p_period_end AND rp.period_end>=p_period_start
      AND (rp.status<>'pending' OR rp.period_start<>p_period_start OR rp.period_end<>p_period_end
        OR NOT EXISTS(SELECT 1 FROM public.accounting_rakeback_period_calculations c WHERE c.period_id=rp.id));
   IF issue_count>0 THEN result:=receipt||jsonb_build_object('reason','legacy_or_paid_period_requires_reconciliation','period_count',issue_count);
   ELSIF inc>0 THEN result:=receipt||jsonb_build_object('reason','cash_source_receipts_incomplete','source_count',inc);
   ELSIF dr>0 THEN result:=receipt||jsonb_build_object('reason','cash_source_receipts_drifted','source_count',dr);
   END IF;
  END IF;
 END IF;
 -- 4. The check pass, then 5. the write pass, page by page.
 IF result IS NULL THEN
  FOR i IN 0..n_pages-1 LOOP
   CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='check' AND part=i);
   IF did AND clock_timestamp()>began+interval '90 seconds' THEN
    RETURN jsonb_build_object('status','in_progress','club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'stage','check');
   END IF;
   ids:=ARRAY(SELECT jsonb_array_elements_text(pages->i)::uuid);
   INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
   VALUES(p_club_id,p_period_start,p_period_end,'check',i,public.fn_rakeback_split_check(p_club_id,p_period_start,p_period_end,ids));
   did:=true; PERFORM set_config('app.accounting_split_did','on',true);
  END LOOP;
  SELECT receipt||jsonb_build_object('reason',p.value->>'reason') INTO result FROM public.accounting_recompute_split_parts p
   WHERE p.club_id=p_club_id AND p.period_start=p_period_start AND p.kind='check' AND p.value ? 'reason' ORDER BY p.part LIMIT 1;
 END IF;
 IF result IS NULL THEN
  FOR i IN 0..n_pages-1 LOOP
   CONTINUE WHEN EXISTS(SELECT 1 FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='write' AND part=i);
   IF did AND clock_timestamp()>began+interval '90 seconds' THEN
    RETURN jsonb_build_object('status','in_progress','club_id',p_club_id,'period_start',p_period_start,'period_end',p_period_end,'stage','write');
   END IF;
   ids:=ARRAY(SELECT jsonb_array_elements_text(pages->i)::uuid);
   INSERT INTO public.accounting_recompute_split_parts(club_id,period_start,period_end,kind,part,value)
   VALUES(p_club_id,p_period_start,p_period_end,'write',i,public.fn_rakeback_split_write(p_club_id,p_period_start,p_period_end,ids));
   did:=true; PERFORM set_config('app.accounting_split_did','on',true);
  END LOOP;
  SELECT receipt||jsonb_build_object('status','ready','written',COALESCE(sum((value->>'written')::integer),0),'confirmed_players',COALESCE(sum((value->>'confirmed')::integer),0))
   INTO result FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start AND kind='write';
 END IF;
 -- The request row, exactly as fn_rakeback_recompute_periods records a
 -- whole-period call.
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
  VALUES(p_club_id,p_period_start,p_period_end)
  ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL
  RETURNING * INTO request;
 request_state:=CASE WHEN result->>'status'='ready' THEN 'complete' ELSE 'blocked' END;
 UPDATE public.accounting_period_recompute_requests SET status=request_state,reason=result->>'reason',
  attempted_at=clock_timestamp(),attempts=attempts+1,last_result=result WHERE id=request.id;
 DELETE FROM public.accounting_recompute_split_parts WHERE club_id=p_club_id AND period_start=p_period_start;
 RETURN result||jsonb_build_object('request_id',request.id,'requested_at',request.requested_at,
  'request_state',request_state,'request_recorded',true);
END
$function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
 RETURNS text[]
 LANGUAGE sql
 STABLE
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[
      'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
      'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
      'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
      'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
      'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
      'fn_ca_journal_append_only','fn_ca_is_midway_scope',
      'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
      'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
      'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
      'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
      'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
      'fn_ca_post_correction','fn_ca_repair_write_failure',
      -- The Diamond money doors (2026-09-12).
      'fn_poker_diamond_reserve','fn_poker_diamond_release',
      'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
      'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
      'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
      -- The unit rules (2026-09-12).
      'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
      'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
      -- The seat guards that know a tournament seat (2026-09-13).
      'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
      'fn_poker_diamond_entry_custody_is_the_entry',
      -- The Diamond tournament money doors (Phase 8, 2026-09-14): an entry
      -- into custody, an add to it, its refund, its unregistration and
      -- cancellation, the drain, the prize, the fee, the close, the shadow.
      'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_custody_add',
      'fn_poker_diamond_tournament_refund','fn_poker_diamond_tournament_unregister',
      'fn_poker_diamond_tournament_cancel','fn_poker_diamond_tournament_drain',
      'fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_settle_fee',
      'fn_poker_diamond_tournament_close_custody','fn_poker_diamond_tournament_open_shadow',
      -- The two guards Phase 8 taught new names, and the two chip readers it
      -- routes by asset. The wallet guard is the one thing between a browser
      -- and profiles.diamonds.
      'fn_guard_profile_privileged_columns','fn_poker_guard_arena_structure',
      'fn_ca_escrow_can_pay','fn_ca_tournament_escrow',
      -- The Diamond satellite seat door (Phase 9, 2026-09-21): a satellite
      -- seat moved custody to custody, out of one prize bank into an entry.
      'fn_poker_diamond_tournament_seat_transfer',
      -- A balance never moves without its ledger row (2026-10-01): the tally,
      -- its two sides, the account key and the commit-time check.
      'fn_ca_ledger_tally_add','fn_ca_ledger_tally_key','fn_ca_felt_counts_table',
      'fn_ca_tally_balance_move','fn_ca_tally_ledger_leg','fn_ca_balance_has_its_ledger_row',
      -- Every chip store balances with its ledger row (2026-10-02): the store
      -- side of the tally, its pair helper and the Diamond-event scope.
      'fn_ca_tally_store_move','fn_ca_tally_pair','fn_ca_tournament_counts',
      -- And the list itself.
      'fn_ca_guard_watchlist'
    ]) x)
$function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_balance_columns()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT array_agg(DISTINCT c)
    FROM (
      SELECT (regexp_matches(pg_get_triggerdef(t.oid), '''([a-z_]+)=([a-z_]+)''', 'g'))[1] AS c
        FROM pg_trigger t
        JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE NOT t.tgisinternal AND p.proname IN ('fn_ca_autoledger','fn_ca_autoledger_delete')
      UNION
      SELECT unnest(ARRAY['chip_balance','held_chips','locked_chips','credit_used',
                          'stack','balance','chips','prize','bounty_winnings'])
    ) s;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_ca_money_rpc_writes_balances(p_src text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    p_src ~* 'UPDATE\s+(public\.)?(club_members|club_wallets|union_wallets|unions|table_seats|bbj_pools|clubs|agents|wallets|spin_bonus_pools|tournament_players)\y'
    OR p_src ~* 'INSERT\s+INTO\s+(public\.)?(club_members|club_wallets|union_wallets|unions|bbj_pools|clubs|agents|wallets|spin_bonus_pools)\y', false)
  AND COALESCE(p_src ~* ('\y(' || array_to_string(public.fn_ca_money_rpc_balance_columns(), '|') || ')\y'), false);
$function$
;
REVOKE ALL ON FUNCTION public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_split(uuid,date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_recompute_split(uuid,date,date) TO service_role;
INSERT INTO public.accounting_cash_rake_sources(id,player_id,club_id,earned_at,rake_credit,contract,recorded_at)
SELECT md5('freshness-fixture:'||i)::uuid,md5('player:'||i)::uuid,'e14bc9f7-736d-425f-8f2c-e78305ebac1d','2026-10-12 07:00Z'::timestamptz+(i%500000)*interval '1 second',1,'{}','2026-10-19 07:30Z' FROM generate_series(1,50000)i;
INSERT INTO public.accounting_cash_rake_sources(id,club_id,earned_at,recorded_at,contract) VALUES('0d0b0bf6-0094-4da1-837a-0fc397eb4d0a','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','2026-10-17 00:17:01.960157+00','2026-10-17 00:36:53.935392+00','{}');
INSERT INTO public.accounting_cash_atomic_contract_admissions VALUES('0d0b0bf6-0094-4da1-837a-0fc397eb4d0a','{}','2026-10-20 16:24:58.067958+00');
INSERT INTO public.accounting_cash_rake_sources(id,club_id,earned_at,recorded_at,contract) VALUES('88fe7361-5768-439d-831e-37a2317c0fe9','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','2026-10-17 00:17:01.960157+00','2026-10-17 00:36:53.955748+00','{}');
INSERT INTO public.accounting_cash_atomic_contract_admissions VALUES('88fe7361-5768-439d-831e-37a2317c0fe9','{}','2026-10-20 16:24:58.122032+00');
INSERT INTO public.accounting_cash_rake_sources(id,club_id,earned_at,recorded_at,contract) VALUES('a82161cc-36a3-4654-911b-d7e29bcb1984','a0000000-0000-0000-0000-000000000001','2026-10-17 00:16:59.477817+00','2026-10-17 00:36:53.280667+00','{}');
INSERT INTO public.accounting_cash_atomic_contract_admissions VALUES('a82161cc-36a3-4654-911b-d7e29bcb1984','{}','2026-10-20 16:24:56.754401+00');
INSERT INTO public.accounting_cash_rake_sources(id,club_id,earned_at,recorded_at,contract) VALUES('c2ac9bd0-3fc3-4311-9a15-6f17dacc8b50','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','2026-10-17 00:17:02.022443+00','2026-10-17 00:36:54.149906+00','{}');
INSERT INTO public.accounting_cash_atomic_contract_admissions VALUES('c2ac9bd0-3fc3-4311-9a15-6f17dacc8b50','{}','2026-10-20 16:24:57.340691+00');
INSERT INTO public.accounting_cash_rake_sources(id,club_id,earned_at,recorded_at,contract) VALUES('f844ea78-72af-470b-813d-65532e8d6f9b','a0000000-0000-0000-0000-000000000001','2026-10-17 00:17:02.022443+00','2026-10-17 00:36:54.133765+00','{}');
INSERT INTO public.accounting_cash_atomic_contract_admissions VALUES('f844ea78-72af-470b-813d-65532e8d6f9b','{}','2026-10-20 16:24:57.53536+00');
INSERT INTO public.accounting_cash_rake_sources(id,club_id,earned_at,recorded_at,contract) VALUES('fc1e6099-b2c1-4fb0-864c-6039e9c48f49','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','2026-10-17 00:16:58.723853+00','2026-10-17 00:36:53.057934+00','{}');
INSERT INTO public.accounting_cash_atomic_contract_admissions VALUES('fc1e6099-b2c1-4fb0-864c-6039e9c48f49','{}','2026-10-20 16:24:58.64367+00');
INSERT INTO public.accounting_period_recompute_requests VALUES('11111111-1111-1111-1111-111111111111','e14bc9f7-736d-425f-8f2c-e78305ebac1d','2026-10-12','2026-10-18','complete','2026-10-20 15:42:33.726198Z','2026-10-20 15:42:33.725179Z','{"accounting_version":2,"status":"ready","club_id":"e14bc9f7-736d-425f-8f2c-e78305ebac1d","period_start":"2026-10-12","period_end":"2026-10-18"}');
VACUUM ANALYZE public.accounting_cash_rake_sources;
ANALYZE;
DO $$BEGIN
 IF md5(pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure))<>'fabde84baa4d2bee303531de45c65c06' OR md5(pg_get_functiondef('public.fn_rakeback_recompute_split(uuid,date,date)'::regprocedure))<>'cb4c66d535d0b0584ec2dad3d6f26c13' THEN RAISE EXCEPTION 'actual_original_preimage_reproduction_failed';END IF;
END$$;
