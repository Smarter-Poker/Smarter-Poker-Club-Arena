-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX-218/219: Bible V8 §2.2 — Add missing table settings columns
-- These fields exist in the TableInfo TypeScript interface and Bible V8 spec
-- but were never added as actual database columns.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Bible V8 §4.3: Separate toggle for ante (allows non-zero ante amount to be stored
-- but disabled without losing the configured value)
ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS ante_enabled BOOLEAN DEFAULT FALSE;

-- Bible V8 §4.22: Bomb pot frequency — every N hands (0 = never)
ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS bomb_pot_frequency INTEGER DEFAULT 0;

-- Bible V8 §4.22: Bomb pot ante multiplier (× BB for the forced ante)
ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS bomb_pot_ante_multiplier INTEGER DEFAULT 2;

-- Comments
COMMENT ON COLUMN public.tables.ante_enabled IS 'Bible V8 §4.3: When false, antes are disabled regardless of ante amount';
COMMENT ON COLUMN public.tables.bomb_pot_frequency IS 'Bible V8 §4.22: Trigger bomb pot every N hands (0 = disabled)';
COMMENT ON COLUMN public.tables.bomb_pot_ante_multiplier IS 'Bible V8 §4.22: Multiplier for bomb pot ante (e.g., 2 = 2×BB per player)';
