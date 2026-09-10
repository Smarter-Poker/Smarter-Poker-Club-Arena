-- 20260910181549_active_means_who_is_on_the_floor_cash_and_events_counted_apa.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-09-09: "why are the club lobby tables not displaying the same
-- numbers as how many players are actually playing?! each club shows 300-549
-- active players, but only showing a handful of cash games open and players
-- sitting..."
--
-- ACTIVE on a club card was one number that mixed cash seats with tournament
-- seats, so 291 "active" beside 21 people at cash tables looked wrong even
-- when it was right. The union card was worse: it SUMMED the member clubs'
-- counts, and a union's members sit at the union's tables, so every horse in
-- two member clubs was two active players and Midway Union read 1,094 while
-- 307 distinct people were on its floor.
--
-- One definition now, for both cards: a player is active when he holds a live
-- seat (left_at null, not away) on an open table of the floor. A club's floor
-- is its own tables plus its union's; a union's floor is its own tables plus
-- every member club's own tables. Every count is DISTINCT users. Each row
-- carries the split the card prints: active_count (distinct, on the floor),
-- cash_count (distinct, at cash tables), event_count (distinct, at tournament,
-- Spin and SNG tables). A player at a cash table and in an MTT at once is one
-- active player, one cash player and one event player.
--
-- The return type changes (two columns added), so both functions are dropped
-- and recreated in this one transaction; every caller reads by column name
-- and the old column keeps its name and meaning, so a bundle from before this
-- migration still renders. Grants are restated as they were.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

DROP FUNCTION IF EXISTS public.fn_batch_union_realtime_active_counts(uuid[]);
DROP FUNCTION IF EXISTS public.fn_batch_club_realtime_active_counts(uuid[]);

CREATE FUNCTION public.fn_batch_club_realtime_active_counts(p_club_ids uuid[])
 RETURNS TABLE(club_id uuid, active_count bigint, cash_count bigint, event_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  WITH requested AS (
    SELECT DISTINCT r.club_id FROM unnest(p_club_ids) r(club_id)
  ),
  seated AS (
    -- Every live seat held by a member of the requested club on that club's
    -- floor: the club's own tables, or its union's tables. A member club of a
    -- union plays on tables stamped with the UNION's id (2026-09-03).
    SELECT requested.club_id,
           ts.user_id,
           (t.tournament_id IS NULL) AS at_cash
      FROM requested
      JOIN public.clubs cl ON cl.id = requested.club_id
      JOIN public.club_members cm ON cm.club_id = requested.club_id
       AND (cm.status IS NULL OR cm.status IN ('active', 'approved'))
      JOIN public.table_seats ts ON ts.user_id = cm.user_id
       AND ts.left_at IS NULL AND COALESCE(ts.is_away, false) = false
      JOIN public.tables t ON t.id = ts.table_id
       AND (t.club_id = requested.club_id
            OR (cl.union_id IS NOT NULL AND t.union_id = cl.union_id))
       AND lower(COALESCE(t.status, '')) NOT IN ('closed','completed','cancelled','finished')
  )
  SELECT requested.club_id,
         count(DISTINCT s.user_id)::bigint AS active_count,
         count(DISTINCT s.user_id) FILTER (WHERE s.at_cash)::bigint AS cash_count,
         count(DISTINCT s.user_id) FILTER (WHERE NOT s.at_cash)::bigint AS event_count
    FROM requested
    LEFT JOIN seated s ON s.club_id = requested.club_id
   GROUP BY requested.club_id;
$function$;

CREATE FUNCTION public.fn_batch_union_realtime_active_counts(p_union_ids uuid[])
 RETURNS TABLE(union_id uuid, active_count bigint, cash_count bigint, event_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  WITH requested AS (
    SELECT DISTINCT r.union_id FROM unnest(p_union_ids) r(union_id)
  ),
  floor_tables AS (
    -- The union's floor: tables stamped with the union's id, the union's own
    -- club row's tables, and every member club's own tables.
    SELECT requested.union_id, t.id AS table_id, (t.tournament_id IS NULL) AS at_cash
      FROM requested
      JOIN public.tables t
        ON (t.union_id = requested.union_id
            OR t.club_id = requested.union_id
            OR t.club_id IN (SELECT uc.club_id FROM public.union_clubs uc
                              WHERE uc.union_id = requested.union_id))
     WHERE lower(COALESCE(t.status, '')) NOT IN ('closed','completed','cancelled','finished')
  ),
  seated AS (
    SELECT f.union_id, ts.user_id, f.at_cash
      FROM floor_tables f
      JOIN public.table_seats ts ON ts.table_id = f.table_id
       AND ts.left_at IS NULL AND COALESCE(ts.is_away, false) = false
  )
  SELECT requested.union_id,
         count(DISTINCT s.user_id)::bigint AS active_count,
         count(DISTINCT s.user_id) FILTER (WHERE s.at_cash)::bigint AS cash_count,
         count(DISTINCT s.user_id) FILTER (WHERE NOT s.at_cash)::bigint AS event_count
    FROM requested
    LEFT JOIN seated s ON s.union_id = requested.union_id
   GROUP BY requested.union_id;
$function$;

REVOKE ALL ON FUNCTION public.fn_batch_club_realtime_active_counts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_batch_club_realtime_active_counts(uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_batch_club_realtime_active_counts(uuid[]) IS
  'Per requested club: DISTINCT members holding a live seat on the club''s floor (own tables plus its union''s), split into cash_count (cash tables) and event_count (tournament, Spin, SNG tables). One row per requested club, zero included.';
COMMENT ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[]) IS
  'Per requested union: DISTINCT players holding a live seat on the union''s floor (its tables, its own club row''s tables, every member club''s own tables), split into cash_count and event_count. Distinct, never a sum over member clubs: a player in two member clubs is one active player. One row per requested union, zero included.';

COMMIT;
