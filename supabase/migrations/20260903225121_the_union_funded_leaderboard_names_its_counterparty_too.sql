-- THE UNION-FUNDED LEADERBOARD NAMES ITS COUNTERPARTY TOO.
--
-- 2026-09-03, Dan: "LEADER BOARDS IS THE ONLY PROMO THAT GETS PAID OUT BY THE
-- PROMO WALLET. MAKE SURE THATS BUILT IN AND FULLY WIRED UP AND WORKING."
--
-- It is wired: leaderboard-payout-waterfall-daily runs fn_settle_due_leaderboards
-- at 00:20 UTC every day, and fn_payout_leaderboard spends the seed first, then
-- the promo float, then the operating wallet. Deep Stack Society's published
-- programme takes effect for the weekly round beginning 2026-09-06 and will
-- draw on its 6,3xx promo float. (The one recorded failure, August's monthly,
-- is correct: that programme's monthly_effective_from is 2026-09-01, so no paid
-- programme applied to an August round.)
--
-- One half of it was not wired. The club-funded branch declares its ledger
-- counterparty before moving the club's balances, so its legs journal as
-- clubs.promo_balance -> leaderboard_round. The union-funded branch declared
-- nothing, so a union-funded leaderboard would have debited promo_wallet and
-- chip_balance straight into settlement_suspense - the exact class of orphan
-- leg Phase 1.3 spent a day removing - and the winners' credits after it would
-- have followed, because fn_credit_and_log only names a counterparty for the
-- tournament categories and inherits the caller's setting otherwise.
--
-- No union-funded programme has ever paid (zero rows in
-- leaderboard_payout_batches), so this fixes the path before it carries money
-- rather than after.
--
-- Nothing else in the function changes.

CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(
  p_club_id uuid, p_period text, p_metric text,
  p_start_date timestamp with time zone, p_end_date timestamp with time zone)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
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
  v_operating_available numeric(18,2) := 0;
  v_seed_available numeric(18,2) := 0;
  v_seed_debit numeric(18,2) := 0;
  v_seed_release numeric(18,2) := 0;
  v_promo_debit numeric(18,2) := 0;
  v_overlay numeric(18,2) := 0;
  v_union_id uuid;
  v_batch_id uuid;
  v_credited boolean;
