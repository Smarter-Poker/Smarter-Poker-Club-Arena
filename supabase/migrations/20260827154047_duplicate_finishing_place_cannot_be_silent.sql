-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827154047; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- A DUPLICATED FINISHING PLACE CANNOT BE SILENT — 2026-08-27
-- The engine assigned finishing places from a LIVE count of players still
-- playing, which is not monotonic (late reg promotes entrants after
-- eliminations begin), so a later sweep could stamp a place an earlier sweep
-- had already PAID. The wallet key dedupes a repeated USER, not a repeated
-- PLACE, so the second payment went through: 206 duplicated places across 138
-- tournaments, worst case 107% of a prize pool disbursed.
-- The engine fix (free-place walk) prevents it at the source; this is the
-- second lock. NOT a unique index: 206 historical rows would make it
-- un-creatable without rewriting settled results, and a constraint that can
-- REFUSE an elimination could strand a busted player in `playing` forever.
-- Same doctrine as the seat-stack-exit trigger: never block, always be loud.

CREATE TABLE IF NOT EXISTS public.tournament_place_collisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id    uuid NOT NULL,
  place            integer NOT NULL,
  user_id          uuid,
  existing_user_id uuid,
  db_role          text,
  application      text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tournament_place_collisions_tid_idx
  ON public.tournament_place_collisions (tournament_id, created_at DESC);

ALTER TABLE public.tournament_place_collisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_place_collisions FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.trg_tournament_place_collision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_existing uuid;
BEGIN
  IF NEW.position IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.position IS NOT DISTINCT FROM OLD.position THEN
    RETURN NEW;
  END IF;

  SELECT tp.user_id INTO v_existing
    FROM tournament_players tp
   WHERE tp.tournament_id = NEW.tournament_id
     AND tp.position = NEW.position
     AND tp.user_id <> NEW.user_id
   LIMIT 1;

  IF v_existing IS NOT NULL THEN
    INSERT INTO tournament_place_collisions
      (tournament_id, place, user_id, existing_user_id, db_role, application)
    VALUES
      (NEW.tournament_id, NEW.position, NEW.user_id, v_existing,
       current_user, current_setting('application_name', true));
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS tournament_place_collision_watch ON public.tournament_players;
CREATE TRIGGER tournament_place_collision_watch
  BEFORE INSERT OR UPDATE OF position ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_place_collision();

CREATE OR REPLACE FUNCTION public.fn_recent_place_collisions(p_days integer DEFAULT 7)
RETURNS TABLE (out_tournament_id uuid, out_place integer, out_user_id uuid,
               out_existing_user_id uuid, out_created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT c.tournament_id, c.place, c.user_id, c.existing_user_id, c.created_at
    FROM tournament_place_collisions c
   WHERE c.created_at > now() - make_interval(days => greatest(least(coalesce(p_days,7), 90), 1))
   ORDER BY c.created_at DESC;
$fn$;

REVOKE ALL ON FUNCTION public.fn_recent_place_collisions(integer) FROM PUBLIC, anon;
