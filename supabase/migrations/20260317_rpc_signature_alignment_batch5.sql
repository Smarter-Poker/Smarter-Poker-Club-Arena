-- ═══════════════════════════════════════════════════════════════════════════════
-- RPC Signature Alignment Batch 5: Fix call site ↔ function mismatches
-- Found by cross-referencing all supabase.rpc() calls against live DB signatures
-- Deploy Date: 2026-03-17
-- Status: APPLIED TO LIVE DB
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. update_player_hand_stats: app sends (profit, is_voluntary, etc.) but old RPC expected (hands_played, hands_won)
DROP FUNCTION IF EXISTS update_player_hand_stats(uuid, integer, integer);
CREATE OR REPLACE FUNCTION update_player_hand_stats(
  p_user_id uuid,
  p_profit numeric DEFAULT 0,
  p_is_voluntary boolean DEFAULT false,
  p_is_preflop_raise boolean DEFAULT false,
  p_went_to_showdown boolean DEFAULT false,
  p_won_at_showdown boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $func$
BEGIN
  UPDATE profiles
  SET total_hands_played = COALESCE(total_hands_played, 0) + 1,
      updated_at = now()
  WHERE id = p_user_id;
END; $func$;

-- 2. execute_commission_payout: rewritten to accept p_payout_id and look up data internally
-- 3. credit_player_rakeback: fix to accept text description (was uuid period_id)
DROP FUNCTION IF EXISTS credit_player_rakeback(uuid, numeric);
DROP FUNCTION IF EXISTS credit_player_rakeback(uuid, numeric, uuid);
CREATE OR REPLACE FUNCTION credit_player_rakeback(
  p_user_id uuid, p_amount numeric, p_description text DEFAULT ''
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE v_club_id uuid;
BEGIN
  IF p_amount <= 0 THEN RETURN false; END IF;
  UPDATE wallets SET balance = COALESCE(balance, 0) + p_amount, updated_at = now()
  WHERE user_id = p_user_id AND wallet_type = 'PLAYER';
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
    VALUES (p_user_id, 'PLAYER', p_amount, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + p_amount, updated_at = now();
  END IF;
  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description)
  VALUES (p_user_id, 'PLAYER', 'credit', p_amount, 'rakeback', COALESCE(NULLIF(p_description, ''), 'Rakeback credit'));
  SELECT club_id INTO v_club_id FROM club_members WHERE user_id = p_user_id LIMIT 1;
  IF v_club_id IS NULL THEN v_club_id := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid; END IF;
  INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type, notes)
  VALUES (v_club_id, p_user_id, p_amount, 'rakeback', COALESCE(NULLIF(p_description, ''), 'Rakeback credit'));
  RETURN true;
END; $func$;

-- 4. fn_save_player_note: fix to accept p_target_user_id + p_tags
DROP FUNCTION IF EXISTS fn_save_player_note(uuid, uuid, text, text);
CREATE OR REPLACE FUNCTION fn_save_player_note(
  p_user_id uuid, p_target_user_id uuid, p_note text,
  p_color text DEFAULT 'blue', p_tags text[] DEFAULT '{}'
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $func$
BEGIN
  INSERT INTO player_notes (user_id, target_user_id, notes, color_label, tags, updated_at)
  VALUES (p_user_id, p_target_user_id, p_note, p_color, p_tags, now())
  ON CONFLICT (user_id, target_user_id) DO UPDATE SET
    notes = p_note, color_label = p_color, tags = p_tags, updated_at = now();
END; $func$;

-- 5. execute_commission_payout: accept p_payout_id
DROP FUNCTION IF EXISTS execute_commission_payout(uuid, numeric, uuid, uuid);
CREATE OR REPLACE FUNCTION execute_commission_payout(p_payout_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $func$
DECLARE
  v_payout RECORD;
  v_club_id uuid;
BEGIN
  SELECT * INTO v_payout FROM commission_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Payout not found');
  END IF;
  IF v_payout.status = 'paid' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Already paid');
  END IF;
  UPDATE wallets SET balance = COALESCE(balance, 0) + v_payout.net_payout, updated_at = now()
  WHERE user_id = v_payout.agent_id AND wallet_type = 'PLAYER';
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, wallet_type, balance, locked_balance)
    VALUES (v_payout.agent_id, 'PLAYER', v_payout.net_payout, 0)
    ON CONFLICT (user_id, wallet_type) DO UPDATE SET balance = wallets.balance + v_payout.net_payout, updated_at = now();
  END IF;
  SELECT club_id INTO v_club_id FROM club_members WHERE user_id = v_payout.agent_id LIMIT 1;
  IF v_club_id IS NULL THEN v_club_id := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid; END IF;
  INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type, notes)
  VALUES (v_club_id, v_payout.agent_id, v_payout.net_payout, 'commission_payout',
          'Commission payout for period ' || COALESCE(v_payout.period_id::text, 'unknown'));
  INSERT INTO wallet_transactions (user_id, wallet_type, type, amount, category, description, related_entity_id)
  VALUES (v_payout.agent_id, 'PLAYER', 'credit', v_payout.net_payout, 'commission', 'Commission payout', p_payout_id);
  UPDATE commission_payouts SET status = 'paid', paid_at = now() WHERE id = p_payout_id;
  RETURN jsonb_build_object('success', true, 'amount', v_payout.net_payout, 'agent_id', v_payout.agent_id);
END; $func$;
