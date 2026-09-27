-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820154722 "union_law_r2_rakeback_funded_from_agent_share"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9972c053679f596830ad02ef7d9d45e7 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- R2 — PLAYER RAKEBACK IS FUNDED FROM THE AGENT'S SHARE (2026-08-20)
--
-- calculate_cascading_commission already distributes 100% of every hand's rake
-- (sub-agent -> agent -> super agent -> club owner residual). Player rakeback
-- was then paid on top of that, funded from nowhere — so the club could pay out
-- MORE than the rake it collected, and an agent's reported earnings ignored
-- everything they passed through to their players.
--
-- In the PokerBros model the agent grants rakeback out of their OWN share:
-- "an agent might pass most rakeback to loyal players, taking a thin margin on
-- huge volume". So the weekly statement now nets it:
--
--   net position = commission earned
--                - rakeback passed to their downline
--                - player winnings they cover
--                - credit outstanding
--
-- and fn_union_distribution_check surfaces any period where total distribution
-- exceeds the rake collected, so an over-payout can never stay invisible.
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
  v_players int := 0; v_rake numeric := 0; v_commission numeric := 0;
  v_player_net numeric := 0; v_credit numeric := 0;
  v_chips_out numeric := 0; v_chips_in numeric := 0; v_rb_passed numeric := 0;
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

-- Distribution must never exceed the rake it is splitting -------------------
CREATE OR REPLACE FUNCTION public.fn_union_distribution_check(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001', p_since timestamptz DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_since, date_trunc('week', now()));
  v_rake numeric; v_comm numeric; v_rb numeric;
BEGIN
  SELECT COALESCE(SUM(rr.rake_amount),0) INTO v_rake
    FROM rake_records rr
    JOIN union_clubs uc ON uc.club_id = rr.club_id AND uc.union_id = p_union_id
   WHERE rr.created_at >= v_from;

  SELECT COALESCE(SUM(ac.amount),0) INTO v_comm
    FROM agent_commissions ac
    JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = p_union_id
   WHERE ac.created_at >= v_from;

  SELECT COALESCE(SUM(rp.rakeback_amount),0) INTO v_rb
    FROM rakeback_periods rp
    JOIN union_clubs uc ON uc.club_id = rp.club_id AND uc.union_id = p_union_id
   WHERE rp.period_start >= v_from::date;

  RETURN jsonb_build_object(
    'period_start', v_from,
    'rake_collected', round(v_rake,2),
    'agent_commissions', round(v_comm,2),
    'player_rakeback', round(v_rb,2),
    'total_distributed', round(v_comm + v_rb, 2),
    'over_distributed_by', round(GREATEST((v_comm + v_rb) - v_rake, 0), 2),
    'healthy', (v_comm + v_rb) <= v_rake * 1.001,
    'note', 'Player rakeback is funded from the agent''s commission, so '
            || 'commissions + rakeback must not exceed the rake collected.'
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_union_distribution_check(uuid, timestamptz) TO authenticated;

