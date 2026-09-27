-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424143202 "20260421197200_hg_list_user_public_home_groups_fix_union_aliases"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 38f9a7c24dbdc8d31685afca75a52923 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_list_user_public_home_groups(
  p_target_user_id uuid, p_limit integer DEFAULT 20
)
 RETURNS TABLE (
   group_id uuid, group_name text, group_slug text, relationship text,
   city text, member_count integer, profile_photo_url text, created_at timestamptz
 )
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  p_limit := GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));

  RETURN QUERY
  SELECT t.u_group_id, t.u_group_name, t.u_group_slug, t.u_relationship,
         t.u_city, t.u_member_count, t.u_profile_photo_url, t.u_created_at
  FROM (
    SELECT g.id                        AS u_group_id,
           g.name::text                AS u_group_name,
           sp.slug::text               AS u_group_slug,
           'owner'::text               AS u_relationship,
           g.city::text                AS u_city,
           g.member_count              AS u_member_count,
           g.profile_photo_url::text   AS u_profile_photo_url,
           g.created_at                AS u_created_at
      FROM public.commander_home_groups g
      LEFT JOIN public.social_pages sp
        ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text
     WHERE g.owner_id = p_target_user_id
       AND g.is_private = false
       AND COALESCE(g.is_active, true) = true
    UNION
    SELECT g.id, g.name::text, sp.slug::text, m.role::text,
           g.city::text, g.member_count, g.profile_photo_url::text, g.created_at
      FROM public.commander_home_members m
      JOIN public.commander_home_groups g ON g.id = m.group_id
      LEFT JOIN public.social_pages sp
        ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text
     WHERE m.user_id = p_target_user_id
       AND m.status = 'approved'
       AND m.role IN ('admin','co_host')
       AND g.owner_id <> p_target_user_id
       AND g.is_private = false
       AND COALESCE(g.is_active, true) = true
  ) t
  ORDER BY
    CASE t.u_relationship WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
    t.u_created_at DESC
  LIMIT p_limit;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.fn_list_user_public_home_groups(uuid, integer) TO authenticated, anon, service_role;
