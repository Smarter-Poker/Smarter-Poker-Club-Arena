-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260812221123 "phase50b_restore_home_members_host_sees_group_select_policy"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a401a1a4049f7c8972114499f43cb39f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =====================================================================
-- Phase 50b — Restore staff visibility of the home group roster
--
-- WHY: policy `home_members_host_sees_group`, applied by
-- 20260419224823_phase37_fix_rls_recursion_home_members, is ABSENT from
-- production and is dropped by no migration in schema_migrations. In its
-- place sits `Enable users to view their own data only`, the Supabase
-- dashboard's default template policy, created by hand.
--
-- RESULTING BUG (verified 2026-08-12): on commander_home_members the
-- INSERT / UPDATE / DELETE policies all read
--     user_id = auth.uid() OR fn_home_is_group_staff(auth.uid(), group_id)
-- but SELECT reads only
--     auth.uid() = user_id
-- so a host can UPDATE and DELETE roster rows they are not permitted to
-- SEE. Any direct PostgREST roster read returns exactly one row (self),
-- which is why host-facing roster surfaces come back empty.
--
-- ORDERING (critical): this migration MUST run AFTER
-- phase50_restore_secdef_on_home_rls_helpers. The new policy calls
-- fn_home_is_group_staff, which reads commander_home_members - the very
-- table being protected. If that helper is not SECURITY DEFINER with
-- row_security=off, this policy either recurses or silently returns false
-- for every caller, making the roster MORE broken, not less. The
-- pre-flight below hard-blocks that ordering mistake.
--
-- SCOPE: deliberately mirrors the three sibling policies exactly
-- (self OR staff). It does NOT grant approved members visibility of each
-- other; that would be a privacy expansion and is a separate product
-- decision, not a restoration.
--
-- Tier 3 (RLS policy change). ROLLBACK at the bottom.
-- =====================================================================

-- ---------- PRE-FLIGHT ----------
DO $$
BEGIN
    -- Hard-block the ordering hazard.
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.proname='fn_home_is_group_staff'
          AND p.prosecdef
          AND COALESCE(p.proconfig, ARRAY[]::text[]) && ARRAY['row_security=off']
    ) THEN
        RAISE EXCEPTION
          'PRE-FLIGHT FAILED: fn_home_is_group_staff is not SECURITY DEFINER with row_security=off. Apply phase50_restore_secdef_on_home_rls_helpers FIRST or this policy will silently deny every staff read.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='public' AND c.relname='commander_home_members' AND c.relrowsecurity) THEN
        RAISE EXCEPTION 'PRE-FLIGHT FAILED: RLS is not enabled on commander_home_members';
    END IF;
END $$;

-- ---------- APPLY ----------
-- Idempotent: safe to re-run.
DROP POLICY IF EXISTS "home_members_host_sees_group"          ON public.commander_home_members;
DROP POLICY IF EXISTS "Enable users to view their own data only" ON public.commander_home_members;

CREATE POLICY "home_members_host_sees_group"
    ON public.commander_home_members
    FOR SELECT
    USING (
        user_id = (SELECT auth.uid())
        OR fn_home_is_group_staff((SELECT auth.uid()), group_id)
    );

COMMENT ON TABLE public.commander_home_members IS
  'Home group roster. SELECT is governed by home_members_host_sees_group (self OR group staff), matching the INSERT/UPDATE/DELETE policies. Do NOT replace this with the Supabase dashboard default "Enable users to view their own data only" - doing so makes hosts unable to read a roster they can still write to. See migration phase50b.';

-- ---------- POST-APPLY ASSERTIONS ----------
DO $$
DECLARE
    v_select_policies int;
    v_qual            text;
BEGIN
    SELECT COUNT(*) INTO v_select_policies
    FROM pg_policies
    WHERE schemaname='public' AND tablename='commander_home_members' AND cmd='SELECT';

    IF v_select_policies <> 1 THEN
        RAISE EXCEPTION 'POST-APPLY FAILED: expected exactly 1 SELECT policy on commander_home_members, found %', v_select_policies;
    END IF;

    SELECT qual INTO v_qual
    FROM pg_policies
    WHERE schemaname='public' AND tablename='commander_home_members'
      AND policyname='home_members_host_sees_group' AND cmd='SELECT';

    IF v_qual IS NULL OR v_qual NOT LIKE '%fn_home_is_group_staff%' THEN
        RAISE EXCEPTION 'POST-APPLY FAILED: restored policy does not reference fn_home_is_group_staff (qual=%)', v_qual;
    END IF;

    -- Guard against the dashboard default creeping back in.
    IF EXISTS (SELECT 1 FROM pg_policies
               WHERE schemaname='public' AND tablename='commander_home_members'
                 AND policyname='Enable users to view their own data only') THEN
        RAISE EXCEPTION 'POST-APPLY FAILED: dashboard default policy still present';
    END IF;

    RAISE NOTICE 'phase50b OK: roster SELECT restored to (self OR staff).';
END $$;

-- =====================================================================
-- ROLLBACK:
--   DROP POLICY IF EXISTS "home_members_host_sees_group" ON public.commander_home_members;
--   CREATE POLICY "Enable users to view their own data only"
--       ON public.commander_home_members FOR SELECT TO authenticated
--       USING ((SELECT auth.uid()) = user_id);
--
-- NOTE: rolling back re-breaks host roster reads. Prefer forward fixes.
-- =====================================================================
