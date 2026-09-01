-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826151326; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

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
