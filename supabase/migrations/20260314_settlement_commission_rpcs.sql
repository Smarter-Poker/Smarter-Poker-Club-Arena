-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 6: Settlement, Commission, Credit & Wallet RPCs
-- Deploy Date: 2026-03-14
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. get_current_settlement_period
-- Returns the current open settlement period, or creates one if none exists.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION get_current_settlement_period()
RETURNS TABLE(id uuid, period_start timestamptz, period_end timestamptz, status text, total_rake numeric)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_now timestamptz := now();
  v_start timestamptz;
  v_end timestamptz;
  v_id uuid;
BEGIN
  -- Try to find current open period
  RETURN QUERY
    SELECT sp.id, sp.start_at, sp.end_at, sp.status::text, COALESCE(sp.total_rake_collected, 0)
    FROM settlement_periods sp
    WHERE sp.status = 'open'
    ORDER BY sp.start_at DESC
    LIMIT 1;

  IF NOT FOUND THEN
    -- Create a new period: Sunday-to-Sunday
    v_start := date_trunc('week', v_now) - interval '1 day'; -- Previous Sunday
    v_end := v_start + interval '7 days';
    v_id := gen_random_uuid();

    INSERT INTO settlement_periods (id, start_at, end_at, status, total_rake_collected)
    VALUES (v_id, v_start, v_end, 'open', 0)
    ON CONFLICT DO NOTHING;

    RETURN QUERY
      SELECT sp.id, sp.start_at, sp.end_at, sp.status::text, COALESCE(sp.total_rake_collected, 0)
      FROM settlement_periods sp
      WHERE sp.id = v_id;
  END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. generate_period_settlements
