-- 20260906234126_a_threshold_nobody_checks_is_a_setting_that_does_nothing.sql
--
-- Named for the version the Supabase MCP recorded when it applied this, so a
-- rebuild from these files records the same version the database has.
--
-- BBJ phase 3.4, second half: SCHEDULE the sender.
-- A threshold nobody checks is a setting that does nothing, so the schedule is
-- part of the feature and the assertions below refuse to pass without it.
-- Five minutes: the thing being announced took a fortnight to happen, so this
-- is about not making a player wait an hour to hear it, not about precision.
-- The advisory lock is this database's house pattern for a periodic job (see
-- ca-quick-reconcile-5m and forty others) so a slow run never stacks up.
BEGIN;

SELECT cron.unschedule('ca-bbj-threshold-notify-5m')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-bbj-threshold-notify-5m');

SELECT cron.schedule(
  'ca-bbj-threshold-notify-5m',
  '*/5 * * * *',
  $cron$
  SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-bbj-threshold-notify'))
              THEN (SELECT public.fn_bbj_notify_thresholds()::text)
              ELSE 'locked' END;
  SELECT pg_advisory_unlock(hashtext('ca-bbj-threshold-notify'));
  $cron$
);

DO $$
DECLARE v_bad text;
BEGIN
  IF to_regclass('public.bbj_notify_thresholds') IS NULL
     OR to_regclass('public.bbj_threshold_crossings') IS NULL THEN
    RAISE EXCEPTION 'the threshold tables were not created';
  END IF;

  IF has_function_privilege('anon', 'public.fn_bbj_notify_thresholds()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_bbj_notify_thresholds()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can execute the notification sender';
  END IF;

  SELECT string_agg(grantee || ':' || privilege_type, ', ') INTO v_bad
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('bbj_notify_thresholds', 'bbj_threshold_crossings')
     AND grantee = 'anon';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'anon can still reach the threshold tables: %', v_bad;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-bbj-threshold-notify-5m' AND active) THEN
    RAISE EXCEPTION 'the sender is not scheduled - a threshold nobody checks is a setting that does nothing';
  END IF;
END $$;

COMMIT;
