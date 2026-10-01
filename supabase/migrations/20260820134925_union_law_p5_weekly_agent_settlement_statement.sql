-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820134925 "union_law_p5_weekly_agent_settlement_statement"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4a1379b8f95bee60478821ea4f5c62ec of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- P5 — WEEKLY AGENT SETTLEMENT STATEMENT (2026-08-20)
--
-- PokerBros settles the agent layer weekly: "the total settlement of chip
-- balances happens on a weekly basis, typically on Mondays", agent -> super-
-- agent -> union. An agent's weekly position is the combination of:
--
--   + commission earned on their roster's rake
--   - net chips their players WON (the agent covers player winnings)
--   + net chips their players LOST (the agent collects)
--   = credit outstanding they still owe
--
-- We had the pieces (agent_commissions, wallet flows, credit_used) but nothing
-- that produced the actual weekly statement an agent settles against, so there
-- was no answer to "what does this agent owe or get paid this week".
--
-- fn_agent_weekly_statement produces exactly that, per agent, and
-- fn_union_weekly_agent_statements rolls it up for the union owner. Both are
-- read-only: they compute the position, they do not move money, so they are
-- safe to run any time.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_agent_weekly_statement(p_agent_user_id uuid DEFAULT NULL, p_period_start timestamptz DEFAULT NULL, p_period_end timestamptz DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from timestamptz := COALESCE(p_period_start, date_trunc('week', now()));
  v_to   timestamptz := COALESCE(p_period_end, now());
  v_players int := 0;
  v_rake numeric := 0;
  v_commission numeric := 0;
  v_player_net numeric := 0;
  v_credit numeric := 0;
  v_chips_out numeric := 0;
  v_chips_in numeric := 0;
BEGIN
  IF v_agent IS NULL THEN RAISE EXCEPTION 'no_agent_context'; END IF;
  IF auth.uid() IS NOT NULL AND auth.uid() <> v_agent
     AND NOT public.fn_is_any_union_overseer(auth.uid()) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  WITH roster AS (
    SELECT DISTINCT m.user_id AS player_id, m.club_id
      FROM club_members m
     WHERE m.agent_id = v_agent
        OR EXISTS (SELECT 1 FROM agents child
                    JOIN agents parent ON parent.id = child.parent_agent_id
                   WHERE child.user_id = m.agent_id AND parent.user_id = v_agent)
  ),
  rk AS (
    SELECT SUM(rr.rake_amount * (e.value::numeric) / NULLIF(c.total,0)) AS rake
      FROM rake_records rr
      CROSS JOIN LATERAL (SELECT SUM(t.value::numeric) AS total
                            FROM jsonb_each_text(rr.player_contributions) t(key,value)) c
      CROSS JOIN LATERAL jsonb_each_text(rr.player_contributions) e(key,value)
     WHERE rr.created_at >= v_from AND rr.created_at < v_to
       AND rr.player_contributions IS NOT NULL AND c.total > 0
       AND EXISTS (SELECT 1 FROM roster r WHERE r.player_id = (e.key)::uuid)
  ),
  fl AS (
    SELECT
      SUM(CASE WHEN wt.type='credit' AND wt.category='cashout' THEN wt.amount ELSE 0 END)
    - SUM(CASE WHEN wt.type='debit'  AND wt.category IN ('buyin','rebuy','addon') THEN wt.amount ELSE 0 END) AS net
      FROM wallet_transactions wt
      JOIN roster r ON r.player_id = wt.user_id
     WHERE wt.created_at >= v_from AND wt.created_at < v_to
  ),
  cm AS (
    SELECT COALESCE(SUM(amount),0) AS commission
      FROM agent_commissions
     WHERE user_id = v_agent AND created_at >= v_from AND created_at < v_to
  ),
  ct AS (
    SELECT
      COALESCE(SUM(CASE WHEN from_user_id = v_agent THEN amount ELSE 0 END),0) AS out_chips,
      COALESCE(SUM(CASE WHEN to_user_id   = v_agent THEN amount ELSE 0 END),0) AS in_chips
      FROM chip_transactions
     WHERE created_at >= v_from AND created_at < v_to
       AND (from_user_id = v_agent OR to_user_id = v_agent)
  )
  SELECT (SELECT count(*) FROM roster),
         COALESCE((SELECT rake FROM rk),0),
         COALESCE((SELECT commission FROM cm),0),
         COALESCE((SELECT net FROM fl),0),
         COALESCE((SELECT out_chips FROM ct),0),
         COALESCE((SELECT in_chips FROM ct),0)
    INTO v_players, v_rake, v_commission, v_player_net, v_chips_out, v_chips_in;

  SELECT COALESCE(SUM(credit_used),0) INTO v_credit
    FROM agents WHERE user_id = v_agent AND status = 'active';

  RETURN jsonb_build_object(
    'agent_user_id', v_agent,
    'period_start', v_from,
    'period_end', v_to,
    'players', v_players,
    'rake_generated', round(v_rake, 2),
    'commission_earned', round(v_commission, 2),
    'player_net_result', round(v_player_net, 2),
    'chips_issued_to_players', round(v_chips_out, 2),
    'chips_returned_from_players', round(v_chips_in, 2),
    'credit_outstanding', round(v_credit, 2),
    -- Positive = the union/club owes the agent. Negative = the agent owes up.
    'net_settlement_position',
      round(v_commission - v_player_net - v_credit, 2),
    'settles', 'weekly'
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_agent_weekly_statement(uuid, timestamptz, timestamptz) TO authenticated;

CREATE OR REPLACE FUNCTION public.fn_union_weekly_agent_statements(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001', p_period_start timestamptz DEFAULT NULL)
 RETURNS TABLE(agent_user_id uuid, agent_name text, club_name text, statement jsonb)
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.fn_is_any_union_overseer(auth.uid()) AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  SELECT a.user_id, pr.username, c.name,
         public.fn_agent_weekly_statement(a.user_id, COALESCE(p_period_start, date_trunc('week', now())), now())
    FROM agents a
    JOIN union_clubs uc ON uc.club_id = a.club_id AND uc.union_id = p_union_id
    LEFT JOIN profiles pr ON pr.id = a.user_id
    LEFT JOIN clubs c ON c.id = a.club_id
   WHERE a.status = 'active'
   ORDER BY pr.username NULLS LAST;
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_union_weekly_agent_statements(uuid, timestamptz) TO authenticated;