-- Generates settlement records for all clubs/agents in a period.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION generate_period_settlements(p_period_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_period record;
  v_result jsonb := '{}';
BEGIN
  SELECT * INTO v_period FROM settlement_periods WHERE id = p_period_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Settlement period not found: %', p_period_id;
  END IF;

  -- Generate club settlements
  INSERT INTO club_settlements (period_id, club_id, club_name, total_rake_collected, status)
  SELECT p_period_id, c.id, c.name, COALESCE(SUM(rh.rake_amount), 0), 'pending'
  FROM clubs c
  LEFT JOIN rake_history rh ON rh.club_id = c.id
    AND rh.collected_at >= v_period.start_at
    AND rh.collected_at < v_period.end_at
  GROUP BY c.id, c.name
  ON CONFLICT DO NOTHING;

  -- Generate agent settlements  
  INSERT INTO agent_settlements (period_id, agent_id, agent_name, total_rake_generated, commission_rate, commission_earned, net_settlement, status)
  SELECT p_period_id, a.id,
    COALESCE(p.display_name, p.username, 'Unknown'),
    COALESCE(SUM(ra.rake_amount), 0),
    COALESCE(a.commission_rate, 0),
    COALESCE(SUM(ra.rake_amount), 0) * COALESCE(a.commission_rate, 0),
    COALESCE(SUM(ra.rake_amount), 0) * COALESCE(a.commission_rate, 0),
    'pending'
  FROM agents a
  LEFT JOIN profiles p ON p.id = a.user_id
  LEFT JOIN rake_attributions ra ON ra.agent_id = a.id
    AND ra.created_at >= v_period.start_at
    AND ra.created_at < v_period.end_at
  WHERE a.status = 'active'
  GROUP BY a.id, p.display_name, p.username
  ON CONFLICT DO NOTHING;

  v_result := jsonb_build_object('status', 'generated', 'period_id', p_period_id);
  RETURN v_result;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. calculate_agent_settlement
-- Calculates settlement details for a specific agent in a period.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION calculate_agent_settlement(p_period_id uuid, p_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_settlement record;
  v_agent record;
BEGIN
  SELECT * INTO v_agent FROM agents WHERE id = p_agent_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO v_settlement
  FROM agent_settlements
  WHERE period_id = p_period_id AND agent_id = p_agent_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'id', v_settlement.id,
      'periodId', v_settlement.period_id,
      'agentId', v_settlement.agent_id,
      'agentName', v_settlement.agent_name,
      'totalRakeGenerated', v_settlement.total_rake_generated,
      'commissionRate', v_settlement.commission_rate,
      'commissionEarned', v_settlement.commission_earned,
      'creditExtended', COALESCE(v_settlement.total_credit_extended, 0),
      'creditRepaid', COALESCE(v_settlement.total_credit_repaid, 0),
      'netSettlement', v_settlement.net_settlement,
      'activePlayers', COALESCE(v_settlement.active_players, 0),
      'status', v_settlement.status
    );
  ELSE
    RETURN jsonb_build_object(
      'id', p_agent_id || '-' || p_period_id,
      'periodId', p_period_id,
      'agentId', p_agent_id,
      'agentName', 'Unknown',
      'totalRakeGenerated', 0,
      'commissionRate', 0,
      'commissionEarned', 0,
      'creditExtended', 0,
      'creditRepaid', 0,
      'netSettlement', 0,
      'activePlayers', 0,
      'status', 'pending'
    );
  END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. calculate_agent_spread
-- Calculates commission spread for an agent (gross, payouts, net margin).
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION calculate_agent_spread(p_agent_id uuid, p_period_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_agent record;
  v_gross_rate numeric;
  v_total_rake numeric;
  v_downline_total numeric := 0;
BEGIN
  SELECT * INTO v_agent FROM agents WHERE id = p_agent_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Get gross commission rate
  SELECT COALESCE(rate, 0) INTO v_gross_rate
  FROM commission_structures
  WHERE agent_id = p_agent_id AND target_role = 'AGENT'
  LIMIT 1;

  -- Get total rake generated by this agent's players
  SELECT COALESCE(SUM(rake_amount), 0) INTO v_total_rake
  FROM rake_attributions
  WHERE agent_id = p_agent_id;

  -- Get what we pay to downlines  
  SELECT COALESCE(SUM(ra.rake_amount * cs.rate), 0) INTO v_downline_total
  FROM agents sub
  JOIN rake_attributions ra ON ra.agent_id = sub.id
  JOIN commission_structures cs ON cs.agent_id = p_agent_id AND cs.target_role = 'SUB_AGENT'
  WHERE sub.parent_agent_id = p_agent_id;

  RETURN jsonb_build_object(
    'agentId', p_agent_id,
    'grossCommissionRate', v_gross_rate,
    'payoutToDownlines', v_downline_total,
    'netMargin', (v_total_rake * v_gross_rate) - v_downline_total,
    'downlineBreakdown', '[]'::jsonb
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. atomic_pay_agent_settlement
-- Atomically pay an agent their settlement earnings.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION atomic_pay_agent_settlement(
  p_settlement_id uuid,
  p_agent_id uuid,
  p_amount numeric,
  p_period_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id uuid;
BEGIN
  -- Get agent's auth user_id
  SELECT user_id INTO v_user_id FROM agents WHERE id = p_agent_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Agent not found: %', p_agent_id;
  END IF;

  -- Credit user wallet
  UPDATE profiles SET chip_balance = COALESCE(chip_balance, 0) + p_amount WHERE id = v_user_id;

  -- Log the transaction
  INSERT INTO chip_transactions (from_user_id, to_user_id, amount, transaction_type, notes, club_id)
  SELECT NULL, v_user_id, p_amount, 'settlement_payout',
    'Weekly agent commission settlement for period ' || p_period_id::text,
    a.club_id
  FROM agents a WHERE a.id = p_agent_id;

  -- Mark settlement as paid
  UPDATE agent_settlements
  SET status = 'paid', paid_at = now()
  WHERE id = p_settlement_id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. atomic_pay_player_rakeback
-- Atomically pay a player their weekly rakeback.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION atomic_pay_player_rakeback(
  p_snapshot_id uuid,
  p_player_id uuid,
  p_amount numeric,
  p_period_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Credit player wallet
  UPDATE profiles SET chip_balance = COALESCE(chip_balance, 0) + p_amount WHERE id = p_player_id;

  -- Log the transaction
  INSERT INTO chip_transactions (from_user_id, to_user_id, amount, transaction_type, notes)
  VALUES (NULL, p_player_id, p_amount, 'rakeback_payout',
    'Weekly rakeback for period ' || p_period_id::text);

  -- Mark snapshot as paid
  UPDATE player_weekly_snapshots
  SET paid = true, paid_at = now()
  WHERE id = p_snapshot_id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. get_union_rake_for_period
-- Gets rake amounts per club for a union within a time range.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION get_union_rake_for_period(
  p_union_id uuid,
  p_start timestamptz,
  p_end timestamptz
)
RETURNS TABLE(club_id uuid, club_name text, rake_amount numeric)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
    SELECT c.id, c.name, COALESCE(SUM(rh.rake_amount), 0)
    FROM clubs c
    LEFT JOIN rake_history rh ON rh.club_id = c.id
      AND rh.collected_at >= p_start
      AND rh.collected_at < p_end
    WHERE c.union_id = p_union_id
    GROUP BY c.id, c.name;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. atomic_wallet_transfer
-- Atomic wallet-to-wallet transfer with full audit logging.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION atomic_wallet_transfer(
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_category text DEFAULT 'transfer',
  p_debit_description text DEFAULT '',
  p_credit_description text DEFAULT '',
  p_related_entity_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_from_balance numeric;
BEGIN
  -- Check sender has enough
  SELECT chip_balance INTO v_from_balance FROM profiles WHERE id = p_from_user_id FOR UPDATE;
  IF v_from_balance IS NULL OR v_from_balance < p_amount THEN
    RETURN false;
  END IF;

  -- Debit sender
  UPDATE profiles SET chip_balance = chip_balance - p_amount WHERE id = p_from_user_id;
  -- Credit receiver
  UPDATE profiles SET chip_balance = COALESCE(chip_balance, 0) + p_amount WHERE id = p_to_user_id;

  -- Log debit
  INSERT INTO chip_transactions (from_user_id, to_user_id, amount, transaction_type, notes)
  VALUES (p_from_user_id, p_to_user_id, p_amount, p_category,
    COALESCE(NULLIF(p_debit_description, ''), 'Wallet transfer'));

  RETURN true;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. calculate_cascading_commission
-- Walks up agent tree, calculating each level's commission share.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION calculate_cascading_commission(
  p_rake_amount numeric,
  p_player_id uuid
)
RETURNS TABLE(agent_id uuid, amount numeric, level int)
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_agent_id uuid;
  v_parent_id uuid;
  v_rate numeric;
  v_remaining numeric := p_rake_amount;
  v_level int := 1;
BEGIN
  -- Find the player's direct agent
  SELECT a.id INTO v_agent_id
  FROM club_members cm
  JOIN agents a ON a.club_id = cm.club_id AND a.user_id = cm.referred_by
  WHERE cm.user_id = p_player_id
  LIMIT 1;

  -- Walk up the tree
  WHILE v_agent_id IS NOT NULL AND v_remaining > 0 AND v_level <= 5 LOOP
    -- Get commission rate
    SELECT COALESCE(cs.rate, 0) INTO v_rate
    FROM commission_structures cs
    WHERE cs.agent_id = v_agent_id
    LIMIT 1;

    IF v_rate > 0 THEN
      agent_id := v_agent_id;
      amount := v_remaining * v_rate;
      level := v_level;
      RETURN NEXT;
      v_remaining := v_remaining - amount;
    END IF;

    -- Move up the tree
    SELECT a.parent_agent_id INTO v_parent_id FROM agents a WHERE a.id = v_agent_id;
    v_agent_id := v_parent_id;
    v_level := v_level + 1;
  END LOOP;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 10. execute_commission_payout
-- Executes a commission payout: credits agent wallet, marks paid.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION execute_commission_payout(p_payout_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_payout record;
  v_user_id uuid;
BEGIN
  SELECT * INTO v_payout FROM commission_payouts WHERE id = p_payout_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Commission payout not found: %', p_payout_id;
  END IF;

  SELECT user_id INTO v_user_id FROM agents WHERE id = v_payout.agent_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Agent not found for payout: %', v_payout.agent_id;
  END IF;

  -- Credit agent wallet
  UPDATE profiles SET chip_balance = COALESCE(chip_balance, 0) + v_payout.net_payout
  WHERE id = v_user_id;

  -- Log transaction
  INSERT INTO chip_transactions (from_user_id, to_user_id, amount, transaction_type, notes)
  VALUES (NULL, v_user_id, v_payout.net_payout, 'commission_payout',
    'Commission payout for period ' || v_payout.period_id::text);

  -- Mark paid
  UPDATE commission_payouts
  SET status = 'paid', paid_at = now()
  WHERE id = p_payout_id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 11. generate_period_commissions
-- Generates commission payout records for all agents in a period.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION generate_period_commissions(p_period_id uuid)
RETURNS TABLE(agent_id uuid, period_id uuid, gross_rake numeric, commission_earned numeric, paid_to_downlines numeric, net_payout numeric, status text)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
    INSERT INTO commission_payouts (agent_id, period_id, gross_rake, commission_earned, paid_to_downlines, net_payout, status)
    SELECT
      s.agent_id,
      s.period_id,
      s.total_rake_generated,
      s.commission_earned,
      0, -- paid_to_downlines computed later
      s.commission_earned,
      'pending'
    FROM agent_settlements s
    WHERE s.period_id = p_period_id AND s.commission_earned > 0
    ON CONFLICT DO NOTHING
    RETURNING commission_payouts.agent_id, commission_payouts.period_id,
      commission_payouts.gross_rake, commission_payouts.commission_earned,
      commission_payouts.paid_to_downlines, commission_payouts.net_payout,
      commission_payouts.status::text;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 12. get_player_rake_total
-- Gets total rake contribution for a player, optionally within a period.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION get_player_rake_total(p_player_id uuid, p_period_id uuid DEFAULT NULL)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_total numeric;
  v_period record;
BEGIN
  IF p_period_id IS NOT NULL THEN
    SELECT * INTO v_period FROM settlement_periods WHERE id = p_period_id;
    SELECT COALESCE(SUM(rake_amount), 0) INTO v_total
    FROM rake_attributions
    WHERE player_id = p_player_id
      AND created_at >= v_period.start_at
      AND created_at < v_period.end_at;
  ELSE
    SELECT COALESCE(SUM(rake_amount), 0) INTO v_total
    FROM rake_attributions
    WHERE player_id = p_player_id;
  END IF;

  RETURN v_total;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 13. atomic_credit_wallet_and_log
-- Atomically credits a user's wallet and logs the transaction.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION atomic_credit_wallet_and_log(
  p_user_id uuid,
  p_amount numeric,
  p_category text DEFAULT 'credit',
  p_description text DEFAULT '',
  p_table_id uuid DEFAULT NULL,
  p_hand_id uuid DEFAULT NULL,
  p_related_entity_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Credit wallet
  UPDATE profiles SET chip_balance = COALESCE(chip_balance, 0) + p_amount
  WHERE id = p_user_id;

  IF NOT FOUND THEN RETURN false; END IF;

  -- Log transaction
  INSERT INTO chip_transactions (to_user_id, amount, transaction_type, notes, table_id)
  VALUES (p_user_id, p_amount, p_category,
    COALESCE(NULLIF(p_description, ''), 'Wallet credit'),
    p_table_id);

  RETURN true;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 14. atomic_deduct_wallet_and_log
-- Atomically deducts from a user's wallet and logs the transaction.
-- Returns false if insufficient balance.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION atomic_deduct_wallet_and_log(
  p_user_id uuid,
  p_amount numeric,
  p_category text DEFAULT 'debit',
  p_description text DEFAULT '',
  p_table_id uuid DEFAULT NULL,
  p_hand_id uuid DEFAULT NULL,
  p_related_entity_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_balance numeric;
BEGIN
  -- Lock and check balance
  SELECT chip_balance INTO v_balance FROM profiles WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_amount THEN
    RETURN false;
  END IF;

  -- Deduct
  UPDATE profiles SET chip_balance = chip_balance - p_amount WHERE id = p_user_id;

  -- Log transaction
  INSERT INTO chip_transactions (from_user_id, amount, transaction_type, notes, table_id)
  VALUES (p_user_id, p_amount, p_category,
    COALESCE(NULLIF(p_description, ''), 'Wallet debit'),
    p_table_id);

  RETURN true;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 15. wallet_user_transfer
-- User-to-user wallet transfer with optional reference ID.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION wallet_user_transfer(
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_from_wallet text DEFAULT 'PLAYER',
  p_to_wallet text DEFAULT 'PLAYER',
  p_reference_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_from_balance numeric;
BEGIN
  -- Lock and check balance
  SELECT chip_balance INTO v_from_balance FROM profiles WHERE id = p_from_user_id FOR UPDATE;
  IF v_from_balance IS NULL OR v_from_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient balance for transfer';
  END IF;

  -- Debit sender
  UPDATE profiles SET chip_balance = chip_balance - p_amount WHERE id = p_from_user_id;
  -- Credit receiver
  UPDATE profiles SET chip_balance = COALESCE(chip_balance, 0) + p_amount WHERE id = p_to_user_id;

  -- Log
  INSERT INTO chip_transactions (from_user_id, to_user_id, amount, transaction_type, notes)
  VALUES (p_from_user_id, p_to_user_id, p_amount, 'user_transfer',
    CASE WHEN p_reference_id IS NOT NULL
      THEN 'Transfer ref: ' || p_reference_id::text
      ELSE 'User-to-user transfer'
    END);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 16. verify_and_log_union_rakeback
-- Idempotency guard for union rakeback execution.
-- Returns true if execution should proceed, false if already executed.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION verify_and_log_union_rakeback(
  p_union_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_total_rakeback numeric
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_exists boolean;
BEGIN
  -- Check if already executed
  SELECT EXISTS(
    SELECT 1 FROM union_rakeback_log
    WHERE union_id = p_union_id
      AND period_start = p_period_start
      AND period_end = p_period_end
  ) INTO v_exists;

  IF v_exists THEN
    RETURN false;
  END IF;

  -- Log this execution attempt
  INSERT INTO union_rakeback_log (union_id, period_start, period_end, total_rakeback, executed_at)
  VALUES (p_union_id, p_period_start, p_period_end, p_total_rakeback, now())
  ON CONFLICT DO NOTHING;

  RETURN true;
END;
$$;
