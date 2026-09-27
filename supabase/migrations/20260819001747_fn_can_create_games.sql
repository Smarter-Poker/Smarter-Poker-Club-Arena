-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819001747 "fn_can_create_games"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 48723243c55d08c174d852222997b932 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- WHO MAY BUILD CASH GAMES AND TOURNAMENTS (owner ruling, 2026-08-19)
--
--   "Tournaments and cash games can only be built or added by the union owner
--    or the club owner. If a club is inside a union, they only see the cash
--    games and tournaments built by the union. If the club is stand alone, with
--    no union affiliation, they create all their own. But only the owner or
--    admin of the clubs or unions can do this."
--
-- One function so the rule exists once. It backs both the tables INSERT policy
-- and fn_create_tournament; anything else that needs the same question must
-- call this rather than re-implement it.
--
-- What it replaces: the tables INSERT policy was
--   WITH CHECK (auth.uid() IS NOT NULL)
-- i.e. ANY logged-in user could create a table in ANY club — including a club
-- they had never joined. tournaments had no INSERT policy at all, so nobody
-- could create one from the browser.
--
-- Union membership is read from BOTH sources because they disagree in live
-- data: union_clubs links two clubs to Midway Union, while clubs.union_id is
-- set on only one of them. Either link counts as "in a union", which fails
-- closed toward the union rule rather than letting a club that looks standalone
-- in one table create its own games.
--
-- A union's own club row (clubs.is_union, or union_id pointing at itself) is
-- NOT treated as a club-inside-a-union; that row is how the union builds games,
-- so it takes the owner/admin branch.
CREATE OR REPLACE FUNCTION public.fn_can_create_games(p_club_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_union   boolean;
  v_union_id   uuid;
BEGIN
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT COALESCE(c.is_union, false), c.union_id
    INTO v_is_union, v_union_id
    FROM clubs c
   WHERE c.id = p_club_id;

  IF NOT FOUND THEN
    RETURN false;              -- unknown club: never authorise
  END IF;

  -- A self-referencing union_id is the union's own club row, not membership.
  IF v_union_id = p_club_id THEN
    v_union_id := NULL;
  END IF;

  -- union_clubs is the more complete of the two link sources.
  IF v_union_id IS NULL AND NOT v_is_union THEN
    SELECT uc.union_id INTO v_union_id
      FROM union_clubs uc
     WHERE uc.club_id = p_club_id
       AND uc.union_id <> p_club_id
     LIMIT 1;
  END IF;

  IF v_union_id IS NOT NULL AND NOT v_is_union THEN
    -- Club belongs to a union. The club's own owner/admins may NOT create here;
    -- the union builds the games and the club sees them.
    RETURN EXISTS (SELECT 1 FROM unions u
                    WHERE u.id = v_union_id AND u.owner_id = p_user_id)
        OR EXISTS (SELECT 1 FROM union_admins a
                    WHERE a.union_id = v_union_id AND a.user_id = p_user_id);
  END IF;

  -- Standalone club, or the union's own club row: club owner or club admin.
  -- club_members.status is checked because an application that was never
  -- approved must not confer admin rights; live data uses both 'active' and
  -- 'approved' for accepted members.
  RETURN EXISTS (SELECT 1 FROM clubs c
                  WHERE c.id = p_club_id AND c.owner_id = p_user_id)
      OR EXISTS (SELECT 1 FROM club_members m
                  WHERE m.club_id = p_club_id
                    AND m.user_id = p_user_id
                    AND m.role IN ('owner', 'admin')
                    AND m.status IN ('active', 'approved'));
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_can_create_games(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_can_create_games(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_can_create_games(uuid, uuid) IS
  'Owner ruling 2026-08-19: only a club owner/admin (standalone club) or a union owner/admin (club in a union) may create cash games or tournaments. Single source of truth for the tables INSERT policy and fn_create_tournament.';
