-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: Atomic increment_table_players RPC
-- ═══════════════════════════════════════════════════════════════════════════════
-- Atomically increments current_players count on a table to prevent race
-- conditions during simultaneous buy-ins.

CREATE OR REPLACE FUNCTION increment_table_players(p_table_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE tables
  SET current_players = current_players + 1
  WHERE id = p_table_id;
END;
$$;

-- Grant access to authenticated users
GRANT EXECUTE ON FUNCTION increment_table_players(UUID) TO authenticated;
