-- RANK THE SURVIVORS HISTORY LEFT BEHIND.
--
-- guard_completed_ranks_survivors (2026-08-28 02:11) ranks survivors in the
-- same statement that flips a tournament to COMPLETED, so no new event can end
-- with a player still holding position NULL. It is a BEFORE UPDATE trigger and
-- it deliberately did not reach backwards: 146 events that finished before it
-- existed still hold 1,013 unranked rows, the oldest from 2026-05-11 and the
-- newest 2026-08-25 (confirmed: nothing has joined the class since the trigger
-- landed, so this is a closed set, not a leak).
--
-- The cost of leaving them is not cosmetic. fn_tournament_payout_reconcile
-- cannot pay a place whose holder is unknown, so it refuses - 146 open critical
-- alerts - and the money simply never went out. Measured across the set:
-- 129 events owe 32,439.50 chips to players who finished in the money.
--
-- This ranks them with fn_rank_survivors, the same function the trigger uses:
-- survivors take the places not already held, ascending, assigned by chips
-- descending. Nobody who already has a position is touched, and the
-- place-collision trigger stays armed throughout - a free place is free.
--
-- IT DOES NOT PAY ANYTHING. Ranking is a record correction and it is separated
-- from the money on purpose, because several of these pools are inflated by
-- guarantees the club never funded. Paying a place out of a pool that does not
-- hold the chips mints them. The payout runs after the funding question is
-- answered, event by event, not as a side effect of this.
--
-- ROLLBACK
--   The affected rows are exactly those in tournament_survivor_rank_backfill.
--   UPDATE tournament_players tp SET position = NULL, status = 'playing'
--     FROM tournament_survivor_rank_backfill b
--    WHERE b.tournament_id = tp.tournament_id AND b.user_id = tp.user_id;

CREATE TABLE IF NOT EXISTS public.tournament_survivor_rank_backfill (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL,
  user_id       uuid NOT NULL,
  new_position  integer NOT NULL,
  new_status    text NOT NULL,
  chips_at_rank numeric,
  ranked_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, user_id)
);

ALTER TABLE public.tournament_survivor_rank_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_survivor_rank_backfill FROM PUBLIC;
GRANT SELECT ON public.tournament_survivor_rank_backfill TO service_role;

CREATE OR REPLACE FUNCTION public.fn_backfill_unranked_survivors(
  p_apply boolean DEFAULT false,
  p_limit integer DEFAULT 1000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record; v_events integer := 0; v_ranked integer := 0;
  v_before integer; v_after integer;
BEGIN
  SELECT count(*) INTO v_before
    FROM public.tournaments t JOIN public.tournament_players tp ON tp.tournament_id = t.id
   WHERE t.status = 'COMPLETED' AND tp.position IS NULL;

  FOR r IN
    SELECT DISTINCT t.id
      FROM public.tournaments t JOIN public.tournament_players tp ON tp.tournament_id = t.id
     WHERE t.status = 'COMPLETED' AND tp.position IS NULL
     LIMIT GREATEST(p_limit, 1)
  LOOP
    v_events := v_events + 1;
    IF p_apply THEN
      -- Record who is about to be ranked, before they are, so the previous
      -- state is reconstructable from the row itself.
      INSERT INTO public.tournament_survivor_rank_backfill
        (tournament_id, user_id, new_position, new_status, chips_at_rank)
      SELECT r.id, tp.user_id, 0, 'pending', tp.chips
        FROM public.tournament_players tp
       WHERE tp.tournament_id = r.id AND tp.position IS NULL
      ON CONFLICT (tournament_id, user_id) DO NOTHING;

      v_ranked := v_ranked + COALESCE(public.fn_rank_survivors(r.id), 0);

      UPDATE public.tournament_survivor_rank_backfill b
         SET new_position = tp.position, new_status = tp.status
        FROM public.tournament_players tp
       WHERE tp.tournament_id = b.tournament_id AND tp.user_id = b.user_id
         AND b.tournament_id = r.id AND b.new_position = 0
         AND tp.position IS NOT NULL;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_after
    FROM public.tournaments t JOIN public.tournament_players tp ON tp.tournament_id = t.id
   WHERE t.status = 'COMPLETED' AND tp.position IS NULL;

  -- Second measurement: the backlog must actually be smaller, not merely
  -- "processed". A pass that reports events touched and leaves the count
  -- unchanged is the failure mode this estate keeps rediscovering.
  RETURN jsonb_build_object('ok', true, 'applied', p_apply,
    'events', v_events, 'rows_ranked', v_ranked,
    'unranked_before', v_before, 'unranked_after', v_after);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_backfill_unranked_survivors(boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_backfill_unranked_survivors(boolean, integer) TO service_role;

DO $post$
BEGIN
  IF to_regprocedure('public.fn_backfill_unranked_survivors(boolean, integer)') IS NULL THEN
    RAISE EXCEPTION 'fn_backfill_unranked_survivors was not created';
  END IF;
  IF to_regclass('public.tournament_survivor_rank_backfill') IS NULL THEN
    RAISE EXCEPTION 'tournament_survivor_rank_backfill was not created';
  END IF;
END
$post$;
