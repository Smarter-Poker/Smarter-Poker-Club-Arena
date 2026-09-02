-- ═══════════════════════════════════════════════════════════════════════════
-- SNAPSHOT: THE GAME-CREATION ACCESS FUNCTIONS ENTER VERSION CONTROL
-- (2026-08-27, create-flow audit Phase 2)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_club_union_context, fn_can_create_games and fn_game_creation_access are
-- the authorization spine of EVERY creation path — the tables INSERT policy,
-- fn_create_tournament, TableConfigPage's permission gate and the modal all
-- call them — and none of the three existed in any migration file in any
-- repo. They were applied to production directly via the Supabase MCP on
-- 2026-08-19 and lived only there: a database rebuild from migrations would
-- silently produce a schema where nobody can create anything.
--
-- These are the LIVE bodies, taken verbatim from production
-- pg_get_functiondef on 2026-08-27. Applying this migration is a no-op
-- against production today; its purpose is that the definitions can never
-- again be lost. If you change one of these, change it in a migration.
--
-- ROLLBACK: none needed — re-applying identical definitions. To alter
-- behaviour, write a NEW migration; never edit this snapshot.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_club_union_context(p_club_id uuid)
 RETURNS TABLE(own_union_id uuid, member_union_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_can_create_games(p_club_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_game_creation_access(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- Grants. ONE deliberate change from the live state: production still had
-- EXECUTE for anon on fn_can_create_games and for PUBLIC + anon on
-- fn_game_creation_access — the 2026-08-25 anon-revoke sweep caught only
-- fn_club_union_context. Both functions fail closed for an unauthenticated
-- caller (auth.uid() IS NULL returns false / not_signed_in), so nothing
-- observable changes for any real client; an anonymous key simply can no
-- longer probe the authorization helpers.
REVOKE ALL ON FUNCTION public.fn_club_union_context(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_can_create_games(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_game_creation_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_union_context(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_can_create_games(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_game_creation_access(uuid) TO authenticated, service_role;

-- ── Post-apply assertions ──────────────────────────────────────────────────
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc
       WHERE proname IN ('fn_club_union_context','fn_can_create_games','fn_game_creation_access')) <> 3 THEN
    RAISE EXCEPTION 'snapshot_game_creation_access: expected all three functions to exist';
  END IF;
END $$;
