-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819211952 "union_settle_player_pnl_atomic"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a60a509a883856ca9192a1adbacfa3cb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.
-- unqualified-write-ok: _pnl_tmp because it is a temporary table the same function builds and
--   empties; this file records SQL production already executed as 20260819211952, and no live
--   function body carries this statement any more (pg_proc read 2026-09-27).

-- ============================================================================
-- UNION PLAYER P&L — ATOMIC WEEKLY SETTLEMENT (2026-08-19, audit fix pass 2)
--
-- Replaces the record-only, non-idempotent, never-scheduled JS implementation.
-- One transaction for the whole union:
--   1. compute each member club's player win/loss on union tables
--   2. COLLECT from losing clubs' treasuries into the union chip wallet
--   3. PAY winning clubs from the union chip wallet (pro-rata if short)
--   4. write settlement_invoices + chip_transactions + union_wallet_transactions
--
-- Chips are conserved: nothing is paid out that was not first collected or
-- already held by the union. Ordering (collect before pay) is what makes that
-- true, and is only possible because this runs union-wide, not per club.
--
-- SEATED-STACK BASELINE: chips still on the felt at the period boundary are
-- part of a player's result. Each run records every club's closing seated
-- stack; the next run uses it as the opening baseline. Self-maintaining, so
-- there is no null-snapshot ambiguity (the previous design could not tell
-- "first run" from "the snapshot RPC failed" and silently zeroed the delta).
--
-- IDEMPOTENT on (union_id, period_start) via a unique index.
-- ============================================================================

CREATE TABLE IF NOT EXISTS union_pnl_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  union_id uuid NOT NULL REFERENCES unions(id) ON DELETE CASCADE,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'settled',
  total_collected numeric NOT NULL DEFAULT 0,
  total_paid numeric NOT NULL DEFAULT 0,
  total_unpaid numeric NOT NULL DEFAULT 0,
  club_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  settled_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_union_pnl_settlements_period
  ON union_pnl_settlements (union_id, period_start);

