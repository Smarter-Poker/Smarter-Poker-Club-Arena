-- ═════════════════════════════════════════════════════════════════════════════
-- CA phantom-reference sweep #3 — financial dashboard read models
-- (applied to production 2026-07-23 via Supabase MCP as
--  ca_sweep3_settlement_commission_read_models)
--
-- Reimplements three stub RPCs over the LIVE tables so the settlement and
-- commission dashboards render real data:
--   * generate_period_settlements(p_period_id)           — full SettlementSummary jsonb
--   * calculate_agent_settlement(p_period_id, p_agent_id) — single AgentSettlement jsonb
--   * calculate_agent_spread(p_agent_id, p_period_id)     — CommissionSpread jsonb
-- Data sources: settlement_periods, settlement_invoices, rake_history,
-- bbj_contributions, agent_commissions (live per-hand ledger written by the
-- engine RakebackSettler), agents, sub_agents, rakeback_periods, profiles.
-- Keys are camelCase because the client consumes the jsonb verbatim.
-- READ-ONLY: none of these move money.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.generate_period_settlements(p_period_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_period record;
  v_authorized boolean := false;
  v_club_name text;
  v_rake numeric := 0;
  v_hands integer := 0;
  v_bbj numeric := 0;
  v_agent_comm numeric := 0;
  v_players integer := 0;
  v_rakeback numeric := 0;
  v_platform_fee numeric := 0;
  v_inv_status text;
  v_club_status text;
  v_agents jsonb;
  v_clubs jsonb;
  v_wires jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  SELECT * INTO v_period FROM settlement_periods WHERE id = p_period_id;
  IF v_period.id IS NULL THEN
    RAISE EXCEPTION 'settlement period % not found', p_period_id;
  END IF;

  -- Caller must administer the period's club or its union
  SELECT (
    EXISTS (
      SELECT 1 FROM clubs c
       WHERE c.id = v_period.club_id
         AND (c.owner_id = v_caller
              OR EXISTS (SELECT 1 FROM club_members cm
                          WHERE cm.club_id = c.id AND cm.user_id = v_caller
                            AND cm.role IN ('owner','co_owner','admin')))
    )
    OR EXISTS (SELECT 1 FROM unions u
                WHERE u.id = v_period.union_id AND u.owner_id = v_caller)
    OR EXISTS (SELECT 1 FROM union_admins ua
                WHERE ua.union_id = v_period.union_id AND ua.user_id = v_caller)
  ) INTO v_authorized;
  IF NOT v_authorized THEN
    RAISE EXCEPTION 'not authorized for this settlement period';
  END IF;

  SELECT COALESCE(SUM(rake_amount),0), COUNT(*) INTO v_rake, v_hands
    FROM rake_history
   WHERE club_id = v_period.club_id
     AND COALESCE(collected_at, created_at) >= v_period.start_at
     AND COALESCE(collected_at, created_at) <  v_period.end_at;

  SELECT COALESCE(SUM(amount),0) INTO v_bbj
    FROM bbj_contributions
   WHERE club_id = v_period.club_id
     AND created_at >= v_period.start_at AND created_at < v_period.end_at;

  SELECT COALESCE(SUM(amount),0) INTO v_agent_comm
    FROM agent_commissions
   WHERE club_id = v_period.club_id
     AND created_at >= v_period.start_at AND created_at < v_period.end_at;

  SELECT COUNT(DISTINCT user_id), COALESCE(SUM(rakeback_amount),0)
    INTO v_players, v_rakeback
    FROM rakeback_periods
   WHERE club_id = v_period.club_id
     AND period_start >= v_period.start_at::date
     AND period_start <= v_period.end_at::date;

  v_platform_fee := round(v_rake * 0.10, 2);

  SELECT name INTO v_club_name FROM clubs WHERE id = v_period.club_id;

  SELECT status INTO v_inv_status
    FROM settlement_invoices
   WHERE period_id = p_period_id
   ORDER BY created_at DESC LIMIT 1;

  v_club_status := CASE
    WHEN v_inv_status = 'paid' THEN 'finalized'
    WHEN v_period.status = 'disputed' THEN 'disputed'
    ELSE 'pending' END;

  v_clubs := jsonb_build_array(jsonb_build_object(
    'id', v_period.id,
    'periodId', v_period.id,
    'clubId', v_period.club_id,
    'clubName', COALESCE(v_club_name, 'Club'),
    'totalRakeCollected', v_rake,
    'totalJackpotContributions', v_bbj,
    'totalPromoCosts', 0,
    'uniquePlayers', v_players,
    'totalHandsDealt', v_hands,
    'platformFee', v_platform_fee,
    'agentCommissions', v_agent_comm,
    'grossRevenue', v_rake,
    'netRevenue', round(v_rake - v_platform_fee - v_agent_comm, 2),
    'status', v_club_status
  ));

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'periodId', p_period_id,
      'agentId', a.id,
      'agentName', COALESCE(NULLIF(pr.display_name,''), NULLIF(pr.username,''), NULLIF(pr.full_name,''), 'Agent ' || left(a.id::text, 8)),
      'totalRakeGenerated', COALESCE(a.weekly_rake_generated, 0),
      'commissionRate', a.commission_rate,
      'commissionEarned', COALESCE(ac.earned, 0),
      'creditExtended', a.credit_used,
      'creditRepaid', 0,
      'netSettlement', COALESCE(ac.earned, 0),
      'activePlayers', a.active_player_count,
      'status', 'pending',
      'updatedAt', a.updated_at
    ) ORDER BY COALESCE(ac.earned,0) DESC), '[]'::jsonb)
    INTO v_agents
    FROM agents a
    LEFT JOIN profiles pr ON pr.id = a.user_id
    LEFT JOIN LATERAL (
      SELECT SUM(c.amount) AS earned
        FROM agent_commissions c
       WHERE c.user_id = a.user_id AND c.club_id = a.club_id
         AND c.created_at >= v_period.start_at AND c.created_at < v_period.end_at
    ) ac ON true
   WHERE a.club_id = v_period.club_id
     AND a.status = 'active';

  v_wires := jsonb_build_array(jsonb_build_object(
    'clubId', v_period.club_id,
    'clubName', COALESCE(v_club_name, 'Club'),
    'netPlayerPL', 0,
    'grossRake', v_rake,
    'unionTax', v_platform_fee,
    'finalWire', round(v_rake - v_platform_fee, 2),
    'action', CASE WHEN (v_rake - v_platform_fee) >= 0 THEN 'COLLECT_FROM_UNION' ELSE 'PAY_TO_UNION' END
  ));

  RETURN jsonb_build_object(
    'period', jsonb_build_object(
      'id', v_period.id,
      'periodNumber', v_period.period_number,
      'year', v_period.year,
      'startAt', v_period.start_at,
      'endAt', v_period.end_at,
      'status', v_period.status,
      'totalRakeCollected', v_rake,
      'totalBBJContributions', v_bbj,
      'totalPlayerWinnings', COALESCE(v_period.total_player_winnings, 0),
      'totalPlayerLosses', COALESCE(v_period.total_player_losses, 0),
      'totalHandsDealt', v_hands,
      'settledAt', v_period.settled_at,
      'settledBy', v_period.settled_by
    ),
    'clubSettlements', v_clubs,
    'agentSettlements', v_agents,
    'unionWires', v_wires,
    'totalPlatformRevenue', v_platform_fee,
    'totalAgentPayouts', v_agent_comm,
    'totalPlayerRakeback', v_rakeback
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.calculate_agent_settlement(p_period_id uuid, p_agent_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_period record;
  v_agent record;
  v_name text;
  v_earned numeric := 0;
  v_authorized boolean := false;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  SELECT * INTO v_period FROM settlement_periods WHERE id = p_period_id;
  IF v_period.id IS NULL THEN
    RAISE EXCEPTION 'settlement period % not found', p_period_id;
  END IF;

  SELECT * INTO v_agent FROM agents WHERE id = p_agent_id;
  IF v_agent.id IS NULL THEN
    RAISE EXCEPTION 'agent % not found', p_agent_id;
  END IF;

  -- Caller must be the agent, or administer the agent's club or its union
  SELECT (
    v_agent.user_id = v_caller
    OR EXISTS (
      SELECT 1 FROM clubs c
       WHERE c.id = v_agent.club_id
         AND (c.owner_id = v_caller
              OR EXISTS (SELECT 1 FROM club_members cm
                          WHERE cm.club_id = c.id AND cm.user_id = v_caller
                            AND cm.role IN ('owner','co_owner','admin')))
    )
    OR EXISTS (SELECT 1 FROM unions u
                WHERE u.id = v_period.union_id AND u.owner_id = v_caller)
  ) INTO v_authorized;
  IF NOT v_authorized THEN
    RAISE EXCEPTION 'not authorized for this agent settlement';
  END IF;

  SELECT COALESCE(SUM(amount),0) INTO v_earned
    FROM agent_commissions
   WHERE user_id = v_agent.user_id AND club_id = v_agent.club_id
     AND created_at >= v_period.start_at AND created_at < v_period.end_at;

  SELECT COALESCE(NULLIF(display_name,''), NULLIF(username,''), NULLIF(full_name,''))
    INTO v_name FROM profiles WHERE id = v_agent.user_id;

  RETURN jsonb_build_object(
    'id', v_agent.id,
    'periodId', p_period_id,
    'agentId', v_agent.id,
    'agentName', COALESCE(v_name, 'Agent ' || left(v_agent.id::text, 8)),
    'totalRakeGenerated', COALESCE(v_agent.weekly_rake_generated, 0),
    'commissionRate', v_agent.commission_rate,
    'commissionEarned', v_earned,
    'creditExtended', v_agent.credit_used,
    'creditRepaid', 0,
    'netSettlement', v_earned,
    'activePlayers', v_agent.active_player_count,
    'status', 'pending'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.calculate_agent_spread(p_agent_id uuid, p_period_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := (SELECT auth.uid());
  v_agent record;
  v_start timestamptz;
  v_end timestamptz;
  v_own_earned numeric := 0;
  v_sub_earned numeric := 0;
  v_downlines jsonb;
  v_authorized boolean := false;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  SELECT * INTO v_agent FROM agents WHERE id = p_agent_id;
  IF v_agent.id IS NULL THEN
    RAISE EXCEPTION 'agent % not found', p_agent_id;
  END IF;

  SELECT (
    v_agent.user_id = v_caller
    OR EXISTS (
      SELECT 1 FROM clubs c
       WHERE c.id = v_agent.club_id
         AND (c.owner_id = v_caller
              OR EXISTS (SELECT 1 FROM club_members cm
                          WHERE cm.club_id = c.id AND cm.user_id = v_caller
                            AND cm.role IN ('owner','co_owner','admin')))
    )
  ) INTO v_authorized;
  IF NOT v_authorized THEN
    RAISE EXCEPTION 'not authorized for this agent';
  END IF;

  IF p_period_id IS NOT NULL THEN
    SELECT start_at, end_at INTO v_start, v_end
      FROM settlement_periods WHERE id = p_period_id;
    IF v_start IS NULL THEN
      RAISE EXCEPTION 'settlement period % not found', p_period_id;
    END IF;
  ELSE
    v_end := now();
    v_start := now() - interval '7 days';
  END IF;

  SELECT COALESCE(SUM(amount),0) INTO v_own_earned
    FROM agent_commissions
   WHERE user_id = v_agent.user_id AND club_id = v_agent.club_id
     AND created_at >= v_start AND created_at < v_end;

  SELECT COALESCE(SUM(c.amount),0) INTO v_sub_earned
    FROM sub_agents s
    JOIN agent_commissions c
      ON c.user_id = s.user_id AND c.club_id = s.club_id
     AND c.created_at >= v_start AND c.created_at < v_end
   WHERE s.parent_agent_id = v_agent.id AND s.status = 'active';

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'entityId', s.id,
      'entityType', 'agent',
      'name', COALESCE(NULLIF(pr.display_name,''), NULLIF(pr.username,''), NULLIF(pr.full_name,''), 'Sub-agent ' || left(s.id::text, 8)),
      'rate', s.commission_pct,
      'rakeGenerated', s.total_rake_generated,
      'commissionPaid', s.total_commission_paid
    ) ORDER BY s.total_rake_generated DESC), '[]'::jsonb)
    INTO v_downlines
    FROM sub_agents s
    LEFT JOIN profiles pr ON pr.id = s.user_id
   WHERE s.parent_agent_id = v_agent.id;

  RETURN jsonb_build_object(
    'agentId', v_agent.id,
    'grossCommissionRate', v_agent.commission_rate,
    'payoutToDownlines', v_sub_earned,
    'netMargin', v_own_earned,
    'downlineBreakdown', v_downlines
  );
END;
$function$;

-- Lock down: authenticated only (they enforce their own authorization)
REVOKE ALL ON FUNCTION public.generate_period_settlements(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calculate_agent_settlement(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calculate_agent_spread(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_period_settlements(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calculate_agent_settlement(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calculate_agent_spread(uuid, uuid) TO authenticated, service_role;
