-- Daily Missions realtime contract.
--
-- The page used to subscribe directly to user_daily_challenges, but that table
-- was never in supabase_realtime. The channel successfully joined and then
-- delivered no rows. It also missed the other two inputs to the dashboard:
-- challenge_streak_state and profiles.diamonds.
--
-- Publish one narrow per-user revision instead. Server-side triggers cover all
-- three authoritative inputs, while the client coalesces a transaction's
-- revision burst into one dashboard receipt. No financial/profile row is
-- exposed through this stream.

CREATE TABLE IF NOT EXISTS public.daily_challenge_dashboard_revisions (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.daily_challenge_dashboard_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own daily challenge revision"
  ON public.daily_challenge_dashboard_revisions;
CREATE POLICY "users read own daily challenge revision"
  ON public.daily_challenge_dashboard_revisions
  FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

REVOKE ALL ON TABLE public.daily_challenge_dashboard_revisions FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.daily_challenge_dashboard_revisions TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bump_daily_challenge_dashboard_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid;
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
          updated_at = EXCLUDED.updated_at;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.bump_daily_challenge_dashboard_revision() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_daily_challenge_revision_from_contract
  ON public.user_daily_challenges;
CREATE TRIGGER trg_daily_challenge_revision_from_contract
AFTER INSERT OR UPDATE OR DELETE ON public.user_daily_challenges
FOR EACH ROW EXECUTE FUNCTION public.bump_daily_challenge_dashboard_revision();

DROP TRIGGER IF EXISTS trg_daily_challenge_revision_from_streak
  ON public.challenge_streak_state;
CREATE TRIGGER trg_daily_challenge_revision_from_streak
AFTER INSERT OR UPDATE OR DELETE ON public.challenge_streak_state
FOR EACH ROW EXECUTE FUNCTION public.bump_daily_challenge_dashboard_revision();

DROP TRIGGER IF EXISTS trg_daily_challenge_revision_from_diamonds
  ON public.profiles;
CREATE TRIGGER trg_daily_challenge_revision_from_diamonds
AFTER UPDATE OF diamonds ON public.profiles
FOR EACH ROW
WHEN (OLD.diamonds IS DISTINCT FROM NEW.diamonds)
EXECUTE FUNCTION public.bump_daily_challenge_dashboard_revision();

DO $publication$
BEGIN
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
$publication$;

COMMENT ON TABLE public.daily_challenge_dashboard_revisions IS
'Per-user event cursor for Daily Missions. Realtime clients refetch the atomic dashboard receipt when this changes.';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'daily_challenge_dashboard_revisions'
  ) THEN
    RAISE EXCEPTION 'daily_challenge_dashboard_revisions is not in supabase_realtime';
  END IF;

  IF (
    SELECT count(*) FROM pg_trigger
    WHERE tgname IN (
      'trg_daily_challenge_revision_from_contract',
      'trg_daily_challenge_revision_from_streak',
      'trg_daily_challenge_revision_from_diamonds'
    ) AND NOT tgisinternal
  ) <> 3 THEN
    RAISE EXCEPTION 'Daily Missions revision triggers are incomplete';
  END IF;
END;
$verify$;

NOTIFY pgrst, 'reload schema';
