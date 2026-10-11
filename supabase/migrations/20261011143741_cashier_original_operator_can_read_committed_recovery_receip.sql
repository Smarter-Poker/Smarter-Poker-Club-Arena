-- Phase 2: an operator who lost access must still be able to check their own
-- interrupted operations. This read-only door returns only requested, committed
-- receipts owned by auth.uid() in the supplied club, never another operator's
-- ledger or authority to create a movement. Missing means unknown, not failed.
-- @live-proof: EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_cashier_recovery_receipts(uuid,uuid[],text[])') AND md5(prosrc)='7a0ae3eb5fa6746cf8846c5bd6e17533' AND prosecdef AND pg_get_userbyid(proowner)='postgres' AND proconfig @> ARRAY['search_path=public, pg_temp'] AND NOT has_function_privilege('anon',oid,'EXECUTE') AND has_function_privilege('authenticated',oid,'EXECUTE'))
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.fn_cashier_recovery_receipts(
  p_club_id uuid, p_operation_ids uuid[] DEFAULT '{}'::uuid[],
  p_ticket_keys text[] DEFAULT '{}'::text[]
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_operations jsonb;
  v_tickets jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not Authenticated' USING ERRCODE='42501'; END IF;
  IF p_club_id IS NULL OR p_operation_ids IS NULL OR p_ticket_keys IS NULL
     OR cardinality(p_operation_ids) + cardinality(p_ticket_keys) > 25
     OR EXISTS (SELECT 1 FROM unnest(p_ticket_keys) k WHERE k IS NULL OR length(k)>300) THEN
    RAISE EXCEPTION 'Choose At Most 25 Original Requests' USING ERRCODE='22023';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'operation_id', i.operation_id, 'receipt', i.receipt,
    'intent', i.operation_intent)), '[]'::jsonb)
    INTO v_operations FROM public.cashier_rpc_operation_intents i
   WHERE i.operation_id=ANY(p_operation_ids) AND i.actor_user_id=v_actor
     AND i.club_id=p_club_id AND i.receipt IS NOT NULL;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'ticket_key', t.metadata->>'idempotency_key',
    'receipt', jsonb_build_object('success',true,'replayed',true,
      'ticket_id',t.metadata->>'ticket_id','transaction_id',t.id))), '[]'::jsonb)
    INTO v_tickets FROM public.chip_transactions t
   WHERE t.club_id=p_club_id AND t.from_user_id=v_actor
     AND t.metadata ? 'idempotency_key'
     AND (t.transaction_type='tournament_ticket_issue'
          OR (t.transaction_type='peer_transfer' AND t.notes ILIKE 'Tournament ticket issued%'))
     AND t.metadata->>'ticket_id' IS NOT NULL
     AND t.metadata->>'idempotency_key'=ANY(p_ticket_keys);
  RETURN jsonb_build_object('operations',v_operations,'tickets',v_tickets);
END
$function$;
ALTER FUNCTION public.fn_cashier_recovery_receipts(uuid,uuid[],text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_cashier_recovery_receipts(uuid,uuid[],text[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_cashier_recovery_receipts(uuid,uuid[],text[]) TO authenticated,service_role;
COMMIT;
