-- 20260909182952_a_committed_tournament_move_receipt_survives_lease_loss
--
-- A tournament table move already had one atomic writer and an immutable
-- request receipt. The writer looked for that receipt only after PostgREST had
-- admitted the caller's current tournament-manager lease. If the write
-- committed but its HTTP response was lost, then the lease expired before the
-- retry, PostgREST refused the retry before the function ran and the old
-- engine generation could never certify the committed result.
--
-- This adds one service-only, receipt-only resolver. It accepts the complete
-- expected move identity, serializes behind the same global settlement lock as
-- the writer, and returns an existing immutable receipt only when every field
-- matches. It cannot create, update, delete, retry or compensate a move. A
-- missing receipt remains an unknown outcome because an already admitted
-- request could still be waiting for the same lock. The engine therefore
-- releases its move fence only after receiving exact committed evidence.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '45s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('public.tournament_seat_move_receipts') IS NULL
     OR to_regprocedure('public.fn_ca_tournament_seat_move_receipt(uuid)') IS NULL
     OR to_regprocedure(
          'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'
        ) IS NULL THEN
    RAISE EXCEPTION 'atomic tournament move receipt authority is missing';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.fn_resolve_committed_tournament_seat_move(
  p_request_id uuid,
  p_tournament_id uuid,
  p_user_id uuid,
  p_source_table_id uuid,
  p_destination_table_id uuid,
  p_destination_seat_number integer,
  p_source_mode text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
SET statement_timeout TO '30s'
AS $committed_move_receipt$
DECLARE
  v_actor text:=NULLIF(current_setting('app.smarter_data_actor',true),'');
  v_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role'
     OR v_actor IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'committed tournament move receipt requires ordinary service authority'
      USING ERRCODE='28000';
  END IF;
  IF p_request_id IS NULL OR p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_table_id IS NULL OR p_destination_table_id IS NULL
     OR p_source_table_id=p_destination_table_id
     OR p_destination_seat_number NOT BETWEEN 1 AND 10
     OR p_source_mode NOT IN ('live_source','closed_orphan') THEN
    RAISE EXCEPTION 'invalid committed tournament move receipt identity'
      USING ERRCODE='22023';
  END IF;

  -- The writer takes this lock before its first receipt read and holds it
  -- through commit. Waiting here makes a receipt read observe any writer that
  -- already owns the settlement boundary. An absent receipt is deliberately
  -- not converted into proof that no write can still begin later.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));

  v_result:=public.fn_ca_tournament_seat_move_receipt(p_request_id);
  IF v_result IS NULL THEN
    RETURN NULL;
  END IF;
  IF (v_result->>'tournament_id')::uuid IS DISTINCT FROM p_tournament_id
     OR (v_result->>'user_id')::uuid IS DISTINCT FROM p_user_id
     OR (v_result->>'source_table_id')::uuid IS DISTINCT FROM p_source_table_id
     OR (v_result->>'destination_table_id')::uuid
          IS DISTINCT FROM p_destination_table_id
     OR (v_result->>'destination_seat_number')::integer
          IS DISTINCT FROM p_destination_seat_number
     OR v_result->>'source_mode' IS DISTINCT FROM p_source_mode THEN
    RAISE EXCEPTION 'tournament move request id belongs to another operation'
      USING ERRCODE='23505';
  END IF;
  RETURN v_result||jsonb_build_object('replayed',true);
END;
$committed_move_receipt$;

REVOKE ALL ON FUNCTION public.fn_resolve_committed_tournament_seat_move(
  uuid,uuid,uuid,uuid,uuid,integer,text
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_resolve_committed_tournament_seat_move(
  uuid,uuid,uuid,uuid,uuid,integer,text
) TO service_role;

COMMENT ON FUNCTION public.fn_resolve_committed_tournament_seat_move(
  uuid,uuid,uuid,uuid,uuid,integer,text
) IS 'Service-only exact lookup for a committed immutable tournament seat-move receipt after a manager response becomes ambiguous. It performs no tournament mutation.';

DO $verify$
DECLARE
  v_source text;
BEGIN
  SELECT p.prosrc INTO v_source
    FROM pg_proc p
   WHERE p.oid='public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)'::regprocedure;
  IF v_source NOT LIKE '%app.smarter_data_actor%'
     OR v_source NOT LIKE '%auth.role() IS DISTINCT FROM ''service_role''%'
     OR v_source NOT LIKE '%ca:tournament-terminal-settlement:v1%'
     OR v_source NOT LIKE '%fn_ca_tournament_seat_move_receipt(p_request_id)%'
     OR v_source NOT LIKE '%RETURN NULL%'
     OR v_source ~* '\m(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\M'
     OR has_function_privilege('anon',
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
          'EXECUTE')
     OR has_function_privilege('authenticated',
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
          'EXECUTE')
     OR NOT has_function_privilege('service_role',
          'public.fn_resolve_committed_tournament_seat_move(uuid,uuid,uuid,uuid,uuid,integer,text)',
          'EXECUTE') THEN
    RAISE EXCEPTION 'committed tournament move receipt resolver verification failed';
  END IF;
END;
$verify$;

COMMIT;
