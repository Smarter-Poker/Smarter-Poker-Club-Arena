/* TWO FAULTS IN THE MACHINERY INSTALLED EARLIER TODAY, FOUND BY EXERCISING IT.

   1. A RUN THAT MEASURED NOTHING IS NOT A READING. fn_ca_trial_balance
      returns a NULL difference for every account whenever the window it is
      asked about does not span two account snapshots, which is most of the
      time between snapshots. The persistence rule added an hour ago recorded
      that empty result as a reading, so the next real reading would find an
      empty predecessor, see no previous difference for the account, and file
      nothing. Two real readings in a row would never be adjacent. The rule
      would have made the watch blind rather than quiet - the worst possible
      outcome for a detector and exactly the fault this session exists to end.
      A run that measured nothing now records nothing.

   2. ran_at DEFAULTED TO now(), WHICH IS THE TRANSACTION START. Two runs
      inside one transaction were stamped with the same instant, so the
      "second most recent run" the resolver looks for could be the same
      observation twice. That is the same defect as chip_ledger.created_at
      being a transaction start, which is the root of half the meter bugs
      fixed this week. clock_timestamp() advances within a transaction. */

DO $ddl$
DECLARE i int;
BEGIN
  FOR i IN 1..25 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      ALTER TABLE public.ca_detector_runs ALTER COLUMN ran_at SET DEFAULT clock_timestamp();
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END
$ddl$;

DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_trial_balance_watch';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_trial_balance_watch is gone'; END IF;
  IF position($chk$v_measured$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'the watch already refuses to record an empty reading';
  END IF;
  IF position($chk$  INSERT INTO public.ca_detector_runs (detector, detail)
  VALUES ('fn_ca_trial_balance_watch',$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the reading record moved; re-read it before editing';
  END IF;

  v_new := replace(v_src,
$old$  v_prev_d numeric;
  v_thr    numeric := COALESCE(p_threshold, 100);$old$,
$new$  v_prev_d numeric;
  v_thr    numeric := COALESCE(p_threshold, 100);
  v_measured integer := 0;$new$);

  v_new := replace(v_new,
$old$    v_this := v_this || jsonb_build_object(r.account, round(r.difference, 2));$old$,
$new$    v_this := v_this || jsonb_build_object(r.account, round(r.difference, 2));
    v_measured := v_measured + 1;$new$);

  v_new := replace(v_new,
$old$  INSERT INTO public.ca_detector_runs (detector, detail)
  VALUES ('fn_ca_trial_balance_watch',
          jsonb_build_object('differences', v_this, 'filed', v_filed, 'threshold', v_thr));$old$,
$new$  /* A RUN THAT MEASURED NOTHING IS NOT A READING (2026-09-09). Between
     account snapshots every difference comes back NULL, and recording that
     emptiness as a reading would put a blank predecessor in front of the next
     real one - so two genuine readings could never be adjacent and the
     persistence rule would silence the watch instead of steadying it. */
  IF v_measured > 0 THEN
    INSERT INTO public.ca_detector_runs (detector, detail)
    VALUES ('fn_ca_trial_balance_watch',
            jsonb_build_object('differences', v_this, 'filed', v_filed,
                               'threshold', v_thr, 'accounts_measured', v_measured));
  END IF;$new$);

  IF v_new = v_src THEN RAISE EXCEPTION 'the watch was not changed'; END IF;
  EXECUTE v_new;

  -- The empty rows written while the fault was live are not readings either.
  DELETE FROM public.ca_detector_runs
   WHERE detector = 'fn_ca_trial_balance_watch'
     AND COALESCE(detail->'differences', '{}'::jsonb) = '{}'::jsonb;

  IF (SELECT position($chk$IF v_measured > 0 THEN$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_trial_balance_watch') = 0 THEN
    RAISE EXCEPTION 'the watch did not learn to skip an empty reading';
  END IF;
  IF (SELECT count(*) FROM public.ca_detector_runs WHERE detector='fn_ca_trial_balance_watch') <> 0 THEN
    RAISE EXCEPTION 'the empty readings were not cleared';
  END IF;
END
$mig$;;
