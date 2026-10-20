-- @live-proof: md5(pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure))='59ffa64567422631e131fd3cc2b03552'
-- @live-proof: md5(pg_get_functiondef('public.fn_rakeback_recompute_split(uuid,date,date)'::regprocedure))='2d8ab8647146824b837ee193b624834c'
-- @live-proof: md5(pg_get_viewdef('public.accounting_effective_cash_rake_sources'::regclass,true))='0dd662a7489be5f387e5838f8ca801c5'
-- @live-proof: (SELECT count(*)=2 AND bool_and(pg_get_userbyid(p.proowner)='postgres' AND p.proconfig=ARRAY['search_path=public']::text[] AND p.prosecdef=(p.proname='fn_prepare_accounting_week') AND p.proacl::text=CASE WHEN p.proname='fn_prepare_accounting_week' THEN '{postgres=X/postgres}' ELSE '{postgres=X/postgres,service_role=X/postgres}' END) FROM pg_proc p WHERE p.oid IN('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_rakeback_recompute_split(uuid,date,date)'::regprocedure))
-- Version: 20261020164752 (maintained allocator).
-- Preserve original earning scope and effective admission freshness using existing indexed inputs.
-- Original two owners only; no new cache/view/pipeline/index and no live qualification DDL.
BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='2s';
DO $owner_freshness$
DECLARE before_meta jsonb; after_meta jsonb;
 prepare_definition constant text := $prepare$CREATE OR REPLACE FUNCTION public.fn_prepare_accounting_week(p_union_id uuid, p_club_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
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

$prepare$;
 split_definition constant text := $split$CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_split(p_club_id uuid, p_period_start date, p_period_end date)
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
   OR EXISTS(SELECT 1 FROM (
     SELECT s.earned_at FROM public.accounting_cash_rake_sources s
     WHERE s.club_id=p_club_id AND s.recorded_at>oldest-interval '1 minute' OFFSET 0
    ) s WHERE s.earned_at>=v_from AND s.earned_at<v_to)
   OR EXISTS(SELECT 1 FROM (
     SELECT a.source_id FROM public.accounting_cash_atomic_contract_admissions a
     WHERE a.admitted_at>oldest-interval '1 minute' OFFSET 0
    ) a CROSS JOIN LATERAL (
     SELECT s.club_id,s.earned_at FROM public.accounting_cash_rake_sources s WHERE s.id=a.source_id OFFSET 0
    ) s WHERE s.club_id=p_club_id AND s.earned_at>=v_from AND s.earned_at<v_to)
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

$split$;
BEGIN
 IF md5(pg_get_viewdef('public.accounting_effective_cash_rake_sources'::regclass,true)) IS DISTINCT FROM '0dd662a7489be5f387e5838f8ca801c5' THEN
  RAISE EXCEPTION 'original_effective_cash_view_contract_changed';END IF;
 IF EXISTS(SELECT FROM (VALUES
 ('accounting_cash_rake_sources','id','uuid'),('accounting_cash_rake_sources','club_id','uuid'),
 ('accounting_cash_rake_sources','earned_at','timestamp with time zone'),('accounting_cash_rake_sources','recorded_at','timestamp with time zone'),
 ('accounting_cash_atomic_contract_admissions','source_id','uuid'),('accounting_cash_atomic_contract_admissions','admitted_at','timestamp with time zone')
 )e(rel,col,typ) LEFT JOIN pg_attribute a ON a.attrelid=to_regclass('public.'||e.rel) AND a.attname=e.col AND a.attnum>0 AND NOT a.attisdropped
 WHERE a.attnum IS NULL OR NOT a.attnotnull OR format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM e.typ) THEN
  RAISE EXCEPTION 'original_effective_cash_column_contract_changed';END IF;
 IF NOT EXISTS(SELECT FROM pg_constraint c JOIN pg_index i ON i.indexrelid=c.conindid
 WHERE c.conrelid='public.accounting_cash_atomic_contract_admissions'::regclass AND c.contype='p'
 AND NOT c.condeferrable AND c.convalidated AND i.indisvalid AND i.indisunique
 AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='source_id')]::smallint[])
 THEN RAISE EXCEPTION 'original_admission_single_source_identity_contract_changed';END IF;
 IF md5(pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM 'fabde84baa4d2bee303531de45c65c06'
 OR md5(pg_get_functiondef('public.fn_rakeback_recompute_split(uuid,date,date)'::regprocedure)) IS DISTINCT FROM 'cb4c66d535d0b0584ec2dad3d6f26c13'
 THEN RAISE EXCEPTION 'original_freshness_owner_preimage_changed';END IF;
 IF EXISTS(SELECT FROM pg_proc p WHERE p.oid IN('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_rakeback_recompute_split(uuid,date,date)'::regprocedure)
 AND (pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres'
 OR p.proacl::text IS DISTINCT FROM CASE WHEN p.proname='fn_prepare_accounting_week' THEN '{postgres=X/postgres}' ELSE '{postgres=X/postgres,service_role=X/postgres}' END))
 THEN RAISE EXCEPTION 'original_freshness_owner_acl_contract_changed';END IF;
 IF 'fn_prepare_accounting_week'=ANY(public.fn_ca_guard_watchlist()) OR 'fn_rakeback_recompute_split'=ANY(public.fn_ca_guard_watchlist()) THEN
  RAISE EXCEPTION 'actual_watchlist_changed_qualify_necessary_C3_declaration_first';END IF;
 IF NOT EXISTS(SELECT FROM public.ca_money_rpc_registry WHERE proname='fn_prepare_accounting_week' AND status='approved') THEN
  RAISE EXCEPTION 'existing_preparation_money_registry_required';END IF;
 SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'acl',p.proacl::text,'config',p.proconfig) ORDER BY p.oid::regprocedure::text)
 INTO before_meta FROM pg_proc p WHERE p.oid IN('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_rakeback_recompute_split(uuid,date,date)'::regprocedure);
 EXECUTE prepare_definition;
 EXECUTE split_definition;
 SELECT jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',pg_get_userbyid(p.proowner),'secdef',p.prosecdef,'acl',p.proacl::text,'config',p.proconfig) ORDER BY p.oid::regprocedure::text)
 INTO after_meta FROM pg_proc p WHERE p.oid IN('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_rakeback_recompute_split(uuid,date,date)'::regprocedure);
 IF after_meta IS DISTINCT FROM before_meta THEN RAISE EXCEPTION 'original_freshness_owner_security_metadata_changed';END IF;
 IF EXISTS(SELECT FROM pg_proc p WHERE p.oid IN('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure,'public.fn_rakeback_recompute_split(uuid,date,date)'::regprocedure) AND public.fn_ca_money_rpc_writes_balances(p.prosrc)) THEN RAISE EXCEPTION 'freshness_change_unexpected_balance_writer';END IF;
 IF md5(pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)) IS DISTINCT FROM '59ffa64567422631e131fd3cc2b03552'
 OR md5(pg_get_functiondef('public.fn_rakeback_recompute_split(uuid,date,date)'::regprocedure)) IS DISTINCT FROM '2d8ab8647146824b837ee193b624834c'
 THEN RAISE EXCEPTION 'native_qualified_freshness_postimage_required';END IF;
END $owner_freshness$;
-- Restate the original owner-only entry point explicitly for branch-level ACL checks.
-- The installer above requires this exact existing ACL before either replacement.
REVOKE ALL ON FUNCTION public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
COMMIT;
