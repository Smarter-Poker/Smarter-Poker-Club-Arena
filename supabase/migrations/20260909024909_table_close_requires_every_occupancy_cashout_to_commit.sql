-- Phase 2: a table close is never a second payment authority.
-- The engine must finish each original occupancy at its hand boundary first.
-- Closing an occupied cash table fails without touching wallets or seats.
-- A later native parent/seat FK migration serializes admission against closure.
-- No production DDL probe. This migration remains unpublished during build-out.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $guard$ BEGIN
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_cashout_seats_for_closing_table(uuid,text)'::regprocedure) NOT IN ('3f30b06dfcc5f4550226d77ba47ecfbd','f97d546f6006979fa2dd55a3c7ed6bfc','2904d38e22d59c753795957b9f57ad0f') THEN RAISE EXCEPTION 'Unreviewed closing baseline: fn_cashout_seats_for_closing_table(uuid,text)'; END IF;
IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trg_auto_cashout_on_table_close()'::regprocedure) NOT IN ('26cb41be80efa0f3afc0922668c5a9aa','901315907d4e3cfb4f88eea60756f01f','a40072307dfb148fd38dfd8e40d37b78') THEN RAISE EXCEPTION 'Unreviewed closing baseline: trg_auto_cashout_on_table_close()'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_cashout_seats_for_closing_table(
 p_table_id uuid,p_reason text DEFAULT 'table closed'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp
AS $function$
DECLARE
  v_tournament uuid;
BEGIN
  SELECT tournament_id INTO v_tournament FROM public.tables WHERE id=p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_TABLE_NOT_FOUND' USING ERRCODE='22023';
  END IF;
  IF v_tournament IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'skipped','tournament_table');
  END IF;
  -- This read-only assertion is also reached from authorized administrator
  -- close RPCs. It must not require an engine JWT when it moves no money.
  IF EXISTS (SELECT 1 FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL) THEN
    RAISE EXCEPTION 'CASH_TABLE_CLOSE_REQUIRES_ENGINE_DEPARTURES' USING ERRCODE='55000';
  END IF;
  RETURN jsonb_build_object('ok',true,'players_paid',0,
    'chips_returned',0,'reason_text',coalesce(p_reason,'table closed'));
END;
$function$;
CREATE OR REPLACE FUNCTION public.trg_auto_cashout_on_table_close()
RETURNS trigger LANGUAGE plpgsql SET search_path TO public,pg_temp
AS $function$
BEGIN
  IF NEW.tournament_id IS NOT NULL THEN RETURN NEW; END IF;
  -- An occupied table cannot close. The engine owns its departures.
  -- Do not convert this refusal into a warning and commit a closed table.
  PERFORM public.fn_cashout_seats_for_closing_table(NEW.id,'table '||NEW.status);
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_cashout_seats_for_closing_table(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cashout_seats_for_closing_table(uuid,text) TO service_role;
COMMIT;
