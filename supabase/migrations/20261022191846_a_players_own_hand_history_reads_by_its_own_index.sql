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
