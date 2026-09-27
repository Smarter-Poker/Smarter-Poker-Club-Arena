-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819213919 "ca_player_stats_full_rpc_v8_index_backed_hand_selection"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ae70ec1bdcb06a93f5c77b2a827eac02 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v8: select the player's most recent hands from ca_hand_player_idx instead of
-- a JSONB containment scan over hand_history. The containment scan had to
-- materialise every hand a player appears in before ORDER BY/LIMIT could apply
-- (measured 71,238 rows / 35,807 heap blocks / ~12s for an active account),
-- which the 8s `authenticated` statement_timeout cancelled outright.
-- Falls back to the old scan only for players with fewer than the cap indexed
-- (necessarily a small match set) while the backfill is still descending.
-- Mirrors repo file 20260819_ca_player_stats_full_rpc.sql.
DO $mig$
DECLARE
  src text;
  head text := $h$DECLARE
  c_cap  constant int := 1500;
  v_ids  uuid[];
  v_floor timestamptz;
  v_need int;
BEGIN
  SELECT array_agg(hand_id ORDER BY created_at DESC)
  INTO v_ids
  FROM (SELECT hand_id, created_at FROM ca_hand_player_idx
        WHERE user_id = p_user ORDER BY created_at DESC LIMIT c_cap) q;

  v_need := c_cap - coalesce(array_length(v_ids, 1), 0);

  IF v_need > 0 THEN
    SELECT idx_floor INTO v_floor FROM ca_hand_player_idx_state WHERE id;
    IF v_floor IS NOT NULL THEN
      SELECT coalesce(v_ids, '{}'::uuid[]) || coalesce(array_agg(id ORDER BY created_at DESC), '{}'::uuid[])
      INTO v_ids
      FROM (SELECT h.id, h.created_at FROM hand_history h
            WHERE h.created_at < v_floor
              AND h.players @> jsonb_build_array(jsonb_build_object('userId', p_user::text))
            ORDER BY h.created_at DESC LIMIT v_need) q2;
    END IF;
  END IF;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    v_ids := '{}'::uuid[];
  END IF;

RETURN (
WITH my_hands AS ($h$;
BEGIN
  src := pg_get_functiondef('public.ca_player_stats_full(uuid)'::regprocedure);

  IF position(' LANGUAGE sql' IN src) = 0 THEN RAISE EXCEPTION 'expected LANGUAGE sql'; END IF;
  IF position('WITH my_hands AS (' IN src) = 0 THEN RAISE EXCEPTION 'my_hands CTE not found'; END IF;
  IF position('WHERE h.players @>' IN src) = 0 THEN RAISE EXCEPTION 'containment predicate not found'; END IF;

  src := replace(src, ' LANGUAGE sql', ' LANGUAGE plpgsql');
  src := replace(src, 'WITH my_hands AS (', head);

  -- collapse the old scan (predicate + ORDER BY + comment block + LIMIT) down to
  -- an id lookup against the array chosen above
  src := regexp_replace(
           src,
           'FROM hand_history h\s+WHERE h\.players @> jsonb_build_array\(jsonb_build_object\(''userId'', p_user::text\)\).*?LIMIT 1500\s*\),',
           E'FROM hand_history h\n  WHERE h.id = ANY(v_ids)\n),',
           '');

  IF position('LIMIT 1500' IN src) <> 0 THEN RAISE EXCEPTION 'old LIMIT block survived the rewrite'; END IF;

  -- close the plpgsql wrapper
  IF position(E'\n);\n$function$' IN src) = 0 THEN RAISE EXCEPTION 'function tail not in expected shape'; END IF;
  src := replace(src, E'\n);\n$function$', E'\n)\n);\nEND;\n$function$');

  EXECUTE src;
END $mig$;
