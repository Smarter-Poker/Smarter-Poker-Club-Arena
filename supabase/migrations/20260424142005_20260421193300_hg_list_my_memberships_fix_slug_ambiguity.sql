-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424142005 "20260421193300_hg_list_my_memberships_fix_slug_ambiguity"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 391341cc174e335b88c414e959f505c8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

DROP FUNCTION IF EXISTS public.fn_list_my_home_memberships(uuid);

CREATE OR REPLACE FUNCTION public.fn_list_my_home_memberships(
  p_caller_user_id uuid
)
 RETURNS TABLE (
   kind              text,
   hg_group_id       uuid,
   hg_name           text,
   hg_slug           text,
   hg_role           text,
   hg_status         text,
   is_owner          boolean,
   is_private        boolean,
   is_21_plus        boolean,
   member_count      integer,
   profile_photo_url text,
   city              text,
   next_game_at      timestamptz,
   unread_posts      integer,
   joined_at         timestamptz,
   last_attended     timestamptz
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
           m.joined_at, m.last_attended, m.last_read_posts_at
      FROM commander_home_members m
      JOIN commander_home_groups g ON g.id = m.group_id
     WHERE m.user_id = p_caller_user_id
       AND m.status IN ('approved','pending')
  ),
  union_set AS (
    SELECT o.id AS group_id, o.name, o.owner_id, o.is_private, o.is_21_plus,
           o.member_count, o.profile_photo_url, o.city,
           'owner'::text AS role, 'approved'::text AS status, true AS is_owner,
           o.created_at AS joined_at,
           NULL::timestamptz AS last_attended, NULL::timestamptz AS last_read_posts_at
      FROM owned o
    UNION
    SELECT m.id, m.name, m.owner_id, m.is_private, m.is_21_plus,
           m.member_count, m.profile_photo_url, m.city,
           m.m_role, m.m_status, (m.owner_id = p_caller_user_id),
           m.joined_at, m.last_attended, m.last_read_posts_at
      FROM memberships m
  ),
  games_with_starts AS (
    SELECT gm.group_id,
           CASE
             WHEN gm.scheduled_date IS NOT NULL AND gm.start_time IS NOT NULL THEN
               (gm.scheduled_date || ' ' || gm.start_time)::timestamp
                 AT TIME ZONE COALESCE(gm.timezone, 'UTC')
             WHEN gm.scheduled_date IS NOT NULL THEN
               (gm.scheduled_date || ' 19:00:00')::timestamp
                 AT TIME ZONE COALESCE(gm.timezone, 'UTC')
             ELSE NULL
           END AS starts_at
      FROM commander_home_games gm
     WHERE gm.status IN ('scheduled','confirmed')
  ),
  next_game_per_group AS (
    SELECT DISTINCT ON (gs.group_id) gs.group_id, gs.starts_at AS next_game_at
      FROM games_with_starts gs
     WHERE gs.starts_at IS NOT NULL AND gs.starts_at > NOW()
     ORDER BY gs.group_id, gs.starts_at ASC
  ),
  sp_slug AS (
    SELECT sp.linked_entity_id::uuid AS sp_group_id, sp.slug AS sp_slug_val
      FROM public.social_pages sp
     WHERE sp.linked_entity_type = 'home_group'
  )
  SELECT 'home_group'::text           AS kind,
         u.group_id                   AS hg_group_id,
         u.name::text                 AS hg_name,
         ss.sp_slug_val::text         AS hg_slug,
         u.role                       AS hg_role,
         u.status                     AS hg_status,
         u.is_owner,
         u.is_private,
         u.is_21_plus,
         u.member_count,
         u.profile_photo_url::text,
         u.city::text,
         ng.next_game_at,
         COALESCE(
           (SELECT COUNT(*)::integer FROM commander_home_posts p
             WHERE p.group_id = u.group_id
               AND p.is_hidden = false
               AND p.created_at > COALESCE(u.last_read_posts_at, u.joined_at, 'epoch'::timestamptz)),
           0
         ) AS unread_posts,
         u.joined_at,
         u.last_attended
    FROM union_set u
    LEFT JOIN next_game_per_group ng ON ng.group_id   = u.group_id
    LEFT JOIN sp_slug             ss ON ss.sp_group_id = u.group_id
   ORDER BY u.is_owner DESC, u.name ASC;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_list_my_home_memberships(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_my_home_memberships(uuid) TO authenticated, service_role;
