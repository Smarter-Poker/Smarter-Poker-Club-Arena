-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820171822 "round2_idempotency_settled_at"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b8727c338654ace417ab4e060c23a87b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ROUND 2 COULD DOUBLE-PAY.
--
-- Round 1 is guarded by union_rakeback_log ('already_executed') and Round 3 is
-- naturally idempotent because it flips rakeback_periods.status to 'paid'.
-- Round 2 just summed agent_commissions over a date window with no notion of
-- whether those commissions had already been settled. Running the cascade twice
-- for the same period — a retried cron, a double-click on the settlement
-- button, a manual re-run after a partial failure — paid every agent again.
-- The ON CONFLICT DO NOTHING on union_settlement_rounds prevented duplicate
-- LOGGING, which made the second payment invisible in the round history.

ALTER TABLE public.agent_commissions
  ADD COLUMN IF NOT EXISTS settled_at timestamptz;

COMMENT ON COLUMN public.agent_commissions.settled_at IS
  'Set by fn_settle_round2_club_to_agents when this commission has been paid out to the agent. NULL means still owed. Makes Round 2 idempotent.';

CREATE INDEX IF NOT EXISTS agent_commissions_unsettled_idx
  ON public.agent_commissions (club_id, user_id)
  WHERE settled_at IS NULL;

-- Everything that already existed before this column was added was paid by the
-- first live cascade run (or predates the cascade entirely and is historical
-- test data). Stamp it so the next run does not re-pay it.
UPDATE public.agent_commissions
   SET settled_at = now()
 WHERE settled_at IS NULL;


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
       AND ac.settled_at IS NULL              -- only what is actually still owed
     GROUP BY ac.club_id, ac.user_id
    HAVING SUM(ac.amount) > 0
     ORDER BY 1,2
  LOOP
    -- Same pot Round 1 credits (clubs.chip_treasury), not club_wallets.
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

    -- Mark exactly the rows this payment covered.
    UPDATE agent_commissions
       SET settled_at = now()
     WHERE club_id = r.club_id AND user_id = r.agent_user
       AND settled_at IS NULL
       AND created_at >= p_period_start AND created_at < p_period_end;

    -- Both sides of the entry: club-side debit above, agent credit here.
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
