-- Daily Missions revision publication repair.
--
-- 20260831130000 was accidentally used by TWO migration files. Supabase
-- migration history identifies a migration by that numeric version, so one
-- file can be marked applied while the sibling never runs. Production reached
-- exactly that split state: the revision table, RLS policy and triggers exist,
-- but pg_publication_tables has no daily_challenge_dashboard_revisions row.
-- A joined client channel therefore reported SUBSCRIBED and received nothing.
--
-- Repeat the publication contract under a unique version. This migration is
-- deliberately idempotent so it repairs both the split state and a fresh
-- database safely.

BEGIN;

DO $repair$
BEGIN
  IF to_regclass('public.daily_challenge_dashboard_revisions') IS NULL THEN
    RAISE EXCEPTION 'daily_challenge_dashboard_revisions must exist before publication repair';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE EXCEPTION 'supabase_realtime publication is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'daily_challenge_dashboard_revisions'
  ) THEN
    ALTER PUBLICATION supabase_realtime
      ADD TABLE public.daily_challenge_dashboard_revisions;
  END IF;
END;
$repair$;

-- The row is tiny and per-user. FULL ensures Realtime has the complete old
-- tuple needed to evaluate a filtered UPDATE under RLS on every supported
-- Realtime/Postgres combination.
ALTER TABLE public.daily_challenge_dashboard_revisions REPLICA IDENTITY FULL;

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
    RAISE EXCEPTION 'daily_challenge_dashboard_revisions publication repair did not stick';
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
    RAISE EXCEPTION 'Daily Missions revision publication has incomplete trigger coverage';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'daily_challenge_dashboard_revisions'
       AND policyname = 'users read own daily challenge revision'
       AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'Daily Missions revision publication has no private SELECT policy';
  END IF;
END;
$verify$;

COMMIT;
