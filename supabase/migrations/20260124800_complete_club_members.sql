-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 COMPREHENSIVE CLUB MEMBERS SCHEMA - ALL COLUMNS
-- ═══════════════════════════════════════════════════════════════════════════════
-- This migration adds ALL columns that ClubsService.joinClub expects

-- Core columns required by joinClub insert
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN tier TEXT DEFAULT 'bronze'; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN xp INTEGER DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN diamonds INTEGER DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN reputation_xp INTEGER DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN trust_score INTEGER DEFAULT 50; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN rank_level INTEGER DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN sessions_played INTEGER DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN orange_ball_status TEXT DEFAULT 'cold'; EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Additional columns for other services
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN role TEXT DEFAULT 'member'; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN is_active BOOLEAN DEFAULT TRUE; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN status TEXT DEFAULT 'active'; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN chip_balance DECIMAL(15,2) DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN credit_limit DECIMAL(15,2) DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN credit_used DECIMAL(15,2) DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN agent_id UUID; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN nickname TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN notes TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN last_active TIMESTAMPTZ DEFAULT NOW(); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE club_members ADD COLUMN joined_at TIMESTAMPTZ DEFAULT NOW(); EXCEPTION WHEN duplicate_column THEN NULL; END $$;

-- Clean up test clubs
DELETE FROM club_members WHERE club_id IN (SELECT id FROM clubs WHERE name LIKE '%Test%' OR name LIKE '%Verification%' OR name LIKE '%Final%');
DELETE FROM clubs WHERE name LIKE '%Test%' OR name LIKE '%Verification%' OR name LIKE '%Final%';

DO $$ BEGIN RAISE NOTICE '✅ COMPREHENSIVE CLUB MEMBERS SCHEMA APPLIED'; END $$;
