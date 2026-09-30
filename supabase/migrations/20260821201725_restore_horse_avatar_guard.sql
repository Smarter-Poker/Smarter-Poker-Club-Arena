-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821201725 "restore_horse_avatar_guard"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d5c4986f911794f56af0764354ae5c65 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Restore trg_guard_horse_avatar, retired earlier today.
--
-- I dropped it to move horses off their portraits in profiles.avatar_url. That
-- plan is wrong: avatar_url is the SOCIAL MEDIA photo and stays exactly as it
-- is. The Club Arena avatar becomes its own column in the next migration.
--
-- So the guard's purpose is intact and it goes back, unchanged.

CREATE TRIGGER trg_guard_horse_avatar
  BEFORE UPDATE OF avatar_url ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_horse_avatar();

COMMENT ON FUNCTION public.fn_guard_horse_avatar() IS
  'Keeps a horse from being moved off its bespoke portrait onto generic library '
  'art in profiles.avatar_url. That column is the SOCIAL MEDIA photo. The Club '
  'Arena avatar is profiles.arena_avatar_url and is not affected by this guard.';
