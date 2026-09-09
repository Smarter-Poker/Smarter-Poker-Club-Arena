-- 20260908230004_tournament_seat_moves_are_one_atomic_receipt
--
-- A tournament table move used to be five independent Data API requests:
-- read the source, close it, revive/insert the destination, clear a previous
-- pointer, and finally update tournament_players.  A timeout, process stop, or
-- competing writer between any two requests could leave a player seatless,
-- duplicated, pointed at the wrong chair, or moved after reaching zero chips.
--
-- This DB-first migration makes the complete move one database transaction.
-- It deliberately accepts either the current integer tournament roster or its
-- later bigint post-cutover shape: the function never changes chips, and both
-- types compare exactly to its positive whole-chip bigint receipt. Installing
-- this authority before the application caller and before normalization closes
-- the deployment gap without a feature flag, compatibility shim, or fallback.
-- The
-- caller names the exact source row AND joined_at generation it observed and
-- supplies a durable operation id.  A successful transaction writes one
-- immutable receipt; replaying that id returns the same authoritative
-- destination generation without touching the game a second time.

BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '30s';

/* Keep Supabase publication catalog work out of the DDL window.  The cutover
   runs with the engine stopped; NOWAIT makes a bad window fail as one unit. */
LOCK TABLE realtime.subscription IN ACCESS EXCLUSIVE MODE NOWAIT;

DO $require_atomic_move_predecessors$
BEGIN
  IF to_regprocedure(
       'public.fn_assert_tournament_manager_write_scope(uuid)'
     ) IS NULL
     OR to_regprocedure(
          'public.fn_lock_tournament_launch_proof_parents(uuid[])'
        ) IS NULL
     OR to_regprocedure('public.fn_platform_frozen()') IS NULL
     OR to_regprocedure('extensions.digest(bytea,text)') IS NULL THEN
    RAISE EXCEPTION
      'Atomic tournament moves require strict manager scope, launch-proof locks, and the platform freeze boundary';
  END IF;

  IF format_type(
       (SELECT a.atttypid FROM pg_attribute a
         WHERE a.attrelid = 'public.table_seats'::regclass
           AND a.attname = 'stack' AND NOT a.attisdropped),
       (SELECT a.atttypmod FROM pg_attribute a
         WHERE a.attrelid = 'public.table_seats'::regclass
           AND a.attname = 'stack' AND NOT a.attisdropped)
     ) <> 'numeric(15,2)'
     OR format_type(
       (SELECT a.atttypid FROM pg_attribute a
         WHERE a.attrelid = 'public.tournament_players'::regclass
           AND a.attname = 'chips' AND NOT a.attisdropped),
       (SELECT a.atttypmod FROM pg_attribute a
         WHERE a.attrelid = 'public.tournament_players'::regclass
           AND a.attname = 'chips' AND NOT a.attisdropped)
     ) NOT IN ('integer', 'bigint') THEN
    RAISE EXCEPTION
      'Atomic tournament moves require numeric(15,2) seat stacks and integer or bigint roster chips';
  END IF;
END;
$require_atomic_move_predecessors$;

/* This closes the pointer phantom: two active roster rows can no longer claim
   the same tournament chair even if two transactions began from stale reads.
   Historical eliminated/winner pointers remain testimony and are not changed. */
CREATE UNIQUE INDEX IF NOT EXISTS
  idx_tournament_players_one_active_destination_pointer
  ON public.tournament_players (tournament_id, table_id, seat_number)
  WHERE status IN ('registered', 'playing')
    AND table_id IS NOT NULL
    AND seat_number IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.tournament_seat_move_receipts (
  operation_id uuid PRIMARY KEY,
  tournament_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source_table_id uuid NOT NULL,
  source_seat_number integer NOT NULL CHECK (source_seat_number BETWEEN 1 AND 10),
  source_seat_id uuid NOT NULL,
  source_joined_at timestamptz NOT NULL,
  destination_table_id uuid NOT NULL,
  destination_seat_number integer NOT NULL
    CHECK (destination_seat_number BETWEEN 1 AND 10),
  destination_seat_id uuid NOT NULL,
  destination_joined_at timestamptz NOT NULL,
  stack bigint NOT NULL CHECK (stack > 0 AND stack <= 9999999999999),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  manager_actor text NOT NULL CHECK (manager_actor = 'tournament-manager'),
  lease_generation uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'committed' CHECK (outcome = 'committed'),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tournament_seat_move_changes_table
    CHECK (source_table_id <> destination_table_id),
  CONSTRAINT tournament_seat_move_source_generation_once
    UNIQUE (tournament_id, user_id, source_seat_id, source_joined_at)
);

