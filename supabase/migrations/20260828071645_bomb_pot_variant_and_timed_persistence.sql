-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828071645; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS bomb_pot_variant text NULL,
  ADD COLUMN IF NOT EXISTS bomb_pot_next_due_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tables_bomb_pot_variant_check'
  ) THEN
    ALTER TABLE public.tables
      ADD CONSTRAINT tables_bomb_pot_variant_check
      CHECK (bomb_pot_variant IS NULL OR bomb_pot_variant IN ('nlh', 'plo4', 'plo5', 'plo6'));
  END IF;
END $$;

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

  IF v_def LIKE '%bomb_pot_variant%' THEN
    RETURN;
  END IF;

  v_def := replace(
    v_def,
    'bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds,',
    'bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds, bomb_pot_variant,'
  );

  IF v_def NOT LIKE '%bomb_pot_variant%' THEN
    RAISE EXCEPTION 'get_club_home tables SELECT has been reshaped — splice point not found; extend it by hand';
  END IF;

  EXECUTE v_def;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables'
      AND column_name = 'bomb_pot_variant' AND data_type = 'text'
  ) THEN
    RAISE EXCEPTION 'assertion failed: tables.bomb_pot_variant missing or wrong type';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tables'
      AND column_name = 'bomb_pot_next_due_at'
      AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'assertion failed: tables.bomb_pot_next_due_at missing or wrong type';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'get_club_home' AND n.nspname = 'public'
      AND pg_get_functiondef(p.oid) LIKE '%bomb_pot_variant%'
  ) THEN
    RAISE EXCEPTION 'assertion failed: get_club_home does not return bomb_pot_variant';
  END IF;
END $$;
