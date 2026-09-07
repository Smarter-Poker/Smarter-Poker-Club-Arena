-- Enforce union finance access before reading wallets or alerts.
-- Reproduced unrelated authenticated access with the actual function in
-- pg_temp. Scoped probes pass; the report no longer runs the global
-- checkpoint/alert-writing self-test. Existing engine diagnostics remain.
CREATE OR REPLACE FUNCTION public.fn_union_money_report(p_union_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union_id uuid;
  v_w record;
  v_week_start timestamptz := public.fn_union_week_start(now());
  v_this_week numeric;
  v_pool record;
  v_clubs jsonb;
  v_closes jsonb;
  v_alerts jsonb;
BEGIN
  v_union_id := COALESCE(p_union_id, (SELECT id FROM unions
    WHERE public.fn_union_report_caller_ok(id) OR public.ca_can_oversee_union(id)
    ORDER BY created_at LIMIT 1));
  IF v_union_id IS NOT NULL AND NOT (
    public.fn_union_report_caller_ok(v_union_id) OR public.ca_can_oversee_union(v_union_id)
  ) THEN
    RAISE EXCEPTION 'not authorized for this union' USING ERRCODE = '42501';
  END IF;
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
           AND context->>'union_id' = v_union_id::text
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
    -- Reporting must not execute a global checkpoint/alert writer or expose
    -- other unions' diagnostics. The existing engine owns that self-test.
    'selftest', jsonb_build_object('checked', false, 'healthy', NULL,
      'reason', 'Global diagnostics run separately; open_alerts contains this union only'));
END $function$;

REVOKE ALL ON FUNCTION public.fn_union_money_report(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_union_money_report(uuid) TO authenticated,service_role;
