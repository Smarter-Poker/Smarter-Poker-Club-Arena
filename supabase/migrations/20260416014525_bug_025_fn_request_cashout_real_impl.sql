-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416014525 "bug_025_fn_request_cashout_real_impl"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3f29759208e26dcdebd10b2cb74dc98c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 B: fn_request_cashout was a silent-success stub returning a random UUID
-- without creating a cashout_requests row or locking escrow. Players clicked
-- "Request Cashout", saw "success", and nothing happened. Restoring real logic.
DROP FUNCTION IF EXISTS public.fn_request_cashout(uuid, uuid, uuid, numeric, text, text);

CREATE OR REPLACE FUNCTION public.fn_request_cashout(
  p_player_id uuid,
  p_club_id uuid,
  p_amount numeric,
  p_note text DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL,
  p_type text DEFAULT 'request'
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_cashout_id uuid;
  v_resolved_agent_id uuid;
  v_player_balance integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'cashout amount must be > 0';
  END IF;

  -- Resolve agent: argument first, then the player's agent in this club, then any club admin
  v_resolved_agent_id := p_agent_id;
  IF v_resolved_agent_id IS NULL THEN
    SELECT agent_id INTO v_resolved_agent_id
    FROM club_memberships
    WHERE club_id = p_club_id AND user_id = p_player_id;
  END IF;

  IF v_resolved_agent_id IS NULL THEN
    SELECT user_id INTO v_resolved_agent_id
    FROM club_memberships
    WHERE club_id = p_club_id AND role IN ('owner', 'co_owner', 'agent', 'super_agent')
    ORDER BY CASE role
      WHEN 'owner' THEN 1
      WHEN 'co_owner' THEN 2
      WHEN 'super_agent' THEN 3
      WHEN 'agent' THEN 4
    END
    LIMIT 1;
  END IF;

  IF v_resolved_agent_id IS NULL THEN
    RAISE EXCEPTION 'no agent/owner available to approve cashout in club %', p_club_id;
  END IF;

  -- Check player's chip balance in this club and lock it
  SELECT chip_balance INTO v_player_balance
  FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_player_id FOR UPDATE;

  IF v_player_balance IS NULL THEN
    RAISE EXCEPTION 'player is not a member of this club';
  END IF;

  IF v_player_balance < p_amount THEN
    RAISE EXCEPTION 'insufficient chips: have %, requested %', v_player_balance, p_amount;
  END IF;

  -- Lock chips in escrow (debit member balance)
  UPDATE club_memberships
  SET chip_balance = chip_balance - p_amount::integer,
      updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_player_id;

  -- Create the cashout request
  INSERT INTO cashout_requests (
    id, club_id, player_id, agent_id, amount,
    status, player_note, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_player_id, v_resolved_agent_id, p_amount,
    'pending', p_note, NOW(), NOW()
  ) RETURNING id INTO v_cashout_id;

  -- Audit log
  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, related_cashout_id, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_player_id, v_resolved_agent_id, p_amount,
    'cashout_request_escrow', COALESCE(p_note, 'Cashout requested - chips in escrow'),
    v_cashout_id, 0, NOW()
  );

  RETURN v_cashout_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.fn_request_cashout(uuid, uuid, numeric, text, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_request_cashout IS
'BUG 025: real implementation replacing silent-success stub. Atomically debits player chips, resolves agent, inserts cashout_requests with status=pending, writes chip_transactions escrow row. Returns new cashout UUID.';

