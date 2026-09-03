-- =============================================================================
-- a_count_that_did_not_move_is_not_a_write
-- Applied to production via Supabase MCP 2026-09-02.
--
-- Dan, 2026-09-02: "THERE ARE STILL MONSTER DELAYS IN THE GAME PLAY AND HAND
-- DELIVERY BEFORE A NEW HAND STARTS AND THE OLD ONE FINISHES ... TABLES STILL
-- DON'T OPEN RIGHT AWAY."
--
-- Both symptoms are the same cause: the database is saturated, so every hand's
-- writes and every socket handshake queue behind work that produces nothing.
-- Measured over 76 minutes on 2026-09-02 (pg_stat_statements, XL / 4 cores,
-- 18,272 s of capacity):
--
--   realtime WAL poller               4,072 s   538 ms mean   <- largest single
--   hand_history INSERT               3,256 s    65 ms mean      consumer
--   fn_sync_seat_first_player_count   2,292 s   100 ms mean  x 24,490 calls
--   fn_aggregate_gto_street_next      1,899 s  1240 ms mean
--   get_club_home                     1,191 s   153 ms mean
--
-- fn_sync_seat_first_player_count is called on every seat change on every
-- seat-first board AND on every retry of the engine's fill loop, which retries
-- a board that cannot fill every 12 seconds. It wrote current_players on both
-- the table and the tournament unconditionally - so nearly all of those 24,490
-- calls rewrote a row to the value it already held.
--
-- That is not free. An UPDATE that changes nothing still writes a new heap
-- tuple, touches every index, writes a WAL record, and has that WAL record
-- decoded and RLS-checked by Realtime for every subscribed client - which is
-- the poller sitting at the top of the table above. Three guarded writes here
-- remove the write, the WAL and the decode together.
--
-- The 32 heads-up boards that had been retrying since 2026-09-01 18:42 were
-- cancelled and refunded separately (852.00 chips back to 32 horses, via
-- atomic_cancel_tournament).
--
-- Every other line of the body is byte-identical to production as read back
-- on 2026-09-02.
-- =============================================================================

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
          UPDATE public.tournaments SET current_players = v_seats
           WHERE id = p_tournament_id
             AND current_players IS DISTINCT FROM v_seats;
          RETURN v_seats;
        END IF;
        RETURN NULL;
      END IF;

      SELECT count(*) INTO v_seats
        FROM public.table_seats
       WHERE table_id = v_table AND left_at IS NULL;

      /* WRITE ONLY WHEN THE NUMBER MOVED (2026-09-02). An UPDATE that sets a
         column to the value it already holds is a no-op to read, and a full
         row rewrite to Postgres: a new heap tuple, every index touched, a WAL
         record written, and that WAL record then decoded and RLS-checked by
         Realtime for every subscribed client. This function is called on every
         seat change on every seat-first board and, while a board cannot fill,
         on every retry of the fill loop - 24,490 calls in 76 minutes measured
         2026-09-02, the vast majority of which changed nothing. The realtime
         WAL poller was the single largest consumer on the database at the time
         (4,072 s, 538 ms mean), and this is one of the things it was decoding.
         IS DISTINCT FROM also covers the NULL case, which `<>` would not. */
      UPDATE public.tables SET current_players = v_seats
       WHERE id = v_table
         AND current_players IS DISTINCT FROM v_seats;

      IF COALESCE(v_seat_first, false) THEN
        UPDATE public.tournaments SET current_players = v_seats
         WHERE id = p_tournament_id
           AND current_players IS DISTINCT FROM v_seats;
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

-- ── WHO MAY CALL IT ──────────────────────────────────────────────────────────
-- Only the engine. Every caller is server-side (TournamentManagerBase,
-- TournamentManagerEliminations, TournamentRecurringService) and reaches it as
-- service_role; nothing in src/ calls it. It is SECURITY DEFINER and it writes,
-- so a browser role holding EXECUTE would be a writer that cannot know who is
-- asking. PUBLIC is named as well as the roles: revoking a role while PUBLIC
-- still holds the grant reads as a fix and does nothing. This matches the live
-- ACL ({postgres=X/postgres,service_role=X/postgres}) rather than changing it.
REVOKE ALL ON FUNCTION public.fn_sync_seat_first_player_count(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_seat_first_player_count(uuid) TO service_role;
