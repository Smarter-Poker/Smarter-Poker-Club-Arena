-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260729181849 "20260729_tournament_templates_venue_id_int_and_session_pause"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8929579f951719246c28a3f034d4810d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- commander_tournament_templates.venue_id was uuid while commander_tournaments.venue_id
-- and staff venue ids are integer, so template list/create never matched a venue and the
-- DB-backed templates feature was dead. Table is empty (0 rows) so the type change is safe.
ALTER TABLE public.commander_tournament_templates
  ALTER COLUMN venue_id TYPE integer USING NULL::integer;

-- Pause/meal-break billing for table sessions: today pause only sets status and the server
-- keeps counting down, so time_remaining jumps on the next poll. Track paused time so the
-- time math can subtract it.
ALTER TABLE public.commander_table_sessions
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS total_paused_minutes integer DEFAULT 0;
