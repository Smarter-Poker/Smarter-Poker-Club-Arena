-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827050241; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_never_pko_and_mystery
  CHECK (NOT (COALESCE(is_pko, false) AND COALESCE(is_mystery_bounty, false)));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.tournaments'::regclass
       AND conname = 'tournaments_never_pko_and_mystery'
       AND convalidated
  ) THEN
    RAISE EXCEPTION 'tournaments_never_pko_and_mystery missing or NOT VALID — migration did not take';
  END IF;
END $$;
