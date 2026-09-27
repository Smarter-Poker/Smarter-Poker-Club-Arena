-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820033931 "union_pnl_count_live_tournament_equity"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 93a5038231a0b1fce7253cfa625fe17f of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- A player's money inside a tournament that has not finished is chips at risk,
-- exactly like a stack on a cash table. The entry fee had already been booked as
-- an outflow while the offsetting prize does not exist yet, so every tournament
-- in progress at the snapshot instant left a hole in the identity.
--
-- Booked AT COST (fees paid minus prizes already received for tournaments still
-- live) rather than at the scrip face value of the tournament stack - chip stacks
-- in a tournament are not redeemable currency and counting them would restate
-- 14.7M of scrip as money.
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
  union_tourneys AS (
    SELECT id FROM tournaments WHERE union_id = p_union_id
  ),
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
         COALESCE(s.seated_stack, 0) + GREATEST(COALESCE(te.equity, 0), 0)
    FROM union_clubs uc
    LEFT JOIN per_club pc ON pc.club_id = uc.club_id
    LEFT JOIN seated s ON s.club_id = uc.club_id
    LEFT JOIN tourney_equity te ON te.club_id = uc.club_id
   WHERE uc.union_id = p_union_id;
$function$;

-- The old tolerance compared the residual against SUM(abs(net)) - but the
-- residual IS the sum of the nets, so whenever both clubs ran the same
-- direction the ratio was pinned at 1.0 and the gate could never pass on
-- anything above the 100 floor. Judge the imbalance against the money that
-- actually moved instead.
CREATE OR REPLACE FUNCTION public.fn_union_settle_player_pnl_guarded(
  p_union_id uuid, p_start timestamptz, p_end timestamptz, p_tolerance numeric DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_preview jsonb; v_bad int := 0; v_detail jsonb; v_id uuid;
  v_residual numeric; v_turnover numeric; v_tol numeric;
BEGIN
  v_preview := fn_union_settle_player_pnl(p_union_id, p_start, p_end, true);
  IF NOT COALESCE((v_preview->>'success')::boolean, false) THEN
    RETURN v_preview;
  END IF;

  SELECT count(*), jsonb_agg(e) INTO v_bad, v_detail
    FROM jsonb_array_elements(v_preview->'clubs') e
   WHERE abs(COALESCE((e->>'net')::numeric, 0)) > 1
     AND COALESCE((e->>'buyins')::numeric, 0) = 0
     AND COALESCE((e->>'cashouts')::numeric, 0) = 0
     AND COALESCE((e->>'stack_delta')::numeric, 0) = 0;

  IF v_bad > 0 THEN
    INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status,
                                       total_collected, total_paid, total_unpaid, club_results)
    VALUES (p_union_id, p_start, p_end, 'needs_review', 0, 0, 0,
            COALESCE(v_preview->'clubs', '[]'::jsonb))
    ON CONFLICT DO NOTHING RETURNING id INTO v_id;
    RETURN jsonb_build_object('success', false, 'needs_review', true,
      'reason', 'net_without_activity', 'clubs_affected', v_bad, 'settlement_id', v_id,
      'message', 'One or more clubs show a balance owed with no buy-ins, cash-outs or '
                 || 'stack movement behind it. The inputs are wrong, so no chips were moved.',
      'detail', v_detail);
  END IF;

  v_residual := COALESCE((v_preview->>'house_residual')::numeric, 0);
  SELECT COALESCE(SUM(COALESCE((e->>'buyins')::numeric,0)
                    + COALESCE((e->>'cashouts')::numeric,0)), 0)
    INTO v_turnover FROM jsonb_array_elements(v_preview->'clubs') e;
  v_tol := COALESCE(p_tolerance, GREATEST(100, round(v_turnover * 0.01, 2)));

  IF abs(v_residual) > v_tol THEN
    INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status,
                                       total_collected, total_paid, total_unpaid, club_results)
    VALUES (p_union_id, p_start, p_end, 'needs_review', 0, 0, 0,
            COALESCE(v_preview->'clubs', '[]'::jsonb))
    ON CONFLICT DO NOTHING RETURNING id INTO v_id;
    RETURN jsonb_build_object('success', false, 'needs_review', true,
      'reason', 'does_not_reconcile', 'residual', v_residual, 'tolerance', v_tol,
      'turnover', v_turnover, 'settlement_id', v_id,
      'message', 'Club win/loss did not net out across the union, so the basis is not '
                 || 'trustworthy and NO chips were moved. Weekly 90% rakeback is unaffected '
                 || 'and pays normally - it is computed from rake contributions, not from '
                 || 'this identity.');
  END IF;

  RETURN fn_union_settle_player_pnl(p_union_id, p_start, p_end, false);
END $function$;

