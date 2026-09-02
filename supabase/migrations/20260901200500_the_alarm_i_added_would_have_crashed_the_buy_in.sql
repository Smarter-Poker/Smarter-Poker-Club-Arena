-- ═══════════════════════════════════════════════════════════════════════════
--  THE ALARM I ADDED WOULD HAVE CRASHED THE BUY-IN, AND THE LOCK ORDER WAS
--  INVERTED. Both found by probing, not by reading.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- DEFECT 1 - THE REPORTER COULD NOT REPORT.
-- 20260901153000 made fn_sync_seat_first_player_count file a booking failure
-- into ca_drift_incidents instead of swallowing it. It wrote the payload into a
-- column named `detail`. That column does not exist on that table; the payload
-- column is `metadata` jsonb. So the INSERT would have raised 42703 - inside
-- the very handler meant to make a failure visible, and NOT inside any handler
-- that catches it, so it would have propagated out of fn_take_seat_and_buy_in
-- and REFUSED THE PLAYER'S SEAT.
--
-- It never fired, which is exactly why it survived: every booking since has
-- succeeded, so the error path was never executed. An alarm nobody has seen
-- ring is an untested code path, and this one would have turned a booking
-- problem into an outage at the till.
--
-- Fixed twice over: the columns are the real ones, and the reporting is
-- wrapped in its own handler so that a failure to REPORT can never cost a
-- player their seat. The booking is what matters; the incident row is a best
-- effort about it.
--
-- DEFECT 2 - LOCK ORDER INVERSION.
-- fn_spin_book_entry resolved the pool with fn_spin_reserve_pool (which
-- UPSERTS into spin_bonus_pools) and only then took its advisory lock. A
-- concurrent caller holding the advisory lock and updating the same pool row
-- gives a cycle: A holds pool row and waits for the lock, B holds the lock and
-- waits for the row. A probe against live traffic deadlocked on exactly that
-- pair (40P01, an advisory lock against spin_bonus_pools).
--
-- The lock is taken FIRST now, so every path is advisory-then-row and the cycle
-- cannot form. The probe transaction rolled back with nothing committed, and no
-- live booking was lost - but the inversion was real and mine.
--
-- ROLLBACK: re-apply 20260901153000_the_entry_booking_lock_took_the_wrong_argument_types.sql

CREATE OR REPLACE FUNCTION public.fn_spin_book_entry(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t         record;
  v_owner     uuid;
  v_seats     integer;
  v_collected numeric;
  v_rake      numeric;
  v_reserve_in numeric;
  v_balance   numeric;
BEGIN
  SELECT t.id, t.club_id, t.buy_in_amount, t.max_players, t.variant
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  IF NOT FOUND OR COALESCE(v_t.variant,'') <> 'spin' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_spin');
  END IF;
  IF v_t.club_id IS NULL OR COALESCE(v_t.buy_in_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;

  -- Cheap read, no locks taken: most calls stop here.
  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
              WHERE tournament_id = p_tournament_id AND kind = 'contribution') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_booked');
  END IF;

  -- THE LOCK COMES FIRST. fn_spin_reserve_pool upserts the pool row, so
  -- resolving the owner before locking made this path take the row lock and
  -- then wait for the advisory lock, while a concurrent booking held the
  -- advisory lock and waited for the row. Advisory-then-row everywhere means
  -- no cycle can form.
  PERFORM pg_advisory_xact_lock(hashtextextended('spin_entry:' || p_tournament_id::text, 0));

  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
              WHERE tournament_id = p_tournament_id AND kind = 'contribution') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_booked');
  END IF;

  v_owner := public.fn_spin_reserve_pool(v_t.club_id);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_reserve_owner');
  END IF;

  v_seats      := GREATEST(COALESCE(v_t.max_players, 3), 1);
  v_collected  := round(v_t.buy_in_amount * v_seats, 2);
  v_rake       := round(v_collected * public.fn_spin_rake_rate(v_t.buy_in_amount), 2);
  v_reserve_in := round(v_collected - v_rake, 2);

  PERFORM set_config('app.ledger_category', 'spin_entry', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

  UPDATE public.spin_bonus_pools
     SET balance         = balance + v_reserve_in,
         total_deposited = total_deposited + v_reserve_in,
         spin_count      = spin_count + 1,
         highest_stake   = GREATEST(highest_stake, v_t.buy_in_amount),
         updated_at      = now()
   WHERE club_id = v_owner
   RETURNING balance INTO v_balance;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_pool_row', 'owner_id', v_owner);
  END IF;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'contribution', v_reserve_in, v_balance,
          NULL, v_t.buy_in_amount, v_seats, v_rake,
          CASE WHEN v_owner = v_t.club_id
               THEN 'buy-ins less fixed rake, booked when the last seat was paid'
               ELSE format('buy-ins less fixed rake, booked when the last seat was paid (club %s)', v_t.club_id)
          END);

  IF v_rake > 0 THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_rake, v_collected, v_seats, 0, true,
            p_tournament_id, 'fn_spin_book_entry',
            jsonb_build_object('kind','spin_rake','buy_in',v_t.buy_in_amount,
                               'rake_rate', public.fn_spin_rake_rate(v_t.buy_in_amount),
                               'booked_at','entry','reserve_owner',v_owner));
  END IF;

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in,
    'balance', v_balance, 'owner_id', v_owner, 'seats', v_seats);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_book_entry(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_book_entry(uuid) TO service_role;

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

         REPORTING IS BEST EFFORT AND CANNOT COST A SEAT. The previous version
         wrote a payload column that does not exist on ca_drift_incidents, which
         would have raised 42703 out of the handler and refused the player's
         seat. The incident row uses the real columns now AND is itself wrapped,
         so the worst a reporting fault can do is leave the incident
         unrecorded. */
      IF v_is_spin AND v_cap > 0 AND v_seats >= v_cap THEN
        BEGIN
          v_book := public.fn_spin_book_entry(p_tournament_id);
          IF COALESCE((v_book->>'ok')::boolean, false) IS NOT TRUE THEN
            BEGIN
              INSERT INTO public.ca_drift_incidents
                (source, dedupe_key, tournament_id, classification, layer,
                 severity, suspected_cause, metadata)
              VALUES ('fn_spin_book_entry', 'spin_entry_refused:' || p_tournament_id::text,
                      p_tournament_id, 'spin_entry_not_booked', 'database',
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
                    p_tournament_id, 'spin_entry_not_booked', 'database',
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

DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_sync_seat_first_player_count';
  -- The exact broken column list, not the bare word: the word appears in the
  -- explanatory comment above, which is where it belongs.
  IF position('dedupe_key, detail' in v_src) > 0 THEN
    RAISE EXCEPTION 'the incident insert still names a column that does not exist';
  END IF;
  IF position('severity, suspected_cause, metadata' in v_src) = 0 THEN
    RAISE EXCEPTION 'the incident insert does not write the real columns';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_spin_book_entry';
  IF position('PERFORM pg_advisory_xact_lock' in v_src)
     > position('v_owner := public.fn_spin_reserve_pool' in v_src) THEN
    RAISE EXCEPTION 'the advisory lock is still taken after the pool row is resolved';
  END IF;
END $$;;
