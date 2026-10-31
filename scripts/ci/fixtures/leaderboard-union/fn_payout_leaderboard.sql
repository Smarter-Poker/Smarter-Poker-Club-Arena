CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(p_club_id uuid, p_period text, p_metric text, p_start_date timestamp with time zone, p_end_date timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_start date := (p_start_date AT TIME ZONE 'UTC')::date;
  v_end date := (p_end_date AT TIME ZONE 'UTC')::date;
  v_plan jsonb;
  v_basis jsonb;
  v_board jsonb;
  v_existing public.leaderboard_payout_batches%ROWTYPE;
  v_winners jsonb := '[]'::jsonb;
  v_winner jsonb;
  v_total numeric(18,2) := 0;
  v_promo_available numeric(18,2) := 0;
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

  -- Serialize the exact historical round identity BEFORE replay lookup.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('leaderboard-round:%s:%s:%s', p_club_id, p_period, v_start), 0));

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

  v_basis := public.fn_leaderboard_complete_round_basis(p_club_id, p_period, v_start, v_end);
  IF NOT (v_basis ->> 'basis_version' = 'legacy_v1'
    OR (v_basis ->> 'basis_version' = 'complete_capture_v2'
      AND v_basis -> 'complete' = 'true'::jsonb)) THEN
    RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='LEADERBOARD_COMPLETE_BASIS_REQUIRED';
  END IF;
  -- The public club board and settlement use ONE maintained ranking owner.
  -- That owner selects the same complete basis for closed canonical V2 rounds;
  -- existing promised legacy rounds retain their unchanged selection.
  SELECT COALESCE(jsonb_agg(to_jsonb(ranked) ORDER BY ranked.rank, ranked.user_id), '[]'::jsonb)
    INTO v_board
  FROM public.fn_club_leaderboard_by_dates(p_club_id, p_metric, v_start, v_end, 1000000, 0) ranked;

  WITH board AS MATERIALIZED (
    SELECT ranked.user_id, ranked.rank
    FROM jsonb_to_recordset(v_board) AS ranked(user_id uuid, rank integer, qualified boolean)
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
  FROM winners
  WHERE winners.amount > 0;

  -- Freeze the exact resolved program, selected inputs and awards before funds.
  -- A failed settlement rolls this receipt back; no historical row is rewritten.
  INSERT INTO public.leaderboard_round_basis_receipts (
    club_id, period, period_start, period_end, metric,
    program_id, program_version, program_hash, basis_version,
    basis, basis_hash, selected_board, selected_board_hash, winners, winners_hash
  ) VALUES (
    p_club_id, p_period, v_start, v_end, p_metric,
    (v_plan ->> 'program_id')::uuid, (v_plan ->> 'program_version')::integer,
    v_plan ->> 'program_hash', v_basis ->> 'basis_version',
    v_basis, md5(v_basis::text), v_board, md5(v_board::text), v_winners, md5(v_winners::text)
  );

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    v_union_id := (v_plan ->> 'funding_union_id')::uuid;
    SELECT COALESCE(wallet.promo_wallet, 0) INTO v_promo_available
    FROM public.union_wallets wallet WHERE wallet.union_id = v_union_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LEADERBOARD_PROMO_WALLET_MISSING|Leaderboard Funding Union Has No Promo Wallet';
    END IF;
  ELSE
    SELECT COALESCE(club.promo_balance, 0) INTO v_promo_available
    FROM public.clubs club WHERE club.id = p_club_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LEADERBOARD_PROMO_WALLET_MISSING|Leaderboard Club Not Found';
    END IF;
  END IF;
  IF v_promo_available < v_total THEN
    RAISE EXCEPTION
      'LEADERBOARD_PROMO_UNDERFUNDED|Leaderboard Requires % Promo Chips But The Recorded Promo Wallet Holds %',
      v_total, v_promo_available;
  END IF;
  v_promo_debit := v_total;

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
    SET promo_balance = promo_balance - v_promo_debit,
        updated_at = now()
    WHERE id = p_club_id;
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
    v_total, 0, v_promo_debit, 0, jsonb_array_length(v_winners),
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
    'seed_funded', 0,
    'promo_funded', v_promo_debit,
    'overlay_funded', 0,
    'winner_count', jsonb_array_length(v_winners),
    'tie_policy', 'split_occupied_places'
  );
END;
$function$
