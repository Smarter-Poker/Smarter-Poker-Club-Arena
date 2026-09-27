-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424142300 "20260421195000_hg_list_post_targets_for_social_composer"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fd35111e93f3cd62566120fd4f2ac156 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Gap 3: social-media composer only shows personal + club targets. It
-- needs to also show home groups the user owns or admins, so posts can
-- be targeted at the home group's social page (which already exists
-- via auto-creation).
--
-- Returns every target the caller can post to:
--   kind='personal' → user's own profile feed (single row)
--   kind='club'     → clubs where user is owner/admin
--   kind='home_group' → HG groups where user is owner/admin/co_host
CREATE OR REPLACE FUNCTION public.fn_list_my_post_targets(
  p_caller_user_id uuid
)
 RETURNS TABLE (
   kind            text,
   target_id       uuid,
   target_name     text,
   target_slug     text,
   target_avatar   text,
   target_role     text,
   social_page_id  uuid,
   sort_order      integer
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
  -- 1) Personal profile (always sort_order=0, always present)
  SELECT 'personal'::text,
         p.id,
         COALESCE(p.display_name, p.full_name, p.username, 'Me')::text,
         p.username::text,
         p.avatar_url::text,
         'owner'::text,
         NULL::uuid,
         0 AS sort_order
    FROM public.profiles p
   WHERE p.id = p_caller_user_id

  UNION ALL

  -- 2) Clubs user owns or admins
  SELECT 'club'::text,
         c.id,
         c.name::text,
         c.slug::text,
         c.logo_url::text,
         cm.role::text,
         (SELECT sp.id FROM public.social_pages sp
           WHERE sp.linked_entity_type='club' AND sp.linked_entity_id = c.id::text LIMIT 1),
         1 AS sort_order
    FROM public.club_members cm
    JOIN public.clubs c ON c.id = cm.club_id
   WHERE cm.user_id = p_caller_user_id
     AND cm.role IN ('owner','admin','operator','manager')
     AND COALESCE(cm.is_active, true) = true

  UNION ALL

  -- 3) Home groups: owner OR approved admin/co_host
  SELECT 'home_group'::text  AS kind,
         g.id                AS target_id,
         g.name::text        AS target_name,
         sp.slug::text       AS target_slug,
         g.profile_photo_url::text AS target_avatar,
         CASE WHEN g.owner_id = p_caller_user_id THEN 'owner'
              ELSE m.role END::text AS target_role,
         sp.id               AS social_page_id,
         2                   AS sort_order
    FROM public.commander_home_groups g
    LEFT JOIN public.commander_home_members m
           ON m.group_id = g.id
          AND m.user_id  = p_caller_user_id
          AND m.status   = 'approved'
          AND m.role IN ('admin','co_host')
    LEFT JOIN public.social_pages sp
           ON sp.linked_entity_type = 'home_group'
          AND sp.linked_entity_id   = g.id::text
   WHERE (g.owner_id = p_caller_user_id OR m.id IS NOT NULL)

   ORDER BY sort_order ASC, target_name ASC;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_list_my_post_targets(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_my_post_targets(uuid) TO authenticated, service_role;
