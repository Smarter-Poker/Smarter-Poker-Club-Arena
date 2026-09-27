-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416015718 "bug_025_fn_credit_debit_chips_real_impl"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3de8c395ce3757bcc3c84ed4197131fb of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 I: fn_credit_chips / fn_debit_chips were silent-success stubs. Called
-- by auto-settlement-distribute cron, manage-agent, rakeback, union-wallet BBJ
-- payouts. These are the atomic player chip_balance mutation RPCs.

DROP FUNCTION IF EXISTS public.fn_credit_chips(uuid, uuid, numeric, text, jsonb);
CREATE OR REPLACE FUNCTION public.fn_credit_chips(
  p_club_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_reason text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_before numeric;
  v_after numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT COALESCE(chip_balance, 0) INTO v_before
  FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_user_id FOR UPDATE;

  IF v_before IS NULL THEN
    -- Auto-create membership so credit isn't lost
    INSERT INTO club_memberships (club_id, user_id, role, chip_balance, joined_at, created_at, updated_at, status, is_active)
    VALUES (p_club_id, p_user_id, 'player', p_amount::integer, NOW(), NOW(), NOW(), 'active', true)
    ON CONFLICT (club_id, user_id) DO UPDATE
      SET chip_balance = COALESCE(club_memberships.chip_balance, 0) + EXCLUDED.chip_balance,
          updated_at = NOW();
    v_before := 0;
    v_after := p_amount;
  ELSE
    UPDATE club_memberships
    SET chip_balance = COALESCE(chip_balance, 0) + p_amount::integer,
        updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = p_user_id;
    v_after := v_before + p_amount;
  END IF;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, metadata, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, NULL, p_user_id, p_amount,
    COALESCE(p_metadata->>'transaction_type', 'chip_credit'),
    COALESCE(p_reason, 'Chip credit'), p_metadata, v_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'balance_before', v_before,
    'balance_after', v_after
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_credit_chips(uuid, uuid, numeric, text, jsonb) TO authenticated, service_role;


DROP FUNCTION IF EXISTS public.fn_debit_chips(uuid, uuid, numeric, text, jsonb);
CREATE OR REPLACE FUNCTION public.fn_debit_chips(
  p_club_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_reason text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_before numeric;
  v_after numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT COALESCE(chip_balance, 0) INTO v_before
  FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_user_id FOR UPDATE;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not a member of this club');
  END IF;

  IF v_before < p_amount THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'insufficient chips',
      'balance', v_before, 'requested', p_amount
    );
  END IF;

  UPDATE club_memberships
  SET chip_balance = chip_balance - p_amount::integer,
      updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_user_id;
  v_after := v_before - p_amount;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, metadata, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_user_id, NULL, p_amount,
    COALESCE(p_metadata->>'transaction_type', 'chip_debit'),
    COALESCE(p_reason, 'Chip debit'), p_metadata, v_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'balance_before', v_before,
    'balance_after', v_after
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_debit_chips(uuid, uuid, numeric, text, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_credit_chips IS 'BUG 025: real impl. Atomic credit to club_memberships.chip_balance (auto-creates membership) + chip_transactions audit.';
COMMENT ON FUNCTION public.fn_debit_chips  IS 'BUG 025: real impl. Atomic debit from club_memberships.chip_balance (fails on insufficient) + chip_transactions audit.';

