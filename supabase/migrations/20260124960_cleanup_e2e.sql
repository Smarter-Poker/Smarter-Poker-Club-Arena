-- ═══════════════════════════════════════════════════════════════════════════════
-- 🧹 CLEANUP E2E TEST DATA
-- ═══════════════════════════════════════════════════════════════════════════════

-- Remove test clubs created during verification
DELETE FROM club_members WHERE club_id IN (
    SELECT id FROM clubs 
    WHERE name ILIKE '%e2e%' 
    OR name ILIKE '%test%'
);

DELETE FROM clubs 
WHERE name ILIKE '%e2e%' 
OR name ILIKE '%test%';

DO $$ BEGIN RAISE NOTICE '🧹 E2E TEST DATA CLEANED'; END $$;
