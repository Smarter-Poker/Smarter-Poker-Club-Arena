-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506160457 "privacy_block_anon_profile_harvest_via_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1d97bbc08d6056a583acec1ba594d769 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- PRIVACY HARDENING — Block anon harvest of phone/email
-- ─────────────────────────────────────────────────────────────────────────
-- Pre-existing hole: profiles_select RLS qual='true' for role 'public' lets
-- ANY caller (including anon — i.e. anyone with the Supabase anon key, which
-- is embedded in every page of smarter.poker) dump the entire profiles table:
--
--   curl -H 'apikey: <anon>' -H 'Authorization: Bearer <anon>' \
--     'https://kuklfnapbkmacvwxktbh.supabase.co/rest/v1/profiles?select=*'
--
-- Confirmed exposure: 1011 rows, 723 emails, 19 phones harvestable.
--
-- Fix (this migration): drop anon's row-level SELECT on profiles, and provide
-- a single SECURITY DEFINER RPC for the only legitimate anon read path
-- (the public /u/[username] page). The RPC returns only safe columns —
-- never phone, email, last_login, last_active, etc.
--
-- Authenticated users are NOT affected by this migration; they can still
-- read full profiles. (Tightening that surface is a follow-up — it requires
-- updating every `select('*')` in the codebase.)
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. SECURITY DEFINER RPC for the public profile share page (/u/[username])
CREATE OR REPLACE FUNCTION public.get_public_profile_by_username(p_username text)
RETURNS TABLE (
  id uuid,
  username text,
  full_name text,
  display_name text,
  bio text,
  avatar_url text,
  level int,
  diamonds bigint,
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
  'Public profile lookup for /u/[username] share page. Returns only display-safe columns — never phone, email, last_login, last_active, role, is_admin, or other sensitive fields. Replaces the previous anon SELECT-on-profiles pattern.';

-- 2. Restrict the table-level SELECT policy to authenticated only
DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT
  TO authenticated
  USING (true);

-- 3. Revoke any direct table grants from anon as defense-in-depth
REVOKE ALL ON TABLE public.profiles FROM anon;
