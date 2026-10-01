-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819214029 "ca_player_stats_full_rpc_v9_forward_tail"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a56e92aa4fe767209673628e5bba4177 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v9: v8 read only ca_hand_player_idx, so hands played since the last index
-- refresh were invisible — exactly the hands a player is most likely checking
-- on right after a session. Union a bounded live window above idx_ceil.
-- Mirrors repo file 20260819_ca_player_stats_full_rpc.sql.
DO $mig$
DECLARE
  src text;
  anchor text := $a$  v_need := c_cap - coalesce(array_length(v_ids, 1), 0);$a$;
  tail text := $t$  SELECT idx_ceil INTO v_ceil FROM ca_hand_player_idx_state WHERE id;
  IF v_ceil IS NOT NULL THEN
    SELECT coalesce(array_agg(id ORDER BY created_at DESC), '{}'::uuid[]) || coalesce(v_ids, '{}'::uuid[])
    INTO v_ids
    FROM (SELECT h.id, h.created_at FROM hand_history h
          WHERE h.created_at > v_ceil
            AND h.players @> jsonb_build_array(jsonb_build_object('userId', p_user::text))
          ORDER BY h.created_at DESC LIMIT c_cap) q0;

    IF coalesce(array_length(v_ids, 1), 0) > c_cap THEN
      v_ids := v_ids[1:c_cap];
    END IF;
  END IF;

  v_need := c_cap - coalesce(array_length(v_ids, 1), 0);$t$;
BEGIN
  src := pg_get_functiondef('public.ca_player_stats_full(uuid)'::regprocedure);
  IF position(anchor IN src) = 0 THEN RAISE EXCEPTION 'v_need anchor not found'; END IF;
  IF position('v_floor timestamptz;' IN src) = 0 THEN RAISE EXCEPTION 'declare block not found'; END IF;

  src := replace(src, 'v_floor timestamptz;', E'v_floor timestamptz;\n  v_ceil  timestamptz;');
  src := replace(src, anchor, tail);
  EXECUTE src;
END $mig$;
