-- ═══════════════════════════════════════════════════════════════════════════════
-- BUG 011 FIX — fn_union_send_chips_to_club inserts into non-existent table
-- ═══════════════════════════════════════════════════════════════════════════════
-- DISCOVERY (2026-04-15 live verification D-2 #4):
--   - 0 union_wallet_transactions rows with tx_type='send_to_club' in last 30 days
--   - The RPC body INSERTed into union_transactions (no such table) → 42P01
--   - Actual audit table is union_wallet_transactions with schema:
--       union_id, wallet(text), direction(text), amount, balance_after,
--       tx_type(text), club_id, period_id, notes, created_by, created_at
--
-- FIX: update INSERT to target union_wallet_transactions with correct column
-- shape. Debit/credit/lock logic was already sound; only the audit write failed.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_union_send_chips_to_club(
  p_union_id uuid, p_club_id uuid, p_amount numeric, p_notes text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_union_balance NUMERIC;
  v_owner_user_id UUID;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'Transfer amount must be positive';
  END IF;

  SELECT chip_balance INTO v_union_balance
    FROM public.union_wallets WHERE union_id = p_union_id FOR UPDATE;
  IF v_union_balance IS NULL THEN
    RAISE EXCEPTION 'Union wallet not found for union %', p_union_id;
  END IF;
  IF v_union_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient union chip balance. Available: %, Requested: %',
      v_union_balance, p_amount;
  END IF;

  SELECT user_id INTO v_owner_user_id
    FROM public.club_members WHERE club_id = p_club_id AND role = 'owner' LIMIT 1;
  IF v_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'Club owner not found for club %', p_club_id;
  END IF;

  UPDATE public.union_wallets
    SET chip_balance = chip_balance - p_amount, updated_at = NOW()
    WHERE union_id = p_union_id;

  UPDATE public.club_members
    SET chip_balance = COALESCE(chip_balance, 0) + p_amount
    WHERE club_id = p_club_id AND role = 'owner';

  -- BUG 011 FIX — correct audit table
  INSERT INTO public.union_wallet_transactions (
    union_id, wallet, direction, amount, balance_after, tx_type, club_id, notes
  ) VALUES (
    p_union_id, 'main', 'debit', p_amount, v_union_balance - p_amount, 'send_to_club',
    p_club_id, COALESCE(p_notes, 'Union chip distribution')
  );

  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION public.fn_union_send_chips_to_club(uuid, uuid, numeric, text) IS
  'BUG 011 FIX 2026-04-15 — replaced INSERT INTO union_transactions (non-existent) '
  'with correct INSERT INTO union_wallet_transactions. Every prior call raised 42P01.';
