-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820134306 "union_law_p3_agent_credit_limits_and_precision"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 28a822ded2327f88a3223a2fd3eb37bc of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- P3 — AGENT CREDIT LIMITS, PRECISION AND AUTHORITY (2026-08-20)
--
-- Three defects in transfer_chips_agent_to_player:
--
-- 1. NO CREDIT SUPPORT. In the PokerBros model an agent either works PREPAID
--    (must hold the chips) or on a CREDIT LINE (may go negative up to
--    credit_limit, and settles weekly). 33 agents have a credit_limit set and
--    it was never consulted: a credit agent was hard-blocked at zero balance,
--    so the credit line was decorative.
--
-- 2. SILENT MONEY LOSS. chip_balance is numeric, but both updates cast the
--    amount with `p_amount::integer`. Every fractional transfer was rounded —
--    the agent could be debited a different amount than the player was
--    credited, quietly creating or destroying chips.
--
-- 3. NO AUTHORITY CHECK. Nothing verified the sender was an active agent of
--    that club, so any member could move chips agent-style.
--
-- credit_used is now maintained so weekly settlement and the risk report show
-- a real outstanding credit position per agent.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.transfer_chips_agent_to_player(p_agent_user_id uuid, p_player_user_id uuid, p_club_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_agent_before numeric;
  v_agent_after numeric;
  v_player_before numeric;
  v_player_after numeric;
  v_agent record;
  v_shortfall numeric := 0;
  v_new_credit_used numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'amount must be > 0');
  END IF;

  -- Caller identity guard: a JWT caller may only move their own chips.
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_agent_user_id
     AND NOT public.fn_is_any_union_overseer(auth.uid()) THEN
    RETURN jsonb_build_object('success', false, 'error', 'cannot transfer on behalf of another agent');
  END IF;

  SELECT a.id, a.user_id, COALESCE(a.is_prepaid, true) AS is_prepaid,
         COALESCE(a.credit_limit, 0) AS credit_limit,
         COALESCE(a.credit_used, 0) AS credit_used
    INTO v_agent
    FROM agents a
   WHERE a.user_id = p_agent_user_id AND a.club_id = p_club_id AND a.status = 'active'
   FOR UPDATE;

  IF v_agent.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not an active agent of this club');
  END IF;

  SELECT COALESCE(chip_balance, 0) INTO v_agent_before
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_agent_user_id FOR UPDATE;

  IF v_agent_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'agent is not a member of this club');
  END IF;

  -- Credit line: a non-prepaid agent may go short up to their remaining limit.
  IF v_agent_before < p_amount THEN
    v_shortfall := p_amount - v_agent_before;
    IF v_agent.is_prepaid THEN
      RETURN jsonb_build_object('success', false, 'error', 'agent has insufficient chips',
                                'balance', v_agent_before, 'requested', p_amount,
                                'prepaid', true);
    END IF;
    IF v_agent.credit_used + v_shortfall > v_agent.credit_limit THEN
      RETURN jsonb_build_object('success', false, 'error', 'agent credit limit exceeded',
                                'balance', v_agent_before, 'requested', p_amount,
                                'credit_limit', v_agent.credit_limit,
                                'credit_used', v_agent.credit_used,
                                'shortfall', v_shortfall);
    END IF;
  END IF;

  -- Debit agent. NOTE: no ::integer cast — that truncation lost fractions.
  UPDATE club_members
     SET chip_balance = COALESCE(chip_balance,0) - p_amount, updated_at = NOW()
   WHERE club_id = p_club_id AND user_id = p_agent_user_id;
  v_agent_after := v_agent_before - p_amount;

  IF v_shortfall > 0 THEN
    UPDATE agents
       SET credit_used = COALESCE(credit_used,0) + v_shortfall, updated_at = NOW()
     WHERE id = v_agent.id
    RETURNING credit_used INTO v_new_credit_used;
  ELSE
    v_new_credit_used := v_agent.credit_used;
  END IF;

  SELECT COALESCE(chip_balance, 0) INTO v_player_before
    FROM club_members
   WHERE club_id = p_club_id AND user_id = p_player_user_id FOR UPDATE;

  IF v_player_before IS NULL THEN
    INSERT INTO club_members (club_id, user_id, role, chip_balance, joined_at, created_at, updated_at, status, is_active, agent_id)
    VALUES (p_club_id, p_player_user_id, 'player', p_amount, NOW(), NOW(), NOW(), 'active', true, p_agent_user_id)
    ON CONFLICT (club_id, user_id) DO UPDATE
      SET chip_balance = COALESCE(club_members.chip_balance, 0) + EXCLUDED.chip_balance,
          updated_at = NOW();
    v_player_before := 0;
    v_player_after := p_amount;
  ELSE
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = NOW()
     WHERE club_id = p_club_id AND user_id = p_player_user_id;
    v_player_after := v_player_before + p_amount;
  END IF;

  INSERT INTO chip_transactions (
    id, club_id, from_user_id, to_user_id, amount,
    transaction_type, notes, balance_after, created_at
  ) VALUES (
    gen_random_uuid(), p_club_id, p_agent_user_id, p_player_user_id, p_amount,
    'agent_to_player_transfer',
    'Agent→player chip transfer'
      || CASE WHEN v_shortfall > 0 THEN ' (on credit: ' || v_shortfall::text || ')' ELSE '' END,
    v_player_after, NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'transferred', p_amount,
    'agent_before', v_agent_before, 'agent_after', v_agent_after,
    'player_before', v_player_before, 'player_after', v_player_after,
    'on_credit', v_shortfall, 'credit_used', v_new_credit_used,
    'credit_limit', v_agent.credit_limit
  );
END;
$function$;

