-- ═══════════════════════════════════════════════════════════════════════════════
-- 🧹 CLEANUP TEST DATA
-- ═══════════════════════════════════════════════════════════════════════════════

-- Remove any test clubs and their members
DELETE FROM club_members WHERE club_id IN (
    SELECT id FROM clubs 
    WHERE name ILIKE '%test%' 
    OR name ILIKE '%123%'
    OR name ILIKE '%verification%'
    OR name ILIKE '%final%'
);

DELETE FROM clubs 
WHERE name ILIKE '%test%' 
OR name ILIKE '%123%'
OR name ILIKE '%verification%'
OR name ILIKE '%final%';

DO $$ BEGIN RAISE NOTICE '🧹 TEST DATA CLEANED UP'; END $$;
