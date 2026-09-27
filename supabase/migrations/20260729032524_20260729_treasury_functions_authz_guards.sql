-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260729032524 "20260729_treasury_functions_authz_guards"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b931a60dd08def63593403175b9bf0f5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Decision D (2026-07-29): add in-function authorization to the three treasury
-- functions that move money. They are SECURITY DEFINER and callable by the
-- club-arena SPA as `authenticated`, so previously ANY logged-in user could
-- invoke them. Guard: when the caller is an end user (auth.uid() IS NOT NULL)
-- they must be the club owner or a privileged club member/agent for the club
-- the money moves in. Trusted backend/service-role calls (auth.uid() IS NULL,
-- anon EXECUTE already revoked) are unaffected, so cron/settlement keep working.

-- Shared predicate: is the current end-user actor allowed to move money for this club?
CREATE OR REPLACE FUNCTION public.fn_actor_can_manage_club_treasury(p_club_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    -- Backend / service-role context (no end-user JWT): trusted, allow.
    auth.uid() IS NULL
    OR EXISTS (SELECT 1 FROM public.clubs c
               WHERE c.id = p_club_id AND c.owner_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.club_members cm
               WHERE cm.club_id = p_club_id
                 AND cm.user_id = auth.uid()
                 AND cm.role IN ('owner','admin','manager','super_agent','treasurer'))
    OR EXISTS (SELECT 1 FROM public.agents a
               WHERE a.club_id = p_club_id
                 AND a.user_id = auth.uid()
                 AND a.role IN ('owner','admin','manager','super_agent'));
$$;

REVOKE ALL ON FUNCTION public.fn_actor_can_manage_club_treasury(uuid) FROM anon;

-- 1) fn_apply_credit_payment: authorize the club owner/manager over the invoice's
--    agent, or the agent paying their own invoice.
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
  v_club_id uuid;
  v_actor uuid;
  v_is_self boolean;
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

  -- AUTHZ: resolve the club that owns this invoice (via the agent) and check.
  v_actor := auth.uid();
  SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = v_inv.agent_id;
  v_is_self := (v_actor IS NOT NULL) AND EXISTS (
    SELECT 1 FROM public.agents a WHERE a.id = v_inv.agent_id AND a.user_id = v_actor
  );
  IF NOT (v_is_self OR public.fn_actor_can_manage_club_treasury(v_club_id)) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to apply payment to this invoice');
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

-- 2) fn_horse_fund_from_treasury: club derived from table; guard before any write.
CREATE OR REPLACE FUNCTION public.fn_horse_fund_from_treasury(p_table_id uuid, p_user_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_treasury numeric;
  v_new_stack numeric;
BEGIN
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user and positive amount required');
  END IF;

  SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  -- AUTHZ: only a club owner/manager (or trusted backend) may fund from treasury.
  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to fund from club treasury');
  END IF;

  -- Lock + check the club treasury.
  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM clubs WHERE id = v_club_id FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury',
                              'treasury', v_treasury, 'needed', p_amount);
  END IF;

  -- Credit the horse's active seat first; abort if the seat is gone.
  UPDATE table_seats
  SET stack = COALESCE(stack, 0) + p_amount
  WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
  RETURNING stack INTO v_new_stack;

  IF v_new_stack IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no active seat for user at table');
  END IF;

  -- Debit the treasury (only now that the seat credit succeeded).
  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount, updated_at = NOW()
  WHERE id = v_club_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club_id, NULL, p_user_id, p_amount,
    'horse_treasury_funding', 'Horse buy-in/rebuy funded from club treasury',
    v_treasury - p_amount, NOW()
  );

  RETURN jsonb_build_object('success', true, 'new_stack', v_new_stack,
                            'treasury_after', v_treasury - p_amount);
END;
$function$;

-- 3) fn_horse_seat_from_treasury: same guard.
CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury(p_table_id uuid, p_user_id uuid, p_seat_number integer, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_treasury numeric;
BEGIN
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_seat_number IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user, seat and positive amount required');
  END IF;

  SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  -- AUTHZ: only a club owner/manager (or trusted backend) may seat from treasury.
  IF NOT public.fn_actor_can_manage_club_treasury(v_club_id) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to seat from club treasury');
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM clubs WHERE id = v_club_id FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury',
                              'treasury', v_treasury, 'needed', p_amount);
  END IF;

  BEGIN
    INSERT INTO table_seats (table_id, user_id, seat_number, stack, is_sitting_out)
    VALUES (p_table_id, p_user_id, p_seat_number, p_amount, false);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'seat already taken');
  END;

  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount, updated_at = NOW()
  WHERE id = v_club_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club_id, NULL, p_user_id, p_amount,
    'horse_treasury_funding', 'Horse seated + funded from club treasury',
    v_treasury - p_amount, NOW()
  );

  RETURN jsonb_build_object('success', true, 'treasury_after', v_treasury - p_amount);
END;
$function$;
