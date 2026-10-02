-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819160046 "union_player_pnl_dual_ledger_fix"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d3bb25c5dc5e7a85dd52e2ca327e6e32 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- FIX (2026-08-19): table cash-outs are split across two ledgers.
--   - wallet_transactions credit/cashout (client leave path, has table_id)
--   - chip_transactions 'cashout' (engine cash-out path, club-scoped, no table_id)
-- Verified in production: the two sets do NOT overlap. Count both.
-- chip_transactions cashouts are scoped by club_id = the table's rake-routing
-- club; for a union that is any club in union_clubs OR the union id itself
-- (legacy rows carry the union id in club_id).
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_chip_tx_type_user_created
  ON chip_transactions (transaction_type, to_user_id, created_at);

CREATE OR REPLACE FUNCTION fn_union_club_player_pnl(
  p_club_id uuid,
  p_union_id uuid,
  p_start timestamptz,
  p_end timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_buyins numeric := 0;
  v_cashouts numeric := 0;
  v_winnings numeric := 0;
  v_losses numeric := 0;
  v_players int := 0;
  v_seated numeric := 0;
BEGIN
  WITH attributed AS (
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
     ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  mine AS (
    SELECT user_id FROM attributed WHERE club_id = p_club_id
  ),
  union_tables AS (
    SELECT id FROM tables WHERE union_id = p_union_id
  ),
  union_scope_clubs AS (
    SELECT club_id AS id FROM union_clubs WHERE union_id = p_union_id
    UNION SELECT p_union_id
  ),
  wallet_flows AS (
    SELECT wt.user_id,
           SUM(CASE WHEN wt.type = 'debit'  AND wt.category = 'buyin'   THEN wt.amount ELSE 0 END) AS buyins,
           SUM(CASE WHEN wt.type = 'credit' AND wt.category = 'cashout' THEN wt.amount ELSE 0 END) AS cashouts
      FROM wallet_transactions wt
      JOIN union_tables ut ON ut.id = wt.table_id
      JOIN mine m ON m.user_id = wt.user_id
     WHERE wt.created_at >= p_start AND wt.created_at < p_end
     GROUP BY wt.user_id
  ),
  chip_flows AS (
    SELECT ct.to_user_id AS user_id,
           SUM(ct.amount) AS cashouts
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
      FROM wallet_flows w
      FULL OUTER JOIN chip_flows c ON c.user_id = w.user_id
  )
  SELECT COALESCE(SUM(f.buyins), 0),
         COALESCE(SUM(f.cashouts), 0),
         COALESCE(SUM(GREATEST(f.cashouts - f.buyins, 0)), 0),
         COALESCE(SUM(GREATEST(f.buyins - f.cashouts, 0)), 0),
         COUNT(*)
    INTO v_buyins, v_cashouts, v_winnings, v_losses, v_players
    FROM flows f;

  SELECT COALESCE(SUM(ts.stack), 0)
    INTO v_seated
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id AND t.union_id = p_union_id
    JOIN (
      SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
        FROM club_members cm
        JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
       ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
    ) a ON a.user_id = ts.user_id AND a.club_id = p_club_id
   WHERE ts.left_at IS NULL;

  RETURN jsonb_build_object(
    'buyins', v_buyins,
    'cashouts', v_cashouts,
    'realized_net', v_cashouts - v_buyins,
    'winnings', v_winnings,
    'losses', v_losses,
    'players', v_players,
    'seated_stack', v_seated
  );
END $$;
