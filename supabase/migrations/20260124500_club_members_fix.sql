-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 CLUB MEMBERS SCHEMA FIX
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add diamonds column to club_members if not exists
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN diamonds INTEGER DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- Add role column if missing
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN role TEXT DEFAULT 'member';
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- Add chip_balance column if missing
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN chip_balance DECIMAL(15,2) DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- Add joined_at column if missing
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN joined_at TIMESTAMPTZ DEFAULT NOW();
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- Add is_active column if missing
DO $$ BEGIN
    ALTER TABLE club_members ADD COLUMN is_active BOOLEAN DEFAULT TRUE;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

DO $$ 
BEGIN 
    RAISE NOTICE '🔧 CLUB MEMBERS SCHEMA FIX APPLIED';
END $$;
