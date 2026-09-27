-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819210824 "selftest_v2_bbj_conservation_and_union_money_report"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ca4fcb7aed72cc7669d30c42593d4119 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- AUDIT PASS 3 — (a) sentinel gains BBJ pool conservation vs the recorded
-- baseline, (b) one reporting RPC powering the union money dashboard.

CREATE OR REPLACE FUNCTION public.fn_bbj_conservation_check()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_in numeric; v_out numeric; v_bal numeric; v_gap numeric; v_base record;
BEGIN
  SELECT COALESCE(SUM(amount),0) INTO v_in FROM bbj_contributions;
  v_in := v_in + (SELECT COALESCE(SUM(amount),0) FROM union_wallet_transactions WHERE tx_type='bbj_fund');

  v_out := (SELECT COALESCE(SUM(total_amount),0) FROM bbj_payouts)
         + (SELECT COALESCE(SUM(amount),0) FROM union_wallet_transactions WHERE tx_type='bbj_promo_sweep')
         + (SELECT COALESCE(SUM(amount),0) FROM chip_transactions WHERE transaction_type='bbj_promo_sweep')
         + (SELECT COALESCE(SUM(amount),0) FROM wallet_transactions
             WHERE category='promotion' AND description='BBJ promo pool payout');

  SELECT COALESCE(SUM(main_balance+backup_balance+promo_balance),0) INTO v_bal FROM bbj_pools;

  v_gap := round(v_in - v_out - v_bal, 2);
  SELECT * INTO v_base FROM bbj_conservation_baseline WHERE id = 1;

  RETURN jsonb_build_object(
    'inflow', round(v_in,2), 'outflow', round(v_out,2), 'balances', round(v_bal,2),
    'gap', v_gap,
    'baseline_gap', COALESCE(v_base.baseline_gap, 0),
    'drift_from_baseline', round(v_gap - COALESCE(v_base.baseline_gap, 0), 2),
    'tolerance', COALESCE(v_base.tolerance, 1.00),
    'healthy', abs(v_gap - COALESCE(v_base.baseline_gap, 0)) <= COALESCE(v_base.tolerance, 1.00));
END $$;

REVOKE ALL ON FUNCTION public.fn_bbj_conservation_check() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_conservation_check() TO service_role;

-- ─── Sentinel v2: all previous checks + BBJ conservation drift ─────────────
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

  -- AUDIT PASS 3: BBJ pool conservation. Alerts only when the gap MOVES off
  -- the recorded historical baseline — i.e. NEW loss, not old history.
  v_cons := fn_bbj_conservation_check();
  IF (v_cons->>'healthy')::boolean IS NOT TRUE THEN
    v_breaches := v_breaches || jsonb_build_object(
      'check', 'bbj_pool_conservation_drift',
      'drift_from_baseline', v_cons->>'drift_from_baseline',
      'gap', v_cons->>'gap', 'baseline_gap', v_cons->>'baseline_gap');
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
    'bbj_conservation', v_cons);
END $$;

REVOKE ALL ON FUNCTION public.fn_union_treasury_selftest() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_treasury_selftest() TO service_role;

