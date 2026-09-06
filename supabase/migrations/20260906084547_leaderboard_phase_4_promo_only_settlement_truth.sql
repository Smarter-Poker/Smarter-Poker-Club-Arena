-- 20260906084547_leaderboard_phase_4_promo_only_settlement_truth.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- PHASE 4 OF 6: PROMO-ONLY SETTLEMENT TRUTH.
--
-- The payout routine inherited a "promo first, operating wallet second"
-- waterfall. That contradicts the product contract: an affiliated club's
-- leaderboard is paid by its union Promo Wallet, and a standalone club's is
-- paid by its own Promo Wallet. An underfunded Promo Wallet must leave the
-- round unpaid and retryable; it must never silently debit the Club Bank or
-- Union Bank.
--
-- This migration also makes the settlement lifecycle observable without
-- giving a browser money-moving authority. Failed attempts are retained and
-- resolved instead of deleted, each payout receipt points at its immutable
-- batch, and one authenticated read RPC returns the exact program, state,
-- receipts, and owner-safe recovery detail for a canonical period.
--
-- Ties use the standard poker payout rule: tied players split the combined
-- prizes for the places they occupy. Cent residue is assigned deterministically
-- by user id, so the batch total remains exact without using a UUID to break a
-- sporting tie.

BEGIN;

ALTER TABLE public.leaderboard_payout_failures
  ADD COLUMN IF NOT EXISTS error_code text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS first_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution text;

UPDATE public.leaderboard_payout_failures
SET first_failed_at = COALESCE(first_failed_at, failed_at)
WHERE first_failed_at IS NULL;

ALTER TABLE public.leaderboard_payout_failures
  ALTER COLUMN first_failed_at SET DEFAULT now(),
  ALTER COLUMN first_failed_at SET NOT NULL,
  DROP CONSTRAINT IF EXISTS leaderboard_payout_failures_attempt_count_check,
  ADD CONSTRAINT leaderboard_payout_failures_attempt_count_check
    CHECK (attempt_count >= 1),
  DROP CONSTRAINT IF EXISTS leaderboard_payout_failures_error_code_check,
  ADD CONSTRAINT leaderboard_payout_failures_error_code_check
    CHECK (error_code IN (
      'promo_wallet_underfunded',
      'promo_wallet_missing',
      'program_invalid',
      'credit_conflict',
      'settlement_error',
      'not_applicable',
      'unknown'
    ));

ALTER TABLE public.leaderboard_payouts
  ADD COLUMN IF NOT EXISTS batch_id uuid;

UPDATE public.leaderboard_payouts payout
SET batch_id = batch.id
FROM public.leaderboard_payout_batches batch
WHERE payout.batch_id IS NULL
  AND batch.club_id = payout.club_id
  AND batch.period = payout.period
  AND batch.period_start = (payout.start_date AT TIME ZONE 'UTC')::date;

DO $verify_receipt_backfill$
BEGIN
  IF EXISTS (SELECT 1 FROM public.leaderboard_payouts WHERE batch_id IS NULL) THEN
    RAISE EXCEPTION 'Leaderboard Payout Receipt Has No Immutable Batch';
  END IF;
END;
$verify_receipt_backfill$;

