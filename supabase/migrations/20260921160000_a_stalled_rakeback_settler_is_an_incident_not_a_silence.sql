-- ═══════════════════════════════════════════════════════════════════════════
--  A STALLED RAKEBACK SETTLER IS AN INCIDENT, NOT A SILENCE (2026-09-21)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fn_process_weekly_accounting_scope raises `weekly_rake_source_not_fully_accrued`
-- when any cash rake record inside the week being settled still sits above
-- daemon_state.rakeback_settler.high_water_mark. That refusal is CORRECT and is
-- not changed here: settling a week on a source that is not fully accrued posts
-- an understated week, and no alerting change may ever be used as an excuse to
-- advance that watermark by hand.
--
-- What was wrong is that the state which triggers the refusal was unobservable.
-- Measured live on 2026-09-21:
--
--   15:21:34Z  high_water_mark 14:34:09.619Z, updated_at 14:34:15.395Z,   805 rows above
--   15:26:06Z  high_water_mark 14:34:09.619Z, updated_at 14:34:15.395Z,   985 rows above
--
-- Fifty-two minutes with no advance and 985 unaccrued cash rake records, and:
--   * https://engine.smarter.poker/health reported settlementStatus "ok" and
--     blockedSettlementCount 0;
--   * fn_settler_lag_check() returned healthy:true, because its only stall rule
--     was (last_save > 1 hour AND backlog > 1000) and neither half was met;
--   * nothing anywhere called fn_settler_lag_check() at all. It had no caller in
--     the repository and no pg_cron job. A probe nobody asks is not a probe.
--
-- This migration makes that state speak, inside the observation surface that
-- already exists. It adds NO job, timer, watcher, reconciler or repair loop:
--   1. fn_settler_lag_check() learns the settler's real interval (30 minutes,
--      RakebackSettlerService.SETTLEMENT_INTERVAL_MS) and the cascade's real
--      gate, so its verdict matches the thing that actually blocks settlement.
--   2. fn_ca_settlement_correctness_check() - already scheduled hourly as
--      pg_cron job 178 `ca-settlement-correctness-30m`, already raising durable,
--      deduped, escalatable incidents through fn_ca_raise_drift_incident - asks
--      the probe and files the incident. Sections B through G are untouched;
--      the body below is the live definition with section H appended.
--
-- Nothing in this migration reads, writes or advances a watermark.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. The probe knows what "behind" means.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_settler_lag_check()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- RakebackSettlerService.SETTLEMENT_INTERVAL_MS is 30 minutes. The grace is
  -- one whole interval plus the :53-to-:00 maintenance freeze, so a healthy
  -- cycle - including one that correctly waited out a freeze - is never an
  -- incident, and a cycle that was actually SKIPPED always is.
  c_interval_m constant numeric  := 30;
  c_grace_m    constant numeric  := 45;
  -- The union week closes at fn_union_week_start(now()) and the cascade cron
  -- (job 272, `0,30 * * * *`) then attempts it. Allow one settler interval past
  -- the boundary before calling the week blocked, so the drain gets a fair
  -- chance to accrue the final hands of the week first.
  c_week_grace constant interval := interval '30 minutes';
  v_cursor     timestamptz;
  v_cursor_id  uuid;
  v_saved      timestamptz;
  v_lag_h      numeric;
  v_stale_m    numeric;
  v_backlog    bigint;
  v_week_to    timestamptz;
  v_week_from  timestamptz;
  v_unaccrued  bigint := 0;
  v_blocked    boolean := false;
  v_stalled    boolean;