ALTER TABLE union_pnl_settlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS union_pnl_settlements_service ON union_pnl_settlements;
CREATE POLICY union_pnl_settlements_service ON union_pnl_settlements
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION fn_union_settle_player_pnl(
  p_union_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_dry_run boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_settlement_id uuid;
  v_prev jsonb;
  r record;
  v_pnl jsonb;
  v_baseline numeric;
  v_seated numeric;
  v_delta numeric;
  v_net numeric;
  v_results jsonb := '[]'::jsonb;
  v_collect_total numeric := 0;
  v_pay_total numeric := 0;
  v_unpaid_total numeric := 0;
  v_treasury numeric;
  v_take numeric;
  v_union_balance numeric;
  v_pay numeric;
  v_owed numeric;
  v_period_id uuid;
  v_scale numeric := 1;
  v_winners_total numeric := 0;
BEGIN
  IF p_union_id IS NULL OR p_start IS NULL OR p_end IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'missing_arguments');
  END IF;
  IF p_end <= p_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_period');
  END IF;

  -- Idempotency claim. A second run for the same period is a no-op.
  IF NOT p_dry_run THEN
    BEGIN
      INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status)
      VALUES (p_union_id, p_start, p_end, 'in_progress')
      RETURNING id INTO v_settlement_id;
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('success', true, 'already_settled', true,
                                'union_id', p_union_id, 'period_start', p_start);
    END;
  END IF;

  -- Opening baselines: the closing seated stacks recorded by the previous run.
  SELECT club_results INTO v_prev
    FROM union_pnl_settlements
   WHERE union_id = p_union_id AND period_start < p_start AND status = 'settled'
   ORDER BY period_start DESC LIMIT 1;

  -- Lock the union wallet for the whole settlement.
  SELECT chip_balance INTO v_union_balance
    FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_union_balance IS NULL THEN
    INSERT INTO union_wallets (union_id, chip_balance)
    VALUES (p_union_id, 0)
    ON CONFLICT (union_id) DO NOTHING;
    SELECT chip_balance INTO v_union_balance
      FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
    v_union_balance := COALESCE(v_union_balance, 0);
  END IF;

  -- ── PASS 1: compute every club's net ─────────────────────────────────────
  CREATE TEMP TABLE IF NOT EXISTS _pnl_tmp (
    club_id uuid, net numeric, seated numeric, detail jsonb
  ) ON COMMIT DROP;
  DELETE FROM _pnl_tmp;

  FOR r IN SELECT uc.club_id FROM union_clubs uc WHERE uc.union_id = p_union_id LOOP
    v_pnl := fn_union_club_player_pnl(r.club_id, p_union_id, p_start, p_end);
    v_seated := COALESCE((v_pnl->>'seated_stack')::numeric, 0);

    v_baseline := NULL;
    IF v_prev IS NOT NULL THEN
      SELECT (e->>'seated_end')::numeric INTO v_baseline
        FROM jsonb_array_elements(v_prev) e
       WHERE (e->>'club_id') = r.club_id::text
       LIMIT 1;
    END IF;
    -- No prior settlement for this club: bootstrap with delta 0.
    IF v_baseline IS NULL THEN v_baseline := v_seated; END IF;

    v_delta := round(v_seated - v_baseline, 2);
    v_net := round(COALESCE((v_pnl->>'realized_net')::numeric, 0) + v_delta, 2);

    INSERT INTO _pnl_tmp VALUES (
      r.club_id, v_net, v_seated,
      jsonb_build_object(
        'club_id', r.club_id,
        'buyins', (v_pnl->>'buyins')::numeric,
        'cashouts', (v_pnl->>'cashouts')::numeric,
        'realized_net', (v_pnl->>'realized_net')::numeric,
        'winnings', (v_pnl->>'winnings')::numeric,
        'losses', (v_pnl->>'losses')::numeric,
        'players', (v_pnl->>'players')::int,
        'seated_start', v_baseline,
        'seated_end', v_seated,
        'stack_delta', v_delta,
        'net', v_net
      )
    );
  END LOOP;

  IF p_dry_run THEN
    SELECT jsonb_agg(detail ORDER BY club_id) INTO v_results FROM _pnl_tmp;
    RETURN jsonb_build_object('success', true, 'dry_run', true,
      'union_id', p_union_id, 'clubs', COALESCE(v_results, '[]'::jsonb));
  END IF;

  -- ── PASS 2: COLLECT from losing clubs (net < 0) ──────────────────────────
  FOR r IN SELECT * FROM _pnl_tmp WHERE net < 0 ORDER BY club_id LOOP
    v_owed := round(-r.net, 2);
    SELECT chip_treasury INTO v_treasury FROM clubs WHERE id = r.club_id FOR UPDATE;
    v_take := LEAST(v_owed, GREATEST(COALESCE(v_treasury, 0), 0));

    IF v_take > 0 THEN
      UPDATE clubs SET chip_treasury = chip_treasury - v_take WHERE id = r.club_id;
      v_union_balance := v_union_balance + v_take;
      UPDATE union_wallets SET chip_balance = v_union_balance WHERE union_id = p_union_id;
      v_collect_total := v_collect_total + v_take;

      INSERT INTO union_wallet_transactions (union_id, wallet, direction, amount, balance_after,
                                             tx_type, club_id, notes)
      VALUES (p_union_id, 'chip_balance', 'credit', v_take, v_union_balance,
              'player_pnl_collect', r.club_id,
              'Weekly player P&L: collected from club (owed ' || v_owed || ')');

      INSERT INTO chip_transactions (club_id, amount, transaction_type, notes, metadata)
      VALUES (r.club_id, v_take, 'union_pnl_collect',
              'Weekly union player P&L settlement: club owed ' || v_owed,
              jsonb_build_object('union_id', p_union_id, 'settlement_id', v_settlement_id,
                                 'period_start', p_start, 'net', r.net));
    END IF;

    SELECT id INTO v_period_id FROM settlement_periods
     WHERE club_id = r.club_id ORDER BY created_at DESC LIMIT 1;

    IF v_period_id IS NOT NULL THEN
      INSERT INTO settlement_invoices (club_id, period_id, invoice_type,
        from_entity_type, from_entity_id, to_entity_type, to_entity_id,
        gross_amount, net_amount, deductions, breakdown, status,
        chips_transferred, transferred_at, notes)
      VALUES (r.club_id, v_period_id, 'union_club_pnl',
        'club', r.club_id::text, 'union', p_union_id::text,
        v_owed, v_take, round(v_owed - v_take, 2),
        r.detail || jsonb_build_object('direction', 'club_owes_union',
                                       'collected', v_take,
                                       'shortfall', round(v_owed - v_take, 2)),
        CASE WHEN v_take >= v_owed THEN 'paid' ELSE 'pending' END,
        v_take > 0, CASE WHEN v_take > 0 THEN now() ELSE NULL END,
        CASE WHEN v_take < v_owed
             THEN 'Partial: club treasury short by ' || round(v_owed - v_take, 2)
             ELSE NULL END);
    END IF;

    v_unpaid_total := v_unpaid_total + round(v_owed - v_take, 2);
  END LOOP;

  -- ── PASS 3: PAY winning clubs (net > 0), pro-rata if the union is short ──
  SELECT COALESCE(SUM(net), 0) INTO v_winners_total FROM _pnl_tmp WHERE net > 0;
  IF v_winners_total > 0 AND v_union_balance < v_winners_total THEN
    v_scale := GREATEST(v_union_balance, 0) / v_winners_total;
  END IF;

  FOR r IN SELECT * FROM _pnl_tmp WHERE net > 0 ORDER BY club_id LOOP
    v_owed := round(r.net, 2);
    v_pay := round(v_owed * v_scale, 2);
    v_pay := LEAST(v_pay, GREATEST(v_union_balance, 0));

    IF v_pay > 0 THEN
      UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) + v_pay WHERE id = r.club_id;
      v_union_balance := v_union_balance - v_pay;
      UPDATE union_wallets SET chip_balance = v_union_balance WHERE union_id = p_union_id;
      v_pay_total := v_pay_total + v_pay;

      INSERT INTO union_wallet_transactions (union_id, wallet, direction, amount, balance_after,
                                             tx_type, club_id, notes)
      VALUES (p_union_id, 'chip_balance', 'debit', v_pay, v_union_balance,
              'player_pnl_pay', r.club_id,
              'Weekly player P&L: paid to club (owed ' || v_owed || ')');

      INSERT INTO chip_transactions (club_id, amount, transaction_type, notes, metadata)
      VALUES (r.club_id, v_pay, 'union_pnl_payout',
              'Weekly union player P&L settlement: union owed ' || v_owed,
              jsonb_build_object('union_id', p_union_id, 'settlement_id', v_settlement_id,
                                 'period_start', p_start, 'net', r.net));
    END IF;

    SELECT id INTO v_period_id FROM settlement_periods
     WHERE club_id = r.club_id ORDER BY created_at DESC LIMIT 1;

    IF v_period_id IS NOT NULL THEN
      INSERT INTO settlement_invoices (club_id, period_id, invoice_type,
        from_entity_type, from_entity_id, to_entity_type, to_entity_id,
        gross_amount, net_amount, deductions, breakdown, status,
        chips_transferred, transferred_at, notes)
      VALUES (r.club_id, v_period_id, 'union_club_pnl',
        'union', p_union_id::text, 'club', r.club_id::text,
        v_owed, v_pay, round(v_owed - v_pay, 2),
        r.detail || jsonb_build_object('direction', 'union_owes_club',
                                       'paid', v_pay,
                                       'shortfall', round(v_owed - v_pay, 2)),
        CASE WHEN v_pay >= v_owed THEN 'paid' ELSE 'pending' END,
        v_pay > 0, CASE WHEN v_pay > 0 THEN now() ELSE NULL END,
        CASE WHEN v_pay < v_owed
             THEN 'Partial: union chip wallet short by ' || round(v_owed - v_pay, 2)
             ELSE NULL END);
    END IF;

    v_unpaid_total := v_unpaid_total + round(v_owed - v_pay, 2);
  END LOOP;

  -- Mirror the per-club numbers onto the club's latest settlement_period.
  FOR r IN SELECT * FROM _pnl_tmp LOOP
    UPDATE settlement_periods sp
       SET total_player_winnings = COALESCE((r.detail->>'winnings')::numeric, 0),
           total_player_losses   = COALESCE((r.detail->>'losses')::numeric, 0),
           seated_stack_snapshot = r.seated
     WHERE sp.id = (SELECT id FROM settlement_periods
                     WHERE club_id = r.club_id ORDER BY created_at DESC LIMIT 1);
  END LOOP;

  SELECT jsonb_agg(detail ORDER BY club_id) INTO v_results FROM _pnl_tmp;

  UPDATE union_pnl_settlements
     SET status = 'settled',
         total_collected = v_collect_total,
         total_paid = v_pay_total,
         total_unpaid = v_unpaid_total,
         club_results = COALESCE(v_results, '[]'::jsonb),
         settled_at = now()
   WHERE id = v_settlement_id;

  RETURN jsonb_build_object(
    'success', true,
    'settlement_id', v_settlement_id,
    'union_id', p_union_id,
    'period_start', p_start,
    'period_end', p_end,
    'total_collected', v_collect_total,
    'total_paid', v_pay_total,
    'total_unpaid', v_unpaid_total,
    'union_balance_after', v_union_balance,
    'clubs', COALESCE(v_results, '[]'::jsonb)
  );
END $$;

REVOKE ALL ON FUNCTION fn_union_settle_player_pnl(uuid, timestamptz, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_settle_player_pnl(uuid, timestamptz, timestamptz, boolean) TO service_role;

-- Assertion: dry run works and returns the expected shape.
DO $$
DECLARE v jsonb;
BEGIN
  SELECT fn_union_settle_player_pnl(
    (SELECT id FROM unions LIMIT 1), now() - interval '7 days', now(), true
  ) INTO v;
  IF NOT (v->>'success')::boolean THEN
    RAISE EXCEPTION 'ASSERTION FAILED: dry run did not succeed: %', v;
  END IF;
END $$;
