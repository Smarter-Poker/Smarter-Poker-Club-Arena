-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424145342 "20260421198000_hg_zero_arg_overloads_for_client_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5e009835827e245354a83caabee7490f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Caller-ergonomic overloads: frontend can call supabase.rpc('fn_x')
-- with no args. auth.uid() is derived from JWT server-side. This mirrors
-- the p_caller_user_id path but saves the frontend from plumbing user.id
-- into every call site.
--
-- Why overloads and not replace: service_role callers (server-side
-- background jobs) still need to pass p_caller_user_id explicitly
-- because service_role has no auth.uid().

CREATE OR REPLACE FUNCTION public.fn_list_my_home_memberships()
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
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.fn_list_my_home_memberships(v_uid);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_list_my_home_memberships() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_my_home_memberships() TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.fn_list_my_post_targets()
 RETURNS TABLE (
   kind text, target_id uuid, target_name text, target_slug text,
   target_avatar text, target_role text, social_page_id uuid, sort_order integer
 )
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.fn_list_my_post_targets(v_uid);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_list_my_post_targets() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_list_my_post_targets() TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.fn_get_home_group_dashboard(p_group_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  RETURN public.fn_get_home_group_dashboard(p_group_id, v_uid);
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.fn_get_home_group_dashboard(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_get_home_group_dashboard(uuid) TO authenticated, service_role;
