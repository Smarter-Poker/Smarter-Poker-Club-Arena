-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820034021 "union_pnl_tournament_equity_unfloored"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 a728ea50523f78d237d042a0d0af3665 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Do NOT floor per-club tournament equity at zero. A club whose players have
-- collected more in bounties than they have paid in fees for tournaments still
-- running is legitimately negative, and clipping it silently breaks the very
-- identity this term exists to close.
CREATE OR REPLACE FUNCTION public.fn_union_pnl_all_clubs(
  p_union_id uuid, p_start timestamptz, p_end timestamptz,
  p_include_horses boolean DEFAULT true)
 RETURNS TABLE(club_id uuid, buyins numeric, cashouts numeric, realized_net numeric,
               winnings numeric, losses numeric, players integer, seated_stack numeric)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
  union_tourneys AS (SELECT id FROM tournaments WHERE union_id = p_union_id),
  live_tourneys AS (
    SELECT id FROM tournaments
     WHERE union_id = p_union_id AND status IN ('REGISTERING','RUNNING')
  ),
  wallet_flows AS (
    SELECT a.club_id, wt.user_id,
           SUM(CASE WHEN wt.type = 'debit'  THEN wt.amount ELSE 0 END) AS buyins,
           SUM(CASE WHEN wt.type = 'credit' THEN wt.amount ELSE 0 END) AS cashouts
      FROM wallet_transactions wt
      JOIN attributed a ON a.user_id = wt.user_id
     WHERE wt.created_at >= p_start AND wt.created_at < p_end
       AND (
         (wt.category IN ('buyin','cashout')
            AND wt.table_id IN (SELECT id FROM union_tables))
         OR
         (wt.category IN ('tournament_buyin','prize','bounty')
            AND wt.related_entity_id IN (SELECT id FROM union_tourneys))
       )
     GROUP BY a.club_id, wt.user_id
  ),
  chip_flows AS (
    SELECT a.club_id, ct.to_user_id AS user_id, SUM(ct.amount) AS cashouts
      FROM chip_transactions ct
      JOIN union_tables ut ON ut.id = ct.table_id
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
  ),
  tourney_equity AS (
    SELECT a.club_id,
           SUM(CASE WHEN wt.category = 'tournament_buyin' THEN wt.amount
                    ELSE -wt.amount END) AS equity
      FROM wallet_transactions wt
      JOIN attributed a ON a.user_id = wt.user_id
     WHERE wt.category IN ('tournament_buyin','prize','bounty')
       AND wt.related_entity_id IN (SELECT id FROM live_tourneys)
     GROUP BY a.club_id
  )
  SELECT uc.club_id,
         COALESCE(pc.buyins, 0), COALESCE(pc.cashouts, 0),
         COALESCE(pc.cashouts, 0) - COALESCE(pc.buyins, 0),
         COALESCE(pc.winnings, 0), COALESCE(pc.losses, 0),
         COALESCE(pc.players, 0),
         COALESCE(s.seated_stack, 0) + COALESCE(te.equity, 0)
    FROM union_clubs uc
    LEFT JOIN per_club pc ON pc.club_id = uc.club_id
    LEFT JOIN seated s ON s.club_id = uc.club_id
    LEFT JOIN tourney_equity te ON te.club_id = uc.club_id
   WHERE uc.union_id = p_union_id;
$function$;

