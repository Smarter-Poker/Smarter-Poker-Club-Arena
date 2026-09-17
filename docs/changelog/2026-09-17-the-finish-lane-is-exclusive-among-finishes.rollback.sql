-- 2026-09-17-the-finish-lane-is-exclusive-among-finishes.rollback.sql
--
-- Rollback of 20260917082500_the_finish_lane_is_exclusive_among_finishes.sql:
-- restores every definition it replaced, byte for byte as captured from
-- production on 2026-09-17 08:30 UTC, and drops the finish lane. One
-- transaction, one schema-cache reload.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal(p_tournament_id uuid, p_observed_winner_id uuid, p_settlement_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '45s'
AS $function$
DECLARE
  v_token uuid;
  v_result jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'terminal settlement requires service authority'
      USING ERRCODE='28000';
  END IF;
  PERFORM public.fn_ca_lock_settlement_lane_global();
  v_token:=public.fn_ca_open_tournament_seat_exit_authority(
    p_tournament_id,'terminal_finish',NULL);
  BEGIN
    v_result:=public.fn_complete_tournament_terminal_pre_seat_guard(
      p_tournament_id,p_observed_winner_id,p_settlement_mode);
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(
      v_token,COALESCE((v_result->>'ok')::boolean,false));
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.fn_ca_close_tournament_seat_exit_authority(v_token,false);
    RAISE;
  END;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_lock_settlement_lane_global()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- G then B. Terminal / rare authorities: serialised against every other
  -- authority AND against every hand settlement, as on 2026-09-09.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1', 0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:hand-settlement-barrier:v1', 0));
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_resolve_tournament_terminal_outcome(p_tournament_id uuid, p_observed_winner_id uuid, p_settlement_mode text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '45s'
AS $function$
DECLARE
  v_mode text := lower(btrim(COALESCE(p_settlement_mode,'')));
  v_t record;
  v_h public.tournament_terminal_settlements%ROWTYPE;
  v_receipt jsonb;
BEGIN
  PERFORM public.fn_ca_lock_settlement_lane_global();
  IF p_tournament_id IS NULL THEN
    RAISE EXCEPTION 'terminal outcome requires a tournament id'
      USING ERRCODE = '22004';
  END IF;
  IF v_mode NOT IN ('places','final_table_deal') THEN
    RAISE EXCEPTION 'unknown terminal outcome mode %',p_settlement_mode
      USING ERRCODE = '22023';
  END IF;
  SELECT t.* INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'tournament % does not exist',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  IF lower(COALESCE(v_t.variant::text,'')) = 'satellite'
     OR upper(COALESCE(v_t.tournament_type::text,'')) = 'SATELLITE'
     OR v_t.satellite_target_id IS NOT NULL
     OR v_t.satellite_target IS NOT NULL THEN
    RAISE EXCEPTION 'tournament % is a satellite',p_tournament_id
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_h FROM public.tournament_terminal_settlements h
   WHERE h.tournament_id = p_tournament_id;
  IF FOUND THEN
    IF v_h.settlement_mode IS DISTINCT FROM v_mode
       OR (p_observed_winner_id IS NOT NULL
           AND v_h.winner_id IS DISTINCT FROM p_observed_winner_id) THEN
      RAISE EXCEPTION 'terminal outcome parameters disagree with stored receipt for %',
        p_tournament_id USING ERRCODE = '40001';
    END IF;
    v_receipt := public.fn_ca_tournament_terminal_receipt(
      p_tournament_id,p_observed_winner_id);
    RETURN jsonb_build_object(
      'ok',true,
      'terminal_committed',true,
      'definitively_not_committed',false,
      'status','COMPLETED',
      'mode',v_mode,
      'tournament_id',p_tournament_id,
      'receipt',v_receipt);
  END IF;

  IF upper(COALESCE(v_t.status::text,'')) = 'COMPLETED' THEN
    RAISE EXCEPTION 'completed tournament % has no atomic terminal receipt',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('RUNNING','COMPLETING') THEN
    RAISE EXCEPTION 'tournament % has non-terminal-outcome status %',
      p_tournament_id,v_t.status USING ERRCODE = '55000';
  END IF;
  RETURN jsonb_build_object(
    'ok',true,
    'terminal_committed',false,
    'definitively_not_committed',true,
    'status',upper(v_t.status::text),
    'mode',v_mode,
    'tournament_id',p_tournament_id,
    'receipt','null'::jsonb);
END;
$function$;

DROP FUNCTION IF EXISTS public.fn_ca_lock_settlement_lane_for_finish(uuid);

COMMIT;
