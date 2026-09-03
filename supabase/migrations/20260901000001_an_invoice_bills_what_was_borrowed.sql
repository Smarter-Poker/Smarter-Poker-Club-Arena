-- =============================================================================
-- AN INVOICE BILLS WHAT WAS BORROWED
-- =============================================================================
-- 2026-08-31, phase 1 of 7 of the agent credit and promotion lifecycle work.
--
-- THE BUG. fn_generate_all_credit_invoices computed an agent's debt as
--
--     v_debt := credit_limit - agent_wallet_balance
--
-- That is the UNUSED PORTION OF THE CREDIT LINE. It is the opposite of a debt:
-- the less an agent has borrowed, the larger the bill. An agent who has drawn
-- nothing and holds nothing is invoiced their entire limit, every week, for as
-- long as the job runs.
--
-- Measured on production before writing this file:
--
--     credit invoices raised ............... 224
--     chips billed ......................... 18,047,771
--     agents.credit_used, whole estate ..... 0.00
--     overdue .............................. 184, oldest 2026-07-21
--     payments ever made ................... 0
--
-- One agent with a 500,000 line who has never borrowed a chip has twelve
-- invoices for 500,000 each. Another has thirty at 150,000. Not one of those
-- chips was ever lent.
--
-- Nobody paid, which is the only reason no money moved. It was luck, not
-- safety: fn_pay_credit_invoice_from_wallet deducts real chips from a real
-- wallet and would have settled a debt that did not exist.
--
-- THE SECOND HALF, found while fixing the first: fn_apply_credit_payment marks
-- the invoice paid and NEVER TOUCHES agents.credit_used. Had the line ever
-- worked, an agent could have paid their invoice in full and still owed every
-- chip of it, because the debt lives in a different column from the bill. The
-- invoice and the ledger were two records of the same money that could not
-- agree, which is the shape CLAUDE.md section 11.5 exists to warn about.
--
-- WHAT THIS MIGRATION DOES
--   1. Bills credit_used. An agent who has borrowed nothing is not invoiced.
--   2. Refuses an invoice larger than the debt, at the single-invoice entry
--      point too, so a hand-rolled caller cannot reintroduce the bug.
--   3. Pays the debt down when the invoice is paid, in the same transaction.
--   4. Voids the 224 phantom invoices. Every one has amount_paid = 0, so
--      nothing is unwound and no chip moves.
--   5. Refuses payment against a void invoice, before any wallet is touched.
--
-- ROLLBACK. The voided rows keep their debt_owed, period and due_date; setting
-- status back to 'pending' restores them exactly. The function bodies are in
-- 20260307_credit_invoices_payments.sql and in this file's git history. Do not
-- roll back the credit_used decrement in fn_apply_credit_payment without also
-- reverting (1), or a paid invoice will again leave the debt standing.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. An invoice can be void, and say why
-- -----------------------------------------------------------------------------
ALTER TABLE public.credit_invoices
  ADD COLUMN IF NOT EXISTS void_reason text;

ALTER TABLE public.credit_invoices
  DROP CONSTRAINT IF EXISTS credit_invoices_status_check;

ALTER TABLE public.credit_invoices
  ADD CONSTRAINT credit_invoices_status_check
  CHECK (status = ANY (ARRAY['pending','partial','paid','overdue','disputed','void']));

COMMENT ON COLUMN public.credit_invoices.void_reason IS
  'Why this invoice was cancelled. A void invoice is never payable; '
  'fn_apply_credit_payment refuses one before any wallet is touched.';

-- -----------------------------------------------------------------------------
-- 2. The batch bills the debt, not the headroom
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_generate_all_credit_invoices(
  p_period_end timestamp with time zone DEFAULT date_trunc('week'::text, now())
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_agent record;
  v_debt numeric;
  v_generated int := 0;
  v_duplicate int := 0;
  v_failed int := 0;
  v_skipped int := 0;
  v_period_start timestamptz := p_period_end - interval '7 days';
  v_due_date timestamptz := p_period_end + interval '2 days';
  v_res jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( NOT public.is_admin()
     AND NOT EXISTS (SELECT 1 FROM public.club_members me
                      WHERE me.user_id = auth.uid()
                        AND me.role IN ('owner','co_owner','admin','manager')))) THEN
    RAISE EXCEPTION 'Not authorised to generate credit invoices';
  END IF;

  -- THE DEBT IS credit_used. It was `credit_limit - agent_wallet_balance`,
  -- which is the unused part of the line - so the less an agent had borrowed,
  -- the more they were billed. An agent who owes nothing is not invoiced at
  -- all, which is why the WHERE clause reads credit_used and not the limit.
  FOR v_agent IN
    SELECT id, credit_used
      FROM agents
     WHERE COALESCE(is_prepaid, false) = false
       AND COALESCE(credit_used, 0) > 0
  LOOP
    v_debt := COALESCE(v_agent.credit_used, 0);
    IF v_debt <= 0 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;
    v_res := fn_generate_credit_invoice(v_agent.id, v_period_start, p_period_end, v_debt, v_due_date);
    IF COALESCE((v_res->>'success')::boolean, false) THEN
      IF COALESCE((v_res->>'duplicate')::boolean, false)
        THEN v_duplicate := v_duplicate + 1;
        ELSE v_generated := v_generated + 1;
      END IF;
    ELSE
      v_failed := v_failed + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'generated', v_generated,
    'duplicate', v_duplicate, 'failed', v_failed, 'skipped', v_skipped,
    'period_end', p_period_end);
END;
$function$;

