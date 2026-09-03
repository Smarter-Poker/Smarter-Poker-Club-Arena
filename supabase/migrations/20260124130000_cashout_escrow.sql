-- ═══════════════════════════════════════════════════════════════════════════════
-- 💰 CHIP CASHOUT ESCROW SYSTEM
-- ═══════════════════════════════════════════════════════════════════════════════
-- Business Rules:
-- 1. Agent can ONLY remove chips within 10 minutes after sending them
-- 2. Player cashout request locks chips in escrow
-- 3. Agent must acknowledge/accept the cashout
-- 4. Player can cancel cashout anytime
-- 5. All cashouts trigger message notification to agent
-- ═══════════════════════════════════════════════════════════════════════════════

-- Cashout request statuses
-- pending: Player requested, chips locked, awaiting agent
-- approved: Agent approved, ready for processing
-- completed: Chips removed, cashout complete
-- cancelled: Player cancelled the request
-- rejected: Agent rejected (chips returned to player)

-- Table: Cashout Requests
CREATE TABLE IF NOT EXISTS cashout_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount DECIMAL(15, 2) NOT NULL CHECK (amount > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'completed', 'cancelled', 'rejected')),
    player_note TEXT,
    agent_note TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ
);

-- Table: Chip Transactions (tracks all chip movements with timing)
CREATE TABLE IF NOT EXISTS chip_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    from_user_id UUID REFERENCES auth.users(id),
    to_user_id UUID REFERENCES auth.users(id),
    amount DECIMAL(15, 2) NOT NULL,
    transaction_type TEXT NOT NULL CHECK (transaction_type IN ('send', 'remove', 'cashout', 'escrow_lock', 'escrow_release')),
    related_cashout_id UUID REFERENCES cashout_requests(id),
    reversible_until TIMESTAMPTZ, -- For agent sends: 10 min window
    is_reversed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    notes TEXT
);

