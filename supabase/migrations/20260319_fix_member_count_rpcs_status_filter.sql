-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: Server-side RPCs — Add status filter to match client-side queries
-- ═══════════════════════════════════════════════════════════════════════════════
-- Both fn_get_club_member_count and fn_batch_club_member_counts were counting
-- ALL members (including banned, pending, left). The trigger was already fixed
-- in 20260319, but these RPCs were missed. Now they match the client-side
-- .in('status', ['active', 'approved']) filter.
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. FIX fn_get_club_member_count — add status filter
CREATE OR REPLACE FUNCTION fn_get_club_member_count(p_club_id UUID)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT COUNT(*)
  FROM club_members
  WHERE club_id = p_club_id
    AND (status IS NULL OR status IN ('active', 'approved'));
$$;

-- 2. FIX fn_batch_club_member_counts — add status filter
CREATE OR REPLACE FUNCTION fn_batch_club_member_counts(p_club_ids UUID[])
RETURNS TABLE(club_id UUID, member_count BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT cm.club_id, COUNT(*) AS member_count
  FROM club_members cm
  WHERE cm.club_id = ANY(p_club_ids)
    AND (cm.status IS NULL OR cm.status IN ('active', 'approved'))
  GROUP BY cm.club_id;
$$;

-- Re-grant permissions
GRANT EXECUTE ON FUNCTION fn_get_club_member_count(UUID) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION fn_batch_club_member_counts(UUID[]) TO authenticated, anon;
