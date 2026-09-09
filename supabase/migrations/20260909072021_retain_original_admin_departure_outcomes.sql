-- Completed administrative outcomes outlive table/profile deletion.
-- Read-only replay requires the authenticated original actor and exact scope.
-- New departures still require current HTTP authorization and engine ownership.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL search_path TO public,pg_temp;
DO $guard$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=
 'public.fn_cashout_seat_occupancy(uuid,uuid,integer,uuid,text)'::regprocedure)
 NOT IN ('91496bd250312f4aa611d957d9628e14','b22cb8e338a816e8459700cb5e1d23bd') THEN
  RAISE EXCEPTION 'Unreviewed occupancy cashout baseline';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.fn_cashout_seat_occupancy(
  p_user_id uuid, p_table_id uuid, p_seat_number integer,
  p_occupancy_id uuid, p_leave_mode text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_tournament uuid;
  v_seat record;
  v_previous public.seat_cashout_receipts%ROWTYPE;
  v_result jsonb;
  v_effective_mode text;
  v_previous_authority text;
BEGIN
  IF p_user_id IS NULL OR p_table_id IS NULL OR p_seat_number IS NULL
     OR p_occupancy_id IS NULL THEN
    RAISE EXCEPTION 'CASHOUT_OCCUPANCY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  -- The engine owns the live-hand boundary. Knowing an occupancy UUID or
  -- owning the seat cannot authorize a direct browser cashout mid-hand.
  IF NOT coalesce(public.fn_caller_is_engine(),false) THEN
    RAISE EXCEPTION 'Engine authority required' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || p_user_id::text,0));
  SELECT * INTO v_previous FROM public.seat_cashout_receipts
   WHERE occupancy_id = p_occupancy_id;
  IF FOUND THEN
    IF v_previous.user_id <> p_user_id OR v_previous.table_id <> p_table_id
       OR v_previous.seat_number <> p_seat_number THEN
      RAISE EXCEPTION 'CASHOUT_OCCUPANCY_SCOPE_MISMATCH' USING ERRCODE = '22023';
    END IF;
    RETURN v_previous.receipt;
  END IF;

  SELECT tournament_id INTO v_tournament FROM public.tables WHERE id=p_table_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_TABLE_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_tournament IS NOT NULL THEN
    PERFORM 1 FROM public.tournaments WHERE id=v_tournament FOR NO KEY UPDATE;
  END IF;
  SELECT id,seat_number,occupancy_id INTO v_seat FROM public.table_seats
   WHERE occupancy_id=p_occupancy_id AND table_id=p_table_id AND user_id=p_user_id
     AND seat_number=p_seat_number AND left_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHOUT_STALE_OCCUPANCY' USING ERRCODE = '22023';
  END IF;

  -- This lock and the canonical function's locks are in the same transaction.
  -- A concurrent seat replacement cannot cross the identity check.
  v_effective_mode := p_leave_mode;
  -- A forced request survives restart and cannot leak onto a later occupancy.
  IF p_leave_mode IS DISTINCT FROM 'vpip_evicted' AND EXISTS (SELECT 1 FROM public.seat_departure_requests
    WHERE occupancy_id=p_occupancy_id AND user_id=p_user_id AND table_id=p_table_id
      AND seat_number=p_seat_number AND leave_mode='forced') THEN
    v_effective_mode := 'forced';
  END IF;
  -- Classification is derived from retained, occupancy-bound authority.
  -- Never inherit another operation's transaction-local admin marker.
  v_previous_authority := current_setting('app.cash_exit_authority',true);
  PERFORM set_config('app.cash_exit_authority',
    CASE WHEN v_effective_mode='forced' AND EXISTS(
      SELECT 1 FROM public.seat_admin_departure_authorizations
       WHERE occupancy_id=p_occupancy_id AND user_id=p_user_id
         AND table_id=p_table_id AND seat_number=p_seat_number)
    THEN 'club_admin' ELSE '' END,true);
  v_result := public.atomic_seat_cashout_locked(
    p_user_id,p_table_id,p_seat_number,v_effective_mode);
  PERFORM set_config('app.cash_exit_authority',coalesce(v_previous_authority,''),true);
  IF v_result->>'ok' IS DISTINCT FROM 'true'
     OR v_result->>'reason' IS NOT NULL
     OR (v_result->>'seat_number')::integer IS DISTINCT FROM p_seat_number
     OR v_result->>'idempotency_key' IS DISTINCT FROM 'cashout:occupancy:'||p_occupancy_id::text THEN
    RAISE EXCEPTION 'CASHOUT_UNCONFIRMED_OUTCOME' USING ERRCODE = '22023';
  END IF;
  -- The canonical transaction writes this receipt for every ingress.
  -- The wrapper owns request identity and replay, never a second receipt write.
  RETURN v_result;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_get_admin_seat_cashout_receipt(
 p_actor_id uuid,p_user_id uuid,p_table_id uuid,p_seat_number integer,p_occupancy_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,pg_temp SET statement_timeout TO '5s'
AS $function$
BEGIN
 IF NOT coalesce(public.fn_caller_is_engine(),false) THEN
  RAISE EXCEPTION 'Engine authority required' USING ERRCODE='42501';
 END IF;
 IF p_actor_id IS NULL OR p_user_id IS NULL OR p_table_id IS NULL
   OR p_seat_number IS NULL OR p_occupancy_id IS NULL THEN
  RAISE EXCEPTION 'ADMIN_CASHOUT_SCOPE_REQUIRED' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM public.seat_admin_departure_authorizations
   WHERE occupancy_id=p_occupancy_id AND actor_id=p_actor_id
     AND user_id=p_user_id AND table_id=p_table_id AND seat_number=p_seat_number) THEN
  RETURN NULL;
 END IF;
 RETURN public.fn_get_seat_cashout_receipt(
   p_user_id,p_table_id,p_seat_number,p_occupancy_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_get_admin_seat_cashout_receipt(uuid,uuid,uuid,integer,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_get_admin_seat_cashout_receipt(uuid,uuid,uuid,integer,uuid)
 TO service_role;
COMMIT;