-- Table: Escrow (locked chips during cashout)
CREATE TABLE IF NOT EXISTS chip_escrow (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cashout_request_id UUID UNIQUE NOT NULL REFERENCES cashout_requests(id) ON DELETE CASCADE,
    player_id UUID NOT NULL REFERENCES auth.users(id),
    amount DECIMAL(15, 2) NOT NULL,
    locked_at TIMESTAMPTZ DEFAULT NOW(),
    released_at TIMESTAMPTZ,
    release_type TEXT CHECK (release_type IN ('completed', 'cancelled', 'rejected'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cashout_requests_player ON cashout_requests(player_id);
CREATE INDEX IF NOT EXISTS idx_cashout_requests_agent ON cashout_requests(agent_id);
CREATE INDEX IF NOT EXISTS idx_cashout_requests_status ON cashout_requests(status);
CREATE INDEX IF NOT EXISTS idx_cashout_requests_club ON cashout_requests(club_id);
CREATE INDEX IF NOT EXISTS idx_chip_transactions_club ON chip_transactions(club_id);
CREATE INDEX IF NOT EXISTS idx_chip_transactions_reversible ON chip_transactions(reversible_until);
CREATE INDEX IF NOT EXISTS idx_chip_escrow_player ON chip_escrow(player_id);

-- RLS Policies
ALTER TABLE cashout_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE chip_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chip_escrow ENABLE ROW LEVEL SECURITY;

-- Players can view their own cashout requests
CREATE POLICY "Players view own cashouts" ON cashout_requests
    FOR SELECT USING (auth.uid() = player_id);

-- Agents can view cashouts for their players
CREATE POLICY "Agents view player cashouts" ON cashout_requests
    FOR SELECT USING (auth.uid() = agent_id);

-- Club admins can view all cashouts in their club
CREATE POLICY "Admins view club cashouts" ON cashout_requests
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM club_members 
            WHERE club_id = cashout_requests.club_id 
            AND user_id = auth.uid() 
            AND role IN ('owner', 'admin')
        )
    );

-- Players can create cashout requests
CREATE POLICY "Players create cashouts" ON cashout_requests
    FOR INSERT WITH CHECK (auth.uid() = player_id AND status = 'pending');

-- Players can cancel their own pending cashouts
CREATE POLICY "Players cancel own cashouts" ON cashout_requests
    FOR UPDATE USING (auth.uid() = player_id AND status = 'pending');

-- Agents can update cashout status
CREATE POLICY "Agents update cashouts" ON cashout_requests
    FOR UPDATE USING (auth.uid() = agent_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Function: Check if agent can remove chips (within 10 min of sending)
CREATE OR REPLACE FUNCTION fn_can_agent_remove_chips(
    p_agent_id UUID,
    p_player_id UUID,
    p_club_id UUID,
    p_amount DECIMAL
) RETURNS BOOLEAN AS $$
DECLARE
    v_available_to_remove DECIMAL;
BEGIN
    -- Sum chips sent by this agent to this player in the last 10 minutes that haven't been reversed
    SELECT COALESCE(SUM(amount), 0) INTO v_available_to_remove
    FROM chip_transactions
    WHERE from_user_id = p_agent_id
      AND to_user_id = p_player_id
      AND club_id = p_club_id
      AND transaction_type = 'send'
      AND reversible_until > NOW()
      AND is_reversed = FALSE;

    RETURN v_available_to_remove >= p_amount;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: Request cashout (locks chips in escrow)
CREATE OR REPLACE FUNCTION fn_request_cashout(
    p_player_id UUID,
    p_club_id UUID,
    p_amount DECIMAL,
    p_note TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_cashout_id UUID;
    v_agent_id UUID;
    v_player_balance DECIMAL;
BEGIN
    -- Get player's agent
    SELECT agent_id INTO v_agent_id
    FROM club_members
    WHERE user_id = p_player_id AND club_id = p_club_id;

    IF v_agent_id IS NULL THEN
        RAISE EXCEPTION 'Player has no assigned agent';
    END IF;

    -- Check player balance (assuming chip_balances table)
    SELECT balance INTO v_player_balance
    FROM chip_balances
    WHERE user_id = p_player_id AND club_id = p_club_id;

    IF v_player_balance IS NULL OR v_player_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient balance for cashout';
    END IF;

    -- Create cashout request
    INSERT INTO cashout_requests (club_id, player_id, agent_id, amount, player_note, status)
    VALUES (p_club_id, p_player_id, v_agent_id, p_amount, p_note, 'pending')
    RETURNING id INTO v_cashout_id;

    -- Lock chips in escrow
    INSERT INTO chip_escrow (cashout_request_id, player_id, amount)
    VALUES (v_cashout_id, p_player_id, p_amount);

    -- Deduct from player balance (move to escrow)
    UPDATE chip_balances
    SET balance = balance - p_amount,
        updated_at = NOW()
    WHERE user_id = p_player_id AND club_id = p_club_id;

    -- Record transaction
    INSERT INTO chip_transactions (club_id, from_user_id, amount, transaction_type, related_cashout_id, notes)
    VALUES (p_club_id, p_player_id, p_amount, 'escrow_lock', v_cashout_id, 'Cashout request - chips locked');

    RETURN v_cashout_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: Cancel cashout (returns chips to player)
CREATE OR REPLACE FUNCTION fn_cancel_cashout(
    p_cashout_id UUID,
    p_player_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
    v_cashout RECORD;
BEGIN
    -- Get cashout details
    SELECT * INTO v_cashout
    FROM cashout_requests
    WHERE id = p_cashout_id AND player_id = p_player_id AND status = 'pending';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cashout not found or not cancellable';
    END IF;

    -- Update cashout status
    UPDATE cashout_requests
    SET status = 'cancelled',
        cancelled_at = NOW(),
        updated_at = NOW()
    WHERE id = p_cashout_id;

    -- Release escrow back to player
    UPDATE chip_escrow
    SET released_at = NOW(),
        release_type = 'cancelled'
    WHERE cashout_request_id = p_cashout_id;

    -- Return chips to player
    UPDATE chip_balances
    SET balance = balance + v_cashout.amount,
        updated_at = NOW()
    WHERE user_id = p_player_id AND club_id = v_cashout.club_id;

    -- Record transaction
    INSERT INTO chip_transactions (club_id, to_user_id, amount, transaction_type, related_cashout_id, notes)
    VALUES (v_cashout.club_id, p_player_id, v_cashout.amount, 'escrow_release', p_cashout_id, 'Cashout cancelled by player');

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: Agent approves cashout
CREATE OR REPLACE FUNCTION fn_agent_approve_cashout(
    p_cashout_id UUID,
    p_agent_id UUID,
    p_note TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
    v_cashout RECORD;
BEGIN
    -- Get cashout details
    SELECT * INTO v_cashout
    FROM cashout_requests
    WHERE id = p_cashout_id AND agent_id = p_agent_id AND status = 'pending';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cashout not found or not approvable';
    END IF;

    -- Update cashout status
    UPDATE cashout_requests
    SET status = 'approved',
        acknowledged_at = NOW(),
        agent_note = p_note,
        updated_at = NOW()
    WHERE id = p_cashout_id;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: Complete cashout (chips removed from escrow)
CREATE OR REPLACE FUNCTION fn_complete_cashout(
    p_cashout_id UUID,
    p_agent_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
    v_cashout RECORD;
BEGIN
    -- Get approved cashout
    SELECT * INTO v_cashout
    FROM cashout_requests
    WHERE id = p_cashout_id AND agent_id = p_agent_id AND status = 'approved';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Cashout not found or not completable';
    END IF;

    -- Update cashout status
    UPDATE cashout_requests
    SET status = 'completed',
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = p_cashout_id;

    -- Release escrow (chips go to agent/removed)
    UPDATE chip_escrow
    SET released_at = NOW(),
        release_type = 'completed'
    WHERE cashout_request_id = p_cashout_id;

    -- Record transaction
    INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, related_cashout_id, notes)
    VALUES (v_cashout.club_id, v_cashout.player_id, v_cashout.agent_id, v_cashout.amount, 'cashout', p_cashout_id, 'Cashout completed');

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ═══════════════════════════════════════════════════════════════════════════════
-- TRIGGER: Notify agent on cashout request
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_notify_agent_on_cashout()
RETURNS TRIGGER AS $$
DECLARE
    v_player_name TEXT;
    v_club_name TEXT;
BEGIN
    -- Get player name
    SELECT display_name INTO v_player_name
    FROM profiles
    WHERE id = NEW.player_id;

    -- Get club name
    SELECT name INTO v_club_name
    FROM clubs
    WHERE id = NEW.club_id;

    -- Create notification for agent
    INSERT INTO notifications (user_id, type, title, message, data, created_at)
    VALUES (
        NEW.agent_id,
        'cashout_request',
        '💰 Cashout Request',
        v_player_name || ' requested a cashout of ' || NEW.amount || ' chips in ' || v_club_name,
        jsonb_build_object(
            'cashout_id', NEW.id,
            'player_id', NEW.player_id,
            'club_id', NEW.club_id,
            'amount', NEW.amount
        ),
        NOW()
    );

    -- Create a club message notification for agent
    INSERT INTO messages (
        conversation_id,
        sender_id,
        receiver_id,
        content,
        is_read,
        created_at
    )
    SELECT 
        c.id,
        NEW.player_id,
        NEW.agent_id,
        '💰 Cashout Request: ' || NEW.amount || ' chips. Please review in your agent dashboard.',
        FALSE,
        NOW()
    FROM conversations c
    WHERE c.participant_ids @> ARRAY[NEW.player_id, NEW.agent_id]
      AND c.club_id = NEW.club_id
      AND c.category = 'club'
    LIMIT 1;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS tr_notify_agent_on_cashout ON cashout_requests;
CREATE TRIGGER tr_notify_agent_on_cashout
    AFTER INSERT ON cashout_requests
    FOR EACH ROW
    WHEN (NEW.status = 'pending')
    EXECUTE FUNCTION fn_notify_agent_on_cashout();

-- Log
DO $$ BEGIN RAISE NOTICE '✅ CHIP CASHOUT ESCROW SYSTEM READY'; END $$;
