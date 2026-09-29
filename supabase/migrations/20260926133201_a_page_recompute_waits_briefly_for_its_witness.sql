-- 20260926133201_a_page_recompute_waits_briefly_for_its_witness
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-26 13:32:01 UTC.
--
-- ===========================================================================
--  A PAGE RECOMPUTE WAITS BRIEFLY FOR ITS WITNESS, BEFORE IT HOLDS ANYTHING
-- ===========================================================================
--
-- WHAT WAS WRONG, MEASURED 2026-09-26 (production, read-only or rolled back)
--
--   20260926091232 (applied 13:11:29 UTC) lets a page-scoped
--   fn_rakeback_recompute_periods call answer from one hand of the club-week
--   that has no accrued batch, instead of paying the full-week calculator only
--   to be refused. While the settler was behind that door always had a
--   witness, and the settler cleared its 84-hour backlog: cursor 2026-09-22
--   20:15 at 08:57, 2026-09-26 13:19 at 13:19 (source receipts 10,000-15,400
--   per 15 minutes from 09:45, against ~40 cash hands a minute arriving).
--
--   Once the settler is CURRENT the only unaccrued hands of an open week are
--   the ones dealt since its own last page, and a call made in the second
--   after that page often finds none for its club. Measured 13:00-13:30 on
--   the three clubs with cash rake this week: a club's next attributed hand
--   is a median 1.10 / 1.45 / 1.68 s away, p95 5.33 / 6.15 / 8.64 s, max 12 /
--   17 / 34 s. Every miss fell through to the full-week calculator, which
--   then saw the hands dealt meanwhile and refused anyway:
--     13:21:46  2a1132b9  supabase_timeout; page took 130,286 ms; the
--               settler held its cursor (3 failures) and retried the page
--     13:23:44  2a1132b9  refused cash_source_receipts_incomplete after 40,886 ms
--     13:25:35  a0000000  refused cash_source_receipts_incomplete after 20,301 ms
--   While it ran it held the club-week advisory lock and the
--   accounting_period_recompute_requests row. pg_stat_activity at 13:20:03
--   and 13:20:45: the recompute (66 s, IO:DataFileRead) blocked
--   fn_complete_tournament_terminal (24.5 s on Lock:transactionid), which
--   blocked ten more sessions, fn_ca_process_hand_post_commit_obligations and
--   fn_project_hand_side_effects among them - live hands waiting on a
--   rakeback refusal.
--
-- WHAT THIS CHANGES
--
--   Only fn_rakeback_recompute_periods, and only a page-scoped call
--   (p_user_ids IS NOT NULL) of a week that is still open, after the cutover,
--   for a club that exists. BEFORE it takes the club-week lock or touches the
--   request row, it asks whether a hand of this club dealt in the last minute
--   of the week has no accrued batch, and if not, waits 0.5 s and asks again,
--   at most 16 times (8 s). The wait decides nothing and writes nothing: the
--   unchanged 20260926091232 door then decides under the lock from its own
--   read, and the unchanged calculator runs when it finds nothing. A
--   whole-period call, fn_prepare_accounting_week, a closed week and an
--   unknown club never wait. No job, sweep or backfill; no timeout raised.
--
-- PROOF (one execute_sql call each, one DO block ending in RAISE EXCEPTION,
-- so rolled back; the new body installed as pg_temp.fn_rrp_new)
--
--   a0000000 week 2026-09-21, 24 page players, settler current: blocked
--     cash_source_receipts_incomplete source_count 71 in 41.5 ms, waited 0;
--     rakeback_periods and certificate md5 for the club-week unchanged.
--   002c2d27 (no cash rake this week), fall-through: the installed function
--     answered ready, written 0 in 1,761 ms; the wait-then-installed path
--     answered the identical receipt (request id/time aside) after waiting
--     16 x 0.5 s, 8,948 ms; periods md5 unchanged.
--   Installed prosrc md5 37a114ec314e300a5c369c80245fee7b (postimage of
--   20260926091232) is asserted before; 936ccee154e1b0cf6d88dd3fd653215b after.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $preimage$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure
                    AND md5(p.prosrc) = '37a114ec314e300a5c369c80245fee7b') THEN
    RAISE EXCEPTION 'RECOMPUTE_PREIMAGE_CHANGED: fn_rakeback_recompute_periods is not the body this migration was derived from';
  END IF;
END $preimage$;

CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_periods(p_club_id uuid, p_period_start date, p_period_end date, p_user_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE request public.accounting_period_recompute_requests%ROWTYPE; result jsonb; request_state text;
 v_from timestamptz; v_to timestamptz; cutover timestamptz; unaccrued bigint:=0;
 v_wait_from timestamptz; witnessed boolean:=false; waited integer:=0;
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
 INSERT INTO public.accounting_period_recompute_requests(club_id,period_start,period_end)
  VALUES(p_club_id,p_period_start,p_period_end)
  ON CONFLICT(club_id,period_start,period_end) DO UPDATE SET last_requested_at=clock_timestamp(),status='pending',reason=NULL
  RETURNING * INTO request;
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
 request_state:=CASE WHEN result->>'status'='ready' AND p_user_ids IS NULL THEN 'complete'
                     WHEN result->>'status'='ready' THEN 'pending' ELSE 'blocked' END;
 UPDATE public.accounting_period_recompute_requests SET status=request_state,reason=result->>'reason',
  attempted_at=clock_timestamp(),attempts=attempts+1,last_result=result WHERE id=request.id;
 RETURN result||jsonb_build_object('request_id',request.id,'requested_at',request.requested_at,
  'request_state',request_state,'request_recorded',true);
END $function$;

-- The installed ACL is {postgres=X, service_role=X}; restated so the
-- migration carries its own authority (check-definer-authorization).
REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_periods(uuid,date,date,uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_recompute_periods(uuid,date,date,uuid[]) TO service_role;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure
                    AND md5(prosrc) = '936ccee154e1b0cf6d88dd3fd653215b' AND prosecdef
                    AND proconfig @> ARRAY['search_path=public','statement_timeout=300s']
                    AND has_function_privilege('service_role','public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])','EXECUTE')
                    AND NOT has_function_privilege('anon','public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])','EXECUTE')
                    AND NOT has_function_privilege('authenticated','public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])','EXECUTE')) THEN
    RAISE EXCEPTION 'RECOMPUTE_POSTIMAGE: the installed body is not the proved body, or its grants or budget moved';
  END IF;
END $post$;

COMMIT;
