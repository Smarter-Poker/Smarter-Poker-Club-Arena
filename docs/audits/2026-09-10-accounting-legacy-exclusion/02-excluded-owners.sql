CREATE OR REPLACE FUNCTION public.fn_agent_claim_commission(p_club_id uuid, p_op_id uuid DEFAULT NULL::uuid, p_max_rows integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor      uuid;
  v_op_id      uuid := COALESCE(p_op_id, gen_random_uuid());
  v_role       text;
  v_amount     numeric;
  v_rows       bigint;
  v_bank_before numeric;
  v_bank_after  numeric;
  v_to_after    numeric;
  v_prior      jsonb;
  v_club_name  text;
  v_batch      integer;
  v_more       boolean;
  v_ids        uuid[];
  v_cutoff     timestamptz;
  v_safe       timestamptz := now() - interval '5 minutes';
  v_settled    uuid;
BEGIN
  /* ZERO-DRIFT phase 6: commission claims journal as commission. */
  PERFORM set_config('app.ledger_category', 'commission', true);
  PERFORM set_config('app.ledger_counterparty', 'agent_wallet', true);
  PERFORM set_config('app.ledger_counterparty_entity', '', true);
  -- IDENTITY. auth.uid() is the only identity a browser can establish, and this
  -- RPC pays the caller. There is deliberately no p_user_id: a parameter naming
  -- somebody else would make this a way to move another person's earnings, and
  -- Dan's rule is that agents handle their own payouts.
  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Sign In To Claim Your Commission');
  END IF;

  -- REPLAY. Same op_id, same answer, no second payment. The client sends one
  -- id per intent, so a double tap or a retried request settles once.
  SELECT metadata INTO v_prior
    FROM chip_transactions
   WHERE club_id = p_club_id
     AND to_user_id = v_actor
     AND transaction_type = 'commission_claim'
     AND metadata ->> 'op_id' = v_op_id::text
   LIMIT 1;
  IF v_prior IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'replayed', true,
      'amount', (v_prior ->> 'amount')::numeric,
      'rows_settled', (v_prior ->> 'rows_settled')::bigint,
      'more', EXISTS (SELECT 1 FROM public.agent_commissions ac WHERE ac.club_id = p_club_id AND ac.user_id = v_actor AND ac.settled_at IS NULL
       AND ac.commission_capture_version IS NULL AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)),
      'op_id', v_op_id);
  END IF;

  /* ONE CLAIM PER PAIR AT A TIME (Phase 7, 20260908). The batch used to be
     held with FOR UPDATE, which is what stopped two concurrent claims paying
     the same rows. Nothing is stamped now, so the pair is serialised here
     instead; every statement after this takes a fresh snapshot, so the
     second claim sees the first one's settlement row. */
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_claim:' || p_club_id::text || ':' || v_actor::text, 42));

  -- MEMBERSHIP, NOT ROLE. A demoted agent keeps what they earned - Phase 4 let
  -- the demotion through precisely because "the agents row survives with the
  -- figure intact". If claiming required an agent role, the demotion would have
  -- quietly confiscated the money instead of deferring it.
  SELECT cm.role INTO v_role
    FROM club_members cm
   WHERE cm.club_id = p_club_id
     AND cm.user_id = v_actor
     AND COALESCE(cm.status, 'active') IN ('active', 'approved')
     -- FOR UPDATE, added 2026-09-02. Without it this row can be deleted
     -- between here and the credit ninety lines below, and the credit
     -- silently matches nothing while the bank has already been debited.
     FOR UPDATE;
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('success', false,
      'error', 'You Are Not An Active Member Of This Club');
  END IF;

  -- WHAT IS OWED, LOCKED, AND BOUNDED.
  --
  -- MEASURED ON PRODUCTION, 2026-08-31: the largest agent has 192,135 unsettled
  -- rows, and settling all of them in one statement took 64.6 SECONDS. The
  -- authenticated role's statement_timeout is 8s, so the three biggest agents
  -- (192k, 114k, 113k rows) could never have been paid at all.
  --
  -- The timeout is the smaller half of the problem. That statement also holds
  -- FOR UPDATE on the clubs row for its whole life, so a single claim would
  -- have frozen every chip movement in that club for a minute.
  --
  -- So a claim settles a BATCH and reports whether more is left. Measured on
  -- production against the largest agent: 2,000 rows took 2.95s, so the default
  -- is 1,000 - roughly 1.5s, a comfortable margin under 8s on a database that
  -- is also serving everybody else. The caller repeats while `more` is true -
  -- WITH A FRESH op_id EACH TIME, because op_id identifies one batch. Reusing
  -- one is what makes a retry safe; reusing one for the NEXT batch would
  -- replay the previous answer instead of settling anything.
  v_batch := LEAST(GREATEST(COALESCE(p_max_rows, 1000), 1), 5000);

  -- LOCK AND TOTAL THE BATCH. NOTHING IS WRITTEN YET.
  --
  -- ORDER MATTERS HERE AND IT IS THE WHOLE POINT. A refusal below returns
  -- JSON, and a plain RETURN does not roll anything back - PostgREST commits
  -- the transaction. So every write in this function happens AFTER the last
  -- thing that can refuse. An earlier draft folded the lock, the settle and
  -- the sum into one CTE for speed, which stamped settled_at before the club
  -- bank had been checked: a short bank would then have returned "cannot pay"
  -- while leaving the rows marked paid. That is the worst bug this function
  -- could have had, and it is why the settle is the last write, below.
  /* Phase 7 (20260908): the batch is the pair's OPEN rows - unstamped, and
     not covered by a settlement row - so a claim can never re-pay a row a
     period already covers. The anti-join rides agent_commissions_open_idx
     and stops at the LIMIT; the ORDER BY note below is history. */
  /* THE CUTOFF: the created_at of the batch-th oldest open row, clamped to
     five minutes ago. Oldest-first is agent_commissions_open_idx's own
     order, so the ORDER BY below is an index walk, not a sort. */
  SELECT ac.created_at INTO v_cutoff
    FROM public.agent_commissions ac
   WHERE ac.club_id = p_club_id AND ac.user_id = v_actor
     AND ac.settled_at IS NULL
       AND ac.commission_capture_version IS NULL
     AND ac.created_at < v_safe
     AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                      WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                        AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)
   ORDER BY ac.created_at
  OFFSET v_batch LIMIT 1;
  v_cutoff := LEAST(COALESCE(v_cutoff, v_safe), v_safe);
  SELECT COALESCE(SUM(ac.amount), 0), COUNT(*)
    INTO v_amount, v_rows
    FROM (
      SELECT ac.amount
        FROM public.agent_commissions ac
       WHERE ac.club_id = p_club_id AND ac.user_id = v_actor
         AND ac.settled_at IS NULL
       AND ac.commission_capture_version IS NULL
         AND ac.created_at < v_cutoff
         AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                          WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                            AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)
       /* No LIMIT and no FOR UPDATE: the cutoff already bounds the set, and
          nothing here is stamped, so there is no row to hold. The pair's
          advisory lock above is what serialises two claims. */
    ) ac;

  IF COALESCE(v_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('success', false, 'nothing_owed', true,
      'error', 'You Have No Commission To Claim Yet');
  END IF;

  v_amount := round(v_amount, 2);

  -- THE CLUB BANK PAYS, AND IT PAYS ONLY WHAT IT HAS. Midway Union owes 568.18
  -- against a treasury of 0.00, so this refusal is not hypothetical. Naming the
  -- shortfall is the difference between "try later" and "somebody has to fund
  -- the bank" - and it is the same refusal fn_club_bank_send already gives.
  SELECT COALESCE(c.chip_treasury, 0), c.name
    INTO v_bank_before, v_club_name
    FROM clubs c WHERE c.id = p_club_id FOR UPDATE;
  IF v_bank_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Club Not Found');
  END IF;
  IF v_bank_before < v_amount THEN
    RETURN jsonb_build_object('success', false, 'bank_short', true,
      'error', 'The Club Bank Holds '
               || trim(to_char(v_bank_before, 'FM999,999,999,990.00'))
               || ' Chips And Owes You '
               || trim(to_char(v_amount, 'FM999,999,999,990.00'))
               || '. Ask An Owner To Fund The Bank, Then Claim Again.',
      'balance', v_bank_before, 'requested', v_amount);
  END IF;

  UPDATE clubs
     SET chip_treasury = COALESCE(chip_treasury, 0) - v_amount,
         updated_at = now()
   WHERE id = p_club_id
   RETURNING chip_treasury INTO v_bank_after;

  -- INTO THEIR OWN MONEY, not the agent wallet. See the header.
  UPDATE club_members
     SET chip_balance = COALESCE(chip_balance, 0) + v_amount,
         updated_at = now()
   WHERE club_id = p_club_id AND user_id = v_actor
   RETURNING chip_balance INTO v_to_after;

  -- THE CREDIT MUST HAVE LANDED. The bank is already debited at this
  -- point, so a credit that matched no row would leave the chips nowhere
  -- and stamp the rows paid. The role read above holds FOR UPDATE, so
  -- this should be unreachable; RAISE rather than RETURN because a
  -- refusal here has to take the debit back with it, and only an
  -- exception rolls back what PostgREST would otherwise commit.
  IF v_to_after IS NULL THEN
    RAISE EXCEPTION 'commission claim could not credit the member wallet'
      USING ERRCODE = '25000';
  END IF;

  -- SETTLED, LAST. This is the line execute_commission_payout never had, and
  -- its absence is what let that function pay the same row forever. It runs
  -- after the bank has been debited and the agent credited, so no row is ever
  -- marked paid by a claim that did not pay.
  INSERT INTO public.agent_commission_settlements
    (club_id, user_id, union_id, period_start, period_end, amount, rows_count, paid_at, settlement_ref)
  VALUES (p_club_id, v_actor, NULL, '-infinity'::timestamptz, v_cutoff,
          round(v_amount, 2), v_rows, now(), 'claim:' || v_op_id::text)
  ON CONFLICT (club_id, user_id, period_start, period_end) DO NOTHING
  RETURNING id INTO v_settled;
  IF v_settled IS NULL THEN
    /* A concurrent claim recorded the same cutoff. The bank is already
       debited in this transaction, so the only safe answer is to take it
       all back: RAISE rolls the claim back and the caller retries. */
    RAISE EXCEPTION 'another claim recorded this window; retry'
      USING ERRCODE = '40001';
  END IF;

  /* CONTROL (phase 8): the claim is two balanced legs on the journal, the
       same movement chip_transactions records one-sidedly below. */
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, description, idempotency_key, metadata)
    VALUES
      (v_actor, 'club_treasury', p_club_id, 'player_wallet', v_actor,
       round(v_amount, 2), 'commission', p_club_id,
       'Agent claimed commission from the club bank',
       'agent_claim:' || v_op_id::text,
       jsonb_build_object('op_id', v_op_id, 'rows_settled', v_rows,
                          'bank_after', v_bank_after,
                          'agent_balance_after', v_to_after))
    ON CONFLICT DO NOTHING;

    INSERT INTO chip_transactions
    (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
  VALUES
    (p_club_id, NULL, v_actor, v_amount, 'commission_claim',
     'Commission Claimed By Agent',
     jsonb_build_object(
       'op_id', v_op_id,
       'amount', v_amount,
       'rows_settled', v_rows,
       'role_at_claim', v_role,
       'bank_before', v_bank_before,
       'bank_after', v_bank_after),
     v_to_after);

  BEGIN
    PERFORM public.fn_raise_notification(
      v_actor, 'commission_claimed',
      'You Claimed ' || trim(to_char(v_amount, 'FM999,999,999,990.00')) || ' Chips',
      'Your Commission From ' || COALESCE(v_club_name, 'Your Club')
        || ' Is Now In Your Chip Balance.',
      '/clubs/' || p_club_id::text,
      jsonb_build_object('club_id', p_club_id, 'amount', v_amount, 'rows_settled', v_rows));
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- the money has moved and is recorded; the notice is a courtesy
  END;

  -- IS THERE MORE? An EXISTS, not a COUNT and a SUM.
  --
  -- Reporting the exact remaining figure here cost 1,474ms on production,
  -- because it re-scans every one of the agent's remaining rows - on a call
  -- whose entire budget is 8 seconds. EXISTS answers the only question the
  -- caller needs in order to loop (0.25ms), and the exact figure is available
  -- from fn_agent_unsettled_commission on a screen that can afford it.
  SELECT EXISTS (
    SELECT 1 FROM public.agent_commissions ac
     WHERE ac.club_id = p_club_id AND ac.user_id = v_actor AND ac.settled_at IS NULL
       AND ac.commission_capture_version IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)
  ) INTO v_more;

  RETURN jsonb_build_object('success', true, 'amount', v_amount,
    'rows_settled', v_rows, 'chip_balance', v_to_after,
    'bank_after', v_bank_after, 'op_id', v_op_id,
    'more', v_more);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_agent_unsettled_commission(p_club_id uuid, p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_club_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'fn_agent_unsettled_commission needs a club and a user'
      USING ERRCODE = '22023';
  END IF;

  IF NOT public.fn_agent_may_read_commission(p_club_id, p_user_id) THEN
    -- Not a zero. A zero is indistinguishable from "owes nothing", and this
    -- caller is not entitled to know which of the two it is.
    RAISE EXCEPTION 'not authorized to read that member''s commission'
      USING ERRCODE = '42501';
  END IF;

  RETURN (
    SELECT COALESCE(SUM(ac.amount), 0)::numeric
      FROM public.agent_commissions ac
     WHERE ac.club_id = p_club_id
       AND ac.user_id = p_user_id
       AND ac.settled_at IS NULL
       AND ac.commission_capture_version IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s
                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end));
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_settle_round2_club_to_agents(p_union_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; v_club_bal numeric; v_paid numeric := 0;
  v_payees int := 0; v_short int := 0; v_detail jsonb := '[]'::jsonb;
  v_debit jsonb; v_agent_bal numeric; v_pairs jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.fn_caller_is_engine() AND (auth.uid() IS NULL OR NOT public.fn_is_union_overseer(p_union_id, auth.uid())) THEN
    RAISE EXCEPTION 'not_authorised';
  END IF;
  IF EXISTS (SELECT 1 FROM settlement_locks WHERE lock_type = 'GLOBAL_SETTLEMENT_FREEZE' AND is_active = true) THEN
    RAISE EXCEPTION 'EMERGENCY_PROFIT_DRIFT_LOCK';
  END IF;
  IF p_union_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end <= p_period_start THEN
    RETURN jsonb_build_object('round', 2, 'name', 'club_to_agents', 'success', false, 'error', 'bad_params',
                              'payees', 0, 'amount', 0, 'shortfalls', 0, 'detail', '[]'::jsonb);
  END IF;
  /* A row's created_at is its transaction's start. The longest transaction that
     writes agent_commissions is an eight-second engine call; five minutes after
     the period closes, nothing that began inside it is still in flight. Before
     that, a period recorded as paid could swallow a row that landed late. */
  IF p_period_end > now() - interval '5 minutes' THEN
    RETURN jsonb_build_object('round', 2, 'name', 'club_to_agents', 'success', false, 'retryable', true,
                              'error', 'period_too_fresh', 'period_end', p_period_end,
                              'payees', 0, 'amount', 0, 'shortfalls', 0, 'detail', '[]'::jsonb);
  END IF;

  /* What each pair is owed INSIDE this period: unstamped, and not already
     covered by a settlement row. One index scan per pair, no materialised set. */
  FOR r IN
    SELECT ac.club_id, ac.user_id AS agent_user, SUM(ac.amount) AS owed, count(*) AS n
      FROM agent_commissions ac
      JOIN union_clubs uc ON uc.club_id = ac.club_id AND uc.union_id = p_union_id
      JOIN agents a ON a.user_id = ac.user_id AND a.club_id = ac.club_id AND a.status = 'active'
     WHERE ac.created_at >= p_period_start AND ac.created_at < p_period_end
       AND ac.settled_at IS NULL
       AND ac.commission_capture_version IS NULL
       AND NOT EXISTS (SELECT 1 FROM agent_commission_settlements s
                        WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id
                          AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)
     GROUP BY ac.club_id, ac.user_id
    HAVING SUM(ac.amount) > 0
     ORDER BY 1, 2
  LOOP
    -- Same pot Round 1 credits (clubs.chip_treasury), not club_wallets.
    SELECT COALESCE(chip_treasury, 0) INTO v_club_bal FROM clubs WHERE id = r.club_id FOR UPDATE;

    IF COALESCE(v_club_bal, 0) < r.owed THEN
      v_short := v_short + 1;
      v_detail := v_detail || jsonb_build_object('club_id', r.club_id, 'agent', r.agent_user,
                    'owed', r.owed, 'club_treasury', COALESCE(v_club_bal, 0), 'skipped', true);
      CONTINUE;
    END IF;

    /* ONE MOVEMENT, ONE LEG (2026-09-09). The leg for this payment is
       written by hand at the bottom of this loop, carrying the period, the
       row count and an idempotency key that a replay can recognise. Until
       today both balance writes ALSO fired their own journal triggers, and
       neither had been told who the counterparty was, so each wrote an
       anonymous twin through settlement_suspense. Every commission was
       therefore journalled twice. The two stand-downs are set immediately
       before each write and cleared immediately after, so a CONTINUE out of
       this iteration can never leave a later statement silently unjournalled. */
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    v_debit := public.fn_debit_treasury(
      r.club_id, r.owed,
      'Round 2: club -> agent commission',
      jsonb_build_object('union_id', p_union_id, 'agent_user_id', r.agent_user,
                         'period_start', p_period_start, 'period_end', p_period_end));
    PERFORM set_config('app.ledger_autoskip_clubs', '', true);
    IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
      v_short := v_short + 1;
      v_detail := v_detail || jsonb_build_object('club_id', r.club_id, 'agent', r.agent_user,
                    'owed', r.owed, 'error', v_debit, 'skipped', true);
      CONTINUE;
    END IF;

    PERFORM public.fn_ensure_club_wallet(r.agent_user, r.club_id);
    PERFORM set_config('app.ledger_autoskip_club_members', '1', true);
    UPDATE club_members
       SET chip_balance = COALESCE(chip_balance, 0) + r.owed, updated_at = now()
     WHERE user_id = r.agent_user AND club_id = r.club_id
     RETURNING chip_balance INTO v_agent_bal;
    PERFORM set_config('app.ledger_autoskip_club_members', '', true);

    /* THE RECORD, instead of two million stamps: one row says this pair's
       rows inside this period are paid. A second call finds no open rows
       inside the period and pays nothing. */
    INSERT INTO public.agent_commission_settlements
      (club_id, user_id, union_id, period_start, period_end, amount, rows_count, paid_at, settlement_ref)
    VALUES (r.club_id, r.agent_user, p_union_id, p_period_start, p_period_end, round(r.owed, 2), r.n, now(),
            'round2:' || p_union_id::text || ':' || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD'))
    ON CONFLICT (club_id, user_id, period_start, period_end) DO NOTHING;

    -- Both sides of the entry: club-side debit above, agent credit here.
    INSERT INTO wallet_transactions
      (user_id, wallet_type, type, amount, category, description, balance_after)
    VALUES
      (r.agent_user, 'PLAYER', 'credit', r.owed, 'commission',
       'Round 2: club -> agent commission [club wallet]', v_agent_bal);

    /* CONTROL (phase 8): the same movement as two balanced legs, on the
       journal fn_ca_trial_balance reads. */
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, union_id, description, idempotency_key, metadata)
    VALUES
      (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
       'club_treasury', r.club_id, 'player_wallet', r.agent_user,
       round(r.owed, 2), 'commission', r.club_id, p_union_id,
       'Round 2: club -> agent commission (period '
         || to_char(p_period_start, 'YYYY-MM-DD') || '..'
         || to_char(p_period_end, 'YYYY-MM-DD') || ')',
       'round2:' || p_union_id::text || ':'
         || to_char(p_period_start at time zone 'UTC', 'YYYY-MM-DD') || ':'
         || r.club_id::text || ':' || r.agent_user::text,
       jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end,
                          'rows_count', r.n, 'agent_balance_after', v_agent_bal))
    ON CONFLICT DO NOTHING;

    v_pairs := v_pairs || jsonb_build_object('club_id', r.club_id, 'user_id', r.agent_user);
    v_paid := v_paid + r.owed;
    v_payees := v_payees + 1;
  END LOOP;

  IF v_pairs <> '[]'::jsonb THEN
    PERFORM public.fn_agent_commission_rollup_recompute(v_pairs);
  END IF;

  RETURN jsonb_build_object('round', 2, 'name', 'club_to_agents',
    'payees', v_payees, 'amount', round(v_paid, 2), 'shortfalls', v_short, 'detail', v_detail);
END
$function$;
