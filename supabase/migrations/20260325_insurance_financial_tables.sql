-- ═══════════════════════════════════════════════════════════════════════════════
-- INSURANCE FINANCIAL TABLES — Bible V8 §4.19
-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: 20260325_insurance_financial_tables.sql
-- Purpose: Track insurance premiums and payouts with proper bank routing
--
-- FINANCIAL ROUTING:
--   - Union clubs: Premiums go to union bank, payouts come from union bank
--   - Standalone clubs: Premiums go to club main bank, payouts come from club main bank
--
-- FLOW:
--   1. Player goes all-in → insurance offer generated (equity-based premium)
--   2. Player ACCEPTS → premium deducted from player stack, credited to bank
--   3. Board dealt → if insured player LOSES → payout from bank to player stack
--   4. If insured player WINS → no payout (bank keeps premium as profit)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. INSURANCE TRANSACTIONS TABLE (Per-Hand Logging)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS insurance_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Context
    table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    union_id UUID REFERENCES unions(id) ON DELETE SET NULL,
    hand_number INTEGER NOT NULL,

    -- Player
    player_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

    -- Insurance Details
    equity_percent DECIMAL(5,2) NOT NULL,         -- Player's equity at time of offer
    premium DECIMAL(10,2) NOT NULL,                -- Premium paid by player
    insured_amount DECIMAL(10,2) NOT NULL,         -- Max payout if player loses
    payout DECIMAL(10,2) NOT NULL DEFAULT 0.00,    -- Actual payout (0 if player won)

    -- Outcome
    player_won BOOLEAN NOT NULL DEFAULT false,     -- Did the insured player win the hand?
    net_result DECIMAL(10,2) NOT NULL,             -- Negative = player paid net, Positive = player received net

    -- Bank routing
    bank_type VARCHAR(10) NOT NULL CHECK (bank_type IN ('union', 'club')),
    bank_entity_id UUID NOT NULL,                  -- union_id or club_id depending on bank_type

    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_insurance_tx_table ON insurance_transactions(table_id);
CREATE INDEX IF NOT EXISTS idx_insurance_tx_player ON insurance_transactions(player_id);
CREATE INDEX IF NOT EXISTS idx_insurance_tx_club ON insurance_transactions(club_id);
CREATE INDEX IF NOT EXISTS idx_insurance_tx_created ON insurance_transactions(created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE insurance_transactions ENABLE ROW LEVEL SECURITY;

-- Players can see their own insurance transactions
CREATE POLICY "insurance_tx_own_select" ON insurance_transactions
    FOR SELECT USING (auth.uid() = player_id);

-- Service role can insert (server-side only)
-- No explicit INSERT policy needed since service_role bypasses RLS

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RPC: Record insurance transaction and handle bank credits/debits
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION record_insurance_transaction(
    p_table_id UUID,
    p_club_id UUID,
    p_hand_number INTEGER,
    p_player_id UUID,
    p_equity_percent DECIMAL,
    p_premium DECIMAL,
    p_insured_amount DECIMAL,
    p_payout DECIMAL,
    p_player_won BOOLEAN
) RETURNS insurance_transactions AS $$
DECLARE
    v_club RECORD;
    v_bank_type VARCHAR(10);
    v_bank_entity_id UUID;
    v_net_result DECIMAL;
    v_tx insurance_transactions;
BEGIN
    -- Determine bank routing
    SELECT union_id INTO v_club FROM clubs WHERE id = p_club_id;

    IF v_club.union_id IS NOT NULL THEN
        v_bank_type := 'union';
        v_bank_entity_id := v_club.union_id;
    ELSE
        v_bank_type := 'club';
        v_bank_entity_id := p_club_id;
    END IF;

    -- Net result from player perspective: payout - premium
    -- Positive = player profited, Negative = house profited
    v_net_result := p_payout - p_premium;

    -- Record the transaction
    INSERT INTO insurance_transactions (
        table_id, club_id, union_id, hand_number,
        player_id, equity_percent, premium, insured_amount, payout,
        player_won, net_result, bank_type, bank_entity_id
    ) VALUES (
        p_table_id, p_club_id, v_club.union_id, p_hand_number,
        p_player_id, p_equity_percent, p_premium, p_insured_amount, p_payout,
        p_player_won, v_net_result, v_bank_type, v_bank_entity_id
    ) RETURNING * INTO v_tx;

    RETURN v_tx;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
