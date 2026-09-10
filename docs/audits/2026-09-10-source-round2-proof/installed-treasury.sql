CREATE OR REPLACE FUNCTION public.fn_debit_treasury(p_club_id uuid, p_amount numeric, p_reason text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
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
$function$
;
