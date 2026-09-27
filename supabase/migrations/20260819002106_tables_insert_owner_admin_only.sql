-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819002106 "tables_insert_owner_admin_only"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fbd6780c60c92824ea8cdfd9a66ab8bd of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Cash games may only be built by a club owner/admin (standalone club) or a
-- union owner/admin (club inside a union). Owner ruling 2026-08-19.
--
-- The policy this replaces was:
--
--   CREATE POLICY "Club admins can create tables" ON tables
--     FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
--
-- Despite the name it checked only that SOMEBODY was logged in. Any registered
-- user could create a table in any club — including a club they had never
-- joined, and including a club inside a union that is not supposed to build its
-- own games at all. DELETE on the same table was already correctly guarded by
-- is_club_admin, so this was an oversight in the INSERT rule rather than a
-- deliberate looseness.
--
-- The engine and the tournament manager write tables with the service role,
-- which bypasses RLS, so the fleet and tournament table creation are unaffected.
DROP POLICY IF EXISTS "Club admins can create tables" ON public.tables;

CREATE POLICY tables_insert_owner_or_admin ON public.tables
  FOR INSERT
  TO authenticated
  WITH CHECK (public.fn_can_create_games(club_id, (SELECT auth.uid())));
