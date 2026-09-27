-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819233323 "union_pnl_set_based_all_clubs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3c417116267f552a0108c444275918df of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- UNION P&L — ONE SET-BASED PASS FOR THE WHOLE UNION (2026-08-19)
--
-- Two problems with the per-club design:
--   1. SCOPE. Chip-ledger cash-outs could only be filtered by club_id, so a
--      PRIVATE club game's cash-out fell into the union scope. Now that
--      chip_transactions carries table_id, cash-outs are scoped to UNION
--      TABLES exactly like the wallet ledger — private games drop out.
--      Legacy rows (written before table_id existed) have table_id IS NULL and
--      are still matched by club, so history does not silently change.
--   2. COST. fn_union_club_player_pnl was called once per club, and each call
--      re-derived the same union-wide attribution and re-scanned the same
--      ledgers. At 2 clubs that is invisible; it is O(clubs) full scans, so it
--      degrades exactly when a union grows.
--
-- fn_union_pnl_all_clubs computes every club in ONE pass. The per-club function
-- is kept (same corrected scoping) because other callers and the bootstrap use
-- it, but the settlement now uses the set-based version.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_union_pnl_all_clubs(
  p_union_id uuid, p_start timestamptz, p_end timestamptz
) RETURNS TABLE (
  club_id uuid, buyins numeric, cashouts numeric, realized_net numeric,
  winnings numeric, losses numeric, players int, seated_stack numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH attributed AS (
    -- Each real player belongs to exactly one club in the union: the one they
    -- joined first. Horses are house AI and are never a club<->union liability.
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
      JOIN profiles p ON p.id = cm.user_id
     WHERE COALESCE(p.is_horse, false) = false
     ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  union_tables AS (SELECT id FROM tables WHERE union_id = p_union_id),
  union_scope_clubs AS (
    SELECT uc.club_id AS id FROM union_clubs uc WHERE uc.union_id = p_union_id
    UNION SELECT p_union_id
  ),
  wallet_flows AS (
    SELECT a.club_id, wt.user_id,
           SUM(CASE WHEN wt.type='debit'  AND wt.category='buyin'   THEN wt.amount ELSE 0 END) AS buyins,
           SUM(CASE WHEN wt.type='credit' AND wt.category='cashout' THEN wt.amount ELSE 0 END) AS cashouts
      FROM wallet_transactions wt
      JOIN union_tables ut ON ut.id = wt.table_id
      JOIN attributed a ON a.user_id = wt.user_id
     WHERE wt.created_at >= p_start AND wt.created_at < p_end
     GROUP BY a.club_id, wt.user_id
  ),
  chip_flows AS (
    SELECT a.club_id, ct.to_user_id AS user_id, SUM(ct.amount) AS cashouts
      FROM chip_transactions ct
      JOIN attributed a ON a.user_id = ct.to_user_id
     WHERE ct.transaction_type = 'cashout'
       AND ct.created_at >= p_start AND ct.created_at < p_end
       AND (
         -- Preferred: the row names its table, so private games drop out.
         ct.table_id IN (SELECT id FROM union_tables)
         -- Legacy rows predate table_id; fall back to club scope.
         OR (ct.table_id IS NULL AND ct.club_id IN (SELECT id FROM union_scope_clubs))
       )
     GROUP BY a.club_id, ct.to_user_id
  ),
  flows AS (
    SELECT COALESCE(w.club_id, c.club_id) AS club_id,
           COALESCE(w.user_id, c.user_id) AS user_id,
           COALESCE(w.buyins, 0) AS buyins,
           COALESCE(w.cashouts, 0) + COALESCE(c.cashouts, 0) AS cashouts
      FROM wallet_flows w
      FULL OUTER JOIN chip_flows c
        ON c.user_id = w.user_id AND c.club_id = w.club_id
  ),
  per_club AS (
    SELECT f.club_id,
           SUM(f.buyins) AS buyins,
           SUM(f.cashouts) AS cashouts,
           SUM(GREATEST(f.cashouts - f.buyins, 0)) AS winnings,
           SUM(GREATEST(f.buyins - f.cashouts, 0)) AS losses,
           COUNT(*)::int AS players
      FROM flows f GROUP BY f.club_id
  ),
  seated AS (
    SELECT a.club_id, SUM(ts.stack) AS seated_stack
      FROM table_seats ts
      JOIN union_tables ut ON ut.id = ts.table_id
      JOIN attributed a ON a.user_id = ts.user_id
     WHERE ts.left_at IS NULL
     GROUP BY a.club_id
  )
  SELECT uc.club_id,
         COALESCE(pc.buyins, 0), COALESCE(pc.cashouts, 0),
         COALESCE(pc.cashouts, 0) - COALESCE(pc.buyins, 0),
         COALESCE(pc.winnings, 0), COALESCE(pc.losses, 0),
         COALESCE(pc.players, 0), COALESCE(s.seated_stack, 0)
    FROM union_clubs uc
    LEFT JOIN per_club pc ON pc.club_id = uc.club_id
    LEFT JOIN seated s ON s.club_id = uc.club_id
   WHERE uc.union_id = p_union_id;
$$;

REVOKE ALL ON FUNCTION fn_union_pnl_all_clubs(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_pnl_all_clubs(uuid, timestamptz, timestamptz) TO service_role;

-- Keep the per-club function consistent with the new scoping (bootstrap and
-- any other caller must not disagree with the settlement).
CREATE OR REPLACE FUNCTION fn_union_club_player_pnl(
  p_club_id uuid, p_union_id uuid, p_start timestamptz, p_end timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'buyins', COALESCE(r.buyins, 0), 'cashouts', COALESCE(r.cashouts, 0),
    'realized_net', COALESCE(r.realized_net, 0),
    'winnings', COALESCE(r.winnings, 0), 'losses', COALESCE(r.losses, 0),
    'players', COALESCE(r.players, 0), 'seated_stack', COALESCE(r.seated_stack, 0))
  FROM (SELECT * FROM fn_union_pnl_all_clubs(p_union_id, p_start, p_end)
         WHERE club_id = p_club_id) r
  UNION ALL
  SELECT jsonb_build_object('buyins',0,'cashouts',0,'realized_net',0,'winnings',0,
                            'losses',0,'players',0,'seated_stack',0)
  WHERE NOT EXISTS (SELECT 1 FROM fn_union_pnl_all_clubs(p_union_id, p_start, p_end)
                     WHERE club_id = p_club_id)
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION fn_union_club_player_pnl(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_club_player_pnl(uuid, uuid, timestamptz, timestamptz) TO service_role;
