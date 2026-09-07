-- ONE BAD PERIOD DOES NOT STOP A CLUB BEING PAID
-- =============================================================================
-- PHASE 5 of 8, part 5 - resilience, found by a deadlock in the probe.
--
-- The third probe run died with a bare `deadlock detected`. Nothing was wrong
-- with the batch's logic; fn_debit_treasury takes `SELECT ... FROM clubs FOR
-- UPDATE` on the club row, and the union settlement cascade, the tournament
-- settler and the engine's own rakeback settler all touch the same row. Two
-- sessions took the same locks in different orders, and Postgres shot one.
--
-- But the probe was not the lesson. THE LESSON IS WHAT WOULD HAVE HAPPENED IN
-- PRODUCTION: the deadlock propagated out of fn_close_settlement_period,
-- through the loop, and aborted fn_settle_club_rakeback_batch entirely. One
-- period, on one club, on one unlucky interleaving, and every remaining player
-- in that batch goes unpaid - and the caller sees an exception rather than a
-- report. That is precisely the shape of the failure this whole phase exists to
-- remove: a drain that stops and does not say so.
--
-- Phase 1 already settled the house answer for this on the union cascade
-- (20260907162037): retry a deadlock, name what it hit, and never let one
-- participant's bad luck end the run. Same answer here.
--
--   - Each period is closed inside its own exception block. A deadlock or a
--     lock timeout is retried twice, with the retry counted; anything else is
--     recorded against the period as its deferral reason and the loop moves on.
--   - A period that fails is never marked paid, so nothing is lost - it is
--     simply attempted again on the next pass, which is what a bounded,
--     resumable drain is for.
--   - The batch always returns a report. `errors` in that report is the number
--     a person should look at.
--
-- Postgres cannot retry a subtransaction's deadlock in place - the whole
-- subtransaction is aborted - so the retry re-enters fn_close_settlement_period
-- from the start. That is safe because the function is idempotent: it re-reads
-- the period FOR UPDATE, and a period already marked paid returns `skipped`.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_settle_club_rakeback_batch(
  p_club_id uuid,
  p_max_periods integer DEFAULT 40,
  p_budget_seconds numeric DEFAULT 4.0,
  p_max_warm_days integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_period     record;
  v_day        record;
  v_res        jsonb;
  v_settled    int := 0;
  v_deferred   int := 0;
  v_errors     int := 0;
  v_retries    int := 0;
  v_warmed     int := 0;
  v_total      numeric := 0;
  v_reasons    jsonb := '{}'::jsonb;
  v_reason     text;
  v_remaining  int;
  v_budget     numeric;
  v_elapsed    numeric;
  v_treasury   numeric;
  v_smallest   numeric;
  v_owed       numeric;
  v_attempt    int;
  v_sqlstate   text;
  v_err        text;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_club_id required');
  END IF;

  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL
          OR (NOT public.fn_is_platform_admin()
              AND NOT EXISTS (SELECT 1 FROM public.clubs c
                               WHERE c.id = p_club_id AND c.owner_id = auth.uid()))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorised');
  END IF;

  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
      'periods_settled', 0, 'total_payout', 0, 'deferred', 0, 'errors', 0,
      'note', 'platform_frozen', 'clock_ran_out', false);
  END IF;

  v_budget := GREATEST(COALESCE(p_budget_seconds, 4.0), 0.5);
  IF p_max_periods IS NULL OR p_max_periods < 1 THEN p_max_periods := 40; END IF;

  SELECT count(*), COALESCE(min(NULLIF(COALESCE(rakeback_amount, rakeback_earned, 0), 0)), 0),
         COALESCE(sum(COALESCE(rakeback_amount, rakeback_earned, 0)), 0)
    INTO v_remaining, v_smallest, v_owed
    FROM public.rakeback_periods
   WHERE club_id = p_club_id AND status = 'pending' AND period_end < CURRENT_DATE;

  IF v_remaining = 0 THEN
    RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
      'periods_settled', 0, 'total_payout', 0, 'deferred', 0, 'errors', 0,
      'periods_remaining', 0, 'note', 'nothing due', 'clock_ran_out', false);
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM public.clubs WHERE id = p_club_id;
  IF v_treasury < v_smallest THEN
    UPDATE public.rakeback_periods
       SET deferred_reason = 'insufficient_club_treasury',
           deferred_at = NOW(), defer_count = defer_count + 1
     WHERE club_id = p_club_id AND status = 'pending' AND period_end < CURRENT_DATE
       AND deferred_reason IS DISTINCT FROM 'insufficient_club_treasury';

    RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
      'periods_settled', 0, 'total_payout', 0, 'errors', 0,
      'deferred', v_remaining,
      'deferred_reasons', jsonb_build_object('insufficient_club_treasury', v_remaining),
      'periods_remaining', v_remaining,
      'treasury', round(v_treasury, 2), 'owed', round(v_owed, 2),
      'shortfall', round(v_owed - v_treasury, 2),
      'note', 'club cannot fund its smallest pending payout',
      'elapsed_seconds', round(extract(epoch FROM (clock_timestamp() - v_started))::numeric, 3),
      'clock_ran_out', false);
  END IF;

  FOR v_day IN
    SELECT DISTINCT d::date AS day
      FROM public.rakeback_periods rp
      CROSS JOIN LATERAL generate_series(rp.period_start, rp.period_end, interval '1 day') d
     WHERE rp.club_id = p_club_id
       AND rp.status = 'pending'
       AND rp.period_end < CURRENT_DATE
       AND NOT EXISTS (SELECT 1 FROM public.rakeback_daily_state s
                        WHERE s.club_id = p_club_id AND s.day = d::date)
     ORDER BY 1
     LIMIT GREATEST(COALESCE(p_max_warm_days, 2), 0)
  LOOP
    EXIT WHEN extract(epoch FROM (clock_timestamp() - v_started)) > v_budget * 0.6;
    BEGIN
      PERFORM public.fn_rakeback_recompute_day(p_club_id, v_day.day, false);
      v_warmed := v_warmed + 1;
    EXCEPTION WHEN OTHERS THEN
      -- A day that will not roll up is not a reason to skip paying the
      -- periods that do. The payer falls back to the direct scan.
      v_errors := v_errors + 1;
    END;
  END LOOP;

  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE club_id = p_club_id AND status = 'pending'
       AND period_end < CURRENT_DATE
     ORDER BY period_end, id
     LIMIT p_max_periods
  LOOP
    EXIT WHEN extract(epoch FROM (clock_timestamp() - v_started)) > v_budget;

    v_attempt := 0;
    LOOP
      v_attempt := v_attempt + 1;
      BEGIN
        v_res := public.fn_close_settlement_period(v_period.id);
        EXIT;                                   -- closed, or refused cleanly
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
        -- 40P01 deadlock_detected, 55P03 lock_not_available, 40001 serialization
        IF v_sqlstate IN ('40P01','55P03','40001') AND v_attempt < 3 THEN
          v_retries := v_retries + 1;
          PERFORM pg_sleep(0.05 * v_attempt);
          CONTINUE;                              -- the period is untouched; try again
        END IF;
        v_res := jsonb_build_object('success', false,
                   'deferred', 'error_' || v_sqlstate,
                   'detail', left(v_err, 200));
        v_errors := v_errors + 1;
        BEGIN
          UPDATE public.rakeback_periods
             SET deferred_reason = 'error_' || v_sqlstate,
                 deferred_at = NOW(), defer_count = defer_count + 1
           WHERE id = v_period.id;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        EXIT;
      END;
    END LOOP;

    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_settled := v_settled + 1;
      v_total   := v_total + COALESCE((v_res->>'payout')::numeric, 0);
    ELSE
      v_deferred := v_deferred + 1;
      v_reason   := COALESCE(v_res->>'deferred', v_res->>'error', 'unknown');
      v_reasons  := jsonb_set(v_reasons, ARRAY[v_reason],
                      to_jsonb(COALESCE((v_reasons->>v_reason)::int, 0) + 1), true);
    END IF;
  END LOOP;

  SELECT count(*) INTO v_remaining FROM public.rakeback_periods
   WHERE club_id = p_club_id AND status = 'pending' AND period_end < CURRENT_DATE;

  v_elapsed := round(extract(epoch FROM (clock_timestamp() - v_started))::numeric, 3);

  RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
    'periods_settled', v_settled, 'total_payout', round(v_total, 2),
    'deferred', v_deferred, 'deferred_reasons', v_reasons,
    'errors', v_errors, 'lock_retries', v_retries,
    'days_warmed', v_warmed, 'periods_remaining', v_remaining,
    'treasury', round(v_treasury, 2),
    'elapsed_seconds', v_elapsed,
    'clock_ran_out', v_elapsed > v_budget);
END;
$function$;

COMMENT ON FUNCTION public.fn_settle_club_rakeback_batch(uuid, integer, numeric, integer) IS
  'Settles at most p_max_periods rakeback periods for one club and stops at p_budget_seconds of wall clock, so it always returns inside the 8s statement_timeout every server-side role carries. Refuses cheaply before doing the work: freeze, then club membership, then whether the treasury can cover the period''s own estimate. Warms uncomputed rollup days first. A deadlock or lock timeout on one period is retried twice and then recorded against that period; one bad period never ends the run. Reports what remains and why. Call it again to continue.';

DO $assert$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_settle_club_rakeback_batch' AND pronamespace='public'::regnamespace;
  IF v_src NOT LIKE '%40P01%' THEN
    RAISE EXCEPTION 'the drain still dies on a deadlock';
  END IF;
  IF v_src NOT LIKE '%lock_retries%' THEN
    RAISE EXCEPTION 'the drain does not report what it retried';
  END IF;
  IF v_src NOT LIKE '%cannot fund its smallest pending payout%'
     OR v_src NOT LIKE '%fn_is_platform_admin%'
     OR v_src NOT LIKE '%fn_rakeback_recompute_day%' THEN
    RAISE EXCEPTION 'the rewrite lost the treasury pre-flight, the admin arm or the rollup warming';
  END IF;
END
$assert$;

COMMIT;
