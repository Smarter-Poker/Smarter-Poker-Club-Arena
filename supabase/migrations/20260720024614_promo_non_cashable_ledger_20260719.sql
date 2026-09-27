-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260720024614 "promo_non_cashable_ledger_20260719"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9031d0fbad256cf89608678aed641063 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- FIX C-PROMO 2026-07-19 — route promo chips through the DEDICATED promo ledger
-- instead of the cashable chip_balance, closing the promo->cashable drain.
--
-- Before: transfer_promo_club_to_agent credited club_members.chip_balance
-- (cashable) and transfer_promo_agent_to_player delegated to the cashable
-- transfer_chips_agent_to_player. So an owner could mint_club_promo (mints
-- clubs.promo_balance from nothing — intended for marketing) and route it out as
-- real cashable chips -> cashout = free money.
--
-- After: promo moves clubs.promo_balance -> agent club_members.promo_balance ->
-- player club_members.promo_balance, tracking promo_received_total and a 3x
-- promo_playthrough_required (Bible V8 §promo). Promo now lives in promo_balance,
-- which cashout (which cashes chip_balance) does NOT touch. NOTE: a follow-up in
-- the engine must let players PLAY with promo_balance and convert it to cashable
-- chip_balance only once promo_wagered >= promo_playthrough_required. Until that
-- lands, promo sits as a non-cashable balance (safe: no drain), which is strictly
-- better than the prior cashable-promo behavior.

CREATE OR REPLACE FUNCTION public.transfer_promo_club_to_agent(
  p_club_id uuid, p_agent_user_id uuid, p_amount numeric, p_note text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_before numeric;
  v_club_after  numeric;
  v_agent_role  text;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  SELECT role INTO v_agent_role FROM club_memberships
   WHERE club_id = p_club_id AND user_id = p_agent_user_id;
  IF v_agent_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent is not a member of this club');
  END IF;

  SELECT COALESCE(promo_balance, 0) INTO v_club_before
    FROM clubs WHERE id = p_club_id FOR UPDATE;
  IF v_club_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_club_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient promo balance',
                              'balance', v_club_before, 'requested', p_amount);
  END IF;

  UPDATE clubs SET promo_balance = promo_balance - p_amount, updated_at = NOW()
   WHERE id = p_club_id;
  v_club_after := v_club_before - p_amount;

  -- Credit the agent's PROMO balance (NOT chip_balance — promo is non-cashable).
  UPDATE club_members
     SET promo_balance = COALESCE(promo_balance, 0) + p_amount,
         updated_at = NOW()
   WHERE club_id = p_club_id AND user_id = p_agent_user_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, NULL, p_agent_user_id, p_amount,
    'promo_club_to_agent', COALESCE(p_note, 'Promo transfer club->agent (promo ledger)'),
    v_club_after, NOW()
  );

  RETURN jsonb_build_object('success', true, 'amount', p_amount,
                            'club_promo_before', v_club_before, 'club_promo_after', v_club_after);
END;
$function$;

CREATE OR REPLACE FUNCTION public.transfer_promo_agent_to_player(
  p_club_id uuid, p_agent_user_id uuid, p_player_user_id uuid, p_amount numeric, p_note text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_agent_before numeric;
  v_playthrough_mult numeric := 3;  -- Bible V8: 3x playthrough before promo converts to cashable
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  -- Lock + debit the agent's PROMO balance (not chip_balance).
  SELECT COALESCE(promo_balance, 0) INTO v_agent_before
    FROM club_members WHERE club_id = p_club_id AND user_id = p_agent_user_id FOR UPDATE;
  IF v_agent_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent is not a member of this club');
  END IF;
  IF v_agent_before < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient agent promo balance',
                              'balance', v_agent_before, 'requested', p_amount);
  END IF;

  UPDATE club_members
     SET promo_balance = promo_balance - p_amount, updated_at = NOW()
   WHERE club_id = p_club_id AND user_id = p_agent_user_id;

  -- Credit the player's PROMO balance + set playthrough requirement.
  UPDATE club_members
     SET promo_balance = COALESCE(promo_balance, 0) + p_amount,
         promo_received_total = COALESCE(promo_received_total, 0) + p_amount,
         promo_playthrough_required = COALESCE(promo_playthrough_required, 0) + (p_amount * v_playthrough_mult),
         updated_at = NOW()
   WHERE club_id = p_club_id AND user_id = p_player_user_id;

  IF NOT FOUND THEN
    -- player not a member: roll back by re-crediting the agent (single txn would
    -- normally auto-rollback on RAISE; be explicit for clarity)
    RAISE EXCEPTION 'player is not a member of this club';
  END IF;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_agent_user_id, p_player_user_id, p_amount,
    'promo_agent_to_player', COALESCE(p_note, 'Promo grant agent->player (promo ledger, 3x playthrough)'),
    v_agent_before - p_amount, NOW()
  );

  RETURN jsonb_build_object('success', true, 'amount', p_amount,
                            'playthrough_required', p_amount * v_playthrough_mult);
END;
$function$;