BEGIN
  SELECT high_water_mark, high_water_mark_id, updated_at
    INTO v_cursor, v_cursor_id, v_saved
    FROM daemon_state
   WHERE daemon = 'rakeback_settler';

  IF v_cursor IS NULL THEN
    -- A genuine first run has no cursor. That is not a stall.
    RETURN jsonb_build_object('healthy', true, 'note', 'no settler cursor yet');
  END IF;

  v_lag_h   := round(EXTRACT(epoch FROM (now() - v_cursor)) / 3600.0, 2);
  v_stale_m := round(EXTRACT(epoch FROM (now() - v_saved)) / 60.0, 1);

  -- Bounded on purpose: the verdict needs to know that backlog exists and
  -- roughly how much, never the exact depth of a days-old hole.
  SELECT count(*) INTO v_backlog
    FROM (SELECT 1 FROM rake_records WHERE created_at > v_cursor LIMIT 5000) s;

  v_week_to   := public.fn_union_week_start(now());
  v_week_from := v_week_to - interval '7 days';

  IF now() >= v_week_to + c_week_grace THEN
    -- The same predicate fn_process_weekly_accounting_scope gates on, minus its
    -- per-union club scoping: if ANY cash rake inside the closed week is still
    -- above the cursor then at least one union raises
    -- weekly_rake_source_not_fully_accrued and the cascade settles nothing.
    SELECT count(*) INTO v_unaccrued
      FROM (SELECT 1
              FROM rake_records rr
             WHERE NOT COALESCE(rr.is_tournament, false)
               AND rr.tournament_id IS NULL
               AND rr.rake_amount > 0
               AND rr.created_at >= v_week_from
               AND rr.created_at <  v_week_to
               AND (rr.created_at > v_cursor
                    OR (rr.created_at = v_cursor
                        AND (v_cursor_id IS NULL OR rr.id > v_cursor_id)))
             LIMIT 5000) w;
    v_blocked := v_unaccrued > 0;
  END IF;

  -- A stall is a cursor that has not moved for materially longer than one
  -- interval WHILE there is work above it. Either half alone is ordinary: an
  -- idle table gives the settler nothing to save, and a fresh backlog just
  -- means the drain is mid-cycle.
  v_stalled := (v_stale_m > c_grace_m AND v_backlog > 0);

  RETURN jsonb_build_object(
    'healthy',                 NOT (v_stalled OR v_blocked OR v_lag_h > 6),
    'cursor',                  v_cursor,
    'lag_hours',               v_lag_h,
    'last_save_hours_ago',     round(v_stale_m / 60.0, 2),
    'last_save_minutes_ago',   v_stale_m,
    'backlog_rows',            v_backlog,
    'interval_minutes',        c_interval_m,
    'stall_grace_minutes',     c_grace_m,
    'stalled',                 v_stalled,
    'week_from',               v_week_from,
    'week_to',                 v_week_to,
    'week_unaccrued_rows',     v_unaccrued,
    'week_settlement_blocked', v_blocked);
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. The hourly settlement-correctness check asks the probe and files it.
--    Sections B through G below are the live definition, unchanged.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_settlement_correctness_check()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE r record; n integer := 0;
BEGIN
  -- B. Cross-club direct postings (last 60 min)
  FOR r IN
    SELECT l.id, l.from_type, l.from_entity_id, l.to_type, l.to_entity_id, l.amount, l.category
    FROM public.chip_ledger l
    WHERE l.created_at > now() - interval '60 minutes'
      AND l.from_type IN ('club_treasury','club_wallet')
      AND l.to_type   IN ('club_treasury','club_wallet')
      AND l.from_entity_id IS DISTINCT FROM l.to_entity_id
      AND l.category NOT IN ('treasury_transfer','pnl_settlement','horse_funding','correction')
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:cross_club', 'cross_club_posting', 'warning',
      'cross-club:' || COALESCE(r.from_entity_id::text,'?') || ':' || COALESCE(r.to_entity_id::text,'?'),
      r.amount, NULL, NULL, 'ledger', 'chip_ledger', NULL,
      r.from_entity_id, NULL, NULL, NULL, NULL, NULL, NULL, ARRAY[r.id],
      'chips moved directly between two different clubs (' || r.category || ', '
        || r.from_type || '→' || r.to_type || ') outside the allowed cross-club categories',
      NULL, jsonb_build_object('ledger_row', r.id, 'category', r.category));
    n := n + 1;
  END LOOP;

  -- C1. Rakeback over-attribution (last 24 h)
  FOR r IN
    SELECT rr.id AS record_id, rr.club_id, rr.rake_amount, round(sum(ra.rake_amount),2) AS attributed
    FROM public.rake_records rr
    JOIN public.rake_attributions ra ON ra.rake_record_id = rr.id
    WHERE rr.created_at > now() - interval '24 hours'
    GROUP BY rr.id, rr.club_id, rr.rake_amount
    HAVING round(sum(ra.rake_amount),2) > round(rr.rake_amount,2) + 0.01
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:rakeback_chain', 'incorrect_rakeback', 'warning',
      'rakeback-overattr:' || r.record_id::text,
      round(r.attributed - r.rake_amount, 2), r.rake_amount, r.attributed,
      'reporting', 'rake_attributions', r.record_id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'rake attributions exceed the rake actually collected for this record - the rakeback chain would over-accrue',
      NULL, jsonb_build_object('rake_record_id', r.record_id));
    n := n + 1;
  END LOOP;

  -- C2. Rakeback over-payout (paid more than the player contributed, last 7 d)
  FOR r IN
    SELECT p.id, p.club_id, p.user_id, p.payout_amount, p.user_rake_contribution
    FROM public.rakeback_period_payouts p
    WHERE p.status = 'paid' AND p.paid_at > now() - interval '7 days'
      AND p.payout_amount > COALESCE(p.user_rake_contribution, 0) + 0.01
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:rakeback_chain', 'incorrect_rakeback', 'critical',
      'rakeback-overpay:' || r.id::text,
      round(r.payout_amount - COALESCE(r.user_rake_contribution,0), 2),
      r.user_rake_contribution, r.payout_amount,
      'settlement', 'rakeback_period_payouts', r.id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'a rakeback payout exceeds the player''s ENTIRE rake contribution - impossible under any percentage',
      NULL, jsonb_build_object('payout_id', r.id, 'user_id', r.user_id));
    n := n + 1;
  END LOOP;

  -- C3. Rakeback dual-write evidence gaps (last 7 d)
  FOR r IN
    SELECT 'period_payout' AS src, p.id, p.club_id FROM public.rakeback_period_payouts p
     WHERE p.status = 'paid' AND p.paid_at > now() - interval '7 days' AND p.wallet_transaction_id IS NULL
    UNION ALL
    SELECT 'distribution', d.id, d.club_id FROM public.rakeback_distributions d
     WHERE d.status IN ('transferred','paid') AND d.transferred_at > now() - interval '7 days'
       AND d.chip_transfer_id IS NULL
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:rakeback_chain', 'reporting_mismatch', 'warning',
      'rakeback-evidence:' || r.src || ':' || r.id::text,
      0, NULL, NULL, 'reporting', 'rakeback_' || r.src, r.id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'rakeback marked paid/transferred with no linked wallet/chip transaction - the money side has no evidence pointer',
      NULL, jsonb_build_object('kind', r.src, 'row_id', r.id));
    n := n + 1;
  END LOOP;

  -- D. Ticket conservation
  FOR r IN
    SELECT t.id, t.club_id, t.status, t.value,
           CASE WHEN t.status='redeemed' AND t.redeemed_at IS NULL THEN 'redeemed_without_timestamp'
                WHEN t.status='cancelled' AND t.cancelled_at IS NULL THEN 'cancelled_without_timestamp'
                WHEN t.status NOT IN ('redeemed','cancelled') AND COALESCE(t.value,0) <= 0 THEN 'active_nonpositive_value'
           END AS why
    FROM public.tournament_tickets t
    WHERE (t.status='redeemed' AND t.redeemed_at IS NULL)
       OR (t.status='cancelled' AND t.cancelled_at IS NULL)
       OR (t.status NOT IN ('redeemed','cancelled') AND COALESCE(t.value,0) <= 0)
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:tickets', 'reporting_mismatch', 'warning',
      'ticket:' || r.id::text,
      COALESCE(r.value,0), NULL, NULL, 'reporting', 'tournament_tickets', r.id, r.club_id,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'ticket conservation violation: ' || r.why,
      NULL, jsonb_build_object('ticket_id', r.id, 'status', r.status, 'why', r.why));
    n := n + 1;
  END LOOP;

  -- E. Insurance pair-match (net must equal payout − premium; last 24 h)
  FOR r IN
    SELECT i.id, i.club_id, i.union_id, i.premium, i.payout, i.net_result
    FROM public.insurance_transactions i
    WHERE i.created_at > now() - interval '24 hours'
      AND round(COALESCE(i.payout,0) - COALESCE(i.premium,0), 2) <> round(COALESCE(i.net_result,0), 2)
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_settlement_correctness_check:insurance', 'reporting_mismatch', 'warning',
      'insurance-pair:' || r.id::text,
      round((COALESCE(r.payout,0) - COALESCE(r.premium,0)) - COALESCE(r.net_result,0), 2),
      round(COALESCE(r.payout,0) - COALESCE(r.premium,0), 2), r.net_result,
      'reporting', 'insurance_transactions', r.id, r.club_id, r.union_id,
      NULL, NULL, NULL, NULL, NULL, NULL,
      'insurance row does not pair: net_result must equal payout minus premium exactly',
      NULL, jsonb_build_object('insurance_id', r.id));
    n := n + 1;
  END LOOP;

  -- F. Ticket VALUE conservation (phase 2b): every redeemed/cancelled
  -- ticket must have exactly one credit receipt of exactly its value.
  FOR r IN
    SELECT t.id, t.club_id, t.value, t.status,
           (SELECT count(*) FROM public.chip_transactions ct
             /* A TICKET ENTRY IS AN ENTRY (2026-09-10): an entry-only ticket is
                redeemed by the entry door, whose receipt is
                tournament_ticket_entry; the cash door writes
                tournament_ticket_redeem. Both are the one receipt. */
             WHERE ct.transaction_type = ANY (CASE t.status WHEN 'redeemed'
                     THEN ARRAY['tournament_ticket_redeem','tournament_ticket_entry']
                     ELSE ARRAY['tournament_ticket_cancel'] END)
               AND ct.metadata->>'ticket_id' = t.id::text) AS receipts,
           (SELECT COALESCE(sum(ct.amount),0) FROM public.chip_transactions ct
             /* A TICKET ENTRY IS AN ENTRY (2026-09-10): an entry-only ticket is
                redeemed by the entry door, whose receipt is
                tournament_ticket_entry; the cash door writes
                tournament_ticket_redeem. Both are the one receipt. */
             WHERE ct.transaction_type = ANY (CASE t.status WHEN 'redeemed'
                     THEN ARRAY['tournament_ticket_redeem','tournament_ticket_entry']
                     ELSE ARRAY['tournament_ticket_cancel'] END)
               AND ct.metadata->>'ticket_id' = t.id::text) AS receipt_value
    FROM public.tournament_tickets t
    WHERE t.status IN ('redeemed','cancelled')
      AND COALESCE(t.redeemed_at, t.cancelled_at) > now() - interval '24 hours'
    LIMIT 50
  LOOP
    IF r.receipts <> 1 OR round(r.receipt_value,2) <> round(r.value,2) THEN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settlement_correctness_check:ticket_value', 'reporting_mismatch', 'warning',
        'ticket-value:' || r.id::text,
        round(r.receipt_value - r.value, 2), r.value, r.receipt_value,
        'settlement', 'tournament_tickets', r.id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'ticket value conservation broken: ' || r.status || ' ticket worth ' || r.value
          || ' has ' || r.receipts || ' receipt(s) totalling ' || r.receipt_value,
        NULL, jsonb_build_object('ticket_id', r.id));
      n := n + 1;
    END IF;
  END LOOP;

  -- G. Legacy-fallback alarm (phase 2b): once the engine settles ≥50% of
  -- hands through the atomic claim RPC (24h view), any last-hour coverage
  -- below 90% means a regression re-opened the unsafe per-seat path.
  DECLARE
    v_hands_24h bigint; v_claims_24h bigint; v_hands_1h bigint; v_claims_1h bigint;
  BEGIN
    SELECT count(*) INTO v_hands_24h FROM public.hand_history
     WHERE created_at > now() - interval '24 hours' AND has_human;
    SELECT count(*) INTO v_claims_24h FROM public.settlement_idempotency_keys
     WHERE first_attempt_at > now() - interval '24 hours';
    IF v_hands_24h > 100 AND v_claims_24h >= v_hands_24h / 2 THEN
      SELECT count(*) INTO v_hands_1h FROM public.hand_history
       WHERE created_at > now() - interval '60 minutes' AND has_human;
      SELECT count(*) INTO v_claims_1h FROM public.settlement_idempotency_keys
       WHERE first_attempt_at > now() - interval '60 minutes';
      IF v_hands_1h >= 20 AND v_claims_1h < (v_hands_1h * 9) / 10 THEN
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_settlement_correctness_check:fallback_regression', 'settlement_error', 'warning',
          'fallback-regression:' || to_char(now(), 'YYYY-MM-DD-HH24'),
          0, v_hands_1h, v_claims_1h, 'settlement', 'settlement_idempotency_keys',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          'atomic hand settlement coverage fell to ' || v_claims_1h || '/' || v_hands_1h
            || ' hands in the last hour after adoption - the engine has regressed to the legacy per-seat write path',
          NULL, jsonb_build_object('claims_1h', v_claims_1h, 'hands_1h', v_hands_1h));
        n := n + 1;
      END IF;
    END IF;
  END;

  -- ═══════════════════════════════════════════════════════════════════════
  --  H. THE SETTLER'S WATERMARK IS THE UNION CASCADE'S GATE (2026-09-21)
  -- ═══════════════════════════════════════════════════════════════════════
  --
  -- fn_process_weekly_accounting_scope raises
  -- `weekly_rake_source_not_fully_accrued` when any cash rake record inside
  -- the week being settled still sits above
  -- daemon_state.rakeback_settler.high_water_mark. That refusal is correct and
  -- must stay - settling a week on a source that is not fully accrued posts an
  -- understated week. What was missing is that the CONDITION causing it was
  -- invisible.
  --
  -- Measured 2026-09-21T15:26:06Z: the watermark was 2026-09-21T14:34:09Z, 52
  -- minutes stale, with 985 rake_records above it, while
  -- engine.smarter.poker/health reported settlementStatus "ok" and
  -- blockedSettlementCount 0, and fn_settler_lag_check - which nothing in the
  -- codebase or the cron schedule ever called - returned healthy:true.
  --
  -- No new job, timer, watcher or repair loop: this hourly settlement
  -- correctness check already runs and already raises durable, deduped,
  -- escalatable incidents. It now also asks the settler probe, and the probe
  -- now knows what the settler's interval is and what the cascade needs.
  DECLARE
    v_settler jsonb;
    v_blocked boolean;
  BEGIN
    v_settler := public.fn_settler_lag_check();
    IF COALESCE((v_settler->>'healthy')::boolean, true) IS NOT TRUE THEN
      v_blocked := COALESCE((v_settler->>'week_settlement_blocked')::boolean, false);
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_settlement_correctness_check:settler_lag', 'settlement_error',
        CASE WHEN v_blocked THEN 'critical' ELSE 'warning' END,
        'settler-lag:' || CASE WHEN v_blocked THEN 'blocking:' ELSE 'stalled:' END
          || to_char(now(), 'YYYY-MM-DD-HH24'),
        0, NULL, NULLIF(v_settler->>'backlog_rows','')::numeric,
        'settlement', 'daemon_state', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        CASE WHEN v_blocked THEN
          'the union weekly cascade WILL refuse this week: '
            || COALESCE(v_settler->>'week_unaccrued_rows','?')
            || ' cash rake record(s) inside the week now due to settle are still above the'
            || ' rakeback settler watermark (' || COALESCE(v_settler->>'cursor','?')
            || '). fn_process_weekly_accounting_scope raises'
            || ' weekly_rake_source_not_fully_accrued on exactly this state and settles nothing.'
        ELSE
          'the rakeback settler watermark has not advanced for '
            || COALESCE(v_settler->>'last_save_minutes_ago','?') || ' minute(s) while '
            || COALESCE(v_settler->>'backlog_rows','?') || ' rake record(s) wait above it.'
            || ' The settler interval is ' || COALESCE(v_settler->>'interval_minutes','?')
            || ' minutes, so the drain has skipped a cycle - and a watermark left behind the'
            || ' week end blocks the whole union settlement cascade.'
        END,
        NULL, v_settler);
      n := n + 1;
    END IF;
  END;

  RETURN n;
