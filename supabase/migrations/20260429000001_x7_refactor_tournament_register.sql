-- ═══════════════════════════════════════════════════════════════════════════════
-- X7 — Refactor fn_tournament_atomic_register to use canonical `tournaments` table
-- Migration: 20260429000001_x7_refactor_tournament_register.sql
--
-- Why: §5 #6 of CLUB-ARENA-CANONICAL-ARCHITECTURE-2026-04-28.md
--   The RPC currently reads/writes `club_tournaments` (legacy schema).
--   The canonical table per Bible V8 §11 is `tournaments`.
--   Column mapping: club_tournaments.registered_count → tournaments.current_players
--
-- Semantics preserved:
--   - Tournament row lock (FOR UPDATE)
--   - Status check (scheduled / registering / running)
--   - Capacity check (max_players)
--   - Duplicate registration check (tournament_registrations)
--   - Membership verification + chip_balance lock (club_memberships)
--   - Chip debit (club_memberships.chip_balance)
--   - Registration insert (tournament_registrations)
--   - Counter + prize pool increment (now on `tournaments.current_players`)
--   - Audit chip_transaction insert
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_tournament_atomic_register(
  p_user_id       uuid,
  p_club_id       uuid,
  p_tournament_id uuid,
  p_buy_in        numeric
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_tourn record;
  v_balance numeric;
  v_existing uuid;
  v_display_name text;
  v_reg_id uuid;
  v_count integer;
BEGIN
  -- Lock the tournament row (canonical: tournaments table)
  SELECT * INTO v_tourn FROM tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF v_tourn.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tournament not found');
  END IF;

  IF v_tourn.status NOT IN ('scheduled', 'registering', 'running') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Registration not open');
  END IF;

  -- Capacity check (canonical column: current_players)
  IF v_tourn.max_players IS NOT NULL AND COALESCE(v_tourn.current_players, 0) >= v_tourn.max_players THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tournament full');
  END IF;

  -- No duplicate
  SELECT id INTO v_existing FROM tournament_registrations
    WHERE tournament_id = p_tournament_id AND user_id = p_user_id AND status = 'registered';
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Already registered');
  END IF;

  -- Verify membership and lock chip_balance
  SELECT COALESCE(chip_balance, 0) INTO v_balance
  FROM club_memberships
  WHERE club_id = p_club_id AND user_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not a member of this club');
  END IF;

  IF v_balance < p_buy_in THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient chips', 'balance', v_balance, 'required', p_buy_in);
  END IF;

  -- Debit chips
  UPDATE club_memberships
  SET chip_balance = chip_balance - p_buy_in::integer, updated_at = NOW()
  WHERE club_id = p_club_id AND user_id = p_user_id;

  -- Resolve display name
  SELECT COALESCE(display_name, username, 'Player') INTO v_display_name
  FROM profiles WHERE id = p_user_id;

  -- Create registration
  INSERT INTO tournament_registrations (
    id, tournament_id, user_id, status, registered_at, display_name
  ) VALUES (
    gen_random_uuid(), p_tournament_id, p_user_id, 'registered', NOW(),
    COALESCE(v_display_name, 'Player')
  ) RETURNING id INTO v_reg_id;

  -- Increment the tournament counter + prize pool (canonical: tournaments.current_players)
  UPDATE tournaments
  SET current_players = COALESCE(current_players, 0) + 1,
      prize_pool = COALESCE(prize_pool, 0) + p_buy_in,
      updated_at = NOW()
  WHERE id = p_tournament_id
  RETURNING COALESCE(current_players, 0) INTO v_count;

  -- Audit
  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_user_id, NULL, p_buy_in,
    'tournament_buyin', 'Tournament buy-in: ' || p_tournament_id::text,
    v_balance - p_buy_in, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'registration_id', v_reg_id,
    'registered_count', v_count,
    'balance_after', v_balance - p_buy_in
  );
END;
$function$;

COMMENT ON FUNCTION public.fn_tournament_atomic_register(uuid, uuid, uuid, numeric)
  IS 'X7 — refactored to write canonical tournaments table (not club_tournaments). Column: current_players replaces registered_count.';
