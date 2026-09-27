-- A started or finalized seat-first game cannot replace a paid player's stack.
-- The old horse endpoint skipped registration INSERT for an existing roster row,
-- bypassing the finalized-entry trigger before resetting the chair to starting_chips.
-- Keep the canonical acquisition/settlement locks and already-seated replay;
-- Apply the same prestart admission boundary as the human seat-first door.
-- No historical state repair or payment is performed by this migration.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

DO $preimage$
BEGIN
  IF md5(pg_get_functiondef(
      'public.fn_seat_horse_in_seat_first_game(uuid,uuid)'::regprocedure))
      IS DISTINCT FROM '5ede4cdd497feef79691a764cfa4871e' THEN
    RAISE EXCEPTION 'Horse seat admission source changed; requalify the current owner';
  END IF;
END;
$preimage$;

CREATE OR REPLACE FUNCTION public.fn_seat_horse_in_seat_first_game(
  p_tournament_id uuid, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
  v_status text;
  v_finalized boolean;
BEGIN
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;

  -- The canonical parent lock serializes this decision with launch/finalization.
  -- Existing live-chair replay still reaches the original read-only delegate.
  -- Like the human door, only ANNOUNCED/REGISTERING may acquire a fresh chair;
  -- launch need not have finalized the entry pool. NULL/unknown status refuses.
  SELECT t.status,t.prize_pool_finalized INTO v_status,v_finalized
    FROM public.tournaments t WHERE t.id=p_tournament_id;
  IF NOT EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id=public.fn_tournament_primary_table(p_tournament_id)
          AND s.user_id=p_user_id AND s.left_at IS NULL
     ) THEN
    IF (v_status IN ('ANNOUNCED','REGISTERING')) IS NOT TRUE THEN
      RETURN jsonb_build_object('ok',false,'reason','game_already_started');
    END IF;
    IF v_finalized IS TRUE THEN
      RETURN jsonb_build_object('ok',false,'reason','registration_closed');
    END IF;
  END IF;

  RETURN public.fn_seat_horse_in_seat_first_game_before_terminal_seat_gate(
    p_tournament_id,p_user_id);
END;
$function$;

-- Restate the existing engine-only ACL so this migration is independently safe.
-- CREATE OR REPLACE preserves postgres ownership; no role gains access.
REVOKE ALL ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_seat_horse_in_seat_first_game(uuid,uuid)
  TO service_role;
COMMIT;
