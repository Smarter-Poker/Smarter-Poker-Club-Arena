-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827215810; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

DO $publication$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'user_theme_settings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_theme_settings;
  END IF;
END
$publication$;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'user_theme_settings'
  ) THEN
    RAISE EXCEPTION 'user_theme_settings is not in supabase_realtime';
  END IF;
END
$verify$;
