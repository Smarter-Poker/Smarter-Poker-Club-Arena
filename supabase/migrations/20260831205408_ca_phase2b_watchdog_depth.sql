-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").
-- Applied 2026-08-31 20:54:08 UTC on kuklfnapbkmacvwxktbh.

-- ═══════════════════════════════════════════════════════════════════════════
-- ROUND-2 BUILD-OUT, PHASE 2 — WATCHDOG DEPTH
-- ═══════════════════════════════════════════════════════════════════════════
-- A. Ticket money flows declare their categories (issue = ticket_issue into
--    escrow; redeem = ticket_redeem out of escrow; cancel = escrow_release
--    back to the issuer). The ticket system is dormant today (0 tickets in
--    7 days) — this makes its first real use land ledgered, not as suspense.
-- B. Ticket VALUE conservation joins the 30-minute correctness sweep: every
--    redeemed/cancelled ticket must have exactly one matching credit receipt
--    of exactly the ticket's value.
-- C. Blocked-mint tracker verifies the engine fix: when a full day passes
--    with zero blocked tournament-cashout attempts, the tracker resolves
--    itself and sends ONE deliberate push confirming the engine exit path
--    is verified fixed.
-- D. Burn-in gate history + the green push: hourly, the 12-check gate runs
--    and records to ca_gate_runs; on a red→green transition you get ONE
--    "gate GREEN" push. Readiness becomes a trend you can watch, and good
--    news is the one push worth sending.
-- E. Legacy-fallback alarm: once the engine's atomic hand settlement is
--    adopted (≥50% of settling hands claiming), any hour where claims cover
--    <90% of hands raises a warning — adoption cannot silently rot back to
--    the unsafe path.

