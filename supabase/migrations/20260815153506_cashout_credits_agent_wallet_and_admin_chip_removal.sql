-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815153506 "cashout_credits_agent_wallet_and_admin_chip_removal"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 84b10ce3bcf94d7889366d9a98c9a064 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- CHIP-REMOVAL AUTHORITY POLICY (Dan, 2026-08-15)
--   1. Agent may never remove chips from a downline except via player cashout.
--   2. Cashout REQUEST escrows chips immediately (already in fn_request_cashout).
--   3. Agent ACCEPT moves the chips to the AGENT (was: clubs.chip_treasury).
--   4. Club OWNER/ADMIN may pull chips from anyone at any time (new function).

CREATE OR REPLACE FUNCTION public.fn_approve_cashout_atomic(
  p_cashout_id uuid,
  p_agent_id uuid,
  p_agent_note text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_cashout record;
  v_agent_after numeric;
BEGIN
  SELECT * INTO v_cashout FROM cashout_requests WHERE id = p_cashout_id FOR UPDATE;
  IF v_cashout IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not found');
  END IF;

  IF v_cashout.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not in pending status',
                              'current_status', v_cashout.status);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM club_members
     WHERE club_id = v_cashout.club_id
       AND user_id = p_agent_id
       AND role IN ('agent','super_agent','owner','co_owner','admin')
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to approve for this club');
  END IF;

  UPDATE club_members
     SET chip_balance = COALESCE(chip_balance, 0) + v_cashout.amount::integer,
         updated_at = NOW()
   WHERE club_id = v_cashout.club_id AND user_id = p_agent_id
  RETURNING chip_balance INTO v_agent_after;

  IF v_agent_after IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'approving agent has no member row in this club');
  END IF;

  UPDATE cashout_requests
     SET status = 'approved',
         agent_note = COALESCE(p_agent_note, agent_note),
         updated_at = NOW(),
         acknowledged_at = NOW()
   WHERE id = p_cashout_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, related_cashout_id, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_cashout.club_id, v_cashout.player_id, p_agent_id, v_cashout.amount,
    'cashout_approved',
    COALESCE(p_agent_note, 'Cashout approved; escrowed chips transferred to agent'),
    p_cashout_id, v_agent_after, NOW()
  );

  RETURN jsonb_build_object('success', true, 'cashout_id', p_cashout_id,
                            'amount', v_cashout.amount, 'agent_balance_after', v_agent_after);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_admin_remove_player_chips(
  p_club_id uuid,
  p_player_id uuid,
  p_amount numeric,
  p_reason text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_actor uuid;
  v_actor_role text;
  v_before numeric;
  v_after numeric;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'actor identity required');
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT role INTO v_actor_role
    FROM club_members
   WHERE club_id = p_club_id AND user_id = v_actor
     AND status IN ('active','approved');

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('owner','co_owner','admin') THEN
    RETURN jsonb_build_object('success', false,
      'error', 'only a club owner or admin may remove chips; agents must use the cashout flow');
  END IF;

  SELECT chip_balance INTO v_before
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_player_id FOR UPDATE;

  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'player is not a member of this club');
  END IF;

  IF v_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient chips',
                              'balance', v_before, 'requested', p_amount);
  END IF;

  UPDATE club_members
     SET chip_balance = chip_balance - p_amount::integer, updated_at = NOW()
   WHERE club_id = p_club_id AND user_id = p_player_id
  RETURNING chip_balance INTO v_after;

  UPDATE clubs
     SET chip_pool = COALESCE(chip_pool, 0) + p_amount, updated_at = NOW()
   WHERE id = p_club_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_player_id, NULL, p_amount,
    'admin_removal', COALESCE(p_reason, 'Chips removed by club admin'),
    v_after, NOW()
  );

  RETURN jsonb_build_object('success', true, 'removed', p_amount,
                            'balance_before', v_before, 'balance_after', v_after);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_admin_remove_player_chips(uuid, uuid, numeric, text)
  TO authenticated, service_role;
