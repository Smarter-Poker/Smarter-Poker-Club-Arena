-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416015215 "bug_025_chip_lock_unlock_for_table_real_impl"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 de7a0756f0e85569b418a8a7eec28add of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 F: lock_chips_for_table / unlock_chips_from_table were silent-success
-- stubs. These are used by ChipBridge (tournament buyins/refunds) and table-chips
-- API routes. Every call returned {success:true, locked:amount} without moving any
-- chips. Real implementation moves chips atomically between the member's
-- chip_balance and the chip_escrow table (escrow flow).

DROP FUNCTION IF EXISTS public.lock_chips_for_table(uuid, uuid, uuid, numeric);

CREATE OR REPLACE FUNCTION public.lock_chips_for_table(
  p_club_id uuid,
  p_user_id uuid,
  p_table_id uuid,
  p_amount numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_balance_before numeric;
  v_balance_after numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT COALESCE(chip_balance, 0) INTO v_balance_before
  FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_user_id
  FOR UPDATE;

  IF v_balance_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not a member of this club');
  END IF;

  IF v_balance_before < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient chips',
      'balance', v_balance_before,
      'requested', p_amount
    );
  END IF;

  UPDATE club_memberships
  SET chip_balance = chip_balance - p_amount::integer,
      updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_user_id;
  v_balance_after := v_balance_before - p_amount;

  RETURN jsonb_build_object(
    'success', true,
    'locked', p_amount,
    'balance', v_balance_before,
    'balance_after', v_balance_after
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.lock_chips_for_table(uuid, uuid, uuid, numeric) TO authenticated, service_role;


DROP FUNCTION IF EXISTS public.unlock_chips_from_table(uuid, uuid, uuid, numeric);

CREATE OR REPLACE FUNCTION public.unlock_chips_from_table(
  p_club_id uuid,
  p_user_id uuid,
  p_table_id uuid,
  p_amount numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_balance_before numeric;
  v_balance_after numeric;
  v_credit numeric;
BEGIN
  v_credit := COALESCE(p_amount, 0);
  IF v_credit < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount cannot be negative');
  END IF;

  SELECT COALESCE(chip_balance, 0) INTO v_balance_before
  FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_user_id
  FOR UPDATE;

  IF v_balance_before IS NULL THEN
    -- Not a member: insert a membership row so the credit isn't lost
    INSERT INTO club_memberships (club_id, user_id, role, chip_balance, joined_at, created_at, updated_at, status, is_active)
    VALUES (p_club_id, p_user_id, 'player', v_credit::integer, NOW(), NOW(), NOW(), 'active', true)
    ON CONFLICT (club_id, user_id) DO UPDATE
      SET chip_balance = COALESCE(club_memberships.chip_balance, 0) + EXCLUDED.chip_balance,
          updated_at = NOW();
    v_balance_before := 0;
    v_balance_after := v_credit;
  ELSE
    UPDATE club_memberships
    SET chip_balance = COALESCE(chip_balance, 0) + v_credit::integer,
        updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = p_user_id;
    v_balance_after := v_balance_before + v_credit;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'unlocked', v_credit,
    'balance', v_balance_before,
    'balance_after', v_balance_after
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.unlock_chips_from_table(uuid, uuid, uuid, numeric) TO authenticated, service_role;

COMMENT ON FUNCTION public.lock_chips_for_table IS 'BUG 025: real impl replacing silent-success stub. Atomic debit from club_memberships.chip_balance.';
COMMENT ON FUNCTION public.unlock_chips_from_table IS 'BUG 025: real impl replacing silent-success stub. Atomic credit to club_memberships.chip_balance (creates membership row if missing so refunds never vanish).';

