-- ═══════════════════════════════════════════════════════════════════════════════
-- Financial Hardening Batch 4: Critical race condition fixes + missing flows
-- Found by end-to-end financial flow audit
-- Deploy Date: 2026-03-17
-- Status: APPLIED TO LIVE DB
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. CRITICAL: Prevent double agent payouts (unique constraint)
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_settlements_agent_period
  ON agent_settlements(agent_id, period_id);

-- 2. CRITICAL: Idempotent cashout cancel (prevents double refund race)
DROP FUNCTION IF EXISTS fn_cancel_cashout(uuid, uuid);
CREATE OR REPLACE FUNCTION fn_cancel_cashout(p_cashout_id uuid, p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_cashout RECORD;
BEGIN
  -- Atomically claim the cashout (only if still pending)
  UPDATE cashout_requests SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
  WHERE id = p_cashout_id AND player_id = p_user_id AND status = 'pending'
  RETURNING * INTO v_cashout;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cashout not found or already processed');
  END IF;
  -- Return chips to player wallet
  UPDATE wallets SET balance = balance + v_cashout.amount, updated_at = NOW()
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description)
  VALUES (p_user_id, 'PLAYER', 'credit', v_cashout.amount, 'cashout_cancel', 'Cashout cancelled — chips returned');
  RETURN jsonb_build_object('success', true, 'amount', v_cashout.amount);
END; $func$;

-- 3. CRITICAL: Idempotent cashout reject (prevents double refund race)
CREATE OR REPLACE FUNCTION fn_reject_cashout(p_cashout_id uuid, p_agent_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_cashout RECORD;
BEGIN
  UPDATE cashout_requests SET status = 'rejected', agent_note = COALESCE(p_reason, agent_note), updated_at = NOW()
  WHERE id = p_cashout_id AND status = 'pending'
  RETURNING * INTO v_cashout;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cashout not found or already processed');
  END IF;
  UPDATE wallets SET balance = balance + v_cashout.amount, updated_at = NOW()
  WHERE user_id = v_cashout.player_id AND wallet_type = 'PLAYER';
  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description)
  VALUES (v_cashout.player_id, 'PLAYER', 'credit', v_cashout.amount, 'cashout_rejected', 'Cashout rejected — chips returned');
  RETURN jsonb_build_object('success', true, 'amount', v_cashout.amount, 'player_id', v_cashout.player_id);
END; $func$;

-- 4. CRITICAL: Tournament prize distribution (was completely missing)
CREATE OR REPLACE FUNCTION distribute_tournament_prizes(p_tournament_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $func$
DECLARE
  v_tournament RECORD;
  v_player RECORD;
  v_payout_structure jsonb;
  v_payout_pct numeric;
  v_payout_amount numeric;
  v_total_distributed numeric := 0;
  v_paid_count integer := 0;
  v_club_id uuid;
BEGIN
  SELECT * INTO v_tournament FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
  IF v_tournament.status != 'completed' THEN
    RAISE EXCEPTION 'Tournament must be completed to distribute prizes (status: %)', v_tournament.status;
  END IF;
  v_club_id := v_tournament.club_id;
  v_payout_structure := COALESCE(v_tournament.payout_structure, '{"1": 100}'::jsonb);
  FOR v_player IN (
    SELECT tp.user_id, tp.id as player_id,
           ROW_NUMBER() OVER (ORDER BY tp.id) as finish_position
    FROM tournament_players tp WHERE tp.tournament_id = p_tournament_id ORDER BY tp.id
  ) LOOP
    v_payout_pct := (v_payout_structure->>v_player.finish_position::text)::numeric;
    IF v_payout_pct IS NULL OR v_payout_pct <= 0 THEN CONTINUE; END IF;
    v_payout_amount := ROUND(v_tournament.prize_pool * v_payout_pct / 100, 2);
    IF v_payout_amount <= 0 THEN CONTINUE; END IF;
    INSERT INTO wallets (user_id, wallet_type, balance) VALUES (v_player.user_id, 'PLAYER', v_payout_amount)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + v_payout_amount, updated_at = NOW();
    INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, related_entity_id)
    VALUES (v_player.user_id, 'PLAYER', 'credit', v_payout_amount, 'tournament_prize',
            'Tournament prize: ' || COALESCE(v_tournament.name, 'Unknown') || ' (Position ' || v_player.finish_position || ')',
            p_tournament_id);
    IF v_club_id IS NOT NULL THEN
      INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type, notes)
      VALUES (v_club_id, v_player.user_id, v_payout_amount, 'tournament_payout',
              'Prize for position ' || v_player.finish_position || ' in ' || COALESCE(v_tournament.name, 'Unknown'));
    END IF;
    v_total_distributed := v_total_distributed + v_payout_amount;
    v_paid_count := v_paid_count + 1;
  END LOOP;
  UPDATE tournaments SET updated_at = NOW() WHERE id = p_tournament_id;
  RETURN jsonb_build_object('success', true, 'total_distributed', v_total_distributed,
    'players_paid', v_paid_count, 'prize_pool', v_tournament.prize_pool);
END; $func$;

-- 5. Rake attributions table (persist per-hand rakeback data)
DROP TABLE IF EXISTS rake_attributions CASCADE;
CREATE TABLE rake_attributions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  club_id uuid NOT NULL,
  hand_id uuid,
  table_id uuid,
  rake_amount numeric NOT NULL DEFAULT 0,
  pot_contribution numeric NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE rake_attributions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY ra_select_own ON rake_attributions FOR SELECT USING (user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS idx_rake_attr_user_club ON rake_attributions(user_id, club_id, created_at);

-- 6. RPC to persist per-hand rake attribution
CREATE OR REPLACE FUNCTION record_hand_rake_attribution(
  p_hand_id uuid, p_table_id uuid, p_club_id uuid, p_attributions jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_attr jsonb;
BEGIN
  FOR v_attr IN SELECT * FROM jsonb_array_elements(p_attributions)
  LOOP
    INSERT INTO rake_attributions (user_id, club_id, hand_id, table_id, rake_amount, pot_contribution)
    VALUES (
      (v_attr->>'user_id')::uuid, p_club_id, p_hand_id, p_table_id,
      (v_attr->>'rake_amount')::numeric, (v_attr->>'pot_contribution')::numeric
    );
  END LOOP;
END; $func$;
