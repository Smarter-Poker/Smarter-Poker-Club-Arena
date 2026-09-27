-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416014458 "bug_025_distribute_chips_real_impl"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9f714f2abe4b11ec917f279dbce617a1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 A: distribute_chips was a silent-success stub: returned {success:true}
-- but never debited treasury or credited the member. Agents have been "distributing"
-- chips that never moved. Replacing with real atomic implementation.
DROP FUNCTION IF EXISTS public.distribute_chips(uuid, uuid, numeric, uuid);

CREATE OR REPLACE FUNCTION public.distribute_chips(
  p_club_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_distributed_by uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_treasury_before numeric;
  v_treasury_after numeric;
  v_member_before numeric;
  v_member_after numeric;
  v_is_member boolean;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  -- Validate distributor is agent/owner/super_agent of this club
  IF NOT EXISTS (
    SELECT 1 FROM club_memberships
    WHERE club_id = p_club_id
      AND user_id = p_distributed_by
      AND role IN ('agent', 'super_agent', 'owner', 'co_owner', 'admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to distribute');
  END IF;

  -- Lock club row + read treasury
  SELECT COALESCE(chip_pool, 0) INTO v_treasury_before
  FROM clubs WHERE id = p_club_id FOR UPDATE;

  IF v_treasury_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;

  IF v_treasury_before < p_amount THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'insufficient club treasury',
      'treasury', v_treasury_before,
      'requested', p_amount
    );
  END IF;

  -- Ensure recipient is member of club
  SELECT EXISTS(
    SELECT 1 FROM club_memberships
    WHERE club_id = p_club_id AND user_id = p_to_user_id
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RETURN jsonb_build_object('success', false, 'error', 'recipient is not a member of this club');
  END IF;

  -- Debit treasury
  UPDATE clubs
  SET chip_pool = chip_pool - p_amount,
      updated_at = NOW()
  WHERE id = p_club_id;
  v_treasury_after := v_treasury_before - p_amount;

  -- Credit member
  SELECT COALESCE(chip_balance, 0) INTO v_member_before
  FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_to_user_id FOR UPDATE;

  UPDATE club_memberships
  SET chip_balance = COALESCE(chip_balance, 0) + p_amount::integer,
      updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_to_user_id;
  v_member_after := v_member_before + p_amount;

  -- Audit log
  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_distributed_by, p_to_user_id, p_amount,
    'agent_distribution', 'Treasury distribution', v_treasury_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'amount', p_amount,
    'treasury_before', v_treasury_before,
    'treasury_after', v_treasury_after,
    'member_before', v_member_before,
    'member_after', v_member_after
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.distribute_chips(uuid, uuid, numeric, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.distribute_chips IS
'BUG 025: real implementation replacing silent-success stub. Atomically debits club treasury + credits member chip_balance + writes chip_transactions audit row.';

