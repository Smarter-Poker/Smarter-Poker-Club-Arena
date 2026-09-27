-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820132154 "authorize_member_leave_to_treasury"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0528e62790ddf23e2f165b6b1410ee80 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- SEC-3 (2026-08-20): fn_member_leave_to_treasury had NO authorization check.
--
-- It is SECURITY DEFINER, granted to `authenticated`, and takes an arbitrary
-- (p_club_id, p_user_id). Any logged-in user could therefore evict ANY member
-- from ANY club and sweep that member's club chip_balance into the club
-- treasury — chip movement plus forced removal, with the victim's own user id
-- recorded as the source in chip_transactions.
--
-- Its sibling treasury functions (fn_horse_seat_from_treasury,
-- fn_horse_fund_from_treasury) already gate on
-- fn_actor_can_manage_club_treasury(); this one was simply missed. Reviewed
-- both while auditing: they are correctly guarded, as is that helper
-- (service role, club owner, admin-tier member, or agent).
--
-- Guard added: the caller must be the service role, OR the member themselves
-- (the real client flow — ClubsService.leaveClub passes the caller's own
-- user id), OR someone who can manage that club's treasury. Everything else
-- in the function is byte-identical.
CREATE OR REPLACE FUNCTION public.fn_member_leave_to_treasury(p_club_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_role  text;
  v_chips numeric;
  v_after numeric;
  v_caller uuid := auth.uid();
BEGIN
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'club and user required');
  END IF;

  -- AUTHZ: service role, the member themselves, or a club treasury manager.
  IF v_caller IS NOT NULL
     AND v_caller <> p_user_id
     AND NOT public.fn_actor_can_manage_club_treasury(p_club_id) THEN
    RETURN jsonb_build_object('success', false,
      'error', 'not authorized to remove another member from this club');
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
