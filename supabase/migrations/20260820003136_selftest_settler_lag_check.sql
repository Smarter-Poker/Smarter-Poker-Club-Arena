-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820003136 "selftest_settler_lag_check"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b3328c95b2b92a5e5df9dd5271e79761 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The settler fell ~2 days behind and NOTHING said so. Every existing check
-- was about money being wrong; none was about money being LATE. Rake is banked
-- at hand time, so nothing was lost — but per-player rakeback attribution and
-- agent commission accrual silently stopped tracking reality for two days, and
-- the only reason it was noticed is that I happened to measure the cursor.
--
-- This adds the missing alarm: the sentinel now flags when the settler's
-- durable cursor falls more than 6 hours behind now(), or when the daemon has
-- not saved a cursor in over an hour while backlog exists. Either condition
-- would have fired on 2026-08-17 instead of being found on the 19th.

CREATE OR REPLACE FUNCTION public.fn_settler_lag_check()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cursor timestamptz;
  v_saved  timestamptz;
  v_lag_h  numeric;
  v_stale_h numeric;
  v_backlog bigint;
BEGIN
  SELECT high_water_mark, updated_at INTO v_cursor, v_saved
    FROM daemon_state WHERE daemon = 'rakeback_settler';

  IF v_cursor IS NULL THEN
    RETURN jsonb_build_object('healthy', true, 'note', 'no settler cursor yet');
  END IF;

  v_lag_h   := round(EXTRACT(epoch FROM (now() - v_cursor)) / 3600.0, 2);
  v_stale_h := round(EXTRACT(epoch FROM (now() - v_saved))  / 3600.0, 2);
  SELECT COUNT(*) INTO v_backlog FROM rake_records WHERE created_at > v_cursor;

  RETURN jsonb_build_object(
    'healthy', (v_lag_h <= 6 AND NOT (v_stale_h > 1 AND v_backlog > 1000)),
    'cursor', v_cursor,
    'lag_hours', v_lag_h,
    'last_save_hours_ago', v_stale_h,
    'backlog_rows', v_backlog);
END $$;

REVOKE ALL ON FUNCTION public.fn_settler_lag_check() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settler_lag_check() TO service_role;

-- Fold it into the sentinel the engine already runs every cycle.
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
  v_tolerance numeric := 150;
  v_cons jsonb;
  v_lag jsonb;
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

  v_cons := fn_bbj_conservation_check();
  IF (v_cons->>'healthy')::boolean IS NOT TRUE THEN
    v_breaches := v_breaches || jsonb_build_object(
      'check', 'bbj_pool_conservation_drift',
      'drift_from_baseline', v_cons->>'drift_from_baseline',
      'gap', v_cons->>'gap', 'baseline_gap', v_cons->>'baseline_gap');
  END IF;

  -- NEW: money being LATE is its own failure mode. Nothing watched for it, so
  -- a 2-day rakeback/commission lag went unnoticed until someone measured.
  v_lag := fn_settler_lag_check();
  IF (v_lag->>'healthy')::boolean IS NOT TRUE THEN
    v_breaches := v_breaches || jsonb_build_object(
      'check', 'rakeback_settler_lagging',
      'lag_hours', v_lag->>'lag_hours',
      'last_save_hours_ago', v_lag->>'last_save_hours_ago',
      'backlog_rows', v_lag->>'backlog_rows');
  END IF;

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
    'breaches', v_breaches,
    'bbj_conservation', v_cons,
    'settler_lag', v_lag);
END $$;

REVOKE ALL ON FUNCTION public.fn_union_treasury_selftest() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_treasury_selftest() TO service_role;
