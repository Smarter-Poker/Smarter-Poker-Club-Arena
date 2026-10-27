CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury(p_table_id uuid, p_user_id uuid, p_seat_number integer, p_amount numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_request jsonb;
  v_response jsonb;
  v_ledger uuid;
  v_gift jsonb;
BEGIN
  p_op_id:=COALESCE(p_op_id,gen_random_uuid());
  PERFORM pg_advisory_xact_lock_shared(530090, 1);

  v_request := jsonb_build_object(
    'door', 'fn_horse_seat_from_treasury',
    'table_id', p_table_id,
    'user_id', p_user_id,
    'seat_number', p_seat_number,
    'amount', p_amount
  );
  v_response := public.fn_claim_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request
  );
  IF NOT COALESCE((v_response->>'claimed')::boolean, false) THEN
    RETURN v_response->'response';
  END IF;

  IF p_op_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.chip_ledger l
     WHERE l.idempotency_key = 'horse_fund:' || p_op_id::text
  ) THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_RECEIPT_UNBOUND: this historical horse key has no exact response receipt'
      USING ERRCODE = '55000';
  END IF;

  IF public.fn_entry_purchases_frozen() THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN jsonb_build_object(
      'success', false,
      'deferred', true,
      'error', 'PLATFORM_FROZEN: scheduled maintenance has deferred this horse seat'
    );
  END IF;
  PERFORM public.fn_assert_cash_chip_purchase_table(p_table_id);
  v_response := public.fn_horse_seat_from_treasury_before_maintenance_gate(
    p_table_id, p_user_id, p_seat_number, p_amount, p_op_id
  );
  IF NOT COALESCE((v_response->>'success')::boolean, false) THEN
    PERFORM public.fn_release_entry_purchase_claim(
      'horse_funding', p_op_id::text, v_request
    );
    RETURN v_response;
  END IF;
  v_response:=public.fn_record_entry_purchase_receipt(
    'horse_funding', p_op_id::text, v_request, v_response
  );
  SELECT id INTO STRICT v_ledger FROM public.chip_ledger WHERE idempotency_key='horse_fund:'||p_op_id::text;
  v_gift:=smarter_private.admit_original_treasury_gift(v_ledger);
  PERFORM public.fn_cash_record_original_funding('horse_funding',p_op_id::text,p_user_id,p_table_id,v_ledger,NULL,
    (v_gift->>'earning_club')::uuid,p_amount,(v_gift->>'bank_balance_after')::numeric,NULL);
  RETURN v_response;
END;
$function$
