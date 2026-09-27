-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260430165151 "x41_credit_agent_commission_uses_referring_agent"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 1be1bd152a8955c5a12fc9ab7b61cddf of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 41 fix: credit_agent_commission_from_rake was looking up
-- agents WHERE user_id = p_agent_user_id, which only matched if the PLAYER
-- WAS THEMSELVES AN AGENT. The caller (RakebackSettlerService) passes a
-- player's user_id from rake_records.player_contributions, expecting the
-- RPC to find that player's REFERRING agent (club_members.agent_id) and
-- credit THAT agent.
--
-- Live evidence: in 24h, 2 referred players generated rake under 1
-- referring agent — that agent received 0 commission credits. Meanwhile,
-- 3 of 4 commission recipients had user_is_agent=true and were credited
-- on their OWN play, not their downline's.
--
-- Fix: rewrite the lookup chain to:
--   1. find player's referring agent_id from club_members
--   2. fall back to "is the player themselves an active agent?" (preserves
--      the existing self-rake credit behavior so we don't regress current
--      live commissions while rolling forward)
--   3. resolve agent.commission_rate
--   4. insert agent_commissions row crediting the AGENT (not the player)
--   5. update agents accumulators (weekly_rake_generated,
--      lifetime_rake_generated, pending_commission, last_active_at)
--
-- Param p_agent_user_id is RETAINED (semantically should be p_player_user_id
-- but renaming would break the PostgREST parameter-name dispatch in the
-- existing caller). Comment in the RPC body documents the intent.

CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake(
  p_agent_user_id  uuid,   -- ← actually the PLAYER's user_id; the RPC finds their referring agent
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
  v_agent_id        UUID;
  v_agent_user_id   UUID;
  v_commission_rate NUMERIC;
  v_commission      NUMERIC;
BEGIN
  -- 1. Try to find the player's REFERRING agent via club_members.
  SELECT a.id, a.user_id, a.commission_rate
  INTO   v_agent_id, v_agent_user_id, v_commission_rate
  FROM   club_members cm
  JOIN   agents a ON a.id = cm.agent_id
  WHERE  cm.user_id = p_agent_user_id
    AND  cm.club_id = p_club_id
    AND  a.status   = 'active'
  LIMIT  1;

  -- 2. Fallback: if no referring agent, see if the player themselves is an
  -- active agent (preserves prior self-rake credit behavior).
  IF v_agent_id IS NULL THEN
    SELECT id, user_id, commission_rate
    INTO   v_agent_id, v_agent_user_id, v_commission_rate
    FROM   agents
    WHERE  user_id = p_agent_user_id
      AND  club_id = p_club_id
      AND  status  = 'active'
    LIMIT  1;
  END IF;

  -- 3. Still nothing → silently return (player has no agent in this club).
  IF v_agent_id IS NULL THEN
    RETURN;
  END IF;

  v_commission := ROUND(p_rake_credit * COALESCE(v_commission_rate, 0), 2);
  IF v_commission <= 0 THEN
    RETURN;
  END IF;

  -- 4. Update the agent's accumulators.
  UPDATE agents SET
    weekly_rake_generated   = COALESCE(weekly_rake_generated, 0)   + p_rake_credit,
    lifetime_rake_generated = COALESCE(lifetime_rake_generated, 0) + p_rake_credit,
    pending_commission      = COALESCE(pending_commission, 0)      + v_commission,
    last_active_at          = NOW(),
    updated_at              = NOW()
  WHERE id = v_agent_id;

  -- 5. Insert the audit row crediting the AGENT (NOT the player).
  -- Note: previously this stored p_agent_user_id (= player's user_id), which
  -- is what made the buggy state look "fine" superficially — every
  -- commission row had the agent-as-player's id when an agent played,
  -- and was simply absent for non-agent players.
  INSERT INTO agent_commissions (
    club_id, user_id, amount, commission_rate, source_type, source_id, notes
  ) VALUES (
    p_club_id,
    v_agent_user_id,           -- ← the AGENT's user_id, not the player's
    v_commission,
    v_commission_rate,
    p_source_type,
    p_source_id,
    p_notes
  );
END;
$function$;
