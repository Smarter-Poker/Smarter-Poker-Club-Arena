-- Move the Daily Missions refresh signal from Postgres Changes to a private
-- per-player Broadcast topic. The durable revision row remains the missed-frame
-- repair cursor, but it no longer adds every mission mutation to the shared
-- supabase_realtime logical-decoding backlog.

BEGIN;

SET LOCAL lock_timeout = '4s';

DROP POLICY IF EXISTS "users receive own daily mission revision broadcasts"
  ON realtime.messages;
CREATE POLICY "users receive own daily mission revision broadcasts"
  ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND (SELECT realtime.topic()) =
      'daily-mission-revision:' || (SELECT auth.uid())::text
  );

CREATE OR REPLACE FUNCTION public.bump_daily_challenge_dashboard_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid;
  v_revision bigint;
BEGIN
  IF TG_TABLE_NAME = 'profiles' THEN
    v_user_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
  ELSE
    v_user_id := NEW.user_id;
  END IF;

  IF v_user_id IS NOT NULL THEN
    INSERT INTO public.daily_challenge_dashboard_revisions (user_id, revision, updated_at)
    VALUES (v_user_id, 1, clock_timestamp())
    ON CONFLICT (user_id) DO UPDATE
      SET revision = public.daily_challenge_dashboard_revisions.revision + 1,
          updated_at = EXCLUDED.updated_at
    RETURNING revision INTO v_revision;

    -- Broadcast is the immediate path. A send failure must never roll back the
    -- mission or economy mutation because the persisted cursor is the repair
    -- path on the next visible-tab check.
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('revision', v_revision),
        'daily_mission_revision_changed',
        'daily-mission-revision:' || v_user_id::text,
        true
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Daily Mission revision broadcast failed: %', SQLERRM;
    END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.bump_daily_challenge_dashboard_revision()
  FROM PUBLIC, anon;

DO $publication$
BEGIN
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
END;
$publication$;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'daily_challenge_dashboard_revisions'
  ) THEN
    RAISE EXCEPTION 'Daily Missions revision cursor still uses Postgres Changes';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_policies
     WHERE schemaname = 'realtime'
       AND tablename = 'messages'
       AND policyname = 'users receive own daily mission revision broadcasts'
       AND cmd = 'SELECT'
       AND roles = ARRAY['authenticated']::name[]
  ) THEN
    RAISE EXCEPTION 'Daily Missions private Broadcast read policy is missing';
  END IF;

  IF (
    SELECT pg_get_functiondef(p.oid)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'bump_daily_challenge_dashboard_revision'
       AND p.pronargs = 0
  ) NOT LIKE '%daily_mission_revision_changed%' THEN
    RAISE EXCEPTION 'Daily Missions revision trigger does not Broadcast';
  END IF;
END;
$verify$;

COMMENT ON TABLE public.daily_challenge_dashboard_revisions IS
'Durable per-player Daily Missions revision cursor. Private Broadcast provides the immediate refresh signal.';

COMMIT;
