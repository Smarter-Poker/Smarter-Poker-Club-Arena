DO $mig$
DECLARE v_src text; v_new text; v_n int;
BEGIN
  SET LOCAL lock_timeout = '4s';
  SET LOCAL statement_timeout = '110s';

  /* =================================================================== */
  /* THE SETTLEMENT WARMS ITS OWN CACHE BEFORE IT TAKES A TREASURY LOCK. */
  /*                                                                     */
  /* An hour ago I gave the union rake rollup a daily cron job, because   */
  /* nothing had ever maintained it. The repository refused the push:     */
  /*                                                                     */
  /*   [check-no-new-band-aids] BLOCKED - this is a band-aid (10.12)      */
  /*     cron job: union-rake-rollup-catchup-daily                        */
  /*                                                                     */
  /* It is right. The reason the cache mattered at all is named in the    */
  /* governance check's own words: "the weekly settlement would recompute */
  /* them while holding treasury locks". That is a statement about ONE    */
  /* caller at ONE moment, and the fix belongs there - not on a schedule  */
  /* that runs whether or not anybody needs it, and that would go on      */
  /* running long after somebody forgets why.                             */
  /*                                                                     */
  /* So the cascade warms the days it is about to read, before it takes   */
  /* the first lock, and the job is gone. If the refresh fails the        */
  /* settlement carries on: a stale day is recomputed live and correct,   */
  /* which is what the cache was ever a shortcut for.                      */
  /*                                                                     */
  /* The whole-cents fix and the seven-day backfill from that migration   */
  /* stand; only the schedule is withdrawn.                                */
  /* =================================================================== */
  BEGIN
    PERFORM cron.unschedule('union-rake-rollup-catchup-daily');
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'union-rake-rollup-catchup-daily was already gone: %', SQLERRM;
  END;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_union_settlement_cascade';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_union_settlement_cascade not found'; END IF;

  IF position($old$  -- ROUND 1 - union rake treasury pays the clubs their 90%.$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the round 1 anchor was not found';
  END IF;
  v_new := replace(v_src,
$old$  -- ROUND 1 - union rake treasury pays the clubs their 90%.$old$,
$old$  /* WARM THE CACHE BEFORE THE FIRST LOCK (2026-09-09). union_rake_rollup_days
     is a speed cache: a day that is missing is recomputed live and correct,
     but it is recomputed INSIDE the settlement, while it holds treasury rows -
     which is where this union has been deadlocking. Doing it here costs the
     same work at a moment when nothing is locked. A failure is not fatal:
     the live path still answers, just more slowly. */
  BEGIN
    PERFORM public.fn_union_rake_rollup_refresh_day(p_union_id, g.d::date)
       FROM generate_series(v_from::date, (v_to - interval '1 day')::date, interval '1 day') g(d)
      WHERE NOT EXISTS (SELECT 1 FROM public.union_rake_rollup_days rd
                         WHERE rd.union_id = p_union_id AND rd.day = g.d::date)
        AND g.d::date < (now() AT TIME ZONE 'UTC')::date;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'settlement could not warm the rake rollup (%); the live path will answer instead', SQLERRM;
  END;

  -- ROUND 1 - union rake treasury pays the clubs their 90%.$old$);
  EXECUTE v_new;

  /* the sweep is not a browser's to call, either */
  REVOKE ALL ON FUNCTION public.fn_ca_return_unawarded_spin_draws(boolean, integer) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.fn_ca_return_unawarded_spin_draws(boolean, integer) TO service_role;

  /* -------- post-apply -------- */
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'union-rake-rollup-catchup-daily';
  IF v_n <> 0 THEN RAISE EXCEPTION 'the catch-up job is still scheduled'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_union_settlement_cascade';
  IF position('WARM THE CACHE BEFORE THE FIRST LOCK' IN v_src) = 0 THEN
    RAISE EXCEPTION 'the cascade did not take the warm-up';
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_return_unawarded_spin_draws'
         AND (has_function_privilege('anon', p.oid, 'EXECUTE')
              OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) <> 0 THEN
    RAISE EXCEPTION 'fn_ca_return_unawarded_spin_draws is still reachable from a browser role';
  END IF;
END
$mig$;
