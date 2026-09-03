-- ═══════════════════════════════════════════════════════════════════════════════
-- BUG 010 FIX — fn_clawback_chips_atomic was a stub that only wrote a non-existent
--                audit table and returned success with zero chips moved
-- ═══════════════════════════════════════════════════════════════════════════════
-- DISCOVERY (2026-04-15 live verification Phase D-2 #3):
--   - 13,902 chip_transactions exist; ZERO are is_reversed=true
--   - Existing fn_clawback_chips_atomic body was:
--       INSERT INTO clawback_audit_log (...) VALUES (...);
--       RETURN jsonb_build_object('success', true, 'clawed_back', p_amount);
--   - clawback_audit_log table DOES NOT EXIST → every call raises 42P01
--   - Client UI (AgentService.clawbackDistribution) shows "success" on response
--     because the RPC signature returns jsonb → on error, client-side swallow
--
-- FIX:
--   Replace with a real atomic clawback:
--   1. Lookup the chip_transactions row by id + verify not already reversed
--   2. Enforce 10-min window via chip_transactions.reversible_until
--   3. Debit recipient's player_balance (the user the chips were sent to)
--   4. Credit sender's agent business_balance (the agent who sent them)
--   5. Mark chip_transactions.is_reversed=true + clawed_back=true
--   6. Insert audit row into chip_transactions as a new 'CLAWBACK' transaction
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_clawback_chips_atomic(
  p_transaction_id uuid,
  p_club_id uuid,
  p_agent_id uuid,
  p_amount numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tx RECORD;
  v_to_user_balance NUMERIC;
  v_agent_balance NUMERIC;
BEGIN
  -- Step 1: Lock + lookup the transaction
  SELECT id, from_user_id, to_user_id, amount, is_reversed, clawed_back,
         reversible_until, transaction_type, club_id
    INTO v_tx
    FROM chip_transactions
    WHERE id = p_transaction_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'transaction_not_found');
  END IF;

  IF v_tx.is_reversed OR v_tx.clawed_back THEN
    RETURN jsonb_build_object('success', false, 'error', 'already_reversed');
  END IF;

  IF v_tx.club_id IS NOT NULL AND v_tx.club_id <> p_club_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'club_mismatch');
  END IF;

  IF v_tx.reversible_until IS NOT NULL AND v_tx.reversible_until < NOW() THEN
    RETURN jsonb_build_object('success', false, 'error', 'clawback_window_expired',
                              'expired_at', v_tx.reversible_until);
  END IF;

  IF v_tx.amount <> p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount_mismatch',
                              'expected', v_tx.amount, 'got', p_amount);
  END IF;

  -- Step 2: Debit recipient (to_user_id) player_balance
  UPDATE agents SET
    player_balance = COALESCE(player_balance, 0) - p_amount,
    updated_at = NOW()
    WHERE user_id = v_tx.to_user_id AND club_id = p_club_id
    RETURNING player_balance INTO v_to_user_balance;

  IF v_to_user_balance IS NULL THEN
    -- Recipient is a regular player (not agent) — debit via wallets table
    UPDATE wallets SET
      balance = COALESCE(balance, 0) - p_amount,
      updated_at = NOW()
      WHERE user_id = v_tx.to_user_id AND wallet_type = 'PLAYER'
      RETURNING balance INTO v_to_user_balance;
  END IF;

  IF v_to_user_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'recipient_wallet_not_found');
  END IF;

  IF v_to_user_balance < 0 THEN
    -- Insufficient — rollback and refuse
    RAISE EXCEPTION 'Recipient has spent the distributed chips — clawback would create negative balance';
  END IF;

  -- Step 3: Credit sender (agent) business_balance
  UPDATE agents SET
    business_balance = COALESCE(business_balance, 0) + p_amount,
    updated_at = NOW()
    WHERE id = p_agent_id
    RETURNING business_balance INTO v_agent_balance;

  IF v_agent_balance IS NULL THEN
    RAISE EXCEPTION 'Agent not found: %', p_agent_id;
  END IF;

  -- Step 4: Mark original transaction as reversed
  UPDATE chip_transactions SET
    is_reversed = true,
    clawed_back = true
    WHERE id = p_transaction_id;

  -- Step 5: Insert reversal audit row
  INSERT INTO chip_transactions (
    club_id, from_user_id, to_user_id, amount, transaction_type,
    notes, balance_after, metadata
  ) VALUES (
    p_club_id,
    v_tx.to_user_id,   -- reversed direction
    (SELECT user_id FROM agents WHERE id = p_agent_id),
    p_amount,
    'CLAWBACK',
    format('Clawback of transaction %s', p_transaction_id),
    v_agent_balance,
    jsonb_build_object('reversed_transaction_id', p_transaction_id,
                       'clawback_by_agent_id', p_agent_id)
  );

  RETURN jsonb_build_object(
    'success', true,
    'clawed_back', p_amount,
    'reversed_transaction_id', p_transaction_id,
    'new_recipient_balance', v_to_user_balance,
    'new_agent_balance', v_agent_balance
  );
END;
$$;

COMMENT ON FUNCTION public.fn_clawback_chips_atomic(uuid, uuid, uuid, numeric) IS
  'BUG 010 FIX (2026-04-15) — real atomic clawback that enforces 10-min window, '
  'debits recipient, credits sender, marks tx reversed, writes audit. Replaces '
  'stub that only wrote to a non-existent clawback_audit_log and returned success.';
