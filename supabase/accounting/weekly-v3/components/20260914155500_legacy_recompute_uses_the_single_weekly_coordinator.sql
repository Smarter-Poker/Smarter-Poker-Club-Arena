-- UNAPPLIED forward cutover after scheduler fairness. Retire the duplicate
-- weekly recompute schedule; calculation remains in certified preparation and
-- the source daemon. No new job, work queue, calculator or money writer.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$
DECLARE expected_definition text:=
$preimage$CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_all_clubs(p_period_start date DEFAULT NULL::date, p_period_end date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE
  v_from date := COALESCE(p_period_start, (date_trunc('week', now()) - interval '7 days')::date);
  v_to   date := COALESCE(p_period_end,   (date_trunc('week', now()) - interval '1 day')::date);
  c record;
  v_one jsonb;
  v_written int := 0;
  v_clubs int := 0;
  v_failed int := 0;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  -- Every club that belongs to a union. Private club games are excluded from
  -- union numbers elsewhere; rakeback is still owed per club, so the club is
  -- the unit here.
  FOR c IN
    SELECT DISTINCT uc.club_id FROM union_clubs uc
  LOOP
    BEGIN
      v_one := public.fn_rakeback_recompute_periods(c.club_id, v_from, v_to, NULL);
      v_written := v_written + COALESCE((v_one->>'written')::int, 0);
      v_clubs := v_clubs + 1;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1;
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('warning', 'fn_rakeback_recompute_all_clubs',
              'Rakeback recompute failed for a club',
              jsonb_build_object('club_id', c.club_id, 'error', SQLERRM,
                                 'period_start', v_from, 'period_end', v_to));
    END;
  END LOOP;

  -- If the week produced rake but no rakeback rows at all, something upstream
  -- is broken and Round 3 is about to pay nobody. Say so before it happens.
  IF v_written = 0 AND EXISTS (
       SELECT 1 FROM rake_records r
        JOIN union_clubs uc ON uc.club_id = r.club_id
       WHERE r.created_at >= v_from::timestamptz
         AND r.created_at < (v_to + 1)::timestamptz
         AND r.rake_amount > 0
     ) THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('critical', 'fn_rakeback_recompute_all_clubs',
            'Rake was generated this period but no rakeback rows were written - Round 3 will pay nobody',
            jsonb_build_object('period_start', v_from, 'period_end', v_to,
                               'clubs_processed', v_clubs));
  END IF;

  RETURN jsonb_build_object('clubs_processed', v_clubs, 'clubs_failed', v_failed,
                            'rows_written', v_written,
                            'period_start', v_from, 'period_end', v_to, 'ran_at', now());
END $function$
$preimage$;
expected_job text:=$job$
  SET statement_timeout = '600s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-recompute'))
             then (select set_config('statement_timeout','600s',true) is not null
                      and public.fn_rakeback_recompute_all_clubs() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $job$;
expected_close text:=$close$
  SET statement_timeout = '2400s';
  select case
           when pg_try_advisory_lock(hashtext('union-weekly-rakeback-close'))
             then (select set_config('statement_timeout','2400s',true) is not null
                      and public.fn_union_settlement_cascade_due() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $close$;
BEGIN
 -- This exact saved pg_get_functiondef preimage avoids inventing a hash while
 -- execution is prohibited. Ignore trailing file newlines, not body changes.
 IF rtrim(pg_get_functiondef('public.fn_rakeback_recompute_all_clubs(date,date)'::regprocedure),E'\n')
    IS DISTINCT FROM rtrim(expected_definition,E'\n')
  OR has_function_privilege('anon','public.fn_rakeback_recompute_all_clubs(date,date)','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_rakeback_recompute_all_clubs(date,date)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.fn_rakeback_recompute_all_clubs(date,date)','EXECUTE') THEN
  RAISE EXCEPTION 'legacy recompute retirement preimage changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.union_accounting_runs'::regclass
    AND attname='last_scheduler_visit_at' AND NOT attisdropped)
  OR (SELECT regexp_replace(prosrc,'[[:space:]]','','g') FROM pg_proc
    WHERE oid='public.fn_process_weekly_accounting(uuid)'::regprocedure)
     IS DISTINCT FROM 'SELECTpublic.fn_process_weekly_accounting_scope(p_union_id,NULL::uuid)'
  OR (SELECT count(*) FROM cron.job WHERE jobname='union-weekly-rakeback-close')<>1
  OR NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='union-weekly-rakeback-close'
    AND active AND schedule='5,35 * * * *' AND command=expected_close) THEN
  RAISE EXCEPTION 'single weekly scheduler must remain active before legacy recompute retirement';END IF;
 IF (SELECT count(*) FROM cron.job WHERE jobname='union-weekly-rakeback-recompute')<>1
  OR NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='union-weekly-rakeback-recompute'
    AND active AND schedule='45 6,7 * * 1' AND command=expected_job) THEN
  RAISE EXCEPTION 'legacy recompute cron preimage changed';END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_rakeback_recompute_all_clubs(p_period_start date DEFAULT NULL::date,p_period_end date DEFAULT NULL::date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE result jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501';END IF;
 -- Do not silently turn a request for one historical date interval into an
 -- all-books payment run. Date-directed legacy calls perform no work.
 IF p_period_start IS NOT NULL OR p_period_end IS NOT NULL THEN
  RETURN jsonb_build_object('success',false,'code','automatic_weekly_settlement',
   'reason','legacy_date_recompute_retired','authority','fn_process_weekly_accounting',
   'clubs_processed',0,'clubs_failed',0,'rows_written',0,
   'period_start',p_period_start,'period_end',p_period_end,'ran_at',clock_timestamp());
 END IF;
 result:=public.fn_process_weekly_accounting(NULL);
 -- Return the actual checked/failed/detail or skipped receipt. The coordinator
 -- does not report legacy calculator row/club counts, so leave them unknown.
 RETURN result||jsonb_build_object('authority','fn_process_weekly_accounting',
   'delegated',true,'legacy_recompute_retired',true,'legacy_counts_unavailable',true,
   'clubs_processed',NULL,'clubs_failed',NULL,'rows_written',NULL,
   'period_start',NULL,'period_end',NULL,'ran_at',clock_timestamp());
END $function$;
REVOKE ALL ON FUNCTION public.fn_rakeback_recompute_all_clubs(date,date) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_rakeback_recompute_all_clubs(date,date) TO service_role;
COMMENT ON FUNCTION public.fn_rakeback_recompute_all_clubs(date,date) IS 'Retired standalone recompute coordinator. Trusted no-argument compatibility calls delegate to the single bounded weekly accounting coordinator; explicit legacy date calls do no work. The old weekly recompute cron is retired.';
DO $retire$
BEGIN
 IF NOT cron.unschedule('union-weekly-rakeback-recompute') THEN
  RAISE EXCEPTION 'legacy recompute cron retirement not confirmed';END IF;
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='union-weekly-rakeback-recompute' AND active) THEN
  RAISE EXCEPTION 'legacy recompute cron remains active';END IF;
END $retire$;
COMMIT;
