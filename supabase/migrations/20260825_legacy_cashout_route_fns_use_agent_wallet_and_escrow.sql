-- ═══════════════════════════════════════════════════════════════════════════
--  THE OTHER DOOR INTO THE SAME FLOW (2026-08-25)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 20260825_role_scoped_cashier_agent_wallet_and_cashout_escrow.sql gave Club
-- Arena a cash out flow that a signed in browser can drive directly:
-- fn_cashout_request / fn_cashout_approve / fn_cashout_release.
--
-- It is not the only door. World Hub still serves three service-role API routes
-- built for the old client, and one of its own pages still uses them:
--
--   pages/api/club-arena/request-cashout.js    -> fn_request_cashout
--   pages/api/club-arena/approve-cashout.js    -> fn_approve_cashout_atomic
--                                              -> fn_cancel_cashout_atomic
--   pages/api/club-arena/cancel-my-cashout.js  -> fn_cancel_cashout_atomic
--   pages/horses/index.js:907 calls approve-cashout
--
-- Two doors into one flow is fine. Two doors that produce INCOMPATIBLE STATE is
-- not, and that is what these three functions did:
--
--   1. fn_approve_cashout_atomic credited the approving agent's
--      club_members.chip_balance - their PLAYER wallet. Dan 2026-08-25: "Once
--      approved the chips go into the agent's wallet." An agent who accepted a
--      cash out found the chips in the account they buy in from.
--
--   2. fn_request_cashout debited the player and opened the request but never
--      wrote the chip_escrow hold, so that table was empty for every request
--      the route created and "held in escrow" was a sentence in the UI rather
--      than a row anywhere. fn_cashout_approve REQUIRES the hold before it will
--      release anything, so a request made through the route could not be
--      accepted through the app.
--
--   3. neither approve nor cancel ever released a hold, so any escrow row that
--      did exist stayed open forever after the request was settled.
--
-- Refusing these outright was the other option and it was rejected: a live
-- World Hub page calls one of them, and breaking a working surface to make a
-- point is not a fix. They now write the SAME accounts and the SAME rows as the
-- app's own path, so it no longer matters which door was used.
--
-- What they still do NOT get is auth.uid(): they are SECURITY INVOKER, reached
-- only with the service role key, and the route is what authenticates the
-- caller. That is unchanged and deliberate.

create or replace function public.fn_request_cashout(
  p_player_id uuid,
  p_club_id uuid,
  p_amount numeric,
  p_note text default null,
  p_agent_id uuid default null,
  p_type text default 'request'
) returns uuid
language plpgsql
set search_path to 'public', 'extensions'
as $function$
DECLARE
  v_cashout_id uuid;
  v_resolved_agent_id uuid;
  v_player_balance numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'cashout amount must be > 0';
  END IF;

  v_resolved_agent_id := p_agent_id;
  IF v_resolved_agent_id IS NULL THEN
    SELECT agent_id INTO v_resolved_agent_id
    FROM club_members
    WHERE club_id = p_club_id AND user_id = p_player_id;
  END IF;

  IF v_resolved_agent_id IS NULL THEN
    SELECT owner_id INTO v_resolved_agent_id FROM clubs WHERE id = p_club_id;
  END IF;

  IF v_resolved_agent_id IS NULL THEN
    SELECT user_id INTO v_resolved_agent_id
    FROM club_members
    WHERE club_id = p_club_id AND role IN ('owner', 'co_owner', 'admin', 'super_agent', 'agent')
    ORDER BY CASE role
      WHEN 'owner' THEN 1 WHEN 'co_owner' THEN 2 WHEN 'admin' THEN 3
      WHEN 'super_agent' THEN 4 ELSE 5 END
    LIMIT 1;
  END IF;

  IF v_resolved_agent_id IS NULL THEN
    RAISE EXCEPTION 'no agent/owner available to approve cashout in club %', p_club_id;
  END IF;

  SELECT chip_balance INTO v_player_balance
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_player_id FOR UPDATE;

  IF v_player_balance IS NULL THEN
    RAISE EXCEPTION 'player is not a member of this club';
  END IF;

  IF v_player_balance < p_amount THEN
    RAISE EXCEPTION 'insufficient chips: have %, requested %', v_player_balance, p_amount;
  END IF;

  UPDATE club_members
  SET chip_balance = COALESCE(chip_balance, 0) - p_amount,
      updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_player_id;

  INSERT INTO cashout_requests (
    id, club_id, player_id, agent_id, amount,
    status, player_note, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_player_id, v_resolved_agent_id, p_amount,
    'pending', p_note, NOW(), NOW()
  ) RETURNING id INTO v_cashout_id;

  -- THE HOLD. Fault 2 above: this row was never written, so chip_escrow was
  -- empty for every request this door created.
  INSERT INTO chip_escrow (cashout_request_id, player_id, amount, club_id, locked_at)
  VALUES (v_cashout_id, p_player_id, p_amount, p_club_id, NOW())
  ON CONFLICT (cashout_request_id) DO NOTHING;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, related_cashout_id, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_player_id, v_resolved_agent_id, p_amount,
    'cashout_request_escrow', COALESCE(p_note, 'Cash Out Requested. Chips Held In Escrow'),
    v_cashout_id, v_player_balance - p_amount, NOW()
  );

  RETURN v_cashout_id;
