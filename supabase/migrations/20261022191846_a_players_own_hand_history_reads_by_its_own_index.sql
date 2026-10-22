-- 20261022191846_a_players_own_hand_history_reads_by_its_own_index.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- The cross-table Hand History page timed out (57014, ~5 an hour) for every
-- player with fewer retained hands than the page asked for. The client read
--   hand_history?players=cs.[{"userId":...}]&order=hand_number.desc&limit=25
-- and, under the hand_history_authenticated_select RLS policy, the planner
-- chose "Index Scan Backward using idx_hand_history_hand_number_lookup" and
-- filtered every row of the table by the policy's players @> test: for a
-- player whose 25th hand does not exist it walks the whole table and dies at
-- the statement timeout (measured as role authenticated: TIMEOUT after 30 s
-- for a player with 0 hands). The same filter as superuser uses the GIN index
-- and returns in milliseconds. The client's seed/floor optimization only
-- applied when the player had enough indexed hands, so it never helped the
-- exact players who hit this.
--
-- The fix is the read itself, chosen by what the player actually has:
--   1. Enough owned hands in ca_hand_player_idx -> their hand_numbers give a
--      floor, and the page is a bounded range read (the existing client
--      logic, now one call). Measured: 5 ms + 11 ms for a 57k-hand player.
--   2. Otherwise the player's whole retained history is small, so it is read
--      completely through the players GIN index (capped at 2000) and sorted.
--      Measured: 4 ms for 0 hands, 252 ms for 339 hands.
--   3. Only a player with more than 2000 retained but unindexed hands falls
--      back to the original ordered read, which finds 25 such rows quickly.
-- SECURITY INVOKER: hand_history and ca_hand_player_idx RLS remain the
-- authorization door. Order is hand_number DESC (nulls first), exactly the
-- PostgREST order the page used, with id as a stable tiebreak.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_player_hand_history_page_ids(
  p_user_id uuid,
  p_limit integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(id uuid, hand_number integer)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_need   integer;
  v_key    jsonb;
  v_floor  integer;
  v_seeds  integer;
  v_cap    constant integer := 2000;
  a_ids    uuid[];
  a_nums   integer[];
  v_n      integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;
  v_need := v_limit + v_offset;
  v_key := jsonb_build_array(jsonb_build_object('userId', p_user_id::text));

  -- 1. Enough owned, retained, numbered hands: a bounded range read.
  SELECT min(h.hand_number), count(DISTINCT h.hand_number)
    INTO v_floor, v_seeds
    FROM (SELECT i.hand_id
            FROM public.ca_hand_player_idx i
           WHERE i.user_id = p_user_id
           ORDER BY i.created_at DESC, i.hand_id
           LIMIT v_need) s
    JOIN public.hand_history h ON h.id = s.hand_id
   WHERE h.players @> v_key
     AND h.hand_number IS NOT NULL;

  IF v_seeds >= v_need THEN
    RETURN QUERY
      SELECT h.id, h.hand_number
        FROM public.hand_history h
       WHERE h.players @> v_key
         AND (h.hand_number >= v_floor OR h.hand_number IS NULL)
       ORDER BY h.hand_number DESC, h.id
      OFFSET v_offset
       LIMIT v_limit;
    RETURN;
  END IF;

  -- 2. A small history: read all of it through the GIN index.
  SELECT array_agg(s.id), array_agg(s.hand_number), count(*)
    INTO a_ids, a_nums, v_n
    FROM (SELECT h.id, h.hand_number
            FROM public.hand_history h
           WHERE h.players @> v_key
           LIMIT v_cap + 1) s;

  IF v_n <= v_cap THEN
    RETURN QUERY
      SELECT u.id, u.hand_number
        FROM unnest(a_ids, a_nums) AS u(id, hand_number)
       ORDER BY u.hand_number DESC, u.id
      OFFSET v_offset
       LIMIT v_limit;
    RETURN;
  END IF;

  -- 3. Many hands the index does not know: dense enough for the ordered read.
  RETURN QUERY
    SELECT h.id, h.hand_number
      FROM public.hand_history h
     WHERE h.players @> v_key
     ORDER BY h.hand_number DESC, h.id
    OFFSET v_offset
     LIMIT v_limit;
END;
$$;

COMMENT ON FUNCTION public.fn_player_hand_history_page_ids(uuid, integer, integer) IS
  'One page of a player''s hand ids in play order (hand_number DESC). Security invoker: RLS on hand_history and ca_hand_player_idx is the door. Chooses an index-bounded read so a player with few hands never walks the table. 2026-10-22.';

REVOKE ALL ON FUNCTION public.fn_player_hand_history_page_ids(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_player_hand_history_page_ids(uuid, integer, integer) TO authenticated, service_role;

COMMIT;
