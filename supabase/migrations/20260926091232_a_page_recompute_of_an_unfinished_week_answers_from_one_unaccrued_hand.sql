-- 20260926091232_a_page_recompute_of_an_unfinished_week_answers_from_one_unaccrued_hand
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-26 09:12:32 UTC.
--
-- ===========================================================================
--  A PAGE RECOMPUTE OF AN UNFINISHED WEEK ANSWERS FROM ONE UNACCRUED HAND
-- ===========================================================================
--
-- WHAT WAS WRONG, MEASURED 2026-09-26 (production, read-only or rolled back)
--
--   The rakeback settler (RakebackSettlerService, engine) was ~84 hours behind
--   (daemon_state.rakeback_settler.high_water_mark 2026-09-22 20:15 at 08:57
--   UTC 09-26). After every page of rake_records it calls
--   fn_rakeback_recompute_periods(club, week, page players) once per
--   (club, week) the page touched. While the settler is behind, that week is
--   by construction unfinished: every hand after the settler's own cursor has
--   no accrued batch yet, so the calculator's `incomplete` count is non-zero
--   and the call is refused with written=0. The refusal still cost a full read
--   of the club-week: week_records (every cash hand of the week, all clubs),
--   the club's attributions, batches, sources and the tournament gate.
--
--   Measured cost of that refusal: the settler logged 137.8 s (a41434bb) and
--   20.2 s (2a1132b9) for the three first-page calls after the 08:55 restart,
--   and its first page took 209,364 ms against 67-86 s for the pages after
--   it. A pg_temp copy of the installed calculator (no lock, rolled back) on
--   a0000000's week did not finish inside the 120 s client budget at 09:20.
--   pg_stat_statements since 09-10: 2,753 calls, mean 5.2 s, max 220.8 s,
--   14,428 s total - as much database time as all 12,380 source-credit batches
--   (18,501 s). The engine restarted 11 times between 03:23 and 09:06 today,
--   and the settler's in-memory "this week is known incomplete" memory
--   (openWeekIncomplete) dies with each process, so every restart paid three
--   cold full-week reads, several minutes of the settler's time, each holding
--   the club-week advisory lock and the request row that the source-credit
--   batches and fn_recognize_accounting_tournament_fees also need.
--
-- WHY THE ANSWER IS ALREADY KNOWN
--
--   fn_calculate_cash_rakeback_periods counts as `incomplete` every
--   attribution of this club (club_attributions) on a week record
--   (week_records) whose joined batch status IS DISTINCT FROM 'accrued'. A
--   record with a hand_id, rake_amount>0, not a tournament record and inside
--   [v_from, v_to) is in week_records (the ghost-twin test short-circuits on a
--   non-null hand_id). If that record has NO accrued batch, every joined batch
--   row fails the accrued test, so each of its attributions to this club is in
--   the count. A non-zero count returns status blocked, written 0; every check
--   before it that could fire also returns blocked, written 0. No period row
--   and no certificate is written on any of those paths.
--
-- WHAT THIS CHANGES
--
--   Only fn_rakeback_recompute_periods, and only for a page-scoped call
--   (p_user_ids IS NOT NULL - the settler's call; fn_prepare_accounting_week
--   and every whole-period call are untouched). Under the same advisory lock
--   and after the same request upsert, it looks at the 200 newest cash hands
--   of the club-week (idx_rake_records_date backwards, then two primary-key /
--   covering-index probes per hand). If any of them has an attribution to this
--   club and no accrued batch, it returns the calculator's own refusal
--   (blocked, written 0, 'cash_source_receipts_incomplete') with source_count
--   = the attributions it saw, which is a LOWER bound of the calculator's
--   count - exactly what the settler's openWeekIncomplete treats it as ("at
--   least N"). Otherwise - a week before the cutover, an unknown club, a week
--   whose newest 200 hands are all accrued - it calls the unchanged calculator.
--   The request row is written by the unchanged tail either way.
--
--   Where a week has both an unaccrued hand AND an earlier-checked refusal
--   (tournament gate, evidence, legacy period), the calculator names that
--   earlier reason and this door names the unaccrued hand. Both are refusals
--   with written 0; the only reader of the reason text is the settler's
--   receipt check, which accepts any named refusal (readPeriodRecomputeReceipt).
--   On the three live club-weeks the calculator's recorded reason IS
--   cash_source_receipts_incomplete (08:59 UTC receipts: source_count 86,565 /
--   97,169 / 309,251).
--
-- PROOF (one execute_sql call each, one DO block ending in RAISE EXCEPTION,
-- so rolled back; the new body installed as pg_temp.fn_rrp_new, prosrc md5
-- 37a114ec314e300a5c369c80245fee7b = the body installed below)
--
--   (the a41434bb and 2a1132b9 runs used the same statements without the
--   comment block.)
--   a41434bb week 2026-09-21, 90 page players: blocked /
--     cash_source_receipts_incomplete / written 0 / source_count 260 in 574 ms
--     (advisory-lock wait 2 ms).
--   a0000000 week 2026-09-21, 99 page players: same refusal, source_count 179,
--     1,098 ms; rakeback_periods + certificates md5 for the club-week
--     identical before and after.
--   2a1132b9 week 2026-09-21: same refusal, source_count 194; periods and
--     certificates md5 unchanged. Fall-through on 2a1132b9 week 2026-09-14
--     (100 players): installed function and new body return identical jsonb
--     (historical_week_before_observed_source_cutover) minus request ids.
--   A multi-club probe in ONE transaction deadlocked against a live
--   source-credit batch on the request rows and was the victim (rolled back);
--   the proofs above take one club per transaction.
--
-- CLAUDE.md 10.11/10.12: this is the call's own cost, fixed at the line that
-- spends it. No job, sweep or backfill; no timeout raised. The settler's
-- batch arithmetic (cashAccountingBatchBudget.ts) prices the source-credit
-- call, which this does not touch.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $preimage$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure
                    AND md5(p.prosrc) = '0aaa0130962768018dd98dd2ea1108be') THEN
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
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'accounting_period_not_authorised' USING ERRCODE='42501'; END IF;
 IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
    OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end)
    OR extract(isodow FROM p_period_start)<>1 OR p_period_end<>p_period_start+6
    OR (p_user_ids IS NOT NULL AND (cardinality(p_user_ids)>2000 OR array_position(p_user_ids,NULL) IS NOT NULL))
 THEN RAISE EXCEPTION 'invalid_accounting_period_request' USING ERRCODE='22023'; END IF;
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

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])'::regprocedure
                    AND md5(prosrc) = '37a114ec314e300a5c369c80245fee7b' AND prosecdef
                    AND proconfig @> ARRAY['search_path=public','statement_timeout=300s']
                    AND has_function_privilege('service_role','public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])','EXECUTE')
                    AND NOT has_function_privilege('anon','public.fn_rakeback_recompute_periods(uuid,date,date,uuid[])','EXECUTE')) THEN
    RAISE EXCEPTION 'RECOMPUTE_POSTIMAGE: the installed body is not the proved body, or its grants or budget moved';
  END IF;
END $post$;

COMMIT;