BEGIN
  IF p_period NOT IN ('weekly', 'monthly') THEN
    RAISE EXCEPTION 'Only Weekly And Monthly Leaderboards Can Be Settled';
  END IF;
  IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN
    RAISE EXCEPTION 'Leaderboard Settlement Requires A Closed Date Range';
  END IF;
  IF v_end > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'An Open Leaderboard Round Cannot Be Paid';
  END IF;
  IF (p_period = 'weekly' AND (EXTRACT(DOW FROM v_start) <> 0 OR v_end <> v_start + 7))
     OR (p_period = 'monthly' AND (EXTRACT(DAY FROM v_start) <> 1 OR v_end <> (v_start + interval '1 month')::date)) THEN
    RAISE EXCEPTION 'Leaderboard Settlement Must Use A Canonical UTC Round';
  END IF;

  SELECT batch.* INTO v_existing
  FROM public.leaderboard_payout_batches batch
  WHERE batch.club_id = p_club_id
    AND batch.period = p_period
    AND batch.period_start = v_start;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true, 'already_settled', true, 'batch_id', v_existing.id,
      'total_paid', v_existing.total_paid,
      'seed_funded', v_existing.seed_funded,
      'promo_funded', v_existing.promo_funded,
      'overlay_funded', v_existing.overlay_funded,
      'winner_count', v_existing.winner_count
    );
  END IF;

  v_plan := public.fn_get_leaderboard_reward_plan(p_club_id, p_period, v_start);
  IF v_plan IS NULL OR NOT COALESCE((v_plan ->> 'rewards_enabled')::boolean, false) THEN
    RAISE EXCEPTION 'No Paid Leaderboard Program Applies To This Round';
  END IF;
  IF p_metric IS DISTINCT FROM v_plan ->> 'payout_metric' THEN
    RAISE EXCEPTION 'Leaderboard Metric Does Not Match The Published Program';
  END IF;

  WITH board AS (
    SELECT ranked.*,
           row_number() OVER (ORDER BY ranked.rank, ranked.user_id) AS position
    FROM public.fn_club_leaderboard_by_dates(
      p_club_id, p_metric, v_start, v_end, 10, 0
    ) ranked
    WHERE ranked.qualified
  ), prizes AS (
    SELECT prize.rank, round(prize.amount, 2) AS amount
    FROM jsonb_to_recordset(COALESCE(v_plan -> 'prizes', '[]'::jsonb))
      AS prize(rank integer, amount numeric)
  ), winners AS (
    SELECT board.user_id, board.position::integer AS rank, prizes.amount
    FROM board JOIN prizes ON prizes.rank = board.position
    WHERE prizes.amount > 0
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'user_id', winners.user_id,
      'rank', winners.rank,
      'amount', winners.amount
    ) ORDER BY winners.rank), '[]'::jsonb),
    COALESCE(round(sum(winners.amount), 2), 0)
  INTO v_winners, v_total
  FROM winners;

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    v_union_id := (v_plan ->> 'funding_union_id')::uuid;
    SELECT COALESCE(wallet.promo_wallet, 0), COALESCE(wallet.chip_balance, 0)
    INTO v_promo_available, v_operating_available
    FROM public.union_wallets wallet
    WHERE wallet.union_id = v_union_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Leaderboard Funding Union Has No Wallet'; END IF;
  ELSE
    SELECT COALESCE(setup.leaderboard_seed_remaining, 0)
    INTO v_seed_available
    FROM public.club_opening_setups setup
    WHERE setup.club_id = p_club_id
    FOR UPDATE;

    SELECT COALESCE(club.promo_balance, 0), COALESCE(club.chip_treasury, 0)
    INTO v_promo_available, v_operating_available
    FROM public.clubs club
    WHERE club.id = p_club_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Leaderboard Club Not Found'; END IF;
  END IF;

  v_seed_debit := LEAST(v_total, v_seed_available);
  v_seed_release := v_seed_available - v_seed_debit;
  v_promo_debit := LEAST(v_total - v_seed_debit, v_promo_available);
  v_overlay := v_total - v_seed_debit - v_promo_debit;
  IF v_operating_available < v_overlay THEN
    RAISE EXCEPTION 'Leaderboard Requires % Chips But Promo And Operating Wallets Hold %',
      v_total, v_seed_available + v_promo_available + v_operating_available;
  END IF;

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    /* CHIP STANDARD (2026-09-03): the union branch declares its counterparty
       exactly as the club branch below does. Without this the wallet debits -
       and the winners' credits after them, which inherit the setting - went to
       settlement_suspense. */
    PERFORM set_config('app.ledger_category', 'leaderboard_payout', true);
    PERFORM set_config('app.ledger_counterparty', 'leaderboard_round', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_club_id::text, true);
    UPDATE public.union_wallets
    SET promo_wallet = promo_wallet - v_promo_debit,
        chip_balance = chip_balance - v_overlay,
        updated_at = now()
    WHERE union_id = v_union_id;
  ELSE
    PERFORM set_config('app.ledger_category', 'leaderboard_payout', true);
    PERFORM set_config('app.ledger_counterparty', 'leaderboard_round', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_club_id::text, true);
    UPDATE public.clubs
    SET promo_balance = promo_balance - v_promo_debit + v_seed_release,
        chip_treasury = chip_treasury - v_overlay,
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
    total_paid, seed_funded, promo_funded, overlay_funded, winner_count
  ) VALUES (
    p_club_id, p_period, v_start, v_end, p_metric,
    (v_plan ->> 'program_id')::uuid,
    (v_plan ->> 'program_version')::integer,
    v_plan ->> 'program_hash',
    v_plan ->> 'funding_owner_type', v_union_id,
    v_total, v_seed_debit, v_promo_debit, v_overlay, jsonb_array_length(v_winners)
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
      RAISE EXCEPTION 'Leaderboard Credit Key Already Exists Without A Batch Receipt';
    END IF;

    INSERT INTO public.leaderboard_payouts (
      club_id, period, metric, start_date, end_date, user_id, rank,
      payout_amount, payout_currency, awarded_at
    ) VALUES (
      p_club_id, p_period, p_metric, v_start, v_end,
      (v_winner ->> 'user_id')::uuid,
      (v_winner ->> 'rank')::integer,
      (v_winner ->> 'amount')::numeric,
      'chips', now()
    );
  END LOOP;

  DELETE FROM public.leaderboard_payout_failures
  WHERE club_id = p_club_id AND period = p_period AND period_start = v_start;

  RETURN jsonb_build_object(
    'success', true, 'already_settled', false, 'batch_id', v_batch_id,
    'total_paid', v_total, 'seed_funded', v_seed_debit, 'promo_funded', v_promo_debit,
    'overlay_funded', v_overlay, 'winner_count', jsonb_array_length(v_winners)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  TO service_role;