-- Batched equivalent of fn_get_active_player_count: returns the live active-player
-- count per club in ONE call, so the hot HomePage stops firing one RPC per club
-- (it previously fanned out N parallel RPCs across a user's clubs / a union's
-- member clubs). Same filter as the single-club version; clubs with 0 active
-- players are simply absent from the result (callers default missing => 0).
--
-- Applied to production via Supabase MCP on 2026-07-29; committed for migration
-- history + phantom-ref CI manifest parity.
CREATE OR REPLACE FUNCTION public.fn_batch_active_player_counts(p_club_ids uuid[])
RETURNS TABLE(club_id uuid, active_count bigint)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT t.club_id, COUNT(DISTINCT ts.user_id) AS active_count
  FROM table_seats ts
  INNER JOIN tables t ON ts.table_id = t.id
  WHERE t.club_id = ANY(p_club_ids)
    AND ts.left_at IS NULL
    AND COALESCE(ts.is_away, false) = false
    AND lower(COALESCE(t.status,'')) NOT IN ('closed','completed','cancelled','finished')
  GROUP BY t.club_id;
$$;

GRANT EXECUTE ON FUNCTION public.fn_batch_active_player_counts(uuid[]) TO authenticated, service_role, anon;
