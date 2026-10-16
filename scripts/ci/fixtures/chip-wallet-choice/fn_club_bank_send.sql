CREATE OR REPLACE FUNCTION public.fn_club_bank_send(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'agent_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_intent jsonb := jsonb_build_object(
    'actor', auth.uid(), 'club', p_club_id, 'action', 'club_bank_send',
    'target', p_to_user_id, 'amount', p_amount,
    'effective_wallet', lower(coalesce(p_destination, 'agent_wallet')),
    'reason', coalesce(nullif(btrim(p_reason), ''), 'Club Bank Send'));
  v_gate jsonb; v_result jsonb;
BEGIN
  IF p_op_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'A Retry Key Is Required'); END IF;
  v_gate := public.fn_cashier_exact_intent_begin('club_bank_send', p_club_id, p_op_id, v_intent);
  IF v_gate ->> 'state' = 'return' THEN RETURN v_gate -> 'response'; END IF;
  v_result := public.fn_club_bank_send_core_20261004(p_club_id, p_to_user_id, p_amount, p_destination, p_reason, p_op_id);
  RETURN public.fn_cashier_exact_intent_finish(p_op_id, v_result);
END
$function$;
