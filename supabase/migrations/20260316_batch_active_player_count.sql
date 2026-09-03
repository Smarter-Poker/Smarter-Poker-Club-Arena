-- ═══════════════════════════════════════════════════════════════════════════════
-- BATCH ACTIVE PLAYER COUNT — Single RPC for efficient seat counting
-- ═══════════════════════════════════════════════════════════════════════════════
-- Replaces the 2-query pattern (tables → table_seats) with a single RPC call.
-- Used by HomePage to display active players for Shark Club.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_get_active_player_count(p_club_id UUID)
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT COUNT(*)
  FROM table_seats ts
  INNER JOIN tables t ON ts.table_id = t.id
  WHERE t.club_id = p_club_id
    AND ts.left_at IS NULL;
$$;

-- Grant access to authenticated and anon roles
GRANT EXECUTE ON FUNCTION fn_get_active_player_count(UUID) TO authenticated, anon;