ALTER TABLE public.leaderboard_payouts
  ALTER COLUMN batch_id SET NOT NULL,
  DROP CONSTRAINT IF EXISTS leaderboard_payouts_batch_id_fkey,
  ADD CONSTRAINT leaderboard_payouts_batch_id_fkey
    FOREIGN KEY (batch_id) REFERENCES public.leaderboard_payout_batches(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS leaderboard_payouts_batch_user_key,
  ADD CONSTRAINT leaderboard_payouts_batch_user_key UNIQUE (batch_id, user_id);

ALTER TABLE public.leaderboard_payout_batches
  ADD COLUMN IF NOT EXISTS tie_policy text NOT NULL DEFAULT 'split_occupied_places',
  DROP CONSTRAINT IF EXISTS leaderboard_payout_batches_tie_policy_check,
  ADD CONSTRAINT leaderboard_payout_batches_tie_policy_check
    CHECK (tie_policy = 'split_occupied_places'),
  DROP CONSTRAINT IF EXISTS leaderboard_payout_batches_promo_only_check,
  ADD CONSTRAINT leaderboard_payout_batches_promo_only_check
    CHECK (overlay_funded = 0 AND total_paid = seed_funded + promo_funded);

CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(
  p_club_id uuid,
  p_period text,
  p_metric text,
  p_start_date timestamptz,
  p_end_date timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_start date := (p_start_date AT TIME ZONE 'UTC')::date;
  v_end date := (p_end_date AT TIME ZONE 'UTC')::date;
  v_plan jsonb;
  v_existing public.leaderboard_payout_batches%ROWTYPE;
  v_winners jsonb := '[]'::jsonb;
  v_winner jsonb;
  v_total numeric(18,2) := 0;
  v_promo_available numeric(18,2) := 0;
  v_seed_available numeric(18,2) := 0;
  v_seed_debit numeric(18,2) := 0;
  v_seed_release numeric(18,2) := 0;
  v_promo_debit numeric(18,2) := 0;
  v_union_id uuid;
  v_batch_id uuid;
  v_credited boolean;
BEGIN
  IF p_period NOT IN ('weekly', 'monthly') THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Only Weekly And Monthly Leaderboards Can Be Settled';
  END IF;
  IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Leaderboard Settlement Requires A Closed Date Range';
  END IF;
  IF v_end > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|An Open Leaderboard Round Cannot Be Paid';
  END IF;
  IF (p_period = 'weekly' AND (EXTRACT(DOW FROM v_start) <> 0 OR v_end <> v_start + 7))
     OR (p_period = 'monthly' AND (
       EXTRACT(DAY FROM v_start) <> 1
       OR v_end <> (v_start + interval '1 month')::date
     )) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Leaderboard Settlement Must Use A Canonical UTC Round';
  END IF;

  SELECT batch.* INTO v_existing
  FROM public.leaderboard_payout_batches batch
  WHERE batch.club_id = p_club_id
    AND batch.period = p_period
    AND batch.period_start = v_start;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_settled', true,
      'batch_id', v_existing.id,
      'total_paid', v_existing.total_paid,
      'seed_funded', v_existing.seed_funded,
      'promo_funded', v_existing.promo_funded,
      'overlay_funded', v_existing.overlay_funded,
      'winner_count', v_existing.winner_count,
      'tie_policy', v_existing.tie_policy
    );
  END IF;

  v_plan := public.fn_get_leaderboard_reward_plan(p_club_id, p_period, v_start);
  IF v_plan IS NULL OR NOT COALESCE((v_plan ->> 'rewards_enabled')::boolean, false) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|No Paid Leaderboard Program Applies To This Round';
  END IF;
  IF p_metric IS DISTINCT FROM v_plan ->> 'payout_metric' THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Leaderboard Metric Does Not Match The Published Program';
  END IF;

  WITH board AS MATERIALIZED (
    SELECT ranked.user_id, ranked.rank
    FROM public.fn_club_leaderboard_by_dates(
      p_club_id, p_metric, v_start, v_end, 1000000, 0
    ) ranked
    WHERE ranked.qualified
  ), tied AS MATERIALIZED (
    SELECT
      board.user_id,
      board.rank,
      count(*) OVER (PARTITION BY board.rank)::integer AS tie_count,
      row_number() OVER (PARTITION BY board.rank ORDER BY board.user_id)::integer AS tie_order
    FROM board
  ), prizes AS MATERIALIZED (
    SELECT prize.rank, round(prize.amount, 2) AS amount
    FROM jsonb_to_recordset(COALESCE(v_plan -> 'prizes', '[]'::jsonb))
      AS prize(rank integer, amount numeric)
    WHERE prize.amount > 0
  ), pooled AS MATERIALIZED (
    SELECT
      tied.user_id,
      tied.rank,
      tied.tie_count,
      tied.tie_order,
      COALESCE(sum(prizes.amount), 0)::numeric(18,2) AS pool_amount
    FROM tied
    LEFT JOIN prizes
      ON prizes.rank >= tied.rank
     AND prizes.rank < tied.rank + tied.tie_count
    GROUP BY tied.user_id, tied.rank, tied.tie_count, tied.tie_order
  ), winners AS (
    SELECT
      pooled.user_id,
      pooled.rank,
      (
        trunc(pooled.pool_amount / pooled.tie_count, 2)
        + CASE
            WHEN pooled.tie_order <= mod((pooled.pool_amount * 100)::bigint, pooled.tie_count)
              THEN 0.01
            ELSE 0
          END
      )::numeric(18,2) AS amount
    FROM pooled
    WHERE pooled.pool_amount > 0
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'user_id', winners.user_id,
      'rank', winners.rank,
      'amount', winners.amount
    ) ORDER BY winners.rank, winners.user_id), '[]'::jsonb),
    COALESCE(round(sum(winners.amount), 2), 0)
  INTO v_winners, v_total
  FROM winners;

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    v_union_id := (v_plan ->> 'funding_union_id')::uuid;
    SELECT COALESCE(wallet.promo_wallet, 0)
    INTO v_promo_available
    FROM public.union_wallets wallet
    WHERE wallet.union_id = v_union_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LEADERBOARD_PROMO_WALLET_MISSING|Leaderboard Funding Union Has No Promo Wallet';
    END IF;
  ELSE
    SELECT COALESCE(setup.leaderboard_seed_remaining, 0)
    INTO v_seed_available
    FROM public.club_opening_setups setup
    WHERE setup.club_id = p_club_id
    FOR UPDATE;

    SELECT COALESCE(club.promo_balance, 0)
    INTO v_promo_available
    FROM public.clubs club
    WHERE club.id = p_club_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LEADERBOARD_PROMO_WALLET_MISSING|Leaderboard Club Not Found';
    END IF;
  END IF;

  IF v_seed_available + v_promo_available < v_total THEN
    RAISE EXCEPTION
      'LEADERBOARD_PROMO_UNDERFUNDED|Leaderboard Requires % Promo Chips But The Recorded Promo Wallet Holds %',
      v_total,
      v_seed_available + v_promo_available;
  END IF;

  v_seed_debit := LEAST(v_total, v_seed_available);
  v_seed_release := v_seed_available - v_seed_debit;
  v_promo_debit := v_total - v_seed_debit;

  PERFORM set_config('app.ledger_category', 'leaderboard_payout', true);
  PERFORM set_config('app.ledger_counterparty', 'leaderboard_round', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_club_id::text, true);

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    UPDATE public.union_wallets
    SET promo_wallet = promo_wallet - v_promo_debit,
        updated_at = now()
    WHERE union_id = v_union_id;
  ELSE
    UPDATE public.clubs
    SET promo_balance = promo_balance - v_promo_debit + v_seed_release,
        updated_at = now()
    WHERE id = p_club_id;

    UPDATE public.club_opening_setups
    SET leaderboard_seed_remaining = 0,
        updated_at = now()
    WHERE club_id = p_club_id AND leaderboard_seed_remaining > 0;
  END IF;

  INSERT INTO public.leaderboard_payout_batches (
    club_id, period, period_start, period_end, metric,
    program_id, program_version, program_hash,
    funding_owner_type, funding_union_id,
    total_paid, seed_funded, promo_funded, overlay_funded, winner_count, tie_policy
  ) VALUES (
    p_club_id, p_period, v_start, v_end, p_metric,
    (v_plan ->> 'program_id')::uuid,
    (v_plan ->> 'program_version')::integer,
    v_plan ->> 'program_hash',
    v_plan ->> 'funding_owner_type', v_union_id,
    v_total, v_seed_debit, v_promo_debit, 0, jsonb_array_length(v_winners),
    'split_occupied_places'
  ) RETURNING id INTO v_batch_id;

  FOR v_winner IN SELECT value FROM jsonb_array_elements(v_winners)
  LOOP
    v_credited := public.fn_credit_and_log(
      (v_winner ->> 'user_id')::uuid,
      (v_winner ->> 'amount')::numeric,
      format('leaderboard:%s:%s:%s:%s', p_club_id, p_period, v_start, v_winner ->> 'user_id'),
      'leaderboard_payout',
      format('%s Leaderboard, Rank %s', initcap(p_period), v_winner ->> 'rank'),
      (v_plan ->> 'program_id')::uuid
    );
    IF NOT v_credited THEN
      RAISE EXCEPTION 'LEADERBOARD_CREDIT_CONFLICT|Leaderboard Credit Key Already Exists Without A Batch Receipt';
    END IF;

    INSERT INTO public.leaderboard_payouts (
      club_id, period, metric, start_date, end_date, user_id, rank,
      payout_amount, payout_currency, awarded_at, batch_id
    ) VALUES (
      p_club_id, p_period, p_metric, v_start, v_end,
      (v_winner ->> 'user_id')::uuid,
      (v_winner ->> 'rank')::integer,
      (v_winner ->> 'amount')::numeric,
      'chips', now(), v_batch_id
    );
  END LOOP;

  UPDATE public.leaderboard_payout_failures
  SET resolved_at = now(),
      resolution = 'Settlement Completed Automatically'
  WHERE club_id = p_club_id
    AND period = p_period
    AND period_start = v_start
    AND resolved_at IS NULL;

  RETURN jsonb_build_object(
    'success', true,
    'already_settled', false,
    'batch_id', v_batch_id,
    'total_paid', v_total,
    'seed_funded', v_seed_debit,
    'promo_funded', v_promo_debit,
    'overlay_funded', 0,
    'winner_count', jsonb_array_length(v_winners),
    'tie_policy', 'split_occupied_places'
  );
