CREATE OR REPLACE FUNCTION public.fn_agent_wallet_send_core_20261004(p_club_id uuid, p_to_user_id uuid, p_amount numeric, p_destination text DEFAULT 'player_wallet'::text, p_reason text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  -- Serialize the existing agreement before any operation/hierarchy/row lock.
  -- Nested callers reacquire the same transaction lock; no new money path.
  IF p_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||p_club_id::text,0));
  END IF;

  if auth.uid() is null then
    return jsonb_build_object('success',false,'error','Not Authenticated');
  end if;
  if p_op_id is null then
    return jsonb_build_object('success',false,'error','A Retry Key Is Required For Every Send');
  end if;
  return public.fn_agent_wallet_send_phase2_core_20260831(
    p_club_id,p_to_user_id,p_amount,p_destination,p_reason,p_op_id
  );
end
$function$
