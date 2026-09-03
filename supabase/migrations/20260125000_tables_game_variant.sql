-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 FIX TABLES SCHEMA - ADD GAME_VARIANT COLUMN
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add game_variant column to tables (expected by TableService)
ALTER TABLE tables ADD COLUMN IF NOT EXISTS game_variant TEXT DEFAULT 'nlh';

-- Also add other commonly expected columns that might be missing
ALTER TABLE tables ADD COLUMN IF NOT EXISTS enable_straddle BOOLEAN DEFAULT true;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS run_it_twice BOOLEAN DEFAULT true;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS bomb_pots BOOLEAN DEFAULT false;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS auto_muck BOOLEAN DEFAULT true;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS ante DECIMAL(15,2) DEFAULT 0;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS time_bank_seconds INTEGER DEFAULT 30;

-- Create index for game_variant
CREATE INDEX IF NOT EXISTS idx_tables_game_variant ON tables(game_variant);

-- Update any existing tables with null game_variant
UPDATE tables SET game_variant = 'nlh' WHERE game_variant IS NULL;

DO $$ BEGIN RAISE NOTICE '🔧 TABLES SCHEMA FIXED - game_variant column added'; END $$;
