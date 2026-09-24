CREATE OR REPLACE FUNCTION public.fn_join_club_membership_impl(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_requires_approval boolean;
  v_active_count int;
  v_role text;
  v_status text;
  v_row club_members%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT owner_id, COALESCE(requires_approval, false)
    INTO v_owner, v_requires_approval
    FROM clubs
    WHERE id = p_club_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club not found';
  END IF;

  SELECT * INTO v_row FROM club_members
    WHERE club_id = p_club_id AND user_id = v_uid;
  IF FOUND THEN
    RETURN to_jsonb(v_row);
  END IF;

  IF v_uid = v_owner THEN
    v_role := 'owner';
    v_status := 'active';
  ELSE
    SELECT count(*) INTO v_active_count
      FROM club_members
      WHERE user_id = v_uid AND status IN ('active', 'approved');
    IF v_active_count >= 10 THEN
      RAISE EXCEPTION 'You can only be a member of up to 10 clubs. Leave a club to join a new one.';
    END IF;

    v_role := 'player';
    v_status := CASE WHEN v_requires_approval THEN 'pending' ELSE 'active' END;
  END IF;

  -- chip_balance = 0 written EXPLICITLY: the default was 1000 until 2026-08-26.
  INSERT INTO club_members (club_id, user_id, role, status, tier, rank_level, orange_ball_status, chip_balance)
  VALUES (p_club_id, v_uid, v_role, v_status, 'bronze', 0, 'cold', 0)
  ON CONFLICT (club_id, user_id) DO NOTHING
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    SELECT * INTO v_row FROM club_members
      WHERE club_id = p_club_id AND user_id = v_uid;
  END IF;

  RETURN to_jsonb(v_row);
END;
$function$
