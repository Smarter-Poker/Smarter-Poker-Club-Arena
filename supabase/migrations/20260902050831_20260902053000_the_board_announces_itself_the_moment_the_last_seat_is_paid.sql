-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902050831; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  THE BOARD ANNOUNCES ITSELF THE MOMENT THE LAST SEAT IS PAID
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan's rule: the wheel plays one second after the last buy-in, three at the
-- outside. It has been taking eleven to twenty-four, and the reason is not the
-- draw, the settle or the animation. It is that nothing TELLS the engine the
-- board is full - the engine goes looking, on a loop that calls itself a
-- one-second poll and is not one.
--
-- Measured on production, through the same PostgREST path the engine uses,
-- for a single pass of GameServer.discoverSeatFirstStarts:
--
--   REGISTERING seat-first tournaments .............  0.475 s
--   their live tables, .in(tournament_id, 85 uuids)   4.029 s
--   their live seats ...............................  0.944 s
--                                                    -------
--                                          per pass   5.448 s
--
-- so the real cadence is about six and a half seconds and a board that fills
-- just after a pass waits a whole cycle. Four Spins seen filling within
-- seconds of one another drew eight seconds apart, in a queue.
--
-- I first collapsed those three round trips into one RPC
-- (fn_seat_first_boards_ready): 76 ms inside the database against 5.448 s for
-- the three calls. Then I measured the RPC through PostgREST and got 1.9 s,
-- 10.0 s and 4.1 s on three consecutive calls. THAT is the finding that
-- settles the design: the query is no longer the cost, the ROUND TRIP is, and
-- no polling loop over that transport can honour a one-second promise.
--
-- So the board stops being discovered and starts announcing itself. The
-- instant the seat that fills it is committed, this broadcasts on a topic the
-- engine holds open, and the engine starts that game immediately instead of
-- waiting to notice.
--
-- WHERE: fn_sync_seat_first_player_count, which both seating paths already
-- call - fn_take_seat_and_buy_in for a human, fn_seat_horse_in_seat_first_game
-- for a horse. The same hook that funds the treasury. A horse's board
-- announces itself exactly as a human's does (CLAUDE.md 10.5).
--
-- HEADS-UP TOO, not only Spins: a duel is seat-first by the same rule and has
-- been waiting on the same loop.
--
-- The send is wrapped, following fn_request_manual_bomb_pot: a broadcast that
-- fails must never fail the SEAT. The poll remains as the backstop, so the
-- worst case is exactly today's behaviour rather than a game that never
-- starts.
--
-- ROLLBACK: re-apply
--   20260902041500 is unrelated; the previous body of this function is in
--   20260901201555_the_alarm_still_could_not_ring_two_check_constraints.sql

