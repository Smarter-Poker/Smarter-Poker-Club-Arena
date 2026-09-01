-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826192546; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- hand_history.rit_boards — Run It Twice boards, first-class (2026-08-26)
-- Boards 2..N in run order (JSONB array of arrays of engine card strings).
-- NULL on single-run hands so historical rows look identical. Board 1 stays
-- community_cards. Writer: server logHandHistory. Tier 2, additive.
-- ROLLBACK: ALTER TABLE public.hand_history DROP COLUMN IF EXISTS rit_boards;

ALTER TABLE public.hand_history
  ADD COLUMN IF NOT EXISTS rit_boards jsonb;

COMMENT ON COLUMN public.hand_history.rit_boards IS
  'Run It Twice boards 2..N in run order (JSONB array of arrays of engine card strings, e.g. [["Ahearts","Kdiamonds",...],[...]]). NULL on single-run hands. Board 1 remains community_cards. Added 2026-08-26; boards 2..N also exist as rit_board_N: pseudo-actions in `actions` for rows that predate this column.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'hand_history'
      AND column_name = 'rit_boards'
      AND data_type = 'jsonb'
  ) THEN
    RAISE EXCEPTION 'hand_history.rit_boards was not created as jsonb';
  END IF;
END $$;
