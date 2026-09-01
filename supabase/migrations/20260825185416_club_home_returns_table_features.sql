-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825185416; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $migration$
DECLARE
  v_def  text;
  v_old  text := 'small_blind, big_blind, min_buy_in, max_buy_in, settings, created_at';
  v_new  text := 'small_blind, big_blind, min_buy_in, max_buy_in, settings, created_at, '
                 || 'run_it_twice, run_it_twice_enabled, allow_run_it_twice, insurance_enabled, '
                 || 'straddle_enabled, straddle_type, auto_utg_straddle, bomb_pot_enabled, '
                 || 'bomb_pot_frequency, bomb_pot_double_board, ante_enabled, ante, '
                 || 'seven_deuce_enabled, seven_deuce_amount, time_bank_enabled, all_in_or_fold';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_club_home';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_club_home does not exist - refusing to guess';
  END IF;

  IF position('insurance_enabled' IN v_def) > 0 THEN
    RAISE NOTICE 'get_club_home already returns the feature columns; nothing to do';
    RETURN;
  END IF;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION
      'get_club_home no longer contains the tables projection this migration edits. Widen it by hand rather than letting this rewrite guess.';
  END IF;

  v_def := replace(v_def, v_old, v_new);
  EXECUTE v_def;
END
$migration$;

DO $verify$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_club_home';
  IF position('insurance_enabled' IN v_def) = 0
     OR position('run_it_twice' IN v_def) = 0
     OR position('bomb_pot_enabled' IN v_def) = 0 THEN
    RAISE EXCEPTION 'get_club_home did not pick up the feature columns';
  END IF;
END
$verify$;
