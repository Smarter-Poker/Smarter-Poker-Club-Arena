-- A union operator's mounted administrator list cannot use the self-only raw
-- union_admins policy. Expose that intended roster through a caller-bound read,
-- like fn_union_player_directory, without widening any table policy or write.
-- Only pseudonyms and the Arena avatar leave profiles; no real-name columns,
-- permissions JSON, balances or financial operations are exposed.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '8s';

DO $guard$
BEGIN
  IF to_regprocedure('public.fn_union_admin_directory(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'UNION_ADMIN_DIRECTORY_ALREADY_EXISTS';
  END IF;
  IF md5(pg_get_functiondef('public.fn_arena_name(text,text,text,text,text,text)'::regprocedure))
     IS DISTINCT FROM '2b7a84c23987cb7c923dde302f9ea998' THEN
    RAISE EXCEPTION 'UNION_ADMIN_DIRECTORY_NAME_DEPENDENCY_CHANGED';
  END IF;
END
$guard$;

CREATE FUNCTION public.fn_union_admin_directory(p_union_id uuid)
RETURNS TABLE(union_id uuid, user_id uuid, role text, created_at timestamptz,
              username text, display_name text, avatar_url text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL OR p_union_id IS NULL OR NOT (
    EXISTS (SELECT 1 FROM public.unions u
             WHERE u.id = p_union_id AND u.owner_id = v_user_id)
    OR EXISTS (SELECT 1 FROM public.union_admins own_admin
                WHERE own_admin.union_id = p_union_id
                  AND own_admin.user_id = v_user_id
                  AND own_admin.role IN ('union_lead', 'union_admin'))
  ) THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT a.union_id, a.user_id, a.role, a.created_at, p.username,
         public.fn_arena_name(p.alias, p.username, p.display_name,
                              p.first_name, p.last_name, p.full_name),
         p.arena_avatar_url
    FROM public.union_admins a
    LEFT JOIN public.profiles p ON p.id = a.user_id
   WHERE a.union_id = p_union_id
     AND a.role IN ('union_lead', 'union_admin')
   ORDER BY a.created_at, a.user_id;
END
$function$;
ALTER FUNCTION public.fn_union_admin_directory(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_union_admin_directory(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_union_admin_directory(uuid) TO authenticated, service_role;

COMMIT;
