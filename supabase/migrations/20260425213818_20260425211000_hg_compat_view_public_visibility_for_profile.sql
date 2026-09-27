-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260425213818 "20260425211000_hg_compat_view_public_visibility_for_profile"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 346452376af95ab8333d27ad09be41a3 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG FIX #3: /u/[username] "Hosts These Games" section is empty for
-- anyone except the profile owner. The bundle queries home_game_members
-- directly (with anon supabase client), but the view has security_invoker=on
-- and the base table's RLS requires auth.uid() = user_id OR caller-is-staff.
-- Result: anon and non-staff visitors get zero rows, section never renders.
--
-- Fix: rebuild home_game_members as security_invoker=off (bypass base
-- table RLS) and bake the privacy logic INTO the view's WHERE clause so
-- access control still holds:
--
--   1. PUBLIC PATH    — anyone sees approved memberships of public, active
--                       groups. Powers /u/<username> "Hosts These Games"
--                       and any cross-user discovery.
--   2. SELF PATH      — authenticated user always sees their own rows.
--                       Powers /hub/my-clubs (current user's memberships)
--                       and the dashboard role-check (own role lookup).
--   3. STAFF PATH     — host/co-host/admin sees ALL rows in groups they
--                       run, including pending/banned. Powers Members tab,
--                       moderation, etc.
--
-- For private groups, only paths 2 and 3 match — privacy preserved.
-- For public groups, path 1 exposes approved memberships only —
-- pending/banned still gated to staff.
--
-- Translations preserved:
--   role:   owner → host  (matches bundle's ["host","co_host","admin"] check)
--   status: approved → active  (matches bundle's .eq("status","active"))

DROP VIEW IF EXISTS public.home_game_members CASCADE;

CREATE VIEW public.home_game_members
  WITH (security_invoker = off)
AS
SELECT
  m.id,
  m.group_id,
  m.user_id,
  CASE WHEN m.role = 'owner' THEN 'host' ELSE m.role END AS role,
  CASE WHEN m.status = 'approved' THEN 'active' ELSE m.status END AS status,
  m.joined_at
FROM public.commander_home_members m
JOIN public.commander_home_groups g ON g.id = m.group_id
WHERE
  -- Path 1: public group's approved memberships → visible to anyone
  (g.is_private = false AND g.is_active = true AND m.status = 'approved')
  OR
  -- Path 2: caller sees their own memberships (any status, any group)
  (auth.uid() IS NOT NULL AND m.user_id = auth.uid())
  OR
  -- Path 3: group staff (owner/admin/co_host) sees all memberships in their group
  (auth.uid() IS NOT NULL AND public.fn_home_is_group_staff(auth.uid(), m.group_id));

GRANT SELECT ON public.home_game_members TO authenticated, anon, service_role;
NOTIFY pgrst, 'reload schema';
