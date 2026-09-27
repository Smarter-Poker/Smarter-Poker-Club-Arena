-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820160547 "union_law_c1b_round3_correct_paid_columns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f32a6748ea9475d5a0afa85c51ad1207 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- rakeback_periods has paid_at, not updated_at. Use the real column so the
-- payment timestamp is recorded rather than the statement failing.
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

    UPDATE club_members SET chip_balance = chip_balance - r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id;

    PERFORM public.fn_ensure_club_wallet(r.player_id, r.club_id);
    UPDATE club_members SET chip_balance = COALESCE(chip_balance,0) + r.owed, updated_at = now()
     WHERE user_id = r.player_id AND club_id = r.club_id;

    UPDATE rakeback_periods
       SET status = 'paid', paid_at = now()
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

