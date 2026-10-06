-- 20261003135514_two_windows_are_a_boundary_three_are_a_drift.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- TWO WINDOWS ARE A BOUNDARY, THREE ARE A DRIFT (phase 6 of 9: money edges).
-- Full account: docs/changelog/2026-10-03-two-windows-are-a-boundary-three-are-a-drift.md.
--
-- fn_ca_trial_balance_watch filed two info incidents for the window
-- 01:05-02:05 on 2026-10-03: player_wallets -169.50 (the reading before,
-- -105.00) and tournament_liability +182.00 (before, +107.00). Read from
-- production: over the 31 hourly readings from 2026-10-02 07:20 to
-- 2026-10-03 13:20, every difference on both accounts sums to exactly 0.00.
-- The next reading reversed (+131.00 and -130.00). A leg is windowed by its
-- stamp and a balance by the snapshot that first sees it, so a movement
-- split across a cut reads +x then -x, and a run of them can lean one way
-- for two windows. No chip was lost.
--
-- A drift is now filed only after three consecutive readings over the
-- threshold in the same direction. Of the 24 readings the two-window rule
-- fired on over fourteen days, a third reading confirms 3; the other 21
-- reversed. Everything else in the function is the live text unchanged.
-- Refuses to run if the function is not the text measured or its grants
-- differ. No job is added. No chips move.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_trial_balance_watch(timestamp with time zone,numeric)'::regprocedure)) = '8b7943c6499f505c8d30d7ece01a9ef6')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_trial_balance_watch(timestamp with time zone,numeric)'::regprocedure)) IS DISTINCT FROM 'ca853ed6b8fea0121f2662fa75cf1ce2' THEN
    RAISE EXCEPTION 'TRIAL_BALANCE_WATCH_PREIMAGE_CHANGED';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_trial_balance_watch(timestamp with time zone,numeric)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'TRIAL_BALANCE_WATCH_AUTHORITY_CHANGED';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_ca_trial_balance_watch(p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_threshold numeric DEFAULT 100)
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
  v_prev2   jsonb := '{}'::jsonb;
  v_prev2_d numeric;
  v_thr    numeric := COALESCE(p_threshold, 100);
  v_measured integer := 0;
BEGIN
  /* ONE WINDOW IS NOISE (2026-09-09). See the migration that installed this.
     A difference is filed only when the reading BEFORE it saw the same
     account over the threshold in the same direction.

     TWO WINDOWS ARE A BOUNDARY, THREE ARE A DRIFT (2026-10-03). A leg is
     windowed by its stamp and a balance by the snapshot that first sees it,
     so a movement whose leg and balance land on either side of a cut shows
     as +x in one window and -x in the next, and a run of such movements
     can lean the same way for two windows before it reverses. Over the 31
     readings from 2026-10-02 07:20 to 2026-10-03 13:20 every difference on
     player_wallets and tournament_liability summed to exactly 0.00, yet the
     two-window rule filed both (01:05-02:05 on 2026-10-03). Of the 24
     readings the two-window rule fired on over fourteen days, a third
     reading confirms 3; the other 21 reversed. A real leak does not reverse, so it now has to hold
     for three consecutive readings, same direction, each over the line. */
  SELECT COALESCE(x.detail->'differences', '{}'::jsonb) INTO v_prev
    FROM (SELECT detail FROM public.ca_detector_runs
           WHERE detector = 'fn_ca_trial_balance_watch'
           ORDER BY ran_at DESC LIMIT 1) x;
  SELECT COALESCE(x.detail->'differences', '{}'::jsonb) INTO v_prev2
    FROM (SELECT detail FROM public.ca_detector_runs
           WHERE detector = 'fn_ca_trial_balance_watch'
           ORDER BY ran_at DESC OFFSET 1 LIMIT 1) x;
  v_prev := COALESCE(v_prev, '{}'::jsonb);
  v_prev2 := COALESCE(v_prev2, '{}'::jsonb);

  FOR r IN
    SELECT * FROM public.fn_ca_trial_balance(p_since)
     WHERE account <> 'total_supply'
       AND difference IS NOT NULL
  LOOP
    -- Every account read is remembered, so the next run has a predecessor
    -- for it whether or not it crossed the line this time.
    v_this := v_this || jsonb_build_object(r.account, round(r.difference, 2));
    v_measured := v_measured + 1;

    CONTINUE WHEN abs(r.difference) <= v_thr;

    v_prev_d := COALESCE((v_prev->>r.account)::numeric, 0);
    CONTINUE WHEN abs(v_prev_d) <= v_thr OR sign(v_prev_d) <> sign(r.difference);
    v_prev2_d := COALESCE((v_prev2->>r.account)::numeric, 0);
    CONTINUE WHEN abs(v_prev2_d) <= v_thr OR sign(v_prev2_d) <> sign(r.difference);

    v_id := public.fn_ca_raise_drift_incident(
      'fn_ca_trial_balance_watch', 'ledger_imbalance', 'info',
      'tb:' || r.account || ':' || to_char(r.window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
      r.difference, r.ledger_net, r.balance_delta,
      'ledger', 'account', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      format('trial balance: %s moved %s in its balance column but %s in the ledger between %s and %s, and the two readings before it were %s and %s in the same direction - three consecutive windows drifting the same way is not a reading boundary; writers %s',
             r.account, r.balance_delta, r.ledger_net,
             to_char(r.window_start AT TIME ZONE 'UTC', 'HH24:MI'),
             to_char(r.window_end   AT TIME ZONE 'UTC', 'HH24:MI'),
             v_prev2_d, v_prev_d,
             COALESCE(r.writers, '(no ledger rows)')),
      false,
      jsonb_build_object('account', r.account, 'balance_delta', r.balance_delta,
                         'ledger_net', r.ledger_net, 'difference', r.difference,
                         'previous_difference', v_prev_d,
                         'difference_before_that', v_prev2_d,
                         'writers', r.writers, 'window_start', r.window_start,
                         'window_end', r.window_end));
    IF v_id IS NOT NULL THEN
      v_filed := v_filed + 1;
    END IF;
  END LOOP;

  /* A RUN THAT MEASURED NOTHING IS NOT A READING (2026-09-09). Between
     account snapshots every difference comes back NULL, and recording that
     emptiness as a reading would put a blank predecessor in front of the next
     real one - so two genuine readings could never be adjacent and the
     persistence rule would silence the watch instead of steadying it. */
  IF v_measured > 0 THEN
    INSERT INTO public.ca_detector_runs (detector, detail)
    VALUES ('fn_ca_trial_balance_watch',
            jsonb_build_object('differences', v_this, 'filed', v_filed,
                               'threshold', v_thr, 'accounts_measured', v_measured));
  END IF;

  RETURN v_filed;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_trial_balance_watch failed: %', SQLERRM;
  RETURN -1;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_trial_balance_watch(timestamp with time zone, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_trial_balance_watch(timestamp with time zone, numeric) TO service_role;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_trial_balance_watch(timestamp with time zone,numeric)'::regprocedure)) IS DISTINCT FROM '8b7943c6499f505c8d30d7ece01a9ef6'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_ca_trial_balance_watch(timestamp with time zone,numeric)'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'TRIAL_BALANCE_WATCH_RESULT_CHANGED';
  END IF;
END
$post$;

COMMIT;
