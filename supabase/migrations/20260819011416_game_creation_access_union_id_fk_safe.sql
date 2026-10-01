-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819011416 "game_creation_access_union_id_fk_safe"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ec7b9a19c34c73db08b85167e460329f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- `tables.union_id` has a FOREIGN KEY to unions(id). fn_club_union_context
-- resolves membership from clubs.is_union / clubs.union_id / union_clubs, and
-- none of those three is guaranteed to point at a real `unions` row — today
-- every one of them does, but a club flagged is_union with no unions row would
-- hand the UI a union_id that the FK then rejects, turning "create a table"
-- into a hard failure for the one person allowed to do it.
--
-- So the id this RPC hands back is only ever one that exists. The access
-- decision is untouched: it still comes from fn_can_create_games, which does
-- not care whether the unions row exists.
CREATE OR REPLACE FUNCTION public.fn_game_creation_access(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user   uuid := auth.uid();
  v_own    uuid;
  v_member uuid;
  v_union  uuid;
  v_ok     boolean;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'union_id', NULL, 'reason', 'not_signed_in');
  END IF;
  IF p_club_id IS NULL OR NOT EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id) THEN
    RETURN jsonb_build_object('allowed', false, 'union_id', NULL, 'reason', 'unknown_club');
  END IF;

  SELECT own_union_id, member_union_id INTO v_own, v_member
    FROM fn_club_union_context(p_club_id);

  v_ok := fn_can_create_games(p_club_id, v_user);

  -- Only a union that really exists may be stamped onto the new row.
  SELECT u.id INTO v_union FROM unions u WHERE u.id = COALESCE(v_own, v_member);

  RETURN jsonb_build_object(
    'allowed',  v_ok,
    'union_id', v_union,
    'reason',   CASE WHEN v_ok THEN 'ok'
                     WHEN v_member IS NOT NULL THEN 'union_only'
                     ELSE 'not_owner_or_admin' END
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_game_creation_access(uuid) TO authenticated, service_role;
