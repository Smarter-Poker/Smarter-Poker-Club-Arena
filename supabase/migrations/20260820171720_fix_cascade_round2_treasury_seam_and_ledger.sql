-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820171720 "fix_cascade_round2_treasury_seam_and_ledger"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f0833a01a84208af70cbf3f3619e5f65 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- THE CASCADE WAS BROKEN BETWEEN ROUND 1 AND ROUND 2.
--
-- Round 1 (fn_union_weekly_rakeback_close) pays each club via fn_credit_treasury,
-- which credits clubs.chip_treasury. Round 2 read and debited a DIFFERENT pot,
-- club_wallets.chip_balance. So the union's 90% landed somewhere Round 2 could
-- not spend, and Round 2 drained an unrelated balance instead. On the first
-- live run: 162,644.52 went into clubs.chip_treasury while Round 2 took
-- 20,377.49 out of club_wallets. Left alone this compounds every Monday —
-- clubs.chip_treasury inflates forever and club_wallets is drained toward zero,
-- at which point Round 2 starts reporting shortfalls and agents stop being paid
-- despite the union having paid the clubs in full.
--
-- clubs.chip_treasury is the canonical club treasury (horse funding, dealer
-- tips, rake credit, union send/clawback and the settlement conservation check
-- all use it), so Round 2 is the side that moves.
--
-- Also fixed here: the audit trail was single-entry. Round 2 logged the club
-- debit but never the agent credit; Round 3 logged the player credit but never
-- the agent debit. Balances were conserved, but no ledger-based reconciliation
-- could ever show that. Both now write both sides.

CREATE OR REPLACE FUNCTION public.fn_settle_round2_club_to_agents(
  p_union_id uuid, p_period_start timestamptz, p_period_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_club_bal numeric; v_paid numeric := 0;
  v_payees int := 0; v_short int := 0; v_detail jsonb := '[]'::jsonb;
  v_debit jsonb; v_agent_bal numeric;
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
    -- Same pot Round 1 credits.
    SELECT COALESCE(chip_treasury,0) INTO v_club_bal
      FROM clubs WHERE id = r.club_id FOR UPDATE;

    IF COALESCE(v_club_bal,0) < r.owed THEN
      v_short := v_short + 1;
      v_detail := v_detail || jsonb_build_object('club_id', r.club_id, 'agent', r.agent_user,
                    'owed', r.owed, 'club_treasury', COALESCE(v_club_bal,0), 'skipped', true);
      CONTINUE;
    END IF;

    v_debit := public.fn_debit_treasury(
      r.club_id, r.owed,
      'Round 2: club -> agent commission',
      jsonb_build_object('union_id', p_union_id, 'agent_user_id', r.agent_user,
                         'period_start', p_period_start, 'period_end', p_period_end));

    IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
      v_short := v_short + 1;
      v_detail := v_detail || jsonb_build_object('club_id', r.club_id, 'agent', r.agent_user,
                    'owed', r.owed, 'error', v_debit, 'skipped', true);
      CONTINUE;
    END IF;

    PERFORM public.fn_ensure_club_wallet(r.agent_user, r.club_id);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance,0) + r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id
     RETURNING chip_balance INTO v_agent_bal;

    -- Both sides of the entry: the club-side debit above, and the agent credit.
    INSERT INTO wallet_transactions
      (user_id, wallet_type, type, amount, category, description, balance_after)
    VALUES
      (r.agent_user, 'PLAYER', 'credit', r.owed, 'commission',
       'Round 2: club -> agent commission [club wallet]', v_agent_bal);

    v_paid := v_paid + r.owed;
    v_payees := v_payees + 1;
  END LOOP;

  RETURN jsonb_build_object('round', 2, 'name', 'club_to_agents',
    'payees', v_payees, 'amount', round(v_paid,2), 'shortfalls', v_short, 'detail', v_detail);
END $function$;


CREATE OR REPLACE FUNCTION public.fn_settle_round3_agents_to_players(
  p_union_id uuid, p_period_start timestamptz, p_period_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_agent_bal numeric; v_paid numeric := 0;
  v_payees int := 0; v_short int := 0; v_detail jsonb := '[]'::jsonb;
  v_agent_after numeric; v_player_after numeric;
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

    UPDATE club_members SET chip_balance = chip_balance - r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id
     RETURNING chip_balance INTO v_agent_after;

    PERFORM public.fn_ensure_club_wallet(r.player_id, r.club_id);
    UPDATE club_members SET chip_balance = COALESCE(chip_balance,0) + r.owed, updated_at = now()
     WHERE user_id = r.player_id AND club_id = r.club_id
     RETURNING chip_balance INTO v_player_after;

    UPDATE rakeback_periods
       SET status = 'paid', paid_at = now()
     WHERE user_id = r.player_id AND club_id = r.club_id AND status = 'pending'
       AND period_start >= p_period_start::date AND period_start < p_period_end::date + 1;

    -- Both sides: the agent is debited, the player credited.
    INSERT INTO wallet_transactions
      (user_id, wallet_type, type, amount, category, description, balance_after)
    VALUES
      (r.agent_user, 'PLAYER', 'debit', r.owed, 'rakeback',
       'Round 3: agent -> player rakeback [club wallet]', v_agent_after),
      (r.player_id, 'PLAYER', 'credit', r.owed, 'rakeback',
       'Round 3: agent -> player rakeback [club wallet]', v_player_after);

    v_paid := v_paid + r.owed;
    v_payees := v_payees + 1;
  END LOOP;

  RETURN jsonb_build_object('round', 3, 'name', 'agents_to_players',
    'payees', v_payees, 'amount', round(v_paid,2), 'shortfalls', v_short, 'detail', v_detail);
END $function$;
