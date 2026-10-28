CREATE OR REPLACE FUNCTION public.fn_get_leaderboard_settlement_status(p_club_id uuid, p_period text, p_period_start date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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
      'overlay_funded', v_batch.overlay_funded,
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
$function$
