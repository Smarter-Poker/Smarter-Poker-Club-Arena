-- ═══════════════════════════════════════════════════════════════════════════════
-- MEMBER COUNT HARDENING — Trigger UPDATE + Composite Index
-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Add UPDATE event to trigger (handles member status changes like bans)
-- 2. Add composite index for filtered COUNT queries
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Recreate trigger with UPDATE event (idempotent via DROP IF EXISTS)
DROP TRIGGER IF EXISTS trg_sync_club_member_count ON club_members;

CREATE TRIGGER trg_sync_club_member_count
  AFTER INSERT OR UPDATE OR DELETE ON club_members
  FOR EACH ROW
  EXECUTE FUNCTION fn_sync_club_member_count();

-- 2. Composite index for COUNT queries that filter by status
CREATE INDEX IF NOT EXISTS idx_club_members_club_status
  ON club_members(club_id, status);
