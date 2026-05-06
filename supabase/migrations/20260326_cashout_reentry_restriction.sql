-- ============================================================
-- FIX 136: 2-Hour Re-Entry Restriction
--
-- Bible V8 §1.5 (Fairness Law): A player who leaves a table
-- CANNOT return and buy in for LESS than their cashout amount
-- for 2 hours. They CAN join any other table (even same stakes)
-- but must wait 2 hours or buy in >= cashout to rejoin that
-- specific table.
--
-- This adds:
-- 1. A table to track cashout amounts per player per table
-- 2. An explicit check in atomic_table_buyin
-- ============================================================

-- 1. Table to track cashout history
CREATE TABLE IF NOT EXISTS table_cashout_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cashout_amount NUMERIC NOT NULL,
  cashed_out_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Restriction expires after 2 hours
  restriction_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '2 hours')
);

-- Index for fast lookup: "did this player recently cashout at this table?"
CREATE INDEX IF NOT EXISTS idx_cashout_history_lookup
  ON table_cashout_history (table_id, user_id, restriction_expires_at DESC);

-- RLS: Players can read their own cashout history
ALTER TABLE table_cashout_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own cashout history"
  ON table_cashout_history FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can insert (server-side only)
CREATE POLICY "Service role can insert cashout history"
  ON table_cashout_history FOR INSERT
  WITH CHECK (true);

-- 2. Update atomic_table_buyin to enforce 2-hour re-entry restriction
CREATE OR REPLACE FUNCTION atomic_table_buyin(
    p_user_id UUID,
    p_table_id UUID,
    p_seat_number INT,
    p_amount NUMERIC,
    p_auto_rebuy BOOLEAN DEFAULT FALSE
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_cashout_record RECORD;
BEGIN
    -- FIX 132: Check if user already has an active seat at this table
    IF EXISTS (
        SELECT 1 FROM table_seats
        WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Player already seated at this table';
    END IF;

    -- FIX 136: Check 2-hour re-entry restriction
    -- If player cashed out from THIS table within last 2 hours,
    -- they must buy in for at least their cashout amount
    SELECT cashout_amount, restriction_expires_at
    INTO v_cashout_record
    FROM table_cashout_history
    WHERE table_id = p_table_id
      AND user_id = p_user_id
      AND restriction_expires_at > NOW()
    ORDER BY cashed_out_at DESC
    LIMIT 1;

    IF FOUND AND p_amount < v_cashout_record.cashout_amount THEN
        RAISE EXCEPTION 'Must buy in for at least % chips (your cashout amount). Restriction expires at %.',
            v_cashout_record.cashout_amount,
            v_cashout_record.restriction_expires_at;
    END IF;

    -- A. Deduct from Player Wallet
    UPDATE wallets
    SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient balance for buy-in';
    END IF;

    -- B. Clear stale seat record (if they previously sat here and left)
    DELETE FROM table_seats
    WHERE table_id = p_table_id AND seat_number = p_seat_number AND left_at IS NOT NULL;

    -- C. Insert new active seat (unique index prevents duplicates at DB level)
    INSERT INTO table_seats (table_id, seat_number, user_id, stack, status, auto_rebuy)
    VALUES (p_table_id, p_seat_number, p_user_id, p_amount, 'active', p_auto_rebuy);

    -- D. Log transaction
    INSERT INTO wallet_transactions (
        user_id, type, amount, category, description, reference_id
    ) VALUES (
        p_user_id, 'debit', -p_amount, 'buyin', 'Cash game buy-in at table', p_table_id
    );

    -- E. Increment active player count atomically
    UPDATE tables
    SET current_players = (
        SELECT COUNT(*) FROM table_seats WHERE table_id = p_table_id AND left_at IS NULL
    )
    WHERE id = p_table_id;

END;
$$;

-- 3. Function to record cashout (called by server when player leaves table)
CREATE OR REPLACE FUNCTION record_table_cashout(
    p_user_id UUID,
    p_table_id UUID,
    p_cashout_amount NUMERIC
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO table_cashout_history (table_id, user_id, cashout_amount)
    VALUES (p_table_id, p_user_id, p_cashout_amount);
END;
$$;
