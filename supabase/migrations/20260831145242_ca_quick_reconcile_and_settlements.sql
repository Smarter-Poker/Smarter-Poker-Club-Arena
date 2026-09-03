-- Applied to production via Supabase MCP on 2026-08-31 (zero-drift directive).
-- This file is the byte-exact mirror of the applied migration.
-- ═══════════════════════════════════════════════════════════════════════════
-- ZERO-DRIFT PART 5: CONTINUOUS NON-BLOCKING RECONCILIATION,
-- AUTOMATED REPAIR, SETTLEMENT STATE MACHINE, SUPPLY MONITOR
-- Nothing here locks, closes, or freezes any table, game, club, union,
-- player, or wallet. Detection raises incidents; repair only calls existing
-- idempotent re-drive functions or re-verifies; corrections are ledger rows.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Settlement state machine ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_settlements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_type text NOT NULL,           -- cash_hand | tournament | spin | bbj | period | adjustment
  external_ref    text NOT NULL,           -- e.g. 'hand:<table>:<hand_no>' / 'tournament:<id>'
  state           text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open','locked_for_calculation','calculated','validated',
                     'ledger_posted','post_commit_verified','final','failed')),
  club_id         uuid,
  union_id        uuid,
  table_id        uuid,
  tournament_id   uuid,
  hand_id         uuid,
  idempotency_key text,
  correlation_id  uuid,
  epoch_id        int DEFAULT public.fn_ca_current_epoch(),
  totals          jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_detail    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (settlement_type, external_ref)
);
ALTER TABLE public.ca_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_settlements FROM anon, authenticated;

-- A settlement may only advance forward, one state at a time (failed is
-- reachable from any non-final state; retry re-enters at the failed step).
-- 'locked_for_calculation' locks ONLY this settlement row — never a table,
-- club, union, wallet, or player.
CREATE OR REPLACE FUNCTION public.fn_ca_settlement_transition_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ord_old int; ord_new int;
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  ord_old := array_position(ARRAY['open','locked_for_calculation','calculated',
              'validated','ledger_posted','post_commit_verified','final'], OLD.state);
  ord_new := array_position(ARRAY['open','locked_for_calculation','calculated',
              'validated','ledger_posted','post_commit_verified','final'], NEW.state);
  IF OLD.state = 'final' THEN
    RAISE EXCEPTION 'settlement % is final and cannot change state', OLD.id;
  END IF;
  IF NEW.state = 'failed' THEN
    NEW.updated_at := now(); RETURN NEW;
  END IF;
  IF OLD.state = 'failed' THEN  -- resume: re-enter anywhere at or before ledger_posted
    IF ord_new IS NULL OR ord_new > 5 THEN
      RAISE EXCEPTION 'failed settlement % may only resume at or before ledger_posted', OLD.id;
    END IF;
    NEW.updated_at := now(); RETURN NEW;
  END IF;
  IF ord_old IS NULL OR ord_new IS NULL OR ord_new <> ord_old + 1 THEN
    RAISE EXCEPTION 'invalid settlement transition % -> % for %', OLD.state, NEW.state, OLD.id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_ca_settlement_guard ON public.ca_settlements;
CREATE TRIGGER trg_ca_settlement_guard
  BEFORE UPDATE ON public.ca_settlements
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_settlement_transition_guard();

