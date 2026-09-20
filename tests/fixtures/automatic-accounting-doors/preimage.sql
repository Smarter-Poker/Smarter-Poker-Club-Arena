-- Installed read-only preimage: fn_agent_claim_commission(uuid,uuid,integer); MD5 bcb8ff3ffb25d8b6a9e1537845050fdd
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
      'more', EXISTS (SELECT 1 FROM public.agent_commissions ac WHERE ac.club_id = p_club_id AND ac.user_id = v_actor AND ac.settled_at IS NULL AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)),
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


-- Installed read-only preimage: fn_claim_rakeback(uuid); MD5 01e25e9908d76f1bdbc749f57f106f21
CREATE OR REPLACE FUNCTION public.fn_claim_rakeback(p_club_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user    uuid := (SELECT auth.uid());
  v_period  record;
  v_res     jsonb;
  v_count   int := 0;
  v_admitted_clubs uuid[];
  v_total   numeric := 0;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required');
  END IF;

  v_admitted_clubs := ARRAY(SELECT DISTINCT club_id FROM public.rakeback_periods
   WHERE user_id=v_user AND status='pending'
    AND (period_end+1)::timestamp AT TIME ZONE 'UTC' <= statement_timestamp()
    AND (p_club_id IS NULL OR club_id=p_club_id) ORDER BY club_id);
  PERFORM public.fn_lock_rakeback_payer_clubs(v_admitted_clubs);
  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE user_id = v_user
       AND club_id = ANY(v_admitted_clubs)
       AND status = 'pending'
       AND (period_end+1)::timestamp AT TIME ZONE 'UTC' <= statement_timestamp()
       AND (p_club_id IS NULL OR club_id = p_club_id)
     ORDER BY club_id,period_start,id
     FOR UPDATE
  LOOP
    v_res := public.fn_close_settlement_period(v_period.id);
    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_total := v_total + COALESCE((v_res->>'payout')::numeric, 0);
      IF COALESCE((v_res->>'payout')::numeric, 0) > 0 THEN
        v_count := v_count + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'periods_claimed', v_count, 'total_payout', v_total);
END;
$function$;


-- Installed read-only preimage: fn_execute_union_rakeback(uuid,timestamp with time zone,timestamp with time zone); MD5 de06da455424cbd5c38d6934a2dfca60
CREATE OR REPLACE FUNCTION public.fn_execute_union_rakeback(p_union_id uuid, p_period_start timestamp with time zone, p_period_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_owner  uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM unions WHERE id = p_union_id;
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'union_not_found');
  END IF;
  IF v_caller IS NULL OR v_caller <> v_owner THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_start <> public.fn_union_week_start(p_period_start)
     OR p_period_end   <> public.fn_union_week_start(p_period_end)
     OR p_period_end <= p_period_start THEN
    RETURN jsonb_build_object('success', false, 'error', 'period_must_be_iso_weeks',
      'hint', 'start and end must both be Monday 00:00 UTC');
  END IF;
  RETURN public.fn_union_weekly_rakeback_close(p_union_id, p_period_start, p_period_end);
END $function$;


