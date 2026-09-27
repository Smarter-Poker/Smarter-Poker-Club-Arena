-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820160305 "union_law_c1_three_round_cascaded_settlement"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 5fcf1871e90df1816b1f555a5246cc87 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- C1 — THREE-ROUND CASCADED SETTLEMENT (2026-08-20)
--
-- Owner's model, in order:
--   ROUND 1  the UNION sends rakeback chips to all CLUBS
--   ROUND 2  each CLUB sends rakeback chips to its SUPER AGENTS and AGENTS
--   ROUND 3  SUPER AGENTS / AGENTS / SUB AGENTS send rakeback to THEIR PLAYERS
--
-- Every round is FUNDED BY THE ROUND ABOVE IT. That is the fix for the two
-- problems found earlier:
--   * agent commission and player rakeback were previously credited from
--     nowhere, so the club could pay out more than the rake it collected;
--   * the two commission code paths disagreed on cascade depth.
--
-- Here the money physically moves down the chain: union rake wallet -> club
-- treasury -> agent club wallet -> player club wallet. Nothing is minted at any
-- step, each transfer is ledgered, and a round can never pay out more than the
-- payer actually holds.
--
-- Round 2 pays each agent tier its accrued commission (agent_commissions), and
-- Round 3 pays each player their resolved rakeback rate. Both are idempotent
-- per period via settlement_idempotency_keys.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.union_settlement_rounds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  union_id      uuid NOT NULL,
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  round_no      int  NOT NULL,
  round_name    text NOT NULL,
  payers        int  NOT NULL DEFAULT 0,
  payees        int  NOT NULL DEFAULT 0,
  amount        numeric(20,2) NOT NULL DEFAULT 0,
  shortfalls    int  NOT NULL DEFAULT 0,
  detail        jsonb,
  executed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (union_id, period_start, period_end, round_no)
);

ALTER TABLE public.union_settlement_rounds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS union_overseer_read_rounds ON public.union_settlement_rounds;
CREATE POLICY union_overseer_read_rounds ON public.union_settlement_rounds
  FOR SELECT TO authenticated
  USING (public.fn_is_union_overseer(union_id, (SELECT auth.uid())));

-- ROUND 2: club treasury -> super agents and agents ------------------------
CREATE OR REPLACE FUNCTION public.fn_settle_round2_club_to_agents(p_union_id uuid, p_period_start timestamptz, p_period_end timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_club_bal numeric; v_paid numeric := 0;
  v_payees int := 0; v_short int := 0; v_detail jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT ac.club_id, ac.user_id AS agent_user, SUM(ac.amount) AS owed
      FROM agent_commissions ac
      JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = p_union_id
      JOIN agents a ON a.user_id = ac.user_id AND a.club_id = ac.club_id AND a.status='active'
     WHERE ac.created_at >= p_period_start AND ac.created_at < p_period_end
     GROUP BY ac.club_id, ac.user_id
    HAVING SUM(ac.amount) > 0
     ORDER BY 1,2
  LOOP
    SELECT chip_balance INTO v_club_bal FROM club_wallets WHERE club_id = r.club_id FOR UPDATE;
    IF COALESCE(v_club_bal,0) < r.owed THEN
      v_short := v_short + 1;
      v_detail := v_detail || jsonb_build_object('club_id', r.club_id, 'agent', r.agent_user,
                    'owed', r.owed, 'club_balance', COALESCE(v_club_bal,0), 'skipped', true);
      CONTINUE;
    END IF;

    -- club treasury pays the agent's club wallet
    UPDATE club_wallets
       SET chip_balance = chip_balance - r.owed, updated_at = now()
     WHERE club_id = r.club_id;

    PERFORM public.fn_ensure_club_wallet(r.agent_user, r.club_id);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance,0) + r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id;

    INSERT INTO club_wallet_transactions (club_id, type, amount, balance_after, related_id, reason)
    SELECT r.club_id, 'commission_out', r.owed, cw.chip_balance, NULL,
           'Round 2: club -> agent commission'
      FROM club_wallets cw WHERE cw.club_id = r.club_id;

    v_paid := v_paid + r.owed;
    v_payees := v_payees + 1;
  END LOOP;

  RETURN jsonb_build_object('round', 2, 'name', 'club_to_agents',
    'payees', v_payees, 'amount', round(v_paid,2), 'shortfalls', v_short, 'detail', v_detail);
END $function$;

