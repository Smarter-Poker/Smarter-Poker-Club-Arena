-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819162701 "union_treasury_selftest_and_ledger_completeness"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2d8ffff9d0670640d19d6ebee568b1b9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- LINE-BY-LINE AUDIT 2026-08-19 (rake/BBJ pass 2) — upgrades:
--
-- 1. LEDGER COMPLETENESS: the weekly close debited rake_wallet by the full
--    period total but only wrote audit debit rows for the 90% payouts — the
--    retained 10% (+ self-club rake) left the rake_wallet sub-account with no
--    debit row, so Σcredits − Σdebits could never reconcile to the balance.
--    The close now writes the retained redesignation as a rake_wallet DEBIT
--    row (paired with the informational chip_balance credit row), and this
--    migration backfills the missing debit row for today's catch-up close.
--
-- 2. fn_union_treasury_selftest(): conservation sentinel the engine can run
--    every settler cycle. Checks, per union: non-negative wallets;
--    rake_wallet <= chip_balance (sub-account invariant); audit-ledger
--    reconciliation |rake_wallet − (Σcredits − Σdebits)| within tolerance;
--    zero duplicate BBJ (pool,hand) pairs; retired pools carry zero balance;
--    no fully-lapsed unclosed week. Breaches insert deduped financial_alerts
--    and are returned to the caller.
--
-- 3. NUMERIC HYGIENE: chip_balance had accumulated float dust
--    (…539999997300). One-time round to cents; all write paths now round.

-- 1a. Backfill the catch-up close's missing retained debit row.
INSERT INTO union_wallet_transactions
  (union_id, amount, tx_type, wallet, direction, balance_after, notes, created_at)
SELECT 'fade0000-0000-0000-0000-000000000001', 109528.17, 'rake_hold', 'rake_wallet', 'debit',
       (SELECT round(rake_wallet,2) FROM union_wallets WHERE union_id='fade0000-0000-0000-0000-000000000001'),
       'BACKFILL: retained 10% + self-club rake redesignated out of rake_wallet (period 2026-04-01..2026-08-17) — pairs with the rake_hold chip_balance credit row',
       now()
WHERE NOT EXISTS (
  SELECT 1 FROM union_wallet_transactions
   WHERE union_id='fade0000-0000-0000-0000-000000000001'
     AND tx_type='rake_hold' AND wallet='rake_wallet' AND direction='debit'
);