-- Installed read-only preimage: fn_run_pending_rakeback_settlement(integer); MD5 000eecf4f81d2e24affa3967676b8263
CREATE OR REPLACE FUNCTION public.fn_run_pending_rakeback_settlement(p_max_clubs integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_budget     numeric := 6.0;   -- inside the 8s the API roles carry
  v_is_admin   boolean;
  v_club       uuid;
  v_res        jsonb;
  v_clubs      integer := 0;
  v_periods    integer := 0;
  v_total      numeric := 0;
  v_deferred   integer := 0;
  v_errors     integer := 0;
  v_reasons    jsonb := '{}'::jsonb;
  v_k          text;
  v_remaining  integer;
  v_out_of_time boolean := false;
BEGIN
  SELECT EXISTS(SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('god','admin'))
    INTO v_is_admin;
  IF NOT v_is_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorized');
  END IF;

  IF p_max_clubs IS NULL OR p_max_clubs < 1 THEN p_max_clubs := 100; END IF;
  IF p_max_clubs > 500 THEN p_max_clubs := 500; END IF;

  FOR v_club IN
    SELECT DISTINCT club_id FROM rakeback_periods
     WHERE status='pending' AND period_end < CURRENT_DATE
     ORDER BY club_id
     LIMIT p_max_clubs
  LOOP
    -- Stop BEFORE starting a club we cannot finish. A cancelled statement
    -- would roll back every period settled in this transaction.
    IF extract(epoch FROM (clock_timestamp() - v_started)) > v_budget THEN
      v_out_of_time := true;
      EXIT;
    END IF;

    v_res := public.settle_club_rakeback(v_club);   -- bounded and idempotent

    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_clubs    := v_clubs + 1;
      v_periods  := v_periods  + COALESCE((v_res->>'periods_settled')::integer, 0);
      v_total    := v_total    + COALESCE((v_res->>'total_payout')::numeric, 0);
      v_deferred := v_deferred + COALESCE((v_res->>'deferred')::integer, 0);
      v_errors   := v_errors   + COALESCE((v_res->>'errors')::integer, 0);
      FOR v_k IN SELECT jsonb_object_keys(COALESCE(v_res->'deferred_reasons', '{}'::jsonb))
      LOOP
        v_reasons := jsonb_set(v_reasons, ARRAY[v_k],
          to_jsonb(COALESCE((v_reasons->>v_k)::int, 0)
                   + COALESCE((v_res->'deferred_reasons'->>v_k)::int, 0)), true);
      END LOOP;
    ELSE
      v_errors := v_errors + 1;
    END IF;
  END LOOP;

  SELECT count(DISTINCT club_id) INTO v_remaining FROM rakeback_periods
   WHERE status='pending' AND period_end < CURRENT_DATE;

  RETURN jsonb_build_object('success', true,
    'clubs_processed', v_clubs, 'periods_settled', v_periods,
    'total_payout', round(v_total, 2), 'clubs_remaining', v_remaining,
    'deferred', v_deferred, 'deferred_reasons', v_reasons, 'errors', v_errors,
    'periods_remaining', (SELECT count(*) FROM rakeback_periods
                           WHERE status='pending' AND period_end < CURRENT_DATE),
    'out_of_time', v_out_of_time,
    'elapsed_seconds', round(extract(epoch FROM (clock_timestamp() - v_started))::numeric, 3));
END;
$function$;


-- Installed read-only preimage: settle_club_rakeback(uuid); MD5 85cf74f076fd3cc2f834b4b29a01c647
CREATE OR REPLACE FUNCTION public.settle_club_rakeback(p_club_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.fn_settle_club_rakeback_batch(p_club_id, 40, 4.0, 2);
END;
$function$;


-- Installed read-only preimage: fn_settle_club_rakeback_batch(uuid,integer,numeric,integer); MD5 8e2f3e6648aaa603acb438fbcfb46b92
CREATE OR REPLACE FUNCTION public.fn_settle_club_rakeback_batch(p_club_id uuid, p_max_periods integer DEFAULT 40, p_budget_seconds numeric DEFAULT 4.0, p_max_warm_days integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_period     record;
  v_day        record;
  v_res        jsonb;
  v_settled    int := 0;
  v_deferred   int := 0;
  v_errors     int := 0;
  v_retries    int := 0;
  v_warmed     int := 0;
  v_total      numeric := 0;
  v_reasons    jsonb := '{}'::jsonb;
  v_reason     text;
  v_remaining  int;
  v_budget     numeric;
  v_elapsed    numeric;
  v_treasury   numeric;
  v_smallest   numeric;
  v_owed       numeric;
  v_attempt    int;
  v_sqlstate   text;
  v_err        text;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_club_id required');
  END IF;

  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL
          OR (NOT public.fn_is_platform_admin()
              AND NOT EXISTS (SELECT 1 FROM public.clubs c
                               WHERE c.id = p_club_id AND c.owner_id = auth.uid()))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorised');
  END IF;

  IF EXISTS(SELECT 1 FROM public.union_clubs WHERE club_id=p_club_id) OR EXISTS(SELECT 1 FROM public.unions WHERE id=p_club_id) THEN
    RETURN jsonb_build_object('success',false,'error','union_requires_weekly_accounting_coordinator','club_id',p_club_id,'periods_settled',0,'total_payout',0);
  END IF;
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
      'periods_settled', 0, 'total_payout', 0, 'deferred', 0, 'errors', 0,
      'note', 'platform_frozen', 'clock_ran_out', false);
  END IF;

  v_budget := GREATEST(COALESCE(p_budget_seconds, 4.0), 0.5);
  IF p_max_periods IS NULL OR p_max_periods < 1 THEN p_max_periods := 40; END IF;

  SELECT count(*), COALESCE(min(NULLIF(COALESCE(rakeback_amount, rakeback_earned, 0), 0)), 0),
         COALESCE(sum(COALESCE(rakeback_amount, rakeback_earned, 0)), 0)
    INTO v_remaining, v_smallest, v_owed
    FROM public.rakeback_periods
   WHERE club_id = p_club_id AND status = 'pending' AND period_end < CURRENT_DATE;

  IF v_remaining = 0 THEN
    RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
      'periods_settled', 0, 'total_payout', 0, 'deferred', 0, 'errors', 0,
      'periods_remaining', 0, 'note', 'nothing due', 'clock_ran_out', false);
  END IF;

  SELECT COALESCE(chip_treasury, 0) INTO v_treasury FROM public.clubs WHERE id = p_club_id;
  IF v_treasury < v_smallest THEN
    UPDATE public.rakeback_periods
       SET deferred_reason = 'insufficient_club_treasury',
           deferred_at = NOW(), defer_count = defer_count + 1
     WHERE club_id = p_club_id AND status = 'pending' AND period_end < CURRENT_DATE
       AND deferred_reason IS DISTINCT FROM 'insufficient_club_treasury';

    RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
      'periods_settled', 0, 'total_payout', 0, 'errors', 0,
      'deferred', v_remaining,
      'deferred_reasons', jsonb_build_object('insufficient_club_treasury', v_remaining),
      'periods_remaining', v_remaining,
      'treasury', round(v_treasury, 2), 'owed', round(v_owed, 2),
      'shortfall', round(v_owed - v_treasury, 2),
      'note', 'club cannot fund its smallest pending payout',
      'elapsed_seconds', round(extract(epoch FROM (clock_timestamp() - v_started))::numeric, 3),
      'clock_ran_out', false);
  END IF;

  FOR v_day IN
    SELECT DISTINCT d::date AS day
      FROM public.rakeback_periods rp
      CROSS JOIN LATERAL generate_series(rp.period_start, rp.period_end, interval '1 day') d
     WHERE rp.club_id = p_club_id
       AND rp.status = 'pending'
       AND rp.period_end < CURRENT_DATE
       AND NOT EXISTS (SELECT 1 FROM public.rakeback_daily_state s
                        WHERE s.club_id = p_club_id AND s.day = d::date)
     ORDER BY 1
     LIMIT GREATEST(COALESCE(p_max_warm_days, 2), 0)
  LOOP
    EXIT WHEN extract(epoch FROM (clock_timestamp() - v_started)) > v_budget * 0.6;
    BEGIN
      PERFORM public.fn_rakeback_recompute_day(p_club_id, v_day.day, false);
      v_warmed := v_warmed + 1;
    EXCEPTION WHEN OTHERS THEN
      -- A day that will not roll up is not a reason to skip paying the
      -- periods that do. The payer falls back to the direct scan.
      v_errors := v_errors + 1;
    END;
  END LOOP;

  FOR v_period IN
    SELECT id FROM public.rakeback_periods
     WHERE club_id = p_club_id AND status = 'pending'
       AND period_end < CURRENT_DATE
     -- Least-refused first. A deferred period stays pending because the
     -- money is still owed, so ordering by age alone lets a permanently
     -- refusing head of queue starve everything behind it.
     ORDER BY defer_count, period_end, id
     LIMIT p_max_periods
  LOOP
    EXIT WHEN extract(epoch FROM (clock_timestamp() - v_started)) > v_budget;

    v_attempt := 0;
    LOOP
      v_attempt := v_attempt + 1;
      BEGIN
        v_res := public.fn_close_settlement_period(v_period.id);
        EXIT;                                   -- closed, or refused cleanly
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_err = MESSAGE_TEXT;
        -- 40P01 deadlock_detected, 55P03 lock_not_available, 40001 serialization
        IF v_sqlstate IN ('40P01','55P03','40001') AND v_attempt < 3 THEN
          v_retries := v_retries + 1;
          PERFORM pg_sleep(0.05 * v_attempt);
          CONTINUE;                              -- the period is untouched; try again
        END IF;
        v_res := jsonb_build_object('success', false,
                   'deferred', 'error_' || v_sqlstate,
                   'detail', left(v_err, 200));
        v_errors := v_errors + 1;
        BEGIN
          UPDATE public.rakeback_periods
             SET deferred_reason = 'error_' || v_sqlstate,
                 deferred_at = NOW(), defer_count = defer_count + 1
           WHERE id = v_period.id;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        EXIT;
      END;
    END LOOP;

    IF COALESCE((v_res->>'success')::boolean, false) THEN
      v_settled := v_settled + 1;
      v_total   := v_total + COALESCE((v_res->>'payout')::numeric, 0);
    ELSE
      v_deferred := v_deferred + 1;
      v_reason   := COALESCE(v_res->>'deferred', v_res->>'error', 'unknown');
      v_reasons  := jsonb_set(v_reasons, ARRAY[v_reason],
                      to_jsonb(COALESCE((v_reasons->>v_reason)::int, 0) + 1), true);
    END IF;
  END LOOP;

  SELECT count(*) INTO v_remaining FROM public.rakeback_periods
   WHERE club_id = p_club_id AND status = 'pending' AND period_end < CURRENT_DATE;

  v_elapsed := round(extract(epoch FROM (clock_timestamp() - v_started))::numeric, 3);

  RETURN jsonb_build_object('success', true, 'club_id', p_club_id,
    'periods_settled', v_settled, 'total_payout', round(v_total, 2),
    'deferred', v_deferred, 'deferred_reasons', v_reasons,
    'errors', v_errors, 'lock_retries', v_retries,
    'days_warmed', v_warmed, 'periods_remaining', v_remaining,
    'treasury', round(v_treasury, 2),
    'elapsed_seconds', v_elapsed,
    'clock_ran_out', v_elapsed > v_budget);
