-- Reserved by scripts/new-migration.mjs. Read-only recovery for the original
-- cash add-on command. The numeric atomic_table_addon result alone does not
-- distinguish a replay; adding its requested delta to the engine twice creates
-- an unfunded in-memory stack. This door exposes the existing immutable receipt
-- and current seat/pending truth only to the engine service identity.
-- Install before the engine containing cashAddonReceipt.ts. No money moves,
-- receipt is rewritten, or existing funding signature changes in this migration.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

CREATE FUNCTION public.fn_cash_addon_receipt(
  p_table_id uuid, p_user_id uuid, p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '5s'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
  v_stack numeric;
  v_pending numeric;
  v_amount numeric;
  v_queued boolean := false;
BEGIN
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'An add-on recovery requires its original operation key';
  END IF;
  SELECT r.request, r.response INTO v_request, v_response
    FROM public.entry_purchase_idempotency_receipts r
   WHERE r.key_domain = 'cash_addon' AND r.idempotency_key = p_idempotency_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_request->>'user_id' IS DISTINCT FROM p_user_id::text
     OR v_request->>'table_id' IS DISTINCT FROM p_table_id::text
     OR v_request->>'door' IS DISTINCT FROM 'atomic_table_addon'
     OR v_response IS NULL THEN
    RAISE EXCEPTION 'The add-on receipt does not prove this operation';
  END IF;
  SELECT s.stack INTO STRICT v_stack FROM public.table_seats s
   WHERE s.table_id = p_table_id AND s.user_id = p_user_id AND s.left_at IS NULL;
  SELECT COALESCE(sum(a.amount), 0) INTO v_pending FROM public.table_pending_addons a
   WHERE a.table_id = p_table_id AND a.user_id = p_user_id AND a.resolved_at IS NULL;
  v_amount := (v_request->>'amount')::numeric;
  IF (v_request->>'apply_to_seat')::boolean IS FALSE THEN
    SELECT a.resolved_at IS NULL,
           CASE WHEN a.resolved_at IS NULL THEN v_amount ELSE a.applied_to_stack END
      INTO STRICT v_queued, v_amount
      FROM public.cash_participant_funding_receipts f
      JOIN public.table_pending_addons a ON a.id=f.pending_addon_id
     WHERE f.operation_kind='addon' AND f.operation_key=p_idempotency_key
       AND f.table_id=p_table_id AND f.user_id=p_user_id;
  END IF;
  RETURN jsonb_build_object('table_id', p_table_id, 'user_id', p_user_id,
    'amount', v_amount, 'applied_to_seat', v_request->'apply_to_seat',
    'stack', v_stack, 'pending', v_pending, 'queued', v_queued);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_cash_addon_receipt(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_addon_receipt(uuid,uuid,text) TO service_role;
CREATE FUNCTION public.fn_diamond_top_up_receipt(
  p_table_id uuid, p_user_id uuid, p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '5s'
AS $function$
DECLARE v_request jsonb; v_receipt jsonb; v_stack numeric;
BEGIN
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'A Diamond recovery requires its original request'; END IF;
  SELECT m.request, m.receipt INTO v_request, v_receipt
    FROM public.poker_diamond_movements m WHERE m.request_id = p_request_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_request->>'user_id' IS DISTINCT FROM p_user_id::text
     OR v_request->>'table_id' IS DISTINCT FROM p_table_id::text
     OR v_request->>'action' IS DISTINCT FROM 'top_up'
     OR v_receipt IS NULL THEN
    RAISE EXCEPTION 'The Diamond receipt does not prove this operation';
  END IF;
  SELECT s.stack INTO STRICT v_stack FROM public.table_seats s
   WHERE s.table_id=p_table_id AND s.user_id=p_user_id AND s.left_at IS NULL;
  RETURN jsonb_build_object('table_id',p_table_id,'user_id',p_user_id,
    'amount',v_request->'amount','applied_to_seat',true,'stack',v_stack,'pending',0,'queued',false);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_diamond_top_up_receipt(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_top_up_receipt(uuid,uuid,uuid) TO service_role;
COMMIT;
