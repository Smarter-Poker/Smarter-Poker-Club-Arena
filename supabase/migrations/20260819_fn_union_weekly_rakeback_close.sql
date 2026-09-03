-- ═══════════════════════════════════════════════════════════════════════════
-- APPLIED TO PRODUCTION: 2026-08-19 via Supabase MCP apply_migration
-- (name fn_union_weekly_rakeback_close). Mirror only.
-- ═══════════════════════════════════════════════════════════════════════════
-- Weekly union rakeback per Dan's spec (2026-08-19): rake is HELD in
-- union_wallets.rake_wallet (Rake Treasury) during the week; at weekly close
-- 90% of each member club's rake is sent back to that club's operational bank
-- (clubs.chip_treasury, via fn_credit_treasury which writes the
-- chip_transactions audit row) and the union keeps 10%, which stays in
-- union_wallets.chip_balance as general funds while leaving the rake_wallet
-- sub-account.
--
-- WHY A NEW FUNCTION: the prior fn_execute_union_rakeback paid clubs from the
-- union OWNER'S personal player wallet and never debited rake_wallet — the
-- treasury grew forever (1,506,446.08 accumulated 2026-04-29..08-19 with
-- total_settlements = 0, i.e. the weekly 90% had never executed once).
-- fn_execute_union_rakeback is now an owner-gated delegate to this function.
--
-- Basis: union_wallet_transactions rake credits per club in the period — i.e.
-- exactly what actually entered the treasury. Payout rate is
-- union_clubs.club_commission_rate (default 0.90). The union's own self-club
-- row (club_id = union_id) is union revenue and is retained, not paid.
-- Idempotent via union_rakeback_log UNIQUE(union_id, period_start, period_end).
-- service_role only; invoked by RakebackSettlerService.runWeeklyFinancialClose
-- (step 1.5) every Monday for the just-lapsed ISO week.
--
-- CATCH-UP EXECUTED 2026-08-19 for period 2026-04-01..2026-08-17:
--   period_rake 1,090,485.21 | paid SHARK CLUB 980,957.04 (90%) |
--   union retained 109,528.17 | rake_wallet after: 417,397.16 (current week) |
--   chip_balance after: 538,292.40. Recorded in union_rakeback_log +
--   union_wallet_transactions + chip_transactions.

CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close(
  p_union_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_wallet       public.union_wallets%ROWTYPE;
  v_period_total numeric := 0;
  v_payout_total numeric := 0;
  v_retained     numeric := 0;
  v_clubs_paid   integer := 0;
  v_club         record;
  v_rw_debit     numeric;
  v_new_rw       numeric;
  v_new_cb       numeric;
  v_credit       jsonb;
BEGIN
  IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_end <= p_period_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'bad_params');
  END IF;

  IF EXISTS (
    SELECT 1 FROM union_rakeback_log
     WHERE union_id = p_union_id
       AND period_start = p_period_start AND period_end = p_period_end
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed');
  END IF;

  SELECT * INTO v_wallet FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_wallet.union_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_wallet');
  END IF;

  CREATE TEMP TABLE _uwrb ON COMMIT DROP AS
  SELECT t.club_id,
         SUM(t.amount) AS rake_in,
         trunc(SUM(t.amount) * COALESCE(uc.club_commission_rate, 0.90) * 100) / 100 AS payout
    FROM union_wallet_transactions t
    LEFT JOIN union_clubs uc
           ON uc.union_id = t.union_id AND uc.club_id = t.club_id
   WHERE t.union_id = p_union_id
     AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
     AND t.created_at >= p_period_start AND t.created_at < p_period_end
   GROUP BY t.club_id, uc.club_commission_rate;

  SELECT COALESCE(SUM(rake_in), 0) INTO v_period_total FROM _uwrb;
  SELECT COALESCE(SUM(payout), 0) INTO v_payout_total
    FROM _uwrb WHERE club_id IS NOT NULL AND club_id <> p_union_id;

  IF v_period_total <= 0 THEN
    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, 0, now());
    RETURN jsonb_build_object('success', true, 'clubs_paid', 0,
      'period_rake', 0, 'total_rakeback', 0, 'union_retained', 0, 'note', 'no_rake');
  END IF;

  IF v_payout_total > COALESCE(v_wallet.chip_balance, 0)
     OR v_payout_total > COALESCE(v_wallet.rake_wallet, 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_treasury',
      'payout', v_payout_total,
      'rake_wallet', v_wallet.rake_wallet, 'chip_balance', v_wallet.chip_balance);
  END IF;

  FOR v_club IN
    SELECT club_id, rake_in, payout FROM _uwrb
     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0
  LOOP
    v_credit := fn_credit_treasury(
      v_club.club_id, v_club.payout,
      'Union weekly rakeback ' || to_char(p_period_start, 'YYYY-MM-DD')
        || '..' || to_char(p_period_end, 'YYYY-MM-DD'),
      jsonb_build_object('union_id', p_union_id,
                         'period_start', p_period_start, 'period_end', p_period_end,
                         'rake_basis', v_club.rake_in, 'rate', 'club_commission_rate')
    );
    IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'treasury credit failed for club %: %', v_club.club_id, v_credit;
    END IF;
    v_clubs_paid := v_clubs_paid + 1;
  END LOOP;

  v_retained := v_period_total - v_payout_total;
  -- rake_wallet is a sub-account of chip_balance: the whole period's rake leaves
  -- the treasury sub-account; only the 90% payout leaves the union entirely.
  -- Clamp against small historical drift between audit rows and the wallet.
  v_rw_debit := LEAST(v_period_total, COALESCE(v_wallet.rake_wallet, 0));

  UPDATE union_wallets
     SET rake_wallet       = rake_wallet - v_rw_debit,
         chip_balance      = chip_balance - v_payout_total,
         total_settlements = COALESCE(total_settlements, 0) + v_payout_total,
         updated_at        = now()
   WHERE union_id = p_union_id
   RETURNING rake_wallet, chip_balance INTO v_new_rw, v_new_cb;

  INSERT INTO union_wallet_transactions
    (union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes)
  SELECT p_union_id, club_id, payout, 'rakeback', 'rake_wallet', 'debit', v_new_rw,
         'Weekly 90% rakeback to club (period '
           || to_char(p_period_start, 'YYYY-MM-DD') || '..'
           || to_char(p_period_end, 'YYYY-MM-DD') || ')'
    FROM _uwrb
   WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0;

  IF v_retained > 0 THEN
    INSERT INTO union_wallet_transactions
      (union_id, amount, tx_type, wallet, direction, balance_after, notes)
    VALUES
      (p_union_id, v_retained, 'rake_hold', 'chip_balance', 'credit', v_new_cb,
       'Union 10% retained + self-club rake, redesignated from rake_wallet to general funds (period '
         || to_char(p_period_start, 'YYYY-MM-DD') || '..'
         || to_char(p_period_end, 'YYYY-MM-DD') || ') — informational; chip_balance total unchanged by retention');
  END IF;

  INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
  VALUES (p_union_id, p_period_start, p_period_end, v_payout_total, now());

  RETURN jsonb_build_object('success', true,
    'clubs_paid', v_clubs_paid,
    'period_rake', v_period_total,
    'total_rakeback', v_payout_total,
    'union_retained', v_retained,
    'rake_wallet_after', v_new_rw,
    'chip_balance_after', v_new_cb);
END $$;

REVOKE ALL ON FUNCTION public.fn_union_weekly_rakeback_close(uuid, timestamptz, timestamptz)
  FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_weekly_rakeback_close(uuid, timestamptz, timestamptz)
  TO service_role;

-- Owner-gated manual trigger now delegates to the treasury-funded close instead
-- of paying from the owner's personal wallet.
CREATE OR REPLACE FUNCTION public.fn_execute_union_rakeback(
  p_union_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_owner  uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM unions WHERE id = p_union_id;
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union_not_found');
  END IF;
  IF v_caller IS NULL OR v_caller <> v_owner THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  RETURN public.fn_union_weekly_rakeback_close(p_union_id, p_period_start, p_period_end);
END $$;
