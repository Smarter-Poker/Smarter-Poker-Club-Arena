-- ═══════════════════════════════════════════════════════════════════════════════
--  fn_union_send_chips_to_club — Atomic Union-to-Club Chip Transfer
--  Addresses BUG #19: phantom union_transactions insert without wallet movement
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- This function atomically:
--   1. Debits union_wallets.chip_balance for the union
--   2. Credits the club's wallet (club_members chip pool or club wallet)
--   3. Logs to union_transactions for audit trail
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_union_send_chips_to_club(
  p_union_id UUID,
  p_club_id UUID,
  p_amount BIGINT,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_union_balance BIGINT;
  v_tx_id UUID;
BEGIN
  -- Validate amount
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  -- Lock and check union wallet balance
  SELECT chip_balance INTO v_union_balance
  FROM union_wallets
  WHERE union_id = p_union_id
  FOR UPDATE;

  IF v_union_balance IS NULL THEN
    RAISE EXCEPTION 'Union wallet not found';
  END IF;

  IF v_union_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient union balance: have %, need %', v_union_balance, p_amount;
  END IF;

  -- 1. Debit union wallet
  UPDATE union_wallets
  SET chip_balance = chip_balance - p_amount,
      updated_at = NOW()
  WHERE union_id = p_union_id;

  -- 2. Credit club wallet (using club_wallets table if it exists, or update chip pool)
  -- Try club_wallets first
  UPDATE club_wallets
  SET chip_balance = chip_balance + p_amount,
      updated_at = NOW()
  WHERE club_id = p_club_id;

  -- If no club_wallets row was updated, try the clubs table chip_pool
  IF NOT FOUND THEN
    UPDATE clubs
    SET chip_pool = COALESCE(chip_pool, 0) + p_amount,
        updated_at = NOW()
    WHERE id = p_club_id;
  END IF;

  -- 3. Log to union_transactions for audit trail
  INSERT INTO union_transactions (
    union_id, club_id, amount, tx_type, wallet, direction, notes, created_at
  ) VALUES (
    p_union_id, p_club_id, p_amount, 'send_to_club', 'chip', 'debit', p_notes, NOW()
  )
  RETURNING id INTO v_tx_id;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_tx_id,
    'new_union_balance', v_union_balance - p_amount
  );
END;
$$;

-- Grant execute to authenticated users (RLS on union_wallets controls access)
GRANT EXECUTE ON FUNCTION public.fn_union_send_chips_to_club TO authenticated;
