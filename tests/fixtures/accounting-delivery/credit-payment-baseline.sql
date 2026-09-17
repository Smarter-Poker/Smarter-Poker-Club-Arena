CREATE OR REPLACE FUNCTION public.fn_apply_credit_payment(p_invoice_id uuid, p_amount numeric, p_method text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_inv public.credit_invoices;
  v_new_paid numeric;
  v_new_remaining numeric;
  v_status text;
  v_paid_at timestamptz;
  v_pay public.credit_payments;
  v_applied numeric;
  v_used_after numeric;
BEGIN
  IF p_invoice_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invoice and positive amount required');
  END IF;
  IF p_method NOT IN ('wallet','diamonds','external') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid payment method');
  END IF;

  SELECT * INTO v_inv FROM public.credit_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF v_inv.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'invoice not found');
  END IF;

  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> v_inv.agent_id
     AND NOT public.is_admin()
     AND NOT EXISTS (
       SELECT 1 FROM public.club_members me
        WHERE me.user_id = auth.uid()
          AND me.role IN ('owner','co_owner','admin','manager')
          AND me.club_id IN (SELECT club_id FROM public.club_members
                              WHERE user_id = v_inv.agent_id)))) THEN
    RAISE EXCEPTION 'Not authorised to apply a payment to this invoice';
  END IF;

  IF v_inv.status = 'void' THEN
    RETURN jsonb_build_object('success', false, 'error', 'that invoice was voided and is not payable',
      'void_reason', v_inv.void_reason);
  END IF;
  IF v_inv.status = 'paid' THEN
    RETURN jsonb_build_object('success', false, 'error', 'that invoice is already settled');
  END IF;

  v_applied := LEAST(p_amount, GREATEST(v_inv.debt_owed - v_inv.amount_paid, 0));
  IF v_applied <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'that invoice has nothing left to pay');
  END IF;

  v_new_paid      := v_inv.amount_paid + v_applied;
  v_new_remaining := GREATEST(v_inv.debt_owed - v_new_paid, 0);
  IF v_new_remaining <= 0 THEN
    v_status  := 'paid';
    v_paid_at := NOW();
  ELSE
    v_status  := 'partial';
    v_paid_at := v_inv.paid_at;
  END IF;

  UPDATE public.credit_invoices
  SET amount_paid = v_new_paid,
      amount_remaining = v_new_remaining,
      status = v_status,
      paid_at = v_paid_at
  WHERE id = p_invoice_id;

  -- THE DEBT ITSELF. Without this the invoice went to 'paid' and
  -- agents.credit_used never moved, so the agent paid and still owed.
  UPDATE public.agents
     SET credit_used = GREATEST(COALESCE(credit_used, 0) - v_applied, 0),
         updated_at = now()
   WHERE id = v_inv.agent_id
  RETURNING credit_used INTO v_used_after;

  INSERT INTO public.credit_payments (invoice_id, amount, payment_method)
  VALUES (p_invoice_id, v_applied, p_method)
  RETURNING * INTO v_pay;

  RETURN jsonb_build_object(
    'success', true, 'invoice_id', p_invoice_id, 'status', v_status,
    'applied', v_applied, 'amount_remaining', v_new_remaining,
    'credit_used_after', v_used_after, 'payment', to_jsonb(v_pay));
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_pay_credit_invoice_from_wallet(p_invoice_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_agent    uuid;
  v_agent_u  uuid;
  v_status   text;
  v_amount   numeric;
  v_apply    jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_pay_credit_invoice_from_wallet requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  v_amount := trunc(COALESCE(p_amount, 0) * 100) / 100;
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'non_positive_amount');
  END IF;

  SELECT agent_id, status INTO v_agent, v_status
    FROM public.credit_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invoice_not_found');
  END IF;

  IF v_status = 'void' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invoice_voided');
  END IF;
  IF v_status = 'paid' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_settled');
  END IF;

  SELECT user_id INTO v_agent_u FROM public.agents WHERE id = v_agent;
  IF v_agent_u IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'agent_user_not_found');
  END IF;
  IF v_agent_u <> v_uid THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_your_wallet');
  END IF;

  IF NOT public.atomic_deduct_wallet_and_log(
       v_agent_u, v_amount, 'settlement',
       'Credit invoice payment: ' || p_invoice_id::text,
       NULL, NULL, p_invoice_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
  END IF;

  v_apply := public.fn_apply_credit_payment(p_invoice_id, v_amount, 'wallet');

  IF v_apply IS NULL OR COALESCE((v_apply->>'success')::boolean, false) = false THEN
    RAISE EXCEPTION 'fn_pay_credit_invoice_from_wallet: apply failed for %: %',
      p_invoice_id, COALESCE(v_apply->>'error', 'unknown')
      USING ERRCODE = '25000';
  END IF;

  RETURN jsonb_build_object('ok', true, 'amount', v_amount, 'payment', v_apply->'payment');
END;
$function$;
