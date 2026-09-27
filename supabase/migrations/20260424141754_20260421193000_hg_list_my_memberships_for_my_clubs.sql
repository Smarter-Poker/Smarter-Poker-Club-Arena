-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424141754 "20260421193000_hg_list_my_memberships_for_my_clubs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d8d12ccb450c30105b4dfebfe0ddac50 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Gap 1: My Clubs page only reads club_members. Home groups live in
-- commander_home_members, siloed. Frontend UNIONs the two via this RPC.
--
-- Returns one row per HG relationship with fields normalized to match
-- what my-clubs.js expects, plus a `kind = 'home_group'` tag so the UI
-- can render a distinct badge.
CREATE OR REPLACE FUNCTION public.fn_list_my_home_memberships(
  p_caller_user_id uuid
)
 RETURNS TABLE (
   kind            text,
   group_id        uuid,
   name            text,
   slug            text,
   role            text,
   status          text,
   is_owner        boolean,
   is_private      boolean,
   is_21_plus      boolean,
   member_count    integer,
   profile_photo_url text,
   city            text,
   next_game_at    timestamptz,
   unread_posts    integer,
   joined_at       timestamptz,
   last_active_at  timestamptz
 )
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_caller_user_id THEN
      RAISE EXCEPTION 'UNAUTHORIZED' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
  WITH owned AS (
    SELECT g.id, g.name, g.owner_id, g.is_private, g.is_21_plus,
           g.member_count, g.profile_photo_url, g.city, g.created_at
      FROM commander_home_groups g
     WHERE g.owner_id = p_caller_user_id
  ),
  memberships AS (
    SELECT g.id, g.name, g.owner_id, g.is_private, g.is_21_plus,
           g.member_count, g.profile_photo_url, g.city, g.created_at,
           m.role AS m_role, m.status AS m_status,
           m.joined_at, m.last_active_at
      FROM commander_home_members m
      JOIN commander_home_groups g ON g.id = m.group_id
     WHERE m.user_id = p_caller_user_id
       AND m.status IN ('approved','pending')
  ),
  union_set AS (
    SELECT o.id AS group_id, o.name, o.owner_id, o.is_private, o.is_21_plus,
           o.member_count, o.profile_photo_url, o.city,
           'owner'::text AS role, 'approved'::text AS status,
           true AS is_owner, o.created_at AS joined_at,
           o.created_at AS last_active_at
      FROM owned o
    UNION
    SELECT m.id, m.name, m.owner_id, m.is_private, m.is_21_plus,
           m.member_count, m.profile_photo_url, m.city,
           m.m_role, m.m_status,
           (m.owner_id = p_caller_user_id) AS is_owner,
           m.joined_at, m.last_active_at
      FROM memberships m
  ),
  next_game_per_group AS (
    SELECT DISTINCT ON (gm.group_id)
           gm.group_id, gm.starts_at AS next_game_at
      FROM commander_home_games gm
     WHERE gm.status IN ('scheduled','confirmed')
       AND gm.starts_at > NOW()
     ORDER BY gm.group_id, gm.starts_at ASC
  ),
  sp_slug AS (
    SELECT linked_entity_id::uuid AS group_id, slug
      FROM social_pages
     WHERE linked_entity_type = 'home_group'
  )
  SELECT 'home_group'::text                        AS kind,
         u.group_id,
         u.name::text,
         sp.slug::text,
         u.role,
         u.status,
         u.is_owner,
         u.is_private,
         u.is_21_plus,
         u.member_count,
         u.profile_photo_url::text,
         u.city::text,
         ng.next_game_at,
         0::integer                                 AS unread_posts,
         u.joined_at,
         u.last_active_at
    FROM union_set u
    LEFT JOIN next_game_per_group ng ON ng.group_id = u.group_id
    LEFT JOIN sp_slug           sp  ON sp.group_id = u.group_id
   ORDER BY u.is_owner DESC, u.name ASC;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_list_my_home_memberships(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_my_home_memberships(uuid) TO authenticated, service_role;
