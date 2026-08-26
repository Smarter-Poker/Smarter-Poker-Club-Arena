-- 20260826_wrap_live_comments_auth_uid.sql
--
-- TIER 2. One policy expression. Semantics unchanged.
--
-- CONTEXT
-- The auth_rls_initplan sweep (wrapping auth.uid() as (SELECT auth.uid()) so the
-- planner hoists it to an InitPlan and evaluates it ONCE per query instead of
-- once per row) is otherwise complete: 923 of 1,417 public policies reference
-- auth.*, and every one of them is already wrapped.
--
-- Except this one. public.live_comments / lc_sel wraps four of its five
-- occurrences and leaves the first bare:
--
--     ((auth.uid() IS NULL) OR (( SELECT auth.uid() AS uid) = user_id) OR ...
--       ^^^^^^^^^^ bare -- re-evaluated per row
--
-- The bare call is in the FIRST disjunct, so it is evaluated for every candidate
-- row before any cheaper branch can short-circuit it.
--
-- ALTER POLICY (not DROP + CREATE) so roles, cmd and permissive are preserved
-- and there is no window in which the table sits unprotected.
--
-- ROLLBACK: re-run this statement with `((SELECT auth.uid()) IS NULL)` changed
-- back to `(auth.uid() IS NULL)`.

ALTER POLICY lc_sel ON public.live_comments
USING (
  ((SELECT auth.uid()) IS NULL)
  OR ((SELECT auth.uid()) = user_id)
  OR (EXISTS (
        SELECT 1 FROM public.live_streams s
         WHERE s.id = live_comments.stream_id
           AND s.broadcaster_id = (SELECT auth.uid())))
  OR (
       NOT EXISTS (
         SELECT 1 FROM public.blocked_users b
          WHERE b.blocker_id = (SELECT auth.uid())
            AND b.blocked_id = live_comments.user_id)
       AND
       NOT EXISTS (
         SELECT 1 FROM public.blocked_users b
          WHERE b.blocker_id = live_comments.user_id
            AND b.blocked_id = (SELECT auth.uid()))
     )
);

-- Post-apply assertion: zero bare auth.*() calls remain anywhere in public.
DO $$
DECLARE v_bare int;
BEGIN
  SELECT count(*) INTO v_bare
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ~* '(?<!select )auth\.(uid|jwt|role)\(\)';

  IF v_bare > 0 THEN
    RAISE EXCEPTION 'assertion failed: % policy expression(s) still call auth.*() unwrapped', v_bare;
  END IF;

  RAISE NOTICE 'auth_rls_initplan: 0 unwrapped auth.*() calls remain in schema public';
END $$;