END;
$function$;

create or replace function public.fn_approve_cashout_atomic(
  p_cashout_id uuid,
  p_agent_id uuid,
  p_agent_note text default null
) returns jsonb
language plpgsql
set search_path to 'public', 'extensions'
as $function$
DECLARE
  v_cashout record;
  v_escrow  record;
  v_role    text;
  v_agent_row uuid;
  v_after   numeric;
BEGIN
  SELECT * INTO v_cashout FROM cashout_requests WHERE id = p_cashout_id FOR UPDATE;
  IF v_cashout IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not found');
  END IF;

  IF v_cashout.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not in pending status',
                              'current_status', v_cashout.status);
  END IF;

  SELECT role INTO v_role
    FROM club_members
   WHERE club_id = v_cashout.club_id
     AND user_id = p_agent_id
     AND role IN ('agent','sub_agent','super_agent','owner','co_owner','admin');
  IF v_role IS NULL AND EXISTS (
       SELECT 1 FROM clubs WHERE id = v_cashout.club_id AND owner_id = p_agent_id) THEN
    v_role := 'owner';
  END IF;
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized to approve for this club');
  END IF;

  -- Release the hold if there is one. A request created before this migration
  -- has no chip_escrow row but its chips WERE debited, so a missing hold is
  -- legacy rather than fraud; an ALREADY RELEASED hold is neither, and stops
  -- here rather than paying the agent a second time.
  SELECT * INTO v_escrow FROM chip_escrow WHERE cashout_request_id = p_cashout_id FOR UPDATE;
  IF v_escrow.id IS NOT NULL AND v_escrow.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'those chips have already been released');
  END IF;

  -- THE AGENT WALLET, not the approver's playing balance. Fault 1 above.
  SELECT id INTO v_agent_row
    FROM agents WHERE club_id = v_cashout.club_id AND user_id = p_agent_id FOR UPDATE;
  IF v_agent_row IS NULL THEN
    INSERT INTO agents (user_id, club_id, role, status, agent_wallet_balance, promo_wallet_balance)
    VALUES (p_agent_id, v_cashout.club_id, v_role, 'active', 0, 0)
    RETURNING id INTO v_agent_row;
  END IF;

  UPDATE agents
     SET agent_wallet_balance = COALESCE(agent_wallet_balance, 0) + v_cashout.amount,
         updated_at = NOW()
   WHERE id = v_agent_row
  RETURNING agent_wallet_balance INTO v_after;

  IF v_escrow.id IS NOT NULL THEN
    UPDATE chip_escrow SET released_at = NOW(), release_type = 'completed' WHERE id = v_escrow.id;
  END IF;

  UPDATE cashout_requests
     SET status = 'approved',
         agent_note = COALESCE(p_agent_note, agent_note),
         updated_at = NOW(),
         acknowledged_at = NOW(),
         completed_at = NOW()
   WHERE id = p_cashout_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, related_cashout_id, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_cashout.club_id, v_cashout.player_id, p_agent_id, v_cashout.amount,
    'cashout_approved',
    COALESCE(p_agent_note, 'Cash Out Approved. Escrow Released Into The Agent Wallet'),
    p_cashout_id, v_after, NOW()
  );

  INSERT INTO notifications (user_id, type, title, message, metadata, actor_id)
  VALUES (v_cashout.player_id, 'settlement', 'Cash Out Approved',
          'Your Cash Out Of ' || trim(to_char(v_cashout.amount, 'FM999,999,999,990'))
            || ' Chips Was Approved',
          jsonb_build_object('clubId', v_cashout.club_id, 'cashoutId', p_cashout_id,
                             'amount', v_cashout.amount),
          p_agent_id);

  RETURN jsonb_build_object('success', true, 'cashout_id', p_cashout_id,
                            'amount', v_cashout.amount, 'agent_wallet_after', v_after);
