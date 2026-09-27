-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820033752 "union_settle_anchor_baseline_at_start_and_always_invoice"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fa2e4ec1e43930b9a229abfdf4040b9b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.
-- unqualified-write-ok: _pnl_tmp because it is a temporary table the same function builds and
--   empties; this file records SQL production already executed as 20260820033752, and no live
--   function body carries this statement any more (pg_proc read 2026-09-27).


-- (A) anchor the opening seated-stack baseline at the START of the period, and
-- (C) guarantee every member club has a period row so it always gets an invoice.
CREATE OR REPLACE FUNCTION public.fn_union_settle_player_pnl(
  p_union_id uuid, p_start timestamptz, p_end timestamptz, p_dry_run boolean DEFAULT false)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_settlement_id uuid; v_prev jsonb; r record;
  v_results jsonb := '[]'::jsonb;
  v_collect_total numeric := 0; v_pay_total numeric := 0; v_unpaid_total numeric := 0;
  v_treasury numeric; v_take numeric; v_union_balance numeric; v_pay numeric; v_owed numeric;
  v_period_id uuid; v_scale numeric := 1; v_winners_total numeric := 0; v_residual numeric := 0;
BEGIN
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_arguments');
  END IF;
  IF p_end <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_period');
  END IF;

  -- (A) FIX: was p_end. The baseline is the state at the OPENING of the window;
  -- passing p_end let a baseline taken inside the window become "seated_start".
  v_prev := fn_union_pnl_baseline(p_union_id, p_start);

  CREATE TEMP TABLE IF NOT EXISTS _pnl_tmp (
    club_id uuid, net numeric, seated numeric, detail jsonb) ON COMMIT DROP;
  DELETE FROM _pnl_tmp;

  INSERT INTO _pnl_tmp (club_id, net, seated, detail)
  SELECT c.club_id,
         round(c.realized_net + (c.seated_stack - base.seated_start) + COALESCE(rk.rake_paid, 0), 2),
         c.seated_stack,
         jsonb_build_object(
           'club_id', c.club_id, 'buyins', c.buyins, 'cashouts', c.cashouts,
           'realized_net', c.realized_net, 'winnings', c.winnings, 'losses', c.losses,
           'players', c.players,
           'seated_start', base.seated_start, 'seated_end', c.seated_stack,
           'stack_delta', round(c.seated_stack - base.seated_start, 2),
           'rake_paid', COALESCE(rk.rake_paid, 0),
           'net', round(c.realized_net + (c.seated_stack - base.seated_start) + COALESCE(rk.rake_paid, 0), 2))
    FROM fn_union_pnl_all_clubs(p_union_id, p_start, p_end, true) c
    -- (B) same population as the P&L above: horses included.
    LEFT JOIN fn_union_rake_paid_by_club(p_union_id, p_start, p_end, true) rk ON rk.club_id = c.club_id
    CROSS JOIN LATERAL (
      SELECT COALESCE(
        (SELECT (e->>'seated_end')::numeric FROM jsonb_array_elements(COALESCE(v_prev,'[]'::jsonb)) e
          WHERE (e->>'club_id') = c.club_id::text LIMIT 1),
        c.seated_stack) AS seated_start
    ) base;

  SELECT COALESCE(round(SUM(net), 2), 0) INTO v_residual FROM _pnl_tmp;

  IF p_dry_run THEN
    SELECT jsonb_agg(detail ORDER BY club_id) INTO v_results FROM _pnl_tmp;
    RETURN jsonb_build_object('success', true, 'dry_run', true, 'union_id', p_union_id,
      'house_residual', v_residual, 'imbalance', v_residual,
      'clubs', COALESCE(v_results, '[]'::jsonb));
  END IF;

  UPDATE union_pnl_settlements SET status = 'superseded'
   WHERE union_id = p_union_id AND period_start = p_start AND status = 'needs_review';

  BEGIN
    INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status)
    VALUES (p_union_id, p_start, p_end, 'in_progress') RETURNING id INTO v_settlement_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', true, 'already_settled', true,
                              'union_id', p_union_id, 'period_start', p_start);
  END;

  -- (C) FIX: every club in the settlement gets a period row for THIS window, so
  -- the invoice below is never silently skipped (Club JAQK had no row at all and
  -- would have been settled in chips with no invoice ever written).
  INSERT INTO settlement_periods (club_id, union_id, period_number, year, start_at, end_at, status)
  SELECT t.club_id, p_union_id,
         EXTRACT(week FROM p_start)::int, EXTRACT(isoyear FROM p_start)::int,
         p_start, p_end, 'processing'
    FROM _pnl_tmp t
   WHERE NOT EXISTS (
     SELECT 1 FROM settlement_periods sp
      WHERE sp.club_id = t.club_id AND sp.union_id = p_union_id
        AND sp.start_at = p_start AND sp.end_at = p_end);

  SELECT chip_balance INTO v_union_balance FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_union_balance IS NULL THEN
    INSERT INTO union_wallets (union_id, chip_balance) VALUES (p_union_id, 0)
      ON CONFLICT (union_id) DO NOTHING;
    SELECT chip_balance INTO v_union_balance FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
    v_union_balance := COALESCE(v_union_balance, 0);
  END IF;

  FOR r IN SELECT * FROM _pnl_tmp WHERE net < 0 ORDER BY club_id LOOP
    v_owed := round(-r.net, 2);
    SELECT chip_treasury INTO v_treasury FROM clubs WHERE id = r.club_id FOR UPDATE;
    v_take := LEAST(v_owed, GREATEST(COALESCE(v_treasury, 0), 0));
    IF v_take > 0 THEN
      UPDATE clubs SET chip_treasury = chip_treasury - v_take WHERE id = r.club_id;
      v_union_balance := v_union_balance + v_take;
      UPDATE union_wallets SET chip_balance = v_union_balance WHERE union_id = p_union_id;
      v_collect_total := v_collect_total + v_take;
      INSERT INTO union_wallet_transactions (union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes)
      VALUES (p_union_id, 'chip_balance', 'credit', v_take, v_union_balance, 'player_pnl_collect', r.club_id,
              'Weekly player P&L: collected from club (owed ' || v_owed || ')');
      INSERT INTO chip_transactions (club_id, amount, transaction_type, notes, metadata)
      VALUES (r.club_id, v_take, 'union_pnl_collect',
              'Weekly union player P&L settlement: club owed ' || v_owed,
              jsonb_build_object('union_id', p_union_id, 'settlement_id', v_settlement_id,
                                 'period_start', p_start, 'net', r.net));
    END IF;

    SELECT id INTO v_period_id FROM settlement_periods
      WHERE club_id = r.club_id AND union_id = p_union_id
        AND start_at = p_start AND end_at = p_end
      ORDER BY created_at DESC LIMIT 1;
    IF v_period_id IS NULL THEN
      RAISE EXCEPTION 'settlement period row missing for club % in window % .. %', r.club_id, p_start, p_end;
    END IF;
    INSERT INTO settlement_invoices (club_id, period_id, invoice_type, from_entity_type, from_entity_id,
      to_entity_type, to_entity_id, gross_amount, net_amount, deductions, breakdown, status,
      chips_transferred, transferred_at, notes)
    VALUES (r.club_id, v_period_id, 'union_club_pnl', 'club', r.club_id::text, 'union', p_union_id::text,
      v_owed, v_take, round(v_owed - v_take, 2),
      r.detail || jsonb_build_object('direction','club_owes_union','collected',v_take,
                                     'shortfall', round(v_owed - v_take, 2)),
      CASE WHEN v_take >= v_owed THEN 'paid' ELSE 'pending' END,
      v_take > 0, CASE WHEN v_take > 0 THEN now() ELSE NULL END,
      CASE WHEN v_take < v_owed THEN 'Partial: club treasury short by ' || round(v_owed - v_take, 2) ELSE NULL END);
    v_unpaid_total := v_unpaid_total + round(v_owed - v_take, 2);
  END LOOP;

  SELECT COALESCE(SUM(net), 0) INTO v_winners_total FROM _pnl_tmp WHERE net > 0;
  IF v_winners_total > 0 AND v_union_balance < v_winners_total THEN
    v_scale := GREATEST(v_union_balance, 0) / v_winners_total;
  END IF;

  FOR r IN SELECT * FROM _pnl_tmp WHERE net > 0 ORDER BY club_id LOOP
    v_owed := round(r.net, 2);
    v_pay := LEAST(round(v_owed * v_scale, 2), GREATEST(v_union_balance, 0));
    IF v_pay > 0 THEN
      UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) + v_pay WHERE id = r.club_id;
      v_union_balance := v_union_balance - v_pay;
      UPDATE union_wallets SET chip_balance = v_union_balance WHERE union_id = p_union_id;
      v_pay_total := v_pay_total + v_pay;
      INSERT INTO union_wallet_transactions (union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes)
      VALUES (p_union_id, 'chip_balance', 'debit', v_pay, v_union_balance, 'player_pnl_pay', r.club_id,
              'Weekly player P&L: paid to club (owed ' || v_owed || ')');
      INSERT INTO chip_transactions (club_id, amount, transaction_type, notes, metadata)
      VALUES (r.club_id, v_pay, 'union_pnl_payout',
              'Weekly union player P&L settlement: union owed ' || v_owed,
              jsonb_build_object('union_id', p_union_id, 'settlement_id', v_settlement_id,
                                 'period_start', p_start, 'net', r.net));
    END IF;

    SELECT id INTO v_period_id FROM settlement_periods
      WHERE club_id = r.club_id AND union_id = p_union_id
        AND start_at = p_start AND end_at = p_end
      ORDER BY created_at DESC LIMIT 1;
    IF v_period_id IS NULL THEN
      RAISE EXCEPTION 'settlement period row missing for club % in window % .. %', r.club_id, p_start, p_end;
    END IF;
    INSERT INTO settlement_invoices (club_id, period_id, invoice_type, from_entity_type, from_entity_id,
      to_entity_type, to_entity_id, gross_amount, net_amount, deductions, breakdown, status,
      chips_transferred, transferred_at, notes)
    VALUES (r.club_id, v_period_id, 'union_club_pnl', 'union', p_union_id::text, 'club', r.club_id::text,
      v_owed, v_pay, round(v_owed - v_pay, 2),
      r.detail || jsonb_build_object('direction','union_owes_club','paid',v_pay,
                                     'shortfall', round(v_owed - v_pay, 2)),
      CASE WHEN v_pay >= v_owed THEN 'paid' ELSE 'pending' END,
      v_pay > 0, CASE WHEN v_pay > 0 THEN now() ELSE NULL END,
      CASE WHEN v_pay < v_owed THEN 'Partial: union chip wallet short by ' || round(v_owed - v_pay, 2) ELSE NULL END);
    v_unpaid_total := v_unpaid_total + round(v_owed - v_pay, 2);
  END LOOP;

  IF abs(v_residual) >= 0.01 THEN
    INSERT INTO union_wallet_transactions (union_id, wallet, direction, amount, balance_after, tx_type, notes)
    VALUES (p_union_id, 'chip_balance',
            CASE WHEN v_residual < 0 THEN 'credit' ELSE 'debit' END,
            abs(v_residual), v_union_balance, 'player_pnl_house_residual',
            'Net real-player vs house-horse flow for the period, absorbed by the union '
            || 'as clearing house (settlement ' || v_settlement_id || ')');
  END IF;

  UPDATE settlement_periods sp
     SET total_player_winnings = COALESCE((t.detail->>'winnings')::numeric, 0),
         total_player_losses   = COALESCE((t.detail->>'losses')::numeric, 0),
         seated_stack_snapshot = t.seated,
         status = 'settled',
         settled_at = now()
    FROM _pnl_tmp t
   WHERE sp.club_id = t.club_id AND sp.union_id = p_union_id
     AND sp.start_at = p_start AND sp.end_at = p_end;

  SELECT jsonb_agg(detail ORDER BY club_id) INTO v_results FROM _pnl_tmp;
  UPDATE union_pnl_settlements
     SET status='settled', total_collected=v_collect_total, total_paid=v_pay_total,
         total_unpaid=v_unpaid_total, house_residual=v_residual,
         club_results=COALESCE(v_results,'[]'::jsonb), settled_at=now()
   WHERE id = v_settlement_id;

  RETURN jsonb_build_object('success', true, 'settlement_id', v_settlement_id, 'union_id', p_union_id,
    'period_start', p_start, 'period_end', p_end, 'house_residual', v_residual,
    'total_collected', v_collect_total, 'total_paid', v_pay_total, 'total_unpaid', v_unpaid_total,
    'union_balance_after', v_union_balance, 'clubs', COALESCE(v_results, '[]'::jsonb));
END $function$;

-- chain from either a real settlement or a baseline
CREATE OR REPLACE FUNCTION public.fn_union_settle_player_pnl_weekly(
  p_union_id uuid, p_min_hours numeric DEFAULT 12)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_start timestamptz; v_end timestamptz := now();
BEGIN
  SELECT period_end INTO v_start
    FROM union_pnl_settlements
   WHERE union_id = p_union_id AND status IN ('settled','baseline')
   ORDER BY period_start DESC LIMIT 1;

  IF v_start IS NULL THEN v_start := v_end - interval '7 days'; END IF;

  IF EXTRACT(EPOCH FROM (v_end - v_start)) / 3600.0 < p_min_hours THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'period_too_short',
      'hours', round((EXTRACT(EPOCH FROM (v_end - v_start)) / 3600.0)::numeric, 2),
      'period_start', v_start, 'period_end', v_end);
  END IF;

  RETURN fn_union_settle_player_pnl_guarded(p_union_id, v_start, v_end);
END $function$;

