-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819162531 "player_rakeback_funded_from_club_treasury"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3b99d0d9e868c578bed1b9cb71de1cd5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- LINE-BY-LINE AUDIT 2026-08-19 (rake/BBJ pass 2), DEFECT #3:
-- fn_close_settlement_period credited each player's weekly rakeback (5–30%
-- tiers) into their wallet with NO offsetting debit anywhere — the payout was
-- MINTED. Every other money movement in the platform is double-entry; this one
-- inflated the economy weekly.
--
-- Funding model now: the CLUB pays player rakeback from its operational bank
-- (clubs.chip_treasury) — which is exactly what the union's weekly 90% payback
-- replenishes. Order inside one transaction:
--   payout-row claim (idempotency) -> treasury debit -> player credit -> paid.
-- If the club treasury cannot cover the payout, the claim is released, a
-- financial_alert is raised, and the period stays 'pending' so the next weekly
-- close retries after the union's 90% lands.

CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(p_period_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_period         record;
  v_rake_total     numeric;
  v_rate           numeric;
  v_payout         numeric;
  v_payout_id      uuid;
  v_wallet_balance numeric;
  v_debit          jsonb;
BEGIN
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;

  IF v_period.status IN ('paid', 'expired') THEN
    RETURN jsonb_build_object('success', true, 'skipped', v_period.status, 'period_id', p_period_id);
  END IF;

  -- EQUAL-SHARE across EVERY PLAYER DEALT IN (DECISION D-001).
  SELECT COALESCE(SUM(
           r.rake_amount / GREATEST(
             (SELECT count(*) FROM jsonb_object_keys(r.player_contributions) k), 1)
         ), 0)
    INTO v_rake_total
    FROM public.rake_records r
   WHERE r.club_id = v_period.club_id
     AND r.created_at >= v_period.period_start::timestamptz
     AND r.created_at <  (v_period.period_end + 1)::timestamptz
     AND r.rake_amount > 0
     AND r.player_contributions IS NOT NULL
     AND (r.player_contributions ? v_period.user_id::text);

  v_rake_total := ROUND(v_rake_total, 2);

  v_rate := CASE
    WHEN v_rake_total >= 10000 THEN 0.30
    WHEN v_rake_total >=  2000 THEN 0.20
    WHEN v_rake_total >=   500 THEN 0.15
    WHEN v_rake_total >=   100 THEN 0.10
    ELSE                            0.05
  END;
  v_payout := ROUND(v_rake_total * v_rate, 4);

  UPDATE public.rakeback_periods
     SET rake_generated  = v_rake_total,
         total_rake_paid = v_rake_total,
         rakeback_rate   = v_rate,
         rakeback_amount = v_payout,
         rakeback_earned = v_payout
   WHERE id = p_period_id;

  IF v_payout <= 0 THEN
    UPDATE public.rakeback_periods SET status = 'paid', paid_at = NOW() WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'period_id', p_period_id, 'payout', 0);
  END IF;

  -- Idempotency claim.
  INSERT INTO public.rakeback_period_payouts
    (rakeback_period_id, club_id, user_id, user_rake_contribution,
     rakeback_pct, payout_amount, status, paid_at)
  VALUES
    (p_period_id, v_period.club_id, v_period.user_id, v_rake_total,
     ROUND(v_rate * 100, 2), v_payout, 'paid', NOW())
  ON CONFLICT (rakeback_period_id, user_id) DO NOTHING
  RETURNING id INTO v_payout_id;

  IF v_payout_id IS NULL THEN
    UPDATE public.rakeback_periods SET status = 'paid', paid_at = NOW() WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'skipped', 'payout_exists', 'period_id', p_period_id);
  END IF;

  -- DOUBLE-ENTRY: the club's operational bank funds the payout.
  v_debit := public.fn_debit_treasury(
    v_period.club_id, v_payout,
    'Player rakeback ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    jsonb_build_object('period_id', p_period_id, 'user_id', v_period.user_id,
                       'rake_basis', v_rake_total, 'rate', v_rate));
  IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
    -- Release the claim; period stays pending and retries after the union's
    -- weekly 90% replenishes the treasury.
    DELETE FROM public.rakeback_period_payouts WHERE id = v_payout_id;
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('warning', 'fn_close_settlement_period',
      'Player rakeback deferred: club treasury cannot fund payout',
      jsonb_build_object('period_id', p_period_id, 'club_id', v_period.club_id,
        'user_id', v_period.user_id, 'payout', v_payout, 'debit_result', v_debit));
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_club_treasury',
      'period_id', p_period_id, 'payout', v_payout, 'debit_result', v_debit);
  END IF;

  PERFORM public.atomic_credit_wallet_and_log(
    v_period.user_id, v_payout, 'rakeback',
    'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    NULL, NULL, v_payout_id
  );

  SELECT balance INTO v_wallet_balance FROM public.wallets
   WHERE user_id = v_period.user_id AND wallet_type = 'PLAYER';
  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, amount, type, category, description, related_entity_id, balance_after)
  VALUES
    (v_period.user_id, 'PLAYER', v_payout, 'credit', 'rakeback',
     'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
     v_payout_id, v_wallet_balance);

  UPDATE public.rakeback_periods SET status = 'paid', paid_at = NOW() WHERE id = p_period_id;

  RETURN jsonb_build_object('success', true, 'period_id', p_period_id,
    'rake_total', v_rake_total, 'rakeback_rate', v_rate,
    'payout', v_payout, 'payout_id', v_payout_id, 'funded_from', 'club_chip_treasury');
END;
$$;
