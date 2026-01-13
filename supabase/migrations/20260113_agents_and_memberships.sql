-- ═══════════════════════════════════════════════════════════════════════════════
-- 🎰 CLUB ENGINE — Agent Hierarchy & Credit System UPDATE
-- ═══════════════════════════════════════════════════════════════════════════════
-- This is an UPDATE migration for existing schema
-- Run AFTER 001_club_arena_schema.sql is applied

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. DROP OLD ENUMS AND RECREATE WITH EXPANDED VALUES
-- ═══════════════════════════════════════════════════════════════════════════════

-- We need to drop dependent objects first, then recreate

-- Create new role enum with all 10 levels
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_role_v2') THEN
        CREATE TYPE member_role_v2 AS ENUM (
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
    END IF;
END $$;

-- Create agent status enum
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_status') THEN
        CREATE TYPE agent_status AS ENUM (
            'active',
            'suspended',
            'frozen'
        );
    END IF;
END $$;

-- Migrate club_members.role to use the table format (text) for now
-- This avoids ENUM migration complexity
ALTER TABLE club_members 
    ALTER COLUMN role TYPE TEXT USING role::TEXT;

-- Migrate agents table - drop and recreate with new schema
DROP TABLE IF EXISTS agents CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ENHANCED CLUB_MEMBERS TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add new columns to club_members
ALTER TABLE club_members 
    ADD COLUMN IF NOT EXISTS parent_agent_id UUID REFERENCES club_members(id),
    ADD COLUMN IF NOT EXISTS invited_by UUID,
    ADD COLUMN IF NOT EXISTS notes TEXT,
    ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Additional indexes
CREATE INDEX IF NOT EXISTS idx_club_members_parent_agent ON club_members(parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_club_members_role_text ON club_members(role);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. NEW AGENTS TABLE (Full Schema)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    membership_id UUID REFERENCES club_members(id) ON DELETE CASCADE,
    
    -- Role & Status (using TEXT for flexibility)
    role TEXT NOT NULL CHECK (role IN ('super_agent', 'agent', 'sub_agent')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'frozen')),
    
    -- Parent Agent (for agent/sub_agent hierarchy)
    parent_agent_id UUID REFERENCES agents(id),
    
    -- Commission Rates (MANDATORY when creating agent)
    commission_rate DECIMAL(5,4) NOT NULL CHECK (commission_rate >= 0 AND commission_rate <= 0.70),  -- Max 70%
    player_rakeback_rate DECIMAL(5,4) NOT NULL CHECK (player_rakeback_rate >= 0 AND player_rakeback_rate <= 0.50),  -- Max 50%
    
    -- Credit (MANDATORY when creating agent)
    credit_limit DECIMAL(15,2) NOT NULL DEFAULT 0,
    credit_used DECIMAL(15,2) NOT NULL DEFAULT 0 CHECK (credit_used >= 0),
    is_prepaid BOOLEAN NOT NULL DEFAULT FALSE,
    
    -- Triple Wallet
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
CREATE INDEX IF NOT EXISTS idx_agents_club ON agents(club_id);
CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_role ON agents(role);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. ROLE CHANGES LOG (Audit Trail)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS role_changes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES club_members(id) ON DELETE CASCADE,
    old_role TEXT,
    new_role TEXT NOT NULL,
    changed_by UUID NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_role_changes_member ON role_changes(member_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. CREDIT ASSIGNMENTS LOG
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS credit_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    assigned_by UUID NOT NULL,
    old_limit DECIMAL(15,2) NOT NULL,
    new_limit DECIMAL(15,2) NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_assignments_agent ON credit_assignments(agent_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. ENHANCED UNIONS TABLE
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add union_id to clubs for union membership
ALTER TABLE clubs 
    ADD COLUMN IF NOT EXISTS union_id UUID REFERENCES unions(id);

-- Enhance unions table
ALTER TABLE unions
    ADD COLUMN IF NOT EXISTS avatar_url TEXT,
    ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS member_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS club_count INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_rake DECIMAL(15,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Add union admins table
CREATE TABLE IF NOT EXISTS union_admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    union_id UUID NOT NULL REFERENCES unions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'union_admin' CHECK (role IN ('union_lead', 'union_admin')),
    permissions JSONB DEFAULT '{"manage_clubs": true, "manage_settlements": true}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(union_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_union_admins_union ON union_admins(union_id);
CREATE INDEX IF NOT EXISTS idx_union_admins_user ON union_admins(user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. TRIGGERS
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

DROP TRIGGER IF EXISTS trg_update_sub_agent_count ON agents;
CREATE TRIGGER trg_update_sub_agent_count
    AFTER INSERT OR UPDATE OR DELETE ON agents
    FOR EACH ROW EXECUTE FUNCTION update_sub_agent_count();

-- Auto-update updated_at for agents
DROP TRIGGER IF EXISTS trg_agents_updated_at ON agents;
CREATE TRIGGER trg_agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Auto-update updated_at for club_members
DROP TRIGGER IF EXISTS trg_club_members_updated_at ON club_members;
CREATE TRIGGER trg_club_members_updated_at
    BEFORE UPDATE ON club_members
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE union_admins ENABLE ROW LEVEL SECURITY;

-- Agents: Viewable by club members
CREATE POLICY "Agents viewable by club members"
    ON agents FOR SELECT
    USING (
        club_id IN (
            SELECT club_id FROM club_members 
            WHERE user_id = auth.uid() AND status = 'active'
        )
    );

-- Agents: Manageable by admins and super_agents
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

-- Role changes: Viewable by admins
CREATE POLICY "Role changes viewable by admins"
    ON role_changes FOR SELECT
    USING (
        member_id IN (
            SELECT id FROM club_members cm
            WHERE cm.club_id IN (
                SELECT club_id FROM club_members 
                WHERE user_id = auth.uid() 
                AND role IN ('platform_admin', 'union_lead', 'union_admin', 'club_owner', 'club_admin')
            )
        )
    );

-- Credit assignments: Viewable by admins
CREATE POLICY "Credit assignments viewable by admins"
    ON credit_assignments FOR SELECT
    USING (
        agent_id IN (
            SELECT id FROM agents a
            WHERE a.club_id IN (
                SELECT club_id FROM club_members 
                WHERE user_id = auth.uid() 
                AND role IN ('platform_admin', 'union_lead', 'union_admin', 'club_owner', 'club_admin', 'super_agent')
            )
        )
    );

-- Union admins: Members can view their union's admins
CREATE POLICY "Union admins viewable by members"
    ON union_admins FOR SELECT
    USING (
        union_id IN (
            SELECT union_id FROM clubs c
            JOIN club_members cm ON cm.club_id = c.id
            WHERE cm.user_id = auth.uid()
        )
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. COMMENTS
-- ═══════════════════════════════════════════════════════════════════════════════

COMMENT ON TABLE agents IS 'Extended agent data with commission rates, credit limits, and triple wallet';
COMMENT ON TABLE role_changes IS 'Audit log of role changes for compliance';
COMMENT ON TABLE credit_assignments IS 'Audit log of credit limit changes';
COMMENT ON TABLE union_admins IS 'Union administrators with specified roles and permissions';

COMMENT ON COLUMN agents.commission_rate IS 'Rate agent receives from club (max 70%)';
COMMENT ON COLUMN agents.player_rakeback_rate IS 'Rate agent gives to players (max 50%)';
COMMENT ON COLUMN agents.credit_limit IS 'Credit limit assigned by hierarchy (club→agent→sub-agent)';
COMMENT ON COLUMN agents.business_balance IS 'Wallet for commission earnings';
COMMENT ON COLUMN agents.player_balance IS 'Wallet for player chips';
COMMENT ON COLUMN agents.promo_balance IS 'Wallet for promotional funds';

-- ═══════════════════════════════════════════════════════════════════════════════
-- SUCCESS
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ 
BEGIN 
    RAISE NOTICE '✅ Agent Hierarchy & Credit System UPDATE applied successfully';
END $$;
