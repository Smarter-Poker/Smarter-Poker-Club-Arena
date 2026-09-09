DO $mig$
DECLARE v_src text; v_new text; v_n int; d date;
  c_union constant uuid := 'fade0000-0000-0000-0000-000000000001';
BEGIN
  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '240s';

  /* =================================================================== */
  /* THE RAKE ROLLUP WRITES WHOLE CENTS.                                 */
  /*                                                                     */
  /* Midway Union is missing seven of the last seven days of              */
  /* union_rake_rollup_days, and the reason is not that nothing ran - it  */
  /* is that the writer cannot write:                                     */
  /*                                                                     */
  /*   new row for relation "union_rake_paid_daily_user" violates check   */
  /*   constraint "chk_rake_amount_is_two_decimal_places"                 */
  /*   Failing row contains (..., 45.09450728600516022029)                */
  /*                                                                     */
  /* fn_union_rake_rollup_refresh_day splits each hand's rake across the  */
  /* players by contribution and inserts the raw quotient. Migration      */
  /* 20260907220528 ("money is whole cents") added the cents rule to that */
  /* table and this writer was never taught it, so every refresh since    */
  /* has thrown - silently, because its one caller wraps it in            */
  /* EXCEPTION WHEN OTHERS THEN NULL and computes the day live instead.   */
  /* The cache has been dead for a week and nothing said so; what said so */
  /* was fn_union_governance_check, complaining that the settlement would */
  /* have to do this work inline while holding treasury locks - which is  */
  /* where this union has been deadlocking.                               */
  /*                                                                     */
  /* Rounding each share on its own would lose the day's total, so the    */
  /* residue goes to the largest share: every user is on a whole cent and */
  /* the day still sums to the rake that was actually taken.              */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_union_rake_rollup_refresh_day';
  IF position($old$  SELECT p_union_id, p_day, all_legs.user_id, SUM(all_legs.share)
    FROM all_legs
   GROUP BY all_legs.user_id;$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the rollup insert tail was not found';
  END IF;
  v_new := replace(v_src,
$old$  SELECT p_union_id, p_day, all_legs.user_id, SUM(all_legs.share)
    FROM all_legs
   GROUP BY all_legs.user_id;$old$,
$old$  ,
  per_user AS (
    SELECT all_legs.user_id, SUM(all_legs.share) AS exact
      FROM all_legs GROUP BY all_legs.user_id
  ),
  /* WHOLE CENTS, AND THE DAY STILL ADDS UP (2026-09-09). A share is a
     quotient and carries twenty decimal places; the table takes two. Each
     user is rounded and the rounding residue is given to the largest share,
     so no user holds a fraction of a cent and the day's total is still the
     rake that was taken. */
  ranked AS (
    SELECT pu.user_id, pu.exact, round(pu.exact, 2) AS cents,
           row_number() OVER (ORDER BY pu.exact DESC, pu.user_id) AS rn
      FROM per_user pu
  ),
  day_total AS (
    SELECT round(sum(exact), 2) AS exact_total, sum(cents) AS cents_total FROM ranked
  )
  SELECT p_union_id, p_day, k.user_id,
         k.cents + CASE WHEN k.rn = 1 THEN (t.exact_total - t.cents_total) ELSE 0 END
    FROM ranked k CROSS JOIN day_total t;$old$);
  EXECUTE v_new;

  /* backfill every complete day the cache is missing */
  FOR d IN
    SELECT gs::date
      FROM generate_series((now() AT TIME ZONE 'UTC')::date - 8,
                           (now() AT TIME ZONE 'UTC')::date - 1, interval '1 day') gs
     WHERE NOT EXISTS (SELECT 1 FROM public.union_rake_rollup_days rd
                        WHERE rd.union_id = c_union AND rd.day = gs::date)
     ORDER BY 1
  LOOP
    PERFORM public.fn_union_rake_rollup_refresh_day(c_union, d);
  END LOOP;

  SELECT count(*) INTO v_n
    FROM generate_series((now() AT TIME ZONE 'UTC')::date - 7,
                         (now() AT TIME ZONE 'UTC')::date - 1, interval '1 day') gs
   WHERE NOT EXISTS (SELECT 1 FROM public.union_rake_rollup_days rd
                      WHERE rd.union_id = c_union AND rd.day = gs::date);
  IF v_n > 0 THEN RAISE EXCEPTION '% day(s) of the rake rollup are still missing', v_n; END IF;

  /* WITHDRAWN 2026-09-09. This block scheduled a daily catch-up, and the
     repository refused the push: a schedule that repairs something is a
     band-aid (10.12). The work moved to the one caller that needs it - the
     weekly cascade warms the days it is about to read, before it takes its
     first treasury lock - in the migration
     the_settlement_warms_its_own_cache_before_it_takes_a_treasury_lock. */

  /* =================================================================== */
  /* A PERIOD IS MINTED ON THE WEEK THE UNION ACTUALLY SETTLES ON.       */
  /*                                                                     */
  /* get_current_settlement_period's zero-argument fallback computed      */
  /*   date_trunc('week', now()) - interval '1 day'                       */
  /* a Sunday-to-Sunday week in UTC, while the union settles on           */
  /* fn_union_week_start: Monday, midnight Pacific. Every period that     */
  /* fallback minted had a boundary fn_union_weekly_rakeback_close        */
  /* refuses outright with period_not_closed_union_weeks - unsettleable,  */
  /* and while it sat there as the newest open row it was what this       */
  /* function handed back to every caller. One such period was minted on  */
  /* 2026-08-20 and closed an hour ago, carrying no club, no totals and   */
  /* no reference from any money table. It came back every week.          */
  /* =================================================================== */
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_current_settlement_period'
     AND pg_get_function_identity_arguments(p.oid) = '';
  IF position($old$  v_start := date_trunc('week', v_now) - interval '1 day';
  v_end := v_start + interval '7 days';$old$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the settlement-period fallback week was not found';
  END IF;
  v_new := replace(v_src,
$old$  v_start := date_trunc('week', v_now) - interval '1 day';
  v_end := v_start + interval '7 days';$old$,
$old$  /* THE UNION'S OWN WEEK (2026-09-09). This was a Sunday-to-Sunday UTC
     week; the settlement runs on fn_union_week_start, Monday midnight
     Pacific, and refuses any other boundary with
     period_not_closed_union_weeks. A period minted on the wrong boundary
     can never be settled and blocks the lookup above for everybody. */
  v_start := public.fn_union_week_start(v_now);
  v_end := v_start + interval '7 days';$old$);
  EXECUTE v_new;

  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_current_settlement_period'
     AND pg_get_function_identity_arguments(p.oid) = '';
  IF position('fn_union_week_start(v_now)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'get_current_settlement_period did not take the week fix';
  END IF;

  SELECT count(*) INTO v_n FROM public.fn_union_governance_check();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'the union governance check still reports: %',
      (SELECT string_agg(invariant || ' (' || offenders || ')', ', ') FROM public.fn_union_governance_check());
  END IF;
END
$mig$;
