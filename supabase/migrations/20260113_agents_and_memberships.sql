-- ═══════════════════════════════════════════════════════════════════════════════
-- 🎰 CLUB ENGINE — Agents & Memberships Schema
-- ═══════════════════════════════════════════════════════════════════════════════
-- Full schema for club memberships, agent hierarchy, and credit management

-- ═══════════════════════════════════════════════════════════════════════════════
-- ENUMS
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TYPE member_role AS ENUM (
    'platform_admin',
    'union_lead',
    'union_admin',
    'club_owner',
    'club_admin',
    'super_agent',
    'agent',
    'sub_agent',
    'member',
    'guest'
);

CREATE TYPE member_status AS ENUM (
    'active',
    'pending',
    'suspended',
    'banned'
);

CREATE TYPE agent_status AS ENUM (
    'active',
    'suspended',
    'frozen'
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CLUB MEMBERS TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS club_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    role member_role NOT NULL DEFAULT 'member',
    status member_status NOT NULL DEFAULT 'pending',
    
    -- Agent relationship
    agent_id UUID REFERENCES club_members(id),           -- The agent who recruited this member
    parent_agent_id UUID REFERENCES club_members(id),   -- For sub-agents: their parent agent
    
    -- Metadata
    invited_by UUID REFERENCES profiles(id),
    notes TEXT,
    
    -- Timestamps
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Constraints
    UNIQUE(club_id, user_id)
);

-- Indexes
CREATE INDEX idx_club_members_club ON club_members(club_id);
CREATE INDEX idx_club_members_user ON club_members(user_id);
CREATE INDEX idx_club_members_agent ON club_members(agent_id);
CREATE INDEX idx_club_members_parent_agent ON club_members(parent_agent_id);
CREATE INDEX idx_club_members_role ON club_members(role);
CREATE INDEX idx_club_members_status ON club_members(status);

-- ═══════════════════════════════════════════════════════════════════════════════
-- AGENTS TABLE (Extended Agent Data)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    membership_id UUID REFERENCES club_members(id) ON DELETE CASCADE,
    
    -- Role & Status
    role member_role NOT NULL CHECK (role IN ('super_agent', 'agent', 'sub_agent')),
    status agent_status NOT NULL DEFAULT 'active',
    
    -- Parent Agent (for agent/sub_agent hierarchy)
    parent_agent_id UUID REFERENCES agents(id),
    
    -- Commission Rates (MANDATORY when creating agent)
    commission_rate DECIMAL(5,4) NOT NULL CHECK (commission_rate >= 0 AND commission_rate <= 0.70),  -- Max 70%
    player_rakeback_rate DECIMAL(5,4) NOT NULL CHECK (player_rakeback_rate >= 0 AND player_rakeback_rate <= 0.50),  -- Max 50%
    
    -- Credit (MANDATORY when creating agent)
    credit_limit DECIMAL(15,2) NOT NULL DEFAULT 0,
    credit_used DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (credit_used >= 0),
    is_prepaid BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Triple Wallet (from wallets table, cached here)
    business_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
    player_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
    promo_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
    
    -- Stats (updated periodically)
    total_players INTEGER NOT NULL DEFAULT 0,
    active_player_count INTEGER NOT NULL DEFAULT 0,
    sub_agent_count INTEGER NOT NULL DEFAULT 0,
    weekly_rake_generated DECIMAL(15,2) NOT NULL DEFAULT 0,
    lifetime_earnings DECIMAL(15,2) NOT NULL DEFAULT 0,
    
    -- Timestamps
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_active_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Constraints
    UNIQUE(club_id, user_id),
    CONSTRAINT check_credit_usage CHECK (credit_used <= credit_limit OR is_prepaid = TRUE)
);

-- Indexes
CREATE INDEX idx_agents_club ON agents(club_id);
CREATE INDEX idx_agents_user ON agents(user_id);
CREATE INDEX idx_agents_parent ON agents(parent_agent_id);
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_role ON agents(role);

