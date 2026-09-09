-- Phase 2: all table-close payouts and seat exits commit together.
-- Requires the occupancy contract migration. No production DDL probe.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$ BEGIN
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_cashout_seats_for_closing_table(uuid,text)'::regprocedure) NOT IN ('3f30b06dfcc5f4550226d77ba47ecfbd','f97d546f6006979fa2dd55a3c7ed6bfc') THEN RAISE EXCEPTION 'Unreviewed closing baseline: fn_cashout_seats_for_closing_table(uuid,text)'; END IF;
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trg_auto_cashout_on_table_close()'::regprocedure) NOT IN ('26cb41be80efa0f3afc0922668c5a9aa','901315907d4e3cfb4f88eea60756f01f') THEN RAISE EXCEPTION 'Unreviewed closing baseline: trg_auto_cashout_on_table_close()'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_cashout_seats_for_closing_table(
 p_table_id uuid,p_reason text DEFAULT 'table closed'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp
AS $function$
DECLARE
  v_tournament uuid;
  v_seat record;
  v_res jsonb;
  v_count integer := 0;
  v_total numeric := 0;
BEGIN
  IF NOT coalesce(public.fn_caller_is_engine(),false) THEN
    RAISE EXCEPTION 'Engine authority required' USING ERRCODE='42501';
  END IF;
  SELECT tournament_id INTO v_tournament FROM public.tables WHERE id=p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_TABLE_NOT_FOUND' USING ERRCODE='22023';
  END IF;
  IF v_tournament IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'skipped','tournament_table');
  END IF;
  -- Capture every active occupancy, including zero and malformed amounts.
  -- The bound transaction validates the amount and owns the wallet/seat locks.
  -- No seat lock or wallet provisioning precedes its per-user advisory lock.
  FOR v_seat IN
    SELECT user_id,seat_number,occupancy_id FROM public.table_seats
     WHERE table_id=p_table_id AND left_at IS NULL
     ORDER BY user_id,seat_number,occupancy_id
  LOOP
    v_res := public.fn_cashout_seat_occupancy(
      v_seat.user_id,p_table_id,v_seat.seat_number,v_seat.occupancy_id,'forced');
    IF v_res->>'ok' IS DISTINCT FROM 'true'
       OR v_res->>'reason' IS NOT NULL
       OR v_res->>'tournament_table' IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'TABLE_CLOSE_CASHOUT_UNCONFIRMED' USING ERRCODE='22023';
    END IF;
    IF (v_res->>'credited')::boolean THEN
      v_count := v_count + 1;
      v_total := v_total + (v_res->>'stack')::numeric;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok',true,'players_paid',v_count,
    'chips_returned',v_total,'reason_text',coalesce(p_reason,'table closed'));
END;
$function$;
CREATE OR REPLACE FUNCTION public.trg_auto_cashout_on_table_close()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public,pg_temp
AS $function$
BEGIN
  IF NEW.tournament_id IS NOT NULL THEN RETURN NEW; END IF;
  -- A failure aborts the status update and every payout in this transaction.
  -- Do not downgrade financial failure to a warning and commit a closed table.
  PERFORM public.fn_cashout_seats_for_closing_table(NEW.id,'table '||NEW.status);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_cashout_seats_for_closing_table(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cashout_seats_for_closing_table(uuid,text) TO service_role;
COMMIT;
