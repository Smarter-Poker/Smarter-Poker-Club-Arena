-- Third defect in the same alarm, found the same way: by running it.
--
-- After the column name was fixed, the INSERT still could not land.
-- ca_drift_incidents constrains BOTH of the columns I invented values for:
--
--   classification CHECK IN (ledger_imbalance, settlement_error, duplicate_payment,
--     missing_payment, projection_delay, cache_mismatch, reporting_mismatch,
--     delayed_event, duplicate_event, rounding_error, incorrect_rake,
--     incorrect_weighted_rake, incorrect_rakeback, bbj_error, treasury_error,
--     credit_line_error, cross_club_posting, cross_union_posting,
--     unauthorized_adjustment, historical_migration, unknown)
--   layer          CHECK IN (ledger, projection, cache, reporting, settlement, unknown)
--
-- I wrote 'spin_entry_not_booked' and 'database'. Neither exists, so the INSERT
-- raised 23514. Because the handler is now wrapped, that would no longer cost a
-- player their seat - it would simply never file, which is the same silent
-- alarm this whole hook was written to eliminate.
--
-- The honest values: the missing row is a reserve-LEDGER row, and failing to
-- book an entry into the pool is a settlement error.
--
-- ROLLBACK: re-apply 20260901200500_the_alarm_i_added_would_have_crashed_the_buy_in.sql

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
  v_attempt    integer := 0;
  v_book       jsonb;
BEGIN
  SELECT (COALESCE(t.variant, '') IN ('spin', 'sng') OR COALESCE(t.max_players, 0) <= 2),
         COALESCE(t.variant, '') = 'spin',
         COALESCE(t.max_players, 0)
    INTO v_seat_first, v_is_spin, v_cap
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
         land here, so a horse funds it exactly as a human does.

         REPORTING IS BEST EFFORT AND CANNOT COST A SEAT. It is also now
         VERIFIED: the first version named a payload column that does not exist
         (42703) and the second invented a classification and a layer the CHECK
         constraints reject (23514). Both were found by executing the handler,
         not by reading it. */
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

-- Assert the values are ones the table will actually accept, by asking the
-- constraints rather than by trusting the text.
DO $$
DECLARE v_src text; v_class text := 'settlement_error'; v_layer text := 'ledger';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_sync_seat_first_player_count';
  IF position('''settlement_error'', ''ledger''' in v_src) = 0 THEN
    RAISE EXCEPTION 'the incident insert does not use the corrected classification/layer';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname='ca_drift_incidents' AND con.conname='ca_drift_incidents_classification_check'
       AND pg_get_constraintdef(con.oid) LIKE '%' || v_class || '%') THEN
    RAISE EXCEPTION 'classification % is not accepted by the check constraint', v_class;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE c.relname='ca_drift_incidents' AND con.conname='ca_drift_incidents_layer_check'
       AND pg_get_constraintdef(con.oid) LIKE '%''' || v_layer || '''%') THEN
    RAISE EXCEPTION 'layer % is not accepted by the check constraint', v_layer;
  END IF;
END $$;;
