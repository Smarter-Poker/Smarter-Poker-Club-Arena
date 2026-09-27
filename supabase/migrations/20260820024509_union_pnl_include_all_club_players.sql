-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820024509 "union_pnl_include_all_club_players"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 72fd15469585609ea5af44d5bfd0c1f0 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- THE P&L COUNTS EVERY PLAYER A CLUB SEATS (2026-08-19)
--
-- Dan: "players inside the clubs generate the rake... each club then squares
-- up what their club won or lost with the union each monday."
--
-- I previously EXCLUDED house horses from the club P&L, on the belief that
-- horses are seated by the engine without touching wallet_transactions, which
-- would have broken the accounting identity. That belief was WRONG:
-- HorseFleetManager.seatHorse goes through atomic_table_buyin, which debits
-- the wallet AND writes the wallet_transactions row. Measured over 2 days:
-- 15,773 horse buy-ins totalling 4,098,346 and 801 horse cash-outs totalling
-- 468,501 — all present in the ledger the P&L reads.
--
-- Excluding them produced a statement that could not reconcile: SHARK CLUB's
-- players generated 530,662 of rake while its P&L read exactly 0.00, so the
-- weekly statement said the union owed SHARK 477,596 with nothing on the other
-- side of the ledger. Rake basis counted horses; P&L did not.
--
-- Both halves now count the same population — everyone the club seats. A
-- club's horses are funded by that club, so their results are that club's
-- results, which is what "what their club won or lost" means.
--
-- p_include_horses is kept as an argument (default TRUE) so the narrower
-- real-players-only view remains available for analysis, but settlement and
-- the weekly statement both use the full population.
-- ============================================================================

DROP FUNCTION IF EXISTS fn_union_pnl_all_clubs(uuid, timestamptz, timestamptz);

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

-- The rake basis already counted every player; keep the two halves aligned.
CREATE OR REPLACE FUNCTION fn_union_club_player_pnl(
  p_club_id uuid, p_union_id uuid, p_start timestamptz, p_end timestamptz
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object(
       'buyins', r.buyins, 'cashouts', r.cashouts, 'realized_net', r.realized_net,
       'winnings', r.winnings, 'losses', r.losses, 'players', r.players,
       'seated_stack', r.seated_stack)
       FROM fn_union_pnl_all_clubs(p_union_id, p_start, p_end, true) r
      WHERE r.club_id = p_club_id),
    jsonb_build_object('buyins',0,'cashouts',0,'realized_net',0,'winnings',0,
                       'losses',0,'players',0,'seated_stack',0));
$$;
REVOKE ALL ON FUNCTION fn_union_club_player_pnl(uuid, uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_club_player_pnl(uuid, uuid, timestamptz, timestamptz) TO service_role;