-- ═══════════════════════════════════════════════════════════════════════════════
-- ROLE CHANGES LOG (Audit Trail)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS role_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
    old_role member_role,
    new_role member_role NOT NULL,
    changed_by UUID NOT NULL REFERENCES profiles(id),
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_role_changes_member ON role_changes(member_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- CREDIT ASSIGNMENTS LOG
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS credit_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    assigned_by UUID NOT NULL REFERENCES profiles(id),
    old_limit DECIMAL(15,2) NOT NULL,
    new_limit DECIMAL(15,2) NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_assignments_agent ON credit_assignments(agent_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Update sub_agent_count for parent agents
CREATE OR REPLACE FUNCTION update_sub_agent_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.parent_agent_id IS NOT NULL THEN
        UPDATE agents SET sub_agent_count = sub_agent_count + 1
        WHERE id = NEW.parent_agent_id;
    ELSIF TG_OP = 'DELETE' AND OLD.parent_agent_id IS NOT NULL THEN
        UPDATE agents SET sub_agent_count = sub_agent_count - 1
        WHERE id = OLD.parent_agent_id;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.parent_agent_id IS DISTINCT FROM NEW.parent_agent_id THEN
            IF OLD.parent_agent_id IS NOT NULL THEN
                UPDATE agents SET sub_agent_count = sub_agent_count - 1
                WHERE id = OLD.parent_agent_id;
            END IF;
            IF NEW.parent_agent_id IS NOT NULL THEN
                UPDATE agents SET sub_agent_count = sub_agent_count + 1
                WHERE id = NEW.parent_agent_id;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_update_sub_agent_count
    AFTER INSERT OR UPDATE OR DELETE ON agents
    FOR EACH ROW EXECUTE FUNCTION update_sub_agent_count();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_club_members_updated_at
    BEFORE UPDATE ON club_members
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE club_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_assignments ENABLE ROW LEVEL SECURITY;

-- Club members: Viewable by club members, editable by admins
CREATE POLICY "Club members viewable by members"
    ON club_members FOR SELECT
    USING (
        club_id IN (
            SELECT club_id FROM club_members 
            WHERE user_id = auth.uid() AND status = 'active'
        )
    );

CREATE POLICY "Club members manageable by admins"
    ON club_members FOR ALL
    USING (
        club_id IN (
            SELECT club_id FROM club_members 
            WHERE user_id = auth.uid() 
            AND role IN ('platform_admin', 'union_lead', 'union_admin', 'club_owner', 'club_admin')
            AND status = 'active'
        )
    );

-- Agents: Viewable by club members, editable by admins
CREATE POLICY "Agents viewable by club members"
    ON agents FOR SELECT
    USING (
        club_id IN (
            SELECT club_id FROM club_members 
            WHERE user_id = auth.uid() AND status = 'active'
        )
    );

CREATE POLICY "Agents manageable by admins"
    ON agents FOR ALL
    USING (
        club_id IN (
            SELECT club_id FROM club_members 
            WHERE user_id = auth.uid() 
            AND role IN ('platform_admin', 'union_lead', 'union_admin', 'club_owner', 'club_admin', 'super_agent')
            AND status = 'active'
        )
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE club_members IS 'Club membership records linking users to clubs';
COMMENT ON TABLE agents IS 'Extended agent data with commission rates and credit limits';
COMMENT ON TABLE role_changes IS 'Audit log of role changes for compliance';
COMMENT ON TABLE credit_assignments IS 'Audit log of credit limit changes';
COMMENT ON COLUMN agents.commission_rate IS 'Rate agent receives from club (max 70%)';
COMMENT ON COLUMN agents.player_rakeback_rate IS 'Rate agent gives to players (max 50%)';
COMMENT ON COLUMN agents.credit_limit IS 'Credit limit assigned by hierarchy (club→agent→sub-agent)';