-- 1b. Close fn now writes the retained redesignation on BOTH sides.
--     (Replace only the retained-row section; function body otherwise as in
--     union_weekly_close_selfhealing_and_index.)
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

  DROP TABLE IF EXISTS _uwrb;
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
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('critical', 'fn_union_weekly_rakeback_close',
      'Weekly union rakeback REJECTED: payout exceeds treasury — investigate before forcing',
      jsonb_build_object('union_id', p_union_id,
        'period_start', p_period_start, 'period_end', p_period_end,
        'payout', v_payout_total,
        'rake_wallet', v_wallet.rake_wallet, 'chip_balance', v_wallet.chip_balance));
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

  v_retained := round(v_period_total - v_payout_total, 2);
  v_rw_debit := LEAST(v_period_total, COALESCE(v_wallet.rake_wallet, 0));

  UPDATE union_wallets
     SET rake_wallet       = round(rake_wallet - v_rw_debit, 2),
         chip_balance      = round(chip_balance - v_payout_total, 2),
         total_settlements = round(COALESCE(total_settlements, 0) + v_payout_total, 2),
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
    -- Double-entry redesignation: OUT of the rake_wallet sub-account…
    INSERT INTO union_wallet_transactions
      (union_id, amount, tx_type, wallet, direction, balance_after, notes)
    VALUES
      (p_union_id, v_retained, 'rake_hold', 'rake_wallet', 'debit', v_new_rw,
       'Union 10% retained + self-club rake leaves the weekly rake treasury (period '
         || to_char(p_period_start, 'YYYY-MM-DD') || '..'
         || to_char(p_period_end, 'YYYY-MM-DD') || ')');
    -- …and INTO general funds (informational: chip_balance total unchanged).
    INSERT INTO union_wallet_transactions
      (union_id, amount, tx_type, wallet, direction, balance_after, notes)
    VALUES
      (p_union_id, v_retained, 'rake_hold', 'chip_balance', 'credit', v_new_cb,
       'Union 10% retained + self-club rake redesignated to general funds (period '
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

-- 2. The conservation sentinel.
CREATE OR REPLACE FUNCTION public.fn_union_treasury_selftest()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_u record;
  v_breaches jsonb := '[]'::jsonb;
  v_credits numeric; v_debits numeric; v_expected numeric; v_drift numeric;
  v_dups integer; v_retired_bal numeric; v_lapsed_unclosed boolean;
  v_tolerance numeric := 150; -- historical pre-atomic drift ceiling (measured 122.14)
  b jsonb;
BEGIN
  FOR v_u IN SELECT uw.union_id, uw.chip_balance, uw.rake_wallet, uw.promo_wallet
               FROM union_wallets uw
  LOOP
    IF v_u.chip_balance < 0 OR v_u.rake_wallet < 0 OR v_u.promo_wallet < 0 THEN
      v_breaches := v_breaches || jsonb_build_object('union_id', v_u.union_id,
        'check', 'non_negative_wallets', 'chip', v_u.chip_balance,
        'rake', v_u.rake_wallet, 'promo', v_u.promo_wallet);
    END IF;

    IF round(v_u.rake_wallet, 2) > round(v_u.chip_balance, 2) + 0.01 THEN
      v_breaches := v_breaches || jsonb_build_object('union_id', v_u.union_id,
        'check', 'rake_subaccount_within_bank',
        'rake_wallet', v_u.rake_wallet, 'chip_balance', v_u.chip_balance);
    END IF;

    SELECT COALESCE(SUM(amount) FILTER (WHERE direction='credit'), 0),
           COALESCE(SUM(amount) FILTER (WHERE direction='debit'), 0)
      INTO v_credits, v_debits
      FROM union_wallet_transactions
     WHERE union_id = v_u.union_id AND wallet = 'rake_wallet';
    v_expected := v_credits - v_debits;
    v_drift := round(v_u.rake_wallet - v_expected, 2);
    IF abs(v_drift) > v_tolerance THEN
      v_breaches := v_breaches || jsonb_build_object('union_id', v_u.union_id,
        'check', 'rake_wallet_ledger_reconciliation',
        'wallet', v_u.rake_wallet, 'ledger_expected', v_expected, 'drift', v_drift);
    END IF;

    SELECT (MAX(period_end) IS NOT NULL AND MAX(period_end) < date_trunc('week', now()))
      INTO v_lapsed_unclosed
      FROM union_rakeback_log WHERE union_id = v_u.union_id;
    IF COALESCE(v_lapsed_unclosed, false)
       AND EXISTS (SELECT 1 FROM union_wallet_transactions
                    WHERE union_id = v_u.union_id AND wallet='rake_wallet'
                      AND tx_type='rake' AND direction='credit'
                      AND created_at < date_trunc('week', now())
                      AND created_at >= (SELECT MAX(period_end) FROM union_rakeback_log
                                          WHERE union_id = v_u.union_id)) THEN
      v_breaches := v_breaches || jsonb_build_object('union_id', v_u.union_id,
        'check', 'lapsed_week_unclosed',
        'last_period_end', (SELECT MAX(period_end) FROM union_rakeback_log
                             WHERE union_id = v_u.union_id));
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO v_dups FROM (
    SELECT 1 FROM bbj_contributions WHERE hand_id IS NOT NULL
    GROUP BY pool_id, hand_id HAVING COUNT(*) > 1
  ) d;
  IF v_dups > 0 THEN
    v_breaches := v_breaches || jsonb_build_object('check', 'bbj_duplicate_hand_contributions', 'groups', v_dups);
  END IF;

  SELECT COALESCE(SUM(main_balance + backup_balance + promo_balance), 0)
    INTO v_retired_bal FROM bbj_pools WHERE status = 'retired';
  IF v_retired_bal <> 0 THEN
    v_breaches := v_breaches || jsonb_build_object('check', 'retired_pools_hold_money', 'total', v_retired_bal);
  END IF;

  IF EXISTS (SELECT 1 FROM bbj_pools WHERE main_balance < 0 OR backup_balance < 0 OR promo_balance < 0) THEN
    v_breaches := v_breaches || jsonb_build_object('check', 'negative_bbj_pool_balance');
  END IF;

  -- Durable, deduped alerts (one unresolved alert per check+union).
  FOR b IN SELECT * FROM jsonb_array_elements(v_breaches)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM financial_alerts
       WHERE source = 'fn_union_treasury_selftest' AND resolved IS NOT TRUE
         AND context->>'check' = b->>'check'
         AND COALESCE(context->>'union_id','') = COALESCE(b->>'union_id','')
    ) THEN
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical', 'fn_union_treasury_selftest',
              'Union treasury conservation breach: ' || (b->>'check'), b);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true,
    'healthy', jsonb_array_length(v_breaches) = 0,
    'breaches', v_breaches);
END $$;

REVOKE ALL ON FUNCTION public.fn_union_treasury_selftest() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_treasury_selftest() TO service_role;

-- 3. One-time cent rounding of stored wallet values.
UPDATE union_wallets
   SET chip_balance = round(chip_balance, 2),
       rake_wallet = round(rake_wallet, 2),
       promo_wallet = round(promo_wallet, 2),
       total_rake_collected = round(total_rake_collected, 2),
       total_settlements = round(total_settlements, 2)
 WHERE chip_balance <> round(chip_balance, 2)
    OR rake_wallet <> round(rake_wallet, 2)
    OR promo_wallet <> round(promo_wallet, 2)
    OR total_rake_collected <> round(total_rake_collected, 2)
    OR total_settlements <> round(total_settlements, 2);
