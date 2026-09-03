-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 MORE CLUB MEMBER SCHEMA FIXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Add rank_level to club_members
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN rank_level INTEGER DEFAULT 1;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- 2. Add credit_limit to club_members (for agent/player credit system)
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN credit_limit DECIMAL(15,2) DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- 3. Add credit_used to club_members
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN credit_used DECIMAL(15,2) DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- 4. Add notes column
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN notes TEXT;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- 5. Add nickname column  
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN nickname TEXT;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- 6. Add agent_id column (for player's agent)
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN agent_id UUID REFERENCES profiles(id);
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- 7. Add last_active column
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN last_active TIMESTAMPTZ DEFAULT NOW();
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- 8. Clean up any test clubs that may have been created
DELETE FROM club_members WHERE club_id IN (SELECT id FROM clubs WHERE name LIKE '%Test%' OR name LIKE '%Verification%');
DELETE FROM clubs WHERE name LIKE '%Test%' OR name LIKE '%Verification%';

DO $$ 
BEGIN 
    RAISE NOTICE '🔧 MORE CLUB MEMBER FIXES APPLIED';
END $$;
