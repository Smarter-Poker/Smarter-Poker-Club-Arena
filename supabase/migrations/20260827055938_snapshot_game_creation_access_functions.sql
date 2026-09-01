-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827055938; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- SNAPSHOT: game-creation access functions enter version control (2026-08-27).
-- See repo migration 20260827_snapshot_game_creation_access_functions.sql for
-- the full header. Bodies are verbatim from production pg_get_functiondef —
-- re-applying them is a no-op. ONE deliberate change: EXECUTE revoked from
-- anon/PUBLIC on the two helpers the 2026-08-25 sweep missed; both fail
-- closed for unauthenticated callers, so no client behaviour changes.

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

  IF v_is_union OR v_union_id = p_club_id
     OR EXISTS (SELECT 1 FROM unions u WHERE u.id = p_club_id) THEN
    v_own := p_club_id;
    v_union_id := NULL;
  END IF;

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

  IF v_member IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM unions u
                    WHERE u.id = v_member AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM union_admins a
                    WHERE a.union_id = v_member AND a.user_id = p_user_id);
  END IF;

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

REVOKE ALL ON FUNCTION public.fn_club_union_context(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_can_create_games(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_game_creation_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_union_context(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_can_create_games(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_game_creation_access(uuid) TO authenticated, service_role;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc
       WHERE proname IN ('fn_club_union_context','fn_can_create_games','fn_game_creation_access')) <> 3 THEN
    RAISE EXCEPTION 'snapshot_game_creation_access: expected all three functions to exist';
  END IF;
END $$;
