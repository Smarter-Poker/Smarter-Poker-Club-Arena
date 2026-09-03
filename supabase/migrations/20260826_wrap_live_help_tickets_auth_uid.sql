-- TIER 2. Two policy expressions. Semantics unchanged. Applied to production 2026-08-26.
--
-- The earlier auth_rls_initplan sweep missed these because every check searched
-- for auth.uid()/jwt()/role() only. The advisor also counts current_setting(),
-- and these two were the last bare auth.uid() calls by its definition.
--
-- ALTER POLICY, not DROP + CREATE, so roles/cmd/permissive survive and the table
-- is never briefly unprotected. fn_is_platform_admin() is left alone: it takes
-- no argument and is not re-evaluated per row the way a bare auth.uid() is.
--
-- VERIFIED AFTER APPLY: anon GET /live_help_tickets returns HTTP 200 [] -- RLS
-- still denies, the policy change did not open or break access.
--
-- ROLLBACK: re-run with (SELECT auth.uid()) changed back to auth.uid().

ALTER POLICY live_help_tickets_select ON public.live_help_tickets
USING (((SELECT auth.uid()) = user_id) OR fn_is_platform_admin());

ALTER POLICY live_help_tickets_update ON public.live_help_tickets
USING (((SELECT auth.uid()) = user_id) OR fn_is_platform_admin())
WITH CHECK (((SELECT auth.uid()) = user_id) OR fn_is_platform_admin());

DO $$
DECLARE v_bare int;
BEGIN
  SELECT count(*) INTO v_bare FROM pg_policies
   WHERE schemaname='public'
     AND (coalesce(qual,'')||' '||coalesce(with_check,'')) ~* '(?<!select )auth\\.(uid|jwt|role)\\(\\)';
  IF v_bare > 0 THEN
    RAISE EXCEPTION 'assertion failed: % policy expression(s) still call auth.*() unwrapped', v_bare;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='live_help_tickets') <> 3 THEN
    RAISE EXCEPTION 'assertion failed: live_help_tickets should still have exactly 3 policies';
  END IF;
  RAISE NOTICE 'live_help_tickets: both policies wrapped, 3 policies intact';
END $$;
