-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260416020125 "bug_025_tournament_register_unregister_real_impl"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bc4c96ed71cd48c94edc3cd5b63798a0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG 025 L: fn_tournament_atomic_register / fn_tournament_unregister_counter
-- were silent-success stubs. Every tournament registration returned success
-- without creating a tournament_registrations row or debiting the player's
-- chips. Implementing real logic (matches caller expectations in tournaments.js).

DROP FUNCTION IF EXISTS public.fn_tournament_atomic_register(uuid, uuid, uuid, numeric);
CREATE OR REPLACE FUNCTION public.fn_tournament_atomic_register(
  p_user_id uuid,
  p_club_id uuid,
  p_tournament_id uuid,
  p_buy_in numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_tourn record;
  v_balance numeric;
  v_existing uuid;
  v_display_name text;
  v_reg_id uuid;
  v_count integer;
BEGIN
  -- Lock the tournament row (club_tournaments is the primary entity)
  SELECT * INTO v_tourn FROM club_tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF v_tourn.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tournament not found');
  END IF;

  IF v_tourn.status NOT IN ('scheduled', 'registering', 'running') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Registration not open');
  END IF;

  -- Capacity
  IF v_tourn.max_players IS NOT NULL AND COALESCE(v_tourn.registered_count,0) >= v_tourn.max_players THEN
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

  -- Increment the tournament counter + prize pool
  UPDATE club_tournaments
  SET registered_count = COALESCE(registered_count, 0) + 1,
      prize_pool = COALESCE(prize_pool, 0) + p_buy_in,
      updated_at = NOW()
  WHERE id = p_tournament_id
  RETURNING COALESCE(registered_count, 0) INTO v_count;

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
GRANT EXECUTE ON FUNCTION public.fn_tournament_atomic_register(uuid, uuid, uuid, numeric) TO authenticated, service_role;


DROP FUNCTION IF EXISTS public.fn_tournament_unregister_counter(uuid, numeric);
CREATE OR REPLACE FUNCTION public.fn_tournament_unregister_counter(
  p_tournament_id uuid,
  p_buy_in numeric DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_count integer;
BEGIN
  UPDATE club_tournaments
  SET registered_count = GREATEST(COALESCE(registered_count, 0) - 1, 0),
      prize_pool = GREATEST(COALESCE(prize_pool, 0) - COALESCE(p_buy_in, 0), 0),
      updated_at = NOW()
  WHERE id = p_tournament_id
  RETURNING COALESCE(registered_count, 0) INTO v_count;

  IF v_count IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'tournament not found');
  END IF;

  RETURN jsonb_build_object('success', true, 'registered_count', v_count);
END;
$function$;
GRANT EXECUTE ON FUNCTION public.fn_tournament_unregister_counter(uuid, numeric) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_tournament_atomic_register IS 'BUG 025: real impl. Atomically validates capacity+membership+chips, debits buy-in, creates tournament_registrations row, bumps registered_count+prize_pool.';
COMMENT ON FUNCTION public.fn_tournament_unregister_counter IS 'BUG 025: real impl. Atomically decrements registered_count and subtracts buy-in from prize_pool (floor 0).';

