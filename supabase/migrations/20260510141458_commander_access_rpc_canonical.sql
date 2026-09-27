-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260510141458 "commander_access_rpc_canonical"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e0b14cea511962e81b621f09b60b0cad of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Canonical Commander access check.
-- Returns true if the user is a Club Commander identity in ANY form:
--   (a) owns a clubs row,
--   (b) owns a commander_subscriptions row (any status),
--   (c) is staff with role='owner' or 'manager' (matched on user_id OR linked_user_id),
--   (d) owns a commander_home_groups row.
--
-- Why linked_user_id: a user can have two auth.users entries — one for legacy
-- billing (e.g., daniel@bekavactrading.com) and one for current login (e.g.,
-- danimal5022@yahoo.com). commander_staff.user_id is the active login;
-- commander_staff.linked_user_id is the linked legacy/billing account.
-- We must check BOTH directions to find access.

CREATE OR REPLACE FUNCTION public.has_commander_access(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    EXISTS (SELECT 1 FROM clubs WHERE owner_id = p_user_id) OR
    EXISTS (SELECT 1 FROM commander_subscriptions WHERE owner_id = p_user_id) OR
    EXISTS (
      SELECT 1 FROM commander_staff
      WHERE (user_id = p_user_id OR linked_user_id = p_user_id)
        AND role IN ('owner','manager')
    ) OR
    EXISTS (SELECT 1 FROM commander_home_groups WHERE owner_id = p_user_id);
$$;

GRANT EXECUTE ON FUNCTION public.has_commander_access(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.has_commander_access(uuid) IS
'Bug-fix 2026-05-10: canonical Commander access check used by /api/check-access. '
'Returns true if user owns clubs, owns commander_subscriptions, is staff with owner/manager role '
'(matched on user_id OR linked_user_id to handle multi-account users), or owns a home group. '
'Replaces the previous narrow check that only looked at clubs.owner_id and missed users like '
'Dan Bekavac who own venues via commander_staff with a separate billing-email auth identity.';

-- Detailed access info — for endpoints that need to route the user
-- to a specific dashboard / venue / home group instead of a generic page.
CREATE OR REPLACE FUNCTION public.get_commander_access_details(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH
    cs AS (
      SELECT venue_id, role
      FROM commander_staff
      WHERE (user_id = p_user_id OR linked_user_id = p_user_id)
        AND venue_id IS NOT NULL
    ),
    sub AS (SELECT venue_id FROM commander_subscriptions WHERE owner_id = p_user_id),
    cl  AS (SELECT id, club_id, name FROM clubs WHERE owner_id = p_user_id),
    hg  AS (SELECT id, name FROM commander_home_groups WHERE owner_id = p_user_id)
  SELECT jsonb_build_object(
    'hasAccess', (
      EXISTS(SELECT 1 FROM cl) OR EXISTS(SELECT 1 FROM sub) OR
      EXISTS(SELECT 1 FROM cs WHERE role IN ('owner','manager')) OR
      EXISTS(SELECT 1 FROM hg)
    ),
    'isClubOwner',           EXISTS(SELECT 1 FROM cl),
    'hasSubscription',       EXISTS(SELECT 1 FROM sub),
    'isVenueStaffOwner',     EXISTS(SELECT 1 FROM cs WHERE role = 'owner'),
    'isVenueStaffManager',   EXISTS(SELECT 1 FROM cs WHERE role = 'manager'),
    'isHomeGroupOwner',      EXISTS(SELECT 1 FROM hg),
    'venueIds',              COALESCE((SELECT jsonb_agg(DISTINCT venue_id) FROM cs), '[]'::jsonb),
    'subscriptionVenueIds',  COALESCE((SELECT jsonb_agg(venue_id) FROM sub), '[]'::jsonb),
    'clubs',                 COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'club_id', club_id, 'name', name)) FROM cl), '[]'::jsonb),
    'homeGroups',            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name)) FROM hg), '[]'::jsonb)
  );
$$;

GRANT EXECUTE ON FUNCTION public.get_commander_access_details(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_commander_access_details(uuid) IS
'Bug-fix 2026-05-10: companion to has_commander_access() that returns full identity context. '
'Use from /api/check-access to return a richer payload that lets the client decide where to '
'route the user (venue dashboard, home group, register flow, etc.) instead of a binary yes/no.';
