-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820024701 "union_pnl_cash_seats_only"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fe6e75b40386f8a7339a640aabb2319c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- THE P&L WAS COUNTING TOURNAMENT SCRIP AS MONEY (2026-08-19)
--
-- The weekly statement reported SHARK CLUB's players +13,921,725 and said the
-- union owed the two clubs 15.1 MILLION. Nonsense, and the same unit error
-- already found and fixed in the chip-supply monitor earlier today:
--
--   `seated_stack` summed EVERY seat on a union table, including TOURNAMENT
--   seats. A tournament seat's stack is scrip granted from
--   tournaments.starting_chips — a 10-chip buy-in grants 10,000 tournament
--   chips. It is never bought with wallet money and can never be cashed out
--   at face value, so differencing it against wallet flows is meaningless.
--
-- Cash buy-ins and cash-outs were always correct (a tournament entry is
-- category 'tournament_buyin', not 'buyin', so it never entered the flows).
-- Only the seated-stack leg was polluted — and it dominated, because
-- tournament seats hold ~31M of scrip against ~86k of real cash stacks.
--
-- Seated stacks are now CASH seats only (tournament_id IS NULL), which is the
-- only pool that is conserved against the wallet ledger.
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
  -- CASH tables only. Tournament tables carry scrip, not money.
  union_tables AS (
    SELECT id FROM tables
     WHERE union_id = p_union_id AND tournament_id IS NULL
  ),
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
       AND (ct.table_id IN (SELECT id FROM union_tables)
            OR (ct.table_id IS NULL AND ct.club_id IN (SELECT id FROM union_scope_clubs)))
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
      JOIN union_tables ut ON ut.id = ts.table_id   -- cash seats only
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
