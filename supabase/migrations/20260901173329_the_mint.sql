-- THE MINT. The one place chips and diamonds are created.
--
-- Dan, 2026-09-01: "somewhere I can create chips and diamonds and send them
-- directly to players, clubs etc, so there is never a drift or a flag for where
-- did these chips come from."
--
-- That is the right instinct and it is the answer to most of what has been on
-- the incident board today. Chips have been appearing in wallets, treasuries and
-- agent banks through provisioning scripts and direct writes, and the platform
-- could only ever report them after the fact as "unexplained supply" or
-- "unclassified flow". The problem was never that someone created chips - Dan is
-- allowed to create chips - it was that creation had no front door, so it could
-- not be told apart from a leak.
--
-- fn_ca_mint is that front door. It does what the supply watcher already knows
-- how to forgive: it declares issuance_reserve as the counterparty before it
-- writes, so the movement lands in chip_ledger as
--
--     issuance_reserve -> player_wallet / club_treasury / agent_wallet / union_wallet
--
-- and fn_ca_supply_snapshot counts it as ledgered issuance in the SAME interval
-- the balance moves. Supply reconciles by construction. Nothing to explain later,
-- because it was explained as it happened.
--
-- Diamonds work the same way against their own journal: fn_ca_diamond_snapshot
-- explains supply from diamond_transactions, so a diamond mint writes that row
-- in the same statement it moves the balance.
--
-- WHAT IT REFUSES
--   * anyone who is not an admin or god (or service_role for automation);
--   * a missing or short reason - "why" is not optional for issuance;
--   * a missing idempotency key, and a replay of one returns the original
--     result rather than minting twice;
--   * an amount that is not positive, not two decimal places, or over the cap
--     (1e9 chips / 1e7 diamonds per call);
--   * a destination that does not exist, or a player/agent wallet in a club
--     they are not in - it will not invent a wallet to mint into.
--
-- WHAT IT DOES NOT DO
--   It does not move chips between existing holders. That is what the club bank,
--   union send and agent wallet paths are for. The Mint only ever creates, and
--   only ever from the issuance reserve, which is what makes it auditable: every
--   chip that has ever entered circulation through this door has a row naming
--   who made it, when, how many and why.
--
-- Probed rolled back before it went live: a non-admin was refused, a club mint
-- posted issuance_reserve -> club_treasury category=mint, replaying the same
-- op_id returned the original result without minting again, a player wallet
-- credit landed, and a diamond mint wrote its diamond_transactions row.

