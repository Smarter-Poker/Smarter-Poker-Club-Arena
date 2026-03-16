-- ═══════════════════════════════════════════════════════════════════════════════
-- LIVE MEMBER COUNT — RPC + Auto-Sync Trigger
-- ═══════════════════════════════════════════════════════════════════════════════
-- Fixes the stale clubs.member_count bug where Shark Club shows 1 instead of 300+.
-- Two mechanisms:
--   1. RPC fn_get_club_member_count: SECURITY DEFINER live COUNT(*) bypassing RLS
--   2. Trigger trg_sync_club_member_count: auto-sync on INSERT/DELETE
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. SECURITY DEFINER RPC — returns exact live member count for any club
--    Bypasses RLS so non-members can see public club stats.
CREATE OR REPLACE FUNCTION fn_get_club_member_count(p_club_id UUID)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT COUNT(*)
  FROM club_members
  WHERE club_id = p_club_id;
$$;

-- Grant access to authenticated and anon roles
GRANT EXECUTE ON FUNCTION fn_get_club_member_count(UUID) TO authenticated, anon;

-- 2. Trigger function — auto-sync clubs.member_count on every INSERT/DELETE
CREATE OR REPLACE FUNCTION fn_sync_club_member_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  target_club_id UUID;
BEGIN
  -- Determine which club_id was affected
  IF TG_OP = 'DELETE' THEN
    target_club_id := OLD.club_id;
  ELSE
    target_club_id := NEW.club_id;
  END IF;

  -- Atomic recount + update
  UPDATE clubs
  SET member_count = (
    SELECT COUNT(*)
    FROM club_members
    WHERE club_id = target_club_id
  )
  WHERE id = target_club_id;

  -- For DELETE, return OLD; for INSERT/UPDATE, return NEW
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Drop existing trigger if any (idempotent)
DROP TRIGGER IF EXISTS trg_sync_club_member_count ON club_members;

-- Create trigger on INSERT and DELETE
CREATE TRIGGER trg_sync_club_member_count
  AFTER INSERT OR DELETE ON club_members
  FOR EACH ROW
  EXECUTE FUNCTION fn_sync_club_member_count();
