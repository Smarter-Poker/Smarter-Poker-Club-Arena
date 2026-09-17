BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('fn_apply_credit_payment(uuid,numeric,text)'::regprocedure))<>'0f5fc9b1264dd3c20b353677fe210abc'
 OR md5(pg_get_functiondef('fn_pay_credit_invoice_from_wallet(uuid,numeric)'::regprocedure))<>'f05bbf2e58863cbc9686d921550637dd'
 THEN RAISE EXCEPTION 'credit payment sources changed since review'; END IF;
END $guard$;
ALTER TABLE public.credit_payments ADD COLUMN operation_id uuid UNIQUE,
 ADD COLUMN payer_user_id uuid,
 ADD COLUMN payment_reference text;
CREATE UNIQUE INDEX credit_payments_external_reference ON public.credit_payments(invoice_id,payment_reference)
 WHERE payment_method='external' AND payment_reference IS NOT NULL;

INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('fn_process_credit_invoice_payment','approved','Single credit invoice payment writer. Authenticated debtor spends only its invoice club player wallet through atomic_deduct_wallet_and_log with explicit ledger club context; receiving club administrators or engine record external payments only with a reference. Locks agent then invoice, requires finite exact cents and consistent outstanding debt, refuses overpayment, and deduplicates operation/reference before debit. Updates credit_used and invoice together. Existing wallet writer journals the debit; credit_payments creates the source-linked invoice and mandatory Messenger/notification receipts in the same transaction. No diamond conversion or arbitrary payer selection.');

CREATE FUNCTION public.fn_process_credit_invoice_payment(p_invoice_id uuid,p_amount numeric,p_method text,p_operation_id uuid,p_reference text DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE inv public.credit_invoices%ROWTYPE; agent public.agents%ROWTYPE; pay public.credit_payments%ROWTYPE;
 actor uuid:=auth.uid(); engine boolean:=public.fn_caller_is_engine(); remaining numeric; old_club text; deducted boolean; new_status text;
BEGIN
 IF p_invoice_id IS NULL OR p_operation_id IS NULL OR p_amount IS NULL OR p_amount<=0
    OR p_amount::text IN('NaN','Infinity','-Infinity') OR p_amount<>round(p_amount,2)
 THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','invalid_payment'); END IF;
 IF p_method IS NULL OR p_method NOT IN('wallet','external') THEN
   RETURN jsonb_build_object('ok',false,'success',false,'reason','unsupported_payment_method'); END IF;
 SELECT * INTO inv FROM public.credit_invoices WHERE id=p_invoice_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','invoice_not_found'); END IF;
 SELECT * INTO agent FROM public.agents WHERE id=inv.agent_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','agent_user_not_found'); END IF;
 IF p_method='wallet' THEN
   -- A service credential is not authority to spend an arbitrary user's wallet.
   IF actor IS NULL OR actor<>agent.user_id THEN
    RAISE EXCEPTION 'not_your_wallet' USING ERRCODE='42501'; END IF;
 ELSE
   IF NOT engine AND (actor IS NULL OR NOT (public.fn_is_club_admin_uid(agent.club_id) OR public.fn_is_platform_admin())) THEN
    RAISE EXCEPTION 'only_receiving_club_can_record_external_payment' USING ERRCODE='42501'; END IF;
   IF NULLIF(btrim(p_reference),'') IS NULL OR length(p_reference)>256 THEN
    RETURN jsonb_build_object('ok',false,'success',false,'reason','payment_reference_required'); END IF;
 END IF;
 -- Use the same agent -> invoice lock order as invoice generation.
 SELECT * INTO agent FROM public.agents WHERE id=inv.agent_id FOR UPDATE;
 SELECT * INTO inv FROM public.credit_invoices WHERE id=p_invoice_id FOR UPDATE;
 IF inv.agent_id IS DISTINCT FROM agent.id OR agent.club_id IS NULL
   OR (p_method='wallet' AND actor IS DISTINCT FROM agent.user_id)
   OR (p_method='external' AND NOT engine AND NOT (public.fn_is_club_admin_uid(agent.club_id) OR public.fn_is_platform_admin()))
 THEN RAISE EXCEPTION 'credit_account_changed' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('credit_payment:'||p_operation_id::text,0));
 SELECT * INTO pay FROM public.credit_payments WHERE operation_id=p_operation_id;
 IF NOT FOUND AND p_method='external' THEN
   SELECT * INTO pay FROM public.credit_payments WHERE invoice_id=p_invoice_id AND payment_method='external' AND payment_reference=btrim(p_reference);
 END IF;
 IF pay.id IS NOT NULL THEN
   IF pay.invoice_id<>p_invoice_id OR pay.amount<>p_amount OR pay.payment_method<>p_method
      OR pay.payer_user_id IS DISTINCT FROM actor OR pay.payment_reference IS DISTINCT FROM NULLIF(btrim(p_reference),'')
   THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','operation_conflict'); END IF;
   RETURN jsonb_build_object('ok',true,'success',true,'duplicate',true,'amount',pay.amount,'applied',pay.amount,
     'invoice_id',inv.id,'status',inv.status,'amount_remaining',inv.amount_remaining,'payment',to_jsonb(pay));
 END IF;
 IF inv.status NOT IN('pending','partial','overdue') THEN
   RETURN jsonb_build_object('ok',false,'success',false,'reason',CASE inv.status WHEN 'void' THEN 'invoice_voided' WHEN 'paid' THEN 'already_settled' ELSE 'invoice_not_payable' END);
 END IF;
 IF inv.debt_owed IS NULL OR inv.amount_paid IS NULL OR inv.amount_remaining IS NULL OR agent.credit_used IS NULL
   OR inv.debt_owed::text IN('NaN','Infinity','-Infinity') OR inv.amount_paid::text IN('NaN','Infinity','-Infinity')
   OR inv.amount_remaining::text IN('NaN','Infinity','-Infinity') OR agent.credit_used::text IN('NaN','Infinity','-Infinity')
   OR inv.debt_owed<>round(inv.debt_owed,2) OR inv.amount_paid<>round(inv.amount_paid,2)
   OR agent.credit_used<>round(agent.credit_used,2) OR inv.amount_paid<0 OR agent.credit_used<0
   OR inv.amount_remaining<>inv.debt_owed-inv.amount_paid
 THEN RAISE EXCEPTION 'credit_balance_evidence_invalid' USING ERRCODE='23514'; END IF;
 remaining:=inv.amount_remaining;
 IF p_amount>remaining THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','amount_exceeds_remaining','amount_remaining',remaining); END IF;
 IF p_amount>agent.credit_used THEN RAISE EXCEPTION 'credit_invoice_exceeds_drawn_debt' USING ERRCODE='23514'; END IF;
 IF p_method='wallet' THEN
   old_club:=current_setting('app.ledger_club_id',true);
   PERFORM set_config('app.ledger_club_id',agent.club_id::text,true);
   deducted:=public.atomic_deduct_wallet_and_log(agent.user_id,p_amount,'settlement','Credit Invoice Payment: '||p_invoice_id::text,NULL,NULL,p_invoice_id);
   PERFORM set_config('app.ledger_club_id',COALESCE(old_club,''),true);
   IF deducted IS DISTINCT FROM true THEN RETURN jsonb_build_object('ok',false,'success',false,'reason','insufficient_balance'); END IF;
 END IF;
 remaining:=remaining-p_amount;
 new_status:=CASE WHEN remaining=0 THEN 'paid' ELSE 'partial' END;
 UPDATE public.credit_invoices SET amount_paid=amount_paid+p_amount,amount_remaining=remaining,status=new_status,
  paid_at=CASE WHEN remaining=0 THEN now() ELSE paid_at END WHERE id=p_invoice_id;
 UPDATE public.agents SET credit_used=credit_used-p_amount,updated_at=now() WHERE id=agent.id;
 INSERT INTO public.credit_payments(invoice_id,amount,payment_method,transaction_id,operation_id,payer_user_id,payment_reference)
  VALUES(p_invoice_id,p_amount,p_method,p_operation_id::text,p_operation_id,actor,NULLIF(btrim(p_reference),'')) RETURNING * INTO pay;
 -- The existing payment trigger creates the invoice and both delivery receipts.
 UPDATE public.settlement_invoices SET status=CASE WHEN remaining=0 THEN 'paid' ELSE 'generated' END,updated_at=now()
  WHERE source_credit_invoice_id=p_invoice_id;
 RETURN jsonb_build_object('ok',true,'success',true,'duplicate',false,'amount',p_amount,'applied',p_amount,
  'invoice_id',p_invoice_id,'status',new_status,'amount_remaining',remaining,'credit_used_after',agent.credit_used-p_amount,'payment',to_jsonb(pay));