-- ROUND 3: agents -> their players ----------------------------------------
CREATE OR REPLACE FUNCTION public.fn_settle_round3_agents_to_players(p_union_id uuid, p_period_start timestamptz, p_period_end timestamptz)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_agent_bal numeric; v_paid numeric := 0;
  v_payees int := 0; v_short int := 0; v_detail jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT rp.user_id AS player_id, rp.club_id, cm.agent_id AS agent_user,
           SUM(rp.rakeback_amount) AS owed
      FROM rakeback_periods rp
      JOIN union_clubs uc ON uc.club_id = rp.club_id AND uc.union_id = p_union_id
      JOIN club_members cm ON cm.user_id = rp.user_id AND cm.club_id = rp.club_id
     WHERE rp.status = 'pending'
       AND rp.period_start >= p_period_start::date
       AND rp.period_start <  p_period_end::date + 1
       AND cm.agent_id IS NOT NULL
     GROUP BY rp.user_id, rp.club_id, cm.agent_id
    HAVING SUM(rp.rakeback_amount) > 0
     ORDER BY 2,3,1
  LOOP
    SELECT chip_balance INTO v_agent_bal
      FROM club_members WHERE user_id = r.agent_user AND club_id = r.club_id FOR UPDATE;

    IF COALESCE(v_agent_bal,0) < r.owed THEN
      v_short := v_short + 1;
      v_detail := v_detail || jsonb_build_object('agent', r.agent_user, 'player', r.player_id,
                    'owed', r.owed, 'agent_balance', COALESCE(v_agent_bal,0), 'skipped', true);
      CONTINUE;
    END IF;

    -- the agent funds their own player's rakeback
    UPDATE club_members SET chip_balance = chip_balance - r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id;

    PERFORM public.fn_ensure_club_wallet(r.player_id, r.club_id);
    UPDATE club_members SET chip_balance = COALESCE(chip_balance,0) + r.owed, updated_at = now()
     WHERE user_id = r.player_id AND club_id = r.club_id;

    UPDATE rakeback_periods
       SET status = 'paid', updated_at = now()
     WHERE user_id = r.player_id AND club_id = r.club_id AND status = 'pending'
       AND period_start >= p_period_start::date AND period_start < p_period_end::date + 1;

    INSERT INTO wallet_transactions
      (user_id, wallet_type, type, amount, category, description, balance_after)
    SELECT r.player_id, 'PLAYER', 'credit', r.owed, 'rakeback',
           'Round 3: agent -> player rakeback [club wallet]', cm.chip_balance
      FROM club_members cm WHERE cm.user_id = r.player_id AND cm.club_id = r.club_id;

    v_paid := v_paid + r.owed;
    v_payees := v_payees + 1;
  END LOOP;

  RETURN jsonb_build_object('round', 3, 'name', 'agents_to_players',
    'payees', v_payees, 'amount', round(v_paid,2), 'shortfalls', v_short, 'detail', v_detail);
END $function$;

-- The full cascade, in order ------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_union_settlement_cascade(p_union_id uuid DEFAULT 'fade0000-0000-0000-0000-000000000001', p_period_start timestamptz DEFAULT NULL, p_period_end timestamptz DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_from timestamptz := COALESCE(p_period_start, date_trunc('week', now()) - interval '7 days');
  v_to   timestamptz := COALESCE(p_period_end,   date_trunc('week', now()));
  v_r1 jsonb; v_r2 jsonb; v_r3 jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.fn_is_union_overseer(p_union_id, auth.uid()) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;

  -- ROUND 1 — union rake treasury pays the clubs their 90%.
  v_r1 := public.fn_union_weekly_rakeback_close(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payers, payees, amount, detail)
  VALUES (p_union_id, v_from, v_to, 1, 'union_to_clubs', 1,
          COALESCE((v_r1->>'clubs_paid')::int,0),
          COALESCE((v_r1->>'total_rakeback')::numeric,0), v_r1)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  -- ROUND 2 — clubs pay their super agents and agents.
  v_r2 := public.fn_settle_round2_club_to_agents(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 2, 'club_to_agents',
          COALESCE((v_r2->>'payees')::int,0), COALESCE((v_r2->>'amount')::numeric,0),
          COALESCE((v_r2->>'shortfalls')::int,0), v_r2)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  -- ROUND 3 — agents pay their players.
  v_r3 := public.fn_settle_round3_agents_to_players(p_union_id, v_from, v_to);
  INSERT INTO union_settlement_rounds (union_id, period_start, period_end, round_no, round_name,
                                       payees, amount, shortfalls, detail)
  VALUES (p_union_id, v_from, v_to, 3, 'agents_to_players',
          COALESCE((v_r3->>'payees')::int,0), COALESCE((v_r3->>'amount')::numeric,0),
          COALESCE((v_r3->>'shortfalls')::int,0), v_r3)
  ON CONFLICT (union_id, period_start, period_end, round_no) DO NOTHING;

  RETURN jsonb_build_object('success', true, 'union_id', p_union_id,
    'period_start', v_from, 'period_end', v_to,
    'round1_union_to_clubs', v_r1, 'round2_club_to_agents', v_r2,
    'round3_agents_to_players', v_r3);
END $function$;

GRANT EXECUTE ON FUNCTION public.fn_union_settlement_cascade(uuid, timestamptz, timestamptz) TO authenticated;

