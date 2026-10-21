CREATE OR REPLACE FUNCTION public.fn_cashier_operation_intent_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_operation uuid;
  v_owner uuid;
  v_action text;
  v_expected_type text;
BEGIN
  IF NEW.metadata ->> 'op_id' IS NULL THEN RETURN NEW; END IF;
  BEGIN
    v_operation := (NEW.metadata ->> 'op_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW;
  END;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'cashier-exact-intent:' || v_operation, 0));
  SELECT actor_user_id, action INTO v_owner, v_action
    FROM public.cashier_rpc_operation_intents
   WHERE operation_id = v_operation;
  IF NOT FOUND THEN RETURN NEW; END IF;

  v_expected_type := CASE v_action
    WHEN 'club_bank_send' THEN 'club_bank_send'
    WHEN 'club_bank_claim' THEN 'club_bank_claim'
    WHEN 'club_bank_reversal' THEN 'club_bank_reversal'
    WHEN 'admin_removal' THEN 'admin_removal'
    WHEN 'promo_wallet_send' THEN 'promo_wallet_send'
    WHEN 'club_promo_send' THEN 'club_promo_send'
    WHEN 'agent_wallet_send' THEN 'agent_wallet_send'
    WHEN 'cashier_player_send' THEN 'peer_transfer'
    WHEN 'agent_wallet_claim_back' THEN 'agent_wallet_claim_back'
  END;
  IF v_owner IS DISTINCT FROM auth.uid()
     OR v_expected_type IS NULL
     OR NEW.transaction_type IS DISTINCT FROM v_expected_type THEN
    RAISE EXCEPTION 'cashier_retry_key_reused_across_actions' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$function$;

