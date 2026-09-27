-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820134820 "union_law_p4_agent_policy_enforcement"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2b0ea196e1ad3e01062fa309aebc5503 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- P4 — UNION AGENT POLICY IS ENFORCED, NOT DECORATIVE (2026-08-20)
--
-- unions.settings already declares the commercial policy:
--   min_agent_commission 0.40, max 0.70, default 0.50
--   require_agent_for_players: true
--   allow_sub_agents: true
-- None of it was enforced. Commission rates could be set to any value, and
-- 1,299 of 1,483 members have no agent at all despite the policy.
--
-- This adds:
--   * a trigger clamping agents.commission_rate to the union's declared bounds
--     (rejects out-of-band values rather than silently mangling them),
--   * fn_assign_player_to_agent — the supported way to attach a player to an
--     agent, with membership + union validation,
--   * fn_union_agent_coverage — reports policy compliance so the shortfall is
--     visible instead of implicit.
--
-- Deliberately NOT done: auto-assigning the 1,299 unagented players. Which
-- agent owns which player is a commercial decision and inventing it would
-- misdirect real commission payments.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_union_setting(p_union_id uuid, p_key text, p_default numeric)
 RETURNS numeric
 LANGUAGE sql STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((settings ->> p_key)::numeric, p_default)
    FROM unions WHERE id = p_union_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_enforce_agent_commission_bounds()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid; v_min numeric; v_max numeric; v_rate numeric;
BEGIN
  IF NEW.commission_rate IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(uc.union_id, c.union_id) INTO v_union
    FROM clubs c LEFT JOIN union_clubs uc ON uc.club_id = c.id
   WHERE c.id = NEW.club_id LIMIT 1;

  IF v_union IS NULL THEN RETURN NEW; END IF;   -- standalone club: no policy

  v_min := public.fn_union_setting(v_union, 'min_agent_commission', 0);
  v_max := public.fn_union_setting(v_union, 'max_agent_commission', 1);

  -- Rates may be expressed as a fraction (0.5) or whole percent (50).
  v_rate := CASE WHEN NEW.commission_rate > 1 THEN NEW.commission_rate / 100.0
                 ELSE NEW.commission_rate END;

  IF v_rate < v_min OR v_rate > v_max THEN
    RAISE EXCEPTION 'agent commission % is outside the union policy band (% .. %)',
      v_rate, v_min, v_max
      USING HINT = 'Change unions.settings.min_agent_commission / max_agent_commission to widen the band.';
  END IF;

  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_agents_commission_bounds ON public.agents;
CREATE TRIGGER trg_agents_commission_bounds
  BEFORE INSERT OR UPDATE OF commission_rate ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.fn_enforce_agent_commission_bounds();

-- Supported way to attach a player to an agent ------------------------------
CREATE OR REPLACE FUNCTION public.fn_assign_player_to_agent(p_player_user_id uuid, p_agent_user_id uuid, p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_agent record; v_is_member boolean;
BEGIN
  IF NOT public.fn_is_any_union_overseer(auth.uid())
     AND auth.uid() IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM agents a
                      WHERE a.user_id = auth.uid() AND a.club_id = p_club_id
                        AND a.status = 'active') THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  SELECT a.id, a.user_id, a.club_id INTO v_agent
    FROM agents a
   WHERE a.user_id = p_agent_user_id AND a.club_id = p_club_id AND a.status = 'active';
  IF v_agent.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent_not_active_in_club');
  END IF;

  IF p_player_user_id = p_agent_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent_cannot_be_own_player');
  END IF;

  SELECT EXISTS (SELECT 1 FROM club_members
                  WHERE user_id = p_player_user_id AND club_id = p_club_id)
    INTO v_is_member;
  IF NOT v_is_member THEN
    RETURN jsonb_build_object('success', false, 'error', 'player_not_member_of_club');
  END IF;

  UPDATE club_members
     SET agent_id = p_agent_user_id, updated_at = now()
   WHERE user_id = p_player_user_id AND club_id = p_club_id;

  UPDATE agents
     SET total_players = (SELECT count(*) FROM club_members
                           WHERE agent_id = p_agent_user_id AND club_id = p_club_id),
         updated_at = now()
   WHERE id = v_agent.id;

  INSERT INTO audit_trail (actor_id, actor_role, action, target_type, target_id, reason)
  VALUES (COALESCE(auth.uid(), p_agent_user_id), 'agent', 'assign_player_to_agent',
          'club_member', p_player_user_id,
          'agent ' || p_agent_user_id::text || ' in club ' || p_club_id::text);

  RETURN jsonb_build_object('success', true, 'player_id', p_player_user_id,
                            'agent_id', p_agent_user_id, 'club_id', p_club_id);
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_assign_player_to_agent(uuid, uuid, uuid) TO authenticated;

-- Policy compliance report --------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_union_agent_coverage(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001')
 RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_required boolean;
  v_total bigint; v_with bigint; v_agents bigint; v_supers bigint; v_linked bigint;
  v_out_of_band bigint;
BEGIN
  SELECT COALESCE((settings->>'require_agent_for_players')::boolean, false)
    INTO v_required FROM unions WHERE id = p_union_id;

  SELECT count(*), count(*) FILTER (WHERE m.agent_id IS NOT NULL)
    INTO v_total, v_with
    FROM club_members m
    JOIN union_clubs uc ON uc.club_id = m.club_id AND uc.union_id = p_union_id;

  SELECT count(*) FILTER (WHERE COALESCE(a.role,'agent') = 'agent'),
         count(*) FILTER (WHERE a.role = 'super_agent'),
         count(*) FILTER (WHERE a.parent_agent_id IS NOT NULL)
    INTO v_agents, v_supers, v_linked
    FROM agents a
    JOIN union_clubs uc ON uc.club_id = a.club_id AND uc.union_id = p_union_id
   WHERE a.status = 'active';

  SELECT count(*) INTO v_out_of_band
    FROM agents a
    JOIN union_clubs uc ON uc.club_id = a.club_id AND uc.union_id = p_union_id
   WHERE a.status = 'active' AND a.commission_rate IS NOT NULL
     AND (CASE WHEN a.commission_rate > 1 THEN a.commission_rate/100.0 ELSE a.commission_rate END)
         NOT BETWEEN public.fn_union_setting(p_union_id,'min_agent_commission',0)
                 AND public.fn_union_setting(p_union_id,'max_agent_commission',1);

  RETURN jsonb_build_object(
    'require_agent_for_players', v_required,
    'members_total', v_total,
    'members_with_agent', v_with,
    'members_without_agent', v_total - v_with,
    'coverage_pct', CASE WHEN v_total > 0 THEN round(100.0*v_with/v_total, 1) ELSE 0 END,
    'active_agents', v_agents,
    'super_agents', v_supers,
    'agents_linked_to_super_agent', v_linked,
    'commission_rates_out_of_policy', v_out_of_band,
    'policy_band', jsonb_build_object(
      'min', public.fn_union_setting(p_union_id,'min_agent_commission',0),
      'max', public.fn_union_setting(p_union_id,'max_agent_commission',1),
      'default', public.fn_union_setting(p_union_id,'default_agent_commission',0.5))
  );
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_union_agent_coverage(uuid) TO authenticated;