END $function$;
REVOKE ALL ON FUNCTION public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_process_credit_invoice_payment(uuid,numeric,text,uuid,text) TO authenticated,service_role;

-- Existing callers delegate to the same writer. Their stable legacy key also makes retries safe.
CREATE OR REPLACE FUNCTION public.fn_pay_credit_invoice_from_wallet(p_invoice_id uuid,p_amount numeric)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 RETURN public.fn_process_credit_invoice_payment(p_invoice_id,p_amount,'wallet',
   md5('legacy-credit-wallet:'||COALESCE(auth.uid()::text,'')||':'||COALESCE(p_invoice_id::text,'')||':'||COALESCE(p_amount::text,''))::uuid,NULL);
END $function$;
CREATE OR REPLACE FUNCTION public.fn_apply_credit_payment(p_invoice_id uuid,p_amount numeric,p_method text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 RETURN public.fn_process_credit_invoice_payment(p_invoice_id,p_amount,p_method,
   md5('legacy-credit-apply:'||COALESCE(auth.uid()::text,'')||':'||COALESCE(p_invoice_id::text,'')||':'||COALESCE(p_amount::text,'')||':'||COALESCE(p_method,''))::uuid,NULL);
END $function$;
REVOKE ALL ON FUNCTION public.fn_pay_credit_invoice_from_wallet(uuid,numeric) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.fn_apply_credit_payment(uuid,numeric,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_pay_credit_invoice_from_wallet(uuid,numeric) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_apply_credit_payment(uuid,numeric,text) TO authenticated,service_role;
COMMIT;
