-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812221009 "phase50_restore_secdef_on_home_rls_helpers"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a21858d317132e80345cc8e3f3963e17 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 50a — Restore SECURITY DEFINER on the two Home Games RLS helpers
--
-- WHY: audit 2026-08-12 found both helpers running as SECURITY INVOKER in
-- production, with NO migration in schema_migrations authorising the change.
-- All four migrations that ever touched them (20260417152310, 20260419224823,
-- 20260420004006, 20260426003729) declare SECURITY DEFINER. This was an
-- out-of-band revert applied directly against production.
--
-- IMPACT OF THE REVERT:
--   * fn_home_is_approved_member is SECURITY INVOKER *and* SET row_security=off.
--     That combination is illegal without BYPASSRLS and raises
--     42501 "query would be affected by row-level security policy" for every
--     `authenticated` caller. The function is hard-broken today.
--   * fn_home_is_group_staff additionally LOST its `SET row_security=off`
--     (silently dropped by 20260426003729_hg_staff_helper_includes_co_host,
--     which re-declared the function and omitted the line). It backs 13 RLS
--     policies and currently only works by coincidence.
--
-- SCOPE: security attributes ONLY. Function bodies are NOT touched (ALTER
-- FUNCTION, not CREATE OR REPLACE). EXECUTE grants are deliberately NOT
-- changed here: 12 of the 13 dependent policies apply to role {public},
-- so revoking the PUBLIC grant in the same step would break anon reads.
-- Grant tightening is deferred to a separate, independently verifiable step.
--
-- Tier 3 (security attribute change on auth-critical functions).
-- ROLLBACK is at the bottom of this file.
-- =====================================================================

-- ---------- PRE-FLIGHT ----------
DO $$
DECLARE
    v_owner_ok boolean;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'fn_home_is_group_staff'
          AND pg_get_function_identity_arguments(p.oid) = 'p_caller uuid, p_group_id uuid'
    ) THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAILED: public.fn_home_is_group_staff(uuid,uuid) not found';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = 'fn_home_is_approved_member'
          AND pg_get_function_identity_arguments(p.oid) = 'p_caller uuid, p_group_id uuid'
    ) THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAILED: public.fn_home_is_approved_member(uuid,uuid) not found';
    END IF;

    -- SECURITY DEFINER + row_security=off is only meaningful if the OWNER can
    -- actually bypass RLS. If the owner is not BYPASSRLS/superuser this
    -- migration would not fix the 42501 and must not be applied blindly.
    SELECT bool_and(r.rolbypassrls OR r.rolsuper) INTO v_owner_ok
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r     ON r.oid = p.proowner
    WHERE n.nspname = 'public'
      AND p.proname IN ('fn_home_is_group_staff','fn_home_is_approved_member');

    IF NOT COALESCE(v_owner_ok, false) THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAILED: helper owner lacks BYPASSRLS/superuser; SECURITY DEFINER would not resolve the 42501';
    END IF;
END $$;

-- ---------- APPLY ----------
-- Bodies untouched. Attributes only.
ALTER FUNCTION public.fn_home_is_group_staff(uuid, uuid)     SECURITY DEFINER;
ALTER FUNCTION public.fn_home_is_group_staff(uuid, uuid)     SET search_path TO 'public', 'pg_temp';
ALTER FUNCTION public.fn_home_is_group_staff(uuid, uuid)     SET row_security TO off;

ALTER FUNCTION public.fn_home_is_approved_member(uuid, uuid) SECURITY DEFINER;
ALTER FUNCTION public.fn_home_is_approved_member(uuid, uuid) SET search_path TO 'public';
ALTER FUNCTION public.fn_home_is_approved_member(uuid, uuid) SET row_security TO off;

COMMENT ON FUNCTION public.fn_home_is_group_staff(uuid, uuid) IS
  'RLS helper: is p_caller staff (owner/admin/co_host) of p_group_id. MUST remain SECURITY DEFINER with row_security=off - it is called from 13 RLS policies and reads commander_home_members, which is itself RLS-protected. Reverting to SECURITY INVOKER silently breaks every staff check. See migration phase50_restore_secdef_on_home_rls_helpers.';

COMMENT ON FUNCTION public.fn_home_is_approved_member(uuid, uuid) IS
  'RLS helper: is p_caller an approved member of p_group_id. MUST remain SECURITY DEFINER with row_security=off - SECURITY INVOKER + row_security=off raises 42501 for every authenticated caller. See migration phase50_restore_secdef_on_home_rls_helpers.';

-- ---------- POST-APPLY ASSERTIONS ----------
DO $$
DECLARE
    r          record;
    v_failures text := '';
BEGIN
    FOR r IN
        SELECT p.proname, p.prosecdef, COALESCE(p.proconfig, ARRAY[]::text[]) AS cfg
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('fn_home_is_group_staff','fn_home_is_approved_member')
    LOOP
        IF NOT r.prosecdef THEN
            v_failures := v_failures || format('%s is still SECURITY INVOKER; ', r.proname);
        END IF;
        IF NOT (r.cfg && ARRAY['row_security=off']) THEN
            v_failures := v_failures || format('%s missing row_security=off (cfg=%s); ', r.proname, r.cfg);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM unnest(r.cfg) c WHERE c LIKE 'search_path=%') THEN
            v_failures := v_failures || format('%s missing search_path; ', r.proname);
        END IF;
    END LOOP;

    IF v_failures <> '' THEN
        RAISE EXCEPTION 'POST-APPLY ASSERTION FAILED: %', v_failures;
    END IF;

    RAISE NOTICE 'phase50a OK: both home RLS helpers are SECURITY DEFINER with row_security=off and a pinned search_path.';
END $$;

-- =====================================================================
-- ROLLBACK (paste and run to revert this migration exactly):
--
--   ALTER FUNCTION public.fn_home_is_group_staff(uuid, uuid)     SECURITY INVOKER;
--   ALTER FUNCTION public.fn_home_is_group_staff(uuid, uuid)     RESET row_security;
--   ALTER FUNCTION public.fn_home_is_approved_member(uuid, uuid) SECURITY INVOKER;
--   ALTER FUNCTION public.fn_home_is_approved_member(uuid, uuid) SET row_security TO off;
--
-- NOTE: rolling back restores a KNOWN-BROKEN state (42501 on every
-- authenticated call to fn_home_is_approved_member). Roll back only if this
-- migration causes a worse regression, and re-apply as soon as possible.
-- =====================================================================
