CREATE OR REPLACE FUNCTION public.fn_generate_credit_invoice(p_agent_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_debt_owed numeric, p_due_date timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
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
CREATE OR REPLACE FUNCTION public.fn_generate_all_credit_invoices(p_period_end timestamp with time zone DEFAULT date_trunc('week'::text, now()))
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
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

  -- THE DEBT IS credit_used. It was the unused part of the line, so the less an
  -- agent had borrowed the more they were billed.
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
