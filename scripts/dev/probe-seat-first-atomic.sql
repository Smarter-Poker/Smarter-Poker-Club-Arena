\set ON_ERROR_STOP on

DO $probe_seat_first_atomic$
DECLARE
  v_id uuid := '20000000-0000-4000-8000-000000000001';
  v_partial_id uuid := '20000000-0000-4000-8000-000000000002';
  v_duplicate_id uuid := '20000000-0000-4000-8000-000000000003';
  v_unknown_id uuid := '20000000-0000-4000-8000-000000000004';
  v_config jsonb := jsonb_build_object(
    'club_id', '30000000-0000-4000-8000-000000000001',
    'union_id', null,
    'name', 'Atomic Spin Probe',
    'game_type', 'NLH',
    'variant', 'spin',
    'tournament_type', 'SPIN',
    'buy_in_amount', 10,
    'buy_in_fee', 1,
    'guaranteed_prize', 30,
    'starting_chips', 500,
    'max_players', 3,
    'min_players', 3,
    'table_size', 3,
    'current_players', 0,
    'status', 'REGISTERING',
    'blind_structure', jsonb_build_array(
      jsonb_build_object('smallBlind', 10, 'bigBlind', 20)
    ),
    'payout_structure', '[]'::jsonb,
    'start_time', '2030-01-01T00:00:00Z',
    'late_reg_levels', 0,
    'late_reg_mins', 0,
    'satellite_target_id', null,
    'satellite_seats', null,
    'short_description', null,
    'spin_multiplier', null,
    'spin_locked_tiers', null
  );
  v_created jsonb;
  v_replayed jsonb;
  v_table_id uuid;
  v_count integer;
BEGIN
  SELECT public.fn_create_seat_first_game_atomic(v_id, v_config)
    INTO v_created;
  IF v_created->>'ok' <> 'true'
     OR v_created->>'replayed' <> 'false'
     OR v_created->'tournament'->>'id' <> v_id::text
     OR NULLIF(v_created->>'table_id', '') IS NULL THEN
    RAISE EXCEPTION 'Atomic creator did not return the committed pair: %', v_created;
  END IF;
  v_table_id := (v_created->>'table_id')::uuid;

  SELECT count(*) INTO v_count
    FROM public.tournaments t
    JOIN public.tables tb ON tb.tournament_id = t.id
   WHERE t.id = v_id
     AND tb.id = v_table_id
     AND tb.status = 'waiting'
     AND tb.game_variant = 'nlh'
     AND tb.max_players = 3;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Atomic creator did not durably commit one exact pair';
  END IF;

  SELECT public.fn_create_seat_first_game_atomic(v_id, v_config)
    INTO v_replayed;
  IF v_replayed->>'ok' <> 'true'
     OR v_replayed->>'replayed' <> 'true'
     OR (v_replayed->>'table_id')::uuid <> v_table_id THEN
    RAISE EXCEPTION 'Exact replay changed identity: %', v_replayed;
  END IF;

  BEGIN
    PERFORM public.fn_create_seat_first_game_atomic(
      v_id,
      v_config || jsonb_build_object('name', 'Changed Spin Probe')
    );
    RAISE EXCEPTION 'A mismatched replay was accepted';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN
      IF position('SEAT_FIRST_CREATE_IDEMPOTENCY_MISMATCH' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.fn_create_seat_first_game_atomic(
      v_unknown_id,
      v_config || jsonb_build_object('ignored_new_field', true)
    );
    RAISE EXCEPTION 'An unknown creator field was accepted';
  EXCEPTION
    WHEN SQLSTATE '22023' THEN
      IF position('SEAT_FIRST_CREATE_UNKNOWN_CONFIG_KEY' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.tournaments WHERE id = v_unknown_id) THEN
    RAISE EXCEPTION 'An invalid creator request left a tournament behind';
  END IF;

  PERFORM public.fn_create_seat_first_game_atomic(v_partial_id, v_config);
  DELETE FROM public.tables WHERE tournament_id = v_partial_id;
  BEGIN
    PERFORM public.fn_create_seat_first_game_atomic(v_partial_id, v_config);
    RAISE EXCEPTION 'A partial prior commit was accepted as a replay';
  EXCEPTION
    WHEN SQLSTATE '23514' THEN
      IF position('SEAT_FIRST_ATOMIC_PARTIAL_STATE' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;
  /* Keep the parent through the end-of-transaction deferred origin proof.
     Restore one exact table so Stage B also proves this fixture has no husk. */
  INSERT INTO public.tables (
    club_id, tournament_id, name, game_type, game_variant, stakes,
    small_blind, big_blind, min_buy_in, max_buy_in,
    max_players, current_players, status
  ) VALUES (
    '30000000-0000-4000-8000-000000000001', v_partial_id,
    'Atomic Spin Probe', 'tournament', 'nlh', '10/20',
    10, 20, 0, 0, 3, 0, 'waiting'
  );

  SELECT public.fn_create_seat_first_game_atomic(v_duplicate_id, v_config)
    INTO v_created;
  INSERT INTO public.tables (
    id, club_id, tournament_id, name, game_type, game_variant, stakes,
    small_blind, big_blind, min_buy_in, max_buy_in,
    max_players, current_players, status
  )
  SELECT
    gen_random_uuid(), tb.club_id, tb.tournament_id, tb.name, tb.game_type,
    tb.game_variant, tb.stakes, tb.small_blind, tb.big_blind,
    tb.min_buy_in, tb.max_buy_in, tb.max_players, tb.current_players, tb.status
    FROM public.tables tb
   WHERE tb.id = (v_created->>'table_id')::uuid;
  BEGIN
    PERFORM public.fn_create_seat_first_game_atomic(v_duplicate_id, v_config);
    RAISE EXCEPTION 'Duplicate joinable tables were accepted as an exact replay';
  EXCEPTION
    WHEN SQLSTATE '23514' THEN
      IF position('SEAT_FIRST_ATOMIC_PARTIAL_STATE' IN SQLERRM) = 0 THEN
        RAISE;
      END IF;
  END;
  DELETE FROM public.tables
   WHERE tournament_id = v_duplicate_id
     AND id <> (v_created->>'table_id')::uuid;
END;
$probe_seat_first_atomic$;

SELECT 'Atomic seat-first create/replay/partial-state probes passed.' AS result;
