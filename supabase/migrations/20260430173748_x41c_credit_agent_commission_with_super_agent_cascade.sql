-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260430173748 "x41c_credit_agent_commission_with_super_agent_cascade"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f0bc1cbad6acc521bc9ed2a7e078cc24 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 41 RE-RUN: extend credit_agent_commission_from_rake to walk one hop up
-- the agent tree via agents.parent_agent_id and credit the super-agent too.
--
-- Design (matches the convention in the unused calculate_cascading_commission
-- RPC that uses player_agent_assignments — same "take from remaining" cascade
-- but driven by agents.parent_agent_id which IS the live schema):
--
--   1. Find direct agent (referring) via club_members.agent_id → credit them
--      with commission = rake × direct_rate.
--   2. If direct.parent_agent_id is set AND that parent is active in the same
--      club, credit the parent with commission = (rake - direct_commission) ×
--      parent_rate. Same pattern as calculate_cascading_commission's
--      "remaining" cascade.
--   3. Stop after one hop. (Schema currently has 0 rows with parent_agent_id
--      populated, so this code path is defensive — when Dan starts onboarding
--      super-agents it will activate without further changes.)
--
-- Self-agent fallback (player IS themselves an active agent) is preserved
-- with the same one-hop super-agent walk.

CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake(
  p_agent_user_id  uuid,   -- ← actually the PLAYER's user_id
  p_club_id        uuid,
  p_rake_credit    numeric,
  p_source_type    text DEFAULT 'rake_settlement'::text,
  p_source_id      uuid DEFAULT NULL::uuid,
  p_notes          text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent_id            UUID;
  v_agent_user_id       UUID;
  v_commission_rate     NUMERIC;
  v_parent_agent_id     UUID;
  v_parent_user_id      UUID;
  v_parent_rate         NUMERIC;
  v_direct_commission   NUMERIC;
  v_parent_commission   NUMERIC;
  v_remaining           NUMERIC;
BEGIN
  -- 1. Direct agent — via club_members, fallback to self-agent
  SELECT a.id, a.user_id, a.commission_rate, a.parent_agent_id
  INTO   v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
  FROM   club_members cm
  JOIN   agents a
         ON a.user_id = cm.agent_id
        AND a.club_id = cm.club_id
        AND a.status  = 'active'
  WHERE  cm.user_id = p_agent_user_id
    AND  cm.club_id = p_club_id
  LIMIT  1;

  IF v_agent_id IS NULL THEN
    SELECT id, user_id, commission_rate, parent_agent_id
    INTO   v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
    FROM   agents
    WHERE  user_id = p_agent_user_id
      AND  club_id = p_club_id
      AND  status  = 'active'
    LIMIT  1;
  END IF;

  IF v_agent_id IS NULL THEN
    RETURN;
  END IF;

  v_direct_commission := ROUND(p_rake_credit * COALESCE(v_commission_rate, 0), 2);
  v_remaining         := p_rake_credit - v_direct_commission;

  -- 2. Credit the direct agent
  IF v_direct_commission > 0 THEN
    UPDATE agents SET
      weekly_rake_generated   = COALESCE(weekly_rake_generated, 0)   + p_rake_credit,
      lifetime_rake_generated = COALESCE(lifetime_rake_generated, 0) + p_rake_credit,
      pending_commission      = COALESCE(pending_commission, 0)      + v_direct_commission,
      last_active_at          = NOW(),
      updated_at              = NOW()
    WHERE id = v_agent_id;

    INSERT INTO agent_commissions (
      club_id, user_id, amount, commission_rate, source_type, source_id, notes
    ) VALUES (
      p_club_id,
      v_agent_user_id,
      v_direct_commission,
      v_commission_rate,
      p_source_type,
      p_source_id,
      COALESCE(p_notes, 'agent slice')
    );
  END IF;

  -- 3. Super-agent cascade (one hop up) — only if direct has a parent
  IF v_parent_agent_id IS NOT NULL AND v_remaining > 0 THEN
    SELECT id, user_id, commission_rate
    INTO   v_parent_agent_id, v_parent_user_id, v_parent_rate
    FROM   agents
    WHERE  id      = v_parent_agent_id
      AND  club_id = p_club_id
      AND  status  = 'active'
    LIMIT  1;

    IF v_parent_agent_id IS NOT NULL AND v_parent_rate IS NOT NULL THEN
      v_parent_commission := ROUND(v_remaining * v_parent_rate, 2);
      IF v_parent_commission > 0 THEN
        UPDATE agents SET
          pending_commission = COALESCE(pending_commission, 0) + v_parent_commission,
          last_active_at     = NOW(),
          updated_at         = NOW()
        WHERE id = v_parent_agent_id;

        INSERT INTO agent_commissions (
          club_id, user_id, amount, commission_rate, source_type, source_id, notes
        ) VALUES (
          p_club_id,
          v_parent_user_id,
          v_parent_commission,
          v_parent_rate,
          p_source_type,
          p_source_id,
          'super-agent slice'
        );
      END IF;
    END IF;
  END IF;
END;
$function$;