ALTER TABLE public.tournament_seat_move_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_seat_move_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_seat_move_receipts
  FROM PUBLIC, anon, authenticated, service_role;

/* Never leave the former integer signature beside the bigint door. Named
   Data API arguments cannot disambiguate those otherwise identical overloads. */
DROP FUNCTION IF EXISTS public.fn_move_tournament_player_atomic(
  uuid, uuid, uuid, uuid, integer, uuid, timestamptz, integer, uuid, integer
);

CREATE OR REPLACE FUNCTION public.fn_move_tournament_player_atomic(
  p_operation_id uuid,
  p_tournament_id uuid,
  p_user_id uuid,
  p_source_table_id uuid,
  p_source_seat_number integer,
  p_source_seat_id uuid,
  p_source_joined_at timestamptz,
  p_expected_stack bigint,
  p_destination_table_id uuid,
  p_destination_seat_number integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_receipt public.tournament_seat_move_receipts%ROWTYPE;
  v_source_table public.tables%ROWTYPE;
  v_destination_table public.tables%ROWTYPE;
  v_player public.tournament_players%ROWTYPE;
  v_source public.table_seats%ROWTYPE;
  v_destination public.table_seats%ROWTYPE;
  v_destination_id uuid;
  v_destination_joined_at timestamptz;
  v_stack bigint;
  v_detail text;
  v_request_hash text;
  v_manager_actor text;
  v_lease_generation uuid;
  v_table_id uuid;
  v_tournament_status text;
  v_table_rows integer;
BEGIN
  IF p_operation_id IS NULL OR p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_table_id IS NULL OR p_source_seat_id IS NULL
     OR p_source_joined_at IS NULL OR p_destination_table_id IS NULL
     OR p_source_seat_number IS NULL OR p_destination_seat_number IS NULL
     OR p_expected_stack IS NULL OR p_expected_stack <= 0
     OR p_expected_stack > 9999999999999
     OR p_source_table_id = p_destination_table_id
     OR p_source_seat_number NOT BETWEEN 1 AND 10
     OR p_destination_seat_number NOT BETWEEN 1 AND 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  /* The request hook already proved and transaction-locked the exact current
     lease generation.  Re-assert its tournament scope inside this SECURITY
     DEFINER boundary so a direct SQL/application-role call cannot omit it. */
  PERFORM public.fn_assert_tournament_manager_write_scope(p_tournament_id);

  v_manager_actor := current_setting('app.smarter_data_actor', true);
  BEGIN
    v_lease_generation := NULLIF(
      current_setting('app.smarter_tournament_lease_generation', true), ''
    )::uuid;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_INVALID: malformed move authority'
      USING ERRCODE = '22023';
  END;
  IF v_manager_actor IS DISTINCT FROM 'tournament-manager'
     OR v_lease_generation IS NULL THEN
    RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_REQUIRED: move authority is absent'
      USING ERRCODE = '42501';
  END IF;

  v_request_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'operation_id', p_operation_id,
    'tournament_id', p_tournament_id,
    'user_id', p_user_id,
    'source_table_id', p_source_table_id,
    'source_seat_number', p_source_seat_number,
    'source_seat_id', p_source_seat_id,
    'source_joined_at', p_source_joined_at,
    'expected_stack', p_expected_stack,
    'destination_table_id', p_destination_table_id,
    'destination_seat_number', p_destination_seat_number
  )::text, 'UTF8'), 'sha256'), 'hex');

  /* Same operation ids serialize even before the receipt exists.  This is a
     transaction-scoped lock, not a scheduler or a repair path. */
  PERFORM pg_advisory_xact_lock(
    hashtextextended('tournament-seat-move:' || p_operation_id::text, 230004)
  );

  SELECT * INTO v_receipt
    FROM public.tournament_seat_move_receipts r
   WHERE r.operation_id = p_operation_id
   FOR UPDATE;
  IF FOUND THEN
    IF v_receipt.tournament_id IS DISTINCT FROM p_tournament_id
       OR v_receipt.user_id IS DISTINCT FROM p_user_id
       OR v_receipt.source_table_id IS DISTINCT FROM p_source_table_id
       OR v_receipt.source_seat_number IS DISTINCT FROM p_source_seat_number
       OR v_receipt.source_seat_id IS DISTINCT FROM p_source_seat_id
       OR v_receipt.source_joined_at IS DISTINCT FROM p_source_joined_at
       OR v_receipt.stack IS DISTINCT FROM p_expected_stack
       OR v_receipt.destination_table_id IS DISTINCT FROM p_destination_table_id
       OR v_receipt.destination_seat_number IS DISTINCT FROM p_destination_seat_number
       OR v_receipt.request_hash IS DISTINCT FROM v_request_hash THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'operation_id_conflict');
    END IF;
    RETURN jsonb_build_object(
      'ok', true,
      'committed', true,
      'replayed', true,
      'operation_id', v_receipt.operation_id,
      'tournament_id', v_receipt.tournament_id,
      'user_id', v_receipt.user_id,
      'source_table_id', v_receipt.source_table_id,
      'source_seat_number', v_receipt.source_seat_number,
      'source_seat_id', v_receipt.source_seat_id,
      'source_joined_at', v_receipt.source_joined_at,
      'destination_table_id', v_receipt.destination_table_id,
      'destination_seat_number', v_receipt.destination_seat_number,
      'destination_seat_id', v_receipt.destination_seat_id,
      'destination_joined_at', v_receipt.destination_joined_at,
      'stack', v_receipt.stack,
      'request_hash', v_receipt.request_hash,
      'manager_actor', v_receipt.manager_actor,
      'lease_generation', v_receipt.lease_generation
    );
  END IF;

  /* A previously committed receipt remains observable during a later freeze;
     only a NEW move is forbidden by the platform boundary. */
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'platform_frozen');
  END IF;

  /* Hand settlement enters atomic-table advisory -> tournament SHARE.  Take
     BOTH table keys, UUID-sorted, before the launch-proof/tournament boundary.
     Try-locking is deliberate: an in-flight hand keeps its authority and this
     move cleanly defers instead of either side waiting into a cycle. */
  FOR v_table_id IN
    SELECT requested.id
      FROM unnest(ARRAY[p_source_table_id, p_destination_table_id]) requested(id)
     ORDER BY requested.id
  LOOP
    IF NOT pg_try_advisory_xact_lock(
      hashtextextended('atomic-table:' || v_table_id::text, 0)
    ) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'table_hand_boundary_busy');
    END IF;
  END LOOP;

  /* Launch children use receipt -> tournament.  Enter that canonical order
     before locking table, roster, or seat rows; never invert it here. */
  PERFORM * FROM public.fn_lock_tournament_launch_proof_parents(
    ARRAY[p_tournament_id]
  );
  SELECT upper(COALESCE(t.status::text, '')) INTO v_tournament_status
    FROM public.tournaments t WHERE t.id = p_tournament_id;
  IF v_tournament_status IS DISTINCT FROM 'RUNNING' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_running');
  END IF;

  /* A table writer may already own its executor row and be waiting for the
     parent proof we now hold.  NOWAIT converts that shape into a clean refusal
     instead of forming a cycle.  One later manager pass can safely retry. */
  BEGIN
    PERFORM t.id
      FROM public.tables t
     WHERE t.id IN (p_source_table_id, p_destination_table_id)
     ORDER BY t.id
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_busy');
  END;

  SELECT * INTO v_source_table
    FROM public.tables t WHERE t.id = p_source_table_id;
  SELECT * INTO v_destination_table
    FROM public.tables t WHERE t.id = p_destination_table_id;
  IF v_source_table.id IS NULL OR v_destination_table.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;
  IF v_source_table.tournament_id IS DISTINCT FROM p_tournament_id
     OR v_destination_table.tournament_id IS DISTINCT FROM p_tournament_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_table_mismatch');
  END IF;
  IF lower(COALESCE(v_destination_table.status::text, ''))
       NOT IN ('waiting', 'active', 'running')
     OR COALESCE(v_destination_table.is_deleted, false)
     OR lower(COALESCE(v_destination_table.lifecycle::text, 'live'))
          IN ('breaking', 'closed') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_not_open');
  END IF;
  IF p_destination_seat_number > COALESCE(v_destination_table.max_players, 0) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_seat_out_of_range');
  END IF;

  /* Lock the moving roster row and any current claimant of the destination in
     UUID order.  The unique partial index above is the final arbiter of a
     claimant that changes its pointer after this predicate snapshot. */
  BEGIN
    PERFORM tp.id
      FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND (
         tp.user_id = p_user_id
         OR (
           tp.status IN ('registered', 'playing')
           AND tp.table_id = p_destination_table_id
           AND tp.seat_number = p_destination_seat_number
         )
       )
     ORDER BY tp.user_id, tp.id
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'player_busy');
  END;

  SELECT * INTO v_player
    FROM public.tournament_players tp
   WHERE tp.tournament_id = p_tournament_id AND tp.user_id = p_user_id;
  IF v_player.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'player_not_found');
  END IF;
  IF v_player.status IS DISTINCT FROM 'playing'
     OR v_player.table_id IS DISTINCT FROM p_source_table_id
     OR v_player.seat_number IS DISTINCT FROM p_source_seat_number THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'player_pointer_mismatch');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id = p_tournament_id
       AND tp.user_id <> p_user_id
       AND tp.status IN ('registered', 'playing')
       AND tp.table_id = p_destination_table_id
       AND tp.seat_number = p_destination_seat_number
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_pointer_occupied');
  END IF;

  /* Lock both physical chairs in stable order.  An absent destination row is
     still protected by UNIQUE(table_id,seat_number) at INSERT. */
  BEGIN
    PERFORM s.id
      FROM public.table_seats s
     WHERE s.id = p_source_seat_id
        OR (s.table_id = p_destination_table_id
            AND s.seat_number = p_destination_seat_number)
     ORDER BY s.table_id, s.seat_number, s.id
     FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'seat_busy');
  END;

  SELECT * INTO v_source
    FROM public.table_seats s WHERE s.id = p_source_seat_id;
  IF v_source.id IS NULL
     OR v_source.table_id IS DISTINCT FROM p_source_table_id
     OR v_source.seat_number IS DISTINCT FROM p_source_seat_number
     OR v_source.user_id IS DISTINCT FROM p_user_id
     OR v_source.joined_at IS DISTINCT FROM p_source_joined_at
     OR v_source.left_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_generation_mismatch');
  END IF;
  IF v_source.stack IS NULL
     OR lower(v_source.stack::text) IN ('nan', 'infinity', '-infinity')
     OR v_source.stack <= 0
     OR v_source.stack > 9999999999999
     OR v_source.stack <> trunc(v_source.stack) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_stack_not_positive_whole');
  END IF;
  v_stack := v_source.stack::bigint;
  IF v_stack IS DISTINCT FROM p_expected_stack THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_stack_changed');
  END IF;
  IF v_player.chips IS DISTINCT FROM v_stack THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'source_player_chip_mismatch');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.table_seats other_seat
      JOIN public.tables other_table ON other_table.id = other_seat.table_id
     WHERE other_table.tournament_id = p_tournament_id
       AND other_seat.user_id = p_user_id
       AND other_seat.left_at IS NULL
       AND other_seat.id <> p_source_seat_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'player_has_another_live_seat');
  END IF;

  SELECT * INTO v_destination
    FROM public.table_seats s
   WHERE s.table_id = p_destination_table_id
     AND s.seat_number = p_destination_seat_number;
  IF v_destination.id IS NOT NULL AND v_destination.left_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_seat_occupied');
  END IF;

  v_destination_joined_at := clock_timestamp();
  BEGIN
    /* The source closes before the destination opens only inside this one
       transaction, because the existing one-live-seat guard correctly rejects
       two live tournament chairs.  Any later failure rolls this subtransaction
       back, so no observer can ever see the player seatless. */
    UPDATE public.table_seats
       SET left_at = v_destination_joined_at,
           is_sitting_out = false,
           is_away = false,
           status = 'left',
           leave_pending = false
     WHERE id = v_source.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'source generation disappeared during atomic move'
        USING ERRCODE = '40001';
    END IF;

    IF v_destination.id IS NOT NULL THEN
      UPDATE public.table_seats
         SET user_id = p_user_id,
             member_id = v_source.member_id,
             stack = v_stack,
             is_sitting_out = false,
             is_away = false,
             joined_at = v_destination_joined_at,
             horse_id = v_source.horse_id,
             status = 'active',
             leave_pending = false,
             auto_rebuy = v_source.auto_rebuy,
             time_bank_remaining = v_source.time_bank_remaining,
             time_bank_uses_remaining = v_source.time_bank_uses_remaining,
             club_id = v_source.club_id,
             sit_out_at = NULL,
             entry_hold = NULL,
             entry_post_agreed = v_source.entry_post_agreed,
             left_at = NULL
       WHERE id = v_destination.id
         AND left_at IS NOT NULL
       RETURNING id INTO v_destination_id;
    ELSE
      INSERT INTO public.table_seats (
        table_id, seat_number, user_id, member_id, stack,
        is_sitting_out, is_away, joined_at, horse_id, status,
        leave_pending, auto_rebuy, time_bank_remaining,
        time_bank_uses_remaining, club_id, sit_out_at, entry_hold,
        entry_post_agreed, left_at
      ) VALUES (
        p_destination_table_id, p_destination_seat_number, p_user_id,
        v_source.member_id, v_stack, false, false,
        v_destination_joined_at, v_source.horse_id, 'active', false,
        v_source.auto_rebuy, v_source.time_bank_remaining,
        v_source.time_bank_uses_remaining, v_source.club_id, NULL, NULL,
        v_source.entry_post_agreed, NULL
      ) RETURNING id INTO v_destination_id;
    END IF;
    IF v_destination_id IS NULL THEN
      RAISE EXCEPTION 'destination chair changed during atomic move'
        USING ERRCODE = '40001';
    END IF;

    UPDATE public.tournament_players tp
       SET table_id = p_destination_table_id,
           seat_number = p_destination_seat_number
     WHERE tp.id = v_player.id
       AND tp.status = 'playing'
       AND tp.table_id = p_source_table_id
       AND tp.seat_number = p_source_seat_number;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'player pointer changed during atomic move'
        USING ERRCODE = '40001';
    END IF;

    /* Ordinary tournaments are intentionally outside the seat-first cash
       inventory trigger. Recount both already-locked executor rows here so
       lobby/UI occupancy commits with the seat and pointer postimage, not on
       some later hand or reconciliation pass. */
    UPDATE public.tables moved_table
       SET current_players = (
         SELECT count(*)::integer
           FROM public.table_seats active_seat
          WHERE active_seat.table_id = moved_table.id
            AND active_seat.left_at IS NULL
       )
     WHERE moved_table.id IN (p_source_table_id, p_destination_table_id);
    GET DIAGNOSTICS v_table_rows = ROW_COUNT;
    IF v_table_rows IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'table occupancy rows disappeared during atomic move'
        USING ERRCODE = '40001';
    END IF;

    INSERT INTO public.tournament_seat_move_receipts (
      operation_id, tournament_id, user_id,
      source_table_id, source_seat_number, source_seat_id, source_joined_at,
      destination_table_id, destination_seat_number,
      destination_seat_id, destination_joined_at, stack, request_hash,
      manager_actor, lease_generation
    ) VALUES (
      p_operation_id, p_tournament_id, p_user_id,
      p_source_table_id, p_source_seat_number, p_source_seat_id,
      p_source_joined_at, p_destination_table_id,
      p_destination_seat_number, v_destination_id,
      v_destination_joined_at, v_stack, v_request_hash,
      v_manager_actor, v_lease_generation
    ) RETURNING * INTO v_receipt;
  EXCEPTION
    WHEN unique_violation OR check_violation OR foreign_key_violation
      OR serialization_failure OR deadlock_detected OR raise_exception THEN
      GET STACKED DIAGNOSTICS v_detail = MESSAGE_TEXT;
      RETURN jsonb_build_object(
        'ok', false,
        'reason', 'atomic_move_refused',
        'detail', left(COALESCE(v_detail, 'database guard refused move'), 240)
      );
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'committed', true,
    'replayed', false,
    'operation_id', v_receipt.operation_id,
    'tournament_id', v_receipt.tournament_id,
    'user_id', v_receipt.user_id,
    'source_table_id', v_receipt.source_table_id,
    'source_seat_number', v_receipt.source_seat_number,
    'source_seat_id', v_receipt.source_seat_id,
    'source_joined_at', v_receipt.source_joined_at,
    'destination_table_id', v_receipt.destination_table_id,
    'destination_seat_number', v_receipt.destination_seat_number,
    'destination_seat_id', v_receipt.destination_seat_id,
    'destination_joined_at', v_receipt.destination_joined_at,
    'stack', v_receipt.stack,
    'request_hash', v_receipt.request_hash,
    'manager_actor', v_receipt.manager_actor,
    'lease_generation', v_receipt.lease_generation
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_move_tournament_player_atomic(
  uuid, uuid, uuid, uuid, integer, uuid, timestamptz, bigint, uuid, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_move_tournament_player_atomic(
  uuid, uuid, uuid, uuid, integer, uuid, timestamptz, bigint, uuid, integer
) TO service_role;

COMMENT ON TABLE public.tournament_seat_move_receipts IS
  'Immutable proof that one exact tournament seat generation moved atomically.';
COMMENT ON FUNCTION public.fn_move_tournament_player_atomic(
  uuid, uuid, uuid, uuid, integer, uuid, timestamptz, bigint, uuid, integer
) IS
  'Manager-lease-only, idempotent tournament table move; validates and commits source, destination, roster pointer, and receipt in one transaction.';

DO $assert_atomic_tournament_move$
DECLARE
  v_source text;
  v_search_path text[];
  v_receipt_shape text[];
BEGIN
  SELECT p.prosrc, p.proconfig
    INTO STRICT v_source, v_search_path
    FROM pg_proc p
   WHERE p.oid =
     'public.fn_move_tournament_player_atomic(uuid,uuid,uuid,uuid,integer,uuid,timestamptz,bigint,uuid,integer)'::regprocedure
     AND p.prosecdef;

  SELECT array_agg(
           a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' ||
           CASE WHEN a.attnotnull THEN 'not-null' ELSE 'nullable' END
           ORDER BY a.attnum
         )
    INTO v_receipt_shape
    FROM pg_attribute a
   WHERE a.attrelid = 'public.tournament_seat_move_receipts'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF v_receipt_shape IS DISTINCT FROM ARRAY[
       'operation_id:uuid:not-null',
       'tournament_id:uuid:not-null',
       'user_id:uuid:not-null',
       'source_table_id:uuid:not-null',
       'source_seat_number:integer:not-null',
       'source_seat_id:uuid:not-null',
       'source_joined_at:timestamp with time zone:not-null',
       'destination_table_id:uuid:not-null',
       'destination_seat_number:integer:not-null',
       'destination_seat_id:uuid:not-null',
       'destination_joined_at:timestamp with time zone:not-null',
       'stack:bigint:not-null',
       'request_hash:text:not-null',
       'manager_actor:text:not-null',
       'lease_generation:uuid:not-null',
       'outcome:text:not-null',
       'committed_at:timestamp with time zone:not-null'
     ]::text[] THEN
    RAISE EXCEPTION 'Atomic tournament move receipt schema is not exact: %', v_receipt_shape;
  END IF;

  IF v_search_path IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR position('fn_assert_tournament_manager_write_scope' IN v_source) = 0
     OR position('fn_lock_tournament_launch_proof_parents' IN v_source) = 0
     OR position('source_generation_mismatch' IN v_source) = 0
     OR position('source_stack_not_positive_whole' IN v_source) = 0
     OR position('source_stack_changed' IN v_source) = 0
     OR position('source_player_chip_mismatch' IN v_source) = 0
     OR position('p_expected_stack > 9999999999999' IN v_source) = 0
     OR position('SET current_players' IN v_source) = 0
     OR position($needle$'atomic-table:'$needle$ IN v_source) = 0
     OR position('pg_try_advisory_xact_lock' IN v_source) = 0
     OR position('FOR UPDATE NOWAIT' IN v_source) = 0
     OR position('tournament_seat_move_receipts' IN v_source) = 0
     OR position('replayed' IN v_source) = 0 THEN
    RAISE EXCEPTION 'Atomic tournament move function lost a required authority, generation, lock, chip, or receipt guard';
  END IF;

  IF NOT EXISTS (
       SELECT 1 FROM pg_class c
        WHERE c.oid = 'public.tournament_seat_move_receipts'::regclass
          AND c.relrowsecurity AND c.relforcerowsecurity
     )
     OR has_table_privilege('anon', 'public.tournament_seat_move_receipts', 'SELECT')
     OR has_table_privilege('anon', 'public.tournament_seat_move_receipts', 'INSERT')
     OR has_table_privilege('anon', 'public.tournament_seat_move_receipts', 'UPDATE')
     OR has_table_privilege('anon', 'public.tournament_seat_move_receipts', 'DELETE')
     OR has_table_privilege('authenticated', 'public.tournament_seat_move_receipts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.tournament_seat_move_receipts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.tournament_seat_move_receipts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.tournament_seat_move_receipts', 'DELETE')
     OR has_table_privilege('service_role', 'public.tournament_seat_move_receipts', 'SELECT')
     OR has_table_privilege('service_role', 'public.tournament_seat_move_receipts', 'INSERT')
     OR has_table_privilege('service_role', 'public.tournament_seat_move_receipts', 'UPDATE')
     OR has_table_privilege('service_role', 'public.tournament_seat_move_receipts', 'DELETE')
     OR to_regprocedure(
          'public.fn_move_tournament_player_atomic(uuid,uuid,uuid,uuid,integer,uuid,timestamptz,integer,uuid,integer)'
        ) IS NOT NULL
     OR EXISTS (
          SELECT 1 FROM pg_policy p
           WHERE p.polrelid = 'public.tournament_seat_move_receipts'::regclass
        )
     OR has_function_privilege(
          'anon',
          'public.fn_move_tournament_player_atomic(uuid,uuid,uuid,uuid,integer,uuid,timestamptz,bigint,uuid,integer)',
          'EXECUTE'
        )
     OR has_function_privilege(
          'authenticated',
          'public.fn_move_tournament_player_atomic(uuid,uuid,uuid,uuid,integer,uuid,timestamptz,bigint,uuid,integer)',
          'EXECUTE'
        )
     OR NOT has_function_privilege(
          'service_role',
          'public.fn_move_tournament_player_atomic(uuid,uuid,uuid,uuid,integer,uuid,timestamptz,bigint,uuid,integer)',
          'EXECUTE'
        ) THEN
    RAISE EXCEPTION 'Atomic tournament move RLS or application ACL is not strict';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_class index_relation
         JOIN pg_namespace index_namespace
           ON index_namespace.oid = index_relation.relnamespace
         JOIN pg_index index_catalog
           ON index_catalog.indexrelid = index_relation.oid
        WHERE index_namespace.nspname = 'public'
          AND index_relation.relname =
                'idx_tournament_players_one_active_destination_pointer'
          AND index_catalog.indrelid = 'public.tournament_players'::regclass
          AND index_catalog.indisunique
          AND index_catalog.indisvalid
          AND index_catalog.indisready
          AND index_catalog.indnkeyatts = 3
          AND index_catalog.indnatts = 3
          AND ARRAY(
                SELECT attribute.attname::text
                  FROM unnest(index_catalog.indkey)
                       WITH ORDINALITY AS key_column(attnum, position)
                  JOIN pg_attribute attribute
                    ON attribute.attrelid = index_catalog.indrelid
                   AND attribute.attnum = key_column.attnum
                 ORDER BY key_column.position
              ) = ARRAY['tournament_id', 'table_id', 'seat_number']::text[]
          AND pg_get_expr(
                index_catalog.indpred, index_catalog.indrelid, true
              ) = '(status = ANY (ARRAY[''registered''::text, ''playing''::text])) AND table_id IS NOT NULL AND seat_number IS NOT NULL'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = 'public.tournament_seat_move_receipts'::regclass
          AND c.conname = 'tournament_seat_move_source_generation_once'
          AND c.contype = 'u'
     ) THEN
    RAISE EXCEPTION 'Atomic tournament move uniqueness guards are missing';
  END IF;
END;
$assert_atomic_tournament_move$;

/* Publish the new RPC only after this transaction commits. The strict-manager
   migration's earlier reload cannot advertise a function that did not yet
   exist, and a caller must never observe a correct pg_proc row through a stale
   PostgREST schema cache. */
NOTIFY pgrst, 'reload schema';

COMMIT;
