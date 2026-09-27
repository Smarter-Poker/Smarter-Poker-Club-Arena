-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721132851 "credit_invoices_subsystem_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c8f9249117fefb1b4e8c50cd5221400d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE TABLE IF NOT EXISTS public.credit_invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  period_start     timestamptz NOT NULL,
  period_end       timestamptz NOT NULL,
  debt_owed        numeric NOT NULL DEFAULT 0 CHECK (debt_owed >= 0),
  amount_paid      numeric NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  amount_remaining numeric NOT NULL DEFAULT 0 CHECK (amount_remaining >= 0),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','partial','paid','overdue','disputed')),
  due_date         timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  paid_at          timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS credit_invoices_agent_period_uidx
  ON public.credit_invoices (agent_id, period_end);
CREATE INDEX IF NOT EXISTS idx_credit_invoices_agent   ON public.credit_invoices (agent_id);
CREATE INDEX IF NOT EXISTS idx_credit_invoices_status  ON public.credit_invoices (status);
CREATE INDEX IF NOT EXISTS idx_credit_invoices_duedate ON public.credit_invoices (due_date);

CREATE TABLE IF NOT EXISTS public.credit_payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     uuid NOT NULL REFERENCES public.credit_invoices(id) ON DELETE CASCADE,
  amount         numeric NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('wallet','diamonds','external')),
  transaction_id text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_payments_invoice ON public.credit_payments (invoice_id);

ALTER TABLE public.credit_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS credit_invoices_select_own ON public.credit_invoices;
CREATE POLICY credit_invoices_select_own ON public.credit_invoices
  FOR SELECT TO public
  USING (agent_id IN (SELECT a.id FROM public.agents a WHERE a.user_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS credit_payments_select_own ON public.credit_payments;
CREATE POLICY credit_payments_select_own ON public.credit_payments
  FOR SELECT TO public
  USING (invoice_id IN (
    SELECT ci.id FROM public.credit_invoices ci
    JOIN public.agents a ON a.id = ci.agent_id
    WHERE a.user_id = (SELECT auth.uid())
  ));

CREATE OR REPLACE FUNCTION public.fn_generate_credit_invoice(
  p_agent_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_debt_owed numeric,
  p_due_date timestamptz
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_row public.credit_invoices;
BEGIN
  IF p_agent_id IS NULL OR p_debt_owed IS NULL OR p_debt_owed <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent and positive debt required');
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

CREATE OR REPLACE FUNCTION public.fn_apply_credit_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_method text
)
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

  v_new_paid      := v_inv.amount_paid + p_amount;
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

  INSERT INTO public.credit_payments (invoice_id, amount, payment_method)
  VALUES (p_invoice_id, p_amount, p_method)
  RETURNING * INTO v_pay;

  RETURN jsonb_build_object(
    'success', true,
    'invoice_id', p_invoice_id,
    'status', v_status,
    'amount_remaining', v_new_remaining,
    'payment', to_jsonb(v_pay)
  );
END;
$function$;

DO $$
DECLARE r jsonb;
BEGIN
  SELECT fn_generate_credit_invoice(NULL, now(), now(), 0, now()) INTO r;
  IF (r->>'success') <> 'false' THEN RAISE EXCEPTION 'generate guard failed: %', r; END IF;
  SELECT fn_apply_credit_payment(NULL, 0, 'wallet') INTO r;
  IF (r->>'success') <> 'false' THEN RAISE EXCEPTION 'apply guard failed: %', r; END IF;
  IF (SELECT count(*) FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('credit_invoices','credit_payments')) <> 2 THEN
    RAISE EXCEPTION 'credit tables not created';
  END IF;
END $$;
