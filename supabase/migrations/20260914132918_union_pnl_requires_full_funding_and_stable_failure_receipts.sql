-- The previous P&L writer collected available treasuries and prorated payments,
-- then marked a partial attempt settled. It also called any duplicate claim a
-- successful replay. All obligations now require locked, full funding; invoices,
-- period completion and transfers roll back together. Existing partial or
-- contradictory historical evidence is refused without rewriting or repaying it.
-- Posted P&L transfers use the central source-ledger invoice; the previous
-- second explicit P&L invoice is removed. Missing delivery aborts the transfer.
-- The weekly coordinator excludes wall-clock telemetry from failure identity so
-- retries of one unchanged standalone-club failure produce one durable alert.
-- Read-only production preimages verified 2026-09-14; no historical money repair.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean)'::regprocedure))<>'e21b68786fba4b6ef2982071b86479ee'
 OR md5(pg_get_functiondef('public.fn_process_weekly_accounting(uuid)'::regprocedure))<>'f8bd737e49e174430ba95ada5118340b'
 THEN RAISE EXCEPTION 'settlement integrity source changed since review'; END IF;
END $guard$;
-- Both existing writers are already registered. Refuse a missing registration.
DO $registry$ BEGIN
 IF (SELECT count(*) FROM public.ca_money_rpc_registry WHERE proname IN('fn_union_settle_player_pnl','fn_process_weekly_accounting') AND status='approved')<>2
 THEN RAISE EXCEPTION 'settlement writer registration is missing'; END IF;
