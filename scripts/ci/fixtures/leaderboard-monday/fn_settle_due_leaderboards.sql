CREATE OR REPLACE FUNCTION public.fn_settle_due_leaderboards()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_candidate record;
  v_plan jsonb;
  v_result jsonb;
  v_end date;
  v_error_message text;
  v_error_code text;
  v_settled integer := 0;
  v_failed integer := 0;
  v_skipped_disabled integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('settle-due-leaderboards')) THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'Already Running');
  END IF;

  FOR v_candidate IN
    WITH latest_closed AS MATERIALIZED (
      SELECT 'weekly'::text AS period, bounds.start_date AS period_start
      FROM public.fn_leaderboard_period_window('weekly', -1) bounds
      UNION ALL
      SELECT 'monthly'::text, bounds.start_date
      FROM public.fn_leaderboard_period_window('monthly', -1) bounds
    ), first_effective AS MATERIALIZED (
      SELECT program.club_id, 'weekly'::text AS period,
             min(program.weekly_effective_from) AS period_start
      FROM public.leaderboard_reward_program_versions program
      GROUP BY program.club_id
      UNION ALL
      SELECT program.club_id, 'monthly'::text,
             min(program.monthly_effective_from)
      FROM public.leaderboard_reward_program_versions program
      GROUP BY program.club_id
    ), due AS (
      SELECT first_effective.club_id, first_effective.period,
             generated.period_start::date AS period_start
      FROM first_effective
      JOIN latest_closed USING (period)
      CROSS JOIN LATERAL generate_series(
        first_effective.period_start::timestamp,
        latest_closed.period_start::timestamp,
        CASE first_effective.period
          WHEN 'weekly' THEN interval '7 days'
          ELSE interval '1 month'
        END
      ) generated(period_start)
    )
    SELECT due.club_id, due.period, due.period_start
    FROM due
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.leaderboard_payout_batches batch
      WHERE batch.club_id = due.club_id
        AND batch.period = due.period
        AND batch.period_start = due.period_start
    )
    ORDER BY due.period_start, due.club_id, due.period
  LOOP
    BEGIN
      v_plan := public.fn_get_leaderboard_reward_plan(
        v_candidate.club_id,
        v_candidate.period,
        v_candidate.period_start
      );

      IF v_plan IS NULL
         OR NOT COALESCE((v_plan ->> 'rewards_enabled')::boolean, false) THEN
        v_skipped_disabled := v_skipped_disabled + 1;
        CONTINUE;
      END IF;

      v_end := CASE v_candidate.period
        WHEN 'weekly' THEN v_candidate.period_start + 7
        ELSE (v_candidate.period_start + interval '1 month')::date
      END;

      v_result := public.fn_payout_leaderboard(
        v_candidate.club_id,
        v_candidate.period,
        v_plan ->> 'payout_metric',
        v_candidate.period_start::timestamp AT TIME ZONE 'UTC',
        v_end::timestamp AT TIME ZONE 'UTC'
      );
      v_settled := v_settled + CASE
        WHEN COALESCE((v_result ->> 'already_settled')::boolean, false) THEN 0
        ELSE 1
      END;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
      v_error_code := CASE
        WHEN v_error_message LIKE 'LEADERBOARD_PROMO_UNDERFUNDED|%' THEN 'promo_wallet_underfunded'
        WHEN v_error_message LIKE 'LEADERBOARD_PROMO_WALLET_MISSING|%' THEN 'promo_wallet_missing'
        WHEN v_error_message LIKE 'LEADERBOARD_PROGRAM_INVALID|%' THEN 'program_invalid'
        WHEN v_error_message LIKE 'LEADERBOARD_CREDIT_CONFLICT|%' THEN 'credit_conflict'
        ELSE 'settlement_error'
      END;
      v_error_message := regexp_replace(v_error_message, '^LEADERBOARD_[A-Z_]+\\|', '');
      v_failed := v_failed + 1;

      INSERT INTO public.leaderboard_payout_failures (
        club_id, period, period_start, error_message, error_code,
        failed_at, first_failed_at, attempt_count, resolved_at, resolution
      ) VALUES (
        v_candidate.club_id, v_candidate.period, v_candidate.period_start,
        left(v_error_message, 500), v_error_code, now(), now(), 1, NULL, NULL
      )
      ON CONFLICT (club_id, period, period_start) DO UPDATE
        SET error_message = EXCLUDED.error_message,
            error_code = EXCLUDED.error_code,
            failed_at = now(),
            attempt_count = public.leaderboard_payout_failures.attempt_count + 1,
            resolved_at = NULL,
            resolution = NULL;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', v_failed = 0,
    'settled', v_settled,
    'failed', v_failed,
    'skipped_disabled', v_skipped_disabled
  );
END;
$function$
