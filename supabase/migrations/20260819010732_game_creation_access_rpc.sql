-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819010732 "game_creation_access_rpc"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2eb67ffcac201b5bd2c2c323317d8bd1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  WHO BUILDS THE GAMES — shared union resolution + a UI-facing access RPC
-- ═══════════════════════════════════════════════════════════════════════════
-- fn_can_create_games already enforces the rule server-side (tables RLS +
-- fn_create_tournament). The UI had no way to ASK the same question, so the
-- create-table page fell back to "is this club in a union? then nobody may
-- build here" — which locked out the union owner, the one person the rule
-- says must be able to build for a union's clubs.
--
-- 1. fn_club_union_context  — the single place union membership is resolved.
-- 2. fn_can_create_games    — refactored to use it (behaviour unchanged).
-- 3. fn_game_creation_access— one call the UI can make: may I build here,
--                             which union owns these games, and if not, why.

CREATE OR REPLACE FUNCTION public.fn_club_union_context(p_club_id uuid)
RETURNS TABLE (own_union_id uuid, member_union_id uuid)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_union boolean;
  v_union_id uuid;
  v_own      uuid;
BEGIN
  own_union_id := NULL;
  member_union_id := NULL;

  IF p_club_id IS NULL THEN
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT COALESCE(c.is_union, false), c.union_id
    INTO v_is_union, v_union_id
    FROM clubs c
   WHERE c.id = p_club_id;

  IF NOT FOUND THEN
    RETURN NEXT;
    RETURN;
  END IF;

  -- Is this club row itself a union? Either the flag, a self-referencing
  -- union_id, or a unions row sharing its id.
  IF v_is_union OR v_union_id = p_club_id
     OR EXISTS (SELECT 1 FROM unions u WHERE u.id = p_club_id) THEN
    v_own := p_club_id;
    v_union_id := NULL;
  END IF;

  -- Live data disagrees between clubs.union_id and union_clubs, so both are
  -- read. Either one makes the club a member.
  IF v_own IS NULL AND v_union_id IS NULL THEN
    SELECT uc.union_id INTO v_union_id
      FROM union_clubs uc
     WHERE uc.club_id = p_club_id
       AND uc.union_id <> p_club_id
     LIMIT 1;
  END IF;

  own_union_id := v_own;
  member_union_id := v_union_id;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_can_create_games(p_club_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_own    uuid;
  v_member uuid;
BEGIN
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM clubs c WHERE c.id = p_club_id) THEN
    RETURN false;
  END IF;

  SELECT own_union_id, member_union_id INTO v_own, v_member
    FROM fn_club_union_context(p_club_id);

  -- The union's own row: the union's people build here.
  IF v_own IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM unions u
                    WHERE u.id = v_own AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM union_admins a
                    WHERE a.union_id = v_own AND a.user_id = p_user_id)
        OR EXISTS (SELECT 1 FROM clubs c
                    WHERE c.id = p_club_id AND c.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM club_members m
                    WHERE m.club_id = p_club_id AND m.user_id = p_user_id
                      AND m.role IN ('owner', 'admin')
                      AND m.status IN ('active', 'approved'));
  END IF;

  -- A club that belongs to a union does not build its own games.
  IF v_member IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM unions u
                    WHERE u.id = v_member AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM union_admins a
                    WHERE a.union_id = v_member AND a.user_id = p_user_id);
  END IF;

  -- Standalone club: its own owner or admin.
  RETURN EXISTS (SELECT 1 FROM clubs c
                  WHERE c.id = p_club_id AND c.owner_id = p_user_id)
      OR EXISTS (SELECT 1 FROM club_members m
                  WHERE m.club_id = p_club_id
                    AND m.user_id = p_user_id
                    AND m.role IN ('owner', 'admin')
                    AND m.status IN ('active', 'approved'));
END;
$$;

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

  RETURN jsonb_build_object(
    'allowed',  v_ok,
    -- The union whose games these are. Stamped onto the row so the union's
    -- own views find it; NULL for a standalone club.
    'union_id', COALESCE(v_own, v_member),
    'reason',   CASE WHEN v_ok THEN 'ok'
                     WHEN v_member IS NOT NULL THEN 'union_only'
                     ELSE 'not_owner_or_admin' END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_club_union_context(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_club_union_context(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_game_creation_access(uuid) TO authenticated, service_role;
