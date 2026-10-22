-- HOURLY SLOTS AFTER THE DAILY RESET ARE NOT BREAKS (2026-10-22)
--
-- Dan moved routine engine resets to once a day at 4 AM Chicago and removed the
-- hourly cash freeze (2026-10-20). Until migration 20261021174252 taught the
-- scorer the new schedule, fn_ca_record_break_scorecard kept scoring every old
-- :55 slot and failed each one with break_never_started / dealt_inside_break /
-- thaw_did_not_run: 18 rows between 2026-10-20 23:55 and 2026-10-21 16:55 UTC.
-- None of those was a scheduled break, so none can fail. The daily digest
-- reported them as "13 engine maintenance breaks did not pass".
--
-- 1. Those rows keep their measurements but carry verdict 'not_scheduled'.
-- 2. The digest counts only scheduled breaks (verdict pass or fail).
-- 3. The stored Oct 20 and Oct 21 digest metrics are re-counted the same way.

UPDATE public.ca_break_scorecards
   SET verdict = 'not_scheduled',
       detail = detail || jsonb_build_object(
         'reclassified_at', now(),
         'reclassified_reason', 'hourly slot after the once-daily 4 AM Chicago reset began; not a scheduled break')
 WHERE verdict = 'fail'
   AND break_started_at >= timestamptz '2026-10-20 23:55:00+00'
   AND break_started_at <  timestamptz '2026-10-21 17:00:00+00'
   AND extract(minute FROM break_started_at AT TIME ZONE 'UTC') = 55
   AND thaw_ran IS NOT TRUE
   AND detail->'reasons' ? 'break_never_started';

DO $mig$
DECLARE
  v_old text := $q$'breaks', (SELECT jsonb_build_object('total', count(*), 'passed', count(*) FILTER (WHERE verdict = 'pass'))$q$;
  v_new text := $q$'breaks', (SELECT jsonb_build_object('total', count(*) FILTER (WHERE verdict IN ('pass','fail')), 'passed', count(*) FILTER (WHERE verdict = 'pass'))$q$;
  v_def text;
  r record;
BEGIN
  FOR r IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'fn_sp_daily_metrics_compute' LOOP
    v_def := pg_get_functiondef(r.oid);
    IF position(v_new IN v_def) > 0 THEN CONTINUE; END IF;
    IF position(v_old IN v_def) = 0 THEN
      RAISE EXCEPTION 'fn_sp_daily_metrics_compute no longer contains the breaks expression this migration rewrites';
    END IF;
    EXECUTE replace(v_def, v_old, v_new);
  END LOOP;
END $mig$;

UPDATE public.sp_daily_metrics m
   SET metrics = jsonb_set(m.metrics, '{health,breaks}', x.breaks)
  FROM (SELECT d.day,
               (SELECT jsonb_build_object('total', count(*) FILTER (WHERE verdict IN ('pass','fail')),
                                          'passed', count(*) FILTER (WHERE verdict = 'pass'))
                  FROM public.ca_break_scorecards b
                 WHERE b.recorded_at >= (d.day::timestamp AT TIME ZONE 'America/Chicago')
                   AND b.recorded_at <  ((d.day + 1)::timestamp AT TIME ZONE 'America/Chicago')) AS breaks
          FROM (VALUES (date '2026-10-20'), (date '2026-10-21')) d(day)) x
 WHERE m.day = x.day;