-- ─── Union money report (dashboard / on-demand answer to "is it correct?") ──
CREATE OR REPLACE FUNCTION public.fn_union_money_report(p_union_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_union_id uuid;
  v_w record;
  v_week_start timestamptz := date_trunc('week', now());
  v_this_week numeric;
  v_pool record;
  v_clubs jsonb;
  v_closes jsonb;
  v_alerts jsonb;
BEGIN
  v_union_id := COALESCE(p_union_id, (SELECT id FROM unions ORDER BY created_at LIMIT 1));
  IF v_union_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_union');
  END IF;

  SELECT round(chip_balance,2) chip_balance, round(rake_wallet,2) rake_wallet,
         round(promo_wallet,2) promo_wallet, round(total_rake_collected,2) total_rake_collected,
         round(total_settlements,2) total_settlements
    INTO v_w FROM union_wallets WHERE union_id = v_union_id;

  SELECT COALESCE(SUM(amount),0) INTO v_this_week
    FROM union_wallet_transactions
   WHERE union_id = v_union_id AND wallet='rake_wallet' AND direction='credit'
     AND tx_type='rake' AND created_at >= v_week_start;

  SELECT round(main_balance,2) main_balance, round(backup_balance,2) backup_balance,
         round(promo_balance,2) promo_balance, hands_contributed, hit_count,
         round(total_contributed,2) total_contributed, round(total_paid_out,2) total_paid_out
    INTO v_pool FROM bbj_pools
   WHERE union_id = v_union_id AND status='active' LIMIT 1;

  -- Per-club rake this week + what each is owed at the next close.
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'club_name'), '[]'::jsonb) INTO v_clubs FROM (
    SELECT jsonb_build_object(
             'club_id', c.id, 'club_name', c.name,
             'rate', COALESCE(uc.club_commission_rate, 0.90),
             'rake_this_week', round(COALESCE(t.amt,0),2),
             'projected_rakeback', trunc(COALESCE(t.amt,0) * COALESCE(uc.club_commission_rate,0.90) * 100)/100,
             'treasury', round(COALESCE(c.chip_treasury,0),2)) AS x
      FROM clubs c
      LEFT JOIN union_clubs uc ON uc.union_id = v_union_id AND uc.club_id = c.id
      LEFT JOIN (
        SELECT club_id, SUM(amount) amt FROM union_wallet_transactions
         WHERE union_id = v_union_id AND wallet='rake_wallet' AND direction='credit'
           AND tx_type='rake' AND created_at >= v_week_start
         GROUP BY club_id) t ON t.club_id = c.id
     WHERE c.union_id = v_union_id AND c.id <> v_union_id
  ) s;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'period_start', period_start, 'period_end', period_end,
           'total_rakeback', round(total_rakeback,2), 'executed_at', executed_at)
         ORDER BY period_start DESC), '[]'::jsonb) INTO v_closes
    FROM (SELECT * FROM union_rakeback_log WHERE union_id = v_union_id
           ORDER BY period_start DESC LIMIT 12) l;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'severity', severity, 'source', source, 'message', message, 'created_at', created_at)
         ORDER BY created_at DESC), '[]'::jsonb) INTO v_alerts
    FROM (SELECT * FROM financial_alerts WHERE resolved IS NOT TRUE
           ORDER BY created_at DESC LIMIT 10) a;

  RETURN jsonb_build_object(
    'success', true,
    'union_id', v_union_id,
    'generated_at', now(),
    'week_start', v_week_start,
    'wallet', jsonb_build_object(
      'union_bank', v_w.chip_balance, 'rake_treasury', v_w.rake_wallet,
      'promo_wallet', v_w.promo_wallet, 'lifetime_rake', v_w.total_rake_collected,
      'lifetime_rakeback_paid', v_w.total_settlements),
    'rake_this_week', round(v_this_week,2),
    'projected_close', jsonb_build_object(
      'clubs_share', trunc(v_this_week * 0.90 * 100)/100,
      'union_share', round(v_this_week - trunc(v_this_week * 0.90 * 100)/100, 2),
      'next_close_after', v_week_start + interval '7 days'),
    'bbj', jsonb_build_object(
      'main', v_pool.main_balance, 'backup', v_pool.backup_balance,
      'promo_in_pool', v_pool.promo_balance,
      'hands_contributed', v_pool.hands_contributed, 'hits', v_pool.hit_count,
      'lifetime_contributed', v_pool.total_contributed,
      'lifetime_paid_out', v_pool.total_paid_out,
      'split', '50/25/25 main/backup/promo (30/40/30 above 100k main)'),
    'clubs', v_clubs,
    'recent_closes', v_closes,
    'open_alerts', v_alerts,
    'selftest', fn_union_treasury_selftest());
END $$;

REVOKE ALL ON FUNCTION public.fn_union_money_report(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_money_report(uuid) TO service_role, authenticated;
