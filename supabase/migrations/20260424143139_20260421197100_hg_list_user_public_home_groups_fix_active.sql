-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424143139 "20260421197100_hg_list_user_public_home_groups_fix_active"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d47957df247586ecfee8d8501dae96b9 of array_to_string(statements, chr(10)) || chr(10).
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
  SELECT * FROM (
    SELECT g.id, g.name::text, sp.slug::text, 'owner'::text,
           g.city::text, g.member_count, g.profile_photo_url::text, g.created_at
      FROM public.commander_home_groups g
      LEFT JOIN public.social_pages sp
        ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text
     WHERE g.owner_id   = p_target_user_id
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
    CASE t.relationship WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
    t.created_at DESC
  LIMIT p_limit;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.fn_list_user_public_home_groups(uuid, integer) TO authenticated, anon, service_role;
