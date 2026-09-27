-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260425064331 "20260421200100_hg_compat_view_status_translation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ccf4ec28c8b71b258d58644f5bbdc36d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG FIX #3: deployed bundle filters .eq("status","active") but the
-- DB stores status as 'approved'|'pending'|'banned'. Translate in the view:
-- map approved → active so the bundle's filter matches.
DROP VIEW IF EXISTS public.home_game_members CASCADE;

CREATE VIEW public.home_game_members AS
SELECT
  m.id,
  m.group_id,
  m.user_id,
  m.role,
  CASE
    WHEN m.status = 'approved' THEN 'active'
    ELSE m.status
  END AS status,
  m.joined_at
FROM public.commander_home_members m;

GRANT SELECT ON public.home_game_members TO authenticated, anon, service_role;