END $registry$;
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
  v_existing record; v_floor timestamptz; v_needed numeric; v_initial_union numeric;
  v_prior_ledger jsonb; v_receipt_count int;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_arguments');
  END IF;
  IF NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end <= p_start OR p_end>now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_period');
  END IF;

  SELECT earliest_period_start INTO v_floor FROM public.union_settlement_floor WHERE union_id=p_union_id;
  IF v_floor IS NOT NULL AND p_start<v_floor THEN
    RETURN jsonb_build_object('success',false,'error','before_settlement_floor','settlement_floor',v_floor);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.unions WHERE id=p_union_id) THEN
    RETURN jsonb_build_object('success',false,'error','unknown_union');
  END IF;
  -- Share the weekly scope lock, then serialize overlapping P&L callers for this union.
  PERFORM pg_advisory_xact_lock(hashtextextended('union-accounting:'||p_union_id::text||':'||extract(epoch FROM p_start)::text||':'||extract(epoch FROM p_end)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('union-player-pnl:'||p_union_id::text,0));
  SELECT * INTO v_existing FROM public.union_pnl_settlements
   WHERE union_id=p_union_id AND status IN('settled','in_progress')
    AND period_start<p_end AND period_end>p_start
   ORDER BY period_start,id LIMIT 1 FOR UPDATE;
  IF FOUND AND NOT p_dry_run THEN
    IF v_existing.period_start=p_start AND v_existing.period_end=p_end
      AND v_existing.status='settled' AND v_existing.total_unpaid=0
      AND v_existing.total_collected>=0 AND v_existing.total_paid>=0 THEN
      RETURN jsonb_build_object('success',true,'already_settled',true,'settlement_id',v_existing.id,
       'union_id',p_union_id,'period_start',p_start,'period_end',p_end,
       'total_collected',v_existing.total_collected,'total_paid',v_existing.total_paid,'total_unpaid',0);
    END IF;
    RETURN jsonb_build_object('success',false,'error',CASE
      WHEN v_existing.status='settled' AND v_existing.total_unpaid IS DISTINCT FROM 0 THEN 'legacy_partial_pnl_requires_reconciliation'
      WHEN v_existing.status='in_progress' THEN 'pnl_claim_requires_reconciliation'
      ELSE 'pnl_period_overlap' END,'settlement_id',v_existing.id,
      'existing_period_start',v_existing.period_start,'existing_period_end',v_existing.period_end,
      'total_unpaid',v_existing.total_unpaid);
  END IF;

  -- (A) FIX: baseline at the OPENING of the window.
  v_prev := fn_union_pnl_baseline(p_union_id, p_start);

  CREATE TEMP TABLE IF NOT EXISTS _pnl_tmp (
    club_id uuid PRIMARY KEY, net numeric, seated numeric, detail jsonb, opening_treasury numeric) ON COMMIT DROP;
  DELETE FROM pg_temp._pnl_tmp WHERE true;

  INSERT INTO pg_temp._pnl_tmp (club_id, net, seated, detail)
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

  SELECT COALESCE(round(SUM(net), 2), 0) INTO v_residual FROM pg_temp._pnl_tmp;

  IF p_dry_run THEN
    SELECT jsonb_agg(detail ORDER BY club_id) INTO v_results FROM pg_temp._pnl_tmp;
    RETURN jsonb_build_object('success', true, 'dry_run', true, 'union_id', p_union_id,
      'house_residual', v_residual, 'imbalance', v_residual,
      'clubs', COALESCE(v_results, '[]'::jsonb));
  END IF;

  IF NOT EXISTS(SELECT 1 FROM pg_temp._pnl_tmp) THEN
    RETURN jsonb_build_object('success',false,'error','pnl_no_club_basis');
  END IF;
  IF EXISTS(SELECT 1 FROM pg_temp._pnl_tmp WHERE net IS NULL OR net::text IN('NaN','Infinity','-Infinity') OR net<>round(net,2)) THEN
    RETURN jsonb_build_object('success',false,'error','pnl_invalid_basis');
  END IF;
  -- A final or advanced state with no matching fully-paid claim cannot be replayed.
  SELECT id,state INTO v_ca_id,v_ca_state FROM public.ca_settlements
   WHERE settlement_type='union_player_pnl'
    AND (idempotency_key='pnl:'||p_union_id::text||':'||extract(epoch FROM p_start)::bigint
      OR external_ref=p_union_id::text||':'||to_char(p_start,'YYYY-MM-DD"T"HH24:MI:SSOF'))
   ORDER BY id LIMIT 1 FOR UPDATE;
  IF FOUND AND v_ca_state NOT IN('failed','open') THEN
    RETURN jsonb_build_object('success',false,'error','pnl_journal_requires_reconciliation','journal_id',v_ca_id,'state',v_ca_state);
  END IF;
  v_ca_id:=NULL; v_ca_state:=NULL;
  UPDATE union_pnl_settlements SET status = 'superseded' 
   WHERE union_id = p_union_id AND period_start = p_start AND status = 'needs_review';

  BEGIN
    INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status)
    VALUES (p_union_id, p_start, p_end, 'in_progress') RETURNING id INTO v_settlement_id;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success',false,'error','pnl_claim_conflict','union_id',p_union_id,'period_start',p_start);
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

  -- A failed attempt preserves only the claim and incident; period/invoice/ledger writes roll back.
  BEGIN
  -- (C) FIX: every club in the settlement gets a period row for THIS window.
  INSERT INTO settlement_periods (club_id, union_id, period_number, year, start_at, end_at, status)
  SELECT t.club_id, p_union_id,
         EXTRACT(week FROM p_start)::int, EXTRACT(isoyear FROM p_start)::int,
         p_start, p_end, 'processing'
    FROM pg_temp._pnl_tmp t
   WHERE NOT EXISTS (
     SELECT 1 FROM settlement_periods sp
      WHERE sp.club_id = t.club_id AND sp.union_id = p_union_id
        AND sp.start_at = p_start AND sp.end_at = p_end);

    IF v_walk THEN
      UPDATE public.ca_settlements SET state = 'locked_for_calculation' WHERE id = v_ca_id;
      UPDATE public.ca_settlements SET state = 'calculated',
        totals = jsonb_build_object('house_residual', v_residual,
                                    'clubs', (SELECT count(*) FROM pg_temp._pnl_tmp))
        WHERE id = v_ca_id;
    END IF;

    SELECT chip_balance INTO v_union_balance FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'pnl_union_wallet_missing'; END IF;

    -- Freeze every participating treasury in stable order before the first leg.
    PERFORM c.id FROM public.clubs c JOIN pg_temp._pnl_tmp t ON t.club_id=c.id ORDER BY c.id FOR UPDATE OF c;
    UPDATE pg_temp._pnl_tmp t SET opening_treasury=c.chip_treasury FROM public.clubs c WHERE c.id=t.club_id;
    IF EXISTS(SELECT 1 FROM pg_temp._pnl_tmp WHERE opening_treasury IS NULL
      OR opening_treasury::text IN('NaN','Infinity','-Infinity') OR opening_treasury<0
      OR opening_treasury<>round(opening_treasury,2))
      OR v_union_balance IS NULL OR v_union_balance::text IN('NaN','Infinity','-Infinity')
      OR v_union_balance<0 OR v_union_balance<>round(v_union_balance,2) THEN
      RAISE EXCEPTION 'pnl_invalid_funding_balance' USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(sum(-net),0) INTO v_needed FROM pg_temp._pnl_tmp WHERE net<0;
    IF EXISTS(SELECT 1 FROM pg_temp._pnl_tmp WHERE net<0 AND opening_treasury < -net) THEN
      RAISE EXCEPTION 'pnl_club_funding_shortfall' USING DETAIL=(
        SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'owed',-net,'available',opening_treasury) ORDER BY club_id)::text
         FROM pg_temp._pnl_tmp WHERE net<0 AND opening_treasury < -net);
    END IF;
    v_initial_union:=v_union_balance;
    -- ZERO-DRIFT phase 3 validation before any chips move.
    SELECT COALESCE(SUM(net), 0) INTO v_winners_total FROM pg_temp._pnl_tmp WHERE net > 0;
    IF v_union_balance+v_needed<v_winners_total THEN
      RAISE EXCEPTION 'pnl_union_funding_shortfall' USING DETAIL=jsonb_build_object('owed',v_winners_total,'available_after_collection',v_union_balance+v_needed)::text;
    END IF;
    IF v_walk THEN
      UPDATE public.ca_settlements SET state = 'validated' WHERE id = v_ca_id;
    END IF;

    -- ZERO-DRIFT phase 3: P&L legs journal as pnl_settlement vs the union
    -- wallet, single-posted from the club-treasury side.
    v_prior_ledger:=jsonb_build_object('category',current_setting('app.ledger_category',true),'counterparty',current_setting('app.ledger_counterparty',true),'entity',current_setting('app.ledger_counterparty_entity',true),'settlement',current_setting('app.ledger_settlement',true),'autoskip',current_setting('app.ledger_autoskip_union_wallets',true));
    PERFORM set_config('app.ledger_category', 'pnl_settlement', true);
    PERFORM set_config('app.ledger_counterparty', 'union_wallet', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_union_id::text, true);
    PERFORM set_config('app.ledger_settlement', COALESCE(v_ca_id::text, ''), true);
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);

    FOR r IN SELECT * FROM pg_temp._pnl_tmp WHERE net < 0 ORDER BY club_id LOOP
      v_owed := round(-r.net, 2);
      SELECT chip_treasury INTO v_treasury FROM clubs WHERE id = r.club_id FOR UPDATE;
      v_take := v_owed;
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
      SELECT count(*) INTO v_receipt_count FROM public.chip_ledger l
       JOIN public.settlement_invoices i ON i.source_ledger_id=l.id
       WHERE l.settlement_id=v_ca_id::text AND l.club_id=r.club_id AND l.category='pnl_settlement'
        AND l.from_type='club_treasury' AND l.from_entity_id=r.club_id
        AND l.to_type='union_wallet' AND l.to_entity_id=p_union_id AND l.status='posted' AND l.amount=v_owed
        AND i.status='paid' AND i.chips_transferred AND i.message_sent
        AND i.gross_amount=v_owed AND i.net_amount=v_owed AND i.deductions=0;
      IF v_receipt_count<>1 THEN RAISE EXCEPTION 'pnl_posted_receipt_missing_or_ambiguous'; END IF;
      v_unpaid_total := v_unpaid_total + round(v_owed - v_take, 2);
    END LOOP;

    FOR r IN SELECT * FROM pg_temp._pnl_tmp WHERE net > 0 ORDER BY club_id LOOP
      v_owed := round(r.net, 2);
      v_pay := v_owed;
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
      SELECT count(*) INTO v_receipt_count FROM public.chip_ledger l
       JOIN public.settlement_invoices i ON i.source_ledger_id=l.id
       WHERE l.settlement_id=v_ca_id::text AND l.club_id=r.club_id AND l.category='pnl_settlement'
        AND l.from_type='union_wallet' AND l.from_entity_id=p_union_id
        AND l.to_type='club_treasury' AND l.to_entity_id=r.club_id AND l.status='posted' AND l.amount=v_owed
        AND i.status='paid' AND i.chips_transferred AND i.message_sent
        AND i.gross_amount=v_owed AND i.net_amount=v_owed AND i.deductions=0;
      IF v_receipt_count<>1 THEN RAISE EXCEPTION 'pnl_posted_receipt_missing_or_ambiguous'; END IF;
      v_unpaid_total := v_unpaid_total + round(v_owed - v_pay, 2);
    END LOOP;

    IF v_unpaid_total<>0 OR v_collect_total<>v_needed OR v_pay_total<>v_winners_total THEN
      RAISE EXCEPTION 'pnl_obligations_not_fully_settled' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM pg_temp._pnl_tmp t JOIN public.clubs c ON c.id=t.club_id
       WHERE c.chip_treasury IS DISTINCT FROM t.opening_treasury+t.net)
      OR v_union_balance<>v_initial_union+v_collect_total-v_pay_total THEN
      RAISE EXCEPTION 'pnl_balance_conservation_failed' USING ERRCODE='23514';
    END IF;
    PERFORM set_config('app.ledger_category',COALESCE(v_prior_ledger->>'category',''),true);
    PERFORM set_config('app.ledger_counterparty',COALESCE(v_prior_ledger->>'counterparty',''),true);
    PERFORM set_config('app.ledger_counterparty_entity',COALESCE(v_prior_ledger->>'entity',''),true);
    PERFORM set_config('app.ledger_settlement',COALESCE(v_prior_ledger->>'settlement',''),true);
    PERFORM set_config('app.ledger_autoskip_union_wallets',COALESCE(v_prior_ledger->>'autoskip',''),true);

    IF abs(v_residual) >= 0.01 THEN
      INSERT INTO union_wallet_transactions (union_id, wallet, direction, amount, balance_after, tx_type, notes)
      VALUES (p_union_id, 'chip_balance',
              CASE WHEN v_residual < 0 THEN 'credit' ELSE 'debit' END,
              abs(v_residual), v_union_balance, 'player_pnl_house_residual',
              'Net player clearing residual for the period, including all players, absorbed by the union '
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
      FROM pg_temp._pnl_tmp t
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

    SELECT jsonb_agg(detail ORDER BY club_id) INTO v_results FROM pg_temp._pnl_tmp;
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
CREATE OR REPLACE FUNCTION public.fn_process_weekly_accounting(p_union_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club record; v_pass int; v_batch jsonb; v_credit jsonb; v_started timestamptz; 
  v_now timestamptz := clock_timestamp();
  v_to timestamptz := public.fn_union_week_start(v_now);
  v_from timestamptz;
  v_first timestamptz;
  v_end timestamptz;
  v_due timestamptz;
  v_union record;
  v_previous jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
  v_orphans integer;
  v_orphan_amount numeric;
  v_complete boolean;
  v_failed integer := 0;
  v_checked integer := 0;
  v_msg text; v_detail text; v_state text;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  -- Transaction locks release on errors and also work in reused connections.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('union-accounting-scheduler',0)) THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','already_running');
  END IF;
  IF public.fn_platform_frozen() OR extract(minute FROM v_now) >= 45 THEN
    RETURN jsonb_build_object('success',true,'skipped',true,'reason','maintenance_window');
  END IF;

  FOR v_union IN SELECT u.id, f.earliest_period_start
    FROM public.unions u LEFT JOIN public.union_settlement_floor f ON f.union_id=u.id WHERE p_union_id IS NULL OR u.id=p_union_id ORDER BY u.id
  LOOP
    -- Catch up chronologically from the explicit clean-data floor. A union
    -- without one starts at the just-closed week, never an invented history.
    v_first := COALESCE(public.fn_union_week_start(v_union.earliest_period_start),
                        public.fn_union_prev_week_start(v_now));
    IF v_first < v_union.earliest_period_start THEN
      v_first := public.fn_union_week_start(v_first + interval '8 days');
    END IF;
    v_from := v_first;
    WHILE v_from < v_to LOOP
      v_end := public.fn_union_week_start(v_from + interval '8 days');
      v_due := public.fn_union_accounting_run_at(v_end);
      IF v_now < v_due THEN EXIT; END IF;

      SELECT result INTO v_previous FROM public.union_accounting_runs
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      SELECT count(*), COALESCE(sum(rakeback_amount),0) INTO v_orphans,v_orphan_amount
        FROM public.rakeback_periods rp
       WHERE rp.club_id=v_union.id AND rp.status='pending' AND rp.rakeback_amount>0
         AND (rp.period_start::timestamp AT TIME ZONE 'UTC') < v_end
         AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') > v_from;

      SELECT NOT EXISTS (
        SELECT 1 FROM generate_series(1,4) n
        WHERE NOT EXISTS (SELECT 1 FROM public.union_settlement_rounds r
          WHERE r.union_id=v_union.id AND r.period_start=v_from AND r.period_end=v_end AND r.round_no=n
            AND CASE
              WHEN n=1 THEN r.detail->>'success'='true'
              WHEN n IN(2,3) THEN
                COALESCE(r.detail->'latest_attempt',r.detail)->>'amount' IS NOT NULL
                AND COALESCE(r.detail->'latest_attempt',r.detail)->>'payees' IS NOT NULL
                AND COALESCE(r.detail->'latest_attempt',r.detail)->'shortfalls'='0'::jsonb
                AND COALESCE(COALESCE(r.detail->'latest_attempt',r.detail)->>'success','true')='true'
              ELSE r.detail->>'success'='true' AND COALESCE(r.detail->>'skipped','false')='false'
            END)) INTO v_complete;

      v_complete := v_complete AND NOT EXISTS (
        SELECT 1 FROM public.rakeback_periods rp
        JOIN public.union_clubs uc ON uc.club_id=rp.club_id AND uc.union_id=v_union.id
        WHERE rp.status='pending' AND rp.rakeback_amount>0
          AND rp.period_start >= (v_from AT TIME ZONE 'UTC')::date
          AND ((rp.period_end+1)::timestamp AT TIME ZONE 'UTC') <= v_end)
        AND NOT EXISTS (SELECT 1 FROM public.union_clubs uc
          WHERE uc.union_id=v_union.id AND uc.club_id<>v_union.id
            AND NOT EXISTS (SELECT 1 FROM public.settlement_invoices si
              WHERE si.club_id=uc.club_id AND si.invoice_type='union_weekly_squareup'
                AND si.breakdown->>'union_id'=v_union.id::text
                AND (si.breakdown->>'period_start')::timestamptz=v_from
                AND (si.breakdown->>'period_end')::timestamptz=v_end
                AND si.message_sent=true AND si.status<>'cancelled'));

      v_complete:=v_complete AND NOT EXISTS(SELECT 1 FROM public.union_clubs uc
        WHERE uc.union_id=v_union.id AND uc.club_id<>v_union.id AND NOT EXISTS(
          SELECT 1 FROM public.settlement_invoices i JOIN public.settlement_periods sp ON sp.id=i.period_id
          WHERE i.club_id=uc.club_id AND i.invoice_type='club_weekly_accounting' AND i.message_sent
            AND sp.start_at=v_from AND sp.end_at=v_end));
      IF v_complete AND v_orphans=0 AND v_previous->>'success'='true' AND v_previous->>'accounting_version'='2' THEN
        v_from:=v_end; CONTINUE;
      END IF;
      -- Bounded recovery: never let a large history monopolize live wallets.
      IF v_checked>=8 OR clock_timestamp()-v_now>interval '15 minutes'
        OR extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
          'more_remaining',true,'detail',v_results);
      END IF;
      INSERT INTO public.union_accounting_runs
        (union_id,period_start,period_end,scheduled_at,status,attempts,started_at)
      VALUES (v_union.id,v_from,v_end,v_due,'running',1,clock_timestamp())
      ON CONFLICT(union_id,period_start,period_end) DO UPDATE
        SET status='running',attempts=union_accounting_runs.attempts+1,started_at=clock_timestamp();

      -- Only this block may move chips. Any refused downstream stage raises
      -- and rolls back the whole union attempt, while the failure record below
      -- survives. Other unions have independent ledgers and transaction scopes.
      BEGIN
        IF EXISTS(SELECT 1 FROM public.rake_records rr LEFT JOIN public.daemon_state ds ON ds.daemon='rakeback_settler'
          WHERE NOT COALESCE(rr.is_tournament,false) AND rr.tournament_id IS NULL AND rr.rake_amount>0
            AND rr.created_at>=v_from AND rr.created_at<v_end
            AND (rr.club_id=v_union.id OR EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.union_id=v_union.id AND uc.club_id=rr.club_id))
            AND (ds.high_water_mark IS NULL OR rr.created_at>ds.high_water_mark OR
              (rr.created_at=ds.high_water_mark AND (ds.high_water_mark_id IS NULL OR rr.id>ds.high_water_mark_id)))) THEN
          RAISE EXCEPTION 'weekly_rake_source_not_fully_accrued';
        END IF;
        IF v_orphans>0 THEN
          RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_rakeback_wrong_club',
            DETAIL=jsonb_build_object('pending_periods',v_orphans,'pending_amount',v_orphan_amount)::text;
        END IF;
        IF v_complete AND v_previous->>'accounting_version'='2' THEN
          v_result:=jsonb_build_object('success',true,'already_posted',true);
        ELSE
          v_result:=public.fn_union_settlement_cascade(v_union.id,v_from,v_end);
          IF v_result->>'success' IS DISTINCT FROM 'true' THEN
            RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='union_settlement_incomplete',DETAIL=v_result::text;
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
      END;

      IF v_result->>'success'='true' THEN v_result:=v_result||jsonb_build_object('accounting_version',2); END IF;
      v_checked:=v_checked+1;
      UPDATE public.union_accounting_runs
         SET status=CASE WHEN v_result->>'success'='true' THEN 'complete' ELSE 'failed' END,
             finished_at=clock_timestamp(),result=v_result
       WHERE union_id=v_union.id AND period_start=v_from AND period_end=v_end;
      IF v_result->>'success' IS DISTINCT FROM 'true' THEN
        v_failed:=v_failed+1;
        -- Report a new failure or a changed failure, not the same alert every tick.
        IF v_previous IS DISTINCT FROM v_result THEN
          INSERT INTO public.financial_alerts(source,severity,message,context)
          VALUES ('union_accounting_scheduler','critical','Weekly union accounting is incomplete',
            jsonb_build_object('union_id',v_union.id,'period_start',v_from,'period_end',v_end,
                               'scheduled_at',v_due,'result',v_result));
        END IF;
      END IF;
      v_results:=v_results||jsonb_build_array(jsonb_build_object('union_id',v_union.id,
        'period_start',v_from,'period_end',v_end,'result',v_result));
      -- Resolve an older period before posting a later one for the same union.
      IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT; END IF;
      v_from:=v_end;
    END LOOP;
  END LOOP;

  -- Standalone clubs use the same schedule and caller. Existing payout rules
  -- remain scoped to that club; no standalone batch can bypass union stages.
  IF p_union_id IS NULL AND v_now>=public.fn_union_accounting_run_at(v_to) THEN
    v_from:=public.fn_union_prev_week_start(v_now);
    FOR v_club IN SELECT c.id FROM public.clubs c
      WHERE NOT EXISTS(SELECT 1 FROM public.union_clubs uc WHERE uc.club_id=c.id)
        AND NOT EXISTS(SELECT 1 FROM public.unions u WHERE u.id=c.id)
        AND (EXISTS(SELECT 1 FROM public.rakeback_periods rp WHERE rp.club_id=c.id AND rp.status='pending' AND rp.period_end<(v_to AT TIME ZONE 'America/Los_Angeles')::date)
          OR EXISTS(SELECT 1 FROM public.agents a WHERE a.club_id=c.id AND NOT COALESCE(a.is_prepaid,false) AND a.credit_used>0))
      ORDER BY c.id
    LOOP
      IF extract(minute FROM clock_timestamp())>=45 OR public.fn_platform_frozen() THEN
        RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,'more_remaining',true,'detail',v_results);
      END IF;
      BEGIN
        v_started:=clock_timestamp();v_pass:=0;
        LOOP
          v_batch:=public.fn_settle_club_rakeback_batch(v_club.id,40,4.0,2);
          IF v_batch->>'success' IS DISTINCT FROM 'true' OR COALESCE((v_batch->>'errors')::int,0)>0 THEN
            RAISE EXCEPTION 'standalone_weekly_payout_failed' USING DETAIL=(v_batch-'elapsed_seconds'-'clock_ran_out')::text; END IF;
          EXIT WHEN COALESCE((v_batch->>'periods_remaining')::int,0)=0;
          v_pass:=v_pass+1;
          IF COALESCE((v_batch->>'periods_settled')::int,0)=0 OR v_pass>=250 OR clock_timestamp()-v_started>interval '30 seconds' THEN
            RAISE EXCEPTION 'standalone_weekly_payout_incomplete' USING DETAIL=(v_batch-'elapsed_seconds'-'clock_ran_out')::text; END IF;
        END LOOP;
        v_credit:=public.fn_generate_scope_credit_invoices(v_club.id,v_from,v_to);
        INSERT INTO public.daemon_state(daemon,high_water_mark,updated_at)
         VALUES('weekly_accounting:'||v_club.id::text,v_to,clock_timestamp())
         ON CONFLICT(daemon) DO UPDATE SET high_water_mark=excluded.high_water_mark,updated_at=excluded.updated_at;
        v_result:=jsonb_build_object('success',true,'credit_invoices',v_credit,'accounting_version',2);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg=MESSAGE_TEXT,v_detail=PG_EXCEPTION_DETAIL,v_state=RETURNED_SQLSTATE;
        v_result:=jsonb_build_object('success',false,'error',v_msg,'sqlstate',v_state,'detail',v_detail);
        v_failed:=v_failed+1;
        INSERT INTO public.financial_alerts(source,severity,message,context)
          SELECT 'weekly_club_accounting','critical','Weekly club accounting is incomplete',
            jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_to,'result',v_result)
          WHERE NOT EXISTS(SELECT 1 FROM public.financial_alerts a WHERE a.source='weekly_club_accounting'
            AND a.context->>'club_id'=v_club.id::text AND a.context->>'period_end'=to_jsonb(v_to)#>>'{}'
            AND a.context->'result'=v_result);
      END;
      v_checked:=v_checked+1;
      v_results:=v_results||jsonb_build_array(jsonb_build_object('club_id',v_club.id,'period_start',v_from,'period_end',v_to,'result',v_result));
    END LOOP;
  END IF;
  RETURN jsonb_build_object('success',v_failed=0,'checked',v_checked,'failed',v_failed,
    'observed_at',clock_timestamp(),'detail',v_results);
END $function$
;

REVOKE ALL ON FUNCTION public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_settle_player_pnl(uuid,timestamptz,timestamptz,boolean) TO service_role;
REVOKE ALL ON FUNCTION public.fn_process_weekly_accounting(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_process_weekly_accounting(uuid) TO service_role;
COMMIT;
