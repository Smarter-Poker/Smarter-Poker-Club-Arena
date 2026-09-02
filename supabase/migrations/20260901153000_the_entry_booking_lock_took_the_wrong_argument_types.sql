-- fn_spin_book_entry called pg_advisory_xact_lock(bigint, bigint). That
-- overload does not exist -- the two-argument form is (int, int), and
-- hashtextextended returns bigint. So EVERY call raised 42883, and the caller's
-- exception handler in fn_sync_seat_first_player_count turned it into a
-- RAISE WARNING nobody reads. 721 Spins in six hours went on booking at settle
-- while the entry hook read as installed.
--
-- That is the same shape as every other defect found today: a failure recorded
-- as nothing. Two corrections, not one:
--
--   1. the lock takes a single bigint key, which is the overload that exists;
--   2. the caller no longer swallows the failure - it files it into
--      ca_drift_incidents, because a treasury that is not being funded on time
--      must be loud even when the fallback at settle keeps the books correct.
--
-- ROLLBACK: re-apply 20260901150000 and 20260901151500.

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

  -- One bigint key. The two-argument overload is (int, int) and taking a
  -- bigint pair raised 42883 on every call.
  PERFORM pg_advisory_xact_lock(hashtextextended('spin_entry:' || p_tournament_id::text, 0));

  -- Re-check under the lock. Two seats can complete a board in the same
  -- instant when a horse and a human race for the last chair.
  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
              WHERE tournament_id = p_tournament_id AND kind = 'contribution') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_booked');
  END IF;

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

-- The caller stops swallowing the failure.
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
         land here - fn_take_seat_and_buy_in for a human, fn_seat_horse_in_seat_
         first_game for a horse - so a horse funds it exactly as a human does.
         A booking failure must not cost a player their seat, so it is caught;
         it is FILED rather than warned, because the first version of this hook
         raised 42883 on every call and a RAISE WARNING hid it completely. */
      IF v_is_spin AND v_cap > 0 AND v_seats >= v_cap THEN
        BEGIN
          v_book := public.fn_spin_book_entry(p_tournament_id);
          IF COALESCE((v_book->>'ok')::boolean, false) IS NOT TRUE THEN
            INSERT INTO public.ca_drift_incidents (source, dedupe_key, detail)
            VALUES ('fn_spin_book_entry', 'refused:' || p_tournament_id::text,
                    jsonb_build_object('tournament_id', p_tournament_id, 'result', v_book))
            ON CONFLICT DO NOTHING;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          INSERT INTO public.ca_drift_incidents (source, dedupe_key, detail)
          VALUES ('fn_spin_book_entry', 'threw:' || p_tournament_id::text,
                  jsonb_build_object('tournament_id', p_tournament_id,
                                     'sqlstate', SQLSTATE, 'error', SQLERRM))
          ON CONFLICT DO NOTHING;
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

DO $$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_spin_book_entry';
  IF position('pg_advisory_xact_lock(hashtextextended(''spin_entry:''' in v_src) = 0 THEN
    RAISE EXCEPTION 'the advisory lock was not corrected to the single-key overload';
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname='fn_sync_seat_first_player_count';
  IF position('ca_drift_incidents' in v_src) = 0 THEN
    RAISE EXCEPTION 'the seat counter still swallows an entry-booking failure';
  END IF;
END $$;;

-- ── Grants restated with the declaration above ─────────────────────────────
REVOKE ALL ON FUNCTION public.fn_sync_seat_first_player_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sync_seat_first_player_count(uuid) TO service_role;
