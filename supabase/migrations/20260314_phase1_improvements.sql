-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 1-2: Security, Correctness & Backend Hardening
-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Tournament waitlists: RLS, trigger, indexes
-- 2. chip_transactions: clawed_back boolean column
-- 3. Distribution rate limiting function
-- 4. Clawback audit log table
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. TOURNAMENT WAITLISTS — RLS, TRIGGER, INDEXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tournament_waitlists_tournament ON tournament_waitlists(tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournament_waitlists_user ON tournament_waitlists(user_id);

-- Auto-assign position on insert
CREATE OR REPLACE FUNCTION fn_tournament_waitlist_position()
RETURNS TRIGGER AS $$
BEGIN
    NEW.position := COALESCE(
        (SELECT MAX(position) + 1 FROM tournament_waitlists WHERE tournament_id = NEW.tournament_id),
        1
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tournament_waitlist_position ON tournament_waitlists;
CREATE TRIGGER trg_tournament_waitlist_position
    BEFORE INSERT ON tournament_waitlists
    FOR EACH ROW EXECUTE FUNCTION fn_tournament_waitlist_position();

-- RLS
ALTER TABLE tournament_waitlists ENABLE ROW LEVEL SECURITY;

-- Drop existing policies to avoid conflicts, then recreate
DROP POLICY IF EXISTS "Users can view own waitlist entries" ON tournament_waitlists;
CREATE POLICY "Users can view own waitlist entries"
    ON tournament_waitlists FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can join waitlist" ON tournament_waitlists;
CREATE POLICY "Users can join waitlist"
    ON tournament_waitlists FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can leave waitlist" ON tournament_waitlists;
CREATE POLICY "Users can leave waitlist"
    ON tournament_waitlists FOR DELETE
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins can view all waitlist entries" ON tournament_waitlists;
CREATE POLICY "Admins can view all waitlist entries"
    ON tournament_waitlists FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM tournaments t
            JOIN club_members cm ON cm.club_id = t.club_id
            WHERE t.id = tournament_waitlists.tournament_id
            AND cm.user_id = auth.uid()
            AND cm.role IN ('owner', 'admin', 'manager')
        )
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. CHIP TRANSACTIONS — CLAWED_BACK BOOLEAN COLUMN
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE chip_transactions ADD COLUMN IF NOT EXISTS clawed_back BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_chip_transactions_clawed_back ON chip_transactions(clawed_back) WHERE clawed_back = FALSE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. DISTRIBUTION RATE LIMITING
-- ═══════════════════════════════════════════════════════════════════════════════

-- Rate-limit: max 10 distributions per agent per minute
CREATE OR REPLACE FUNCTION fn_check_distribution_rate_limit(p_agent_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_recent_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_recent_count
    FROM chip_transactions
    WHERE from_user_id = (SELECT user_id FROM agents WHERE id = p_agent_id)
    AND transaction_type IN ('agent_to_player', 'promo_agent_to_player')
    AND created_at > NOW() - INTERVAL '1 minute';

    RETURN v_recent_count < 10;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. CLAWBACK AUDIT LOG TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS clawback_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES chip_transactions(id),
    club_id UUID NOT NULL REFERENCES clubs(id),
    agent_user_id UUID NOT NULL REFERENCES auth.users(id),
    player_user_id UUID NOT NULL REFERENCES auth.users(id),
    original_amount NUMERIC NOT NULL,
    recovered_amount NUMERIC NOT NULL,
    is_partial BOOLEAN DEFAULT FALSE,
    player_balance_before NUMERIC,
    player_balance_after NUMERIC,
    agent_balance_after NUMERIC,
    clawed_back_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ip_address TEXT,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_clawback_audit_club ON clawback_audit_log(club_id);
CREATE INDEX IF NOT EXISTS idx_clawback_audit_agent ON clawback_audit_log(agent_user_id);
CREATE INDEX IF NOT EXISTS idx_clawback_audit_player ON clawback_audit_log(player_user_id);
CREATE INDEX IF NOT EXISTS idx_clawback_audit_time ON clawback_audit_log(clawed_back_at DESC);

ALTER TABLE clawback_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Agents can view own clawback logs" ON clawback_audit_log;
CREATE POLICY "Agents can view own clawback logs"
    ON clawback_audit_log FOR SELECT
    USING (auth.uid() = agent_user_id);

DROP POLICY IF EXISTS "Admins can view club clawback logs" ON clawback_audit_log;
CREATE POLICY "Admins can view club clawback logs"
    ON clawback_audit_log FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM club_members cm
            WHERE cm.club_id = clawback_audit_log.club_id
            AND cm.user_id = auth.uid()
            AND cm.role IN ('owner', 'admin')
        )
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. UPDATE fn_clawback_chips_atomic TO USE NEW COLUMNS + AUDIT LOG
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_clawback_chips_atomic(
    p_transaction_id UUID,
    p_club_id UUID,
    p_agent_id UUID,
    p_amount NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_player_id UUID;
    v_player_balance NUMERIC;
    v_actual_amount NUMERIC;
    v_is_partial BOOLEAN := FALSE;
    v_player_new_balance NUMERIC;
    v_agent_new_balance NUMERIC;
    v_agent_pk UUID;
    v_original_amount NUMERIC;
BEGIN
    -- 1. Get transaction details
    SELECT to_user_id, amount INTO v_player_id, v_original_amount
    FROM chip_transactions
    WHERE id = p_transaction_id AND club_id = p_club_id;

    IF v_player_id IS NULL THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'Transaction not found');
    END IF;

    -- 2. Lock player balance
    SELECT COALESCE(chip_balance, 0) INTO v_player_balance
    FROM club_members
    WHERE user_id = v_player_id AND club_id = p_club_id
    FOR UPDATE;

    IF v_player_balance IS NULL THEN
        RETURN jsonb_build_object('success', FALSE, 'error', 'Player not found in club');
    END IF;

    -- 3. Resolve agent PK
    SELECT id INTO v_agent_pk FROM agents WHERE user_id = p_agent_id AND club_id = p_club_id;

    -- 4. Determine clawback amount
    IF v_player_balance >= p_amount THEN
        v_actual_amount := p_amount;
    ELSIF v_player_balance > 0 THEN
        v_actual_amount := v_player_balance;
        v_is_partial := TRUE;
    ELSE
        RETURN jsonb_build_object(
            'success', FALSE, 'partial', FALSE, 'recovered', 0,
            'player_new_balance', 0,
            'error', 'Player has zero balance — nothing to recover'
        );
    END IF;

    -- 5. Deduct from player
    UPDATE club_members
    SET chip_balance = chip_balance - v_actual_amount
    WHERE user_id = v_player_id AND club_id = p_club_id;

    -- 6. Credit agent
    IF v_agent_pk IS NOT NULL THEN
        UPDATE agents SET promo_balance = promo_balance + v_actual_amount WHERE id = v_agent_pk;
    ELSE
        UPDATE club_members SET chip_balance = chip_balance + v_actual_amount
        WHERE user_id = p_agent_id AND club_id = p_club_id;
    END IF;

    -- 7. Get new balances
    SELECT chip_balance INTO v_player_new_balance
    FROM club_members WHERE user_id = v_player_id AND club_id = p_club_id;

    IF v_agent_pk IS NOT NULL THEN
        SELECT promo_balance INTO v_agent_new_balance FROM agents WHERE id = v_agent_pk;
    ELSE
        SELECT chip_balance INTO v_agent_new_balance
        FROM club_members WHERE user_id = p_agent_id AND club_id = p_club_id;
    END IF;

    -- 8. Log clawback transaction
    INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes)
    VALUES (p_club_id, v_player_id, p_agent_id, v_actual_amount, 'clawback',
        format('Clawback of txn %s — %s chips recovered', p_transaction_id::text, v_actual_amount));

    -- 9. Mark original transaction as clawed back
    UPDATE chip_transactions SET clawed_back = TRUE
    WHERE id = p_transaction_id;

    -- 10. Insert audit log entry
    INSERT INTO clawback_audit_log (
        transaction_id, club_id, agent_user_id, player_user_id,
        original_amount, recovered_amount, is_partial,
        player_balance_before, player_balance_after, agent_balance_after
    ) VALUES (
        p_transaction_id, p_club_id, p_agent_id, v_player_id,
        v_original_amount, v_actual_amount, v_is_partial,
        v_player_balance, COALESCE(v_player_new_balance, 0), COALESCE(v_agent_new_balance, 0)
    );

    RETURN jsonb_build_object(
        'success', TRUE,
        'partial', v_is_partial,
        'recovered', v_actual_amount,
        'player_new_balance', COALESCE(v_player_new_balance, 0),
        'agent_new_balance', COALESCE(v_agent_new_balance, 0)
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', FALSE, 'error', SQLERRM);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. UPDATE distribute_promo_chips TO USE RATE LIMITING
-- ═══════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS distribute_promo_chips(UUID, UUID, NUMERIC);
CREATE OR REPLACE FUNCTION distribute_promo_chips(
    p_agent_id UUID,
    p_player_id UUID,
    p_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_club_id UUID;
    v_agent_user_id UUID;
BEGIN
    -- 1. Get agent context
    SELECT club_id, user_id INTO v_club_id, v_agent_user_id
    FROM agents WHERE id = p_agent_id;

    IF v_club_id IS NULL THEN
        RAISE EXCEPTION 'Agent not found';
    END IF;

    -- 2. Rate limiting: max 10 per minute
    IF NOT fn_check_distribution_rate_limit(p_agent_id) THEN
        RAISE EXCEPTION 'Rate limit exceeded — max 10 distributions per minute';
    END IF;

    -- 3. Deduct from agent's promo balance
    UPDATE agents
    SET promo_balance = COALESCE(promo_balance, 0) - p_amount, updated_at = NOW()
    WHERE id = p_agent_id AND COALESCE(promo_balance, 0) >= p_amount;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient promo balance';
    END IF;

    -- 4. Credit player's club chip balance
    UPDATE club_members
    SET chip_balance = COALESCE(chip_balance, 0) + p_amount
    WHERE user_id = p_player_id AND club_id = v_club_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player not found in club';
    END IF;

    -- 5. Log to chip_transactions
    INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes)
    VALUES (v_club_id, v_agent_user_id, p_player_id, p_amount, 'promo_agent_to_player', 'Promo Distribution');
END;
$$;
