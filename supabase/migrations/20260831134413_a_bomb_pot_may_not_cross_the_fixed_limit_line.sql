-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831134413; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.tables
   WHERE bomb_pot_variant IS NOT NULL
     AND ( bomb_pot_variant NOT IN ('nlh','plo4','plo5','plo6','flh','flo8')
        OR (lower(coalesce(game_variant,'nlh')) IN ('flh','flo8'))
           IS DISTINCT FROM (bomb_pot_variant IN ('flh','flo8')) );
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'refusing to add the constraint: % existing rows carry a bomb pot that crosses the fixed-limit line or is off the whitelist',
      v_bad;
  END IF;
END $$;

ALTER TABLE public.tables
  DROP CONSTRAINT IF EXISTS tables_bomb_pot_variant_check;

ALTER TABLE public.tables
  ADD CONSTRAINT tables_bomb_pot_variant_check
  CHECK (
    bomb_pot_variant IS NULL
    OR (
      bomb_pot_variant IN ('nlh', 'plo4', 'plo5', 'plo6', 'flh', 'flo8')
      AND (lower(coalesce(game_variant, 'nlh')) IN ('flh', 'flo8'))
          = (bomb_pot_variant IN ('flh', 'flo8'))
    )
  );

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.tables'::regclass
     AND conname = 'tables_bomb_pot_variant_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'tables_bomb_pot_variant_check is missing after the ALTER';
  END IF;
  IF position('game_variant' in v_def) = 0 THEN
    RAISE EXCEPTION 'the constraint is still single-column: %', v_def;
  END IF;
  IF position('flo8' in v_def) = 0 THEN
    RAISE EXCEPTION 'the constraint does not know the fixed-limit variants: %', v_def;
  END IF;
END $$;
