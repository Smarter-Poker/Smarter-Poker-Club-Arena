-- Exact production fn_ca_quick_reconcile (pg_get_functiondef, 2026-09-26),
-- md5 1fa22b57be6709733e7b851aa1fb4005. Pinned by migration 20260926060005.
CREATE OR REPLACE FUNCTION public.fn_ca_quick_reconcile()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r RECORD; n int := 0; v_frozen numeric; v_now numeric; v_left numeric;
BEGIN
  -- 3a. Negative balances (credit-line members are checked against their BOUND)
  FOR r IN
    SELECT 'player_wallet' AS pool, m.user_id AS entity_id, m.club_id, m.chip_balance AS amt,
           false AS ok
      FROM club_members m
     WHERE COALESCE(m.chip_balance,0) < 0
       AND COALESCE(m.chip_balance,0) < -COALESCE(m.credit_limit,0)
    UNION ALL
    SELECT 'club_treasury', c.id, c.id, c.chip_treasury, false FROM clubs c
     WHERE COALESCE(c.chip_treasury,0) < 0
    UNION ALL
    SELECT 'union_wallet', w.union_id, NULL, LEAST(w.chip_balance, w.rake_wallet, w.bbj_wallet,
           w.promo_wallet, w.insurance_wallet, COALESCE(w.spin_reserve_wallet,0)), false
      FROM union_wallets w
     WHERE LEAST(w.chip_balance, w.rake_wallet, w.bbj_wallet, w.promo_wallet,
                 w.insurance_wallet, COALESCE(w.spin_reserve_wallet,0)) < 0
    UNION ALL
    SELECT 'agent_wallet', a.user_id, a.club_id,
           LEAST(COALESCE(a.agent_wallet_balance,0), COALESCE(a.promo_wallet_balance,0)), false
      FROM agents a
     WHERE LEAST(COALESCE(a.agent_wallet_balance,0), COALESCE(a.promo_wallet_balance,0)) < 0
    UNION ALL
    SELECT 'bbj_pool', b.id, b.club_id,
           LEAST(b.main_balance, b.backup_balance, b.promo_balance), false
      FROM bbj_pools b
     WHERE LEAST(b.main_balance, b.backup_balance, b.promo_balance) < 0
    LIMIT 50
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:negative_balance',
      CASE WHEN r.pool = 'club_treasury' THEN 'treasury_error'
           WHEN r.pool = 'player_wallet' THEN 'credit_line_error'
           ELSE 'ledger_imbalance' END,
      CASE WHEN r.pool = 'club_treasury' THEN 'warning' ELSE 'critical' END,
      'qr:neg:' || r.pool || ':' || COALESCE(r.entity_id::text,'-') || ':' || CURRENT_DATE::text,
      abs(r.amt), 0, r.amt, 'ledger', r.pool, r.entity_id, r.club_id,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      CASE WHEN r.pool = 'player_wallet'
           THEN 'player balance below the authorized credit-line bound'
           ELSE 'unauthorized negative balance in ' || r.pool END,
      NULL, '{}'::jsonb);
    n := n + 1;
  END LOOP;

  -- 3b. Frozen pool must not move
  SELECT frozen_total INTO v_frozen
    FROM public.ca_frozen_pool_baseline WHERE pool = 'public.wallets';
  -- The frozen pool is the PRE-FREEZE rows (verified: the 690 rows created
  -- before 2026-08-22 sum to the baseline exactly). Post-freeze rows belong
  -- to certification/test accounts whose harness chips cycle through the
  -- no-club fallback and are deleted by the certification cleanup - they are
  -- not the stranded pool and must not page anyone.
  SELECT COALESCE(SUM(balance), 0) INTO v_now FROM public.wallets
   WHERE created_at < '2026-08-22';
  -- 2026-09-02: a pre-freeze row can also LEAVE, because public.wallets
  -- cascades from profiles and auth.users and 188 pre-freeze rows belong to
  -- certification accounts that are torn down routinely. A deleted row is not
  -- a write, so add recorded departures back before comparing: an
  -- attributable teardown nets to zero, an unrecorded change still pages.
  SELECT COALESCE(SUM(deleted_balance), 0) INTO v_left
    FROM public.ca_frozen_pool_deletions WHERE pool = 'public.wallets';
  v_now := v_now + COALESCE(v_left, 0);
  IF v_frozen IS NOT NULL AND v_now <> v_frozen THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:frozen_pool', 'unauthorized_adjustment', 'critical',
      'qr:frozen_wallets:' || CURRENT_DATE::text,
      v_now - v_frozen, v_frozen, v_now, 'ledger', 'frozen_wallets_pool',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'the dead public.wallets pool changed by an amount no recorded deletion explains - either a money path wrote to it, or a row left without the recording trigger firing',
      NULL, '{}'::jsonb);
    n := n + 1;
  END IF;

  -- 3c. Settlements stuck in flight (> 5 minutes)
  FOR r IN
    SELECT table_id, hand_id, first_attempt_at
      FROM settlement_idempotency_keys
     WHERE status = 'in_flight' AND last_attempt_at < now() - interval '5 minutes'
     LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:settlement_stuck', 'settlement_error', 'critical',
      'qr:stuck:' || r.table_id::text || ':' || COALESCE(r.hand_id::text,'-'),
      0, NULL, NULL, 'settlement', 'settlement_idempotency_keys', r.hand_id,
      NULL, NULL, r.table_id, NULL, r.hand_id,
      'hand:' || r.table_id::text, NULL, NULL,
      'settlement in_flight for more than 5 minutes (crashed mid-settlement?)',
      NULL, jsonb_build_object('first_attempt_at', r.first_attempt_at));
    n := n + 1;
  END LOOP;

  -- 3d. Union PnL settlements stuck in_progress (> 10 minutes) - the
  -- half-collected/half-paid trap the audit flagged.
  FOR r IN
    SELECT id, union_id, period_start
      FROM union_pnl_settlements
     WHERE status = 'in_progress'
       AND COALESCE(settled_at, period_end, now() - interval '1 day') < now() - interval '10 minutes'
     LIMIT 10
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:union_pnl_stuck', 'settlement_error', 'critical',
      'qr:pnl:' || r.id::text,
      0, NULL, NULL, 'settlement', 'union_pnl_settlements', r.id,
      NULL, r.union_id, NULL, NULL, NULL,
      'union_pnl:' || r.id::text, NULL, NULL,
      'union PnL settlement stuck in_progress - money may be half-collected/half-paid; resume or reconcile manually',
      NULL, jsonb_build_object('period_start', r.period_start));
    n := n + 1;
  END LOOP;

  -- 3e. Fresh unaccounted cash seat exits
  FOR r IN
    SELECT * FROM public.fn_unaccounted_seat_exits('30 minutes'::interval, '10 minutes'::interval)
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:seat_exit', 'missing_payment', 'critical',
      'qr:seatexit:' || r.exit_id::text,
      -r.stack, r.stack, 0, 'ledger', 'seat_stack_exit', r.user_id,
      r.club_id, NULL, r.table_id, NULL, NULL, NULL, NULL, NULL,
      'seat exited with ' || r.stack || ' chips and no matching wallet credit',
      false, jsonb_build_object('exit_id', r.exit_id, 'exit_kind', r.exit_kind));
    n := n + 1;
  END LOOP;

  -- 3f. Ledger write failures
  -- The opening grant journals issuance_reserve -> club_treasury since
  -- 2026-09-03 and system_mint -> club_treasury before it. A refusal of its
  -- already-posted key is an idempotency refusal in either shape; matching
  -- system_mint alone left this exemption dead for every newer club
  -- (2026-09-23).
  FOR r IN
    SELECT * FROM public.ca_ledger_write_failures f
     WHERE f.occurred_at > now() - interval '10 minutes'
        AND public.fn_ca_is_midway_scope(NULL, f.club_id, NULL, NULL, '{}'::jsonb)
        AND NOT (
          f.sqlstate = '23505'
          AND f.message LIKE '%ux_chip_ledger_idempotency_key%'
          AND EXISTS (
            SELECT 1 FROM public.chip_ledger l
             WHERE l.club_id = f.club_id
               AND l.idempotency_key = 'club-opening-grant:' || f.club_id::text
               AND l.category = 'mint' AND l.from_type IN ('system_mint', 'issuance_reserve')
               AND l.to_type = 'club_treasury' AND l.to_entity_id = f.club_id
               AND l.amount = 100000 AND l.status = 'posted'
          )
        )
     LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:ledger_write_failure', 'ledger_imbalance', 'critical',
      'qr:lwf:' || r.id::text,
      COALESCE(r.delta,0), NULL, NULL, 'ledger', 'ca_ledger_write_failures', r.user_id,
      r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'a balance moved but its ledger row could not be written: ' || COALESCE(r.message,''),
      false, jsonb_build_object('sqlstate', r.sqlstate));
    n := n + 1;
  END LOOP;

  -- 3g. Unclassified (suspense) flow - info-severity daily rollup: it is a
  -- category-migration metric, not a discrepancy; the dashboard shows it.
  -- NET, NOT GROSS (2026-09-09): a chip that enters suspense and leaves it
  -- declared its counterparty on the way out. Counting both legs made a
  -- correction cancelling its own auto-ledger twin read as 720.00 of
  -- undeclared flow when it left nothing behind at all.
  PERFORM 1 FROM public.chip_ledger
   WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
     AND created_at > GREATEST(CURRENT_DATE::timestamptz, '2026-09-01 00:17:00+00'::timestamptz)
  HAVING abs(round(COALESCE(sum(CASE WHEN to_type = 'settlement_suspense' THEN amount ELSE -amount END), 0), 2)) > 1.00;
  IF FOUND THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:suspense_flow', 'unknown', 'info',
      'qr:suspense:' || CURRENT_DATE::text,
      (SELECT round(COALESCE(sum(CASE WHEN to_type='settlement_suspense' THEN amount ELSE -amount END),0),2)
         FROM public.chip_ledger
        WHERE (from_type='settlement_suspense' OR to_type='settlement_suspense')
          AND created_at > GREATEST(CURRENT_DATE::timestamptz, '2026-09-01 00:17:00+00'::timestamptz)),
      NULL, NULL, 'ledger', 'settlement_suspense', NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL,
      'suspense is holding chips it was not handed a counterparty for: this is the NET of what entered and left today, not the gross flow through it',
      true, '{}'::jsonb);
  END IF;

  RETURN n;
END $function$
;
