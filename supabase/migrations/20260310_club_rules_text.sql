-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 23: Add rules_text column to clubs table
-- ═══════════════════════════════════════════════════════════════════════════
-- Stores admin-editable club rules and guidelines (ClubRulesPage.tsx)

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'clubs' AND column_name = 'rules_text'
    ) THEN
        ALTER TABLE clubs ADD COLUMN rules_text TEXT DEFAULT '';
    END IF;
END $$;
