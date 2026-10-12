CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_checkpoint_due()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE origin public.union_pnl_inventory_capture%ROWTYPE; b timestamptz; v_sealed jsonb:='[]'; v_step jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 SELECT * INTO origin FROM public.union_pnl_inventory_capture WHERE singleton;
 IF NOT FOUND THEN RETURN jsonb_build_object('status','blocked','reason','inventory_capture_missing'); END IF;
 b:=public.fn_union_week_start(origin.captured_at);
 LOOP
  b:=public.fn_union_week_start(b+interval '8 days');
  EXIT WHEN b>clock_timestamp();
  IF NOT EXISTS(SELECT 1 FROM public.union_pnl_inventory_checkpoints c WHERE c.boundary=b) THEN
   -- SPLIT SEAL (20261003): inside a chunked close tick, six hours at a time
   -- (fn_union_pnl_inventory_seal_advance); 'sealing' while layers remain.
   IF COALESCE(current_setting('app.weekly_accounting_chunked',true),'')='on' THEN
    v_step:=public.fn_union_pnl_inventory_seal_advance(b,false);
    IF v_step->>'status'='sealing' THEN
     RETURN jsonb_build_object('status','sealing','boundary',b,'progress',v_step,'sealed',v_sealed);
    END IF;
    v_sealed:=v_sealed||jsonb_build_array(v_step);
   ELSE
   v_sealed:=v_sealed||jsonb_build_array(public.fn_union_pnl_inventory_checkpoint_seal(b,false));
   END IF;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('status','ready','sealed',v_sealed);
END $function$
;

