-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260823042107 as "no_more_entrants_than_seats"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- See supabase/migrations/20260823070000_no_more_entrants_than_seats.sql
-- (Club Arena) for the full rationale.

CREATE OR REPLACE FUNCTION public.fn_enforce_tournament_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_max int;
  v_have int;
  v_name text;
BEGIN
  SELECT max_players, name INTO v_max, v_name
    FROM public.tournaments WHERE id = NEW.tournament_id;

  -- No declared capacity means no capacity to exceed (open MTTs).
  IF v_max IS NULL OR v_max <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_have
    FROM public.tournament_players
   WHERE tournament_id = NEW.tournament_id;

  IF v_have >= v_max THEN
    RAISE EXCEPTION
      'tournament_full: % already has % of % entrants', COALESCE(v_name, NEW.tournament_id::text), v_have, v_max
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.fn_enforce_tournament_capacity() IS
  'Refuses an entrant beyond tournaments.max_players. fn_register_for_tournament already checked capacity, but against the DENORMALISED tournaments.current_players counter - and the rows that filled one 3-max Spin were inserted without going through that function, so the counter never saw them and a 4th player was sold a seat. Counting rows is the only check that binds every path.';

DROP TRIGGER IF EXISTS trg_enforce_tournament_capacity ON public.tournament_players;
CREATE TRIGGER trg_enforce_tournament_capacity
  BEFORE INSERT ON public.tournament_players
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_tournament_capacity();

-- ── Post-apply assertions ───────────────────────────────────────────────────
DO $$
DECLARE v_bad int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.tournament_players'::regclass
       AND tgname = 'trg_enforce_tournament_capacity'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'trg_enforce_tournament_capacity was not created';
  END IF;

  SELECT count(*) INTO v_bad
    FROM (
      SELECT t.id
        FROM public.tournaments t
        JOIN public.tournament_players tp ON tp.tournament_id = t.id
       WHERE t.max_players IS NOT NULL AND t.max_players > 0
       GROUP BY t.id, t.max_players
      HAVING count(tp.user_id) > t.max_players
    ) x;

  IF v_bad > 1 THEN
    RAISE EXCEPTION 'expected at most the one known over-filled tournament, found %', v_bad;
  END IF;
END $$;
