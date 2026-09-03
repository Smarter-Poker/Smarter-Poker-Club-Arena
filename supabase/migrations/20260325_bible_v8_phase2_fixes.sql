-- ═══════════════════════════════════════════════════════════════════════════════
-- ♠ CLUB ARENA — Bible V8 Phase 2 Verification: Schema Updates
-- ═══════════════════════════════════════════════════════════════════════════════
-- Adds table settings columns required by Bible V8 §2.2, §4.3, §4.4:
--   - big_blind_ante_enabled: BBA mode (BB posts ante for entire table)
--   - straddle_enabled: Whether straddles are allowed
--   - straddle_type: 'utg' or 'mississippi'
--   - max_straddles: Maximum number of re-straddles (0 = unlimited)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add BBA setting (Bible V8 §4.3)
ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS big_blind_ante_enabled BOOLEAN DEFAULT FALSE;

-- Add straddle settings (Bible V8 §4.4)
ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS straddle_enabled BOOLEAN DEFAULT FALSE;

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS straddle_type TEXT DEFAULT 'utg'
  CHECK (straddle_type IN ('utg', 'mississippi'));

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS max_straddles INTEGER DEFAULT 1;

-- Comment the new columns for documentation
COMMENT ON COLUMN public.tables.big_blind_ante_enabled IS 'Bible V8 §4.3: When true, BB posts ante for entire table instead of each player posting individually';
COMMENT ON COLUMN public.tables.straddle_enabled IS 'Bible V8 §4.4: When true, UTG or Mississippi straddles are allowed';
COMMENT ON COLUMN public.tables.straddle_type IS 'Bible V8 §4.4: utg = only UTG can straddle; mississippi = any position can straddle';
COMMENT ON COLUMN public.tables.max_straddles IS 'Bible V8 §4.4: Max number of re-straddles per hand (0 = unlimited)';