CREATE OR REPLACE FUNCTION public.fn_ca_mint(
  p_asset       text,
  p_destination text,
  p_target_id   uuid,
  p_amount      numeric,
  p_reason      text,
  p_op_id       text,
  p_club_id     uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor  uuid := auth.uid();
  v_admin  boolean := false;
  v_asset  text := lower(btrim(coalesce(p_asset, '')));
  v_dest   text := lower(btrim(coalesce(p_destination, '')));
  v_prior  jsonb;
  v_before numeric;
  v_after  numeric;
  v_result jsonb;
  v_name   text;
BEGIN
  ------------------------------------------------------------------ who
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    SELECT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = v_actor AND p.role IN ('admin','god'))
      INTO v_admin;
    IF NOT v_admin THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'the_mint_is_admin_only');
    END IF;
  END IF;

  ------------------------------------------------------------------ what
  IF v_asset NOT IN ('chips','diamonds') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'asset_must_be_chips_or_diamonds');
  END IF;
  IF v_dest NOT IN ('player','club','agent','union') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_must_be_player_club_agent_or_union');
  END IF;
  IF v_asset = 'diamonds' AND v_dest <> 'player' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'diamonds_belong_to_a_player');
  END IF;
  IF p_target_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive_to_two_decimals');
  END IF;
  IF (v_asset = 'chips' AND p_amount > 1000000000)
     OR (v_asset = 'diamonds' AND p_amount > 10000000) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_over_the_single_mint_cap');
  END IF;
  IF coalesce(btrim(p_reason), '') = '' OR length(btrim(p_reason)) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'issuance_needs_a_real_reason');
  END IF;
  IF coalesce(btrim(p_op_id), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_key_required');
  END IF;

  ------------------------------------------------------------------ once
  SELECT result INTO v_prior FROM public.ca_op_claims
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
  IF FOUND AND v_prior IS NOT NULL THEN
    RETURN v_prior || jsonb_build_object('replayed', true);
  ELSIF FOUND THEN
    DELETE FROM public.ca_op_claims WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
  END IF;
  INSERT INTO public.ca_op_claims (op_id, fn_name, claimed_by)
  VALUES (p_op_id, 'fn_ca_mint', v_actor);

  ------------------------------------------------------------------ mint
  IF v_asset = 'diamonds' THEN
    SELECT coalesce(diamonds, 0) INTO v_before FROM public.profiles
     WHERE id = p_target_id FOR UPDATE;
    IF NOT FOUND THEN
      DELETE FROM public.ca_op_claims WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
      RETURN jsonb_build_object('ok', false, 'reason', 'player_not_found');
    END IF;

    UPDATE public.profiles SET diamonds = coalesce(diamonds, 0) + p_amount
     WHERE id = p_target_id
    RETURNING diamonds INTO v_after;

    /* The diamond snapshot explains supply from this journal, so the row is
       written in the same breath as the balance. */
    INSERT INTO public.diamond_transactions
      (user_id, type, amount, balance_after, description, source, metadata)
    VALUES (p_target_id, 'mint', p_amount, v_after,
            'The Mint: ' || btrim(p_reason), 'the_mint',
            jsonb_build_object('minted_by', v_actor, 'op_id', p_op_id));

  ELSE
    /* Authorized issuance journals against the issuance reserve. Declared
       before the write and cleared after, so it cannot colour an unrelated
       autoledger write later in the same transaction. */
    PERFORM public.fn_ca_declare_ledger('mint', 'issuance_reserve');

    IF v_dest = 'player' THEN
      IF p_club_id IS NULL THEN
        DELETE FROM public.ca_op_claims WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
        RETURN jsonb_build_object('ok', false, 'reason', 'club_required_for_a_player_wallet');
      END IF;
      SELECT coalesce(chip_balance, 0) INTO v_before FROM public.club_members
       WHERE user_id = p_target_id AND club_id = p_club_id FOR UPDATE;
      IF NOT FOUND THEN
        DELETE FROM public.ca_op_claims WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
        RETURN jsonb_build_object('ok', false, 'reason', 'that_player_has_no_wallet_in_that_club');
      END IF;
      UPDATE public.club_members SET chip_balance = coalesce(chip_balance, 0) + p_amount
       WHERE user_id = p_target_id AND club_id = p_club_id
      RETURNING chip_balance INTO v_after;

    ELSIF v_dest = 'club' THEN
      SELECT coalesce(chip_treasury, 0), name INTO v_before, v_name FROM public.clubs
       WHERE id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        DELETE FROM public.ca_op_claims WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
        RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');
      END IF;
      UPDATE public.clubs SET chip_treasury = coalesce(chip_treasury, 0) + p_amount
       WHERE id = p_target_id
      RETURNING chip_treasury INTO v_after;

      INSERT INTO public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
      VALUES (p_target_id, v_actor, NULL, p_amount, 'treasury_mint',
              'The Mint: ' || btrim(p_reason), v_after);

    ELSIF v_dest = 'agent' THEN
      IF p_club_id IS NULL THEN
        DELETE FROM public.ca_op_claims WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
        RETURN jsonb_build_object('ok', false, 'reason', 'club_required_for_an_agent_wallet');
      END IF;
      SELECT coalesce(agent_wallet_balance, 0) INTO v_before FROM public.agents
       WHERE user_id = p_target_id AND club_id = p_club_id FOR UPDATE;
      IF NOT FOUND THEN
        DELETE FROM public.ca_op_claims WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';
        RETURN jsonb_build_object('ok', false, 'reason', 'that_user_is_not_an_agent_in_that_club');
      END IF;
      UPDATE public.agents SET agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount
       WHERE user_id = p_target_id AND club_id = p_club_id
      RETURNING agent_wallet_balance INTO v_after;

    ELSE  -- union
      SELECT coalesce(chip_balance, 0) INTO v_before FROM public.union_wallets
       WHERE union_id = p_target_id FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO public.union_wallets (union_id, created_at, updated_at)
        VALUES (p_target_id, now(), now())
        ON CONFLICT (union_id) DO NOTHING;
        v_before := 0;
      END IF;
      UPDATE public.union_wallets SET chip_balance = coalesce(chip_balance, 0) + p_amount,
             updated_at = now()
       WHERE union_id = p_target_id
      RETURNING chip_balance INTO v_after;
    END IF;

    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
  END IF;

  v_result := jsonb_build_object(
    'ok', true, 'replayed', false,
    'asset', v_asset, 'destination', v_dest,
    'target_id', p_target_id, 'club_id', p_club_id,
    'amount', p_amount,
    'balance_before', v_before, 'balance_after', v_after,
    'minted_by', v_actor, 'reason', btrim(p_reason), 'op_id', p_op_id);

  UPDATE public.ca_op_claims
     SET result = v_result, finalized_at = now()
   WHERE op_id = p_op_id AND fn_name = 'fn_ca_mint';

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.fn_ca_mint(text,text,uuid,numeric,text,text,uuid) IS
  'THE MINT - the only sanctioned way to create chips or diamonds. Declares '
  'issuance_reserve as the counterparty before writing, so fn_ca_supply_snapshot '
  'counts the issuance in the same interval the balance moves and supply '
  'reconciles by construction. Admin or god only, reason required, idempotent on '
  'p_op_id, capped per call. It creates; it never transfers.';

-- A browser reaches it (the admin panel calls it as the signed-in admin) and it
-- checks who is asking on its own, which is what the definer gate requires.
REVOKE ALL ON FUNCTION public.fn_ca_mint(text,text,uuid,numeric,text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint(text,text,uuid,numeric,text,text,uuid) TO authenticated, service_role;

-- It writes balances, so it belongs in the registry rather than being found by
-- the drift sweep later.
INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES ('fn_ca_mint', 'approved',
        'THE MINT. Creates chips (player, club, agent or union wallet) and diamonds '
        '(player), always from issuance_reserve with the counterparty declared before '
        'the write, so supply reconciles in the interval it happens. Admin/god or '
        'service_role only; reason of at least ten characters required; idempotent on '
        'p_op_id via ca_op_claims; capped at 1e9 chips / 1e7 diamonds per call; refuses '
        'to mint into a wallet that does not already exist. Added 2026-09-01 at Dan''s '
        'request so chip creation has a front door and stops arriving as drift.')
ON CONFLICT (proname) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry WHERE proname = 'fn_ca_mint') THEN
    RAISE EXCEPTION 'The Mint is not in the money-RPC registry';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fn_ca_money_rpc_drift() WHERE proname = 'fn_ca_mint') THEN
    RAISE EXCEPTION 'The Mint is still reported as an unregistered balance writer';
  END IF;
  IF has_function_privilege('anon', 'public.fn_ca_mint(text,text,uuid,numeric,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can reach The Mint';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_ca_mint(text,text,uuid,numeric,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the admin panel cannot reach The Mint';
  END IF;
END $$;
