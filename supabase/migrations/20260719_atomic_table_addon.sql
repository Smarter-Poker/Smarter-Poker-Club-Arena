-- ============================================================
-- SECURITY / MONEY FIX (2026-07-19): atomic table add-on (top-up)
--
-- Previously `POST /addchips` → ServerTableEngine.addChips credited the seat
-- stack (and table_seats.stack) with NO wallet debit and no enforced max buy-in
-- on the immediate path — a seated player could mint unlimited chips. The
-- queued path also "refunded" never-debited chips into club_members.balance.
--
-- This RPC mirrors atomic_table_buyin's money movement exactly: it debits the
-- player's PLAYER wallet, logs a wallet_transactions row, and (optionally, only
-- between hands) increments the seat stack — all atomically. The engine caps
-- the amount to the table max buy-in BEFORE calling this, so no over-debit /
-- refund is needed on the happy path; the rare post-hand re-cap refunds via
-- atomic_credit_wallet_and_log (correct PLAYER wallet, not club_members).
--
--   p_apply_to_seat = true  → between hands: debit wallet + bump table_seats.stack
--   p_apply_to_seat = false → mid-hand: debit wallet only (engine owns the live
--                             stack and persists it in postHandTasks)
-- Returns the player's new wallet balance. Raises on insufficient funds / not
-- seated so the caller can surface a clean error and NOT credit the stack.
-- ============================================================

CREATE OR REPLACE FUNCTION public.atomic_table_addon(
  p_user_id uuid,
  p_table_id uuid,
  p_amount numeric,
  p_apply_to_seat boolean DEFAULT true
) RETURNS numeric
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_new_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Add-on amount must be positive';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM table_seats
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Player not seated at this table';
  END IF;

  UPDATE wallets
     SET balance    = balance - p_amount,
         updated_at = NOW()
   WHERE user_id     = p_user_id
     AND wallet_type = 'PLAYER'
     AND balance    >= p_amount
   RETURNING balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    RAISE EXCEPTION 'Insufficient balance for add-on';
  END IF;

  IF p_apply_to_seat THEN
    UPDATE table_seats
       SET stack = stack + p_amount
     WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL;
  END IF;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, table_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', -p_amount, 'addon',
            'Table add-on (top-up)', p_table_id, v_new_balance);

  RETURN v_new_balance;
END;
$$;
