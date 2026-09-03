-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831144741; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

SET lock_timeout = '1500ms';
DROP TRIGGER IF EXISTS tournaments_creation_guard ON public.tournaments;
CREATE TRIGGER tournaments_creation_guard
  BEFORE INSERT ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.fn_tournaments_creation_guard();
