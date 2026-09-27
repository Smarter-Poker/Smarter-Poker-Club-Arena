-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260722133224 "fix_rakeback_payout_wallet_type_and_horse_guard_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 02d164550e9dfcf9e6c28b126d1d3d08 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- AUDIT FIX (rakeback payout). Two live bugs meant NO rakeback ever reached a wallet:
--   1. fn_close_settlement_period credited wallet_type='main' — an invalid type (CHECK
--      allows only BUSINESS/PLAYER/PROMO), so it matched 0 rows and the guarded audit
--      insert was skipped. 47 periods were marked 'paid' with 0 chips delivered.
--   2. Even had the type been right, the raw UPDATE wallets is blocked by the
--      guard_wallet_balance_write trigger (fn_close_settlement_period is not whitelisted).
-- Additionally, 45 of those 47 paid periods belong to HORSES — crediting them would MINT
-- ~55k chips into house-player wallets (the 'main' typo accidentally prevented this).
--
-- Fix: credit through the whitelisted atomic_credit_wallet_and_log (upserts the PLAYER
-- wallet, logs chip_transactions, passes the guard); NEVER credit a horse; order the
-- credit BEFORE the status flip so it is atomic + idempotent on the payout row.
CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period     record;
  v_is_horse   boolean;
  v_rake_total numeric;
  v_payout     numeric;
  v_payout_id  uuid;
BEGIN
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;

  IF v_period.status IN ('paid', 'expired') THEN
    RETURN jsonb_build_object('success', true, 'skipped', v_period.status, 'period_id', p_period_id);
  END IF;

  -- Horses (house AI players) never earn rakeback — crediting them mints chips.
  -- Terminalize any horse period so it can never be paid, and self-heal legacy rows.
  SELECT COALESCE(is_horse, false) INTO v_is_horse FROM public.profiles WHERE id = v_period.user_id;
  IF v_is_horse THEN
    UPDATE public.rakeback_periods SET status = 'expired' WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'skipped', 'horse', 'period_id', p_period_id);
  END IF;

  -- Recompute this player's rake share for the period from the canonical rake_records.
  SELECT COALESCE(SUM(COALESCE((r.player_contributions->v_period.user_id::text)::numeric, 0)), 0)
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
         rakeback_earned = v_payout
   WHERE id = p_period_id;

  IF v_payout <= 0 THEN
    UPDATE public.rakeback_periods SET status = 'paid', paid_at = NOW() WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'period_id', p_period_id, 'payout', 0);
  END IF;

  -- Idempotency marker: one payout row per (period, user). If it already exists, another
  -- run already paid this period — do NOT credit again.
  INSERT INTO public.rakeback_period_payouts
    (rakeback_period_id, club_id, user_id, user_rake_contribution,
     rakeback_pct, payout_amount, status, paid_at)
  VALUES
    (p_period_id, v_period.club_id, v_period.user_id, v_rake_total,
     ROUND(v_period.rakeback_rate * 100, 2), v_payout, 'paid', NOW())
  ON CONFLICT (rakeback_period_id, user_id) DO NOTHING
  RETURNING id INTO v_payout_id;

  IF v_payout_id IS NULL THEN
    UPDATE public.rakeback_periods SET status = 'paid', paid_at = NOW() WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'skipped', 'payout_exists', 'period_id', p_period_id);
  END IF;

  -- Credit the PLAYER wallet through the whitelisted, ledger-logging RPC. If this raises
  -- (e.g. guard/RLS), the whole transaction rolls back — the payout row + status flip do
  -- not persist, so the period stays claimable.
  PERFORM public.atomic_credit_wallet_and_log(
    v_period.user_id, v_payout, 'rakeback',
    'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    NULL, NULL, v_payout_id
  );

  UPDATE public.rakeback_periods SET status = 'paid', paid_at = NOW() WHERE id = p_period_id;

  RETURN jsonb_build_object('success', true, 'period_id', p_period_id,
    'rake_total', v_rake_total, 'rakeback_rate', v_period.rakeback_rate,
    'payout', v_payout, 'payout_id', v_payout_id);
END;
$function$;
