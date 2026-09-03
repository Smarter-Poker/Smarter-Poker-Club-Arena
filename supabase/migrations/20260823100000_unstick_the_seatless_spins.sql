-- ============================================================================
-- 20260823100000_unstick_the_seatless_spins.sql
-- TIER: 3  |  AFFECTS: tournaments.status, tournament_players, table_seats.
--
-- 12 of 24 open Spins held entrants on the registration list and nobody in a
-- seat. They looked like one fault and were two.
--
-- SHAPE A - ten games that had already PLAYED and were never closed.
--   15 hands dealt, two players eliminated at places 2 and 3, one holding
--   every chip, the reserve settled (contribution + jackpot_draw on the
--   ledger) - and the tournament row still REGISTERING with started_at NULL.
--   So a FINISHED game kept advertising itself on the lobby as a Spin you
--   could join. All ten winners are horses, so no human was owed a prize;
--   the harm was that a human could walk into a finished game, which is
--   exactly what happened.
--   Repair: award the chip leader position 1, mark the tournament COMPLETED,
--   and take it off the board.
--
-- SHAPE B - two games that never started, because nobody was ever SEATED.
--   The past-start top-up had put horses on the registration list only.
--   Repair: seat them, so the ordinary start-when-full rule can fire.
--
-- The distinction matters and is not cosmetic: seating horses into shape A
-- would have re-opened ten games that had already been played and settled.
--
-- ROLLBACK
--   There is none worth having. Shape A games really did finish; shape B games
--   really do have those entrants. Reverting would put finished games back on
--   the lobby.
-- ============================================================================

DO $$
DECLARE
  g record; h record; res jsonb;
  v_closed int := 0; v_seated int := 0; v_games int := 0; v_failed int := 0;
BEGIN
  FOR g IN
    SELECT t.id,
           (SELECT tp.user_id FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id AND tp.status = 'playing'
             ORDER BY tp.chips DESC LIMIT 1) AS winner,
           (SELECT min(tp.eliminated_at) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS first_out
      FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.status IN ('REGISTERING','ANNOUNCED')
       AND t.spin_multiplier IS NOT NULL
       AND (SELECT count(*) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id AND tp.status = 'eliminated') >= 2
  LOOP
    IF g.winner IS NULL THEN CONTINUE; END IF;
    UPDATE public.tournament_players
       SET status = 'winner', position = 1
     WHERE tournament_id = g.id AND user_id = g.winner;
    UPDATE public.tournaments
       SET status = 'COMPLETED',
           started_at = COALESCE(started_at, g.first_out),
           current_players = (SELECT count(*) FROM public.tournament_players tp
                               WHERE tp.tournament_id = g.id)
     WHERE id = g.id;
    v_closed := v_closed + 1;
  END LOOP;

  FOR g IN
    SELECT t.id FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.status IN ('REGISTERING','ANNOUNCED')
       AND EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = t.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
          WHERE tb.tournament_id = t.id AND ts.left_at IS NULL)
  LOOP
    v_games := v_games + 1;
    FOR h IN
      SELECT tp.user_id FROM public.tournament_players tp
       WHERE tp.tournament_id = g.id ORDER BY tp.registered_at
    LOOP
      res := public.fn_seat_horse_in_seat_first_game(g.id, h.user_id);
      IF COALESCE((res->>'ok')::boolean, false) THEN v_seated := v_seated + 1;
      ELSE v_failed := v_failed + 1; RAISE WARNING 'could not seat % in %: %', h.user_id, g.id, res;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'closed % played game(s); seated % horse(s) across % stalled game(s), % refused',
    v_closed, v_seated, v_games, v_failed;

  IF EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE t.variant = 'spin' AND t.status IN ('REGISTERING','ANNOUNCED')
       AND EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = t.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
          WHERE tb.tournament_id = t.id AND ts.left_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'a Spin is still advertising itself with entrants and no seats';
  END IF;
END $$;

-- ============================================================================
-- APPLY HISTORY
-- Applied to production 2026-08-23 as
-- `close_the_played_spins_and_seat_the_stalled_ones`. Open Spins went 24 -> 15
-- with 0 deadlocked and 13 genuinely open.
-- ============================================================================
