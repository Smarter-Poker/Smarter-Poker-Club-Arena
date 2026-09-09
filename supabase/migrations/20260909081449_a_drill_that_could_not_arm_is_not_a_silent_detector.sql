DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* 1. THE DRILL CAN ARM ITSELF.                                        */
  /*                                                                     */
  /* fn_ca_alarm_drill reported that negative_balance,                    */
  /* suspense_regression, mint_velocity and delete_journals_burn "stayed  */
  /* silent when their drift condition was created". They had not.        */
  /* Every one of those four arms writes to club_members or chip_ledger,  */
  /* and every one of them threw                                          */
  /*   PLATFORM_FROZEN: the platform is on a scheduled maintenance break  */
  /* before its write landed - the note is in ca_alarm_drills id=2. No    */
  /* drift condition was created, so no detector was ever called.         */
  /*                                                                     */
  /* This was not bad luck. The drill's cron (jobid 207) fires at 11:00   */
  /* on Mondays; the freeze runs :55 to :00 of every hour. Its only       */
  /* scheduled run in history was guaranteed to land inside the freeze.   */
  /* The one clean pass this drill has ever had (id=1) was a manual run   */
  /* at 01:08.                                                            */
  /*                                                                     */
  /* Two of the four detectors it accused had fired correctly in          */
  /* production that same week: fn_ca_suspense_regression_check 22 times, */
  /* most recently the same morning, and fn_ca_mint_velocity_watch twice. */
  /* fn_freeze_bypass_active is checked ahead of fn_platform_frozen and   */
  /* reads a transaction-local GUC, so the drill can exempt its own       */
  /* transaction and nothing else.                                        */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_alarm_drill';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_alarm_drill not found'; END IF;
  v_new := v_src;

  IF position($old$  v_ok boolean; v_note text; v_n int; v_sev text;$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'drill DECLARE block not found';
  END IF;
  v_new := replace(v_new,
$old$  v_ok boolean; v_note text; v_n int; v_sev text;$old$,
$old$  v_ok boolean; v_note text; v_n int; v_sev text;
  v_unarmed text[] := '{}'; v_silent text[] := '{}';$old$);

  IF position($old$  SET LOCAL statement_timeout = '110s';
  SET LOCAL lock_timeout = '4s';$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'drill SET LOCAL block not found';
  END IF;
  v_new := replace(v_new,
$old$  SET LOCAL statement_timeout = '110s';
  SET LOCAL lock_timeout = '4s';$old$,
$old$  SET LOCAL statement_timeout = '110s';
  SET LOCAL lock_timeout = '4s';
  -- THE DRILL ARMS ITSELF EVEN DURING THE MAINTENANCE BREAK. Transaction
  -- local, and every arm below unwinds; nothing outside this transaction
  -- can see it.
  PERFORM set_config('app.freeze_bypass', 'on', true);$old$);

  IF position($old$  IF cardinality(v_failing) > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_alarm_drill', 'unknown', 'critical',
      'alarm-drill-failed:' || to_char(now(), 'YYYY-MM-DD'),
      cardinality(v_failing), NULL, NULL, 'reporting', 'ca_alarm_drills',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'THE ALARM DRILL FAILED: ' || array_to_string(v_failing, ', ')
        || ' stayed silent when their drift condition was created. The detectors need repair before anything else.',
      true, jsonb_build_object('failing', v_failing));
  END IF;$old$ IN v_new) = 0 THEN
    RAISE EXCEPTION 'drill verdict block not found';
  END IF;
  v_new := replace(v_new,
$old$  IF cardinality(v_failing) > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_alarm_drill', 'unknown', 'critical',
      'alarm-drill-failed:' || to_char(now(), 'YYYY-MM-DD'),
      cardinality(v_failing), NULL, NULL, 'reporting', 'ca_alarm_drills',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'THE ALARM DRILL FAILED: ' || array_to_string(v_failing, ', ')
        || ' stayed silent when their drift condition was created. The detectors need repair before anything else.',
      true, jsonb_build_object('failing', v_failing));
  END IF;$old$,
$old$  /* A DRILL THAT COULD NOT ARM IS NOT A SILENT DETECTOR. An arm that
     threw carries the error in its note and never reached its assertion;
     an arm that ran and found nothing has an empty note. Those are two
     different findings and only the second one is about a detector. */
  SELECT COALESCE(array_agg(r->>'check' ORDER BY r->>'check'), '{}')
    INTO v_unarmed
    FROM jsonb_array_elements(v_results) r
   WHERE COALESCE((r->>'pass')::boolean, false) IS NOT TRUE
     AND COALESCE(r->>'note', '') <> '';

  SELECT COALESCE(array_agg(r->>'check' ORDER BY r->>'check'), '{}')
    INTO v_silent
    FROM jsonb_array_elements(v_results) r
   WHERE COALESCE((r->>'pass')::boolean, false) IS NOT TRUE
     AND COALESCE(r->>'note', '') = '';

  IF cardinality(v_silent) > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_alarm_drill', 'unknown', 'critical',
      'alarm-drill-failed:' || to_char(now(), 'YYYY-MM-DD'),
      cardinality(v_silent), NULL, NULL, 'reporting', 'ca_alarm_drills',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'THE ALARM DRILL FAILED: ' || array_to_string(v_silent, ', ')
        || ' stayed silent when their drift condition was created. The detectors need repair before anything else.',
      true, jsonb_build_object('failing', v_silent, 'results', v_results));
  END IF;

  IF cardinality(v_unarmed) > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_alarm_drill', 'unknown', 'warning',
      'alarm-drill-unarmed:' || to_char(now(), 'YYYY-MM-DD'),
      cardinality(v_unarmed), NULL, NULL, 'reporting', 'ca_alarm_drills',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'THE ALARM DRILL COULD NOT ARM: ' || array_to_string(v_unarmed, ', ')
        || ' threw before their drift condition existed, so their detectors were never called and nothing was proven either way. Read the note on each arm in ca_alarm_drills. This is a defect in the drill, not evidence about the detectors.',
      true, jsonb_build_object('unarmed', v_unarmed, 'results', v_results));
  END IF;$old$);

  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_alarm_drill';
  IF position($chk$set_config('app.freeze_bypass', 'on', true)$chk$ IN v_src) = 0
     OR position('COULD NOT ARM' IN v_src) = 0
     OR position('v_silent' IN v_src) = 0 THEN
    RAISE EXCEPTION 'fn_ca_alarm_drill did not take the arming fix';
  END IF;

  /* The drill must not depend on the bypass working, either: move it off the
     hour boundary the freeze owns. */
  BEGIN
    UPDATE cron.job SET schedule = '7 11 * * 1'
     WHERE command ILIKE '%fn_ca_alarm_drill%' AND schedule = '0 11 * * 1';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'could not reschedule the alarm drill off the hour boundary: %', SQLERRM;
  END;
END
$mig$;
