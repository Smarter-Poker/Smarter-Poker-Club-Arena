CREATE OR REPLACE FUNCTION public.fn_generate_credit_invoice(p_agent_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_debt_owed numeric, p_due_date timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
 v_agent public.agents%ROWTYPE;
 v_row public.credit_invoices%ROWTYPE;
 v_invoiced numeric;
 v_available numeric;
BEGIN
 IF p_agent_id IS NULL THEN RAISE EXCEPTION 'agent_required' USING ERRCODE='22023'; END IF;
 SELECT * INTO v_agent FROM public.agents WHERE id=p_agent_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'agent_not_found' USING ERRCODE='22023'; END IF;
 IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR
   (auth.uid()<>v_agent.user_id AND NOT public.fn_is_platform_admin()
    AND NOT public.fn_is_club_admin_uid(v_agent.club_id))) THEN
   RAISE EXCEPTION 'not_authorised' USING ERRCODE='42501';
 END IF;
 IF p_period_start IS NULL OR p_period_end IS NULL OR p_due_date IS NULL
   OR NOT isfinite(p_period_start) OR NOT isfinite(p_period_end) OR NOT isfinite(p_due_date)
   OR p_period_start>=p_period_end OR p_period_end>now() OR p_due_date<p_period_end
   OR p_debt_owed IS NULL OR p_debt_owed::text IN ('NaN','Infinity','-Infinity')
   OR p_debt_owed<=0 OR p_debt_owed<>round(p_debt_owed,2) THEN
   RAISE EXCEPTION 'invalid_credit_invoice_terms' USING ERRCODE='22023';
 END IF;
 -- An issued document is immutable. Replay returns its original terms.
 SELECT * INTO v_row FROM public.credit_invoices WHERE agent_id=p_agent_id AND period_end=p_period_end;
 IF FOUND THEN RETURN jsonb_build_object('success',true,'duplicate',true,'invoice',to_jsonb(v_row)); END IF;
 IF COALESCE(v_agent.is_prepaid,false) THEN
   RETURN jsonb_build_object('success',false,'error','prepaid_agent');
 END IF;
 IF v_agent.credit_used IS NULL OR v_agent.credit_used::text IN ('NaN','Infinity','-Infinity')
   OR v_agent.credit_used<0 OR v_agent.credit_used<>round(v_agent.credit_used,2) THEN
   RAISE EXCEPTION 'invalid_drawn_credit' USING ERRCODE='23514';
 END IF;
 SELECT COALESCE(sum(amount_remaining),0) INTO v_invoiced FROM public.credit_invoices
   WHERE agent_id=p_agent_id AND status IN ('pending','partial','overdue','disputed');
 v_available:=v_agent.credit_used-v_invoiced;
 IF v_available<p_debt_owed THEN
   RETURN jsonb_build_object('success',false,'error','debt_already_invoiced_or_not_drawn',
     'credit_used',v_agent.credit_used,'already_invoiced',v_invoiced,'available',v_available);
 END IF;
 INSERT INTO public.credit_invoices(agent_id,period_start,period_end,debt_owed,amount_paid,amount_remaining,status,due_date)
 VALUES(p_agent_id,p_period_start,p_period_end,p_debt_owed,0,p_debt_owed,'pending',p_due_date)
 RETURNING * INTO v_row;
 RETURN jsonb_build_object('success',true,'duplicate',false,'invoice',to_jsonb(v_row));
END $function$
;