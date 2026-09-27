-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820130915 "fix_treasury_selftest_unbounded_bbj_dup_scan"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e29f2ab61316a36d7f7173a5f99ac228 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- 2026-08-20: fn_union_treasury_selftest has been FAILING EVERY SETTLER CYCLE
-- with 'canceling statement due to statement timeout' (HTTP 500 in the
-- PostgREST logs at 13:00:08 and 13:04:36, and every cycle before that). The
-- union treasury conservation sentinel — the check that exists specifically
-- to catch chips being destroyed — has therefore not run at all, and no
-- financial_alerts could be raised by it.
--
-- Cause: the BBJ duplicate-contribution check grouped the ENTIRE
-- bbj_contributions table (212 MB and growing by ~30,700 rows/day):
--   SELECT 1 FROM bbj_contributions WHERE hand_id IS NOT NULL
--    GROUP BY pool_id, hand_id HAVING COUNT(*) > 1
-- An unbounded aggregate over a table that only ever grows is guaranteed to
-- cross the statement timeout eventually — the same failure mode as the
-- unbounded wallet_transactions scans that took production down on
-- 2026-08-19.
--
-- Fix: bound it to the last 7 days. The sentinel runs every 30 minutes, so a
-- duplicate is detected within half an hour of being written and raises a
-- durable financial_alerts row; re-scanning years of history on every cycle
-- adds no detection power. Measured after bounding: 0.41s over 2 days,
-- 0 duplicate groups.
--
-- Everything else in the function is left byte-identical.
CREATE OR REPLACE FUNCTION public.fn_union_treasury_selftest()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- BOUNDED 2026-08-20: was an unbounded GROUP BY over all of
  -- bbj_contributions, which timed out and killed the whole sentinel.
  SELECT COUNT(*) INTO v_dups FROM (
    SELECT 1 FROM bbj_contributions
     WHERE hand_id IS NOT NULL
       AND created_at > now() - interval '7 days'
     GROUP BY pool_id, hand_id HAVING COUNT(*) > 1) d;
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
END $function$;
