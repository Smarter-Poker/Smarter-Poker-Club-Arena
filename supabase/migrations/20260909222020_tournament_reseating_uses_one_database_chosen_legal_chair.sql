-- 20260909222020_tournament_reseating_uses_one_database_chosen_legal_chair.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A manager snapshot used to choose a table and chair before the database
-- acquired the tournament seat locks. Deleted tables, format-specific seat
-- caps, capacity expansion and a concurrent seat claim could make that hint
-- stale. The RPC then returned a refusal forever while the positive roster
-- remained seatless. Make the existing locked database chooser authoritative;
-- the caller's coordinates are only preferences.
--
-- A second permanent refusal affected played Spins and heads-up seat-first
-- games. Initial admission must equal starting_chips, but a RUNNING player who
-- has played must be reseated with the exact latest accepted-hand stack. The
-- old birth guard applied the initial-admission rule to that lifecycle move.
-- It now accepts a different stack only when the locked playing roster and
-- both accepted-hand journals independently prove that exact value.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SET LOCAL transaction_timeout = '90s';

CREATE OR REPLACE FUNCTION public.fn_ca_guard_seat_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $seat_guard$
DECLARE
  v_path text:=current_setting('app.money_path',true);
  v_creating boolean;
  v_tournament_id uuid;
  v_tournament_status text;
  v_variant text;
  v_tournament_type text;
  v_max_players integer;
  v_starting_chips numeric;
BEGIN
  v_creating := (TG_OP='INSERT' AND NEW.left_at IS NULL)
             OR (TG_OP='UPDATE' AND OLD.left_at IS NOT NULL
                                      AND NEW.left_at IS NULL);
  IF NOT v_creating THEN
    RETURN NEW;
  END IF;

  SELECT tb.tournament_id,upper(COALESCE(t.status::text,'')),
         t.variant,t.tournament_type,t.max_players,t.starting_chips
    INTO v_tournament_id,v_tournament_status,v_variant,v_tournament_type,
         v_max_players,v_starting_chips
    FROM public.tables tb
    LEFT JOIN public.tournaments t ON t.id=tb.tournament_id
   WHERE tb.id=NEW.table_id;

  IF v_tournament_id IS NOT NULL THEN
    IF NEW.stack IS NULL
       OR NEW.stack::text IN ('NaN','Infinity','-Infinity')
       OR NEW.stack<=0 THEN
      RAISE EXCEPTION
        'TOURNAMENT_SEAT_REQUIRES_POSITIVE_STACK: tournament %, table %, seat %, stack %',
        v_tournament_id,NEW.table_id,NEW.seat_number,NEW.stack
        USING ERRCODE='check_violation',
              HINT='Create or revive the seat with its paid positive stack in the same database transaction.';
    END IF;

    IF lower(COALESCE(v_variant,''))='spin'
       OR upper(COALESCE(v_tournament_type,''))='SPIN'
       OR COALESCE(v_max_players,0)<=2 THEN
      IF v_starting_chips IS NULL
         OR v_starting_chips::text IN ('NaN','Infinity','-Infinity')
         OR v_starting_chips<=0 THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STARTING_CHIPS_INVALID: tournament %, starting_chips %',
          v_tournament_id,v_starting_chips
          USING ERRCODE='check_violation';
      END IF;

      IF NEW.stack IS DISTINCT FROM v_starting_chips
         AND NOT (
           v_path='fn_assign_tournament_player_seat_atomic'
           AND v_tournament_status='RUNNING'
           AND EXISTS (
             SELECT 1
               FROM public.tournament_players tp
              WHERE tp.tournament_id=v_tournament_id
                AND tp.user_id=NEW.user_id
                AND tp.status::text='playing'
                AND tp.chips::numeric IS NOT DISTINCT FROM NEW.stack)
           AND EXISTS (
             SELECT 1
               FROM (
                 SELECT h.table_id,h.hand_id,h.hand_number,h.stack_result
                   FROM public.hand_atomic_commits h
                   JOIN public.tables hand_table ON hand_table.id=h.table_id
                  WHERE hand_table.tournament_id=v_tournament_id
                    AND h.stack_result->'written' ? NEW.user_id::text
                    AND h.stack_result->>'success'='true'
                    AND h.post_commit_completed_at IS NOT NULL
                    AND h.post_commit_result->>'ok'='true'
                  ORDER BY h.hand_number DESC,h.table_id,h.hand_id
                  LIMIT 1
               ) latest
               JOIN public.settlement_idempotency_keys settled
                 ON settled.table_id=latest.table_id
                AND settled.hand_id=latest.hand_id
                AND settled.status='succeeded'
                AND settled.completed_at IS NOT NULL
                AND settled.result IS NOT DISTINCT FROM latest.stack_result
              WHERE latest.stack_result->>'hand_id'=latest.hand_id::text
                AND COALESCE(
                      latest.stack_result->'written'->>NEW.user_id::text,'')
                      ~'^-?[0-9]+([.][0-9]+)?$'
                AND (latest.stack_result->'written'->>NEW.user_id::text)::numeric
                      IS NOT DISTINCT FROM NEW.stack)
         ) THEN
        RAISE EXCEPTION
          'SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS: tournament %, table %, seat %, stack %, expected %',
          v_tournament_id,NEW.table_id,NEW.seat_number,NEW.stack,
          v_starting_chips
          USING ERRCODE='check_violation',
                HINT='Only initial admission uses starting_chips; a RUNNING lifecycle reseat must match the locked roster and latest accepted hand exactly.';
      END IF;
    END IF;
  END IF;

  -- Cash reservations keep their existing zero-stack path. A positive seat is
  -- still reachable only through the engine or one declared money authority.
  IF COALESCE(NEW.stack,0)<=0 THEN
    RETURN NEW;
  END IF;
  IF public.fn_caller_is_engine() THEN
    RETURN NEW;
  END IF;
  IF v_path IN (
       'atomic_table_buyin','fn_take_seat_and_buy_in',
       'fn_seat_horse_in_seat_first_game','fn_seat_late_registrant',
       'fn_assign_tournament_player_seat_atomic',
       'fn_horse_seat_from_treasury') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'SEAT_NOT_FUNDED: chips may only reach a seat through the engine or a declared money path (path=%, jwt_role=%, app=%, table=%, seat=%, stack=%)',
    COALESCE(NULLIF(v_path,''),'none'),COALESCE(auth.role(),'none'),
    COALESCE(NULLIF(current_setting('application_name',true),''),'none'),
    NEW.table_id,NEW.seat_number,NEW.stack
    USING ERRCODE='check_violation',
          HINT='The caller must debit a wallet or treasury and declare app.money_path, or be the engine.';
