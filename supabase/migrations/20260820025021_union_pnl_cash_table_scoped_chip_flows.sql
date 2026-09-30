-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820025021 "union_pnl_cash_table_scoped_chip_flows"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 75b12e1759e5420f2a76cfd0015e772d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- CASH-OUTS MUST NAME A CASH TABLE (2026-08-19)
--
-- Over a clean 45-second window with matched baselines, players still netted
-- +323 while paying 40.82 of rake. In a closed system players lose the rake,
-- so ~364 of chips were arriving from outside the cash economy.
--
-- Cause: the chip-ledger leg carried a legacy fallback —
--     (ct.table_id IS NULL AND ct.club_id IN <union scope>)
-- — added because chip_transactions had no table_id at all until earlier
-- today. With every game now owned by the union, that predicate stopped
-- meaning "a cash-out from one of our cash tables" and started meaning "any
-- club-scoped credit", sweeping in TOURNAMENT payouts. Tournament entries are
-- category 'tournament_buyin' and are deliberately NOT counted as cash
-- buy-ins, so counting their payouts as cash-outs credited players with
-- winnings whose stake was never debited.
--
-- chip_transactions.table_id is populated going forward (added today), so the
-- cash-out leg now REQUIRES a union cash table. Historical rows without a
-- table_id are no longer force-fitted into the cash economy — better to
-- attribute nothing than to attribute a tournament prize as a cash win.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_union_pnl_all_clubs(
  p_union_id uuid, p_start timestamptz, p_end timestamptz,
  p_include_horses boolean DEFAULT true
) RETURNS TABLE (
  club_id uuid, buyins numeric, cashouts numeric, realized_net numeric,
  winnings numeric, losses numeric, players int, seated_stack numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH attributed AS (
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
      JOIN profiles p ON p.id = cm.user_id
     WHERE p_include_horses OR COALESCE(p.is_horse, false) = false
     ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  union_tables AS (
    SELECT id FROM tables WHERE union_id = p_union_id AND tournament_id IS NULL
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
      JOIN union_tables ut ON ut.id = ct.table_id   -- must name a union CASH table
      JOIN attributed a ON a.user_id = ct.to_user_id
     WHERE ct.transaction_type = 'cashout'
       AND ct.created_at >= p_start AND ct.created_at < p_end
     GROUP BY a.club_id, ct.to_user_id
  ),
  flows AS (
    SELECT COALESCE(w.club_id, c.club_id) AS club_id,
           COALESCE(w.user_id, c.user_id) AS user_id,
           COALESCE(w.buyins, 0) AS buyins,
           COALESCE(w.cashouts, 0) + COALESCE(c.cashouts, 0) AS cashouts
      FROM wallet_flows w
      FULL OUTER JOIN chip_flows c ON c.user_id = w.user_id AND c.club_id = w.club_id
  ),
  per_club AS (
    SELECT f.club_id, SUM(f.buyins) AS buyins, SUM(f.cashouts) AS cashouts,
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

REVOKE ALL ON FUNCTION fn_union_pnl_all_clubs(uuid, timestamptz, timestamptz, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_pnl_all_clubs(uuid, timestamptz, timestamptz, boolean) TO service_role;

-- Re-baseline so the next window is measured against this definition.
DO $$
DECLARE u record;
BEGIN
  FOR u IN SELECT id FROM unions LOOP
    PERFORM fn_union_pnl_bootstrap(u.id);
  END LOOP;
END $$;
