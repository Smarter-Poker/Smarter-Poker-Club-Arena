-- Club tournament leaderboard, aggregated in the database.
--
-- Applied to production 2026-08-22 as 20260822023309. This file is a copy of
-- what was applied, not a plan: the previous version of it
-- (20260821_club_tournament_stats.sql) sat in this directory for a day WITHOUT
-- ever being applied, while the service code that called it was reverted by a
-- bad merge. The result was a repo that claimed a feature, a database that had
-- never heard of it, and a leaderboard quietly serving wrong numbers.
--
-- WHY THE FUNCTION EXISTS: the client aggregated this itself, reading raw
-- tournament_players rows capped at QUERY_LIMITS.AGGREGATE (10,000). Every club
-- with results is past that cap (21,116 / 19,241 / 17,842 rows on 2026-08-21),
-- and the cap was applied with NO ORDER BY, so each club's standings were
-- computed from an arbitrary ~half of its history. Measured on SHARK CLUB
-- before this landed: the true #1 showed as #5, the true #2 as #28, the true #3
-- as #116 with $0, and the true #10 did not appear at all.
--
-- SECURITY INVOKER, deliberately. `tournaments` carries an RLS policy that
-- hides private tournaments from non-members; running as invoker keeps exactly
-- the visibility the client-side version had. A SECURITY DEFINER version would
-- publish private clubs' results to anyone who called it. The DO block at the
-- bottom refuses to apply if that ever flips.
--
-- The arithmetic mirrors the client implementation it replaces, field for
-- field, so landing it changes WHICH ROWS are counted (all of them) and nothing
-- else: prize only (bounties excluded), buy-in + fee per entry for ROI,
-- distinct tournaments for the played count, position = 1 for a win.

CREATE OR REPLACE FUNCTION public.fn_club_tournament_stats(
    p_club_id uuid,
    p_limit int DEFAULT 50,
    p_offset int DEFAULT 0
)
RETURNS TABLE (
    "userId" uuid,
    username text,
    avatar text,
    "tournamentsPlayed" int,
    wins int,
    "finalTables" int,
    "itmFinishes" int,
    "totalPrizes" numeric,
    roi numeric,
    "biggestWin" numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT
        tp.user_id,
        COALESCE(pr.username, tp.username)::text,
        pr.arena_avatar_url::text,
        COUNT(DISTINCT tp.tournament_id)::int,
        COUNT(*) FILTER (WHERE tp.position = 1)::int,
        COUNT(*) FILTER (WHERE tp.position IS NOT NULL AND tp.position <= 9)::int,
        COUNT(*) FILTER (WHERE COALESCE(tp.prize, 0) > 0)::int,
        COALESCE(SUM(tp.prize), 0)::numeric,
        (CASE
            WHEN SUM(COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0)) > 0
            THEN ((COALESCE(SUM(tp.prize), 0)
                   - SUM(COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0)))
                  / SUM(COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0))) * 100.0
            ELSE 0
        END)::numeric,
        COALESCE(MAX(tp.prize), 0)::numeric
    FROM tournament_players tp
    JOIN tournaments t ON t.id = tp.tournament_id
    LEFT JOIN profiles pr ON pr.id = tp.user_id
    WHERE t.club_id = p_club_id
      AND tp.status IN ('eliminated', 'winner')
    GROUP BY tp.user_id, COALESCE(pr.username, tp.username), pr.arena_avatar_url
    -- user_id breaks ties: without it, two players on equal prizes can swap
    -- between pages, so the same row appears twice and another never does.
    ORDER BY 8 DESC, tp.user_id
    LIMIT GREATEST(p_limit, 0)
    OFFSET GREATEST(p_offset, 0);
$$;

COMMENT ON FUNCTION public.fn_club_tournament_stats(uuid, int, int) IS
    'Club tournament leaderboard aggregated server-side. Replaces a client-side aggregation that was capped at 10k raw rows, which every club exceeded. SECURITY INVOKER so the tournaments RLS policy still hides private tournaments.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname = 'fn_club_tournament_stats'
    ) THEN
        RAISE EXCEPTION 'fn_club_tournament_stats was not created';
    END IF;

    IF (SELECT prosecdef FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname = 'fn_club_tournament_stats') THEN
        RAISE EXCEPTION 'fn_club_tournament_stats must be SECURITY INVOKER - a definer version leaks private clubs';
    END IF;
END $$;
