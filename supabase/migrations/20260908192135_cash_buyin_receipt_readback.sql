-- Read-only recovery of a possibly committed cash buy-in. Absence is unknown.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_cash_buyin_receipt(
  p_idempotency_key uuid,
  p_table_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, auth
SET statement_timeout = '5s'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_request jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Sign in to check your buy-in' USING ERRCODE = '42501';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: sign in again to check your buy-in'
      USING ERRCODE = '28000';
  END IF;

  SELECT r.request INTO v_request
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = 'cash_transaction'
     AND r.idempotency_key = p_idempotency_key::text
     AND r.request->>'door' = 'atomic_table_buyin'
     AND r.request->>'user_id' = v_user_id::text
     AND r.request->>'table_id' = p_table_id::text
     AND r.response = jsonb_build_object('completed', true)
     AND r.completed_at IS NOT NULL;

  -- An in-flight transaction is invisible here. Never call absence a refusal,
  -- and never infer the purchase from a current seat or current wallet balance.
  IF NOT FOUND THEN RETURN jsonb_build_object('status', 'unconfirmed'); END IF;
  RETURN jsonb_build_object('status', 'confirmed', 'request', jsonb_build_object(
    'door', 'atomic_table_buyin', 'user_id', v_user_id, 'table_id', p_table_id,
    'seat_number', v_request->'seat_number', 'amount', v_request->'amount',
    'auto_rebuy', v_request->'auto_rebuy', 'club_id', v_request->'club_id'
  ));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_cash_buyin_receipt(uuid,uuid)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_cash_buyin_receipt(uuid,uuid) TO authenticated;

COMMIT;
