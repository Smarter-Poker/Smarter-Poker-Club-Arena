-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828030250; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'get_club_home' AND n.nspname = 'public';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'get_club_home not found';
  END IF;

  IF v_def LIKE '%bomb_pot_board_count%' THEN
    RETURN;
  END IF;

  v_def := replace(
    v_def,
    'bomb_pot_enabled, bomb_pot_frequency, bomb_pot_double_board,',
    'bomb_pot_enabled, bomb_pot_frequency, bomb_pot_double_board, bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds,'
  );

  IF v_def NOT LIKE '%bomb_pot_board_count%' THEN
    RAISE EXCEPTION 'get_club_home tables SELECT has been reshaped — splice point not found; extend it by hand';
  END IF;

  EXECUTE v_def;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'get_club_home' AND n.nspname = 'public'
      AND pg_get_functiondef(p.oid) LIKE '%bomb_pot_trigger_mode%'
  ) THEN
    RAISE EXCEPTION 'assertion failed: get_club_home does not return bomb_pot_trigger_mode';
  END IF;
END $$;
