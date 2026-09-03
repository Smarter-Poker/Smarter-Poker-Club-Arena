-- ═══════════════════════════════════════════════════════════════════════════════
-- 💰 BBJ TRIPLE-BANK SYSTEM
-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: 005_bbj_triple_bank.sql
-- Purpose: Bad Beat Jackpot management with MAIN/BACKUP/PROMO pools
-- 
-- ARCHITECTURE:
-- 1. bbj_pools: Main pool tracking (one per union or independent club)
-- 2. bbj_contributions: Hand-by-hand contribution logging
-- 3. bbj_payouts: Jackpot hit history with distribution records
-- 4. bbj_promo_events: Manual promotional payouts (rain, high hand)
--
-- ALLOCATION LAWS:
-- STANDARD (<$100k): 50% MAIN, 25% BACKUP, 25% PROMO
-- PIVOT (≥$100k): 30% MAIN, 40% BACKUP, 30% PROMO
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. BBJ POOLS TABLE
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bbj_pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Ownership: Either union-level OR club-level (independent)
    union_id UUID REFERENCES unions(id) ON DELETE CASCADE,
    club_id UUID REFERENCES clubs(id) ON DELETE CASCADE,
    
    -- Triple-Bank Balances (in chips/dollars)
    main_balance DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    backup_balance DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    promo_balance DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    
    -- Lifetime Stats
    total_contributed DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    total_paid_out DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    hit_count INTEGER NOT NULL DEFAULT 0,
    
    -- Last Hit Info
    last_hit_at TIMESTAMPTZ,
    last_hit_amount DECIMAL(15,2),
    last_winner_id UUID REFERENCES profiles(id),
    last_loser_id UUID REFERENCES profiles(id),
    
    -- Metadata
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    -- Constraints
    CONSTRAINT bbj_pool_ownership CHECK (
        (union_id IS NOT NULL AND club_id IS NULL) OR
        (union_id IS NULL AND club_id IS NOT NULL)
    ),
    CONSTRAINT bbj_balances_positive CHECK (
        main_balance >= 0 AND backup_balance >= 0 AND promo_balance >= 0
    )
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bbj_pools_union ON bbj_pools(union_id) WHERE union_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bbj_pools_club ON bbj_pools(club_id) WHERE club_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. BBJ CONTRIBUTIONS TABLE (Per-Hand Logging)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bbj_contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID NOT NULL REFERENCES bbj_pools(id) ON DELETE CASCADE,
    hand_id UUID NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
    table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    
    -- Contribution Breakdown
    amount DECIMAL(10,2) NOT NULL,
    main_portion DECIMAL(10,2) NOT NULL,
    backup_portion DECIMAL(10,2) NOT NULL,
    promo_portion DECIMAL(10,2) NOT NULL,
    
    -- Stake Reference
    big_blind DECIMAL(10,2) NOT NULL,
    
    -- Timestamp
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    -- Constraints
    CONSTRAINT bbj_contrib_sum CHECK (
        ABS((main_portion + backup_portion + promo_portion) - amount) < 0.01
    )
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_bbj_contrib_pool ON bbj_contributions(pool_id);
CREATE INDEX IF NOT EXISTS idx_bbj_contrib_hand ON bbj_contributions(hand_id);
CREATE INDEX IF NOT EXISTS idx_bbj_contrib_created ON bbj_contributions(created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. BBJ PAYOUTS TABLE (Jackpot Hits)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bbj_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID NOT NULL REFERENCES bbj_pools(id) ON DELETE CASCADE,
    hand_id UUID NOT NULL REFERENCES hands(id) ON DELETE CASCADE,
    
    -- Participants
    winner_user_id UUID NOT NULL REFERENCES profiles(id),  -- Holder of beaten hand (gets 50%)
    loser_user_id UUID NOT NULL REFERENCES profiles(id),   -- Holder of winning hand (gets 25%)
    
    -- Payout Breakdown
    total_amount DECIMAL(15,2) NOT NULL,
    winner_share DECIMAL(15,2) NOT NULL,
    loser_share DECIMAL(15,2) NOT NULL,
    table_share DECIMAL(15,2) NOT NULL,
    table_player_count INTEGER NOT NULL,
    
    -- Hand Details (for history display)
    winner_hand_name VARCHAR(50) NOT NULL,  -- e.g., "Quad Aces"
    loser_hand_name VARCHAR(50) NOT NULL,   -- e.g., "Straight Flush"
    
    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'completed',
    
    -- Timestamp
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    -- Constraints
    CONSTRAINT bbj_payout_shares CHECK (
        ABS((winner_share + loser_share + table_share) - total_amount) < 0.01
    )
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bbj_payouts_pool ON bbj_payouts(pool_id);
CREATE INDEX IF NOT EXISTS idx_bbj_payouts_winner ON bbj_payouts(winner_user_id);
CREATE INDEX IF NOT EXISTS idx_bbj_payouts_loser ON bbj_payouts(loser_user_id);
CREATE INDEX IF NOT EXISTS idx_bbj_payouts_created ON bbj_payouts(created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. BBJ TABLE PAYOUT RECIPIENTS (Many-to-Many for Table Share)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bbj_payout_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payout_id UUID NOT NULL REFERENCES bbj_payouts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    amount DECIMAL(15,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    
    UNIQUE(payout_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_bbj_recipients_payout ON bbj_payout_recipients(payout_id);
CREATE INDEX IF NOT EXISTS idx_bbj_recipients_user ON bbj_payout_recipients(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. BBJ PROMO EVENTS (Manual Payouts from Promo Pool)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bbj_promo_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pool_id UUID NOT NULL REFERENCES bbj_pools(id) ON DELETE CASCADE,
    
    -- Event Details
    event_type VARCHAR(50) NOT NULL,  -- 'rain', 'high_hand', 'leaderboard', 'custom'
    reason TEXT NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    recipient_count INTEGER NOT NULL,
    
    -- Admin
    triggered_by UUID NOT NULL REFERENCES profiles(id),
    
    -- Status
    status VARCHAR(20) NOT NULL DEFAULT 'completed',
    
    -- Timestamp
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bbj_promo_pool ON bbj_promo_events(pool_id);
CREATE INDEX IF NOT EXISTS idx_bbj_promo_created ON bbj_promo_events(created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. ATOMIC FUNCTIONS
-- ─────────────────────────────────────────────────────────────────────────────

-- Record a BBJ contribution and update pool balances
CREATE OR REPLACE FUNCTION bbj_record_contribution(
    p_pool_id UUID,
    p_hand_id UUID,
    p_table_id UUID,
    p_amount DECIMAL,
    p_main_portion DECIMAL,
    p_backup_portion DECIMAL,
    p_promo_portion DECIMAL,
    p_big_blind DECIMAL DEFAULT 2.00
) RETURNS bbj_contributions AS $$
DECLARE
    v_contribution bbj_contributions;
BEGIN
    -- Update pool balances
    UPDATE bbj_pools
    SET 
        main_balance = main_balance + p_main_portion,
        backup_balance = backup_balance + p_backup_portion,
        promo_balance = promo_balance + p_promo_portion,
        total_contributed = total_contributed + p_amount,
        updated_at = now()
    WHERE id = p_pool_id;
    
    -- Record contribution
    INSERT INTO bbj_contributions (
        pool_id, hand_id, table_id, amount,
        main_portion, backup_portion, promo_portion, big_blind
    ) VALUES (
        p_pool_id, p_hand_id, p_table_id, p_amount,
        p_main_portion, p_backup_portion, p_promo_portion, p_big_blind
    ) RETURNING * INTO v_contribution;
    
    RETURN v_contribution;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Execute BBJ payout (transfers chips to winners and resets pool)
CREATE OR REPLACE FUNCTION bbj_execute_payout(
    p_pool_id UUID,
    p_hand_id UUID,
    p_loser_user_id UUID,
    p_winner_user_id UUID,
    p_dealt_in_player_ids UUID[],
    p_winner_share DECIMAL,
    p_loser_share DECIMAL,
    p_table_share DECIMAL,
    p_winner_hand_name VARCHAR DEFAULT 'Quads',
    p_loser_hand_name VARCHAR DEFAULT 'Straight Flush'
) RETURNS bbj_payouts AS $$
DECLARE
    v_pool bbj_pools;
    v_payout bbj_payouts;
    v_per_player_share DECIMAL;
    v_player_id UUID;
BEGIN
    -- Lock and get pool
    SELECT * INTO v_pool FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;
    
    IF v_pool IS NULL THEN
        RAISE EXCEPTION 'Pool not found';
    END IF;
    
    -- Create payout record
    INSERT INTO bbj_payouts (
        pool_id, hand_id, winner_user_id, loser_user_id,
        total_amount, winner_share, loser_share, table_share,
        table_player_count, winner_hand_name, loser_hand_name
    ) VALUES (
        p_pool_id, p_hand_id, p_winner_user_id, p_loser_user_id,
        v_pool.main_balance, p_winner_share, p_loser_share, p_table_share,
        array_length(p_dealt_in_player_ids, 1), p_winner_hand_name, p_loser_hand_name
    ) RETURNING * INTO v_payout;
    
    -- Record table share recipients
    v_per_player_share := p_table_share / array_length(p_dealt_in_player_ids, 1);
    FOREACH v_player_id IN ARRAY p_dealt_in_player_ids
    LOOP
        INSERT INTO bbj_payout_recipients (payout_id, user_id, amount)
        VALUES (v_payout.id, v_player_id, v_per_player_share);
    END LOOP;
    
    -- Update pool: Reset main from backup, clear backup, update stats
    UPDATE bbj_pools
    SET 
        main_balance = backup_balance,  -- Seed new jackpot from backup
        backup_balance = 0,             -- Reset backup
        total_paid_out = total_paid_out + v_pool.main_balance,
        hit_count = hit_count + 1,
        last_hit_at = now(),
        last_hit_amount = v_pool.main_balance,
        last_winner_id = p_winner_user_id,
        last_loser_id = p_loser_user_id,
        updated_at = now()
    WHERE id = p_pool_id;
    
    -- TODO: Integrate with chip_transactions to credit user wallets
    -- This would call transfer_chips for each recipient
    
    RETURN v_payout;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Execute promo payout from promo pool
CREATE OR REPLACE FUNCTION bbj_promo_payout(
    p_pool_id UUID,
    p_amount DECIMAL,
    p_recipient_user_ids UUID[],
    p_reason TEXT,
    p_triggered_by UUID DEFAULT NULL,
    p_event_type VARCHAR DEFAULT 'custom'
) RETURNS BOOLEAN AS $$
DECLARE
    v_pool bbj_pools;
BEGIN
    -- Lock and validate pool
    SELECT * INTO v_pool FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;
    
    IF v_pool IS NULL THEN
        RAISE EXCEPTION 'Pool not found';
    END IF;
    
    IF v_pool.promo_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient promo balance: % < %', v_pool.promo_balance, p_amount;
    END IF;
    
    -- Deduct from promo pool
    UPDATE bbj_pools
    SET 
        promo_balance = promo_balance - p_amount,
        updated_at = now()
    WHERE id = p_pool_id;
    
    -- Record promo event
    INSERT INTO bbj_promo_events (
        pool_id, event_type, reason, amount, recipient_count, triggered_by
    ) VALUES (
        p_pool_id, p_event_type, p_reason, p_amount, 
        array_length(p_recipient_user_ids, 1), p_triggered_by
    );
    
    -- TODO: Integrate with chip_transactions to credit user wallets
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. ROW LEVEL SECURITY
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE bbj_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE bbj_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bbj_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bbj_payout_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE bbj_promo_events ENABLE ROW LEVEL SECURITY;

-- Pools: Viewable by anyone, editable by system only
CREATE POLICY "bbj_pools_select" ON bbj_pools FOR SELECT USING (true);

-- Contributions: Viewable by anyone
CREATE POLICY "bbj_contributions_select" ON bbj_contributions FOR SELECT USING (true);

-- Payouts: Viewable by anyone
CREATE POLICY "bbj_payouts_select" ON bbj_payouts FOR SELECT USING (true);

-- Recipients: Viewable by the recipient
CREATE POLICY "bbj_recipients_select" ON bbj_payout_recipients FOR SELECT 
    USING (auth.uid() = user_id);

-- Promo events: Viewable by anyone
CREATE POLICY "bbj_promo_select" ON bbj_promo_events FOR SELECT USING (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. TRIGGERS
-- ─────────────────────────────────────────────────────────────────────────────

-- Auto-update updated_at
CREATE TRIGGER bbj_pools_updated_at
    BEFORE UPDATE ON bbj_pools
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. SEED DATA (Optional - One pool per union/club)
-- ─────────────────────────────────────────────────────────────────────────────

-- Example: Create a pool for the first union if none exists
-- INSERT INTO bbj_pools (union_id, main_balance, backup_balance, promo_balance)
-- SELECT id, 0, 0, 0 FROM unions LIMIT 1
-- ON CONFLICT DO NOTHING;
