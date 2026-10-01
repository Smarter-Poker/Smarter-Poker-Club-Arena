-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260512144236 "20260512144500_inline_fn_list_my_post_targets_zero_arg"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c6651b3285fc0f68d8f3606d6c318694 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Dan-fix/home-group-identity (2026-05-12) part 2
--
-- The previous migration dropped fn_list_my_post_targets(uuid) but the no-args
-- version delegates to it (`RETURN QUERY SELECT * FROM public.fn_list_my_post_targets(v_uid)`)
-- — so the no-args version was left broken (42883: function does not exist).
--
-- Fix: inline the full computation into the no-args overload so it's self-contained.
-- Body taken verbatim from the 2026-04-26 translate-owner-to-host migration,
-- with auth.uid() inlined where p_caller_user_id was. This eliminates the
-- 1-arg overload entirely (no callers in the codebase), removing any chance
-- of PostgREST overload ambiguity affecting the social composer's identity picker.

CREATE OR REPLACE FUNCTION public.fn_list_my_post_targets()
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
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT * FROM (
    -- Personal: post as self
    SELECT 'personal'::text AS kind,
           p.id AS target_id,
           COALESCE(p.display_name, p.full_name, p.username, 'Me')::text AS target_name,
           p.username::text AS target_slug,
           p.avatar_url::text AS target_avatar,
           'owner'::text AS target_role,
           NULL::uuid AS social_page_id,
           0 AS sort_order
      FROM public.profiles p
     WHERE p.id = v_uid

    UNION ALL

    -- Clubs: post as Club Page
    SELECT 'club',
           c.id, c.name::text, c.slug::text, c.logo_url::text, cm.role::text,
           (SELECT sp.id FROM public.social_pages sp
             WHERE sp.linked_entity_type='club' AND sp.linked_entity_id = c.id::text LIMIT 1),
           1
      FROM public.club_members cm
      JOIN public.clubs c ON c.id = cm.club_id
     WHERE cm.user_id = v_uid
       AND cm.role IN ('owner','admin','operator','manager')
       AND COALESCE(cm.is_active, true) = true

    UNION ALL

    -- Home groups: translate owner→host for UI consistency with rest of HG launch
    SELECT 'home_group',
           g.id, g.name::text, sp.slug::text, g.profile_photo_url::text,
           (CASE
              WHEN g.owner_id = v_uid THEN 'host'
              ELSE m.role
            END)::text,
           sp.id, 2
      FROM public.commander_home_groups g
      LEFT JOIN public.commander_home_members m
             ON m.group_id = g.id AND m.user_id = v_uid
            AND m.status = 'approved' AND m.role IN ('admin','co_host')
      LEFT JOIN public.social_pages sp
             ON sp.linked_entity_type='home_group' AND sp.linked_entity_id = g.id::text
     WHERE (g.owner_id = v_uid OR m.id IS NOT NULL)
  ) t
  ORDER BY t.sort_order ASC, t.target_name ASC;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_list_my_post_targets() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_list_my_post_targets() TO authenticated, service_role;

-- Verify only one overload exists and it works
DO $$
DECLARE cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM pg_proc p
   WHERE p.proname = 'fn_list_my_post_targets'
     AND p.pronamespace = 'public'::regnamespace;
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'expected 1 fn_list_my_post_targets after inline, found %', cnt;
  END IF;
END$$;
