-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820020556 "weekly_close_pays_from_treasury_and_sentinel_invariant"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d6fde839ceb611440e04524a3c64cbe3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Companion to rake_lands_only_in_rake_treasury_not_union_bank.
--
-- Now that rake lands ONLY in the Rake Treasury, the weekly close must pay the
-- clubs OUT OF the treasury (that is where the chips are) and move only the
-- union's retained 10% into the Union Bank. Previously it debited chip_balance
-- for the payout, which under the new model would spend the union's own money
-- while leaving the held rake untouched.
--
-- Flow per close:
--   rake_wallet  -= period_total          (the whole week leaves trust)
--   clubs        += 90%                   (fn_credit_treasury per club)
--   chip_balance += retained 10%          (the union has now EARNED this)
--
-- The solvency guard also moves to the treasury, which is the account that
-- actually has to cover the payout.

CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close(
  p_union_id uuid, p_period_start timestamptz, p_period_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
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

  IF EXISTS (SELECT 1 FROM union_rakeback_log
              WHERE union_id = p_union_id AND period_start = p_period_start AND period_end = p_period_end) THEN
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
    LEFT JOIN union_clubs uc ON uc.union_id = t.union_id AND uc.club_id = t.club_id
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
    RETURN jsonb_build_object('success', true, 'clubs_paid', 0, 'period_rake', 0,
                              'total_rakeback', 0, 'union_retained', 0, 'note', 'no_rake');
  END IF;

  -- The treasury is the account that must cover the payout now.
  IF v_payout_total > COALESCE(v_wallet.rake_wallet, 0) THEN
    INSERT INTO financial_alerts (severity, source, message, context)
    VALUES ('critical', 'fn_union_weekly_rakeback_close',
      'Weekly union rakeback REJECTED: payout exceeds the rake treasury',
      jsonb_build_object('union_id', p_union_id, 'period_start', p_period_start,
        'period_end', p_period_end, 'payout', v_payout_total, 'rake_wallet', v_wallet.rake_wallet));
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_treasury',
      'payout', v_payout_total, 'rake_wallet', v_wallet.rake_wallet);
  END IF;

  FOR v_club IN SELECT club_id, rake_in, payout FROM _uwrb
                 WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0
  LOOP
    v_credit := fn_credit_treasury(
      v_club.club_id, v_club.payout,
      'Union weekly rakeback ' || to_char(p_period_start,'YYYY-MM-DD') || '..' || to_char(p_period_end,'YYYY-MM-DD'),
      jsonb_build_object('union_id', p_union_id, 'period_start', p_period_start,
                         'period_end', p_period_end, 'rake_basis', v_club.rake_in,
                         'rate', 'club_commission_rate'));
    IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'treasury credit failed for club %: %', v_club.club_id, v_credit;
    END IF;
    v_clubs_paid := v_clubs_paid + 1;
  END LOOP;

  v_retained := round(v_period_total - v_payout_total, 2);
  v_rw_debit := LEAST(v_period_total, COALESCE(v_wallet.rake_wallet, 0));

  -- Whole week leaves trust; only the retained share becomes union money.
  UPDATE union_wallets
     SET rake_wallet       = round(rake_wallet - v_rw_debit, 2),
         chip_balance      = round(chip_balance + v_retained, 2),
         total_settlements = round(COALESCE(total_settlements, 0) + v_payout_total, 2),
         updated_at        = now()
   WHERE union_id = p_union_id
   RETURNING rake_wallet, chip_balance INTO v_new_rw, v_new_cb;

  INSERT INTO union_wallet_transactions
    (union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes)
  SELECT p_union_id, club_id, payout, 'rakeback', 'rake_wallet', 'debit', v_new_rw,
         'Weekly 90% rakeback to club (period ' || to_char(p_period_start,'YYYY-MM-DD')
           || '..' || to_char(p_period_end,'YYYY-MM-DD') || ')'
    FROM _uwrb WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0;

  IF v_retained > 0 THEN
    INSERT INTO union_wallet_transactions
      (union_id, amount, tx_type, wallet, direction, balance_after, notes)
    VALUES
      (p_union_id, v_retained, 'rake_hold', 'rake_wallet', 'debit', v_new_rw,
       'Union retained share leaves the rake treasury (period '
         || to_char(p_period_start,'YYYY-MM-DD') || '..' || to_char(p_period_end,'YYYY-MM-DD') || ')'),
      (p_union_id, v_retained, 'rake_hold', 'chip_balance', 'credit', v_new_cb,
       'Union retained share earned into the Union Bank (period '
         || to_char(p_period_start,'YYYY-MM-DD') || '..' || to_char(p_period_end,'YYYY-MM-DD') || ')');
  END IF;

  INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
  VALUES (p_union_id, p_period_start, p_period_end, v_payout_total, now());

  RETURN jsonb_build_object('success', true, 'clubs_paid', v_clubs_paid,
    'period_rake', v_period_total, 'total_rakeback', v_payout_total,
    'union_retained', v_retained, 'rake_wallet_after', v_new_rw, 'chip_balance_after', v_new_cb);
