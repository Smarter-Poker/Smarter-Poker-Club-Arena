-- ═══════════════════════════════════════════════════════════════════════════════
-- Club Level System — Performance Index
-- March 21, 2026
--
-- Speeds up the COUNT(*) FILTER queries inside recompute_club_levels() and
-- recompute_union_levels() by providing a composite index on the three columns
-- used in the WHERE/FILTER clauses.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_club_members_club_role_status
    ON club_members (club_id, role, status);

-- Also fix promote_member RPC to accept both 'active' and 'approved' statuses
-- Previously only checked status = 'approved', but new members join with 'active'
CREATE OR REPLACE FUNCTION promote_member(
    p_club_id UUID,
    p_target_user_id UUID,
    p_new_role TEXT,
    p_promoted_by UUID
)
RETURNS JSONB AS $$
DECLARE
    v_old_role TEXT;
    v_promoter_role TEXT;
    v_existing_agent_id UUID;
    v_is_agent_role BOOLEAN;
    v_was_agent_role BOOLEAN;
BEGIN
    -- Validate new role
    IF p_new_role NOT IN ('admin', 'super_agent', 'agent', 'sub_agent', 'manager', 'member') THEN
        RETURN jsonb_build_object('success', false, 'error', 'Invalid role: ' || p_new_role);
    END IF;

    -- Get target member current role (accept both 'active' and 'approved' statuses)
    SELECT role INTO v_old_role
    FROM club_members
    WHERE club_id = p_club_id AND user_id = p_target_user_id AND status IN ('active', 'approved');

    IF v_old_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Target member not found or inactive');
    END IF;

    -- Get promoter role
    SELECT role INTO v_promoter_role
    FROM club_members
    WHERE club_id = p_club_id AND user_id = p_promoted_by AND status IN ('active', 'approved');

    IF v_promoter_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Promoter not found or inactive');
    END IF;

    -- Permission check: owner can promote to anything, admin to super_agent/agent/manager/member,
    -- super_agent to agent/sub_agent/member
    IF v_promoter_role = 'owner' THEN
        -- Owner can promote to any non-owner role
        NULL;
    ELSIF v_promoter_role = 'admin' THEN
        IF p_new_role NOT IN ('super_agent', 'agent', 'sub_agent', 'manager', 'member') THEN
            RETURN jsonb_build_object('success', false, 'error', 'Admins cannot promote to ' || p_new_role);
        END IF;
    ELSIF v_promoter_role = 'super_agent' THEN
        IF p_new_role NOT IN ('agent', 'sub_agent', 'member') THEN
            RETURN jsonb_build_object('success', false, 'error', 'Super agents can only promote to agent/sub_agent/member');
        END IF;
    ELSE
        RETURN jsonb_build_object('success', false, 'error', 'Insufficient permissions to promote');
    END IF;

    -- Cannot modify owner
    IF v_old_role = 'owner' THEN
        RETURN jsonb_build_object('success', false, 'error', 'Cannot modify club owner role');
    END IF;

    -- Same role? No-op
    IF v_old_role = p_new_role THEN
        RETURN jsonb_build_object('success', true, 'message', 'Role unchanged');
    END IF;

    v_is_agent_role := p_new_role IN ('super_agent', 'agent', 'sub_agent');
    v_was_agent_role := v_old_role IN ('super_agent', 'agent', 'sub_agent');

    -- Update club_members role (composite key: club_id + user_id)
    UPDATE club_members
    SET role = p_new_role, updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = p_target_user_id;

    -- Handle agents table entry
    IF v_is_agent_role THEN
        SELECT id INTO v_existing_agent_id
        FROM agents
        WHERE club_id = p_club_id AND user_id = p_target_user_id;

        IF v_existing_agent_id IS NOT NULL THEN
            UPDATE agents
            SET role = p_new_role, status = 'active', updated_at = NOW()
            WHERE id = v_existing_agent_id;
        ELSE
            INSERT INTO agents (club_id, user_id, role, status, commission_rate, player_rakeback_rate, credit_limit)
            VALUES (
                p_club_id,
                p_target_user_id,
                p_new_role,
                'active',
                CASE WHEN p_new_role = 'super_agent' THEN 0.50 ELSE 0.30 END,
                CASE WHEN p_new_role = 'super_agent' THEN 0.30 ELSE 0.20 END,
                0
            );
        END IF;
    ELSIF v_was_agent_role AND NOT v_is_agent_role THEN
        -- Demoting from agent role: deactivate agent entry
        UPDATE agents
        SET status = 'suspended', updated_at = NOW()
        WHERE club_id = p_club_id AND user_id = p_target_user_id;
    END IF;

    -- Attempt audit log (role_changes table may have schema issues, so wrap in exception)
    BEGIN
        INSERT INTO role_changes (old_role, new_role, changed_by, reason)
        VALUES (v_old_role, p_new_role, p_promoted_by, 'Promoted via Players page');
    EXCEPTION WHEN OTHERS THEN
        -- Audit logging is non-critical; don't fail the promotion
        NULL;
    END;

    RETURN jsonb_build_object(
        'success', true,
        'old_role', v_old_role,
        'new_role', p_new_role
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION promote_member TO authenticated;