END;
$function$;

create or replace function public.fn_cancel_cashout_atomic(
  p_cashout_id uuid,
  p_user_id uuid,
  p_is_agent boolean default false,
  p_note text default null
) returns jsonb
language plpgsql
set search_path to 'public', 'extensions'
as $function$
DECLARE
  v_cashout record;
  v_escrow  record;
  v_new_balance numeric;
BEGIN
  SELECT * INTO v_cashout FROM cashout_requests WHERE id = p_cashout_id FOR UPDATE;

  IF v_cashout IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not found');
  END IF;

  IF v_cashout.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'cashout not in pending status',
                              'current_status', v_cashout.status);
  END IF;

  IF p_is_agent THEN
    IF NOT EXISTS (
      SELECT 1 FROM club_members
      WHERE club_id = v_cashout.club_id
        AND user_id = p_user_id
        AND role IN ('agent', 'sub_agent', 'super_agent', 'owner', 'co_owner', 'admin')
    ) AND NOT EXISTS (
      SELECT 1 FROM clubs WHERE id = v_cashout.club_id AND owner_id = p_user_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error', 'not authorized to cancel for this club');
    END IF;
  ELSE
    IF v_cashout.player_id <> p_user_id THEN
      RETURN jsonb_build_object('success', false, 'error', 'only the requester can self-cancel');
    END IF;
  END IF;

  SELECT * INTO v_escrow FROM chip_escrow WHERE cashout_request_id = p_cashout_id FOR UPDATE;
  IF v_escrow.id IS NOT NULL AND v_escrow.released_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'those chips have already been released');
  END IF;

  UPDATE club_members
  SET chip_balance = COALESCE(chip_balance, 0) + v_cashout.amount,
      updated_at = NOW()
  WHERE club_id = v_cashout.club_id AND user_id = v_cashout.player_id
  RETURNING chip_balance INTO v_new_balance;

  IF v_new_balance IS NULL THEN
    -- Membership gone while chips of theirs sat in escrow: putting the row back
    -- is the only way the chips are not simply lost.
    INSERT INTO club_members (club_id, user_id, role, chip_balance, joined_at, created_at, updated_at, status, is_active)
    VALUES (v_cashout.club_id, v_cashout.player_id, 'player', v_cashout.amount, NOW(), NOW(), NOW(), 'active', true)
    ON CONFLICT (club_id, user_id) DO UPDATE
      SET chip_balance = COALESCE(club_members.chip_balance, 0) + EXCLUDED.chip_balance,
          updated_at = NOW()
    RETURNING chip_balance INTO v_new_balance;
  END IF;

  IF v_escrow.id IS NOT NULL THEN
    UPDATE chip_escrow
       SET released_at = NOW(),
           release_type = CASE WHEN p_is_agent THEN 'rejected' ELSE 'cancelled' END
     WHERE id = v_escrow.id;
  END IF;

  UPDATE cashout_requests
  SET status = CASE WHEN p_is_agent THEN 'rejected' ELSE 'cancelled' END,
      agent_note = CASE WHEN p_is_agent THEN COALESCE(p_note, agent_note) ELSE agent_note END,
      player_note = CASE WHEN NOT p_is_agent THEN COALESCE(p_note, player_note) ELSE player_note END,
      cancelled_at = NOW(),
      updated_at = NOW()
  WHERE id = p_cashout_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, related_cashout_id, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_cashout.club_id, p_user_id, v_cashout.player_id, v_cashout.amount,
    CASE WHEN p_is_agent THEN 'cashout_denied' ELSE 'cashout_cancelled' END,
    COALESCE(p_note, 'Cash Out Closed. Chips Returned From Escrow'),
    p_cashout_id, v_new_balance, NOW()
  );

  IF p_is_agent THEN
    INSERT INTO notifications (user_id, type, title, message, metadata, actor_id)
    VALUES (v_cashout.player_id, 'settlement', 'Cash Out Declined',
            'Your Cash Out Of ' || trim(to_char(v_cashout.amount, 'FM999,999,999,990'))
              || ' Chips Was Declined And The Chips Are Back In Your Wallet',
            jsonb_build_object('clubId', v_cashout.club_id, 'cashoutId', p_cashout_id,
                               'amount', v_cashout.amount),
            p_user_id);
  END IF;

  RETURN jsonb_build_object('success', true, 'cashout_id', p_cashout_id,
                            'amount', v_cashout.amount, 'new_balance', v_new_balance);
END;
$function$;
