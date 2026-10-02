-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819215702 "union_pnl_exclude_house_horses"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a2f00bf48e4e8e18627b6461c10cef2d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- UNION P&L — EXCLUDE HOUSE HORSES (2026-08-19, audit round 2)
--
-- Measured in production: of 1,156 union club members, 1,148 are horses
-- (profiles.is_horse) and only 8 are real people. 100% of the 11.7M chips
-- currently seated on union tables belong to horse accounts.
--
-- Why that broke the settlement: horses do not buy in through
-- wallet_transactions (they are seated by the engine via atomic_table_buyin,
-- funded from the club treasury). So their chips appear in the seated-stack
-- delta with NO matching wallet debit, which shattered the accounting
-- identity — a dry run showed an imbalance of 1,112,929 and the guard
-- correctly refused to move a chip.
--
-- Why excluding them is also the RIGHT model, not just a convenient fix:
-- horses are house AI funded by the club itself. Their table results are not
-- an obligation between a club and its union. The weekly square-up is for
-- REAL players' wins and losses, which is what "wins and losses are tracked
-- by players" means. Real players' results already account for money won
-- from or lost to a horse.
--
-- Applied to all three attribution points: P&L, seated stacks, and rake.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_union_club_player_pnl(
  p_club_id uuid, p_union_id uuid, p_start timestamptz, p_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_buyins numeric := 0; v_cashouts numeric := 0; v_winnings numeric := 0;
  v_losses numeric := 0; v_players int := 0; v_seated numeric := 0;
BEGIN
  WITH attributed AS (
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
      JOIN profiles p ON p.id = cm.user_id
     WHERE COALESCE(p.is_horse, false) = false   -- house AI is not a club liability
     ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  mine AS (SELECT user_id FROM attributed WHERE club_id = p_club_id),
  union_tables AS (SELECT id FROM tables WHERE union_id = p_union_id),
  union_scope_clubs AS (
    SELECT club_id AS id FROM union_clubs WHERE union_id = p_union_id
    UNION SELECT p_union_id
  ),
  wallet_flows AS (
    SELECT wt.user_id,
           SUM(CASE WHEN wt.type='debit'  AND wt.category='buyin'   THEN wt.amount ELSE 0 END) AS buyins,
           SUM(CASE WHEN wt.type='credit' AND wt.category='cashout' THEN wt.amount ELSE 0 END) AS cashouts
      FROM wallet_transactions wt
      JOIN union_tables ut ON ut.id = wt.table_id
      JOIN mine m ON m.user_id = wt.user_id
     WHERE wt.created_at >= p_start AND wt.created_at < p_end
     GROUP BY wt.user_id
  ),
  chip_flows AS (
    SELECT ct.to_user_id AS user_id, SUM(ct.amount) AS cashouts
      FROM chip_transactions ct
      JOIN mine m ON m.user_id = ct.to_user_id
     WHERE ct.transaction_type = 'cashout'
       AND ct.club_id IN (SELECT id FROM union_scope_clubs)
       AND ct.created_at >= p_start AND ct.created_at < p_end
     GROUP BY ct.to_user_id
  ),
  flows AS (
    SELECT COALESCE(w.user_id, c.user_id) AS user_id,
           COALESCE(w.buyins, 0) AS buyins,
           COALESCE(w.cashouts, 0) + COALESCE(c.cashouts, 0) AS cashouts
      FROM wallet_flows w FULL OUTER JOIN chip_flows c ON c.user_id = w.user_id
  )
  SELECT COALESCE(SUM(f.buyins),0), COALESCE(SUM(f.cashouts),0),
         COALESCE(SUM(GREATEST(f.cashouts - f.buyins, 0)),0),
         COALESCE(SUM(GREATEST(f.buyins - f.cashouts, 0)),0), COUNT(*)
    INTO v_buyins, v_cashouts, v_winnings, v_losses, v_players
    FROM flows f;

  SELECT COALESCE(SUM(ts.stack), 0) INTO v_seated
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id AND t.union_id = p_union_id
    JOIN profiles pr ON pr.id = ts.user_id AND COALESCE(pr.is_horse, false) = false
    JOIN (
      SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
        FROM club_members cm
        JOIN union_clubs u2 ON u2.club_id = cm.club_id AND u2.union_id = p_union_id
        JOIN profiles p2 ON p2.id = cm.user_id
       WHERE COALESCE(p2.is_horse, false) = false
       ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
    ) a ON a.user_id = ts.user_id AND a.club_id = p_club_id
   WHERE ts.left_at IS NULL;

  RETURN jsonb_build_object(
    'buyins', v_buyins, 'cashouts', v_cashouts, 'realized_net', v_cashouts - v_buyins,
    'winnings', v_winnings, 'losses', v_losses, 'players', v_players, 'seated_stack', v_seated);
END $$;

CREATE OR REPLACE FUNCTION fn_union_rake_paid_by_club(
  p_union_id uuid, p_start timestamptz, p_end timestamptz
) RETURNS TABLE (club_id uuid, rake_paid numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH attributed AS (
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
      JOIN profiles p ON p.id = cm.user_id
     WHERE COALESCE(p.is_horse, false) = false
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

CREATE OR REPLACE FUNCTION fn_union_pnl_bootstrap(p_union_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_results jsonb; v_id uuid; v_now timestamptz := now();
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
           'club_id', uc.club_id,
           'seated_end', COALESCE((
             SELECT SUM(ts.stack) FROM table_seats ts
              JOIN tables t ON t.id = ts.table_id AND t.union_id = p_union_id
              JOIN profiles pr ON pr.id = ts.user_id AND COALESCE(pr.is_horse, false) = false
              JOIN (
                SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
                  FROM club_members cm
                  JOIN union_clubs u2 ON u2.club_id = cm.club_id AND u2.union_id = p_union_id
                  JOIN profiles p2 ON p2.id = cm.user_id
                 WHERE COALESCE(p2.is_horse, false) = false
                 ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
              ) a ON a.user_id = ts.user_id AND a.club_id = uc.club_id
              WHERE ts.left_at IS NULL), 0),
           'net', 0, 'bootstrap', true))
    INTO v_results FROM union_clubs uc WHERE uc.union_id = p_union_id;

  INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status,
                                     total_collected, total_paid, total_unpaid, club_results)
  VALUES (p_union_id, v_now, v_now + interval '1 second', 'settled', 0, 0, 0,
          COALESCE(v_results, '[]'::jsonb))
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'bootstrap_id', v_id,
                            'baseline_at', v_now, 'clubs', COALESCE(v_results, '[]'::jsonb));
END $$;

-- Re-bootstrap on the real-player-only basis so baselines are consistent.
DO $$
DECLARE u record;
BEGIN
  FOR u IN SELECT id FROM unions LOOP
    PERFORM fn_union_pnl_bootstrap(u.id);
  END LOOP;
END $$;
