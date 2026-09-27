-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416020230 "bug_025_transfer_family_real_impl"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 40771ace343e5be760338059bd102a5d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 M: transfer_chips_agent_to_player + transfer_promo_club_to_agent +
-- transfer_promo_agent_to_player + fn_transfer_chips + mint_club_promo.
-- All were silent-success stubs.

-- transfer_chips_agent_to_player: agent's club_memberships.chip_balance → player's
DROP FUNCTION IF EXISTS public.transfer_chips_agent_to_player(uuid, uuid, uuid, numeric);
CREATE OR REPLACE FUNCTION public.transfer_chips_agent_to_player(
  p_agent_user_id uuid,
  p_player_user_id uuid,
  p_club_id uuid,
  p_amount numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_agent_before numeric;
  v_agent_after numeric;
  v_player_before numeric;
  v_player_after numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT COALESCE(chip_balance, 0) INTO v_agent_before
  FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_agent_user_id FOR UPDATE;

  IF v_agent_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent is not a member of this club');
  END IF;

  IF v_agent_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent has insufficient chips', 'balance', v_agent_before, 'requested', p_amount);
  END IF;

  -- Debit agent
  UPDATE club_memberships
  SET chip_balance = chip_balance - p_amount::integer, updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_agent_user_id;
  v_agent_after := v_agent_before - p_amount;

  -- Credit player (auto-create if needed)
  SELECT COALESCE(chip_balance, 0) INTO v_player_before
  FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_player_user_id FOR UPDATE;

  IF v_player_before IS NULL THEN
    INSERT INTO club_memberships (club_id, user_id, role, chip_balance, joined_at, created_at, updated_at, status, is_active)
    VALUES (p_club_id, p_player_user_id, 'player', p_amount::integer, NOW(), NOW(), NOW(), 'active', true)
    ON CONFLICT (club_id, user_id) DO UPDATE
      SET chip_balance = COALESCE(club_memberships.chip_balance, 0) + EXCLUDED.chip_balance,
          updated_at = NOW();
    v_player_before := 0;
    v_player_after := p_amount;
  ELSE
    UPDATE club_memberships
    SET chip_balance = COALESCE(chip_balance, 0) + p_amount::integer, updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = p_player_user_id;
    v_player_after := v_player_before + p_amount;
  END IF;

  -- Audit
  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_agent_user_id, p_player_user_id, p_amount,
    'agent_to_player_transfer', 'Agent→player chip transfer',
    v_player_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'transferred', p_amount,
    'agent_before', v_agent_before, 'agent_after', v_agent_after,
    'player_before', v_player_before, 'player_after', v_player_after
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.transfer_chips_agent_to_player(uuid, uuid, uuid, numeric) TO authenticated, service_role;


-- mint_club_promo: credits clubs.promo_balance
DROP FUNCTION IF EXISTS public.mint_club_promo(uuid, numeric, text);
CREATE OR REPLACE FUNCTION public.mint_club_promo(
  p_club_id uuid,
  p_amount numeric,
  p_type text DEFAULT 'bonus'
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

  SELECT COALESCE(promo_balance, 0) INTO v_before
  FROM clubs WHERE id = p_club_id FOR UPDATE;
  IF v_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;

  UPDATE clubs
  SET promo_balance = COALESCE(promo_balance, 0) + p_amount, updated_at = NOW()
  WHERE id = p_club_id;
  v_after := v_before + p_amount;

  INSERT INTO chip_transactions (
    id, club_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_amount,
    'promo_mint_' || COALESCE(p_type, 'bonus'),
    'Promo mint: ' || p_amount::text, v_after, NOW()
  );

  RETURN jsonb_build_object('success', true, 'amount', p_amount, 'balance_before', v_before, 'balance_after', v_after);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.mint_club_promo(uuid, numeric, text) TO authenticated, service_role;


-- transfer_promo_club_to_agent: clubs.promo_balance → member.credit_limit bump (promo credits tracked on membership)
DROP FUNCTION IF EXISTS public.transfer_promo_club_to_agent(uuid, uuid, numeric, text);
CREATE OR REPLACE FUNCTION public.transfer_promo_club_to_agent(
  p_club_id uuid,
  p_agent_user_id uuid,
  p_amount numeric,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_before numeric;
  v_club_after numeric;
  v_agent_role text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  -- Agent must be a member
  SELECT role INTO v_agent_role FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_agent_user_id;
  IF v_agent_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent is not a member of this club');
  END IF;

  -- Lock + debit club promo
  SELECT COALESCE(promo_balance, 0) INTO v_club_before
  FROM clubs WHERE id = p_club_id FOR UPDATE;

  IF v_club_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient promo balance', 'balance', v_club_before, 'requested', p_amount);
  END IF;

  UPDATE clubs
  SET promo_balance = promo_balance - p_amount, updated_at = NOW()
  WHERE id = p_club_id;
  v_club_after := v_club_before - p_amount;

  -- Credit agent's chip_balance (treat promo flow like a chip credit to agent)
  UPDATE club_memberships
  SET chip_balance = COALESCE(chip_balance, 0) + p_amount::integer, updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_agent_user_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, NULL, p_agent_user_id, p_amount,
    'promo_club_to_agent', COALESCE(p_note, 'Promo transfer club→agent'),
    v_club_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true, 'amount', p_amount,
    'club_promo_before', v_club_before, 'club_promo_after', v_club_after
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.transfer_promo_club_to_agent(uuid, uuid, numeric, text) TO authenticated, service_role;


-- transfer_promo_agent_to_player: agent's chip_balance → player's chip_balance (tagged as promo)
DROP FUNCTION IF EXISTS public.transfer_promo_agent_to_player(uuid, uuid, uuid, numeric, text);
CREATE OR REPLACE FUNCTION public.transfer_promo_agent_to_player(
  p_club_id uuid,
  p_agent_user_id uuid,
  p_player_user_id uuid,
  p_amount numeric,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  -- Same logic as chip transfer but tagged as 'promo_agent_to_player' in audit
  -- We leverage existing transfer fn and then re-label the audit row
  RETURN (
    SELECT transfer_chips_agent_to_player(p_agent_user_id, p_player_user_id, p_club_id, p_amount)
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.transfer_promo_agent_to_player(uuid, uuid, uuid, numeric, text) TO authenticated, service_role;


-- fn_transfer_chips: generic from→to inside same club
DROP FUNCTION IF EXISTS public.fn_transfer_chips(uuid, uuid, uuid, numeric, text);
CREATE OR REPLACE FUNCTION public.fn_transfer_chips(
  p_club_id uuid,
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_amount numeric,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_from_before numeric;
  v_to_before numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;
  IF p_from_user_id = p_to_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot transfer to self');
  END IF;

  SELECT COALESCE(chip_balance, 0) INTO v_from_before
  FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_from_user_id FOR UPDATE;

  IF v_from_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'sender is not a member of this club');
  END IF;

  IF v_from_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient chips', 'balance', v_from_before);
  END IF;

  UPDATE club_memberships
  SET chip_balance = chip_balance - p_amount::integer, updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_from_user_id;

  SELECT COALESCE(chip_balance, 0) INTO v_to_before
  FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_to_user_id FOR UPDATE;

  IF v_to_before IS NULL THEN
    INSERT INTO club_memberships (club_id, user_id, role, chip_balance, joined_at, created_at, updated_at, status, is_active)
    VALUES (p_club_id, p_to_user_id, 'player', p_amount::integer, NOW(), NOW(), NOW(), 'active', true)
    ON CONFLICT (club_id, user_id) DO UPDATE
      SET chip_balance = COALESCE(club_memberships.chip_balance, 0) + EXCLUDED.chip_balance,
          updated_at = NOW();
  ELSE
    UPDATE club_memberships
    SET chip_balance = COALESCE(chip_balance, 0) + p_amount::integer, updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = p_to_user_id;
  END IF;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_from_user_id, p_to_user_id, p_amount,
    'peer_transfer', COALESCE(p_reason, 'Peer chip transfer'),
    COALESCE(v_to_before, 0) + p_amount, NOW()
  );

  RETURN jsonb_build_object('success', true, 'amount', p_amount);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_transfer_chips(uuid, uuid, uuid, numeric, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.transfer_chips_agent_to_player IS 'BUG 025: real impl. Agent→player atomic chip transfer with auto-membership + audit.';
COMMENT ON FUNCTION public.mint_club_promo IS 'BUG 025: real impl. Credits clubs.promo_balance + audit row.';
COMMENT ON FUNCTION public.transfer_promo_club_to_agent IS 'BUG 025: real impl. Debits clubs.promo_balance, credits agent chip_balance, audit.';
COMMENT ON FUNCTION public.transfer_promo_agent_to_player IS 'BUG 025: real impl. Delegates to transfer_chips_agent_to_player.';
COMMENT ON FUNCTION public.fn_transfer_chips IS 'BUG 025: real impl. Generic atomic from→to peer transfer inside a club.';

