-- 20260927001446_scoped_achievement_and_commission_history_reads.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Browser progress reads silently returned zero rows because achievements had
-- no SELECT policy. Commission history had only its service-role policy.
-- The existing financial page and ca_can_view_club_finances define the intended
-- staff scope: finance members except banned/suspended, direct club owners,
-- profiles.is_admin and platform administrator roles. A NULL member status
-- keeps the helper's existing active default; an owner retains its override.
-- Use that maintained authority for both histories; ordinary players cannot
-- see either history and a player sees only their own achievement progress.
-- No writes, rewards, grants, Realtime publication or financial rules change.

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '8s';
SET LOCAL search_path = public, pg_temp;
DO $preflight$
BEGIN
  IF (SELECT count(*) FROM pg_class WHERE oid IN (
      'public.training_user_achievements'::regclass,
      'public.commission_rate_audit'::regclass,
      'public.rake_rate_audit'::regclass)
      AND relkind='r' AND relrowsecurity AND NOT relforcerowsecurity
      AND relowner='postgres'::regrole) <> 3
     OR EXISTS (SELECT FROM pg_policies WHERE schemaname='public'
       AND tablename='training_user_achievements')
     OR (SELECT count(*) FROM pg_policies WHERE schemaname='public'
       AND tablename='commission_rate_audit') <> 1
     OR NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public'
       AND tablename='commission_rate_audit' AND cmd='ALL'
       AND policyname='commission_rate_audit_service_role_all' AND permissive='PERMISSIVE'
       AND roles=ARRAY['service_role']::name[] AND qual='true' AND with_check='true')
     OR (SELECT count(*) FROM pg_policies WHERE schemaname='public'
       AND tablename='rake_rate_audit') <> 2
     OR NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public'
       AND tablename='rake_rate_audit' AND policyname='rake_rate_audit_service_role_all'
       AND cmd='ALL' AND permissive='PERMISSIVE'
       AND roles=ARRAY['service_role']::name[] AND qual='true' AND with_check='true')
     OR NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public'
       AND tablename='rake_rate_audit' AND policyname='rake_rate_audit_club_admin_read'
       AND cmd='SELECT' AND permissive='PERMISSIVE' AND with_check IS NULL
       AND roles=ARRAY['authenticated']::name[]
       AND md5(qual)='917327a7b30ff645f7e6c479bde62322')
     OR md5(pg_get_functiondef(to_regprocedure('public.ca_can_view_club_finances(uuid)')))
       IS DISTINCT FROM 'fae59a344dc9040e81cda02fb9fee97f'
     OR md5(pg_get_functiondef(to_regprocedure('public.fn_is_platform_admin()')))
       IS DISTINCT FROM 'ed89787c7b832e76a886734e16a27c3d'
  THEN RAISE EXCEPTION 'SCOPED_AUDIT_READ_PREIMAGE_DRIFT' USING ERRCODE='55000';
  END IF;
END
$preflight$;

CREATE POLICY training_achievements_owner_read
  ON public.training_user_achievements FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY commission_rate_audit_finance_read
  ON public.commission_rate_audit FOR SELECT TO authenticated
  USING (public.ca_can_view_club_finances(club_id) OR (SELECT public.fn_is_platform_admin()));

DROP POLICY rake_rate_audit_club_admin_read ON public.rake_rate_audit;
CREATE POLICY rake_rate_audit_finance_read
  ON public.rake_rate_audit FOR SELECT TO authenticated
  USING (public.ca_can_view_club_finances(club_id) OR (SELECT public.fn_is_platform_admin()));

COMMIT;
