-- ═══════════════════════════════════════════════════════════════════════════════
-- 🧹 CLEAN START - DELETE ALL CLUBS AND MEMBERSHIPS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Delete all club members first (FK constraint)
DELETE FROM club_members;

-- Delete all clubs
DELETE FROM clubs;

DO $$ BEGIN RAISE NOTICE '🧹 ALL CLUBS AND MEMBERSHIPS DELETED - CLEAN START'; END $$;
