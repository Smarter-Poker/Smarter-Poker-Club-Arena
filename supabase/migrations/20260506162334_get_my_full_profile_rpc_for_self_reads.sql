-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506162334 "get_my_full_profile_rpc_for_self_reads"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c148a4ef1a4ce5e874e4e8d6cf7ef4a0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- get_my_full_profile() — self-read RPC for sensitive columns
-- ─────────────────────────────────────────────────────────────────────────
-- After REVOKE SELECT (phone, email) FROM authenticated, table-level reads
-- of those columns will fail — including for the user's OWN profile. This
-- RPC is the legitimate self-read path. It runs SECURITY DEFINER (postgres)
-- and uses auth.uid() to ensure the caller can only ever see their OWN row.
--
-- Returns the entire profiles row including phone, email, and any future
-- sensitive columns. Future column additions automatically flow through.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_my_full_profile()
RETURNS public.profiles
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.profiles;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_row FROM public.profiles WHERE id = v_uid;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_full_profile() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_full_profile() TO authenticated, service_role;
-- Deliberately NOT granted to anon — anonymous callers don't have a profile row.

COMMENT ON FUNCTION public.get_my_full_profile() IS
  'Returns the authenticated caller''s full profile row including sensitive columns (phone, email). Required because column-level REVOKE on phone/email blocks direct table SELECTs even for self.';
