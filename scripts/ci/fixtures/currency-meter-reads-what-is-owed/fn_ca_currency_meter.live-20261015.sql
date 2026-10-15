CREATE OR REPLACE FUNCTION public.fn_ca_currency_meter()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t0 timestamptz := clock_timestamp();
  v_out numeric; v_journal numeric; v_accounts int; v_drifted int; v_worst numeric; v_detail jsonb;
  v_res jsonb := '{}'::jsonb;
  v_rb_periods_paid numeric; v_rb_payout_rows numeric; v_rb_legs numeric; v_rb_pending numeric;
  v_rb_orphans int; v_rb_deletes int; v_rb_first_leg timestamptz;
BEGIN
  IF NOT (current_user IN ('postgres', 'supabase_admin') OR COALESCE(auth.role(), '') = 'service_role') THEN
    RAISE EXCEPTION 'fn_ca_currency_meter is service only' USING ERRCODE = '42501';
  END IF;

  /* VIP POINTS: every balance against the sum of its legs. Enforced. */
  WITH j AS (SELECT user_id, sum(points) AS journal, sum(points) FILTER (WHERE points > 0) AS earned FROM public.vip_points_ledger GROUP BY 1)
  SELECT COALESCE(sum(v.current_points), 0), COALESCE(sum(j.journal), 0), count(*),
         count(*) FILTER (WHERE COALESCE(j.journal, 0) <> COALESCE(v.current_points, 0) OR COALESCE(j.earned, 0) <> COALESCE(v.lifetime_points, 0)),
         COALESCE(max(abs(COALESCE(j.journal, 0) - COALESCE(v.current_points, 0))), 0),
         jsonb_build_object(
           'balance_without_journal', count(*) FILTER (WHERE j.user_id IS NULL),
           'journal_without_balance', count(*) FILTER (WHERE v.user_id IS NULL),
           'sample', COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id', x.uid, 'balance', x.bal, 'journal', x.jr)) FROM (
              SELECT COALESCE(v2.user_id, j2.user_id) AS uid, v2.current_points AS bal, j2.journal AS jr
                FROM public.vip_points v2 FULL JOIN j j2 ON j2.user_id = v2.user_id
               WHERE COALESCE(j2.journal, 0) <> COALESCE(v2.current_points, 0) LIMIT 10) x), '[]'::jsonb))
    INTO v_out, v_journal, v_accounts, v_drifted, v_worst, v_detail
    FROM public.vip_points v FULL JOIN j ON j.user_id = v.user_id;
  INSERT INTO public.ca_currency_meter (currency, outstanding, journal_total, accounts, drifted, worst, enforced, detail)
  VALUES ('vip_points', v_out, v_journal, v_accounts, v_drifted, v_worst, true, v_detail);
  IF v_drifted > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_currency_meter', 'ledger_imbalance', 'critical', 'currency-drift:vip_points',
      v_out - v_journal, v_journal, v_out, 'ledger', 'vip_points',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      v_drifted || ' VIP balance(s) disagree with their own ledger (worst ' || v_worst || ' points). '
        || 'zz_vip_points_move_only_with_a_leg and the append-only guard on vip_points_ledger make this '
        || 'impossible through the doors; seeing it means a guard was bypassed or dropped.',
      false, v_detail);
  END IF;
  v_res := v_res || jsonb_build_object('vip_points', jsonb_build_object('outstanding', v_out, 'journal', v_journal, 'accounts', v_accounts, 'drifted', v_drifted, 'worst', v_worst));

  /* AGENT COMMISSIONS: every rollup against the sum of its unsettled rows. Enforced. */
  WITH u AS (SELECT club_id, user_id, sum(amount) AS owed FROM public.agent_commissions_unsettled GROUP BY 1, 2)
  SELECT COALESCE(sum(r.owed), 0), COALESCE(sum(u.owed), 0), count(*),
         count(*) FILTER (WHERE round(COALESCE(u.owed, 0), 2) <> round(COALESCE(r.owed, 0), 2)),
         COALESCE(max(abs(COALESCE(u.owed, 0) - COALESCE(r.owed, 0))), 0),
         jsonb_build_object(
           'journal_without_rollup', count(*) FILTER (WHERE r.club_id IS NULL),
           'rollup_without_journal', count(*) FILTER (WHERE u.club_id IS NULL))
    INTO v_out, v_journal, v_accounts, v_drifted, v_worst, v_detail
    FROM u FULL JOIN public.agent_commission_unsettled_rollup r ON r.club_id = u.club_id AND r.user_id = u.user_id;
  INSERT INTO public.ca_currency_meter (currency, outstanding, journal_total, accounts, drifted, worst, enforced, detail)
  VALUES ('agent_commissions', v_out, v_journal, v_accounts, v_drifted, v_worst, true, v_detail);
  IF v_drifted > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_currency_meter', 'ledger_imbalance', 'critical', 'currency-drift:agent_commissions',
      v_out - v_journal, v_journal, v_out, 'ledger', 'agent_commissions',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      v_drifted || ' agent(s) whose unsettled rollup disagrees with their commission rows (worst ' || round(v_worst, 2) || '). '
        || 'The rollup is kept by statement triggers and the rows are append-only; seeing it means one of those was bypassed.',
      false, v_detail);
  END IF;
  v_res := v_res || jsonb_build_object('agent_commissions', jsonb_build_object('outstanding', v_out, 'journal', v_journal, 'accounts', v_accounts, 'drifted', v_drifted, 'worst', v_worst));

  /* RAKEBACK: three sources side by side. NOT enforced - the period row is a
     counter that accrues by design, and the payout path is another lane's. */
  SELECT COALESCE(sum(rakeback_amount) FILTER (WHERE status = 'paid'), 0),
         COALESCE(sum(rakeback_amount) FILTER (WHERE status <> 'paid'), 0)
    INTO v_rb_periods_paid, v_rb_pending FROM public.rakeback_periods;
  SELECT COALESCE(sum(payout_amount), 0) INTO v_rb_payout_rows FROM public.rakeback_period_payouts WHERE status = 'paid';
  SELECT COALESCE(sum(amount), 0), min(created_at) INTO v_rb_legs, v_rb_first_leg
    FROM public.chip_ledger WHERE category = 'rakeback' AND to_type = 'player_wallet';
  /* Only periods that closed AFTER the opening position. The block before
     it is recorded in ca_rakeback_baseline, reconciled to the cent, and does
     not need re-deriving every forty minutes. */
  SELECT count(*) INTO v_rb_orphans FROM public.rakeback_periods p
   WHERE p.status = 'paid' AND p.rakeback_amount > 0
     AND p.created_at > COALESCE((SELECT b.known_through FROM public.ca_rakeback_baseline b WHERE b.id = 1),
                                 '-infinity'::timestamptz)
     AND NOT EXISTS (SELECT 1 FROM public.rakeback_period_payouts pp WHERE pp.rakeback_period_id = p.id);
  SELECT count(*) INTO v_rb_deletes FROM public.ca_ledger_mutation_log
   WHERE source_table = 'rakeback_period_payouts' AND at > now() - interval '1 day';
  v_detail := jsonb_build_object(
    'periods_paid_total', v_rb_periods_paid, 'payout_rows_total', v_rb_payout_rows,
    'chip_legs_to_players_total', v_rb_legs, 'chip_journal_since', v_rb_first_leg,
    'paid_periods_without_payout_row', v_rb_orphans, 'payout_rows_deleted_24h', v_rb_deletes,
    'not_enforced_because', 'rakeback_periods accrues during the period by design and the payout path (fn_close_settlement_period) is another lane''s live rebuild as of 2026-09-07; the meter reads the three sources and names the gap');
  INSERT INTO public.ca_currency_meter (currency, outstanding, journal_total, accounts, drifted, worst, enforced, detail)
  VALUES ('rakeback', v_rb_pending, v_rb_payout_rows, 0,
          CASE WHEN round(v_rb_periods_paid, 2) <> round(v_rb_payout_rows, 2) THEN 1 ELSE 0 END,
          abs(v_rb_periods_paid - v_rb_payout_rows), false, v_detail);
  IF round(v_rb_periods_paid, 2)
       <> round(v_rb_payout_rows
                + COALESCE((SELECT b.known_orphan_amount + b.known_unpayable_amount
                              FROM public.ca_rakeback_baseline b WHERE b.id = 1), 0), 2)
     OR v_rb_orphans > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_currency_meter', 'ledger_imbalance', 'warning', 'currency-drift:rakeback',
      v_rb_periods_paid - v_rb_payout_rows, v_rb_payout_rows, v_rb_periods_paid, 'ledger', 'rakeback_periods',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'rakeback_periods says ' || v_rb_periods_paid || ' paid; rakeback_period_payouts says ' || v_rb_payout_rows
        || '; chip_ledger legs to players say ' || v_rb_legs || ' since ' || COALESCE(v_rb_first_leg::text, 'never')
        || '. ' || v_rb_orphans || ' paid period(s) have no payout row. Not enforced by this meter; see detail.',
      false, v_detail);
  END IF;
  v_res := v_res || jsonb_build_object('rakeback', v_detail || jsonb_build_object('pending', v_rb_pending));

  RETURN v_res || jsonb_build_object('at', now(), 'ms', round(extract(epoch from (clock_timestamp() - v_t0)) * 1000));
END $function$
