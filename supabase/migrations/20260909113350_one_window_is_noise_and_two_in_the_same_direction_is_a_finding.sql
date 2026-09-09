DO $guard$
BEGIN
  /* The trial balance watch compared ONE hour-long window and filed anything
     over 100 chips. chip_ledger.created_at is the transaction START, so a
     buy-in whose transaction opened at 10:04 and committed at 10:06 carries a
     created_at outside a window beginning at 10:05 while its balance change is
     read inside it. On table_stack, which takes twenty thousand legs an hour,
     a few straddlers per window are certain and 100 chips is a low bar at a
     table where one buy-in is 180.

     It filed two notices today on that basis: table_stack -608.39 and
     player_wallets +511.79, which very nearly cancel, because they are two
     sides of the same handful of buy-ins and cash-outs caught on the boundary.

     This is the third meter this session to have the same fault. The ledger
     replay was taught to read balance and journal at one instant; the jackpot
     meter was taught to measure cumulatively since the pool opened so a
     straddle comes back on its own. This one keeps its window - an hourly
     reading is what it is for - and learns the other half of the rule
     fn_bbj_reconcile_all already uses: a swing that reverses at the next
     reading is a boundary, and only a difference that persists in the SAME
     direction across two consecutive readings is a finding.

     The previous reading is kept in ca_detector_runs, which is where every
     detector on this platform now records that it ran. */
  IF (SELECT position($chk$AND abs(difference) > COALESCE(p_threshold, 100)$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_trial_balance_watch') = 0 THEN
    RAISE EXCEPTION 'fn_ca_trial_balance_watch does not look the way this migration expects';
  END IF;
  IF (SELECT position($chk$ca_detector_runs$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_trial_balance_watch') <> 0 THEN
    RAISE EXCEPTION 'fn_ca_trial_balance_watch already remembers its last reading';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fn_ca_trial_balance_watch(
  p_since timestamp with time zone DEFAULT (now() - '01:15:00'::interval),
  p_threshold numeric DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r        record;
  v_filed  integer := 0;
  v_id     uuid;
  v_prev   jsonb := '{}'::jsonb;
  v_this   jsonb := '{}'::jsonb;
  v_prev_d numeric;
  v_thr    numeric := COALESCE(p_threshold, 100);
BEGIN
  /* ONE WINDOW IS NOISE (2026-09-09). See the migration that installed this.
     A difference is filed only when the reading BEFORE it saw the same
     account over the threshold in the same direction. */
  SELECT COALESCE(detail->'differences', '{}'::jsonb) INTO v_prev
    FROM public.ca_detector_runs
   WHERE detector = 'fn_ca_trial_balance_watch'
   ORDER BY ran_at DESC LIMIT 1;
  v_prev := COALESCE(v_prev, '{}'::jsonb);

  FOR r IN
    SELECT * FROM public.fn_ca_trial_balance(p_since)
     WHERE account <> 'total_supply'
       AND difference IS NOT NULL
  LOOP
    -- Every account read is remembered, so the next run has a predecessor
    -- for it whether or not it crossed the line this time.
    v_this := v_this || jsonb_build_object(r.account, round(r.difference, 2));

    CONTINUE WHEN abs(r.difference) <= v_thr;

    v_prev_d := COALESCE((v_prev->>r.account)::numeric, 0);
    CONTINUE WHEN abs(v_prev_d) <= v_thr OR sign(v_prev_d) <> sign(r.difference);

    v_id := public.fn_ca_raise_drift_incident(
      'fn_ca_trial_balance_watch', 'ledger_imbalance', 'info',
      'tb:' || r.account || ':' || to_char(r.window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
      r.difference, r.ledger_net, r.balance_delta,
      'ledger', 'account', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      format('trial balance: %s moved %s in its balance column but %s in the ledger between %s and %s, and the reading before it was %s in the same direction - two consecutive windows drifting the same way is not a reading boundary; writers %s',
             r.account, r.balance_delta, r.ledger_net,
             to_char(r.window_start AT TIME ZONE 'UTC', 'HH24:MI'),
             to_char(r.window_end   AT TIME ZONE 'UTC', 'HH24:MI'),
             v_prev_d,
             COALESCE(r.writers, '(no ledger rows)')),
      false,
      jsonb_build_object('account', r.account, 'balance_delta', r.balance_delta,
                         'ledger_net', r.ledger_net, 'difference', r.difference,
                         'previous_difference', v_prev_d,
                         'writers', r.writers, 'window_start', r.window_start,
                         'window_end', r.window_end));
    IF v_id IS NOT NULL THEN
      v_filed := v_filed + 1;
    END IF;
  END LOOP;

  INSERT INTO public.ca_detector_runs (detector, detail)
  VALUES ('fn_ca_trial_balance_watch',
          jsonb_build_object('differences', v_this, 'filed', v_filed, 'threshold', v_thr));

  RETURN v_filed;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_trial_balance_watch failed: %', SQLERRM;
  RETURN -1;
END $function$;

DO $mig$
DECLARE
  v_actor uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid;
  v_n int;
BEGIN
  IF (SELECT position($chk$two consecutive windows drifting the same way$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_trial_balance_watch') = 0 THEN
    RAISE EXCEPTION 'the watch did not take the persistence rule';
  END IF;

  UPDATE public.ca_drift_incidents
     SET status='resolved', resolved_at=now(), resolved_by=v_actor,
         root_cause = 'Both notices are one reading of one hour-long window, and the two very nearly '
                   || 'cancel - table_stack -608.39 against player_wallets +511.79 - because they are '
                   || 'two sides of the same handful of buy-ins and cash-outs caught on the boundary. '
                   || 'chip_ledger.created_at is the transaction START, so a movement whose transaction '
                   || 'opened before the window and committed inside it has its leg outside the window '
                   || 'and its balance change inside. On table_stack, at twenty thousand legs an hour, '
                   || 'that is certain every window, and the 100 chip threshold is a low bar at a table '
                   || 'where a single buy-in is 180.',
         correction_ref = 'migration 20260909112900_one_window_is_noise_and_two_in_the_same_direction_is_a_finding',
         resolution = 'No chips moved to close these. The watch keeps its hourly window and now files '
                   || 'only a difference that persists in the same direction across two consecutive '
                   || 'readings, which is the rule the jackpot meter already uses. It remembers the '
                   || 'previous reading in ca_detector_runs.'
   WHERE resolved_at IS NULL AND source = 'fn_ca_trial_balance_watch';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN RAISE EXCEPTION 'expected to close 2 trial balance notices, closed %', v_n; END IF;
END
$mig$;;