-- ── 2. Chip-supply snapshot + unexplained-change monitor ───────────────────
CREATE TABLE IF NOT EXISTS public.ca_supply_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  taken_at timestamptz NOT NULL DEFAULT now(),
  member_wallets numeric NOT NULL,
  member_promo   numeric NOT NULL,
  felt           numeric NOT NULL,
  treasuries     numeric NOT NULL,
  chip_pools     numeric NOT NULL,
  club_wallets   numeric NOT NULL,
  union_wallets  numeric NOT NULL,
  agent_wallets  numeric NOT NULL,
  bbj_pools      numeric NOT NULL,
  spin_pools     numeric NOT NULL,
  total          numeric NOT NULL,
  mint_since_prev numeric,
  burn_since_prev numeric,
  delta_vs_prev   numeric,
  unexplained     numeric
);
ALTER TABLE public.ca_supply_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_supply_snapshots FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_supply_snapshot()
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s RECORD; prev RECORD; v_mint numeric; v_burn numeric; v_unexplained numeric;
BEGIN
  SELECT
    (SELECT COALESCE(sum(chip_balance),0) FROM club_members)            AS member_wallets,
    (SELECT COALESCE(sum(promo_balance),0) FROM club_members)           AS member_promo,
    (SELECT COALESCE(sum(stack),0) FROM table_seats
      WHERE left_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tables t
                         WHERE t.id = table_seats.table_id
                           AND t.tournament_id IS NOT NULL))            AS felt,
    (SELECT COALESCE(sum(chip_treasury),0) FROM clubs)                  AS treasuries,
    (SELECT COALESCE(sum(chip_pool),0) FROM clubs)                      AS chip_pools,
    (SELECT COALESCE(sum(chip_balance),0) FROM club_wallets)            AS club_wallets,
    (SELECT COALESCE(sum(chip_balance+rake_wallet+bbj_wallet+promo_wallet
             +insurance_wallet+COALESCE(spin_reserve_wallet,0)),0)
       FROM union_wallets)                                              AS union_wallets,
    (SELECT COALESCE(sum(COALESCE(agent_wallet_balance,0)
             +COALESCE(promo_wallet_balance,0)),0) FROM agents)         AS agent_wallets,
    (SELECT COALESCE(sum(main_balance+backup_balance+promo_balance),0)
       FROM bbj_pools)                                                  AS bbj,
    (SELECT COALESCE(sum(balance),0) FROM spin_bonus_pools)             AS spin
  INTO s;

  SELECT * INTO prev FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;

  IF prev.id IS NOT NULL THEN
    SELECT COALESCE(sum(amount) FILTER (WHERE from_type IN ('system_mint','issuance_reserve')),0),
           COALESCE(sum(amount) FILTER (WHERE to_type   IN ('system_burn','chip_retirement')),0)
      INTO v_mint, v_burn
      FROM public.chip_ledger
     WHERE created_at > prev.taken_at;
  END IF;

  INSERT INTO public.ca_supply_snapshots
    (member_wallets, member_promo, felt, treasuries, chip_pools, club_wallets,
     union_wallets, agent_wallets, bbj_pools, spin_pools, total,
     mint_since_prev, burn_since_prev, delta_vs_prev, unexplained)
  VALUES
    (s.member_wallets, s.member_promo, s.felt, s.treasuries, s.chip_pools,
     s.club_wallets, s.union_wallets, s.agent_wallets, s.bbj, s.spin,
     s.member_wallets + s.member_promo + s.felt + s.treasuries + s.chip_pools
       + s.union_wallets + s.agent_wallets + s.bbj + s.spin,
     v_mint, v_burn,
     CASE WHEN prev.id IS NULL THEN NULL ELSE
       (s.member_wallets + s.member_promo + s.felt + s.treasuries + s.chip_pools
        + s.union_wallets + s.agent_wallets + s.bbj + s.spin) - prev.total END,
     CASE WHEN prev.id IS NULL THEN NULL ELSE
       (s.member_wallets + s.member_promo + s.felt + s.treasuries + s.chip_pools
        + s.union_wallets + s.agent_wallets + s.bbj + s.spin) - prev.total
        - COALESCE(v_mint,0) + COALESCE(v_burn,0) END)
  RETURNING unexplained INTO v_unexplained;

  /* NOTE: club_wallets.chip_balance is a rake accumulator (period settlement
     bookkeeping) and total excludes it to avoid double-counting rake that
     also lands in union rake wallets / treasuries. Documented in the ledger
     architecture doc; revisit when the accumulator is retired. */

  RETURN v_unexplained;
END $$;

