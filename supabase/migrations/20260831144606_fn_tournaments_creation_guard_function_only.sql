-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831144606; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_tournaments_creation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_paid int;
BEGIN
  IF COALESCE(NEW.max_players, 0) <= 0 THEN
    RAISE EXCEPTION
      'tournament guard: max_players must be positive (got %) - a tournament with no seats can never start',
      NEW.max_players
      USING ERRCODE = '23514';
  END IF;

  IF NEW.payout_structure IS NOT NULL
     AND jsonb_typeof(NEW.payout_structure::jsonb) = 'array' THEN
    v_paid := jsonb_array_length(NEW.payout_structure::jsonb);
    IF v_paid > NEW.max_players THEN
      RAISE EXCEPTION
        'tournament guard: % paid places for % seats - more places than players who can enter',
        v_paid, NEW.max_players
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