-- -----------------------------------------------------------------------------
-- 3. The single entry point refuses to bill more than was borrowed
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_generate_credit_invoice(
  p_agent_id uuid,
  p_period_start timestamp with time zone,
  p_period_end timestamp with time zone,
  p_debt_owed numeric,
  p_due_date timestamp with time zone
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_row public.credit_invoices;
  v_used numeric;
  v_prepaid boolean;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> p_agent_id
     AND NOT public.is_admin()
     AND NOT EXISTS (
       SELECT 1 FROM public.club_members me
        WHERE me.user_id = auth.uid()
          AND me.role IN ('owner','co_owner','admin','manager')
          AND me.club_id IN (SELECT club_id FROM public.club_members
                              WHERE user_id = p_agent_id)))) THEN
    RAISE EXCEPTION 'Not authorised to generate an invoice for this agent';
  END IF;

  IF p_agent_id IS NULL OR p_debt_owed IS NULL OR p_debt_owed <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent and positive debt required');
  END IF;

  -- The caller used to supply any figure it liked and this function billed it.
  -- The debt is agents.credit_used and nothing else.
  SELECT COALESCE(credit_used, 0), COALESCE(is_prepaid, false)
    INTO v_used, v_prepaid
    FROM public.agents WHERE id = p_agent_id;

  IF v_used IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent not found');
  END IF;
  IF v_prepaid THEN
    RETURN jsonb_build_object('success', false,
      'error', 'a prepaid agent borrows nothing and cannot be invoiced');
  END IF;
  IF v_used <= 0 THEN
    RETURN jsonb_build_object('success', false,
      'error', 'this agent has drawn no credit, so there is nothing to invoice',
      'credit_used', v_used);
  END IF;
  IF p_debt_owed > v_used THEN
    RETURN jsonb_build_object('success', false,
      'error', 'an invoice cannot exceed the credit actually drawn',
      'requested', p_debt_owed, 'credit_used', v_used);
  END IF;

  INSERT INTO public.credit_invoices (
    agent_id, period_start, period_end, debt_owed,
    amount_paid, amount_remaining, status, due_date
  ) VALUES (
    p_agent_id, p_period_start, p_period_end, p_debt_owed,
    0, p_debt_owed, 'pending', p_due_date
  )
  ON CONFLICT (agent_id, period_end) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM public.credit_invoices
    WHERE agent_id = p_agent_id AND period_end = p_period_end;
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'invoice', to_jsonb(v_row));
  END IF;

  RETURN jsonb_build_object('success', true, 'duplicate', false, 'invoice', to_jsonb(v_row));
END;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Paying the invoice pays down the debt
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_apply_credit_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_method text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
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

  -- A void invoice is not a bill. Refuse before any wallet is touched.
  IF v_inv.status = 'void' THEN
    RETURN jsonb_build_object('success', false, 'error', 'that invoice was voided and is not payable',
      'void_reason', v_inv.void_reason);
  END IF;
  IF v_inv.status = 'paid' THEN
    RETURN jsonb_build_object('success', false, 'error', 'that invoice is already settled');
  END IF;

  -- Never bank more than is owed. amount_paid used to climb past debt_owed
  -- while amount_remaining floored at zero, so the two disagreed by the
  -- overpayment for ever after.
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
    'success', true,
    'invoice_id', p_invoice_id,
    'status', v_status,
    'applied', v_applied,
    'amount_remaining', v_new_remaining,
    'credit_used_after', v_used_after,
    'payment', to_jsonb(v_pay)
  );
END;
$function$;

-- -----------------------------------------------------------------------------
-- 5. The wallet path refuses a void invoice before it deducts anything
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_pay_credit_invoice_from_wallet(
  p_invoice_id uuid,
  p_amount numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
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

  -- Before the deduct, not after. The apply would have raised and rolled the
  -- deduct back, but a wallet that is debited and refunded inside one call is
  -- a ledger entry nobody asked for.
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
       NULL, NULL, p_invoice_id
     ) THEN
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

-- -----------------------------------------------------------------------------
-- 6. Void every invoice that bills more than was ever borrowed
-- -----------------------------------------------------------------------------
-- Measured before writing: all 224 have amount_paid = 0 and every agent's
-- credit_used is 0.00, so this cancels bills and unwinds no payment.
UPDATE public.credit_invoices ci
   SET status = 'void',
       amount_remaining = 0,
       void_reason = 'Billed the unused portion of the credit line rather than '
                     || 'the credit drawn. Corrected 2026-08-31; no payment was '
                     || 'ever made against this invoice.'
  FROM public.agents a
 WHERE a.id = ci.agent_id
   AND ci.status <> 'void'
   AND COALESCE(ci.amount_paid, 0) = 0
   AND ci.debt_owed > COALESCE(a.credit_used, 0);

-- -----------------------------------------------------------------------------
-- 7. Proof
-- -----------------------------------------------------------------------------
DO $verify$
DECLARE
  v_bad int;
  v_voided int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.credit_invoices ci JOIN public.agents a ON a.id = ci.agent_id
   WHERE ci.status NOT IN ('void', 'paid')
     AND ci.debt_owed > COALESCE(a.credit_used, 0);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% live invoice(s) still bill more than the agent has drawn', v_bad;
  END IF;

  SELECT count(*) INTO v_voided FROM public.credit_invoices WHERE status = 'void';
  RAISE NOTICE 'phantom invoices voided: %', v_voided;

  IF pg_get_functiondef('public.fn_apply_credit_payment(uuid,numeric,text)'::regprocedure)
       !~ 'credit_used' THEN
    RAISE EXCEPTION 'fn_apply_credit_payment still does not pay down agents.credit_used';
  END IF;

  IF pg_get_functiondef('public.fn_generate_all_credit_invoices(timestamptz)'::regprocedure)
       ~ 'credit_limit' THEN
    RAISE EXCEPTION 'fn_generate_all_credit_invoices still reads the credit limit';
  END IF;
END
$verify$;

COMMIT;