END $$;

-- Sentinel: the "rake_wallet <= chip_balance" invariant described the old
-- sub-account model. They are independent accounts now, so it would fire on
-- every healthy union. Non-negativity is the invariant that survives.
CREATE OR REPLACE FUNCTION public.fn_union_treasury_selftest()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_u record; v_breaches jsonb := '[]'::jsonb;
  v_credits numeric; v_debits numeric; v_expected numeric; v_drift numeric;
  v_dups integer; v_retired_bal numeric; v_lapsed_unclosed boolean;
  v_tolerance numeric := 150; v_cons jsonb; v_lag jsonb; b jsonb;
BEGIN
  FOR v_u IN SELECT uw.union_id, uw.chip_balance, uw.rake_wallet, uw.promo_wallet FROM union_wallets uw
  LOOP
    IF v_u.chip_balance < 0 OR v_u.rake_wallet < 0 OR v_u.promo_wallet < 0 THEN
      v_breaches := v_breaches || jsonb_build_object('union_id', v_u.union_id,
        'check', 'non_negative_wallets', 'chip', v_u.chip_balance,
        'rake', v_u.rake_wallet, 'promo', v_u.promo_wallet);
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
      INTO v_lapsed_unclosed FROM union_rakeback_log WHERE union_id = v_u.union_id;
    IF COALESCE(v_lapsed_unclosed, false)
       AND EXISTS (SELECT 1 FROM union_wallet_transactions
                    WHERE union_id = v_u.union_id AND wallet='rake_wallet'
                      AND tx_type='rake' AND direction='credit'
                      AND created_at < date_trunc('week', now())
                      AND created_at >= (SELECT MAX(period_end) FROM union_rakeback_log WHERE union_id = v_u.union_id)) THEN
      v_breaches := v_breaches || jsonb_build_object('union_id', v_u.union_id, 'check', 'lapsed_week_unclosed');
    END IF;
  END LOOP;

  SELECT COUNT(*) INTO v_dups FROM (
    SELECT 1 FROM bbj_contributions WHERE hand_id IS NOT NULL GROUP BY pool_id, hand_id HAVING COUNT(*) > 1) d;
  IF v_dups > 0 THEN
    v_breaches := v_breaches || jsonb_build_object('check', 'bbj_duplicate_hand_contributions', 'groups', v_dups);
  END IF;

  SELECT COALESCE(SUM(main_balance + backup_balance + promo_balance), 0) INTO v_retired_bal
    FROM bbj_pools WHERE status = 'retired';
  IF v_retired_bal <> 0 THEN
    v_breaches := v_breaches || jsonb_build_object('check', 'retired_pools_hold_money', 'total', v_retired_bal);
  END IF;

  IF EXISTS (SELECT 1 FROM bbj_pools WHERE main_balance < 0 OR backup_balance < 0 OR promo_balance < 0) THEN
    v_breaches := v_breaches || jsonb_build_object('check', 'negative_bbj_pool_balance');
  END IF;

  v_cons := fn_bbj_conservation_check();
  IF (v_cons->>'healthy')::boolean IS NOT TRUE THEN
    v_breaches := v_breaches || jsonb_build_object('check', 'bbj_pool_conservation_drift',
      'drift_from_baseline', v_cons->>'drift_from_baseline');
  END IF;

  v_lag := fn_settler_lag_check();
  IF (v_lag->>'healthy')::boolean IS NOT TRUE THEN
    v_breaches := v_breaches || jsonb_build_object('check', 'rakeback_settler_lagging',
      'lag_hours', v_lag->>'lag_hours', 'backlog_rows', v_lag->>'backlog_rows');
  END IF;

  FOR b IN SELECT * FROM jsonb_array_elements(v_breaches)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM financial_alerts
                    WHERE source = 'fn_union_treasury_selftest' AND resolved IS NOT TRUE
                      AND context->>'check' = b->>'check'
                      AND COALESCE(context->>'union_id','') = COALESCE(b->>'union_id','')) THEN
      INSERT INTO financial_alerts (severity, source, message, context)
      VALUES ('critical', 'fn_union_treasury_selftest',
              'Union treasury conservation breach: ' || (b->>'check'), b);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'healthy', jsonb_array_length(v_breaches) = 0,
    'breaches', v_breaches, 'bbj_conservation', v_cons, 'settler_lag', v_lag);
END $$;

REVOKE ALL ON FUNCTION public.fn_union_treasury_selftest() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_treasury_selftest() TO service_role;
