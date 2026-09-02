-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826232514; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

ALTER TABLE public.user_table_settings DROP COLUMN IF EXISTS button_color, ADD COLUMN IF NOT EXISTS blue_buttons_enabled BOOLEAN NOT NULL DEFAULT FALSE;
