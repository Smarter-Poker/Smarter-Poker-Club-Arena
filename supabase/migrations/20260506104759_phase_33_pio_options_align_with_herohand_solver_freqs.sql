-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506104759 "phase_33_pio_options_align_with_herohand_solver_freqs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3a6124180f7e895bb1f4750925a88b9b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 33 fix: ensure fn_pio_options_from_solver helper is persisted in production
-- (the bulk UPDATE ran via execute_sql in batches; this re-records the helper as part of schema_migrations audit trail)
CREATE OR REPLACE FUNCTION fn_pio_options_from_solver(
  p_game_type TEXT, p_stack INT, p_street TEXT, p_board TEXT, p_position TEXT, p_hero TEXT
) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  freqs jsonb;
  hash_with_prefix TEXT := p_street || '_' || p_game_type || '_' || p_position || '_' || p_stack || 'bb_' || p_board;
  hash_no_prefix   TEXT := p_game_type || '_' || p_position || '_' || p_stack || 'bb_' || p_board;
  hash_flop_prefix TEXT := 'flop_' || p_game_type || '_' || p_position || '_' || p_stack || 'bb_' || p_board;
  c_f numeric := 0; b16_f numeric := 0; b45_f numeric := 0; f_f numeric := 0;
  c_i int := 0; b16_i int := 0; b45_i int := 0; f_i int := 0;
  total numeric;
  result jsonb := '[]'::jsonb;
BEGIN
  SELECT strategy_matrix->'frequencies' INTO freqs
  FROM solved_spots_gold
  WHERE scenario_hash IN (hash_with_prefix, hash_no_prefix, hash_flop_prefix)
  LIMIT 1;
  IF freqs IS NULL THEN RETURN NULL; END IF;
  c_f   := COALESCE(NULLIF((freqs->'c'->>p_hero), '')::numeric, 0);
  b16_f := COALESCE(NULLIF((freqs->'b16'->>p_hero), '')::numeric, 0);
  b45_f := COALESCE(NULLIF((freqs->'b45'->>p_hero), '')::numeric, 0);
  f_f   := COALESCE(NULLIF((freqs->'f'->>p_hero), '')::numeric, 0);
  IF c_f < 0 OR c_f > 1.5 THEN c_f := 0; END IF;
  IF b16_f < 0 OR b16_f > 1.5 THEN b16_f := 0; END IF;
  IF b45_f < 0 OR b45_f > 1.5 THEN b45_f := 0; END IF;
  IF f_f < 0 OR f_f > 1.5 THEN f_f := 0; END IF;
  total := c_f + b16_f + b45_f + f_f;
  IF total = 0 THEN RETURN NULL; END IF;
  c_i   := round(100.0 * c_f / total)::int;
  b16_i := round(100.0 * b16_f / total)::int;
  b45_i := round(100.0 * b45_f / total)::int;
  f_i   := round(100.0 * f_f / total)::int;
  IF b16_i > 0 THEN result := result || jsonb_build_object('id','b16','text','Bet 16%','frequency',b16_i); END IF;
  IF c_i   > 0 THEN result := result || jsonb_build_object('id','c','text','Check','frequency',c_i); END IF;
  IF b45_i > 0 THEN result := result || jsonb_build_object('id','b45','text','Bet 45%','frequency',b45_i); END IF;
  IF f_i   > 0 THEN result := result || jsonb_build_object('id','f','text','Fold','frequency',f_i); END IF;
  IF jsonb_array_length(result) < 2 THEN RETURN NULL; END IF;
  RETURN result;
END;
$$;
