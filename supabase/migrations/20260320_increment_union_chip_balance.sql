-- ═══════════════════════════════════════════════════════════════════════════════
-- increment_union_chip_balance — Atomic SQL increment for union wallet balance
-- ═══════════════════════════════════════════════════════════════════════════════
-- Prevents TOCTOU race conditions in union deposit/clawback handlers by using
-- a single atomic UPDATE with chip_balance = chip_balance + p_amount.
--
-- Returns the new balance after the increment.
-- Supports negative amounts for deductions (clawbacks).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION increment_union_chip_balance(
  p_union_id UUID,
  p_amount NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_balance NUMERIC;
BEGIN
  -- Atomic increment — no read-then-write race condition
  UPDATE union_wallets
  SET chip_balance = chip_balance + p_amount
  WHERE union_id = p_union_id
  RETURNING chip_balance INTO v_new_balance;

  -- If union_wallets row doesn't exist, try the unions table as fallback
  IF NOT FOUND THEN
    UPDATE unions
    SET chip_balance = COALESCE(chip_balance, 0) + p_amount
    WHERE id = p_union_id
    RETURNING chip_balance INTO v_new_balance;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Union % not found in union_wallets or unions', p_union_id;
    END IF;
  END IF;

  RETURN v_new_balance;
END;
$$;

-- Grant execute to authenticated users (RLS on the underlying tables still applies)
GRANT EXECUTE ON FUNCTION increment_union_chip_balance(UUID, NUMERIC) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- decrement_club_treasury — Atomic SQL decrement for club treasury
-- ═══════════════════════════════════════════════════════════════════════════════
-- Prevents TOCTOU race conditions in clawback handlers.
-- Returns new balance. Raises exception if balance would go negative.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION decrement_club_treasury(
  p_club_id UUID,
  p_amount NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_new_balance NUMERIC;
BEGIN
  UPDATE clubs
  SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount
  WHERE id = p_club_id
    AND COALESCE(chip_treasury, 0) >= p_amount  -- Prevent negative balance
  RETURNING chip_treasury INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club % has insufficient treasury balance or not found', p_club_id;
  END IF;

  RETURN v_new_balance;
END;
$$;

GRANT EXECUTE ON FUNCTION decrement_club_treasury(UUID, NUMERIC) TO authenticated;
