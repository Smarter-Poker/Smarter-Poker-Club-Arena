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

