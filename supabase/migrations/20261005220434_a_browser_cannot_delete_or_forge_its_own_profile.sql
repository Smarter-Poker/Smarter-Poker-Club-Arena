-- 20261005220434_a_browser_cannot_delete_or_forge_its_own_profile.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (launch audit 2026-10-05, blocker 2):
--
-- 1. A PLAYER COULD MAKE ITSELF A PLATFORM ADMIN. Read on production:
--      profiles ACL            authenticated=adxtm   (table-level INSERT and DELETE)
--      profiles_delete         USING (auth.uid() = id)
--      profiles_insert_self    WITH CHECK (auth.uid() = id)
--      trg_guard_profile_privileged_columns   BEFORE UPDATE only
--    So a signed-in account could DELETE its own profile row and INSERT it
--    again with role = 'god', is_admin, is_vip and a diamond balance.
--    fn_is_platform_admin() reads profiles.role. Migration 20260827214020
--    tried to close this with a column-level REVOKE INSERT, which is a no-op
--    while the table-level INSERT grant stands.
--
--    The fix is at the two doors themselves:
--      a. No browser role may DELETE a profile. Nothing in the Club Arena or
--         World Hub clients deletes one (account closure is its own RPC), and
--         no function in the database deletes from profiles.
--      b. A profile INSERTed from a browser context may carry only what a
--         brand-new player has. The signup upsert (src/pages/AuthPage.tsx)
--         sends id, username, display_name, tier, diamonds 0 and timestamps;
--         it is unaffected. Server-side creators (handle_new_user, the horse
--         seeders, service-role API routes) run in a service context and are
--         not judged.
--
-- 2. A PLAYER COULD WRITE ITS OWN KYC, AGE, MFA AND FARMING FLAGS. Column
--    UPDATE grants on those columns were held by `authenticated`. No browser
--    code in either repo writes them; the World Hub's KYC and auth API routes
--    do, with the service role. Revoked from the browser roles.
--
-- (dblink, blocker 4 of the same audit, is closed by its own migration,
-- 20261005221203_dblink_leaves_the_schema_the_data_api_serves.sql,
-- so that neither change can hold the other back.)
--
-- Every step asserts its own result, so a step that silently did nothing
-- aborts the whole transaction instead of reading as applied.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1a. No browser role deletes a profile ───────────────────────────────────
REVOKE DELETE ON public.profiles FROM authenticated, anon;

-- ── 1b. A browser-born profile carries nothing privileged ───────────────────
CREATE OR REPLACE FUNCTION public.fn_guard_profile_privileged_columns_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_field text;
BEGIN
  -- SET ROLE survives nested SECURITY DEFINER calls; current_user does not.
  -- A browser request is judged even when a definer function carries it here.
  IF coalesce(current_setting('role', true), 'none') NOT IN ('anon', 'authenticated')
     AND public.fn_is_service_context() IS TRUE THEN
    RETURN NEW;
  END IF;

  IF coalesce(NEW.role, 'user') <> 'user' THEN v_field := 'role';
  ELSIF coalesce(NEW.is_admin, false) THEN v_field := 'is_admin';
  ELSIF coalesce(NEW.is_vip, false) THEN v_field := 'is_vip';
  ELSIF NEW.vip_tier IS NOT NULL THEN v_field := 'vip_tier';
  ELSIF NEW.vip_expires_at IS NOT NULL THEN v_field := 'vip_expires_at';
  ELSIF coalesce(NEW.diamonds, 0) <> 0 THEN v_field := 'diamonds';
  ELSIF coalesce(NEW.diamond_balance, 0) <> 0 THEN v_field := 'diamond_balance';
  ELSIF coalesce(NEW.diamond_multiplier, 1) <> 1 THEN v_field := 'diamond_multiplier';
  ELSIF coalesce(NEW.kyc_status, 'NONE') <> 'NONE' THEN v_field := 'kyc_status';
  ELSIF coalesce(NEW.age_verified, false) THEN v_field := 'age_verified';
  ELSIF coalesce(NEW.mfa_required, false) THEN v_field := 'mfa_required';
  ELSIF coalesce(NEW.email_verified, false) THEN v_field := 'email_verified';
  ELSIF coalesce(NEW.phone_verified, false) THEN v_field := 'phone_verified';
  END IF;

  IF v_field IS NOT NULL THEN
    RAISE EXCEPTION 'profiles.% is server-managed and cannot be set when a profile is created', v_field
      USING ERRCODE = '42501',
            HINT = 'A new profile starts as an ordinary player. Standing, verification and balances are set by the server.';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_profile_privileged_columns_on_insert ON public.profiles;
CREATE TRIGGER trg_guard_profile_privileged_columns_on_insert
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_guard_profile_privileged_columns_on_insert();

-- ── 2. A player does not write its own KYC, age, MFA or farming flags ───────
REVOKE UPDATE (kyc_status, kyc_completed_at, kyc_inquiry_id, kyc_provider,
               kyc_rejection_reason, age_verified, age_verified_at,
               mfa_required, is_farming_flagged)
  ON public.profiles FROM authenticated, anon;

-- ── Assertions: a step that did nothing aborts everything ───────────────────
DO $do$
DECLARE
  v_bad text;
BEGIN
  IF has_table_privilege('authenticated', 'public.profiles', 'DELETE')
     OR has_table_privilege('anon', 'public.profiles', 'DELETE') THEN
    RAISE EXCEPTION 'a browser role can still DELETE from public.profiles';
  END IF;

  SELECT string_agg(c, ', ') INTO v_bad
    FROM unnest(ARRAY['kyc_status','kyc_completed_at','kyc_inquiry_id','kyc_provider',
                      'kyc_rejection_reason','age_verified','age_verified_at',
                      'mfa_required','is_farming_flagged']) AS c
   WHERE has_column_privilege('authenticated', 'public.profiles', c, 'UPDATE')
      OR has_column_privilege('anon', 'public.profiles', c, 'UPDATE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a browser role can still UPDATE profiles columns: %', v_bad;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.profiles'::regclass
       AND tgname = 'trg_guard_profile_privileged_columns_on_insert'
       AND tgenabled = 'O'
       AND (tgtype & 4) = 4 AND (tgtype & 2) = 2 AND (tgtype & 1) = 1
  ) THEN
    RAISE EXCEPTION 'the profile insert guard is not armed';
  END IF;

END
$do$;

COMMIT;
