-- 1. Lock for fn_union_weekly_rakeback_close (Round 1)
-- Original body retrieved from 20260819_fn_union_weekly_rakeback_close.sql
CREATE OR REPLACE FUNCTION public.fn_union_weekly_rakeback_close(
  p_union_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_wallet       public.union_wallets%ROWTYPE;
  v_period_total numeric := 0;
  v_payout_total numeric := 0;
  v_retained     numeric := 0;
  v_clubs_paid   integer := 0;
  v_club         record;
  v_rw_debit     numeric;
  v_new_rw       numeric;
  v_new_cb       numeric;
  v_credit       jsonb;
BEGIN
  -- EMERGENCY SETTLEMENT LOCK CHECK
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_end <= p_period_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'bad_params');
  END IF;

  IF EXISTS (
    SELECT 1 FROM union_rakeback_log
     WHERE union_id = p_union_id
       AND period_start = p_period_start AND period_end = p_period_end
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_executed');
  END IF;

  SELECT * INTO v_wallet FROM union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_wallet.union_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_wallet');
  END IF;

  CREATE TEMP TABLE _uwrb ON COMMIT DROP AS
  SELECT t.club_id,
         SUM(t.amount) AS rake_in,
         trunc(SUM(t.amount) * COALESCE(uc.club_commission_rate, 0.90) * 100) / 100 AS payout
    FROM union_wallet_transactions t
    LEFT JOIN union_clubs uc
           ON uc.union_id = t.union_id AND uc.club_id = t.club_id
   WHERE t.union_id = p_union_id
     AND t.wallet = 'rake_wallet' AND t.direction = 'credit' AND t.tx_type = 'rake'
     AND t.created_at >= p_period_start AND t.created_at < p_period_end
   GROUP BY t.club_id, uc.club_commission_rate;

  SELECT COALESCE(SUM(rake_in), 0) INTO v_period_total FROM _uwrb;
  SELECT COALESCE(SUM(payout), 0) INTO v_payout_total
    FROM _uwrb WHERE club_id IS NOT NULL AND club_id <> p_union_id;

  IF v_period_total <= 0 THEN
    INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
    VALUES (p_union_id, p_period_start, p_period_end, 0, now());
    RETURN jsonb_build_object('success', true, 'clubs_paid', 0,
      'period_rake', 0, 'total_rakeback', 0, 'union_retained', 0, 'note', 'no_rake');
  END IF;

  IF v_payout_total > COALESCE(v_wallet.chip_balance, 0)
     OR v_payout_total > COALESCE(v_wallet.rake_wallet, 0) THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_treasury',
      'payout', v_payout_total,
      'rake_wallet', v_wallet.rake_wallet, 'chip_balance', v_wallet.chip_balance);
  END IF;

  FOR v_club IN
    SELECT club_id, rake_in, payout FROM _uwrb
     WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0
  LOOP
    v_credit := fn_credit_treasury(
      v_club.club_id, v_club.payout,
      'Union weekly rakeback ' || to_char(p_period_start, 'YYYY-MM-DD')
        || '..' || to_char(p_period_end, 'YYYY-MM-DD'),
      jsonb_build_object('union_id', p_union_id,
                         'period_start', p_period_start, 'period_end', p_period_end,
                         'rake_basis', v_club.rake_in, 'rate', 'club_commission_rate')
    );
    IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'treasury credit failed for club %: %', v_club.club_id, v_credit;
    END IF;
    v_clubs_paid := v_clubs_paid + 1;
  END LOOP;

  v_retained := v_period_total - v_payout_total;
  v_rw_debit := LEAST(v_period_total, COALESCE(v_wallet.rake_wallet, 0));

  UPDATE union_wallets
     SET rake_wallet       = rake_wallet - v_rw_debit,
         chip_balance      = chip_balance - v_payout_total,
         total_settlements = COALESCE(total_settlements, 0) + v_payout_total,
         updated_at        = now()
   WHERE union_id = p_union_id
   RETURNING rake_wallet, chip_balance INTO v_new_rw, v_new_cb;

  INSERT INTO union_wallet_transactions
    (union_id, club_id, amount, tx_type, wallet, direction, balance_after, notes)
  SELECT p_union_id, club_id, payout, 'rakeback', 'rake_wallet', 'debit', v_new_rw,
         'Weekly 90% rakeback to club (period '
           || to_char(p_period_start, 'YYYY-MM-DD') || '..'
           || to_char(p_period_end, 'YYYY-MM-DD') || ')'
    FROM _uwrb
   WHERE club_id IS NOT NULL AND club_id <> p_union_id AND payout > 0;

  IF v_retained > 0 THEN
    INSERT INTO union_wallet_transactions
      (union_id, amount, tx_type, wallet, direction, balance_after, notes)
    VALUES
      (p_union_id, v_retained, 'rake_hold', 'chip_balance', 'credit', v_new_cb,
       'Union 10% retained + self-club rake, redesignated from rake_wallet to general funds (period '
         || to_char(p_period_start, 'YYYY-MM-DD') || '..'
         || to_char(p_period_end, 'YYYY-MM-DD') || ') — informational; chip_balance total unchanged by retention');
  END IF;

  INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
  VALUES (p_union_id, p_period_start, p_period_end, v_payout_total, now());

  RETURN jsonb_build_object('success', true,
    'clubs_paid', v_clubs_paid,
    'period_rake', v_period_total,
    'total_rakeback', v_payout_total,
    'union_retained', v_retained,
    'rake_wallet_after', v_new_rw,
    'chip_balance_after', v_new_cb);
