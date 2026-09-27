-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260724033039 "club_join_approval_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 04f16e4e635d713d949eb7ab0f39cad8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- CLUB-JOIN approval flow RPCs (SECURITY DEFINER)
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. fn_join_club: authoritative join path. Owner → owner/active; else enforce
--    4-club limit and set status per clubs.requires_approval. Idempotent.
CREATE OR REPLACE FUNCTION public.fn_join_club(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
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
    v_role := 'member';
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
$$;

GRANT EXECUTE ON FUNCTION public.fn_join_club(uuid) TO authenticated;

-- 2. fn_review_join_request: admin approves (status=active) or denies (delete
--    pending row). Gated on is_club_admin.
CREATE OR REPLACE FUNCTION public.fn_review_join_request(
  p_club_id uuid,
  p_user_id uuid,
  p_approve boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_found boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF NOT is_club_admin(p_club_id, v_uid) THEN
    RAISE EXCEPTION 'Not authorized to review join requests for this club';
  END IF;

  IF p_approve THEN
    UPDATE club_members
      SET status = 'active'
      WHERE club_id = p_club_id AND user_id = p_user_id AND status = 'pending';
    GET DIAGNOSTICS v_found = ROW_COUNT;
  ELSE
    DELETE FROM club_members
      WHERE club_id = p_club_id AND user_id = p_user_id AND status = 'pending';
    GET DIAGNOSTICS v_found = ROW_COUNT;
  END IF;

  IF NOT v_found THEN
    RETURN jsonb_build_object('success', false, 'error', 'No pending request found');
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_review_join_request(uuid, uuid, boolean) TO authenticated;

-- 3. fn_list_pending_members: admin-only list of pending members (SELECT RLS on
--    club_members restricts non-service callers to their own row, so admins need
--    this SECURITY DEFINER path to see other members' pending requests).
CREATE OR REPLACE FUNCTION public.fn_list_pending_members(p_club_id uuid)
RETURNS TABLE (
  user_id uuid,
  role text,
  status text,
  created_at timestamptz,
  username text,
  display_name text,
  avatar_url text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF NOT is_club_admin(p_club_id, auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
    SELECT cm.user_id,
           cm.role::text,
           cm.status,
           cm.created_at,
           p.username,
           p.display_name,
           p.avatar_url
    FROM club_members cm
    LEFT JOIN profiles p ON p.id = cm.user_id
    WHERE cm.club_id = p_club_id AND cm.status = 'pending'
    ORDER BY cm.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_list_pending_members(uuid) TO authenticated;
