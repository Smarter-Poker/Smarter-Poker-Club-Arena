-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260823043153 "close_the_played_spins_and_seat_the_stalled_ones"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e9f621c5a90fcd47ba0dc522dd46c1a8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- See supabase/migrations/20260823100000_unstick_the_seatless_spins.sql
-- (Club Arena) for the full rationale.
--
-- 12 of 24 open Spins had entrants on the registration list and nobody in a
-- seat. They are two different faults wearing the same symptom.

DO $$
DECLARE
  g record; h record; res jsonb;
  v_closed int := 0; v_seated int := 0; v_games int := 0; v_failed int := 0;
BEGIN
  -- ── SHAPE A: it already PLAYED and was never closed ──────────────────────
  -- 15 hands dealt, two players eliminated at places 2 and 3, one holding
  -- every chip, the reserve already settled - and the tournament row still
  -- REGISTERING with started_at NULL. So a finished game kept advertising
  -- itself on the lobby as a Spin you could join, which is how a human walked
  -- into one and became its fourth entrant.
  FOR g IN
    SELECT t.id,
           (SELECT tp.user_id FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id AND tp.status = 'playing'
             ORDER BY tp.chips DESC LIMIT 1) AS winner,
           (SELECT max(tp.eliminated_at) FROM public.tournament_players tp
             WHERE tp.tournament_id = t.id) AS last_out,
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

  -- ── SHAPE B: it never started, because nobody was ever SEATED ────────────
  -- Horses were put on the registration list by the past-start top-up, which
  -- writes tournament_players and nothing else. A seat-first game starts when
  -- every SEAT is sold, so these could never start and showed three open seats
  -- each. Seat them and the ordinary start rule can fire.
  FOR g IN
    SELECT t.id
      FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.status IN ('REGISTERING','ANNOUNCED')
       AND EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = t.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.table_seats ts
           JOIN public.tables tb ON tb.id = ts.table_id
          WHERE tb.tournament_id = t.id AND ts.left_at IS NULL)
  LOOP
    v_games := v_games + 1;
    FOR h IN
      SELECT tp.user_id FROM public.tournament_players tp
       WHERE tp.tournament_id = g.id ORDER BY tp.registered_at
    LOOP
      res := public.fn_seat_horse_in_seat_first_game(g.id, h.user_id);
      IF COALESCE((res->>'ok')::boolean, false) THEN
        v_seated := v_seated + 1;
      ELSE
        v_failed := v_failed + 1;
        RAISE WARNING 'could not seat % in %: %', h.user_id, g.id, res;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'closed % played game(s); seated % horse(s) across % stalled game(s), % refused',
    v_closed, v_seated, v_games, v_failed;

  -- No Spin may be open for registration while holding entrants nobody seated.
  IF EXISTS (
    SELECT 1 FROM public.tournaments t
     WHERE t.variant = 'spin'
       AND t.status IN ('REGISTERING','ANNOUNCED')
       AND EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = t.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.table_seats ts
           JOIN public.tables tb ON tb.id = ts.table_id
          WHERE tb.tournament_id = t.id AND ts.left_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'a Spin is still advertising itself with entrants and no seats';
  END IF;
END $$;
