-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825223908; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- SHOWDOWN POLISH 2026-08-25: persist what the table actually SAW at showdown.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'hand_history'
      AND column_name = 'showdown'
  ) THEN
    ALTER TABLE public.hand_history ADD COLUMN showdown jsonb;
    COMMENT ON COLUMN public.hand_history.showdown IS
      'Showdown reveal record: [{user_id, seat, reveal_order, mucked, hand_name?, hand_description?}]. Mucked entries carry no hand identity. NULL = no showdown or predates 2026-08-25.';
  END IF;
END $$;