END;
$function$;

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
$function$;

CREATE OR REPLACE FUNCTION public.fn_get_leaderboard_settlement_status(
  p_club_id uuid,
  p_period text,
  p_period_start date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_club record;
  v_is_member boolean := false;
  v_can_manage boolean := false;
  v_is_platform_admin boolean := false;
  v_period_end date;
  v_plan jsonb;
  v_batch public.leaderboard_payout_batches%ROWTYPE;
  v_failure public.leaderboard_payout_failures%ROWTYPE;
  v_receipts jsonb := '[]'::jsonb;
  v_state text;
  v_planned_total numeric(18,2) := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication Required' USING ERRCODE = '42501';
  END IF;
  IF p_period NOT IN ('weekly', 'monthly') OR p_period_start IS NULL THEN
    RAISE EXCEPTION 'A Canonical Weekly Or Monthly Period Is Required' USING ERRCODE = '22023';
  END IF;

  SELECT club.id, club.owner_id, club.union_id
  INTO v_club
  FROM public.clubs club
  WHERE club.id = p_club_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.club_members member
    WHERE member.club_id = p_club_id AND member.user_id = v_actor
  ) INTO v_is_member;
  SELECT EXISTS (
    SELECT 1 FROM public.profiles profile
    WHERE profile.id = v_actor AND profile.role IN ('admin', 'superadmin', 'god')
  ) INTO v_is_platform_admin;

  v_can_manage := v_is_platform_admin
    OR v_club.owner_id = v_actor
    OR EXISTS (
      SELECT 1 FROM public.club_members member
      WHERE member.club_id = p_club_id
        AND member.user_id = v_actor
        AND member.role IN ('owner', 'co_owner')
    )
    OR (
      v_club.union_id IS NOT NULL
      AND public.fn_union_can_manage_wallets(v_club.union_id, v_actor)
    );

  IF NOT v_is_member AND NOT v_can_manage THEN
    RAISE EXCEPTION 'Leaderboard Access Denied' USING ERRCODE = '42501';
  END IF;

  v_period_end := CASE p_period
    WHEN 'weekly' THEN p_period_start + 7
    ELSE (p_period_start + interval '1 month')::date
  END;
  IF (p_period = 'weekly' AND EXTRACT(DOW FROM p_period_start) <> 0)
     OR (p_period = 'monthly' AND EXTRACT(DAY FROM p_period_start) <> 1) THEN
    RAISE EXCEPTION 'A Canonical Weekly Or Monthly Period Is Required' USING ERRCODE = '22023';
  END IF;

  v_plan := public.fn_get_leaderboard_reward_plan(p_club_id, p_period, p_period_start);
  IF v_plan IS NOT NULL THEN
    SELECT COALESCE(sum((prize ->> 'amount')::numeric), 0)
    INTO v_planned_total
    FROM jsonb_array_elements(COALESCE(v_plan -> 'prizes', '[]'::jsonb)) prize;
  END IF;

  SELECT batch.* INTO v_batch
  FROM public.leaderboard_payout_batches batch
  WHERE batch.club_id = p_club_id
    AND batch.period = p_period
    AND batch.period_start = p_period_start;

  IF v_batch.id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', payout.id,
      'batch_id', payout.batch_id,
      'user_id', payout.user_id,
      'rank', payout.rank,
      'payout_amount', payout.payout_amount,
      'payout_currency', payout.payout_currency,
      'awarded_at', payout.awarded_at
    ) ORDER BY payout.rank, payout.user_id), '[]'::jsonb)
    INTO v_receipts
    FROM public.leaderboard_payouts payout
    WHERE payout.batch_id = v_batch.id;
  END IF;

  SELECT failure.* INTO v_failure
  FROM public.leaderboard_payout_failures failure
  WHERE failure.club_id = p_club_id
    AND failure.period = p_period
    AND failure.period_start = p_period_start
    AND failure.resolved_at IS NULL;

  v_state := CASE
    WHEN v_batch.id IS NOT NULL THEN 'paid'
    WHEN v_plan IS NULL THEN 'not_published'
    WHEN NOT COALESCE((v_plan ->> 'rewards_enabled')::boolean, false) THEN 'disabled'
    WHEN v_period_end > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date THEN 'open'
    WHEN v_failure.id IS NOT NULL THEN 'failed'
    ELSE 'pending'
  END;

  RETURN jsonb_build_object(
    'club_id', p_club_id,
    'period', p_period,
    'period_start', p_period_start,
    'period_end', v_period_end,
    'state', v_state,
    'can_manage', v_can_manage,
    'planned_total', round(v_planned_total, 2),
    'program', v_plan,
    'batch', CASE WHEN v_batch.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_batch.id,
      'program_id', v_batch.program_id,
      'program_version', v_batch.program_version,
      'program_hash', v_batch.program_hash,
      'metric', v_batch.metric,
      'funding_owner_type', v_batch.funding_owner_type,
      'funding_union_id', v_batch.funding_union_id,
      'total_paid', v_batch.total_paid,
      'seed_funded', v_batch.seed_funded,
      'promo_funded', v_batch.promo_funded,
      'winner_count', v_batch.winner_count,
      'tie_policy', v_batch.tie_policy,
      'settled_at', v_batch.settled_at
    ) END,
    'failure', CASE WHEN v_failure.id IS NULL THEN NULL ELSE jsonb_build_object(
      'error_code', v_failure.error_code,
      'attempt_count', v_failure.attempt_count,
      'first_failed_at', v_failure.first_failed_at,
      'last_failed_at', v_failure.failed_at,
      'automatic_retry', true,
      'owner_message', CASE WHEN v_can_manage THEN CASE v_failure.error_code
        WHEN 'promo_wallet_underfunded' THEN 'Add Promo Chips To Cover The Published Prize Pool. Automatic Retry Is Active.'
        WHEN 'promo_wallet_missing' THEN 'The Recorded Promo Wallet Could Not Be Found. Automatic Retry Is Active.'
        WHEN 'credit_conflict' THEN 'A Payout Receipt Conflict Needs Platform Review. No Duplicate Credit Was Issued.'
        ELSE 'Settlement Needs Platform Review. Automatic Retry Is Active.'
      END ELSE NULL END
    ) END,
    'receipts', v_receipts
  );
