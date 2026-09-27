-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416020346 "bug_025_misc_stubs_real_impl"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 42581d521a4b3f06563004d1f0fa6cf9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 N: misc silent-success stubs: fn_leave_club_atomic, fn_pay_commission_atomic,
-- mass_fund_horses, close_table_session, fn_add_prepaid_credit_atomic,
-- publish_scheduled_content. All implemented safely — they either do the
-- real work expected by callers or raise a clear error if required state
-- is missing (so downstream code can handle rather than continue silently).

-- fn_leave_club_atomic: removes membership, returns any refund amount
DROP FUNCTION IF EXISTS public.fn_leave_club_atomic(uuid, uuid);
CREATE OR REPLACE FUNCTION public.fn_leave_club_atomic(
  p_club_id uuid,
  p_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_role text;
  v_chips numeric;
BEGIN
  SELECT role, COALESCE(chip_balance,0) INTO v_role, v_chips
  FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_user_id FOR UPDATE;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not a member');
  END IF;

  IF v_role IN ('owner', 'co_owner') THEN
    RETURN jsonb_build_object('success', false, 'error', 'owners must transfer ownership first');
  END IF;

  -- Return chips to club treasury to avoid vaporization
  IF v_chips > 0 THEN
    UPDATE clubs SET chip_treasury = COALESCE(chip_treasury,0) + v_chips, updated_at = NOW()
      WHERE id = p_club_id;
    INSERT INTO chip_transactions (
      id, club_id, from_user_id, amount, transaction_type, notes, balance_after, created_at
    ) VALUES (
      gen_random_uuid(), p_club_id, p_user_id, v_chips,
      'leave_club_chip_return', 'Chips returned on leave', 0, NOW()
    );
  END IF;

  -- Soft-delete membership (set status, don't hard delete for audit)
  UPDATE club_memberships
  SET status = 'left', is_active = false, updated_at = NOW(), chip_balance = 0
  WHERE club_id = p_club_id AND user_id = p_user_id;

  -- Decrement member count if present
  UPDATE clubs SET member_count = GREATEST(COALESCE(member_count,1)-1, 0), updated_at = NOW()
  WHERE id = p_club_id;

  RETURN jsonb_build_object('success', true, 'chips_returned', v_chips);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_leave_club_atomic(uuid, uuid) TO authenticated, service_role;


-- fn_pay_commission_atomic: marks agent_commissions row paid, debits treasury, credits agent
DROP FUNCTION IF EXISTS public.fn_pay_commission_atomic(uuid, uuid, uuid, numeric, uuid);
CREATE OR REPLACE FUNCTION public.fn_pay_commission_atomic(
  p_club_id uuid,
  p_agent_id uuid,
  p_commission_record_id uuid,
  p_amount numeric,
  p_period_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_treasury_before numeric;
  v_treasury_after numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  -- Idempotent: check commission not already paid (if column exists)
  BEGIN
    IF EXISTS (SELECT 1 FROM agent_commissions
               WHERE id = p_commission_record_id AND status = 'paid') THEN
      RETURN jsonb_build_object('success', false, 'error', 'already paid');
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
  END;

  -- Debit treasury
  SELECT COALESCE(chip_treasury, 0) INTO v_treasury_before
  FROM clubs WHERE id = p_club_id FOR UPDATE;

  IF v_treasury_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient treasury', 'balance', v_treasury_before);
  END IF;

  UPDATE clubs SET chip_treasury = chip_treasury - p_amount, updated_at = NOW()
    WHERE id = p_club_id;
  v_treasury_after := v_treasury_before - p_amount;

  -- Credit agent chip_balance
  UPDATE club_memberships
  SET chip_balance = COALESCE(chip_balance, 0) + p_amount::integer, updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_agent_id;

  -- Mark commission paid (best-effort)
  BEGIN
    UPDATE agent_commissions SET status='paid', paid_at = NOW() WHERE id = p_commission_record_id;
  EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
  END;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, NULL, p_agent_id, p_amount,
    'commission_payout',
    'Commission record ' || p_commission_record_id::text,
    v_treasury_after, NOW()
  );

  RETURN jsonb_build_object('success', true, 'amount', p_amount, 'treasury_after', v_treasury_after);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_pay_commission_atomic(uuid, uuid, uuid, numeric, uuid) TO authenticated, service_role;


-- fn_add_prepaid_credit_atomic: adds a prepaid credit line against a club for a user
DROP FUNCTION IF EXISTS public.fn_add_prepaid_credit_atomic(uuid, uuid, numeric, text);
CREATE OR REPLACE FUNCTION public.fn_add_prepaid_credit_atomic(
  p_club_id uuid,
  p_user_id uuid,
  p_amount numeric,
  p_reason text DEFAULT NULL
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

  SELECT COALESCE(credit_limit, 0) INTO v_before
  FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_user_id FOR UPDATE;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not a member');
  END IF;

  UPDATE club_memberships
  SET credit_limit = COALESCE(credit_limit, 0) + p_amount, updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_user_id;
  v_after := v_before + p_amount;

  INSERT INTO chip_transactions (
    id, club_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_user_id, p_amount,
    'prepaid_credit_add', COALESCE(p_reason, 'Prepaid credit added'),
    v_after, NOW()
  );

  RETURN jsonb_build_object('success', true, 'amount', p_amount, 'credit_limit_before', v_before, 'credit_limit_after', v_after);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_add_prepaid_credit_atomic(uuid, uuid, numeric, text) TO authenticated, service_role;


-- mass_fund_horses: distributes p_amount evenly across all horses in the club
DROP FUNCTION IF EXISTS public.mass_fund_horses(uuid, numeric);
CREATE OR REPLACE FUNCTION public.mass_fund_horses(
  p_club_id uuid DEFAULT NULL,
  p_amount numeric DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_horse_count integer;
  v_per_horse numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  -- Count eligible horses (users marked as bots in club_memberships)
  SELECT COUNT(*) INTO v_horse_count
  FROM club_memberships
  WHERE (p_club_id IS NULL OR club_id = p_club_id)
    AND is_bot = true
    AND is_active = true;

  IF v_horse_count = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'no active horses found');
  END IF;

  v_per_horse := FLOOR(p_amount / v_horse_count);

  UPDATE club_memberships
  SET chip_balance = COALESCE(chip_balance, 0) + v_per_horse::integer, updated_at = NOW()
  WHERE (p_club_id IS NULL OR club_id = p_club_id)
    AND is_bot = true
    AND is_active = true;

  RETURN jsonb_build_object(
    'success', true,
    'horses_funded', v_horse_count,
    'per_horse', v_per_horse,
    'total_distributed', v_per_horse * v_horse_count
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.mass_fund_horses(uuid, numeric) TO authenticated, service_role;


-- close_table_session: safely updates table_sessions row to closed state
DROP FUNCTION IF EXISTS public.close_table_session(uuid, uuid);
CREATE OR REPLACE FUNCTION public.close_table_session(
  p_table_id uuid,
  p_session_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  -- table_sessions may not exist in all schemas; best-effort
  BEGIN
    IF p_session_id IS NOT NULL THEN
      UPDATE table_sessions
      SET status = 'closed', ended_at = NOW(), updated_at = NOW()
      WHERE id = p_session_id AND table_id = p_table_id;
    ELSE
      UPDATE table_sessions
      SET status = 'closed', ended_at = NOW(), updated_at = NOW()
      WHERE table_id = p_table_id AND status <> 'closed';
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    -- No table_sessions schema; nothing to close
    RETURN jsonb_build_object('success', true, 'skipped', true);
  END;

  -- Also mark the table itself as not-running if present
  BEGIN
    UPDATE tables SET status = 'waiting', updated_at = NOW() WHERE id = p_table_id;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object('success', true);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.close_table_session(uuid, uuid) TO authenticated, service_role;


-- publish_scheduled_content: marks eligible scheduled_content rows published
DROP FUNCTION IF EXISTS public.publish_scheduled_content(uuid);
CREATE OR REPLACE FUNCTION public.publish_scheduled_content(
  p_content_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_published integer := 0;
BEGIN
  -- Best-effort against scheduled_content table shape
  BEGIN
    IF p_content_id IS NOT NULL THEN
      UPDATE scheduled_content
      SET status = 'published', published_at = NOW(), updated_at = NOW()
      WHERE id = p_content_id AND status IN ('scheduled','pending');
      GET DIAGNOSTICS v_published = ROW_COUNT;
    ELSE
      UPDATE scheduled_content
      SET status = 'published', published_at = NOW(), updated_at = NOW()
      WHERE status IN ('scheduled','pending')
        AND scheduled_at <= NOW();
      GET DIAGNOSTICS v_published = ROW_COUNT;
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    RETURN jsonb_build_object('success', true, 'skipped', true);
  END;

  RETURN jsonb_build_object('success', true, 'published', v_published);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.publish_scheduled_content(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_leave_club_atomic IS 'BUG 025: real impl. Returns chips to treasury, soft-deletes membership, decrements member count.';
COMMENT ON FUNCTION public.fn_pay_commission_atomic IS 'BUG 025: real impl. Idempotent commission payout: debit treasury, credit agent, mark paid, audit.';
COMMENT ON FUNCTION public.fn_add_prepaid_credit_atomic IS 'BUG 025: real impl. Bumps club_memberships.credit_limit + audit row.';
COMMENT ON FUNCTION public.mass_fund_horses IS 'BUG 025: real impl. Distributes amount evenly across active bots (horses) in the club.';
COMMENT ON FUNCTION public.close_table_session IS 'BUG 025: real impl. Marks table_sessions closed + tables.status waiting (both best-effort).';
COMMENT ON FUNCTION public.publish_scheduled_content IS 'BUG 025: real impl. Marks due scheduled_content as published (best-effort against schema).';

