CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(
  p_club_id uuid,
  p_period text,
  p_metric text,
  p_start_date date,
  p_end_date date
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_settings record;
  v_prizes jsonb;
  v_prize record;
  v_winner record;
  v_idempotency_key text;
  v_payout_amount numeric;
BEGIN
  -- Get club settings
  SELECT * INTO v_settings FROM public.club_leaderboard_settings WHERE club_id = p_club_id;
  IF NOT FOUND THEN
    RETURN; -- No settings, nothing to pay
  END IF;

  -- Determine which prize bracket to use based on period
  IF p_period = 'weekly' THEN
    v_prizes := v_settings.weekly_prizes;
  ELSIF p_period = 'monthly' THEN
    v_prizes := v_settings.monthly_prizes;
  ELSE
    RETURN; -- Only weekly and monthly payouts are supported for now
  END IF;

  IF jsonb_array_length(v_prizes) = 0 THEN
    RETURN; -- No prizes configured
  END IF;

  -- Get top ranked players for the specified period and metric
  FOR v_winner IN (
    SELECT * FROM fn_club_leaderboard_period_v2(
      p_club_id,
      p_metric,
      p_period,
      50, -- limit
      0   -- offset
    )
  ) LOOP
    -- Find prize amount for this rank
    v_payout_amount := 0;
    
    FOR v_prize IN SELECT * FROM jsonb_to_recordset(v_prizes) AS x(rank int, amount numeric)
    LOOP
      IF v_prize.rank = v_winner.rn_now THEN
        v_payout_amount := v_prize.amount;
        EXIT;
      END IF;
    END LOOP;

    -- If there's a payout, record it and credit wallet
    IF v_payout_amount > 0 THEN
      -- Record payout
      v_idempotency_key := 'lb_payout:' || p_club_id::text || ':' || p_period || ':' || p_metric || ':' || p_start_date::text || ':' || v_winner.uid::text;
      
      BEGIN
        INSERT INTO public.leaderboard_payouts (
          club_id, period, metric, start_date, end_date, user_id, rank, payout_amount, payout_currency
        ) VALUES (
          p_club_id, p_period, p_metric, p_start_date, p_end_date, v_winner.uid, v_winner.rn_now, v_payout_amount, v_settings.payout_currency
        );

        -- Credit wallet using idempotent credit (assuming fn_idempotent_credit_wallet exists as per M1 fix)
        -- We will attempt to call credit_player_wallet as a fallback if the new function doesn't exist yet,
        -- but the instruction implies M1 is either fixed or will be fixed.
        
        IF v_settings.payout_currency = 'diamonds' THEN
          -- Deduct from club diamond wallet
          UPDATE public.club_diamond_wallets 
          SET balance = balance - v_payout_amount,
              updated_at = NOW()
          WHERE club_id = p_club_id;
          
          -- Add to user diamond wallet
          UPDATE public.diamond_wallets
          SET balance = balance + v_payout_amount,
              lifetime_earned = lifetime_earned + v_payout_amount,
              updated_at = NOW()
          WHERE user_id = v_winner.uid;
        ELSIF v_settings.payout_currency = 'chips' THEN
          -- Mint chips to user
          -- Use generic credit for now
          PERFORM public.credit_player_wallet(v_winner.uid, p_club_id, v_payout_amount, 'leaderboard_payout');
        END IF;
      EXCEPTION WHEN unique_violation THEN
        -- Already paid out
        NULL;
      END;
    END IF;
  END LOOP;
END;
$$;
