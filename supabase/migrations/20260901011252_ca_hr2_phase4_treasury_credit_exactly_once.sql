-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

-- ═══════════════════════════════════════════════════════════════════════════
-- HARDENING ROUND 2, PHASE 4: fn_credit_treasury joins the exactly-once
-- club. The three club-bank/admin movers already carry durable receipt-based
-- op-id replay (verified by sim in this phase); the treasury credit was the
-- last admin mover with no idempotency at all. Wrapper/core pattern, claims
-- in ca_op_claims, byte-identical behaviour when no op id is passed.
-- ═══════════════════════════════════════════════════════════════════════════
DROP FUNCTION public.fn_credit_treasury(uuid, numeric, text, jsonb);

CREATE FUNCTION public.fn_credit_treasury_zd4core(
  p_club_id uuid, p_amount numeric, p_reason text, p_metadata jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_before numeric;
  v_after numeric;
BEGIN
  IF p_club_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid parameters');
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_before
  FROM clubs WHERE id = p_club_id FOR UPDATE;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;

  UPDATE clubs
  SET chip_treasury = COALESCE(chip_treasury, 0) + p_amount,
      updated_at = NOW()
  WHERE id = p_club_id;
  v_after := v_before + p_amount;

  INSERT INTO chip_transactions (
    id, club_id, amount, transaction_type, notes, metadata, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_amount,
    'treasury_credit', COALESCE(p_reason, 'Treasury credit'), p_metadata, v_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'balance_before', v_before,
    'balance_after', v_after
  );
END;
$function$;

CREATE FUNCTION public.fn_credit_treasury(
  p_club_id uuid, p_amount numeric,
  p_reason text DEFAULT NULL::text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_op_id text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_prior jsonb;
  v_res jsonb;
BEGIN
  IF p_op_id IS NULL THEN
    RETURN public.fn_credit_treasury_zd4core(p_club_id, p_amount, p_reason, p_metadata);
  END IF;

  SELECT result INTO v_prior
    FROM public.ca_op_claims
   WHERE op_id = p_op_id AND fn_name = 'fn_credit_treasury';
  IF FOUND AND v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true, 'op_id', p_op_id);
  ELSIF FOUND THEN
    DELETE FROM public.ca_op_claims
     WHERE op_id = p_op_id AND fn_name = 'fn_credit_treasury';
  END IF;

  INSERT INTO public.ca_op_claims (op_id, fn_name, claimed_by)
  VALUES (p_op_id, 'fn_credit_treasury', auth.uid());

  v_res := public.fn_credit_treasury_zd4core(p_club_id, p_amount, p_reason, p_metadata);

  IF COALESCE(v_res->>'success', '') = 'true' THEN
    UPDATE public.ca_op_claims
       SET result = v_res, finalized_at = now()
     WHERE op_id = p_op_id AND fn_name = 'fn_credit_treasury';
  ELSE
    DELETE FROM public.ca_op_claims
     WHERE op_id = p_op_id AND fn_name = 'fn_credit_treasury';
  END IF;

  RETURN v_res;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_credit_treasury_zd4core(uuid, numeric, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_treasury_zd4core(uuid, numeric, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_credit_treasury(uuid, numeric, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_credit_treasury(uuid, numeric, text, jsonb, text) TO service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
SELECT 'fn_credit_treasury_zd4core', 'approved',
       'Hardening round 2 phase 4 (2026-09-01): exact pre-phase-4 body of fn_credit_treasury, callable only by its op-id wrapper and service_role.'
WHERE NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry WHERE proname='fn_credit_treasury_zd4core');

NOTIFY pgrst, 'reload schema';;
