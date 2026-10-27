CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury_before_maintenance_gate(p_table_id uuid,p_user_id uuid,p_seat_number integer,p_amount numeric,p_op_id uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions AS $function$
DECLARE request jsonb;receipt public.entry_purchase_idempotency_receipts%ROWTYPE;
 response jsonb;claim jsonb;expected_claim jsonb;ledger_id uuid;gift jsonb;internal_key boolean:=p_op_id IS NULL;
BEGIN
 -- Existing supported entry gate, also for a direct privileged leaf call.
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 p_op_id:=COALESCE(p_op_id,gen_random_uuid());
 request:=jsonb_build_object('door','fn_horse_seat_from_treasury','table_id',p_table_id,
  'user_id',p_user_id,'seat_number',p_seat_number,'amount',p_amount);
 IF internal_key THEN
  claim:=public.fn_claim_entry_purchase_receipt('horse_funding',p_op_id::text,request);
  IF NOT COALESCE((claim->>'claimed')::boolean,false) THEN RETURN claim->'response';END IF;
 END IF;
 SELECT * INTO receipt FROM public.entry_purchase_idempotency_receipts
  WHERE key_domain='horse_funding' AND idempotency_key=p_op_id::text FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'original_treasury_entry_claim_missing' USING ERRCODE='55000';END IF;
 IF receipt.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'original_treasury_entry_request_disagrees' USING ERRCODE='22023';END IF;
 IF receipt.response IS NOT NULL THEN RETURN receipt.response;END IF;
 expected_claim:=jsonb_build_object('domain','horse_funding','key',p_op_id::text,
  'request_md5',md5(request::text),'transaction_id',pg_current_xact_id()::text);
 claim:=NULLIF(current_setting('app.original_treasury_entry_claim',true),'')::jsonb;
 IF claim IS DISTINCT FROM expected_claim THEN RAISE EXCEPTION 'original_treasury_entry_claim_not_owned' USING ERRCODE='55000';END IF;
 response:=smarter_private.original_treasury_seat_money_core(p_table_id,p_user_id,p_seat_number,p_amount,p_op_id);
 IF NOT COALESCE((response->>'success')::boolean,false) THEN
  PERFORM public.fn_release_entry_purchase_claim('horse_funding',p_op_id::text,request);
  PERFORM set_config('app.original_treasury_entry_claim','',true);
  RETURN response;
 END IF;
 response:=public.fn_record_entry_purchase_receipt('horse_funding',p_op_id::text,request,response);
 SELECT id INTO STRICT ledger_id FROM public.chip_ledger WHERE idempotency_key='horse_fund:'||p_op_id::text;
 gift:=smarter_private.admit_original_treasury_gift(ledger_id);
 PERFORM public.fn_cash_record_original_funding('horse_funding',p_op_id::text,p_user_id,p_table_id,ledger_id,NULL,
  (gift->>'earning_club')::uuid,p_amount,(gift->>'bank_balance_after')::numeric,NULL);
 PERFORM set_config('app.original_treasury_entry_claim','',true);
 RETURN response;
END$function$;
