-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828232521; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '',
ADD COLUMN IF NOT EXISTS player_tags TEXT[] DEFAULT '{}';
