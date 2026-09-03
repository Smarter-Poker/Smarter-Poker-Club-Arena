-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: tables_status_check constraint - Add 'active' status
-- ═══════════════════════════════════════════════════════════════════════════════
-- The constraint only allows ('waiting', 'running', 'paused', 'closed')
-- But the app sends 'active' when creating a table via "Start" button
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop the existing constraint
ALTER TABLE tables DROP CONSTRAINT IF EXISTS tables_status_check;

-- Add updated constraint with 'active' status included
ALTER TABLE tables ADD CONSTRAINT tables_status_check 
    CHECK (status IN ('waiting', 'active', 'running', 'paused', 'closed'));

-- Success message
DO $$ 
BEGIN 
    RAISE NOTICE '✓ tables_status_check constraint updated to include active status';
END $$;
