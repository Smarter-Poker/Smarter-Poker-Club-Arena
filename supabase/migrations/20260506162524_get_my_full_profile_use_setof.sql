-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506162524 "get_my_full_profile_use_setof"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cc6d5cd21220be043996d836a6b097d9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Return SETOF for stable array shape via PostgREST. Drop first since
-- Postgres can't ALTER a function's return type signature.
DROP FUNCTION IF EXISTS public.get_my_full_profile();

CREATE FUNCTION public.get_my_full_profile()
RETURNS SETOF public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM public.profiles WHERE id = v_uid LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_full_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_full_profile() TO authenticated, service_role;
COMMENT ON FUNCTION public.get_my_full_profile() IS
  'Returns the authenticated caller''s full profile row including sensitive columns (phone, email). Required because column-level REVOKE on phone/email blocks direct table SELECTs even for self. Returns SETOF for stable array shape via PostgREST.';
