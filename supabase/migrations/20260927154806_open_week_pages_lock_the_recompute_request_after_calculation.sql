-- Open-week pages retain their advisory lock and financial calculation while
-- acquiring the shared durable request row only after the calculation. A slow
-- page must not hold terminal recognition behind a request-row transaction lock.
-- Closed-week and full-book calls preserve their original order. No financial
-- formula, guard, caller permission, witness wait, deadline or result schema changes.
-- Existing request identity/creation time is retained. New rows and the last-request
-- clock timestamp intentionally reflect the later write; financial values/states do not change.
-- @live-proof: SELECT md5(pg_get_functiondef('public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure))='7b5688a846bd8cea792abd1d5bcd774a' AS present;
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='8s';
DO $guard$
DECLARE original text; candidate text; before_catalog jsonb;
BEGIN
 IF md5(pg_get_functiondef('fn_accounting_tournament_week_quality(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '15496db2b1026a92fedee86502028b95' THEN RAISE EXCEPTION 'OPEN_WEEK_REQUEST_SOURCE_CHANGED: fn_accounting_tournament_week_quality'; END IF;
 IF md5(pg_get_functiondef('fn_calculate_cash_rakeback_periods(uuid,date,date,uuid[])'::regprocedure)) IS DISTINCT FROM '2fffb5add208db1eb1e6b66c9df15220' THEN RAISE EXCEPTION 'OPEN_WEEK_REQUEST_SOURCE_CHANGED: fn_calculate_cash_rakeback_periods'; END IF;
 IF md5(pg_get_functiondef('fn_caller_is_engine()'::regprocedure)) IS DISTINCT FROM 'd9a70f1d932538025e656bfe2b4d091d' THEN RAISE EXCEPTION 'OPEN_WEEK_REQUEST_SOURCE_CHANGED: fn_caller_is_engine'; END IF;
 IF md5(pg_get_functiondef('fn_rake_record_is_ghost_twin(uuid,uuid,jsonb)'::regprocedure)) IS DISTINCT FROM 'd59ea94ab309a36c5d5a1298cbc604d3' THEN RAISE EXCEPTION 'OPEN_WEEK_REQUEST_SOURCE_CHANGED: fn_rake_record_is_ghost_twin'; END IF;
 IF md5(pg_get_functiondef('fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure)) IS DISTINCT FROM 'e99a813fda15749223c45954404c961e' THEN RAISE EXCEPTION 'OPEN_WEEK_REQUEST_SOURCE_CHANGED: fn_rakeback_recompute_periods'; END IF;
 IF md5(pg_get_functiondef('fn_recognize_accounting_tournament_fees(uuid,timestamp with time zone,uuid,uuid,uuid)'::regprocedure)) IS DISTINCT FROM '195878da781227b47753a28dbc7bc978' THEN RAISE EXCEPTION 'OPEN_WEEK_REQUEST_SOURCE_CHANGED: fn_recognize_accounting_tournament_fees'; END IF;
 IF md5(pg_get_functiondef('fn_union_week_start(timestamp with time zone)'::regprocedure)) IS DISTINCT FROM '103f192a228084dad0e4268c36c82c4b' THEN RAISE EXCEPTION 'OPEN_WEEK_REQUEST_SOURCE_CHANGED: fn_union_week_start'; END IF;
 IF md5(pg_get_functiondef('public.fn_lock_accounting_tournament_recognition_week(uuid,timestamp with time zone)'::regprocedure)) IS DISTINCT FROM 'd5339cec8b0e00be748c4c15bc3dba83' THEN RAISE EXCEPTION 'OPEN_WEEK_RECOGNITION_LOCK_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure
  AND proowner='postgres'::regrole AND prosecdef AND provolatile='v'
  AND proconfig=ARRAY['search_path=public','statement_timeout=300s']
  AND proacl::text='{postgres=X/postgres,service_role=X/postgres}')
 THEN RAISE EXCEPTION 'OPEN_WEEK_REQUEST_AUTHORITY_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.accounting_period_recompute_requests'::regclass
  AND relowner='postgres'::regrole AND relrowsecurity AND NOT relforcerowsecurity
  AND relacl::text='{postgres=arwdDxtm/postgres,service_role=r/postgres}')
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.accounting_period_recompute_requests'::regclass AND NOT tgisinternal)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_index i ON i.indexrelid=c.conindid
   WHERE c.conrelid='public.accounting_period_recompute_requests'::regclass AND c.contype='u'
    AND pg_get_constraintdef(c.oid)='UNIQUE (club_id, period_start, period_end)'
    AND NOT c.condeferrable AND i.indimmediate AND i.indisvalid AND i.indisready AND i.indislive)
 THEN RAISE EXCEPTION 'OPEN_WEEK_REQUEST_TABLE_CHANGED'; END IF;
 SELECT jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,
  'definer',prosecdef,'volatility',provolatile) INTO before_catalog
 FROM pg_proc WHERE oid='public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure;
 SELECT pg_get_functiondef('public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure) INTO original;
 candidate:=$definition$CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE request public.accounting_period_recompute_requests%ROWTYPE; result jsonb; request_state text;
 v_from timestamptz; v_to timestamptz; cutover timestamptz; unaccrued bigint:=0;
 v_wait_from timestamptz; witnessed boolean:=false; waited integer:=0;
 defer_request_lock boolean:=false;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_period_request' USING ERRCODE='22023'; END IF;
 -- A PAGE WAITS BRIEFLY FOR ITS WITNESS, BEFORE IT HOLDS ANYTHING
 -- (20260926133201). Once the settler is current, the hands of an open week
 -- that have no accrued batch are only the ones dealt since its last page -
 -- a club's next attributed hand is a median 1.1-1.7 s away (p95 5.3-8.6 s,
 -- measured 2026-09-26 13:00-13:30). A call that arrives in that gap found no
 -- witness in the door below and paid the full-week calculator, 20-130 s,
 -- holding the club-week lock and the request row that
 -- fn_complete_tournament_terminal also takes. This wait decides nothing: it
 -- holds no lock and writes nothing, only waits (at most 16 x 0.5 s) for one
 -- such hand to exist; the unchanged door below still decides, under the lock,
 -- from its own read. Page-scoped calls of an open week only.
 IF p_user_ids IS NOT NULL THEN
  v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
  v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
  SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
  IF cutover IS NOT NULL AND v_from>=cutover AND clock_timestamp()<v_to
     AND EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id) THEN
   LOOP
    v_wait_from:=greatest(v_from,clock_timestamp()-interval '1 minute');
    SELECT EXISTS(SELECT 1 FROM public.rake_records r
      JOIN public.rake_attributions a ON a.rake_record_id=r.id AND a.club_id=p_club_id
     WHERE r.created_at>=v_wait_from AND r.created_at<v_to AND r.rake_amount>0
       AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL AND r.hand_id IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches b
                       WHERE b.rake_record_id=r.id AND b.status='accrued')) INTO witnessed;
    EXIT WHEN witnessed OR waited>=16 OR clock_timestamp()>=v_to;
    PERFORM pg_sleep(0.5);
    waited:=waited+1;
   END LOOP;
  END IF;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('accounting_rakeback_period:'||p_club_id::text||':'||p_period_start::text,0));
 -- A live page cannot complete a weekly book. Keep the original club-week
 -- advisory lock, but let terminal recognition record its pending request
 -- while this page reads the week. Whole-week and closed-week calls keep the
 -- original request-first order. Evaluate the boundary after advisory admission.
 defer_request_lock:=p_user_ids IS NOT NULL AND cutover IS NOT NULL
  AND v_from>=cutover AND clock_timestamp()>=v_from AND clock_timestamp()<v_to
  AND EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id);
 IF NOT defer_request_lock THEN
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
  VALUES(p_club_id,p_period_start,p_period_end)
  ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL
  RETURNING * INTO request;
 END IF;
 BEGIN
  -- A PAGE CANNOT CERTIFY A WEEK THAT STILL HOLDS AN UNACCRUED HAND
  -- (20260926091232). The calculator counts, as `incomplete`, every
  -- attribution of this club on a week record with no accrued batch, and a
  -- non-zero count refuses the call with written=0 whatever else it finds.
  -- When one such hand is already in view the full-week read can only reach
  -- a refusal, so answer from the hand. Only a page-scoped call takes this
  -- door; a whole-period call, a week before the cutover, an unknown club and
  -- a week whose newest hands are all accrued go to the unchanged calculator.
  IF p_user_ids IS NOT NULL THEN
   v_from:=p_period_start::timestamp AT TIME ZONE 'America/Los_Angeles';
   v_to:=(p_period_end+1)::timestamp AT TIME ZONE 'America/Los_Angeles';
   SELECT starts_at INTO cutover FROM public.accounting_cash_accrual_cutover WHERE singleton;
   IF cutover IS NOT NULL AND v_from>=cutover AND EXISTS(SELECT 1 FROM public.clubs WHERE id=p_club_id) THEN
    SELECT count(*) INTO unaccrued
     FROM (SELECT r.id FROM public.rake_records r
            WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
              AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL AND r.hand_id IS NOT NULL
            ORDER BY r.created_at DESC LIMIT 200) w
     JOIN public.rake_attributions a ON a.rake_record_id=w.id AND a.club_id=p_club_id
     WHERE NOT EXISTS(SELECT 1 FROM public.accounting_cash_accrual_batches b
                       WHERE b.rake_record_id=w.id AND b.status='accrued');
   END IF;
  END IF;
  IF unaccrued>0 THEN
   result:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,
    'period_end',p_period_end,'written',0,'status','blocked','reason','cash_source_receipts_incomplete',
    'source_count',unaccrued);
  ELSE
   result:=public.fn_calculate_cash_rakeback_periods(p_club_id,p_period_start,p_period_end,p_user_ids);
  END IF;
 EXCEPTION WHEN OTHERS THEN
  -- This subtransaction rolls back every period/certificate write before the
  -- durable request is marked blocked. The source cursor can keep accruing
  -- later hands; the weekly coordinator still refuses this unfinished book.
  result:=jsonb_build_object('accounting_version',2,'club_id',p_club_id,'period_start',p_period_start,
    'period_end',p_period_end,'status','blocked','written',0,'reason',SQLERRM);
 END;
 IF defer_request_lock THEN
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
  VALUES(p_club_id,p_period_start,p_period_end)
  ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL
  RETURNING * INTO request;
 END IF;
 request_state:=CASE WHEN result->>'status'='ready' AND p_user_ids IS NULL THEN 'complete'
                     WHEN result->>'status'='ready' THEN 'pending' ELSE 'blocked' END;
 UPDATE public.accounting_period_recompute_requests SET status=request_state,reason=result->>'reason',
  attempted_at=clock_timestamp(),attempts=attempts+1,last_result=result WHERE id=request.id;
 RETURN result||jsonb_build_object('request_id',request.id,'requested_at',request.requested_at,
  'request_state',request_state,'request_recorded',true);
END $function$
$definition$;
 EXECUTE candidate;
 IF md5(pg_get_functiondef('public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure)) IS DISTINCT FROM '7b5688a846bd8cea792abd1d5bcd774a' THEN RAISE EXCEPTION 'OPEN_WEEK_REQUEST_POSTIMAGE_CHANGED'; END IF;
 IF (SELECT jsonb_build_object('oid',oid,'owner',proowner,'acl',proacl,'config',proconfig,
  'definer',prosecdef,'volatility',provolatile) FROM pg_proc
  WHERE oid='public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure) IS DISTINCT FROM before_catalog
 THEN RAISE EXCEPTION 'OPEN_WEEK_REQUEST_CATALOG_CHANGED'; END IF;
END $guard$;
COMMIT;
