-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔐 CLUB MESSAGING PERMISSIONS — Database-Level Enforcement
-- ═══════════════════════════════════════════════════════════════════════════════
-- Role-based messaging rules enforced via RLS policies
-- 
-- Hierarchy:
-- UNION OWNER/ADMIN → Can message ANY player
-- CLUB OWNER/ADMIN → Can message ANY player in their club
-- AGENT → Can message: their players, club owners, club admins
-- PLAYER → Can message: their agent, designated club admin only
-- ═══════════════════════════════════════════════════════════════════════════════

-- Helper function: Check if user can message another user in a club conversation
CREATE OR REPLACE FUNCTION fn_can_message_in_club(
    sender_id UUID,
    recipient_id UUID,
    p_club_id UUID
) RETURNS BOOLEAN AS $$
DECLARE
    sender_role TEXT;
    sender_agent_id UUID;
    recipient_role TEXT;
    recipient_agent_id UUID;
    is_union_member BOOLEAN;
BEGIN
    -- Check if sender is a union owner/admin (can message anyone)
    SELECT EXISTS(
        SELECT 1 FROM union_members um
        JOIN unions u ON um.union_id = u.id
        JOIN clubs c ON c.union_id = u.id
        WHERE um.user_id = sender_id 
        AND c.id = p_club_id
        AND um.role IN ('owner', 'admin')
    ) INTO is_union_member;
    
    IF is_union_member THEN
        RETURN TRUE;
    END IF;

    -- Get sender's club role and agent
    SELECT role, agent_id INTO sender_role, sender_agent_id
    FROM club_members
    WHERE user_id = sender_id AND club_id = p_club_id;

    IF sender_role IS NULL THEN
        RETURN FALSE; -- Sender not in club
    END IF;

    -- Get recipient's club role and agent
    SELECT role, agent_id INTO recipient_role, recipient_agent_id
    FROM club_members
    WHERE user_id = recipient_id AND club_id = p_club_id;

    IF recipient_role IS NULL THEN
        RETURN FALSE; -- Recipient not in club
    END IF;

    -- Club owner/admin can message anyone
    IF sender_role IN ('owner', 'admin') THEN
        RETURN TRUE;
    END IF;

    -- Agent can message:
    -- - Club owner/admin
    -- - Their own players (where player's agent_id = sender_id)
    -- - Other agents
    IF sender_role = 'agent' THEN
        IF recipient_role IN ('owner', 'admin', 'agent') THEN
            RETURN TRUE;
        END IF;
        IF recipient_agent_id = sender_id THEN
            RETURN TRUE; -- Recipient is sender's player
        END IF;
        RETURN FALSE;
    END IF;

    -- Player can message:
    -- - Their assigned agent
    -- - Club owner/admin
    IF sender_role = 'player' THEN
        IF sender_agent_id = recipient_id THEN
            RETURN TRUE; -- Their agent
        END IF;
        IF recipient_role IN ('owner', 'admin') THEN
            RETURN TRUE;
        END IF;
        RETURN FALSE;
    END IF;

    RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Policy: Only allow inserting messages to allowed recipients in club conversations
CREATE OR REPLACE FUNCTION fn_check_club_message_permission()
RETURNS TRIGGER AS $$
DECLARE
    conv_category TEXT;
    conv_club_id UUID;
BEGIN
    -- Get conversation details
    SELECT category, club_id INTO conv_category, conv_club_id
    FROM conversations
    WHERE id = NEW.conversation_id;

    -- If not a club conversation, allow (personal messages have different rules)
    IF conv_category != 'club' OR conv_club_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Check permission
    IF NOT fn_can_message_in_club(NEW.sender_id, NEW.receiver_id, conv_club_id) THEN
        RAISE EXCEPTION 'Not authorized to message this user in this club';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger for message insert permission check
DROP TRIGGER IF EXISTS tr_check_club_message_permission ON messages;
CREATE TRIGGER tr_check_club_message_permission
    BEFORE INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION fn_check_club_message_permission();

-- Log successful creation
DO $$ BEGIN RAISE NOTICE '✅ CLUB MESSAGING PERMISSIONS READY'; END $$;
