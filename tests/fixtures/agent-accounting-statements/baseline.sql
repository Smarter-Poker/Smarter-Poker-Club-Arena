CREATE OR REPLACE FUNCTION public.fn_agent_roster_report(p_agent_user_id uuid DEFAULT NULL::uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(player_id uuid, username text, club_id uuid, club_name text, buyins numeric, cashouts numeric, net_result numeric, rake_generated numeric, agent_commission numeric, chip_balance numeric, credit_used numeric, currently_seated boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from  timestamptz := COALESCE(p_since, public.fn_union_week_start(now()));
  v_to    timestamptz := COALESCE(p_until, now());
BEGIN
  IF v_agent IS NULL THEN RAISE EXCEPTION 'no_agent_context'; END IF;
  -- A caller may only pull their OWN roster unless they oversee the union.
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> v_agent
     AND NOT public.fn_is_any_union_overseer(auth.uid()))) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  WITH roster AS (
    SELECT DISTINCT m.user_id, m.club_id, m.chip_balance, m.credit_used
      FROM club_members m
     WHERE m.agent_id = v_agent
        OR EXISTS (SELECT 1 FROM agents child
                    JOIN agents parent ON parent.id = child.parent_agent_id
                   WHERE child.user_id = m.agent_id AND parent.user_id = v_agent)
  ),
  flows AS (
    SELECT wt.user_id,
           SUM(CASE WHEN wt.type='debit'  AND wt.category IN ('buyin','rebuy','addon') THEN wt.amount ELSE 0 END) AS buyins,
           SUM(CASE WHEN wt.type='credit' AND wt.category='cashout' THEN wt.amount ELSE 0 END) AS cashouts
      FROM wallet_transactions wt
      JOIN roster r ON r.user_id = wt.user_id
     WHERE wt.created_at >= v_from AND wt.created_at < v_to
     GROUP BY wt.user_id
  ),
  rake AS (
    SELECT (e.key)::uuid AS user_id,
           SUM(rr.rake_amount * (e.value::numeric) / NULLIF(c.total,0)) AS rake_generated
      FROM rake_records rr
      CROSS JOIN LATERAL (SELECT SUM(t.value::numeric) AS total
                            FROM jsonb_each_text(rr.player_contributions) t(key,value)) c
      CROSS JOIN LATERAL jsonb_each_text(rr.player_contributions) e(key,value)
     WHERE rr.created_at >= v_from AND rr.created_at < v_to
       AND rr.player_contributions IS NOT NULL AND c.total > 0
       AND EXISTS (SELECT 1 FROM roster r WHERE r.user_id = (e.key)::uuid)
     GROUP BY 1
  ),
  comm AS (
    SELECT ac.club_id, SUM(ac.amount) AS amt
      FROM agent_commissions ac
     WHERE ac.user_id = v_agent AND ac.created_at >= v_from AND ac.created_at < v_to
     GROUP BY ac.club_id
  )
  SELECT r.user_id, pr.username, r.club_id, cl.name,
         COALESCE(f.buyins,0), COALESCE(f.cashouts,0),
         COALESCE(f.cashouts,0) - COALESCE(f.buyins,0),
         ROUND(COALESCE(rk.rake_generated,0),2),
         ROUND(COALESCE(cm2.amt,0),2),
         COALESCE(r.chip_balance,0), COALESCE(r.credit_used,0),
         EXISTS (SELECT 1 FROM table_seats ts WHERE ts.user_id = r.user_id AND ts.left_at IS NULL)
    FROM roster r
    LEFT JOIN profiles pr ON pr.id = r.user_id
    LEFT JOIN clubs cl ON cl.id = r.club_id
    LEFT JOIN flows f ON f.user_id = r.user_id
    LEFT JOIN rake rk ON rk.user_id = r.user_id
    LEFT JOIN comm cm2 ON cm2.club_id = r.club_id
   ORDER BY 8 DESC NULLS LAST;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_agent_weekly_statement(p_agent_user_id uuid DEFAULT NULL::uuid, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_period_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid := COALESCE(p_agent_user_id, auth.uid());
  v_from timestamptz := COALESCE(p_period_start, public.fn_union_week_start(now()));
  v_to   timestamptz := COALESCE(p_period_end, now());
  v_players int := 0; v_rake numeric := 0; v_commission numeric := 0;
  v_player_net numeric := 0; v_credit numeric := 0;
  v_chips_out numeric := 0; v_chips_in numeric := 0; v_rb_passed numeric := 0;
BEGIN
  IF v_agent IS NULL THEN RAISE EXCEPTION 'no_agent_context'; END IF;
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR ( auth.uid() <> v_agent
     AND NOT public.fn_is_any_union_overseer(auth.uid()))) THEN
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
    SELECT SUM(CASE WHEN wt.type='credit' AND wt.category='cashout' THEN wt.amount ELSE 0 END)
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
  rb AS (
    -- rakeback this agent's own players received: funded from this agent
    SELECT COALESCE(SUM(rp.rakeback_amount),0) AS passed
      FROM rakeback_periods rp
      JOIN club_members m ON m.user_id = rp.user_id AND m.club_id = rp.club_id
     WHERE m.agent_id = v_agent
       AND rp.period_start >= v_from::date AND rp.period_start < v_to::date + 1
  ),
  ct AS (
    SELECT COALESCE(SUM(CASE WHEN from_user_id = v_agent THEN amount ELSE 0 END),0) AS out_chips,
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
         COALESCE((SELECT in_chips FROM ct),0),
         COALESCE((SELECT passed FROM rb),0)
    INTO v_players, v_rake, v_commission, v_player_net, v_chips_out, v_chips_in, v_rb_passed;

  SELECT COALESCE(SUM(credit_used),0) INTO v_credit
    FROM agents WHERE user_id = v_agent AND status = 'active';

  RETURN jsonb_build_object(
    'agent_user_id', v_agent,
    'period_start', v_from, 'period_end', v_to,
    'players', v_players,
    'rake_generated', round(v_rake, 2),
    'commission_earned', round(v_commission, 2),
    'rakeback_passed_to_players', round(v_rb_passed, 2),
    'commission_net_of_rakeback', round(v_commission - v_rb_passed, 2),
    'player_net_result', round(v_player_net, 2),
    'chips_issued_to_players', round(v_chips_out, 2),
    'chips_returned_from_players', round(v_chips_in, 2),
    'credit_outstanding', round(v_credit, 2),
    -- positive = owed TO the agent; negative = the agent owes up the chain
    'net_settlement_position',
      round(v_commission - v_rb_passed - v_player_net - v_credit, 2),
    'settles', 'weekly'
  );
END $function$;
CREATE OR REPLACE FUNCTION public.fn_union_weekly_agent_statements(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001'::uuid, p_period_start timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(agent_user_id uuid, agent_name text, club_name text, statement jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.fn_is_any_union_overseer(auth.uid()) AND NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  RETURN QUERY
  SELECT a.user_id, pr.username, c.name,
         public.fn_agent_weekly_statement(a.user_id, COALESCE(p_period_start, public.fn_union_week_start(now())), now())
    FROM agents a
    JOIN union_clubs uc ON uc.club_id = a.club_id AND uc.union_id = p_union_id
    LEFT JOIN profiles pr ON pr.id = a.user_id
    LEFT JOIN clubs c ON c.id = a.club_id
   WHERE a.status = 'active'
   ORDER BY pr.username NULLS LAST;
END $function$;
