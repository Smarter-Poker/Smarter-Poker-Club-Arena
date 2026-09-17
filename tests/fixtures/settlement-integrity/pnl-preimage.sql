CREATE OR REPLACE FUNCTION public.fn_union_settle_player_pnl(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_settlement_id uuid; v_prev jsonb; r record;
  v_results jsonb := '[]'::jsonb;
  v_collect_total numeric := 0; v_pay_total numeric := 0; v_unpaid_total numeric := 0;
  v_treasury numeric; v_take numeric; v_union_balance numeric; v_pay numeric; v_owed numeric;
  v_period_id uuid; v_scale numeric := 1; v_winners_total numeric := 0; v_residual numeric := 0;
  v_ca_id uuid; v_ca_state text; v_walk boolean := false;
  v_expected_balance numeric; v_err text;
BEGIN
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_arguments');
  END IF;
  IF p_end <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_period');
  END IF;

  -- (A) FIX: baseline at the OPENING of the window.
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
           'seated_end_cash', COALESCE(cc.seated_stack, 0),
           'stack_delta', round(c.seated_stack - base.seated_start, 2),
           'rake_paid', COALESCE(rk.rake_paid, 0),
           'net', round(c.realized_net + (c.seated_stack - base.seated_start) + COALESCE(rk.rake_paid, 0), 2))
    FROM fn_union_pnl_all_clubs(p_union_id, p_start, p_end, true) c
    -- (B) same population as the P&L above: horses included.
    LEFT JOIN fn_union_rake_paid_by_club(p_union_id, p_start, p_end, true) rk ON rk.club_id = c.club_id
    LEFT JOIN fn_union_pnl_cash_by_club(p_union_id, p_start, p_end, true) cc ON cc.club_id = c.club_id
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

  -- ZERO-DRIFT phase 3: register on the settlement state machine (resume a
  -- prior failed run; leave an unexpected 'final' row untouched).
  INSERT INTO public.ca_settlements (settlement_type, external_ref, state, union_id, idempotency_key)
  VALUES ('union_player_pnl', p_union_id::text || ':' || to_char(p_start, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
          'open', p_union_id, 'pnl:' || p_union_id::text || ':' || extract(epoch from p_start)::bigint)
  ON CONFLICT (settlement_type, external_ref) DO NOTHING
  RETURNING id INTO v_ca_id;
  IF v_ca_id IS NULL THEN
    SELECT id, state INTO v_ca_id, v_ca_state FROM public.ca_settlements
     WHERE settlement_type = 'union_player_pnl'
       AND external_ref = p_union_id::text || ':' || to_char(p_start, 'YYYY-MM-DD"T"HH24:MI:SSOF');
    IF v_ca_state = 'failed' THEN
      UPDATE public.ca_settlements SET state = 'open', error_detail = NULL WHERE id = v_ca_id;
      v_walk := true;
    ELSIF v_ca_state = 'open' THEN
      v_walk := true;
    END IF; -- any later state: leave the machine alone, evidence stands
  ELSE
    v_walk := true;
  END IF;

  -- (C) FIX: every club in the settlement gets a period row for THIS window.
  INSERT INTO settlement_periods (club_id, union_id, period_number, year, start_at, end_at, status)
  SELECT t.club_id, p_union_id,
         EXTRACT(week FROM p_start)::int, EXTRACT(isoyear FROM p_start)::int,
         p_start, p_end, 'processing'
    FROM _pnl_tmp t
   WHERE NOT EXISTS (
     SELECT 1 FROM settlement_periods sp
      WHERE sp.club_id = t.club_id AND sp.union_id = p_union_id
        AND sp.start_at = p_start AND sp.end_at = p_end);

  -- ═══ GUARDED MONEY SECTION: any error rolls all chip movements back ═══
  BEGIN
    IF v_walk THEN
      UPDATE public.ca_settlements SET state = 'locked_for_calculation' WHERE id = v_ca_id;
      UPDATE public.ca_settlements SET state = 'calculated',
        totals = jsonb_build_object('house_residual', v_residual,
                                    'clubs', (SELECT count(*) FROM _pnl_tmp))
        WHERE id = v_ca_id;
    END IF;

    SELECT chip_balance INTO v_union_balance FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
    IF v_union_balance IS NULL THEN
      INSERT INTO union_wallets (union_id, chip_balance) VALUES (p_union_id, 0)
        ON CONFLICT (union_id) DO NOTHING;
      SELECT chip_balance INTO v_union_balance FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
      v_union_balance := COALESCE(v_union_balance, 0);
    END IF;

    -- ZERO-DRIFT phase 3 validation before any chips move.
    SELECT COALESCE(SUM(net), 0) INTO v_winners_total FROM _pnl_tmp WHERE net > 0;
    IF v_winners_total < 0 THEN
      RAISE EXCEPTION 'pnl validation: winners_total negative (%)', v_winners_total;
    END IF;
    IF v_walk THEN
      UPDATE public.ca_settlements SET state = 'validated' WHERE id = v_ca_id;
    END IF;

    -- ZERO-DRIFT phase 3: P&L legs journal as pnl_settlement vs the union
    -- wallet, single-posted from the club-treasury side.
    PERFORM set_config('app.ledger_category', 'pnl_settlement', true);
    PERFORM set_config('app.ledger_counterparty', 'union_wallet', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_union_id::text, true);
    PERFORM set_config('app.ledger_settlement', COALESCE(v_ca_id::text, ''), true);
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);

    FOR r IN SELECT * FROM _pnl_tmp WHERE net < 0 ORDER BY club_id LOOP
      v_owed := round(-r.net, 2);
      SELECT chip_treasury INTO v_treasury FROM clubs WHERE id = r.club_id FOR UPDATE;
      v_take := LEAST(v_owed, GREATEST(COALESCE(v_treasury, 0), 0));
      IF v_take > v_owed OR v_take < 0 THEN
        RAISE EXCEPTION 'pnl validation: collect leg out of bounds (take % owed %)', v_take, v_owed;
      END IF;
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

    IF v_winners_total > 0 AND v_union_balance < v_winners_total THEN
      v_scale := GREATEST(v_union_balance, 0) / v_winners_total;
    END IF;
    IF v_scale < 0 OR v_scale > 1 THEN
      RAISE EXCEPTION 'pnl validation: pay scale out of bounds (%)', v_scale;
    END IF;

    FOR r IN SELECT * FROM _pnl_tmp WHERE net > 0 ORDER BY club_id LOOP
      v_owed := round(r.net, 2);
      v_pay := LEAST(round(v_owed * v_scale, 2), GREATEST(v_union_balance, 0));
      IF v_pay > v_owed OR v_pay < 0 THEN
        RAISE EXCEPTION 'pnl validation: pay leg out of bounds (pay % owed %)', v_pay, v_owed;
      END IF;
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

    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);

    IF abs(v_residual) >= 0.01 THEN
      INSERT INTO union_wallet_transactions (union_id, wallet, direction, amount, balance_after, tx_type, notes)
      VALUES (p_union_id, 'chip_balance',
              CASE WHEN v_residual < 0 THEN 'credit' ELSE 'debit' END,
              abs(v_residual), v_union_balance, 'player_pnl_house_residual',
              'Net real-player vs house-horse flow for the period, absorbed by the union '
              || 'as clearing house (settlement ' || v_settlement_id || ')');
    END IF;

    IF v_walk THEN
      UPDATE public.ca_settlements SET state = 'ledger_posted' WHERE id = v_ca_id;
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

    -- Post-commit verification: the wallet must hold exactly what the legs say.
    SELECT chip_balance INTO v_expected_balance FROM union_wallets WHERE union_id = p_union_id;
    IF round(COALESCE(v_expected_balance, 0), 2) <> round(v_union_balance, 2) THEN
      RAISE EXCEPTION 'pnl post-commit verify: wallet % but legs say %', v_expected_balance, v_union_balance;
    END IF;
    IF v_walk THEN
      UPDATE public.ca_settlements SET state = 'post_commit_verified' WHERE id = v_ca_id;
      UPDATE public.ca_settlements SET state = 'final',
        totals = COALESCE(totals, '{}'::jsonb) || jsonb_build_object(
          'collected', v_collect_total, 'paid', v_pay_total,
          'unpaid', v_unpaid_total, 'house_residual', v_residual)
        WHERE id = v_ca_id;
    END IF;

    SELECT jsonb_agg(detail ORDER BY club_id) INTO v_results FROM _pnl_tmp;
    UPDATE union_pnl_settlements
       SET status='settled', total_collected=v_collect_total, total_paid=v_pay_total,
           total_unpaid=v_unpaid_total, house_residual=v_residual,
           club_results=COALESCE(v_results,'[]'::jsonb), settled_at=now()
     WHERE id = v_settlement_id;

  EXCEPTION WHEN OTHERS THEN
    -- Every chip movement above is rolled back to the block savepoint here.
    v_err := SQLERRM;
    UPDATE union_pnl_settlements SET status = 'failed' WHERE id = v_settlement_id;
    UPDATE public.ca_settlements SET state = 'failed', error_detail = left(v_err, 2000)
     WHERE id = v_ca_id;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_union_settle_player_pnl', 'settlement_error', 'critical',
      'pnl-settle-failed:' || p_union_id::text || ':' || extract(epoch from p_start)::bigint,
      0, NULL, NULL, 'settlement', 'union_pnl_settlements',
      v_settlement_id, NULL, p_union_id, NULL, NULL, NULL, v_ca_id::text, NULL, NULL,
      'Weekly player P&L settlement failed and was fully rolled back (no chips moved): ' || left(v_err, 300)
        || ' - fix the cause and re-run; the failed claim does not block a retry',
      false, jsonb_build_object('period_start', p_start, 'period_end', p_end, 'error', left(v_err, 500)));
    RETURN jsonb_build_object('success', false, 'error', v_err, 'rolled_back', true,
      'settlement_id', v_settlement_id, 'union_id', p_union_id, 'period_start', p_start);
  END;

  RETURN jsonb_build_object('success', true, 'settlement_id', v_settlement_id, 'union_id', p_union_id,
    'period_start', p_start, 'period_end', p_end, 'house_residual', v_residual,
    'total_collected', v_collect_total, 'total_paid', v_pay_total, 'total_unpaid', v_unpaid_total,
    'union_balance_after', v_union_balance, 'clubs', COALESCE(v_results, '[]'::jsonb));
END $function$
;
