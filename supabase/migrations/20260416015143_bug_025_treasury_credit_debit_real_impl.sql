-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416015143 "bug_025_treasury_credit_debit_real_impl"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 110f3bbe5454f230946f31227e47dd11 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 E: fn_credit_treasury / fn_debit_treasury were silent-success stubs.
-- These are the atomic treasury mutation RPCs used by every rake settlement,
-- union rakeback cron, tournament overlay debit, settle-period payout, etc.
-- No rake or settlement has actually moved clubs.chip_treasury since at least
-- 2026-03-24 (last chip_transactions audit row), because these were no-ops.

DROP FUNCTION IF EXISTS public.fn_credit_treasury(uuid, numeric, text, jsonb);

CREATE OR REPLACE FUNCTION public.fn_credit_treasury(
  p_club_id uuid,
  p_amount numeric,
  p_reason text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
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

GRANT EXECUTE ON FUNCTION public.fn_credit_treasury(uuid, numeric, text, jsonb) TO authenticated, service_role;


DROP FUNCTION IF EXISTS public.fn_debit_treasury(uuid, numeric, text, jsonb);

CREATE OR REPLACE FUNCTION public.fn_debit_treasury(
  p_club_id uuid,
  p_amount numeric,
  p_reason text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
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

  IF v_before < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient treasury',
      'balance', v_before,
      'requested', p_amount
    );
  END IF;

  UPDATE clubs
  SET chip_treasury = chip_treasury - p_amount,
      updated_at = NOW()
  WHERE id = p_club_id;
  v_after := v_before - p_amount;

  INSERT INTO chip_transactions (
    id, club_id, amount, transaction_type, notes, metadata, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_amount,
    'treasury_debit', COALESCE(p_reason, 'Treasury debit'), p_metadata, v_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'balance_before', v_before,
    'balance_after', v_after
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_debit_treasury(uuid, numeric, text, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_credit_treasury IS 'BUG 025: real impl replacing silent-success stub. Atomic credit to clubs.chip_treasury + chip_transactions audit.';
COMMENT ON FUNCTION public.fn_debit_treasury  IS 'BUG 025: real impl replacing silent-success stub. Atomic debit from clubs.chip_treasury + chip_transactions audit (errors if insufficient).';

