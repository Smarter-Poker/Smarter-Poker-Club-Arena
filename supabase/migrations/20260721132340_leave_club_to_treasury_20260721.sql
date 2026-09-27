-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260721132340 "leave_club_to_treasury_20260721"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 286c2221c671ea7ecf4f631ad73deb3a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_member_leave_to_treasury(
  p_club_id uuid,
  p_user_id uuid
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_role  text;
  v_chips numeric;
  v_after numeric;
BEGIN
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club and user required');
  END IF;

  SELECT role, COALESCE(chip_balance, 0)
    INTO v_role, v_chips
  FROM club_members
  WHERE club_id = p_club_id AND user_id = p_user_id
  FOR UPDATE;

  IF v_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not a member');
  END IF;

  IF v_role = 'owner' THEN
    RETURN jsonb_build_object('success', false, 'error', 'owner must transfer ownership first');
  END IF;

  IF v_chips > 0 THEN
    UPDATE clubs
    SET chip_treasury = COALESCE(chip_treasury, 0) + v_chips,
        updated_at = NOW()
    WHERE id = p_club_id
    RETURNING chip_treasury INTO v_after;

    IF v_after IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error', 'club not found');
    END IF;

    INSERT INTO chip_transactions (
      id, club_id, from_user_id, amount, transaction_type, notes, balance_after, created_at
    ) VALUES (
      gen_random_uuid(), p_club_id, p_user_id, v_chips,
      'leave_club_chip_return', 'Chips returned to treasury on club departure',
      v_after, NOW()
    );
  END IF;

  DELETE FROM club_members WHERE club_id = p_club_id AND user_id = p_user_id;

  RETURN jsonb_build_object('success', true, 'chips_returned', COALESCE(v_chips, 0));
END;
$function$;

DO $$
DECLARE r jsonb;
BEGIN
  SELECT fn_member_leave_to_treasury(NULL, NULL) INTO r;
  IF (r->>'success') <> 'false' THEN
    RAISE EXCEPTION 'null-arg guard not active: %', r;
  END IF;
END $$;
