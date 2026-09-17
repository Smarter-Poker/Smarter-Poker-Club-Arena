-- Read-only observer; uses the existing financial observer unchanged.
CREATE FUNCTION pg_temp.spin_history_retention_state(p_removed uuid[] DEFAULT '{}'::uuid[])
RETURNS jsonb LANGUAGE plpgsql AS $observe$
DECLARE v_state jsonb := pg_temp.spin_expiry_business_state();
        v_name text; v_rows jsonb;
BEGIN
  IF p_removed IS NULL OR array_position(p_removed,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'spin retention qualification: removed-ID set is unknown';
  END IF;
  -- Expected removals apply only to the four tables the genuine pruner deletes.
  v_state:=jsonb_set(v_state,'{hand_history}',COALESCE((
    SELECT jsonb_agg(x ORDER BY x::text)
      FROM jsonb_array_elements(v_state->'hand_history') x
     WHERE NOT COALESCE((x->>'id')::uuid=ANY(p_removed),false)),'[]'::jsonb));
  FOREACH v_name IN ARRAY ARRAY['rake_attributions','ca_hand_player_idx',
    'hand_atomic_commits','hand_projection_outbox','tournament_knockout_candidates',
    'tournament_terminal_settlements','hand_history_retention_policy','profiles'] LOOP
    EXECUTE format('SELECT COALESCE(jsonb_agg(r ORDER BY r::text),''[]''::jsonb)
      FROM (SELECT to_jsonb(x) r FROM public.%I x LIMIT 1001) bounded',v_name) INTO v_rows;
    IF jsonb_array_length(v_rows)>1000 THEN
      RAISE EXCEPTION 'spin retention qualification: observer relation bound exceeded %',v_name;
    END IF;
    IF v_name=ANY(ARRAY['rake_attributions','ca_hand_player_idx','hand_atomic_commits']) THEN
      SELECT COALESCE(jsonb_agg(x ORDER BY x::text),'[]'::jsonb) INTO v_rows
        FROM jsonb_array_elements(v_rows) x
       WHERE NOT COALESCE((x->>'hand_id')::uuid=ANY(p_removed),false);
    END IF;
    v_state:=v_state||jsonb_build_object(v_name,v_rows);
  END LOOP;
  IF octet_length(v_state::text)>2097152 THEN
    RAISE EXCEPTION 'spin retention qualification: observer exceeds 2 MiB';
  END IF;
  RETURN v_state;
END;
$observe$;
