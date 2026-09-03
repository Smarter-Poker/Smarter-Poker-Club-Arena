-- Applied to production 2026-09-02 as schema_migrations version 20260902010432.
--
-- Fix-first. fn_rls_policies_with_unhoisted_auth() - the guard shipped hours ago in
-- 20260901122257 - reported ONE policy again, having reported zero when it landed:
--
--   game_management_events / game_management_events_authorized_read / 3 bare calls
--
-- This is the guard doing the job it was written for. Section 10.8's history is
-- that this lint had been "fixed" seven times by sweep and came back every time,
-- because nothing stopped the NEXT policy being written bare. This is the next
-- policy, written bare, caught the same day instead of in a month.
--
-- It matters more than the fifteen the original sweep fixed: game_management_events
-- took 42,069 writes in a measured 4h55m window, 4.6% of everything in the
-- supabase_realtime publication. It is live and growing, not peripheral.
--
-- v2. The first attempt DEADLOCKED and rolled back whole, changing nothing:
--   40P01 ... waits for AccessExclusiveLock on relation 16907; blocked by a
--   process waiting for AccessShareLock on 18670564.
-- ALTER POLICY takes ACCESS EXCLUSIVE on the table, and on a table taking ~8,500
-- writes an hour that lock has to be taken carefully rather than queued: a queued
-- ACCESS EXCLUSIVE blocks every reader that arrives behind it, which is how a
-- one-line policy edit becomes an outage. lock_timeout makes this fail in three
-- seconds instead of waiting, so a busy moment costs a retry and nothing else.
--
-- auth.uid() reads a session GUC and cannot vary by row, so wrapping it as
-- (SELECT auth.uid()) makes it an InitPlan evaluated once per query instead of
-- once per row. The three OR arms, the command, the role list and the semantics
-- are otherwise untouched.
--
-- ROLLBACK: re-run this ALTER with "(SELECT auth.uid())" replaced by "auth.uid()".

SET LOCAL lock_timeout = '3s';

ALTER POLICY game_management_events_authorized_read ON public.game_management_events
  USING (
    (recipient_id = (SELECT auth.uid()))
    OR ((scope_kind = 'club'::text)  AND fn_can_create_games(scope_id, (SELECT auth.uid())))
    OR ((scope_kind = 'union'::text) AND fn_is_union_operator(scope_id, (SELECT auth.uid())))
  );

DO $$
DECLARE v_n int; v_cmd text; v_roles text; v_qual text;
BEGIN
  SELECT count(*) INTO v_n FROM public.fn_rls_policies_with_unhoisted_auth();
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'guard still reports % policies calling auth.* bare; expected 0', v_n;
  END IF;

  SELECT cmd, roles::text, qual INTO v_cmd, v_roles, v_qual
    FROM pg_policies
   WHERE schemaname='public' AND tablename='game_management_events'
     AND policyname='game_management_events_authorized_read';

  IF v_cmd <> 'SELECT' OR v_roles <> '{authenticated}' THEN
    RAISE EXCEPTION 'policy shape changed: cmd=% roles=% (expected SELECT / {authenticated})',
      v_cmd, v_roles;
  END IF;

  -- all three arms must still be present; a hoist must not drop an arm
  IF v_qual NOT LIKE '%recipient_id%'
     OR v_qual NOT LIKE '%fn_can_create_games%'
     OR v_qual NOT LIKE '%fn_is_union_operator%' THEN
    RAISE EXCEPTION 'an authorisation arm went missing from the policy: %', v_qual;
  END IF;
END $$;
