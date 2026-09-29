-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416015321 "bug_025_cashout_approve_cancel_atomic_real_impl"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 daf4729603e34a70b79997351e117e69 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 G: fn_approve_cashout_atomic / fn_cancel_cashout_atomic were silent-success
-- stubs. Called by the agent cashout-approval API route. Every agent "approval"
-- for ~weeks returned success without updating the cashout row, crediting treasury,
-- or logging a transaction. Same for cancellation: the player's chips never came
-- back from escrow. Replacing with real atomic implementations.

DROP FUNCTION IF EXISTS public.fn_approve_cashout_atomic(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.fn_approve_cashout_atomic(
  p_cashout_id uuid,
  p_agent_id uuid,
  p_agent_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_cashout record;
  v_treasury_after numeric;
BEGIN
  -- Lock the cashout row
  SELECT * INTO v_cashout
  FROM cashout_requests
  WHERE id = p_cashout_id
  FOR UPDATE;

  IF v_cashout IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not found');
  END IF;

  IF v_cashout.status <> 'pending' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'cashout not in pending status',
      'current_status', v_cashout.status
    );
  END IF;

  -- Authorization: must be agent/owner/super_agent of the club
  IF NOT EXISTS (
    SELECT 1 FROM club_memberships
    WHERE club_id = v_cashout.club_id
      AND user_id = p_agent_id
      AND role IN ('agent', 'super_agent', 'owner', 'co_owner', 'admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to approve for this club');
  END IF;

  -- Credit club treasury (agent settled the fiat off-platform; chips stay in system)
  UPDATE clubs
  SET chip_treasury = COALESCE(chip_treasury, 0) + v_cashout.amount,
      updated_at = NOW()
  WHERE id = v_cashout.club_id
  RETURNING chip_treasury INTO v_treasury_after;

  -- Transition cashout -> approved
  UPDATE cashout_requests
  SET status = 'approved',
      agent_note = COALESCE(p_agent_note, agent_note),
      updated_at = NOW(),
      acknowledged_at = NOW()
  WHERE id = p_cashout_id;

  -- Audit
  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, related_cashout_id, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_cashout.club_id, v_cashout.player_id, NULL, v_cashout.amount,
    'cashout_approved',
    COALESCE(p_agent_note, 'Cashout approved; chips moved to treasury'),
    p_cashout_id, v_treasury_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'cashout_id', p_cashout_id,
    'amount', v_cashout.amount,
    'treasury_after', v_treasury_after
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_approve_cashout_atomic(uuid, uuid, text) TO authenticated, service_role;


DROP FUNCTION IF EXISTS public.fn_cancel_cashout_atomic(uuid, uuid, boolean, text);

CREATE OR REPLACE FUNCTION public.fn_cancel_cashout_atomic(
  p_cashout_id uuid,
  p_user_id uuid,
  p_is_agent boolean DEFAULT false,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_cashout record;
  v_new_balance numeric;
BEGIN
  SELECT * INTO v_cashout
  FROM cashout_requests
  WHERE id = p_cashout_id
  FOR UPDATE;

  IF v_cashout IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not found');
  END IF;

  IF v_cashout.status <> 'pending' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'cashout not in pending status',
      'current_status', v_cashout.status
    );
  END IF;

  -- Authorization: caller is the requester OR an agent/owner in that club
  IF p_is_agent THEN
    IF NOT EXISTS (
      SELECT 1 FROM club_memberships
      WHERE club_id = v_cashout.club_id
        AND user_id = p_user_id
        AND role IN ('agent', 'super_agent', 'owner', 'co_owner', 'admin')
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'not authorized to cancel for this club');
    END IF;
  ELSE
    IF v_cashout.player_id <> p_user_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'only the requester can self-cancel');
    END IF;
  END IF;

  -- Refund the player's chip_balance (escrow was held when request was created)
  UPDATE club_memberships
  SET chip_balance = COALESCE(chip_balance, 0) + v_cashout.amount::integer,
      updated_at = NOW()
  WHERE club_id = v_cashout.club_id AND user_id = v_cashout.player_id
  RETURNING chip_balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    -- Membership gone: create it so refund doesn't vanish
    INSERT INTO club_memberships (club_id, user_id, role, chip_balance, joined_at, created_at, updated_at, status, is_active)
    VALUES (v_cashout.club_id, v_cashout.player_id, 'player', v_cashout.amount::integer, NOW(), NOW(), NOW(), 'active', true)
    ON CONFLICT (club_id, user_id) DO UPDATE
      SET chip_balance = COALESCE(club_memberships.chip_balance, 0) + EXCLUDED.chip_balance,
          updated_at = NOW()
    RETURNING chip_balance INTO v_new_balance;
  END IF;

  -- Transition cashout -> cancelled
  UPDATE cashout_requests
  SET status = 'cancelled',
      agent_note = CASE WHEN p_is_agent THEN COALESCE(p_note, agent_note) ELSE agent_note END,
      player_note = CASE WHEN NOT p_is_agent THEN COALESCE(p_note, player_note) ELSE player_note END,
      cancelled_at = NOW(),
      updated_at = NOW()
  WHERE id = p_cashout_id;

  -- Audit
  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, related_cashout_id, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_cashout.club_id, NULL, v_cashout.player_id, v_cashout.amount,
    CASE WHEN p_is_agent THEN 'cashout_cancelled_by_agent' ELSE 'cashout_cancelled_by_player' END,
    COALESCE(p_note, 'Cashout cancelled; chips returned from escrow'),
    p_cashout_id, 0, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'cashout_id', p_cashout_id,
    'amount', v_cashout.amount,
    'new_balance', v_new_balance
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_cancel_cashout_atomic(uuid, uuid, boolean, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_approve_cashout_atomic IS 'BUG 025: real impl. Validates pending status + agent authorization, credits chip_treasury, transitions cashout to approved, writes audit.';
COMMENT ON FUNCTION public.fn_cancel_cashout_atomic IS 'BUG 025: real impl. Validates pending + authorization (self or agent), refunds player chip_balance from escrow, transitions cashout to cancelled, writes audit.';

