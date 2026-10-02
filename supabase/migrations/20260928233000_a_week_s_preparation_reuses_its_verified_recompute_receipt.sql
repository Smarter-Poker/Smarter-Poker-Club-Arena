-- A WEEK'S PREPARATION REUSES ITS VERIFIED RECOMPUTE RECEIPT (2026-09-28).
--
-- fn_prepare_accounting_week re-ran the whole-week calculator
-- (fn_rakeback_recompute_periods(club,from,to,NULL)) on every call, even when
-- the same club-week already had a complete, ready, version-2 receipt that no
-- later request had superseded. The weekly close calls it inside its single
-- money transaction after fn_lock_rakeback_payer_clubs, so Deep Stack
-- Society's first close spent 9-13 minutes recomputing an unchanged week
-- while holding its payer lock, blocking up to 11 live sessions and dying on
-- a deadlock at 22:32 UTC. Measured 2026-09-28 23:05-23:21 UTC by lock
-- observation; the receipt was complete at 22:10:34 with no newer request.
--
-- Now a club-week is recomputed only when its receipt is not proven current:
--   * the recompute request row is status 'complete' with a ready version-2
--     last_result for exactly this club and period,
--   * no request arrived after that attempt (last_requested_at <= attempted_at),
--   * no cash earning source for that club earned inside the week, and no
--     tournament fee source for that club, was recorded after the attempt
--     (a one-minute margin covers writers that started before it).
-- Otherwise the calculator runs exactly as before. Rounds 2 and 3 still
-- verify every certificate against accounting_payable_earning_sources and
-- refuse any mismatch, so a reused receipt can never pay a stale figure.
--
-- @live-proof: position('proven current (20260928233000)' in pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure)) > 0
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $patch$
DECLARE source text; needle text; replacement text;
BEGIN
 source:=pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
 IF md5(source) IS DISTINCT FROM 'cf709ed5dfee2c237f05c502830a2ac1' THEN
  RAISE EXCEPTION 'preimage mismatch: fn_prepare_accounting_week is not the reviewed definition'; END IF;
 needle:=$n$ FOREACH club IN ARRAY clubs LOOP
  result:=public.fn_rakeback_recompute_periods(club,from_date,to_date,NULL);$n$;
 IF (length(source)-length(replace(source,needle,'')))/length(needle)<>1 THEN
  RAISE EXCEPTION 'preparation_loop_changed' USING ERRCODE='55000'; END IF;
 replacement:=$r$ FOREACH club IN ARRAY clubs LOOP
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
     AND NOT EXISTS(SELECT 1 FROM public.accounting_cash_rake_sources s
       WHERE s.club_id=club AND s.earned_at>=p_from AND s.earned_at<p_to AND s.recorded_at>q.attempted_at-interval '1 minute')
     AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_sources f
       WHERE f.club_id=club AND f.recorded_at>q.attempted_at-interval '1 minute')) THEN
   CONTINUE;
  END IF;
  result:=public.fn_rakeback_recompute_periods(club,from_date,to_date,NULL);$r$;
 EXECUTE replace(source,needle,replacement);
END $patch$;

REVOKE ALL ON FUNCTION public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated, service_role;

DO $post$
BEGIN
 IF position('proven current (20260928233000)' in pg_get_functiondef('public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)'::regprocedure))=0 THEN
  RAISE EXCEPTION 'postimage: receipt reuse not installed'; END IF;
 IF has_function_privilege('anon','public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_prepare_accounting_week(uuid,uuid,timestamptz,timestamptz)','EXECUTE') THEN
  RAISE EXCEPTION 'postimage: browser roles can call the preparation'; END IF;
END $post$;
COMMIT;
