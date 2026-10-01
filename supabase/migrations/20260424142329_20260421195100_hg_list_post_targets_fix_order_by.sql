-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424142329 "20260421195100_hg_list_post_targets_fix_order_by"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d068f711800532e645ed7eb7ea6e10b1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_list_my_post_targets(
  p_caller_user_id uuid
)
 RETURNS TABLE (
   kind text, target_id uuid, target_name text, target_slug text,
   target_avatar text, target_role text, social_page_id uuid, sort_order integer
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
  SELECT * FROM (
    SELECT 'personal'::text AS kind,
           p.id AS target_id,
           COALESCE(p.display_name, p.full_name, p.username, 'Me')::text AS target_name,
           p.username::text AS target_slug,
           p.avatar_url::text AS target_avatar,
           'owner'::text AS target_role,
           NULL::uuid AS social_page_id,
           0 AS sort_order
      FROM public.profiles p
     WHERE p.id = p_caller_user_id
    UNION ALL
    SELECT 'club',
           c.id, c.name::text, c.slug::text, c.logo_url::text, cm.role::text,
           (SELECT sp.id FROM public.social_pages sp
             WHERE sp.linked_entity_type='club' AND sp.linked_entity_id = c.id::text LIMIT 1),
           1
      FROM public.club_members cm
      JOIN public.clubs c ON c.id = cm.club_id
     WHERE cm.user_id = p_caller_user_id
       AND cm.role IN ('owner','admin','operator','manager')
       AND COALESCE(cm.is_active, true) = true
    UNION ALL
    SELECT 'home_group',
           g.id, g.name::text, sp.slug::text, g.profile_photo_url::text,
           (CASE WHEN g.owner_id = p_caller_user_id THEN 'owner'
                 ELSE m.role END)::text,
           sp.id, 2
      FROM public.commander_home_groups g
      LEFT JOIN public.commander_home_members m
             ON m.group_id = g.id AND m.user_id = p_caller_user_id
            AND m.status = 'approved' AND m.role IN ('admin','co_host')
      LEFT JOIN public.social_pages sp
             ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text
     WHERE (g.owner_id = p_caller_user_id OR m.id IS NOT NULL)
  ) t
  ORDER BY t.sort_order ASC, t.target_name ASC;
END;
$fn$;
