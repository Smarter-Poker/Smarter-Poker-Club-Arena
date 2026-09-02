-- Table artwork changes must reach the same user's other devices immediately.
-- The client subscribes with user_id=eq.<auth.uid()> and RLS permits only the
-- owner's rows, but postgres_changes cannot emit at all until the table is in
-- Supabase's realtime publication. Production was checked before this
-- migration: profiles and user_table_settings were present; this table was not.

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
