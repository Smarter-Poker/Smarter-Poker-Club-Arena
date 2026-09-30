-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724052112 "tourney_audit_sweep4_rebuy_window_enforcement"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fc26b7a2836f566e0ef3ab02dee17bf5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- TOURNEY-AUDIT SWEEP 4 (2026-07-24): server-side rebuy/add-on/re-entry
-- window enforcement in process_tournament_rebuy.
--
-- The RPC previously enforced NOTHING beyond wallet balance and registration:
-- no tournament-status check, no level-window check, no stack-limit check, no
-- one-add-on limit, no player-status check. All gating lived in the CLIENT
-- (canRebuy/canAddOn), whose level clock drifts from the server and which can
-- be bypassed by calling the RPC directly — i.e. buy chips at any moment of
-- any tournament, including after the rebuy period closed or while sitting on
-- a huge stack. Rules now enforced atomically server-side:
--   * tournament must be RUNNING
--   * rebuy:   level < cap, player 'playing', chips <= starting_chips
--   * reentry: level < cap, player 'eliminated'
--   * addon:   cap <= level < cap + addon_levels, player 'playing', one per player
--   (cap = COALESCE(late_reg_levels, rebuy_levels, 8))

CREATE OR REPLACE FUNCTION public.process_tournament_rebuy(
  p_tournament_id uuid, p_user_id uuid, p_rebuy_type text,
  p_cost numeric, p_chips numeric, p_current_level integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_balance numeric;
  v_new_chips integer;
  v_add integer := COALESCE(p_chips, 0)::integer;
  v_t record;
  v_p record;
  v_cap integer;
  v_addon_window integer;
  v_level integer;
BEGIN
  IF p_cost IS NULL OR p_cost < 0 THEN
    RAISE EXCEPTION 'Invalid rebuy cost';
  END IF;
  IF p_rebuy_type NOT IN ('rebuy','reentry','addon') THEN
    RAISE EXCEPTION 'Invalid rebuy type: %', p_rebuy_type;
  END IF;

  SELECT status, current_level, late_reg_levels, rebuy_levels, addon_levels,
         starting_chips
    INTO v_t
    FROM tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tournament not found';
  END IF;
  IF v_t.status <> 'RUNNING' THEN
    RAISE EXCEPTION 'Tournament is not running (status %)', v_t.status;
  END IF;

  v_level := COALESCE(v_t.current_level, p_current_level, 0);
  v_cap := COALESCE(v_t.late_reg_levels, v_t.rebuy_levels, 8);
  v_addon_window := COALESCE(v_t.addon_levels, 1);

  SELECT status, chips, add_on INTO v_p
    FROM tournament_players
   WHERE tournament_id = p_tournament_id AND user_id = p_user_id
   ORDER BY registered_at DESC NULLS LAST
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Player not registered in this tournament';
  END IF;

  IF p_rebuy_type = 'rebuy' THEN
    IF v_level >= v_cap THEN
      RAISE EXCEPTION 'Rebuy period has ended (level % >= cap %)', v_level, v_cap;
    END IF;
    IF v_p.status NOT IN ('playing','registered') THEN
      RAISE EXCEPTION 'Only active players can rebuy (status %)', v_p.status;
    END IF;
    IF COALESCE(v_p.chips, 0) > COALESCE(v_t.starting_chips, 0) THEN
      RAISE EXCEPTION 'Stack too high for rebuy (% > starting %)', v_p.chips, v_t.starting_chips;
    END IF;
  ELSIF p_rebuy_type = 'reentry' THEN
    IF v_level >= v_cap THEN
      RAISE EXCEPTION 'Re-entry period has ended (level % >= cap %)', v_level, v_cap;
    END IF;
    IF v_p.status <> 'eliminated' THEN
      RAISE EXCEPTION 'Only eliminated players can re-enter (status %)', v_p.status;
    END IF;
  ELSE -- addon
    IF v_level < v_cap OR v_level >= v_cap + v_addon_window THEN
      RAISE EXCEPTION 'Add-on window is closed (level %, window % to %)', v_level, v_cap, v_cap + v_addon_window;
    END IF;
    IF v_p.status NOT IN ('playing','registered') THEN
      RAISE EXCEPTION 'Only active players can add on (status %)', v_p.status;
    END IF;
    IF COALESCE(v_p.add_on, false) THEN
      RAISE EXCEPTION 'Add-on already used';
    END IF;
  END IF;

  SELECT balance INTO v_balance FROM wallets
   WHERE user_id = p_user_id AND wallet_type = 'PLAYER' FOR UPDATE;
  IF v_balance IS NULL OR v_balance < p_cost THEN
    RAISE EXCEPTION 'Insufficient chips for rebuy';
  END IF;
  UPDATE wallets SET balance = balance - p_cost, updated_at = NOW()
   WHERE user_id = p_user_id AND wallet_type = 'PLAYER';

  IF p_rebuy_type = 'reentry' THEN
    UPDATE tournament_players
       SET chips = v_add, status = 'playing', eliminated_at = NULL,
           rebuys = COALESCE(rebuys, 0) + 1
     WHERE tournament_id = p_tournament_id AND user_id = p_user_id
     RETURNING chips INTO v_new_chips;
  ELSIF p_rebuy_type = 'addon' THEN
    UPDATE tournament_players
       SET chips = COALESCE(chips, 0) + v_add, add_on = true
     WHERE tournament_id = p_tournament_id AND user_id = p_user_id
     RETURNING chips INTO v_new_chips;
  ELSE
    UPDATE tournament_players
       SET chips = COALESCE(chips, 0) + v_add, status = 'playing',
           rebuys = COALESCE(rebuys, 0) + 1
     WHERE tournament_id = p_tournament_id AND user_id = p_user_id
     RETURNING chips INTO v_new_chips;
  END IF;

  INSERT INTO wallet_transactions
    (user_id, wallet_type, type, amount, category, description, related_entity_id, balance_after)
    VALUES (p_user_id, 'PLAYER', 'debit', -p_cost, p_rebuy_type,
            'Tournament ' || p_rebuy_type, p_tournament_id, v_balance - p_cost);

  RETURN jsonb_build_object('success', true, 'new_stack', v_new_chips, 'rebuy_type', p_rebuy_type);
END;
$function$;
