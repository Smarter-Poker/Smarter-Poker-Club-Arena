-- =============================================================================
-- a_union_clubs_active_players_sit_at_union_tables
-- Applied to production via Supabase MCP 2026-09-03.
--
-- Dan, 2026-09-03: "SHARK CLUB & CLUB JAQK AREN'T DISPLAYING THE 'ACTIVE
-- PLAYERS' THIS BUG NEEDS TO BE FIXED." Both cards read MEMBERS 593 / 584 and
-- ACTIVE 0.
--
-- Measured 2026-09-03 08:0x UTC:
--
--   club          members   active (t.club_id = club)   active (club OR union)
--   SHARK CLUB        593                            0                      475
--   Club JAQK         584                            0                      471
--
-- Both clubs are member clubs of Midway Union, and a union floor's tables are
-- stamped with the UNION's id, not the member club's - which is the whole point
-- of a union: one shared floor that every member club's players sit at. This
-- function counted a member as active only when
-- `t.club_id = requested.club_id`, so for a club inside a union the join could
-- never match and the answer was structurally 0, forever, however busy the
-- floor was.
--
-- A member is active when they hold a live seat at a table ON THEIR CLUB'S
-- FLOOR: the club's own tables, or - when the club belongs to a union - that
-- union's tables. Standalone clubs are unaffected: `cl.union_id` is NULL for
-- them, the second arm is never true, and the answer is exactly what it was.
--
-- The lobby was already right (get_club_players_playing and get_club_home both
-- resolve the union scope). This is the club CARD's batch reader, and it was
-- the only one of the four still counting by club_id alone.
--
-- Same signature, same STABLE SECURITY DEFINER, same ACL as production
-- ({postgres,authenticated,service_role}); restated at the end so this file is
-- self-contained.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.fn_batch_club_realtime_active_counts(p_club_ids uuid[])
 RETURNS TABLE(club_id uuid, active_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT requested.club_id,
         count(DISTINCT ts.user_id) FILTER (WHERE t.id IS NOT NULL)::bigint
    FROM unnest(p_club_ids) requested(club_id)
    -- The club's own row, for the union it belongs to (if any).
    LEFT JOIN public.clubs cl ON cl.id = requested.club_id
    LEFT JOIN public.club_members cm ON cm.club_id = requested.club_id
      AND (cm.status IS NULL OR cm.status IN ('active', 'approved'))
    LEFT JOIN public.table_seats ts ON ts.user_id = cm.user_id
      AND ts.left_at IS NULL AND COALESCE(ts.is_away, false) = false
    LEFT JOIN public.tables t ON t.id = ts.table_id
      -- THE CLUB'S FLOOR, not just the club's own tables. A member club of a
      -- union plays on tables stamped with the UNION's id; requiring
      -- t.club_id = requested.club_id reported 0 active players at Shark Club
      -- and Club JAQK while 475 and 471 of their members were seated.
      AND (
        t.club_id = requested.club_id
        OR (cl.union_id IS NOT NULL AND t.union_id = cl.union_id)
      )
      AND lower(COALESCE(t.status, '')) NOT IN ('closed','completed','cancelled','finished')
   GROUP BY requested.club_id;
$function$;

-- ── WHO MAY CALL IT ──────────────────────────────────────────────────────────
-- A signed-in player reads this for the club cards on the home page. It is
-- STABLE and reads only public club facts (how many members are seated), so
-- `authenticated` keeps the grant it already holds; anon and PUBLIC do not.
-- PUBLIC is named as well as the roles: revoking a role while PUBLIC still
-- holds the grant reads as a fix and does nothing. This matches the live ACL
-- rather than changing it.
REVOKE ALL ON FUNCTION public.fn_batch_club_realtime_active_counts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_batch_club_realtime_active_counts(uuid[]) TO authenticated, service_role;
