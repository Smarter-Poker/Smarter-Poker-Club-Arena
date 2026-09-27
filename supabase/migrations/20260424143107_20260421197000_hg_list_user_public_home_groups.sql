-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424143107 "20260421197000_hg_list_user_public_home_groups"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 11d032af89e54c78605b381d0d1cdab2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Public profile page integration: when viewing smarter.poker/u/<username>,
-- show any PUBLIC home groups the user owns or is an admin/co_host of.
-- Returns only non-private groups so privacy is preserved.
--
-- Unlike fn_list_my_home_memberships, this is:
--   - viewable by anyone (authenticated or anon)
--   - filters to public groups only
--   - only returns owner/admin/co_host relationship (not every member)
CREATE OR REPLACE FUNCTION public.fn_list_user_public_home_groups(
  p_target_user_id uuid, p_limit integer DEFAULT 20
)
 RETURNS TABLE (
   group_id          uuid,
   group_name        text,
   group_slug        text,
   relationship      text,
   city              text,
   member_count      integer,
   profile_photo_url text,
   created_at        timestamptz
 )
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  p_limit := GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));

  RETURN QUERY
  SELECT * FROM (
    SELECT g.id AS group_id,
           g.name::text AS group_name,
           sp.slug::text AS group_slug,
           'owner'::text AS relationship,
           g.city::text,
           g.member_count,
           g.profile_photo_url::text,
           g.created_at
      FROM public.commander_home_groups g
      LEFT JOIN public.social_pages sp
        ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text
     WHERE g.owner_id   = p_target_user_id
       AND g.is_private = false
       AND g.hidden_at IS NULL

    UNION

    SELECT g.id,
           g.name::text,
           sp.slug::text,
           m.role::text,
           g.city::text,
           g.member_count,
           g.profile_photo_url::text,
           g.created_at
      FROM public.commander_home_members m
      JOIN public.commander_home_groups g ON g.id = m.group_id
      LEFT JOIN public.social_pages sp
        ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text
     WHERE m.user_id = p_target_user_id
       AND m.status = 'approved'
       AND m.role IN ('admin','co_host')
       AND g.owner_id <> p_target_user_id
       AND g.is_private = false
       AND g.hidden_at IS NULL
  ) t
  ORDER BY
    CASE t.relationship WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
    t.created_at DESC
  LIMIT p_limit;
END;
$fn$;

-- Public RPC: anyone can read public profile data
GRANT EXECUTE ON FUNCTION public.fn_list_user_public_home_groups(uuid, integer) TO authenticated, anon, service_role;
