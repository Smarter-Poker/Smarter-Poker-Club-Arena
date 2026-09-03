-- ═══════════════════════════════════════════════════════════════════════════════
-- Table Templates and SNG Player Count Migration
-- ═══════════════════════════════════════════════════════════════════════════════

-- Table Templates - Store saved table configurations for easy duplication
CREATE TABLE IF NOT EXISTS table_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID REFERENCES clubs(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    game_type VARCHAR(20),
    game_mode VARCHAR(20),
    config JSONB NOT NULL,
    created_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE
);

-- Create index for fast template lookups by club
CREATE INDEX IF NOT EXISTS idx_table_templates_club_id ON table_templates(club_id);
CREATE INDEX IF NOT EXISTS idx_table_templates_created_by ON table_templates(created_by);

-- RLS for table_templates
ALTER TABLE table_templates ENABLE ROW LEVEL SECURITY;

-- Policy: Club members can view templates for their clubs
CREATE POLICY "Members can view club templates" ON table_templates
    FOR SELECT
    USING (
        club_id IN (
            SELECT club_id FROM club_members WHERE user_id = auth.uid()
        )
    );

-- Policy: Club owners/managers can insert templates
CREATE POLICY "Owners can create templates" ON table_templates
    FOR INSERT
    WITH CHECK (
        club_id IN (
            SELECT club_id FROM club_members 
            WHERE user_id = auth.uid() 
            AND role IN ('owner', 'manager', 'admin')
        )
    );

-- Policy: Template creators or club owners can update
CREATE POLICY "Creators can update templates" ON table_templates
    FOR UPDATE
    USING (
        created_by = auth.uid() OR
        club_id IN (
            SELECT club_id FROM club_members 
            WHERE user_id = auth.uid() 
            AND role IN ('owner', 'admin')
        )
    );

-- Policy: Template creators or club owners can delete
CREATE POLICY "Creators can delete templates" ON table_templates
    FOR DELETE
    USING (
        created_by = auth.uid() OR
        club_id IN (
            SELECT club_id FROM club_members 
            WHERE user_id = auth.uid() 
            AND role IN ('owner', 'admin')
        )
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- SNG Player Count and Spins Mode
-- ═══════════════════════════════════════════════════════════════════════════════

-- SNG player count (3, 9, 18, 27, 36, 45, 54, 63, 72, 81, 90, 99)
ALTER TABLE tables ADD COLUMN IF NOT EXISTS sng_player_count INTEGER DEFAULT 9;

-- Is this a Spins game (3-player special mode)
ALTER TABLE tables ADD COLUMN IF NOT EXISTS is_spins BOOLEAN DEFAULT FALSE;

-- Spins multiplier (random prize multiplier: 2x, 5x, 10x, 25x, 100x, etc.)
ALTER TABLE tables ADD COLUMN IF NOT EXISTS spins_multiplier INTEGER;

-- Spins prize pool (calculated from buy-in * multiplier)
ALTER TABLE tables ADD COLUMN IF NOT EXISTS spins_prize_pool DECIMAL(12, 2);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Soft Delete for Tables
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE tables ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE tables ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES profiles(id);

-- Update default queries to exclude deleted tables
CREATE OR REPLACE VIEW active_tables AS
SELECT * FROM tables WHERE is_deleted = FALSE OR is_deleted IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Helper function: Soft delete a table
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION soft_delete_table(table_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_table RECORD;
BEGIN
    -- Get table info
    SELECT * INTO v_table FROM tables WHERE id = table_id;
    
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    
    -- Check if table is in use (has active players)
    IF v_table.current_players > 0 THEN
        RAISE EXCEPTION 'Cannot delete table with active players';
    END IF;
    
    -- Soft delete
    UPDATE tables
    SET 
        is_deleted = TRUE,
        deleted_at = NOW(),
        deleted_by = auth.uid()
    WHERE id = table_id;
    
    RETURN TRUE;
END;
$$;
