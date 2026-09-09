-- ============================================================================
--  A SEAT-FIRST LISTING AND ITS TABLE ARE ONE TRANSACTION
--
-- A Spin or heads-up listing was inserted through PostgREST first and its table
-- was inserted by a second request. A process exit, timeout or failed second
-- request committed a REGISTERING tournament that nobody could ever join. The
-- engine then called fn_repair_seat_first_games every board tick to manufacture
-- the missing table later.
--
-- This is the source fix. The service supplies one stable tournament UUID and
-- this function inserts the tournament and table in the same database
-- transaction. A failure commits neither row. An ambiguous response can retry
-- the same UUID and receives the exact committed pair. The later Stage-B
-- migration retires the legacy repair only after this caller is the sole live
-- engine protocol.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_create_seat_first_game_atomic(
  p_tournament_id uuid,
  p_config jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_existing public.tournaments%ROWTYPE;
  v_existing_table public.tables%ROWTYPE;
  v_existing_table_count integer;
  v_created public.tournaments%ROWTYPE;
  v_table_id uuid;
  v_club_id uuid;
  v_union_id uuid;
  v_name text;
  v_game_type text;
  v_table_variant text;
  v_variant text;
  v_tournament_type text;
  v_buy_in numeric;
  v_buy_in_fee numeric;
  v_guarantee numeric;
  v_starting_chips integer;
  v_max_players integer;
  v_min_players integer;
  v_table_size integer;
  v_blinds jsonb;
  v_payouts jsonb;
  v_start_time timestamptz;
  v_late_reg_levels integer;
  v_late_reg_mins integer;
  v_satellite_target_id uuid;
  v_satellite_seats integer;
  v_short_description text;
  v_requested_current_players integer;
  v_requested_status text;
  v_first_level jsonb;
  v_small_blind numeric;
  v_big_blind numeric;
BEGIN
  IF p_tournament_id IS NULL OR p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'SEAT_FIRST_CREATE_INVALID_REQUEST'
      USING ERRCODE = '22023';
  END IF;

  /* Every accepted request key must be represented by the durable pair below.
     Rejecting unknown keys prevents an idempotent replay from appearing exact
     after a caller adds configuration this creator silently ignores. */
  IF EXISTS (
    SELECT 1
      FROM jsonb_object_keys(p_config) AS supplied(key)
     WHERE supplied.key NOT IN (
       'club_id', 'union_id', 'name', 'game_type', 'variant',
       'tournament_type', 'buy_in_amount', 'buy_in_fee', 'guaranteed_prize',
       'starting_chips', 'max_players', 'min_players', 'table_size',
       'current_players', 'status', 'blind_structure', 'payout_structure',
       'start_time', 'late_reg_levels', 'late_reg_mins',
       'satellite_target_id', 'satellite_seats', 'short_description',
       'spin_multiplier', 'spin_locked_tiers'
     )
  ) THEN
    RAISE EXCEPTION 'SEAT_FIRST_CREATE_UNKNOWN_CONFIG_KEY'
      USING ERRCODE = '22023';
  END IF;

  /* This is an entry-producing transaction. It takes the same first lock as
     every purchase path, before the idempotency key or either game row. */
  PERFORM pg_advisory_xact_lock_shared(530090, 1);
  IF public.fn_entry_purchases_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:seat-first-create:' || p_tournament_id::text, 0)
  );

  v_club_id := NULLIF(p_config->>'club_id', '')::uuid;
  v_union_id := NULLIF(p_config->>'union_id', '')::uuid;
  v_name := NULLIF(btrim(p_config->>'name'), '');
  v_game_type := NULLIF(btrim(p_config->>'game_type'), '');
  v_table_variant := lower(v_game_type);
  v_variant := lower(NULLIF(btrim(p_config->>'variant'), ''));
  v_tournament_type := upper(NULLIF(btrim(p_config->>'tournament_type'), ''));
  v_buy_in := COALESCE(NULLIF(p_config->>'buy_in_amount', '')::numeric, 0);
  v_buy_in_fee := COALESCE(NULLIF(p_config->>'buy_in_fee', '')::numeric, 0);
  v_guarantee := COALESCE(NULLIF(p_config->>'guaranteed_prize', '')::numeric, 0);
  v_starting_chips := NULLIF(p_config->>'starting_chips', '')::integer;
  v_max_players := NULLIF(p_config->>'max_players', '')::integer;
  v_min_players := COALESCE(NULLIF(p_config->>'min_players', '')::integer, v_max_players);
  v_table_size := COALESCE(NULLIF(p_config->>'table_size', '')::integer, v_max_players);
  v_blinds := p_config->'blind_structure';
  v_payouts := COALESCE(p_config->'payout_structure', '[]'::jsonb);
  v_start_time := NULLIF(p_config->>'start_time', '')::timestamptz;
  v_late_reg_levels := COALESCE(NULLIF(p_config->>'late_reg_levels', '')::integer, 0);
  v_late_reg_mins := COALESCE(NULLIF(p_config->>'late_reg_mins', '')::integer, 0);
  v_satellite_target_id := NULLIF(p_config->>'satellite_target_id', '')::uuid;
  v_satellite_seats := NULLIF(p_config->>'satellite_seats', '')::integer;
  v_short_description := NULLIF(btrim(p_config->>'short_description'), '');
  v_requested_current_players :=
    COALESCE(NULLIF(p_config->>'current_players', '')::integer, 0);
  v_requested_status :=
    upper(COALESCE(NULLIF(btrim(p_config->>'status'), ''), 'REGISTERING'));

  IF v_club_id IS NULL
     OR v_name IS NULL
     OR v_game_type IS NULL
     OR v_variant IS NULL
     OR v_tournament_type IS NULL
     OR v_starting_chips IS NULL OR v_starting_chips <= 0
     OR v_max_players IS NULL OR v_max_players < 2 OR v_max_players > 3
     OR v_min_players < 2 OR v_min_players > v_max_players
     OR v_table_size <> v_max_players
     OR v_start_time IS NULL
     OR jsonb_typeof(v_blinds) <> 'array'
     OR jsonb_array_length(v_blinds) = 0
     OR jsonb_typeof(v_payouts) <> 'array'
     OR NOT (v_variant = 'spin' OR v_max_players = 2)
     OR v_tournament_type NOT IN ('SPIN', 'SNG', 'SATELLITE')
     OR v_table_variant NOT IN ('nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'short_deck', 'flh', 'flo8')
     OR v_requested_current_players <> 0
     OR v_requested_status <> 'REGISTERING'
     OR NULLIF(p_config->>'spin_multiplier', '') IS NOT NULL
     OR (
       p_config ? 'spin_locked_tiers'
       AND jsonb_typeof(p_config->'spin_locked_tiers') IS DISTINCT FROM 'null'
     )
     OR (v_tournament_type = 'SPIN' AND (v_variant <> 'spin' OR v_max_players <> 3))
     OR (
       v_tournament_type = 'SATELLITE'
       AND (
         v_satellite_target_id IS NULL
         OR v_satellite_seats IS NULL
         OR v_satellite_seats <= 0
         OR v_satellite_seats > v_max_players
       )
     )
     OR (
       v_tournament_type <> 'SATELLITE'
       AND (v_satellite_target_id IS NOT NULL OR v_satellite_seats IS NOT NULL)
     )
     OR v_buy_in < 0 OR v_buy_in_fee < 0 OR v_guarantee < 0 THEN
    RAISE EXCEPTION 'SEAT_FIRST_CREATE_INVALID_CONFIG'
      USING ERRCODE = '22023';
  END IF;

  v_first_level := v_blinds->0;
  v_small_blind := COALESCE(
    NULLIF(v_first_level->>'smallBlind', '')::numeric,
    NULLIF(v_first_level->>'small_blind', '')::numeric,
    NULLIF(v_first_level->>'sb', '')::numeric
  );
  v_big_blind := COALESCE(
    NULLIF(v_first_level->>'bigBlind', '')::numeric,
    NULLIF(v_first_level->>'big_blind', '')::numeric,
    NULLIF(v_first_level->>'bb', '')::numeric
  );
  IF v_small_blind IS NULL OR v_small_blind <= 0
     OR v_big_blind IS NULL OR v_big_blind < v_small_blind THEN
    RAISE EXCEPTION 'SEAT_FIRST_CREATE_INVALID_BLINDS'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_existing
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF FOUND THEN
    SELECT count(*) INTO v_existing_table_count
      FROM public.tables tb
     WHERE tb.tournament_id = p_tournament_id
       AND COALESCE(tb.is_deleted, false) = false
       AND tb.status IN ('waiting', 'running');

    IF v_existing_table_count <> 1 THEN
      RAISE EXCEPTION
        'SEAT_FIRST_ATOMIC_PARTIAL_STATE: tournament % has % joinable tables',
        p_tournament_id, v_existing_table_count
        USING ERRCODE = '23514';
    END IF;

    SELECT tb.* INTO v_existing_table
      FROM public.tables tb
     WHERE tb.tournament_id = p_tournament_id
       AND COALESCE(tb.is_deleted, false) = false
       AND tb.status IN ('waiting', 'running')
     ORDER BY tb.created_at, tb.id
     LIMIT 1
     FOR UPDATE;
    v_table_id := v_existing_table.id;

    IF v_existing.club_id IS DISTINCT FROM v_club_id
       OR v_existing.union_id IS DISTINCT FROM v_union_id
       OR v_existing.name IS DISTINCT FROM v_name
       OR lower(v_existing.game_type) IS DISTINCT FROM lower(v_game_type)
       OR lower(v_existing.variant) IS DISTINCT FROM v_variant
       OR upper(v_existing.tournament_type) IS DISTINCT FROM v_tournament_type
       OR v_existing.buy_in_amount IS DISTINCT FROM v_buy_in
       OR v_existing.buy_in_fee IS DISTINCT FROM v_buy_in_fee
       OR v_existing.guaranteed_prize IS DISTINCT FROM v_guarantee
       OR v_existing.starting_chips IS DISTINCT FROM v_starting_chips
       OR v_existing.max_players IS DISTINCT FROM v_max_players
       OR v_existing.min_players IS DISTINCT FROM v_min_players
       OR v_existing.table_size IS DISTINCT FROM v_table_size
       OR (v_existing.blind_structure)::jsonb IS DISTINCT FROM v_blinds
       OR (v_existing.payout_structure)::jsonb IS DISTINCT FROM v_payouts
       OR v_existing.start_time IS DISTINCT FROM v_start_time
       OR v_existing.late_reg_levels IS DISTINCT FROM v_late_reg_levels
       OR v_existing.late_reg_mins IS DISTINCT FROM v_late_reg_mins
       OR v_existing.satellite_target_id IS DISTINCT FROM v_satellite_target_id
       OR v_existing.satellite_seats IS DISTINCT FROM v_satellite_seats
       OR v_existing.short_description IS DISTINCT FROM v_short_description
       OR v_existing_table.club_id IS DISTINCT FROM v_club_id
       OR v_existing_table.tournament_id IS DISTINCT FROM p_tournament_id
       OR v_existing_table.name IS DISTINCT FROM v_name
       OR lower(v_existing_table.game_type) IS DISTINCT FROM 'tournament'
       OR lower(v_existing_table.game_variant) IS DISTINCT FROM v_table_variant
       OR v_existing_table.stakes IS DISTINCT FROM
          (v_small_blind::text || '/' || v_big_blind::text)
       OR v_existing_table.small_blind IS DISTINCT FROM v_small_blind
       OR v_existing_table.big_blind IS DISTINCT FROM v_big_blind
       OR v_existing_table.min_buy_in IS DISTINCT FROM 0::numeric
       OR v_existing_table.max_buy_in IS DISTINCT FROM 0::numeric
       OR v_existing_table.max_players IS DISTINCT FROM v_max_players THEN
      RAISE EXCEPTION 'SEAT_FIRST_CREATE_IDEMPOTENCY_MISMATCH: %', p_tournament_id
        USING ERRCODE = '22023';
    END IF;

    RETURN jsonb_build_object(
      'ok', true,
      'replayed', true,
      'tournament', to_jsonb(v_existing),
      'table_id', v_table_id
    );
  END IF;

  INSERT INTO public.tournaments (
    id, club_id, union_id, name, game_type, variant, tournament_type,
    buy_in_amount, buy_in_fee, guaranteed_prize, starting_chips,
    max_players, min_players, table_size, current_players, status,
    blind_structure, payout_structure, start_time,
    late_reg_levels, late_reg_mins,
    satellite_target_id, satellite_seats, short_description
  ) VALUES (
    p_tournament_id, v_club_id, v_union_id, v_name, v_game_type, v_variant,
    v_tournament_type, v_buy_in, v_buy_in_fee, v_guarantee, v_starting_chips,
    v_max_players, v_min_players, v_table_size, 0, 'REGISTERING',
    v_blinds::text, v_payouts::text, v_start_time,
    v_late_reg_levels, v_late_reg_mins,
    v_satellite_target_id, v_satellite_seats, v_short_description
  ) RETURNING * INTO v_created;

  INSERT INTO public.tables (
    club_id, tournament_id, name, game_type, game_variant, stakes,
    small_blind, big_blind, min_buy_in, max_buy_in,
    max_players, current_players, status
  ) VALUES (
    v_club_id, p_tournament_id, v_name, 'tournament', v_table_variant,
    v_small_blind::text || '/' || v_big_blind::text,
    v_small_blind, v_big_blind, 0, 0,
    v_max_players, 0, 'waiting'
  ) RETURNING id INTO v_table_id;

  RETURN jsonb_build_object(
    'ok', true,
    'replayed', false,
    'tournament', to_jsonb(v_created),
    'table_id', v_table_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_create_seat_first_game_atomic(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_seat_first_game_atomic(uuid, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.fn_create_seat_first_game_atomic(uuid, jsonb) IS
  'Stage-A creator for a Spin, heads-up SNG or heads-up satellite and its joinable table in one service-only transaction. The caller-supplied tournament UUID is the exact replay key.';

DO $assert_atomic_seat_first_creator$
DECLARE
  v_definition text;
BEGIN
  v_definition := pg_get_functiondef(
    'public.fn_create_seat_first_game_atomic(uuid,jsonb)'::regprocedure
  );
  IF position('INSERT INTO public.tournaments' IN v_definition) = 0
     OR position('INSERT INTO public.tables' IN v_definition) = 0
     OR position('pg_advisory_xact_lock_shared(530090, 1)' IN v_definition) = 0
     OR has_function_privilege(
       'anon', 'public.fn_create_seat_first_game_atomic(uuid,jsonb)', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.fn_create_seat_first_game_atomic(uuid,jsonb)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', 'public.fn_create_seat_first_game_atomic(uuid,jsonb)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'seat-first atomic creator is incomplete or exposed';
  END IF;
END;
$assert_atomic_seat_first_creator$;

COMMIT;
