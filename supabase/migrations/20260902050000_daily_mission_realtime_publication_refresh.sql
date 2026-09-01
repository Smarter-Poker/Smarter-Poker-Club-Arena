-- Production held the correct publication catalog row, RLS policy, trigger
-- coverage, and replica identity while new subscribers still received no
-- Daily Missions revision changes. Refresh the table membership so the
-- Realtime tenant reloads this relation instead of retaining the stale
-- publication state.

BEGIN;

SET LOCAL lock_timeout = '4s';

DO $refresh$
BEGIN
  IF to_regclass('public.daily_challenge_dashboard_revisions') IS NULL THEN
    RAISE EXCEPTION 'Daily Challenge Dashboard Revisions Must Exist Before Realtime Refresh';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE EXCEPTION 'Supabase Realtime Publication Is Missing';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'daily_challenge_dashboard_revisions'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      DROP TABLE public.daily_challenge_dashboard_revisions;
  END IF;

  ALTER PUBLICATION supabase_realtime
    ADD TABLE public.daily_challenge_dashboard_revisions;
END;
$refresh$;

ALTER TABLE public.daily_challenge_dashboard_revisions REPLICA IDENTITY FULL;

REVOKE ALL ON TABLE public.daily_challenge_dashboard_revisions
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.daily_challenge_dashboard_revisions
  TO authenticated, service_role;

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'daily_challenge_dashboard_revisions'
  ) THEN
    RAISE EXCEPTION 'Daily Missions Realtime Publication Refresh Did Not Stick';
  END IF;

  IF (
    SELECT count(*)
      FROM pg_trigger
     WHERE tgname IN (
       'trg_daily_challenge_revision_from_contract',
       'trg_daily_challenge_revision_from_streak',
       'trg_daily_challenge_revision_from_diamonds'
     )
       AND tgenabled <> 'D'
       AND NOT tgisinternal
  ) <> 3 THEN
    RAISE EXCEPTION 'Daily Missions Revision Trigger Coverage Is Incomplete';
  END IF;

  IF has_table_privilege('authenticated',
      'public.daily_challenge_dashboard_revisions', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Authenticated Browsers Retained A Daily Missions Revision Write Grant';
  END IF;
END;
$verify$;

COMMIT;
