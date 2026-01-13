-- ═══════════════════════════════════════════════════════════════════════════════
-- 💰 FINANCIAL CORE MIGRATION - Phase 1
-- ═══════════════════════════════════════════════════════════════════════════════
-- Implements: Triple-Wallets, Credit Lines, BBJ Pools, and Diamond Economy
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. UPGRADE AGENTS TABLE (Triple Wallet & Credit Line)
ALTER TABLE agents 
    ADD COLUMN IF NOT EXISTS agent_wallet_balance DECIMAL(15, 2) DEFAULT 0, -- Business (Commissions)
    ADD COLUMN IF NOT EXISTS promo_wallet_balance DECIMAL(15, 2) DEFAULT 0, -- Marketing (Non-cashable)
    ADD COLUMN IF NOT EXISTS credit_limit DECIMAL(15, 2) DEFAULT 0,         -- Debt Ceiling
    ADD COLUMN IF NOT EXISTS is_prepaid BOOLEAN DEFAULT false;             -- Pre-paid vs Credit

-- Rename original chip_balance to player_wallet_balance for clarity
ALTER TABLE agents RENAME COLUMN chip_balance TO player_wallet_balance;

-- 2. DIAMOND ECONOMY (Club Wallets)
CREATE TABLE IF NOT EXISTS club_diamond_wallets (
    club_id UUID PRIMARY KEY REFERENCES clubs(id) ON DELETE CASCADE,
    balance DECIMAL(15, 2) DEFAULT 0,
    total_minted DECIMAL(15, 2) DEFAULT 0,
    last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- 3. BBJ POOLS (Triple Bank)
CREATE TABLE IF NOT EXISTS bbj_pools (
    union_id UUID REFERENCES unions(id) ON DELETE CASCADE,
    club_id UUID REFERENCES clubs(id) ON DELETE CASCADE, -- Null if Union pool
    pool_type TEXT CHECK (pool_type IN ('MAIN', 'BACKUP', 'PROMO')),
    balance DECIMAL(15, 2) DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (union_id, club_id, pool_type),
    CONSTRAINT one_owner_check CHECK (
        (union_id IS NOT NULL AND club_id IS NULL) OR 
        (union_id IS NULL AND club_id IS NOT NULL)
    )
);

-- 4. SETTLEMENTS & INVOICES
CREATE TYPE settlement_status AS ENUM ('PENDING', 'PAID', 'DISPUTED');

CREATE TABLE IF NOT EXISTS settlements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    entity_id UUID NOT NULL, -- Agent ID or Club ID
    entity_type TEXT CHECK (entity_type IN ('AGENT', 'CLUB')),
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    
    -- Financials
    total_rake_generated DECIMAL(15, 2) DEFAULT 0,
    total_player_pl DECIMAL(15, 2) DEFAULT 0,
    union_tax DECIMAL(15, 2) DEFAULT 0,
    debt_owed DECIMAL(15, 2) DEFAULT 0, -- (Limit - Balance) for Agents
    net_wire_amount DECIMAL(15, 2) DEFAULT 0, -- Final Settlement Calculation
    
    status settlement_status DEFAULT 'PENDING',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    settled_at TIMESTAMPTZ
);

-- 5. COMMISSION CONFIGURATION (Hierarchical)
CREATE TABLE IF NOT EXISTS commission_structures (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    club_id UUID REFERENCES clubs(id),
    agent_id UUID REFERENCES agents(id),
    target_role TEXT CHECK (target_role IN ('AGENT', 'SUB_AGENT', 'PLAYER')),
    rate DECIMAL(5, 4) NOT NULL, -- e.g. 0.70 for 70%
    set_by UUID REFERENCES auth.users(id),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(club_id, agent_id, target_role)
);

-- RLS POLICIES
ALTER TABLE club_diamond_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE bbj_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_structures ENABLE ROW LEVEL SECURITY;

-- Owners can view their Diamond Wallet
CREATE POLICY "Owners view diamond wallet" ON club_diamond_wallets
    FOR SELECT USING (club_id IN (SELECT id FROM clubs WHERE owner_id = auth.uid()));

-- Agents can view their own settlements
CREATE POLICY "Agents view settlements" ON settlements
    FOR SELECT USING (entity_type = 'AGENT' AND entity_id IN (SELECT id FROM agents WHERE user_id = auth.uid()));

DO $$ 
BEGIN 
    RAISE NOTICE '💰 FINANCIAL CORE SCHEMA APPLIED SUCCESSFULLY';
END $$;
