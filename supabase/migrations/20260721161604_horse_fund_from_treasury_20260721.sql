-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721161604 "horse_fund_from_treasury_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 75f4e237de3c2b1b8a4350f519ce3511 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Horse (AI) buy-ins/rebuys must be funded from the club's treasury
-- (clubs.chip_treasury — the club's bankroll), not minted from nothing. Horses
-- provide liquidity real players can win, so the chips must come from a real
-- account for conservation. Atomic: debit treasury + credit the horse's seat
-- stack + audit row, all-or-nothing; fails on insufficient treasury (the horse
-- then simply cannot rebuy, which is the correct conservation behavior).
CREATE OR REPLACE FUNCTION public.fn_horse_fund_from_treasury(
  p_table_id uuid,
  p_user_id uuid,
  p_amount numeric
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_club_id uuid;
  v_treasury numeric;
  v_new_stack numeric;
BEGIN
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user and positive amount required');
  END IF;

  SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  -- Lock + check the club treasury.
  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM clubs WHERE id = v_club_id FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury',
                              'treasury', v_treasury, 'needed', p_amount);
  END IF;

  -- Credit the horse's active seat first; abort if the seat is gone.
  UPDATE table_seats
  SET stack = COALESCE(stack, 0) + p_amount
  WHERE table_id = p_table_id AND user_id = p_user_id AND left_at IS NULL
  RETURNING stack INTO v_new_stack;

  IF v_new_stack IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no active seat for user at table');
  END IF;

  -- Debit the treasury (only now that the seat credit succeeded).
  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount, updated_at = NOW()
  WHERE id = v_club_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club_id, NULL, p_user_id, p_amount,
    'horse_treasury_funding', 'Horse buy-in/rebuy funded from club treasury',
    v_treasury - p_amount, NOW()
  );

  RETURN jsonb_build_object('success', true, 'new_stack', v_new_stack,
                            'treasury_after', v_treasury - p_amount);
END;
$function$;

DO $$
DECLARE r jsonb;
BEGIN
  SELECT fn_horse_fund_from_treasury(NULL, NULL, 0) INTO r;
  IF (r->>'success') <> 'false' THEN RAISE EXCEPTION 'guard failed: %', r; END IF;
END $$;
