-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 ADDITIONAL SCHEMA FIXES
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Add slug column to clubs if not exists
DO $$ BEGIN
    ALTER TABLE clubs ADD COLUMN slug TEXT;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

-- Create unique index on slug
CREATE UNIQUE INDEX IF NOT EXISTS idx_clubs_slug ON clubs(slug) WHERE slug IS NOT NULL;

-- 2. Ensure messages has is_read column
DO $$ BEGIN
    ALTER TABLE messages ADD COLUMN is_read BOOLEAN DEFAULT FALSE;
EXCEPTION WHEN duplicate_column THEN
    NULL;
END $$;

DO $$ 
BEGIN 
    RAISE NOTICE '🔧 ADDITIONAL SCHEMA FIXES APPLIED';
END $$;
