-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX: Deduplicate active player count
-- ═══════════════════════════════════════════════════════════════════════════════
-- Bug: Active player count exceeded member count (e.g., 754 active with 326 members).
-- Root cause: COUNT(*) counted all seat rows, including multiple rows per player
-- (orphan seats from disconnects, multi-table players).
-- Fix: COUNT(DISTINCT ts.user_id) ensures each unique player is counted once.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_get_active_player_count(p_club_id UUID)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT COUNT(DISTINCT ts.user_id)
  FROM table_seats ts
  INNER JOIN tables t ON ts.table_id = t.id
  WHERE t.club_id = p_club_id
    AND ts.left_at IS NULL;
$$;

-- Grant access to authenticated and anon roles
GRANT EXECUTE ON FUNCTION fn_get_active_player_count(UUID) TO authenticated, anon;