END;
$seat_guard$;

REVOKE ALL ON FUNCTION public.fn_ca_guard_seat_creation()
  FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION public.fn_ca_guard_seat_creation() IS
  'BEFORE-seat funding invariant. Initial Spin and heads-up seat-first admission equals starting_chips; a changed RUNNING lifecycle stack must match the locked playing roster and latest accepted hand in both journals.';

CREATE OR REPLACE FUNCTION public.fn_assign_tournament_player_seat_atomic(
  p_tournament_id uuid,
  p_user_id uuid,
  p_table_id uuid,
  p_seat_number integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $atomic_tournament_seat_assignment$
DECLARE
  v_gate jsonb;
  v_choice jsonb;
  v_existing_live_count integer;
  v_existing_table_id uuid;
  v_existing_seat_number integer;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION
      'fn_assign_tournament_player_seat_atomic requires service authority'
      USING ERRCODE='28000';
  END IF;

  -- Lock the tournament root, not a stale caller-selected child. The private
  -- chooser establishes capacity and locks one legal table/chair below that
  -- same root. Caller coordinates are preferences only.
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;

  -- A response-loss retry must replay the chair this player already owns.
  -- The free-chair chooser deliberately excludes occupied seats, so invoking
  -- it first would redirect a committed retry and hide the private assigner's
  -- exact replay receipt. Lock the beneficiary before its live seat, matching
  -- tournament -> roster -> seat order, and use the existing coordinates only
  -- when the locked database proves there is exactly one.
  PERFORM tp.id
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
   ORDER BY tp.id
   FOR UPDATE;
  PERFORM existing.id
    FROM public.table_seats existing
    JOIN public.tables existing_table ON existing_table.id=existing.table_id
   WHERE existing_table.tournament_id=p_tournament_id
     AND existing.user_id=p_user_id AND existing.left_at IS NULL
   ORDER BY existing.id
   FOR UPDATE OF existing;
  SELECT count(*)::integer
    INTO v_existing_live_count
    FROM public.table_seats existing
    JOIN public.tables existing_table ON existing_table.id=existing.table_id
   WHERE existing_table.tournament_id=p_tournament_id
     AND existing.user_id=p_user_id AND existing.left_at IS NULL;
  IF v_existing_live_count>1 THEN
    RAISE EXCEPTION 'tournament player already owns multiple live seats'
      USING ERRCODE='P0404';
  END IF;
  IF v_existing_live_count=1 THEN
    SELECT existing.table_id,existing.seat_number
      INTO STRICT v_existing_table_id,v_existing_seat_number
      FROM public.table_seats existing
      JOIN public.tables existing_table ON existing_table.id=existing.table_id
     WHERE existing_table.tournament_id=p_tournament_id
       AND existing.user_id=p_user_id AND existing.left_at IS NULL;
    RETURN public.fn_ca_assign_tournament_player_seat_locked(
      p_tournament_id,p_user_id,v_existing_table_id,
      v_existing_seat_number);
  END IF;

  v_choice:=public.fn_ca_choose_tournament_seat_locked(
    p_tournament_id,p_user_id,p_table_id,p_seat_number);
  IF COALESCE((v_choice->>'ok')::boolean,false) IS NOT TRUE
     OR v_choice->>'table_id' IS NULL
     OR v_choice->>'seat_number' IS NULL THEN
    RAISE EXCEPTION 'database tournament seat choice is not exact: %',v_choice
      USING ERRCODE='P0404';
  END IF;

  RETURN public.fn_ca_assign_tournament_player_seat_locked(
    p_tournament_id,p_user_id,(v_choice->>'table_id')::uuid,
    (v_choice->>'seat_number')::integer);
END;
$atomic_tournament_seat_assignment$;

REVOKE ALL ON FUNCTION public.fn_assign_tournament_player_seat_atomic(
  uuid,uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_assign_tournament_player_seat_atomic(
  uuid,uuid,uuid,integer) TO service_role;
COMMENT ON FUNCTION public.fn_assign_tournament_player_seat_atomic(
  uuid,uuid,uuid,integer) IS
  'Service-only atomic tournament reseat. Caller coordinates are hints; the locked database chooser owns capacity, legal format cap, table and chair selection before the exact assignment receipt commits.';

DO $prove_database_owned_tournament_reseating$
DECLARE
  v_assign text;
  v_choose text;
  v_guard text;
BEGIN
  SELECT p.prosrc INTO STRICT v_assign
    FROM pg_proc p
   WHERE p.oid=
     'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)'::regprocedure
     AND p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[];
  IF position(
       'fn_ca_lock_tournament_seat_acquisition(' IN v_assign)=0
     OR position(
          'p_tournament_id,NULL,p_user_id' IN
          regexp_replace(v_assign,'[[:space:]]','','g'))=0
     OR position('v_existing_live_count=1' IN
          regexp_replace(v_assign,'[[:space:]]','','g'))=0
     OR position('FOR UPDATE OF existing' IN v_assign)=0
     OR position('fn_ca_choose_tournament_seat_locked(' IN v_assign)=0
     OR position('fn_ca_assign_tournament_player_seat_locked(' IN v_assign)=0
     OR position(
          'fn_ca_assign_tournament_player_seat_locked(' IN
          substring(
            v_assign FROM
            position('fn_ca_choose_tournament_seat_locked(' IN v_assign)+1))=0
     OR has_function_privilege(
          'anon',
          'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
          'EXECUTE')
     OR has_function_privilege(
          'authenticated',
          'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
          'EXECUTE')
     OR NOT has_function_privilege(
          'service_role',
          'public.fn_assign_tournament_player_seat_atomic(uuid,uuid,uuid,integer)',
          'EXECUTE') THEN
    RAISE EXCEPTION 'database-owned tournament seat selection changed';
  END IF;

  SELECT p.prosrc INTO STRICT v_choose
    FROM pg_proc p
   WHERE p.oid=
     'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)'::regprocedure
     AND p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[];
  IF v_choose NOT LIKE '%fn_ensure_late_registration_capacity%'
     OR v_choose NOT LIKE '%fn_ca_tournament_seat_cap%'
     OR v_choose NOT LIKE '%NOT COALESCE(tb.is_deleted,false)%'
     OR v_choose NOT LIKE '%FOR UPDATE OF tb%'
     OR v_choose NOT LIKE '%generate_series%'
     OR v_choose NOT LIKE '%p_preferred_table_id%'
     OR has_function_privilege(
          'service_role',
          'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)',
          'EXECUTE')
     OR has_function_privilege(
          'service_role',
          'public.fn_ca_assign_tournament_player_seat_locked(uuid,uuid,uuid,integer)',
          'EXECUTE') THEN
    RAISE EXCEPTION 'private locked tournament chair chooser changed';
  END IF;

  SELECT p.prosrc INTO STRICT v_guard
    FROM pg_proc p
   WHERE p.oid='public.fn_ca_guard_seat_creation()'::regprocedure
     AND p.prosecdef
     AND p.proconfig @> ARRAY['search_path=public, pg_temp']::text[];
  IF v_guard NOT LIKE '%SEAT_FIRST_STACK_MUST_EQUAL_STARTING_CHIPS%'
     OR v_guard NOT LIKE '%fn_assign_tournament_player_seat_atomic%'
     OR v_guard NOT LIKE '%v_tournament_status=''RUNNING''%'
     OR v_guard NOT LIKE '%v_tournament_type%SPIN%'
     OR v_guard NOT LIKE '%public.tournament_players%'
     OR v_guard NOT LIKE '%public.hand_atomic_commits%'
     OR v_guard NOT LIKE '%public.settlement_idempotency_keys%'
     OR v_guard NOT LIKE '%latest.stack_result%NEW.user_id%'
     OR has_function_privilege(
          'service_role','public.fn_ca_guard_seat_creation()','EXECUTE')
     OR (SELECT count(*) FROM pg_trigger tg
          WHERE tg.tgrelid='public.table_seats'::regclass
            AND tg.tgname='trg_ca_guard_seat_creation'
            AND tg.tgfoid='public.fn_ca_guard_seat_creation()'::regprocedure
            AND NOT tg.tgisinternal AND tg.tgenabled<>'D')<>1 THEN
    RAISE EXCEPTION 'seat-first lifecycle funding distinction changed';
  END IF;
END;
$prove_database_owned_tournament_reseating$;

COMMIT;
