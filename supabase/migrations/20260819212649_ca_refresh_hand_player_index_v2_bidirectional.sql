-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819212649 "ca_refresh_hand_player_index_v2_bidirectional"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0e8be33de25c0a6bcc0141e1fa60ac77 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DROP FUNCTION IF EXISTS public.ca_refresh_hand_player_index(int);

CREATE FUNCTION public.ca_refresh_hand_player_index(p_max_hands int DEFAULT 50000)
RETURNS TABLE (hands_indexed int, rows_added int, floor_at timestamptz, ceil_at timestamptz, complete boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10min'
AS $fn$
DECLARE
  f timestamptz; c timestamptz; done boolean;
  new_floor timestamptz; new_ceil timestamptz;
  n_hands int := 0; n_rows int := 0; k int; kr int;
BEGIN
  SELECT idx_floor, idx_ceil, backfill_complete INTO f, c, done
  FROM ca_hand_player_idx_state WHERE id;
  IF f IS NULL THEN f := now(); END IF;
  IF c IS NULL THEN c := now(); END IF;

  -- 1) FORWARD TAIL: hands newer than the ceiling (cheap; uses created_at idx)
  SELECT max(created_at) INTO new_ceil FROM hand_history WHERE created_at > c;
  IF new_ceil IS NOT NULL THEN
    WITH src AS (
      SELECT h.id, h.created_at, h.players FROM hand_history h
      WHERE h.created_at > c AND h.created_at <= new_ceil
    ), expanded AS (
      SELECT DISTINCT ((pl->>'userId')::uuid) AS user_id, s.created_at, s.id AS hand_id
      FROM src s, jsonb_array_elements(s.players) pl
      WHERE pl->>'userId' ~ '^[0-9a-fA-F-]{36}$'
    ), ins AS (
      INSERT INTO ca_hand_player_idx (user_id, created_at, hand_id)
      SELECT user_id, created_at, hand_id FROM expanded
      ON CONFLICT DO NOTHING RETURNING 1
    )
    SELECT (SELECT count(*) FROM src)::int, (SELECT count(*) FROM ins)::int INTO k, kr;
    n_hands := n_hands + coalesce(k,0); n_rows := n_rows + coalesce(kr,0);
    c := new_ceil;
  END IF;

  -- 2) BACKWARD BACKFILL: next batch strictly below the floor
  IF NOT done THEN
    SELECT min(created_at) INTO new_floor
    FROM (SELECT created_at FROM hand_history
          WHERE created_at < f ORDER BY created_at DESC LIMIT p_max_hands) q;
    IF new_floor IS NULL THEN
      done := true;
    ELSE
      WITH src AS (
        SELECT h.id, h.created_at, h.players FROM hand_history h
        WHERE h.created_at < f AND h.created_at >= new_floor
      ), expanded AS (
        SELECT DISTINCT ((pl->>'userId')::uuid) AS user_id, s.created_at, s.id AS hand_id
        FROM src s, jsonb_array_elements(s.players) pl
        WHERE pl->>'userId' ~ '^[0-9a-fA-F-]{36}$'
      ), ins AS (
        INSERT INTO ca_hand_player_idx (user_id, created_at, hand_id)
        SELECT user_id, created_at, hand_id FROM expanded
        ON CONFLICT DO NOTHING RETURNING 1
      )
      SELECT (SELECT count(*) FROM src)::int, (SELECT count(*) FROM ins)::int INTO k, kr;
      n_hands := n_hands + coalesce(k,0); n_rows := n_rows + coalesce(kr,0);
      f := new_floor;
      IF NOT EXISTS (SELECT 1 FROM hand_history WHERE created_at < f) THEN done := true; END IF;
    END IF;
  END IF;

  UPDATE ca_hand_player_idx_state
  SET idx_floor = f, idx_ceil = c, backfill_complete = done,
      rows_indexed = rows_indexed + n_rows, updated_at = now()
  WHERE id;

  RETURN QUERY SELECT n_hands, n_rows, f, c, done;
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_refresh_hand_player_index(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_refresh_hand_player_index(int) FROM anon;
GRANT EXECUTE ON FUNCTION public.ca_refresh_hand_player_index(int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ca_refresh_hand_player_index(int) TO service_role;
