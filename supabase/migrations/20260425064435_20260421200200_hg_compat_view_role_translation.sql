-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260425064435 "20260421200200_hg_compat_view_role_translation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1416b01265a93f5195b90e5b25760189 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG FIX #4: deployed bundle checks
--   ["host","co_host","admin"].includes(t.userRole)
-- to decide whether to route to /dashboard. Real DB role is 'owner'
-- (not in that list) so owners would route to the public group page,
-- not their own dashboard.
--
-- Translate owner → host in the view so the bundle's check matches.
DROP VIEW IF EXISTS public.home_game_members CASCADE;

CREATE VIEW public.home_game_members
  WITH (security_invoker = on)
AS
SELECT
  m.id,
  m.group_id,
  m.user_id,
  CASE WHEN m.role = 'owner' THEN 'host' ELSE m.role END AS role,
  CASE WHEN m.status = 'approved' THEN 'active' ELSE m.status END AS status,
  m.joined_at
FROM public.commander_home_members m;

GRANT SELECT ON public.home_game_members TO authenticated, anon, service_role;
NOTIFY pgrst, 'reload schema';
