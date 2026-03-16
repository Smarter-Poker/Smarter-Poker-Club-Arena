-- ═══════════════════════════════════════════════════════════════════════════════
-- BATCH CLUB MEMBER COUNTS — Grouped COUNT RPC
-- ═══════════════════════════════════════════════════════════════════════════════
-- Returns {club_id, member_count} pairs for a set of club IDs.
-- Replaces N-row client-side counting with a single GROUP BY query.
-- ═══════════════════════════════════════════════════════════════════════════════

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
  GROUP BY cm.club_id;
$$;

GRANT EXECUTE ON FUNCTION fn_batch_club_member_counts(UUID[]) TO authenticated, anon;
