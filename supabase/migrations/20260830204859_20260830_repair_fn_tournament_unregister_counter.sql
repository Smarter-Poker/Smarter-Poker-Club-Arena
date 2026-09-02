-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830204859; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_tournament_unregister_counter has never worked. It updated
-- tournaments.registered_count, a column that does not exist on that table, so
-- every call raised 42703 and rolled back whatever transaction it was in.
--
-- Found 2026-08-30 when a satellite-seat settlement called it and the whole
-- migration aborted. Verified there are ZERO callers in either repo, so it has
-- silently never run in production — which is the only reason the unregister
-- flows are not already corrupt.
--
-- Repaired rather than dropped: it is the obvious thing to reach for when
-- writing an unregister path, and leaving a landmine named
-- "unregister_counter" for the next person is worse than either fixing or
-- removing it. It now maintains the columns that actually exist:
--
--   current_players  the entrant count the lobby shows and the capacity guard
--                    in fn_award_satellite_seat compares against max_players.
--                    Floored at 0, never negative.
--   prize_pool       reduced by the buy-in the leaving player contributed.
--                    Floored at 0 so a bad p_buy_in cannot invert the pool.
--
-- It does NOT refund — atomic_tournament_unregister owns the money and the
-- tournament_players row. This only corrects the counters, and returns the
-- new count so a caller can assert on it.

CREATE OR REPLACE FUNCTION public.fn_tournament_unregister_counter(
  p_tournament_id uuid,
  p_buy_in        numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_count integer;
BEGIN
  UPDATE tournaments
     SET current_players = GREATEST(COALESCE(current_players, 0) - 1, 0),
         prize_pool      = GREATEST(COALESCE(prize_pool, 0) - COALESCE(p_buy_in, 0), 0),
         updated_at      = NOW()
   WHERE id = p_tournament_id
   RETURNING COALESCE(current_players, 0) INTO v_count;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'tournament not found');
  END IF;

  RETURN jsonb_build_object('success', true, 'current_players', v_count);
END;
$fn$;
