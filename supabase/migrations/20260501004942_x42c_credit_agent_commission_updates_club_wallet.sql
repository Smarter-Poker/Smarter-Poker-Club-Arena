-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260501004942 "x42c_credit_agent_commission_updates_club_wallet"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6370cf894cb8981c684546793150d3f8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 42 follow-up: credit_agent_commission_from_rake also needs to increment
-- club_wallets.period_commission_paid + lifetime_commission_paid + insert a
-- club_wallet_transactions audit row of type='commission_out' so the period
-- close-out flow + dashboards see the outflow.
--
-- Pre-fix: agents.pending_commission was correctly accumulating per Round 41,
-- but club_wallets never saw the corresponding outflow. The cascading_commission
-- RPC (unused) had this logic; the active rake_settlement RPC did not.

CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake(
  p_agent_user_id  uuid,
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
  v_total_commission    NUMERIC;
  v_balance_after       NUMERIC;
  v_audit_id            UUID;
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
  v_total_commission  := 0;

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
      p_club_id, v_agent_user_id, v_direct_commission, v_commission_rate,
      p_source_type, p_source_id, COALESCE(p_notes, 'agent slice')
    );

    v_total_commission := v_total_commission + v_direct_commission;
  END IF;

  -- 3. Super-agent cascade (one hop up)
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
          p_club_id, v_parent_user_id, v_parent_commission, v_parent_rate,
          p_source_type, p_source_id, 'super-agent slice'
        );

        v_total_commission := v_total_commission + v_parent_commission;
      END IF;
    END IF;
  END IF;

  -- 4. ROUND 42: Update club_wallets accumulator + audit ledger.
  -- The total commission paid out on this player's rake reduces club_wallets.chip_balance
  -- (it's an OUTFLOW from the club to agents) and increments period/lifetime_commission_paid.
  IF v_total_commission > 0 THEN
    UPDATE club_wallets
       SET period_commission_paid    = period_commission_paid    + v_total_commission,
           lifetime_commission_paid  = lifetime_commission_paid  + v_total_commission,
           chip_balance              = chip_balance              - v_total_commission,
           updated_at                = NOW()
     WHERE club_id = p_club_id
     RETURNING chip_balance INTO v_balance_after;

    IF v_balance_after IS NOT NULL THEN
      INSERT INTO club_wallet_transactions (
        club_id, type, amount, balance_after, related_id, reason
      ) VALUES (
        p_club_id, 'commission_out', -v_total_commission, v_balance_after, p_source_id,
        'Agent commission paid (rake-share for player ' || p_agent_user_id::text || ')'
      );
    END IF;
  END IF;
END;
$function$;