END $function$;

-- fn_ca_settlement_correctness_check is on fn_ca_guard_watchlist(), so this
-- redefinition is DECLARED in the same transaction that makes it. Undeclared,
-- fn_ca_guard_defs_watch opens an INFO notice a human has to close by hand;
-- declared, the baseline moves with the change and the watcher has nothing to
-- report. Sections B through G are the live definition unchanged; section H is
-- the addition this migration exists for.
SELECT public.fn_ca_declare_guard_redefinition(
  'fn_ca_settlement_correctness_check',
  'migration a_stalled_rakeback_settler_is_an_incident_not_a_silence');

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Authorization, stated rather than assumed.
--
-- Both are operator/engine telemetry: one is a diagnostic probe, the other is
-- the scheduled correctness sweep that files incidents. Neither has any reason
-- to be reachable from a browser, logged in or not, and both are SECURITY
-- DEFINER, so they run past RLS as the owner.
--
-- This re-asserts the posture production already has (verified 2026-09-21:
-- both hold exactly `postgres=X/postgres | service_role=X/postgres`). It
-- changes no privilege - it writes the intent down so a later CREATE OR
-- REPLACE cannot quietly widen it, and so the definer-authorization check can
-- read the answer out of the migration instead of guessing. pg_cron runs these
-- as the owner and is unaffected.
-- ───────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.fn_settler_lag_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_settler_lag_check() TO service_role;

REVOKE ALL ON FUNCTION public.fn_ca_settlement_correctness_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_settlement_correctness_check() TO service_role;