CREATE OR REPLACE FUNCTION public.fn_sync_seat_first_player_count(p_tournament_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_table      uuid;
  v_seats      integer := 0;
  v_seat_first boolean := false;
  v_is_spin    boolean := false;
  v_cap        integer := 0;
  v_variant    text := '';
  v_attempt    integer := 0;
  v_book       jsonb;
  v_announced  boolean := false;
BEGIN
  SELECT (COALESCE(t.variant, '') IN ('spin', 'sng') OR COALESCE(t.max_players, 0) <= 2),
         COALESCE(t.variant, '') = 'spin',
         COALESCE(t.max_players, 0),
         COALESCE(t.variant, '')
    INTO v_seat_first, v_is_spin, v_cap, v_variant
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  <<retry>>
  LOOP
    v_attempt := v_attempt + 1;
    BEGIN
      v_table := public.fn_tournament_primary_table(p_tournament_id);

      IF v_table IS NULL THEN
        IF COALESCE(v_seat_first, false) THEN
          SELECT count(*) INTO v_seats
            FROM public.table_seats s
            JOIN public.tables tb ON tb.id = s.table_id
           WHERE tb.tournament_id = p_tournament_id
             AND s.left_at IS NULL;
          UPDATE public.tournaments SET current_players = v_seats WHERE id = p_tournament_id;
          RETURN v_seats;
        END IF;
        RETURN NULL;
      END IF;

      SELECT count(*) INTO v_seats
        FROM public.table_seats
       WHERE table_id = v_table AND left_at IS NULL;

      UPDATE public.tables SET current_players = v_seats WHERE id = v_table;

      IF COALESCE(v_seat_first, false) THEN
        UPDATE public.tournaments SET current_players = v_seats WHERE id = p_tournament_id;
      END IF;

      /* THE LAST SEAT FUNDS THE TREASURY (Dan, 2026-09-01). Both seating paths
         land here, so a horse funds it exactly as a human does. Reporting is
         best effort and cannot cost a seat. */
      IF v_is_spin AND v_cap > 0 AND v_seats >= v_cap THEN
        BEGIN
          v_book := public.fn_spin_book_entry(p_tournament_id);
          IF COALESCE((v_book->>'ok')::boolean, false) IS NOT TRUE THEN
            BEGIN
              INSERT INTO public.ca_drift_incidents
                (source, dedupe_key, tournament_id, classification, layer,
                 severity, suspected_cause, metadata)
              VALUES ('fn_spin_book_entry', 'spin_entry_refused:' || p_tournament_id::text,
                      p_tournament_id, 'settlement_error', 'ledger',
                      'critical', 'fn_spin_book_entry refused the entry booking',
                      jsonb_build_object('tournament_id', p_tournament_id, 'result', v_book))
              ON CONFLICT DO NOTHING;
            EXCEPTION WHEN OTHERS THEN
              RAISE WARNING 'could not file spin entry incident for %: %', p_tournament_id, SQLERRM;
            END;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          BEGIN
            INSERT INTO public.ca_drift_incidents
              (source, dedupe_key, tournament_id, classification, layer,
               severity, suspected_cause, metadata)
            VALUES ('fn_spin_book_entry', 'spin_entry_threw:' || p_tournament_id::text,
                    p_tournament_id, 'settlement_error', 'ledger',
                    'critical', 'fn_spin_book_entry raised',
                    jsonb_build_object('tournament_id', p_tournament_id,
                                       'sqlstate', SQLSTATE, 'error', SQLERRM))
            ON CONFLICT DO NOTHING;
          EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'could not file spin entry incident for %: %', p_tournament_id, SQLERRM;
          END;
        END;
      END IF;

      /* THE PUSH. Spins AND heads-up: both are seat-first and both have been
         waiting on the same loop. Wrapped, exactly as fn_request_manual_bomb_pot
         wraps its own send - a broadcast that fails must never fail the seat,
         and discoverSeatFirstStarts stays in place as the backstop, so the
         worst case is the behaviour we have today rather than a game that
         never begins. */
      IF COALESCE(v_seat_first, false) AND v_cap > 0 AND v_seats >= v_cap THEN
        BEGIN
          PERFORM realtime.send(
            jsonb_build_object(
              'tournament_id', p_tournament_id,
              'variant', v_variant,
              'max_players', v_cap,
              'paid_seats', v_seats,
              'filled_at', now()
            ),
            'seat_first_ready',
            'seat_first',
            false
          );
          v_announced := true;
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'fn_sync_seat_first_player_count: realtime.send failed for %: %',
            p_tournament_id, SQLERRM;
        END;
      END IF;

      RETURN v_seats;

    EXCEPTION
      WHEN deadlock_detected OR lock_not_available THEN
        IF v_attempt >= 3 THEN
          RAISE;
        END IF;
        PERFORM pg_sleep(0.05 * v_attempt);
    END;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_sync_seat_first_player_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_seat_first_player_count(uuid) TO service_role;

DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_sync_seat_first_player_count';

  IF position('realtime.send' in v_src) = 0 THEN
    RAISE EXCEPTION 'the board no longer announces itself';
  END IF;
  IF position('seat_first_ready' in v_src) = 0 THEN
    RAISE EXCEPTION 'the announcement lost its event name';
  END IF;
  -- The treasury hook must survive this edit.
  IF position('fn_spin_book_entry' in v_src) = 0 THEN
    RAISE EXCEPTION 'the entry booking was dropped';
  END IF;
  -- And the push must cover heads-up, not just spins.
  IF position('COALESCE(v_seat_first, false) AND v_cap > 0' in v_src) = 0 THEN
    RAISE EXCEPTION 'the announcement is not gated on seat-first, so a duel would never announce';
  END IF;
END $$;
