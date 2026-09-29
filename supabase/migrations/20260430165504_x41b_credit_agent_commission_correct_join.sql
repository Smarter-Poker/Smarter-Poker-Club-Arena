-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260430165504 "x41b_credit_agent_commission_correct_join"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f296d40620d022d40190b61c703dc89c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 41 follow-up: club_members.agent_id stores the agent's USER_id
-- (not agents.id), despite the misleading column name. Re-apply the RPC
-- with a.user_id = cm.agent_id (and same club).

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
  v_agent_id        UUID;
  v_agent_user_id   UUID;
  v_commission_rate NUMERIC;
  v_commission      NUMERIC;
BEGIN
  -- 1. Try to find the player's REFERRING agent via club_members.
  --    NOTE: club_members.agent_id stores the agent's user_id (NOT agents.id).
  SELECT a.id, a.user_id, a.commission_rate
  INTO   v_agent_id, v_agent_user_id, v_commission_rate
  FROM   club_members cm
  JOIN   agents a
         ON a.user_id = cm.agent_id   -- referrer's user_id, not agents.id
        AND a.club_id = cm.club_id
        AND a.status  = 'active'
  WHERE  cm.user_id = p_agent_user_id
    AND  cm.club_id = p_club_id
  LIMIT  1;

  -- 2. Fallback: player themselves is an active agent.
  IF v_agent_id IS NULL THEN
    SELECT id, user_id, commission_rate
    INTO   v_agent_id, v_agent_user_id, v_commission_rate
    FROM   agents
    WHERE  user_id = p_agent_user_id
      AND  club_id = p_club_id
      AND  status  = 'active'
    LIMIT  1;
  END IF;

  IF v_agent_id IS NULL THEN
    RETURN;
  END IF;

  v_commission := ROUND(p_rake_credit * COALESCE(v_commission_rate, 0), 2);
  IF v_commission <= 0 THEN
    RETURN;
  END IF;

  UPDATE agents SET
    weekly_rake_generated   = COALESCE(weekly_rake_generated, 0)   + p_rake_credit,
    lifetime_rake_generated = COALESCE(lifetime_rake_generated, 0) + p_rake_credit,
    pending_commission      = COALESCE(pending_commission, 0)      + v_commission,
    last_active_at          = NOW(),
    updated_at              = NOW()
  WHERE id = v_agent_id;

  INSERT INTO agent_commissions (
    club_id, user_id, amount, commission_rate, source_type, source_id, notes
  ) VALUES (
    p_club_id,
    v_agent_user_id,
    v_commission,
    v_commission_rate,
    p_source_type,
    p_source_id,
    p_notes
  );
END;
$function$;