-- ── A. ticket GUCs (anchored dynamic patches) ────────────────────────────
DO $$
DECLARE v_def text; v_new text;
BEGIN
  -- redeem: credit to holder = ticket_redeem from escrow
  v_def := pg_get_functiondef('public.fn_redeem_tournament_ticket(uuid)'::regprocedure);
  IF v_def NOT LIKE '%ledger_category%' THEN
    v_new := replace(v_def,
'  update public.club_members
     set chip_balance=coalesce(chip_balance,0)+v_t.value,updated_at=now()',
'  perform set_config(''app.ledger_category'',''ticket_redeem'',true);
  perform set_config(''app.ledger_counterparty'',''escrow'',true);
  perform set_config(''app.ledger_counterparty_entity'','''',true);
  update public.club_members
     set chip_balance=coalesce(chip_balance,0)+v_t.value,updated_at=now()');
    IF v_new = v_def THEN RAISE EXCEPTION 'redeem anchor not found'; END IF;
    EXECUTE v_new;
  END IF;

  -- cancel: refund to issuer = escrow_release
  v_def := pg_get_functiondef('public.fn_cancel_tournament_ticket(uuid)'::regprocedure);
  IF v_def NOT LIKE '%ledger_category%' THEN
    v_new := replace(v_def,
'  update public.club_members
     set chip_balance=coalesce(chip_balance,0)+v_t.value,updated_at=now()',
'  perform set_config(''app.ledger_category'',''escrow_release'',true);
  perform set_config(''app.ledger_counterparty'',''escrow'',true);
  perform set_config(''app.ledger_counterparty_entity'','''',true);
  update public.club_members
     set chip_balance=coalesce(chip_balance,0)+v_t.value,updated_at=now()');
    IF v_new = v_def THEN RAISE EXCEPTION 'cancel anchor not found'; END IF;
    EXECUTE v_new;
  END IF;

  -- issue core: debit from issuer = ticket_issue into escrow
  v_def := pg_get_functiondef((SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='public' AND p.proname='fn_issue_tournament_ticket_phase2_core_20260831')::regprocedure);
  IF v_def NOT LIKE '%ledger_category%' THEN
    v_new := replace(v_def,
'  update public.club_members set chip_balance=coalesce(chip_balance,0)-p_value,updated_at=now()',
'  perform set_config(''app.ledger_category'',''ticket_issue'',true);
  perform set_config(''app.ledger_counterparty'',''escrow'',true);
  perform set_config(''app.ledger_counterparty_entity'','''',true);
  update public.club_members set chip_balance=coalesce(chip_balance,0)-p_value,updated_at=now()');
    IF v_new = v_def THEN RAISE EXCEPTION 'issue anchor not found'; END IF;
    EXECUTE v_new;
  END IF;
END $$;

-- ── B+E. two new sections on the correctness sweep ───────────────────────
DO $$
DECLARE v_def text; v_new text;
BEGIN
  v_def := pg_get_functiondef('public.fn_ca_settlement_correctness_check()'::regprocedure);
  IF v_def LIKE '%ticket-value:%' THEN RETURN; END IF;
  v_new := replace(v_def,
'  RETURN n;
END $function2$',
'  RETURN n;
END $function2$');
  -- (anchor on the tail comment-free RETURN; the real anchor is below)
  v_new := replace(v_def,
'  RETURN n;
END $function$',
'  -- F. Ticket VALUE conservation (phase 2b): every redeemed/cancelled
  -- ticket must have exactly one credit receipt of exactly its value.
  FOR r IN
    SELECT t.id, t.club_id, t.value, t.status,
           (SELECT count(*) FROM public.chip_transactions ct
             WHERE ct.transaction_type = CASE t.status WHEN ''redeemed''
                     THEN ''tournament_ticket_redeem'' ELSE ''tournament_ticket_cancel'' END
               AND ct.metadata->>''ticket_id'' = t.id::text) AS receipts,
           (SELECT COALESCE(sum(ct.amount),0) FROM public.chip_transactions ct
             WHERE ct.transaction_type = CASE t.status WHEN ''redeemed''
                     THEN ''tournament_ticket_redeem'' ELSE ''tournament_ticket_cancel'' END
               AND ct.metadata->>''ticket_id'' = t.id::text) AS receipt_value
    FROM public.tournament_tickets t
    WHERE t.status IN (''redeemed'',''cancelled'')
      AND COALESCE(t.redeemed_at, t.cancelled_at) > now() - interval ''24 hours''
    LIMIT 50
  LOOP
    IF r.receipts <> 1 OR round(r.receipt_value,2) <> round(r.value,2) THEN
      PERFORM public.fn_ca_raise_drift_incident(
        ''fn_ca_settlement_correctness_check:ticket_value'', ''reporting_mismatch'', ''warning'',
        ''ticket-value:'' || r.id::text,
        round(r.receipt_value - r.value, 2), r.value, r.receipt_value,
        ''settlement'', ''tournament_tickets'', r.id, r.club_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        ''ticket value conservation broken: '' || r.status || '' ticket worth '' || r.value
          || '' has '' || r.receipts || '' receipt(s) totalling '' || r.receipt_value,
        NULL, jsonb_build_object(''ticket_id'', r.id));
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
     WHERE created_at > now() - interval ''24 hours'' AND has_human IS TRUE;
    SELECT count(*) INTO v_claims_24h FROM public.settlement_idempotency_keys
     WHERE first_attempt_at > now() - interval ''24 hours'';
    IF v_hands_24h > 100 AND v_claims_24h >= v_hands_24h / 2 THEN
      SELECT count(*) INTO v_hands_1h FROM public.hand_history
       WHERE created_at > now() - interval ''60 minutes'' AND has_human IS TRUE;
      SELECT count(*) INTO v_claims_1h FROM public.settlement_idempotency_keys
       WHERE first_attempt_at > now() - interval ''60 minutes'';
      IF v_hands_1h >= 20 AND v_claims_1h < (v_hands_1h * 9) / 10 THEN
        PERFORM public.fn_ca_raise_drift_incident(
          ''fn_ca_settlement_correctness_check:fallback_regression'', ''settlement_error'', ''warning'',
          ''fallback-regression:'' || to_char(now(), ''YYYY-MM-DD-HH24''),
          0, v_hands_1h, v_claims_1h, ''settlement'', ''settlement_idempotency_keys'',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          ''atomic hand settlement coverage fell to '' || v_claims_1h || ''/'' || v_hands_1h
            || '' hands in the last hour after adoption — the engine has regressed to the legacy per-seat write path'',
          NULL, jsonb_build_object(''claims_1h'', v_claims_1h, ''hands_1h'', v_hands_1h));
        n := n + 1;
      END IF;
    END IF;
  END;

  RETURN n;
END $function$');
  IF v_new = v_def THEN RAISE EXCEPTION 'sweep tail anchor not found'; END IF;
  EXECUTE v_new;
END $$;

-- ── C+D. gate history, green push, blocked-mint auto-verify ─────────────
CREATE TABLE IF NOT EXISTS public.ca_gate_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_at timestamptz NOT NULL DEFAULT now(),
  pass boolean NOT NULL,
  window_hours integer NOT NULL,
  failing text[],
  result jsonb NOT NULL
);
REVOKE ALL ON public.ca_gate_runs FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_burnin_gate_tick()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_gate jsonb; v_pass boolean; v_prev boolean; v_failing text[];
  v_tracker record; v_uid uuid;
BEGIN
  v_gate := public.fn_ca_midway_burnin_gate(24);
  v_pass := COALESCE((v_gate->>'pass')::boolean, false);
  SELECT COALESCE(array_agg(k), '{}') INTO v_failing
    FROM jsonb_each(v_gate->'checks') e(k, v) WHERE (v->'pass')::boolean = false;
  SELECT pass INTO v_prev FROM public.ca_gate_runs ORDER BY run_at DESC LIMIT 1;
  INSERT INTO public.ca_gate_runs (pass, window_hours, failing, result)
  VALUES (v_pass, 24, v_failing, v_gate);

  -- red -> green: the one push worth sending
  IF v_pass AND (v_prev IS DISTINCT FROM true) THEN
    FOR v_uid IN SELECT user_id FROM public.ca_incident_recipients WHERE active AND scope='platform' LOOP
      PERFORM public.fn_raise_notification(v_uid, 'financial_attestation',
        '🟢 Midway burn-in gate is GREEN',
        'All 12 acceptance checks passed over the last 24 hours. Per the zero-drift directive, Midway/Shark/JAQK may reopen normal tables.',
        '/hub/club-arena/financial-incidents',
        jsonb_build_object('gate', 'green'));
    END LOOP;
  END IF;

  -- blocked-mint tracker auto-verify: a full day of zero attempts after the
  -- engine fix = verified. Resolve the tracker and say so, once.
  FOR v_tracker IN
    SELECT i.id FROM public.ca_drift_incidents i
    WHERE i.dedupe_key LIKE 'tourney-cashout-blocked:%' AND i.status <> 'resolved'
      AND i.detected_at < now() - interval '24 hours'
      AND NOT EXISTS (SELECT 1 FROM public.ca_incident_events e
                       WHERE e.incident_id = i.id AND e.at > now() - interval '24 hours'
                         AND e.kind IN ('created','notified'))
  LOOP
    PERFORM public.fn_ca_incident_action(v_tracker.id, 'resolve',
      'Auto-verified: 24 hours with zero blocked tournament-cashout attempts — the engine exit path is confirmed fixed.',
      NULL, 'engine exit path fix verified by 24h of silence at the guard', NULL);
    FOR v_uid IN SELECT user_id FROM public.ca_incident_recipients WHERE active AND scope='platform' LOOP
      PERFORM public.fn_raise_notification(v_uid, 'financial_attestation',
        '✅ Engine tournament-exit fix verified',
        'The mint guard has seen zero blocked cashout attempts for a full day. The engine-side bug behind the tournament-cashout mint is confirmed fixed.',
        '/hub/club-arena/financial-incidents', '{}'::jsonb);
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('pass', v_pass, 'failing', v_failing);
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_burnin_gate_tick() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-burnin-gate-hourly', '58 * * * *',
  $$SELECT public.fn_ca_burnin_gate_tick();$$);

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
VALUES ('function', 'fn_ca_burnin_gate_tick', NULL, 'phase 2b: gate history + green push + tracker auto-verify', true),
       ('cron', 'ca-burnin-gate-hourly', NULL, 'phase 2b: hourly gate run', true)
ON CONFLICT DO NOTHING;
INSERT INTO public.ca_money_rpc_registry (proname, notes)
VALUES ('fn_ca_burnin_gate_tick', 'phase 2b: read-only gate runner + deliberate positive pushes'),
       ('fn_redeem_tournament_ticket', 'phase 2b: declares ticket_redeem vs escrow'),
       ('fn_cancel_tournament_ticket', 'phase 2b: declares escrow_release vs escrow'),
       ('fn_issue_tournament_ticket_phase2_core_20260831', 'phase 2b: declares ticket_issue vs escrow')
ON CONFLICT DO NOTHING;;
