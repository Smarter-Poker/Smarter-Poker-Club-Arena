-- 20260821_club_tournament_stats.sql
-- Create an RPC to aggregate tournament stats on the server-side
-- Handles scaling issues where raw rows exceed aggregate limits.

CREATE OR REPLACE FUNCTION fn_club_tournament_stats(
    p_club_id UUID,
    p_limit INT DEFAULT 50,
    p_offset INT DEFAULT 0
)
RETURNS TABLE (
    "userId" UUID,
    username TEXT,
    avatar TEXT,
    "tournamentsPlayed" INT,
    wins INT,
    "finalTables" INT,
    "itmFinishes" INT,
    "totalPrizes" NUMERIC,
    roi NUMERIC,
    "biggestWin" NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        tp.user_id AS "userId",
        COALESCE(u.username, tp.username)::TEXT AS username,
        u.avatar_url::TEXT AS avatar,
        COUNT(tp.tournament_id)::INT AS "tournamentsPlayed",
        COUNT(*) FILTER (WHERE tp.position = 1 OR tp.status = 'winner')::INT AS wins,
        COUNT(*) FILTER (WHERE tp.position <= 9)::INT AS "finalTables",
        COUNT(*) FILTER (WHERE COALESCE(tp.prize, 0) + COALESCE(tp.bounty_winnings, 0) > 0)::INT AS "itmFinishes",
        SUM(COALESCE(tp.prize, 0) + COALESCE(tp.bounty_winnings, 0))::NUMERIC AS "totalPrizes",
        (
            CASE 
                WHEN SUM(
                    COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) + 
                    (COALESCE(tp.rebuys, 0) * COALESCE(t.rebuy_cost, 0)) +
                    (CASE WHEN tp.add_on THEN COALESCE(t.addon_cost, 0) ELSE 0 END)
                ) > 0 THEN
                    (
                        (SUM(COALESCE(tp.prize, 0) + COALESCE(tp.bounty_winnings, 0)) - 
                        SUM(
                            COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) + 
                            (COALESCE(tp.rebuys, 0) * COALESCE(t.rebuy_cost, 0)) +
                            (CASE WHEN tp.add_on THEN COALESCE(t.addon_cost, 0) ELSE 0 END)
                        )) 
                        / 
                        SUM(
                            COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) + 
                            (COALESCE(tp.rebuys, 0) * COALESCE(t.rebuy_cost, 0)) +
                            (CASE WHEN tp.add_on THEN COALESCE(t.addon_cost, 0) ELSE 0 END)
                        )
                    ) * 100.0
                ELSE 0.0
            END
        )::NUMERIC AS roi,
        MAX(COALESCE(tp.prize, 0) + COALESCE(tp.bounty_winnings, 0))::NUMERIC AS "biggestWin"
    FROM tournament_players tp
    JOIN tournaments t ON t.id = tp.tournament_id
    LEFT JOIN profiles u ON u.id = tp.user_id
    WHERE t.club_id = p_club_id
      AND tp.status IN ('eliminated', 'winner')
    GROUP BY tp.user_id, COALESCE(u.username, tp.username), u.avatar_url
    ORDER BY "totalPrizes" DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