END;
$function$;


-- Installed read-only preimage: fn_close_settlement_period(uuid); MD5 e129b4ff2ba84faa8f0dee88b494d21f
CREATE OR REPLACE FUNCTION public.fn_close_settlement_period(p_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_period         record;
  v_admitted_club uuid;
  v_rake_total     numeric;
  v_rate           numeric;
  v_payout         numeric;
  v_payout_id      uuid;
  v_days_needed    int;
  v_days_have      int;
  v_from_rollup    boolean := true;
  v_is_member      boolean;
  v_balance        numeric;
  v_debit          jsonb;
  v_treasury       numeric;
  v_ledger_category text;
BEGIN
  SELECT club_id INTO v_admitted_club FROM public.rakeback_periods WHERE id=p_period_id;
  PERFORM public.fn_lock_rakeback_payer_clubs(ARRAY[v_admitted_club]);
  SELECT * INTO v_period FROM public.rakeback_periods WHERE id = p_period_id FOR UPDATE;
  IF FOUND AND v_period.club_id IS DISTINCT FROM v_admitted_club THEN RAISE EXCEPTION 'Rakeback period scope changed during admission' USING ERRCODE='40001'; END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found');
  END IF;

  IF v_period.status IN ('paid', 'expired') THEN
    RETURN jsonb_build_object('success', true, 'skipped', v_period.status, 'period_id', p_period_id);
  END IF;

  -- WHO IS ASKING. A grant is not an authorization check: it lives outside
  -- the function and CREATE OR REPLACE carries it forward unexamined. This
  -- function debits a treasury and credits a wallet, so it asks.
  IF NOT public.fn_caller_is_engine()
     AND (auth.uid() IS NULL
          OR (auth.uid() <> v_period.user_id
              AND NOT public.fn_is_platform_admin()
              AND NOT EXISTS (SELECT 1 FROM public.clubs c
                               WHERE c.id = v_period.club_id
                                 AND c.owner_id = auth.uid()))) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_authorised');
  END IF;

  -- The existing batch payer selects closed periods. Direct callers must too.
  IF (v_period.period_end+1)::timestamp AT TIME ZONE 'UTC' > statement_timestamp() THEN
    RETURN jsonb_build_object('success',false,'deferred','earning_period_open',
      'period_id',p_period_id,'matures_at',(v_period.period_end+1)::timestamp AT TIME ZONE 'UTC');
  END IF;

  -- ---- EVERY CHEAP REFUSAL FIRST -------------------------------------------
  -- Each of these is one indexed lookup. The basis below is a rollup sum at
  -- best and a full rake_records scan at worst, and there is no reason to pay
  -- for it on a period that cannot be paid out either way.

  -- CLAUDE.md 13 rule 5: a sweep that moves money checks the freeze first.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('success', false, 'deferred', 'platform_frozen',
                              'period_id', p_period_id);
  END IF;

  -- Rakeback is earned at a club and belongs in that club's wallet. A player
  -- with no membership there is not quietly paid somewhere else, and is not
  -- worth a rake scan to discover that.
  SELECT EXISTS (SELECT 1 FROM public.club_members cm
                  WHERE cm.user_id = v_period.user_id
                    AND cm.club_id = v_period.club_id
                    AND cm.status IN ('active','approved'))
    INTO v_is_member;

  IF NOT v_is_member THEN
    UPDATE public.rakeback_periods
       SET deferred_reason = 'no_membership_at_earning_club',
           deferred_at = NOW(), defer_count = defer_count + 1
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', false, 'deferred', 'no_membership_at_earning_club',
      'period_id', p_period_id, 'club_id', v_period.club_id, 'user_id', v_period.user_id);
  END IF;

  -- Can this club fund what this period is already believed to be worth? The
  -- estimate is the writer's own last computation, it is used ONLY to refuse,
  -- and refusing here costs one indexed row where continuing costs a full rake
  -- scan for a payment fn_debit_treasury would decline at the end of it.
  IF COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0) > 0 THEN
    SELECT COALESCE(c.chip_treasury, 0) INTO v_treasury
      FROM public.clubs c WHERE c.id = v_period.club_id;
    IF v_treasury < COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0) THEN
      UPDATE public.rakeback_periods
         SET deferred_reason = 'insufficient_club_treasury',
             deferred_at = NOW(), defer_count = defer_count + 1
       WHERE id = p_period_id;
      RETURN jsonb_build_object('success', false, 'deferred', 'insufficient_club_treasury',
        'period_id', p_period_id, 'club_id', v_period.club_id,
        'estimated_payout', COALESCE(v_period.rakeback_amount, v_period.rakeback_earned, 0),
        'treasury', round(v_treasury, 2), 'checked', 'before_basis');
    END IF;
  END IF;

  -- ---- NOW THE WORK ---------------------------------------------------------
  -- rakeback_daily_user is the same allocation the writer used, computed once
  -- per club-day for every player. Where it does not cover the period - it
  -- began 2026-08-31 and the backlog reaches to 2026-07-20 - fall back to the
  -- original scan rather than pay somebody zero because a cache is cold.
  v_days_needed := (v_period.period_end - v_period.period_start) + 1;
  SELECT count(*) INTO v_days_have FROM public.rakeback_daily_state s
   WHERE s.club_id = v_period.club_id
     AND s.day BETWEEN v_period.period_start AND v_period.period_end;

  IF v_days_have >= v_days_needed THEN
    SELECT ROUND(COALESCE(SUM(d.cents), 0)::numeric / 100, 2)
      INTO v_rake_total
      FROM public.rakeback_daily_user d
     WHERE d.club_id = v_period.club_id
       AND d.user_id = v_period.user_id
       AND d.day BETWEEN v_period.period_start AND v_period.period_end;
  ELSE
    v_from_rollup := false;
    SELECT ROUND(COALESCE(SUM(s.credit), 0), 2)
      INTO v_rake_total
      FROM public.rake_records r
      CROSS JOIN LATERAL public.fn_rake_shares_for_record(
        r.hand_id, r.rake_amount, r.player_contributions, COALESCE(r.rake_method, 'DEALT_EQUAL')
      ) s
     WHERE r.club_id = v_period.club_id
       AND r.created_at >= v_period.period_start::timestamp AT TIME ZONE 'UTC'
       AND r.created_at <  (v_period.period_end + 1)::timestamp AT TIME ZONE 'UTC'
       AND r.rake_amount > 0
       AND r.player_contributions IS NOT NULL
       AND (r.player_contributions ? v_period.user_id::text)
       AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id, r.table_id, r.metadata)
       AND s.user_id = v_period.user_id;
  END IF;

  -- One source of truth for the rate: the player's own deal, else their agent's
  -- standing offer, else the legacy volume ladder, never more than the upline
  -- earns less ten points.
  v_rate   := public.fn_player_rakeback_rate(v_period.user_id, v_period.club_id, v_rake_total);
  v_payout := ROUND(v_rake_total * v_rate, 2);

  UPDATE public.rakeback_periods
     SET rake_generated  = v_rake_total,
         total_rake_paid = v_rake_total,
         rakeback_rate   = v_rate,
         rakeback_amount = v_payout,
         rakeback_earned = v_payout
   WHERE id = p_period_id;

  IF v_payout <= 0 THEN
    UPDATE public.rakeback_periods
       SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'period_id', p_period_id, 'payout', 0,
                              'rake_total', v_rake_total, 'rakeback_rate', v_rate,
                              'from_rollup', v_from_rollup);
  END IF;

  INSERT INTO public.rakeback_period_payouts
    (rakeback_period_id, club_id, user_id, user_rake_contribution,
     rakeback_pct, payout_amount, status, paid_at)
  VALUES
    (p_period_id, v_period.club_id, v_period.user_id, v_rake_total,
     ROUND(v_rate * 100, 2), round(v_payout, 2), 'paid', NOW())
  ON CONFLICT (rakeback_period_id, user_id) DO NOTHING
  RETURNING id INTO v_payout_id;

  IF v_payout_id IS NULL THEN
    UPDATE public.rakeback_periods
       SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', true, 'skipped', 'payout_exists', 'period_id', p_period_id);
  END IF;

  v_debit := public.fn_debit_treasury(
    v_period.club_id, v_payout,
    'Player rakeback ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    jsonb_build_object('period_id', p_period_id, 'user_id', v_period.user_id,
                       'rake_basis', v_rake_total, 'rate', v_rate));

  IF COALESCE((v_debit->>'success')::boolean, false) IS NOT TRUE THEN
    DELETE FROM public.rakeback_period_payouts WHERE id = v_payout_id;
    UPDATE public.rakeback_periods
       SET deferred_reason = 'insufficient_club_treasury',
           deferred_at = NOW(), defer_count = defer_count + 1
     WHERE id = p_period_id;
    RETURN jsonb_build_object('success', false, 'deferred', 'insufficient_club_treasury',
      'period_id', p_period_id, 'club_id', v_period.club_id, 'payout', v_payout,
      'treasury', v_debit->'balance');
  END IF;

  PERFORM set_config('app.ledger_club_id', v_period.club_id::text, true);

  v_ledger_category:=current_setting('app.ledger_category',true);
  PERFORM public.atomic_credit_wallet_and_log(
    v_period.user_id, v_payout, 'rakeback',
    'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
    NULL, NULL, v_payout_id, 'rakeback:' || p_period_id::text
  );


  PERFORM set_config('app.ledger_club_id', '', true);
  PERFORM set_config('app.ledger_category',coalesce(v_ledger_category,''),true);

  SELECT cm.chip_balance INTO v_balance
    FROM public.club_members cm
   WHERE cm.user_id = v_period.user_id AND cm.club_id = v_period.club_id;

  INSERT INTO public.wallet_transactions
    (user_id, wallet_type, amount, type, category, description, related_entity_id, balance_after)
  VALUES
    (v_period.user_id, 'PLAYER', v_payout, 'credit', 'rakeback',
     'Rakeback payout ' || v_period.period_start::text || ' to ' || v_period.period_end::text,
     v_payout_id, v_balance);

  -- Bind the existing payout receipt only after its wallet row has been inserted.
  PERFORM set_config('app.ledger_maintenance',
                     'rakeback payout evidence pointer', true);
  UPDATE public.rakeback_period_payouts p
     SET wallet_transaction_id = w.id
    FROM public.wallet_transactions w
   WHERE p.id = v_payout_id AND w.related_entity_id = v_payout_id
     AND p.wallet_transaction_id IS NULL;
  PERFORM set_config('app.ledger_maintenance', '', true);

  UPDATE public.rakeback_periods
     SET status = 'paid', paid_at = NOW(), deferred_reason = NULL, deferred_at = NULL
   WHERE id = p_period_id;

  RETURN jsonb_build_object('success', true, 'period_id', p_period_id,
    'rake_total', v_rake_total, 'rakeback_rate', v_rate,
    'payout', v_payout, 'payout_id', v_payout_id, 'club_id', v_period.club_id,
    'from_rollup', v_from_rollup, 'funded_from', 'club_chip_treasury');
END;
$function$;

