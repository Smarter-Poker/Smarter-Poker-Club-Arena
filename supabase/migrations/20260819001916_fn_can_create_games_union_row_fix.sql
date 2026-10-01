-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819001916 "fn_can_create_games_union_row_fix"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 58f937c71c11f902ac23a31e038a5162 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix found by the rollback test written alongside the first version:
-- on the UNION'S OWN club row, authorisation was falling through to the
-- standalone branch and checking clubs.owner_id. A union whose club row is
-- owned by someone other than the union owner — which is normal once a union
-- outlives whoever first created its club record — would have locked the union
-- owner out of building the very games their member clubs depend on.
--
-- The union's own row now accepts the union owner and union_admins as well as
-- the club-row owner/admins. Everything else is unchanged; see the original
-- migration for the rule and why both link sources are consulted.
CREATE OR REPLACE FUNCTION public.fn_can_create_games(p_club_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_union     boolean;
  v_union_id     uuid;
  v_own_union_id uuid;
BEGIN
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT COALESCE(c.is_union, false), c.union_id
    INTO v_is_union, v_union_id
    FROM clubs c
   WHERE c.id = p_club_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Is this club row itself a union? Either the flag, a self-referencing
  -- union_id, or a unions row sharing its id.
  IF v_is_union OR v_union_id = p_club_id
     OR EXISTS (SELECT 1 FROM unions u WHERE u.id = p_club_id) THEN
    v_own_union_id := p_club_id;
    v_union_id := NULL;
  END IF;

  IF v_own_union_id IS NULL AND v_union_id IS NULL THEN
    SELECT uc.union_id INTO v_union_id
      FROM union_clubs uc
     WHERE uc.club_id = p_club_id
       AND uc.union_id <> p_club_id
     LIMIT 1;
  END IF;

  -- The union's own row: the union's people build here.
  IF v_own_union_id IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM unions u
                    WHERE u.id = v_own_union_id AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM union_admins a
                    WHERE a.union_id = v_own_union_id AND a.user_id = p_user_id)
        OR EXISTS (SELECT 1 FROM clubs c
                    WHERE c.id = p_club_id AND c.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM club_members m
                    WHERE m.club_id = p_club_id AND m.user_id = p_user_id
                      AND m.role IN ('owner', 'admin')
                      AND m.status IN ('active', 'approved'));
  END IF;

  -- A club that belongs to a union does not build its own games.
  IF v_union_id IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM unions u
                    WHERE u.id = v_union_id AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM union_admins a
                    WHERE a.union_id = v_union_id AND a.user_id = p_user_id);
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
