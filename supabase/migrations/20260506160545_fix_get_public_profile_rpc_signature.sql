-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506160545 "fix_get_public_profile_rpc_signature"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6d6509feb5015b6fe34a81a60f73683e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- diamonds and level are 'integer', not bigint. Fix the RETURNS TABLE
-- types and re-grant. Drop first because Postgres can't ALTER return type.
DROP FUNCTION IF EXISTS public.get_public_profile_by_username(text);

CREATE OR REPLACE FUNCTION public.get_public_profile_by_username(p_username text)
RETURNS TABLE (
  id uuid,
  username text,
  full_name text,
  display_name text,
  bio text,
  avatar_url text,
  level integer,
  diamonds integer,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    p.id, p.username, p.full_name, p.display_name, p.bio, p.avatar_url,
    p.level, p.diamonds, p.created_at
  FROM public.profiles p
  WHERE lower(p.username) = lower(trim(both ' @' from coalesce(p_username, '')))
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_public_profile_by_username(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_profile_by_username(text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.get_public_profile_by_username(text) IS
  'Public profile lookup for /u/[username] share page. Returns only display-safe columns — never phone, email, last_login, last_active, role, is_admin, or other sensitive fields.';
