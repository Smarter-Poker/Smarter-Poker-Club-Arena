-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820023856 "rakeback_basis_by_player_contribution"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 90b7b15f2a973ba1254e562121a85097 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- RAKEBACK BASIS FOR UNION-OWNED GAMES (2026-08-19)
--
-- Dan: "all clubs inside the union get their rake back every monday morning.
-- 90% rake back."
--
-- THE BREAK. fn_union_weekly_rakeback_close builds its payout basis by
-- grouping union_wallet_transactions on club_id, then pays every club EXCEPT
-- the union's own row:
--       FROM _uwrb WHERE club_id IS NOT NULL AND club_id <> p_union_id
-- That was correct while each game belonged to a member club. Now that all
-- games are created BY the union, every rake credit carries
-- club_id = <union id>, so the basis collapses to a single self-club row, the
-- payout loop skips it, and JAQK and SHARK would have received 0% this Monday
-- while the union retained 100%.
--
-- THE BASIS. Rake credited to the union has to be split by WHOSE PLAYERS paid
-- it. rake_records.player_contributions already records each player's share of
-- every pot, and that is the same weighting the rakeback settler uses per
-- player — so the club-level split is just that, grouped one level up.
--
-- NOTE ON HORSES: unlike the union player-P&L (which excludes house horses
-- because it settles a liability between real people), rakeback is a revenue
-- share on ACTIVITY. Horses are funded by their club and their play generates
-- real rake, so they count toward that club's basis. Excluding them here would
-- hand almost the entire pot to whichever club happened to seat a human.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_union_rake_basis_by_club(
  p_union_id uuid, p_start timestamptz, p_end timestamptz
) RETURNS TABLE (club_id uuid, rake_share numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH attributed AS (
    -- every member, horses included; first club joined wins ties
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
     ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  ut AS (SELECT id FROM tables WHERE union_id = p_union_id),
  rr AS (
    SELECT r.id, r.rake_amount, r.player_contributions,
           (SELECT SUM(t.value::numeric)
              FROM jsonb_each_text(r.player_contributions) AS t(key, value)) AS total_contrib
      FROM rake_records r
      JOIN ut ON ut.id = r.table_id
     WHERE r.created_at >= p_start AND r.created_at < p_end
       AND r.player_contributions IS NOT NULL AND r.rake_amount > 0
  )
  SELECT a.club_id, round(SUM(rr.rake_amount * (e.value::numeric) / rr.total_contrib), 2)
    FROM rr
    CROSS JOIN LATERAL jsonb_each_text(rr.player_contributions) AS e(key, value)
    JOIN attributed a ON a.user_id = (e.key)::uuid
   WHERE rr.total_contrib > 0
   GROUP BY a.club_id;
$$;

REVOKE ALL ON FUNCTION fn_union_rake_basis_by_club(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_rake_basis_by_club(uuid, timestamptz, timestamptz) TO service_role;
