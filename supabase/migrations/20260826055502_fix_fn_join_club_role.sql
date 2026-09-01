-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826055502; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE OR REPLACE FUNCTION public.fn_join_club(p_club_id uuid)
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

  -- Idempotent: if a membership row already exists, return it unchanged.
  SELECT * INTO v_row FROM club_members
    WHERE club_id = p_club_id AND user_id = v_uid;
  IF FOUND THEN
    RETURN to_jsonb(v_row);
  END IF;

  IF v_uid = v_owner THEN
    v_role := 'owner';
    v_status := 'active';
  ELSE
    -- Enforce the 4-club limit (count active memberships).
    SELECT count(*) INTO v_active_count
      FROM club_members
      WHERE user_id = v_uid AND status IN ('active', 'approved');
    IF v_active_count >= 4 THEN
      RAISE EXCEPTION 'You can only be a member of up to 4 clubs. Leave a club to join a new one.';
    END IF;
    
    -- MUST use 'player' not 'member' to satisfy club_members_role_check
    v_role := 'player';
    v_status := CASE WHEN v_requires_approval THEN 'pending' ELSE 'active' END;
  END IF;

  INSERT INTO club_members (club_id, user_id, role, status, tier, rank_level, orange_ball_status)
  VALUES (p_club_id, v_uid, v_role::member_role, v_status, 'bronze', 0, 'cold')
  ON CONFLICT (club_id, user_id) DO NOTHING
  RETURNING * INTO v_row;

  -- Race: a concurrent insert won the conflict — re-read the existing row.
  IF NOT FOUND THEN
    SELECT * INTO v_row FROM club_members
      WHERE club_id = p_club_id AND user_id = v_uid;
  END IF;

  RETURN to_jsonb(v_row);
END;
$function$;