END;
$function$;

UPDATE public.leaderboard_payout_failures failure
SET error_code = 'not_applicable',
    first_failed_at = COALESCE(first_failed_at, failed_at),
    resolved_at = COALESCE(resolved_at, now()),
    resolution = COALESCE(resolution, 'No Published Program Applied To The Historical Round')
WHERE failure.resolved_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.leaderboard_reward_program_versions program
    WHERE program.club_id = failure.club_id
      AND CASE failure.period
        WHEN 'weekly' THEN program.weekly_effective_from
        WHEN 'monthly' THEN program.monthly_effective_from
        ELSE NULL
      END <= failure.period_start
  );

REVOKE ALL ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_settle_due_leaderboards()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settle_due_leaderboards()
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_get_leaderboard_settlement_status(uuid, text, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_leaderboard_settlement_status(uuid, text, date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz) IS
  'Atomic service-only leaderboard settlement. Uses only the recorded Promo Wallet and opening Promo reserve, splits occupied prizes across ties exactly, credits winners once, and writes immutable batch-linked receipts.';
COMMENT ON FUNCTION public.fn_settle_due_leaderboards() IS
  'Service-only catch-up scheduler. Retries every closed unpaid immutable program, records categorized attempt history, and never debits an operating wallet.';
COMMENT ON FUNCTION public.fn_get_leaderboard_settlement_status(uuid, text, date) IS
  'Authenticated canonical-period settlement read model. Members see program, state, and receipts; funding owners also receive safe recovery guidance. Moves no chips.';

COMMIT;
