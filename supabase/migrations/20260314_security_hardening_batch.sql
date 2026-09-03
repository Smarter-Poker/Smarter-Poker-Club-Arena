-- ═══════════════════════════════════════════════════════════════════════════════
-- SECURITY HARDENING BATCH: 3 Critical Fixes
-- 1. credit_player_rakeback: Restrict to auth.uid() only
-- 2. club_chat: Add RLS policies (membership-based)
-- 3. add_chips: Restrict to auth.uid() only
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── FIX 1: Harden credit_player_rakeback ─────────────────────────────────────
-- Problem: Accepts any p_user_id, allowing client to credit chips to any user.
-- Fix: Validate p_user_id = auth.uid() inside the function.
CREATE OR REPLACE FUNCTION credit_player_rakeback(
    p_user_id UUID,
    p_amount NUMERIC,
    p_period_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    -- SECURITY: Validate caller is crediting their own account
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Unauthorized: can only credit your own account';
    END IF;

    -- Validate amount is positive
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be positive';
    END IF;

    INSERT INTO wallets (user_id, wallet_type, balance)
    VALUES (p_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
    
    INSERT INTO wallet_transactions (user_id, type, amount, period_id, description)
    VALUES (p_user_id, 'RAKEBACK', p_amount, p_period_id, 'Rakeback credit');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Revoke anon access — only authenticated users should call this
REVOKE EXECUTE ON FUNCTION credit_player_rakeback(UUID, NUMERIC, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION credit_player_rakeback(UUID, NUMERIC, UUID) TO authenticated;


-- ─── FIX 2: Harden add_chips RPC ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION add_chips(p_user_id UUID, p_amount NUMERIC)
RETURNS VOID AS $$
BEGIN
    -- SECURITY: Validate caller is adding to their own account
    IF p_user_id != auth.uid() THEN
        RAISE EXCEPTION 'Unauthorized: can only add chips to your own account';
    END IF;

    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be positive';
    END IF;

    INSERT INTO wallets (user_id, wallet_type, balance)
    VALUES (p_user_id, 'PLAYER', p_amount)
    ON CONFLICT (user_id, wallet_type) 
    DO UPDATE SET balance = wallets.balance + p_amount, updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE EXECUTE ON FUNCTION add_chips(UUID, NUMERIC) FROM anon;
GRANT EXECUTE ON FUNCTION add_chips(UUID, NUMERIC) TO authenticated;


-- ─── FIX 3: club_chat RLS policies ────────────────────────────────────────────
-- Enable RLS if not already enabled
ALTER TABLE IF EXISTS club_chat ENABLE ROW LEVEL SECURITY;

-- SELECT: Members can view chat messages from clubs they belong to
DROP POLICY IF EXISTS club_chat_select_member ON club_chat;
CREATE POLICY club_chat_select_member ON club_chat
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM club_members cm
            WHERE cm.club_id = club_chat.club_id
            AND cm.user_id = auth.uid()
            AND cm.status = 'active'
        )
    );

-- INSERT: Members can send messages to clubs they belong to
DROP POLICY IF EXISTS club_chat_insert_member ON club_chat;
CREATE POLICY club_chat_insert_member ON club_chat
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND EXISTS (
            SELECT 1 FROM club_members cm
            WHERE cm.club_id = club_chat.club_id
            AND cm.user_id = auth.uid()
            AND cm.status = 'active'
        )
    );

-- UPDATE: Users can only update their own messages (e.g. edit)
DROP POLICY IF EXISTS club_chat_update_own ON club_chat;
CREATE POLICY club_chat_update_own ON club_chat
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- DELETE: Users can only delete their own messages
DROP POLICY IF EXISTS club_chat_delete_own ON club_chat;
CREATE POLICY club_chat_delete_own ON club_chat
    FOR DELETE TO authenticated
    USING (user_id = auth.uid());


DO $$ BEGIN RAISE NOTICE '✅ Security hardening complete: credit_player_rakeback + add_chips + club_chat RLS'; END $$;