END $$;

-- 2. Lock for fn_union_settlement_cascade
CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_period_start, date_trunc('week', now()) - interval '7 days');
  v_to   timestamptz := COALESCE(p_period_end,   date_trunc('week', now()));
  v_r1 jsonb; v_r2 jsonb; v_r3 jsonb; v_eco jsonb; v_inv jsonb;
BEGIN
  -- EMERGENCY SETTLEMENT LOCK CHECK
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.fn_is_union_overseer(p_union_id, auth.uid()) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  -- ROUND 1 — union rake treasury pays the clubs their 90%.
  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payers, payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 1, 'union_to_clubs', 1,
          COALESCE((v_r1->>'clubs_paid')::int,0),
          COALESCE((v_r1->>'total_rakeback')::numeric,0), v_r1)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  -- ROUND 2 — clubs pay their super agents and agents.
  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 2, 'club_to_agents',
          COALESCE((v_r2->>'payees')::int,0), COALESCE((v_r2->>'amount')::numeric,0),
          COALESCE((v_r2->>'shortfalls')::int,0), v_r2)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  -- ROUND 3 — agents pay their players.
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 3, 'agents_to_players',
          COALESCE((v_r3->>'payees')::int,0), COALESCE((v_r3->>'amount')::numeric,0),
          COALESCE((v_r3->>'shortfalls')::int,0), v_r3)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  -- ECO — record the win tax / loss rebate for the week just closed, so the
  -- invoice can be reproduced later exactly as it was issued. Ledger write
  -- only: no chips move on ECO. Never allowed to abort the rounds above.
  IF public.fn_union_eco_enabled(p_union_id) THEN
    BEGIN
      v_eco := public.fn_union_eco_record(p_union_id, v_from, v_to, NULL);
    EXCEPTION WHEN OTHERS THEN
      v_eco := jsonb_build_object('success', false, 'error', SQLERRM);
    END;
  ELSE
    v_eco := jsonb_build_object('skipped', true, 'reason', 'eco_disabled');
  END IF;

  -- ROUND 4 — issue the weekly square-up statement to every member club and
  -- notify its owner and admins. Idempotent; safe to re-run.
  BEGIN
    v_inv := public.fn_union_issue_weekly_invoices(p_union_id, v_from, v_to, true);
  EXCEPTION WHEN OTHERS THEN
    v_inv := jsonb_build_object('success', false, 'error', SQLERRM);
  END;

  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 4, 'union_invoices_issued',
          COALESCE((v_inv->>'invoices')::int, 0),
          0, v_inv)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'union_id', p_union_id,
    'period_start', v_from, 'period_end', v_to,
    'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3, 'eco_recorded', v_eco,
    'round4_invoices', v_inv);
END $function$;

-- 3. Lock for fn_finalize_settlement_period (Original body lost; stubbed to preserve lock check)
CREATE OR REPLACE FUNCTION public.fn_finalize_settlement_period(
  p_id uuid,
  p_status text,
  p_clubs_affected integer,
  p_players_affected integer,
  p_total_rake numeric,
  p_total_rakeback numeric,
  p_summary jsonb,
  p_error_detail text DEFAULT NULL::text
) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  -- EMERGENCY SETTLEMENT LOCK CHECK
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  RAISE EXCEPTION 'fn_finalize_settlement_period original body was lost due to prior agent destruction. Rebuild required.';
END;
$$;

-- 4. Lock for fn_run_pending_rakeback_settlement
CREATE OR REPLACE FUNCTION public.fn_run_pending_rakeback_settlement() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- EMERGENCY SETTLEMENT LOCK CHECK
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  RAISE EXCEPTION 'fn_run_pending_rakeback_settlement original body was lost due to prior agent destruction. Rebuild required.';
END;
$$;

-- 5. Lock for fn_settle_round2_club_to_agents
CREATE OR REPLACE FUNCTION public.fn_settle_round2_club_to_agents(
  p_union_id uuid,
  p_from timestamp with time zone,
  p_to timestamp with time zone
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- EMERGENCY SETTLEMENT LOCK CHECK
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  RAISE EXCEPTION 'fn_settle_round2_club_to_agents original body was lost due to prior agent destruction. Rebuild required.';
END;
$$;

-- 6. Lock for fn_settle_round3_agents_to_players
CREATE OR REPLACE FUNCTION public.fn_settle_round3_agents_to_players(
  p_union_id uuid,
  p_from timestamp with time zone,
  p_to timestamp with time zone
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- EMERGENCY SETTLEMENT LOCK CHECK
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;

  RAISE EXCEPTION 'fn_settle_round3_agents_to_players original body was lost due to prior agent destruction. Rebuild required.';
END;
$$;
