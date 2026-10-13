CREATE TEMP TABLE native_original_opening AS SELECT (r->>'club_id')::uuid club_id,(r->>'user_id')::uuid user_id,(r->>'amount')::numeric amount FROM jsonb_array_elements(smarter_private.original_erased_cash_receivables('fade0000-0000-0000-0000-000000000001','2026-10-12 07:00:00Z')->'holdings')r;
CREATE TEMP TABLE native_original_current_report AS WITH flows AS(SELECT * FROM smarter_private.original_erased_cash_discharge_returns('fade0000-0000-0000-0000-000000000001','2026-10-12 07:00:00Z','2026-10-19 07:00:00Z')),
 hand_players(club_id,user_id,delta) AS(SELECT club_id,user_id,0::numeric FROM native_original_opening),
 opening AS(SELECT club_id,sum(amount) amount,sum(amount) cash FROM native_original_opening GROUP BY club_id),
 closing AS(SELECT (x->>'club_id')::uuid club_id,sum((x->>'amount')::numeric) amount,sum((x->>'amount')::numeric) cash FROM jsonb_array_elements(smarter_private.original_erased_cash_receivables('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00:00Z')->'holdings')x GROUP BY 1),
 rake AS(SELECT DISTINCT club_id,0::numeric generated,0::numeric earned,0::numeric cash_rake,0::numeric tournament_rake FROM native_original_opening),
 roster AS(SELECT DISTINCT club_id FROM native_original_opening),
 movement AS (SELECT club_id,sum(buyins) buyins,sum(cashouts) cashouts,
  sum(cashouts-buyins) FILTER(WHERE kind IN('cash_funding','cash_return','cash_late_settlement')) cash_flow,
  sum(buyins) FILTER(WHERE kind='cash_funding') cash_buyins,sum(cashouts) FILTER(WHERE kind='cash_return') cash_cashouts FROM flows GROUP BY club_id),
 hands AS (SELECT club_id,sum(delta) delta FROM hand_players GROUP BY club_id),
 people AS (SELECT club_id,count(DISTINCT user_id)::int players FROM(SELECT club_id,user_id FROM flows UNION SELECT club_id,user_id FROM hand_players
  UNION SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid FROM jsonb_array_elements((SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id,'amount',amount)) FROM native_original_opening)||(smarter_private.original_erased_cash_receivables('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00:00Z')->'holdings')) x) q GROUP BY club_id),
 club_rows AS (
  SELECT r.club_id,COALESCE(m.buyins,0) buyins,COALESCE(m.cashouts,0) cashouts,COALESCE(m.cash_buyins,0) cash_buyins,COALESCE(m.cash_cashouts,0) cash_cashouts,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0) realized_net,COALESCE(o.amount,0) seated_start,COALESCE(c.amount,0) seated_end,
   COALESCE(o.cash,0) seated_start_cash,COALESCE(c.cash,0) seated_end_cash,
   COALESCE(c.amount,0)-COALESCE(o.amount,0) stack_delta,COALESCE(h.delta,0) cash_player_pnl,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0)+COALESCE(c.amount,0)-COALESCE(o.amount,0)-COALESCE(h.delta,0) tournament_player_pnl,
   COALESCE(m.cash_flow,0)+COALESCE(c.cash,0)-COALESCE(o.cash,0)=COALESCE(h.delta,0) cash_reconciled,
   COALESCE(p.players,0) players,COALESCE(k.generated,0) rake_paid,COALESCE(k.earned,0) rake_earned,COALESCE(k.cash_rake,0) cash_rake,COALESCE(k.tournament_rake,0) tournament_rake,
   COALESCE(m.cashouts,0)-COALESCE(m.buyins,0)+COALESCE(c.amount,0)-COALESCE(o.amount,0)+COALESCE(k.generated,0) net
  FROM roster r LEFT JOIN movement m USING(club_id) LEFT JOIN opening o USING(club_id) LEFT JOIN closing c USING(club_id)
  LEFT JOIN hands h USING(club_id) LEFT JOIN people p USING(club_id) LEFT JOIN rake k USING(club_id)
  WHERE r.club_id IS NOT NULL
 ), player_results AS (
  SELECT club_id,user_id,sum(delta) delta FROM (
   SELECT club_id,user_id,cashouts-buyins delta FROM flows
   UNION ALL SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid,(x->>'amount')::numeric FROM jsonb_array_elements((smarter_private.original_erased_cash_receivables('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00:00Z')->'holdings')) x
   UNION ALL SELECT (x->>'club_id')::uuid,(x->>'user_id')::uuid,-(x->>'amount')::numeric FROM jsonb_array_elements((SELECT jsonb_agg(jsonb_build_object('club_id',club_id,'user_id',user_id,'amount',amount)) FROM native_original_opening)) x
  ) amounts GROUP BY club_id,user_id
 ), wins AS(SELECT club_id,sum(greatest(delta,0)) winnings,sum(greatest(-delta,0)) losses FROM player_results GROUP BY club_id), complete AS (
  SELECT q.*,COALESCE(w.winnings,0) winnings,COALESCE(w.losses,0) losses,
   CASE 'winnings_only'
    WHEN 'club_cash_profit' THEN rake_earned-cash_player_pnl
    WHEN 'net_invoice_position' THEN realized_net+stack_delta+rake_paid+rake_earned
    WHEN 'winnings_plus_rake' THEN realized_net+stack_delta+rake_paid
    WHEN 'winnings_only' THEN realized_net+stack_delta END eco_base
  FROM club_rows q LEFT JOIN wins w USING(club_id)
 )SELECT * FROM complete;
DO $test$BEGIN IF (SELECT count(*) FROM smarter_private.original_erased_cash_discharge_returns('fade0000-0000-0000-0000-000000000001','2026-10-12 07:00:00Z','2026-10-19 07:00:00Z'))<>7 OR (SELECT count(DISTINCT ledger_id) FROM smarter_private.original_erased_cash_discharge_returns('fade0000-0000-0000-0000-000000000001','2026-10-12 07:00:00Z','2026-10-19 07:00:00Z'))<>7 OR smarter_private.original_erased_cash_receivables('fade0000-0000-0000-0000-000000000001','2026-10-19 07:00:00Z')->>'status' IS DISTINCT FROM 'ready' THEN RAISE EXCEPTION 'exactsevenactualheldsource_refused';END IF; IF (SELECT count(*) FROM native_original_current_report)<>2 OR EXISTS(SELECT FROM native_original_current_report WHERE cash_reconciled IS DISTINCT FROM true OR net<>0 OR winnings<>0 OR losses<>0 OR tournament_player_pnl<>0 OR cash_player_pnl<>0 OR rake_paid<>0 OR rake_earned<>0) OR(SELECT sum(cash_cashouts) FROM native_original_current_report)<>1845.87 OR(SELECT sum(seated_start_cash) FROM native_original_current_report)<>1845.87 OR(SELECT sum(seated_end_cash) FROM native_original_current_report)<>0 THEN RAISE EXCEPTION 'current_original_bank_discharge_report_disagrees';END IF;RAISE NOTICE 'PASS actualb9 report original7 cashreturn offsets1845.87opening receivable,0net/rake/winnings/losses';END$test$;