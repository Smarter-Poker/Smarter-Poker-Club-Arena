-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260428210537 "x3_005_settlement_period_open_close"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ea64ccaf6b2ef2031aeb125fd4590aea of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_create_settlement_period(
  p_club_id      uuid,
  p_user_id      uuid,
  p_period_start date DEFAULT CURRENT_DATE,
  p_period_end   date DEFAULT CURRENT_DATE + INTERVAL '7 days'
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_period_id uuid;
  v_rate numeric;
BEGIN
  SELECT COALESCE(a.player_rakeback_rate, 0.10) INTO v_rate
    FROM public.player_agent_assignments paa
    LEFT JOIN public.agents a ON a.id = paa.agent_id
   WHERE paa.player_id = p_user_id AND paa.club_id = p_club_id
   LIMIT 1;
  v_rate := COALESCE(v_rate, 0.10);

  INSERT INTO public.rakeback_periods
    (user_id, club_id, period_start, period_end, rakeback_rate, status)
  VALUES
    (p_user_id, p_club_id, p_period_start, p_period_end, v_rate, 'pending')
  RETURNING id INTO v_period_id;

  RETURN v_period_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_create_settlement_period(uuid, uuid, date, date) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(
  p_period_id uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  v_period record;
  v_rake_total numeric;
  v_payout     numeric;
  v_payout_id  uuid;
  v_wallet_balance numeric;
BEGIN
  SELECT * INTO v_period
    FROM public.rakeback_periods
   WHERE id = p_period_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;

  IF v_period.status = 'paid' THEN
    RETURN jsonb_build_object('success', true, 'skipped', 'already_paid', 'period_id', p_period_id);
  END IF;

  SELECT COALESCE(SUM(
    COALESCE((r.player_contributions->v_period.user_id::text)::numeric, 0)
  ), 0)
    INTO v_rake_total
    FROM public.rake_records r
   WHERE r.club_id = v_period.club_id
     AND r.created_at::date >= v_period.period_start
     AND r.created_at::date <= v_period.period_end;

  v_payout := ROUND(v_rake_total * v_period.rakeback_rate, 4);

  UPDATE public.rakeback_periods
     SET rake_generated  = v_rake_total,
         total_rake_paid = v_rake_total,
         rakeback_amount = v_payout,
         rakeback_earned = v_payout,
         status = 'paid',
         paid_at = NOW()
   WHERE id = p_period_id;

  IF v_payout <= 0 THEN
    RETURN jsonb_build_object('success', true, 'period_id', p_period_id, 'payout', 0);
  END IF;

  INSERT INTO public.rakeback_period_payouts
    (rakeback_period_id, club_id, user_id, user_rake_contribution,
     rakeback_pct, payout_amount, status, paid_at)
  VALUES
    (p_period_id, v_period.club_id, v_period.user_id, v_rake_total,
     ROUND(v_period.rakeback_rate * 100, 2), v_payout, 'paid', NOW())
  ON CONFLICT (rakeback_period_id, user_id) DO NOTHING
  RETURNING id INTO v_payout_id;

  UPDATE public.wallets
     SET balance    = balance + v_payout,
         updated_at = NOW()
   WHERE user_id = v_period.user_id AND wallet_type = 'main'
  RETURNING balance INTO v_wallet_balance;

  IF v_wallet_balance IS NOT NULL THEN
    INSERT INTO public.wallet_transactions
      (user_id, wallet_type, amount, type, category,
       description, related_entity_id, balance_after)
    VALUES
      (v_period.user_id, 'main', v_payout, 'credit', 'rakeback',
       'Rakeback payout for period ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
       v_payout_id, v_wallet_balance);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'period_id', p_period_id,
    'rake_total', v_rake_total,
    'rakeback_rate', v_period.rakeback_rate,
    'payout', v_payout,
    'payout_id', v_payout_id
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_close_settlement_period(uuid) TO service_role;
