-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820161409 "treasury_selftest_use_ledger_checkpoint"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7aced12c20d5d58ffc60e5502787c4d7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_union_treasury_selftest()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
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

    -- CHECKPOINTED 2026-08-20: was an unbounded SUM over every rake_wallet
    -- row ever written (609k rows, +69k/day, no index) which had crossed
    -- the statement timeout and was aborting this whole sentinel every
    -- cycle. The full recompute now runs at most once per 24h and alerts
    -- if the incremental total ever disagrees with it.
    IF NOT EXISTS (SELECT 1 FROM union_rake_ledger_checkpoint c
                    WHERE c.union_id = v_u.union_id
                      AND c.last_verified_at > now() - interval '24 hours') THEN
      PERFORM fn_union_rake_ledger_checkpoint_verify(v_u.union_id);
    END IF;

    SELECT g.total_credits, g.total_debits
      INTO v_credits, v_debits
      FROM fn_union_rake_ledger_totals(v_u.union_id) g;

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
END
$function$;
