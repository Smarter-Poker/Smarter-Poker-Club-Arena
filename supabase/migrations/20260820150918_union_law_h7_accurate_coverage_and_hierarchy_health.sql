-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820150918 "union_law_h7_accurate_coverage_and_hierarchy_health"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c38a3a43303858bc41b7f965ede7768e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- H7 — ACCURATE COVERAGE + HIERARCHY HEALTH (2026-08-20)
--
-- fn_union_agent_coverage counted EVERY member without an upline as a policy
-- gap, including club owners and super agents — who are top of chain and
-- correctly have nobody above them. That made a fully-populated hierarchy read
-- as permanently non-compliant, which is the fastest way to get a warning
-- ignored.
--
-- Coverage now measures what the policy actually says: every PLAYER has an
-- agent. Tier linkage (agents under super agents, sub-agents under agents) is
-- reported separately, and orphaned tiers are surfaced as their own signal.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_union_agent_coverage(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001')
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_required boolean;
  v_players bigint; v_players_with bigint;
  v_supers bigint; v_agents bigint; v_subs bigint;
  v_agents_linked bigint; v_subs_linked bigint;
  v_agents_with_subs bigint; v_out_of_band bigint;
  v_deals bigint; v_gap_breaches bigint;
BEGIN
  SELECT COALESCE((settings->>'require_agent_for_players')::boolean, false)
    INTO v_required FROM unions WHERE id = p_union_id;

  SELECT count(*) FILTER (WHERE m.role = 'player'),
         count(*) FILTER (WHERE m.role = 'player' AND m.agent_id IS NOT NULL)
    INTO v_players, v_players_with
    FROM club_members m
    JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = p_union_id;

  SELECT count(*) FILTER (WHERE a.role='super_agent'),
         count(*) FILTER (WHERE a.role='agent'),
         count(*) FILTER (WHERE a.role='sub_agent'),
         count(*) FILTER (WHERE a.role='agent'     AND a.parent_agent_id IS NOT NULL),
         count(*) FILTER (WHERE a.role='sub_agent' AND a.parent_agent_id IS NOT NULL)
    INTO v_supers, v_agents, v_subs, v_agents_linked, v_subs_linked
    FROM agents a
    JOIN union_clubs uc ON uc.club_id = a.club_id AND uc.union_id = p_union_id
   WHERE a.status = 'active';

  SELECT count(*) INTO v_agents_with_subs
    FROM agents a
    JOIN union_clubs uc ON uc.club_id = a.club_id AND uc.union_id = p_union_id
   WHERE a.status='active' AND a.role='agent'
     AND EXISTS (SELECT 1 FROM agents s WHERE s.parent_agent_id = a.id AND s.status='active');

  SELECT count(*) INTO v_out_of_band
    FROM agents a
    JOIN union_clubs uc ON uc.club_id = a.club_id AND uc.union_id = p_union_id
   WHERE a.status='active' AND a.commission_rate IS NOT NULL
     AND (CASE WHEN a.commission_rate > 1 THEN a.commission_rate/100.0 ELSE a.commission_rate END)
         NOT BETWEEN public.fn_union_setting(p_union_id,'min_agent_commission',0)
                 AND public.fn_union_setting(p_union_id,'max_agent_commission',1);

  SELECT count(*) FILTER (WHERE COALESCE(m.player_rakeback_pct,0) > 0),
         count(*) FILTER (WHERE COALESCE(m.player_rakeback_pct,0) > 0
                            AND m.player_rakeback_pct * 100 > floor((a.commission_rate*100) - 10))
    INTO v_deals, v_gap_breaches
    FROM club_members m
    JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = p_union_id
    JOIN agents a ON a.user_id = m.agent_id AND a.club_id = m.club_id AND a.status='active'
   WHERE m.role = 'player';

  RETURN jsonb_build_object(
    'require_agent_for_players', v_required,
    'players_total', v_players,
    'players_with_agent', v_players_with,
    'players_without_agent', v_players - v_players_with,
    'player_coverage_pct', CASE WHEN v_players > 0
                                THEN round(100.0*v_players_with/v_players, 1) ELSE 100 END,
    'super_agents', v_supers,
    'agents', v_agents,
    'sub_agents', v_subs,
    'agents_under_a_super_agent', v_agents_linked,
    'agents_orphaned', v_agents - v_agents_linked,
    'sub_agents_under_an_agent', v_subs_linked,
    'sub_agents_orphaned', v_subs - v_subs_linked,
    'agents_that_have_sub_agents', v_agents_with_subs,
    'commission_rates_out_of_policy', v_out_of_band,
    'player_rakeback_deals', v_deals,
    'player_rakeback_gap_breaches', v_gap_breaches,
    'policy_band', jsonb_build_object(
      'min', public.fn_union_setting(p_union_id,'min_agent_commission',0),
      'max', public.fn_union_setting(p_union_id,'max_agent_commission',1))
  );
END $function$;

-- The self-test warning should track PLAYERS, plus orphaned tiers and any
-- rakeback deal that breaches the gap rule.
CREATE OR REPLACE FUNCTION public.fn_union_hierarchy_warnings()
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_c jsonb; v_out jsonb := '[]'::jsonb;
BEGIN
  v_c := public.fn_union_agent_coverage();

  IF (v_c->>'players_without_agent')::bigint > 0 THEN
    v_out := v_out || jsonb_build_object('check','players_without_agent',
      'count', (v_c->>'players_without_agent')::bigint);
  END IF;
  IF (v_c->>'agents_orphaned')::bigint > 0 THEN
    v_out := v_out || jsonb_build_object('check','agents_without_super_agent',
      'count', (v_c->>'agents_orphaned')::bigint);
  END IF;
  IF (v_c->>'sub_agents_orphaned')::bigint > 0 THEN
    v_out := v_out || jsonb_build_object('check','sub_agents_without_agent',
      'count', (v_c->>'sub_agents_orphaned')::bigint);
  END IF;
  IF (v_c->>'player_rakeback_gap_breaches')::bigint > 0 THEN
    v_out := v_out || jsonb_build_object('check','player_rakeback_exceeds_upline',
      'count', (v_c->>'player_rakeback_gap_breaches')::bigint);
  END IF;
  IF (v_c->>'commission_rates_out_of_policy')::bigint > 0 THEN
    v_out := v_out || jsonb_build_object('check','commission_rate_out_of_policy',
      'count', (v_c->>'commission_rates_out_of_policy')::bigint);
  END IF;

  RETURN v_out;
END $function$;

