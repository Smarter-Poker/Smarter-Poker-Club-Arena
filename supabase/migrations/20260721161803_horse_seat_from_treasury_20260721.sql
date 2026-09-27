-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721161803 "horse_seat_from_treasury_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 bf9b7ecd360cf681cfb24b3f40f5f873 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Atomic horse seating funded from the club treasury: insert the seat with its
-- starting stack AND debit chip_treasury in one transaction. All-or-nothing, so
-- on insufficient treasury or a seat conflict nothing is created (no orphan seat,
-- no minted chips). Companion to fn_horse_fund_from_treasury (which handles the
-- recurring rebuy on an existing seat).
CREATE OR REPLACE FUNCTION public.fn_horse_seat_from_treasury(
  p_table_id uuid,
  p_user_id uuid,
  p_seat_number integer,
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
BEGIN
  IF p_table_id IS NULL OR p_user_id IS NULL OR p_seat_number IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'table, user, seat and positive amount required');
  END IF;

  SELECT club_id INTO v_club_id FROM tables WHERE id = p_table_id;
  IF v_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'table has no club');
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM clubs WHERE id = v_club_id FOR UPDATE;
  IF v_treasury IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club not found');
  END IF;
  IF v_treasury < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient club treasury',
                              'treasury', v_treasury, 'needed', p_amount);
  END IF;

  BEGIN
    INSERT INTO table_seats (table_id, user_id, seat_number, stack, is_sitting_out)
    VALUES (p_table_id, p_user_id, p_seat_number, p_amount, false);
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', 'seat already taken');
  END;

  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury, 0) - p_amount, updated_at = NOW()
  WHERE id = v_club_id;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), v_club_id, NULL, p_user_id, p_amount,
    'horse_treasury_funding', 'Horse seated + funded from club treasury',
    v_treasury - p_amount, NOW()
  );

  RETURN jsonb_build_object('success', true, 'treasury_after', v_treasury - p_amount);
END;
$function$;

DO $$
DECLARE r jsonb;
BEGIN
  SELECT fn_horse_seat_from_treasury(NULL, NULL, NULL, 0) INTO r;
  IF (r->>'success') <> 'false' THEN RAISE EXCEPTION 'guard failed: %', r; END IF;
END $$;