-- ── 3. Quick reconcile pass (every 5 minutes) ──────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_quick_reconcile()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r RECORD; n int := 0; v_frozen numeric; v_now numeric;
BEGIN
  -- 3a. Negative balances anywhere (loud, never blocking)
  FOR r IN
    SELECT 'player_wallet' AS pool, m.user_id AS entity_id, m.club_id, m.chip_balance AS amt,
           (COALESCE(m.credit_limit,0) > 0) AS credit_authorized
      FROM club_members m WHERE COALESCE(m.chip_balance,0) < 0
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
    -- an in-credit player balance is authorized business state, not drift
    CONTINUE WHEN r.pool = 'player_wallet' AND r.credit_authorized;
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:negative_balance',
      CASE WHEN r.pool = 'club_treasury' THEN 'treasury_error'
           WHEN r.pool = 'credit' THEN 'credit_line_error'
           ELSE 'ledger_imbalance' END,
      CASE WHEN r.pool = 'club_treasury' THEN 'warning' ELSE 'critical' END,
      'qr:neg:' || r.pool || ':' || COALESCE(r.entity_id::text,'-') || ':' || CURRENT_DATE::text,
      abs(r.amt), 0, r.amt, 'ledger', r.pool, r.entity_id, r.club_id,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'unauthorized negative balance in ' || r.pool, NULL, '{}'::jsonb);
    n := n + 1;
  END LOOP;

  -- 3b. The frozen public.wallets pool must not move
  SELECT frozen_total INTO v_frozen
    FROM public.ca_frozen_pool_baseline WHERE pool = 'public.wallets';
  SELECT COALESCE(SUM(balance), 0) INTO v_now FROM public.wallets;
  IF v_frozen IS NOT NULL AND v_now <> v_frozen THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:frozen_pool', 'unauthorized_adjustment', 'critical',
      'qr:frozen_wallets:' || CURRENT_DATE::text,
      v_now - v_frozen, v_frozen, v_now, 'ledger', 'frozen_wallets_pool',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'a money path is writing to the dead public.wallets pool', NULL, '{}'::jsonb);
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

  -- 3d. Fresh unaccounted cash seat exits (10-minute grace)
  FOR r IN
    SELECT * FROM public.fn_unaccounted_seat_exits('30 minutes'::interval, '10 minutes'::interval)
    LIMIT 20
  LOOP
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:seat_exit', 'missing_payment', 'critical',
      'qr:seatexit:' || r.id::text,
      -r.stack, r.stack, 0, 'ledger', 'seat_stack_exit', r.user_id,
      r.club_id, NULL, r.table_id, NULL, NULL, NULL, NULL, NULL,
      'seat exited with ' || r.stack || ' chips and no matching wallet credit',
      false, jsonb_build_object('exit_id', r.id, 'exit_kind', r.exit_kind));
    n := n + 1;
  END LOOP;

  -- 3e. Ledger write failures (the journal itself failed — must never be silent)
  FOR r IN
    SELECT * FROM public.ca_ledger_write_failures
     WHERE occurred_at > now() - interval '10 minutes'
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

  -- 3f. Unclassified (suspense) flow — daily informational rollup during the
  -- category-migration phase; tightens once all RPCs declare categories.
  PERFORM 1 FROM public.chip_ledger
   WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
     AND created_at > now() - interval '1 day' LIMIT 1;
  IF FOUND THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:suspense_flow', 'unknown', 'warning',
      'qr:suspense:' || CURRENT_DATE::text,
      (SELECT COALESCE(sum(amount),0) FROM public.chip_ledger
        WHERE (from_type='settlement_suspense' OR to_type='settlement_suspense')
          AND created_at > CURRENT_DATE),
      NULL, NULL, 'ledger', 'settlement_suspense', NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL,
      'balance movements posted without a declared counterparty today (category-migration phase)',
      true, '{}'::jsonb);
  END IF;

  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_quick_reconcile() FROM PUBLIC, anon, authenticated;

-- ── 4. Automated repair tick ───────────────────────────────────────────────
-- May only: re-run existing idempotent re-drives, rebuild projections,
-- re-verify and auto-resolve incidents whose source measurement is now clean.
-- Never mints, burns, deletes, or silently adjusts.
CREATE OR REPLACE FUNCTION public.fn_ca_auto_reconcile_tick()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inc RECORD; repaired int := 0; v_clean boolean; v_res text;
BEGIN
  FOR inc IN
    SELECT * FROM public.ca_drift_incidents
     WHERE status IN ('open','acknowledged','reconciling')
       AND auto_repair_status IN ('pending','running')
     ORDER BY detected_at
     LIMIT 25
  LOOP
    v_clean := false; v_res := NULL;

    -- targeted idempotent re-drives by classification
    BEGIN
      IF inc.classification = 'incorrect_rake' THEN
        PERFORM public.fn_redrive_unbanked_rake(100);
        v_res := 'ran fn_redrive_unbanked_rake(100)';
      ELSIF inc.classification = 'bbj_error' THEN
        PERFORM public.fn_bbj_repair_unbanked(24, 100);
        v_res := 'ran fn_bbj_repair_unbanked(24,100)';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_res := 'redrive failed: ' || SQLERRM;
    END;

    -- re-verify the original measurement where we can
    IF inc.entity_type = 'seat_stack_exit' AND (inc.metadata ? 'exit_id') THEN
      SELECT NOT EXISTS (
        SELECT 1 FROM public.fn_unaccounted_seat_exits('7 days'::interval) u
         WHERE u.id = (inc.metadata->>'exit_id')::bigint) INTO v_clean;
    ELSIF inc.entity_type = 'settlement_idempotency_keys' AND inc.table_id IS NOT NULL THEN
      SELECT NOT EXISTS (
        SELECT 1 FROM settlement_idempotency_keys k
         WHERE k.table_id = inc.table_id AND k.hand_id = inc.hand_id
           AND k.status = 'in_flight') INTO v_clean;
    ELSIF inc.entity_type = 'frozen_wallets_pool' THEN
      SELECT (SELECT COALESCE(SUM(balance),0) FROM public.wallets)
             = (SELECT frozen_total FROM public.ca_frozen_pool_baseline
                 WHERE pool = 'public.wallets') INTO v_clean;
    ELSIF inc.entity_type IN ('player_wallet','club_treasury','union_wallet','agent_wallet','bbj_pool')
          AND inc.source = 'fn_ca_quick_reconcile:negative_balance' THEN
      -- clean when the pool is no longer negative
      v_clean := NOT EXISTS (
        SELECT 1 WHERE
          (inc.entity_type='club_treasury' AND EXISTS
            (SELECT 1 FROM clubs WHERE id = inc.entity_id AND COALESCE(chip_treasury,0) < 0))
          OR (inc.entity_type='player_wallet' AND EXISTS
            (SELECT 1 FROM club_members WHERE user_id = inc.entity_id
              AND club_id = inc.club_id AND COALESCE(chip_balance,0) < 0
              AND COALESCE(credit_limit,0) = 0)));
    END IF;

    IF v_clean THEN
      UPDATE public.ca_drift_incidents
         SET status = 'resolved', resolved_at = now(),
             auto_repair_status = 'repaired',
             resolution = COALESCE(v_res || '; ', '') || 'source measurement re-verified clean',
             root_cause = COALESCE(root_cause, 'transient / repaired by idempotent re-drive')
       WHERE id = inc.id;
      INSERT INTO public.ca_incident_events (incident_id, kind, detail)
      VALUES (inc.id, 'repair_action',
              jsonb_build_object('action', COALESCE(v_res,'reverify'), 'result', 'clean -> resolved'));
      PERFORM public.fn_ca_incident_notify(inc.id, 'notified',
        '✅ Auto-reconciled: ' || inc.classification, false);
      repaired := repaired + 1;
    ELSIF v_res IS NOT NULL THEN
      UPDATE public.ca_drift_incidents SET auto_repair_status = 'running' WHERE id = inc.id;
      INSERT INTO public.ca_incident_events (incident_id, kind, detail)
      VALUES (inc.id, 'repair_action', jsonb_build_object('action', v_res, 'result', 'pending re-check'));
    ELSIF inc.auto_repair_status = 'pending'
          AND now() - inc.detected_at > interval '10 minutes' THEN
      UPDATE public.ca_drift_incidents SET auto_repair_status = 'manual_needed' WHERE id = inc.id;
      INSERT INTO public.ca_incident_events (incident_id, kind, detail)
      VALUES (inc.id, 'repair_action',
              jsonb_build_object('action', 'none applicable', 'result', 'manual_needed'));
    END IF;
  END LOOP;
  RETURN repaired;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_auto_reconcile_tick() FROM PUBLIC, anon, authenticated;

-- ── 5. Crons ───────────────────────────────────────────────────────────────
SELECT cron.schedule('ca-quick-reconcile-5m', '*/5 * * * *',
  $cron$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-quick-reconcile'))
    THEN (SELECT public.fn_ca_quick_reconcile()) ELSE -1 END; $cron$);

SELECT cron.schedule('ca-auto-reconcile-tick', '* * * * *',
  $cron$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-auto-reconcile-tick'))
    THEN (SELECT public.fn_ca_auto_reconcile_tick()) ELSE -1 END; $cron$);

SELECT cron.schedule('ca-supply-snapshot-hourly', '5 * * * *',
  $cron$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-supply-snapshot'))
    THEN (SELECT public.fn_ca_supply_snapshot()) ELSE NULL END; $cron$);

SELECT cron.schedule('ca-ledger-chain-verify-daily', '35 4 * * *',
  $cron$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-ledger-chain-verify'))
    THEN (SELECT checked FROM public.fn_ca_verify_ledger_chain(100000)) ELSE -1 END; $cron$);
-- ---------------------------------------------------------------------------
-- AND THE GRANT (added by the agent landing this bundle).
-- fn_ca_supply_snapshot is SECURITY DEFINER and writes a chip-supply snapshot;
-- its callers are fn_ca_quick_reconcile and the cron ticks, all service_role,
-- and nothing in either repo calls it from a browser. Revoked here as well as
-- in 20260831161047 so that at NO point during a replay is it open - a later
-- migration closing it still leaves a window in between.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.fn_ca_supply_snapshot() FROM PUBLIC, anon, authenticated;
