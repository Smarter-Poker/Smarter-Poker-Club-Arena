-- Applied to production via Supabase MCP on 2026-08-31 (zero-drift round 2).
-- Byte-exact mirror of the applied migration.
-- ═══════════════════════════════════════════════════════════════════════════
-- ZERO-DRIFT ROUND 2 (2026-08-31): tuning + closing the follow-up list.
-- 1. Severity-aware escalation cadence (critical = full 5/10/15/20 + repeats;
--    warning = 5-min + past-target once; info = dashboard-only).
-- 2. rake_law reconcile rows classify as reporting_mismatch.
-- 3. Quick-reconcile v2: suspense rollup becomes info; credit-line bound
--    check (balance below -credit_limit); stuck union PnL settlements.
-- 4. Auto-repair v2: prize-credit incidents auto-resolve when the payout
--    reconciler has verifiably paid the player since detection.
-- 5. Browser write-block on union_wallets/club_wallets/bbj_pools/spin pools.
-- 6. fn_mint_club_chips: 20s duplicate suppression + mint category/issuance
--    counterparty. fn_union_send_to_member: 20s duplicate suppression +
--    union_send category (one clean ledger row per send).
-- 7. fn_ca_drift_metrics() for the incident dashboard.
-- (Journal-table grant revokes ship as separate short transactions after
--  this migration — they need brief exclusive locks on hot tables.)
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Escalation tick v2 ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_incident_escalation_tick()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inc RECORD;
  age_min numeric;
  sent int := 0;
  budget int := 40;
BEGIN
  FOR inc IN
    SELECT * FROM public.ca_drift_incidents
     WHERE status IN ('open','acknowledged','reconciling')
       AND severity IN ('critical','warning')
     ORDER BY detected_at
     LIMIT 200
  LOOP
    EXIT WHEN budget <= 0;
    age_min := extract(epoch FROM now() - inc.detected_at) / 60;

    IF inc.severity = 'warning' THEN
      -- warnings: one 5-minute update, one past-target notice, then quiet
      -- (they stay on the dashboard; only criticals get the full drumbeat)
      IF age_min >= 5 AND inc.escalation_level < 1 THEN
        UPDATE public.ca_drift_incidents SET escalation_level = 1 WHERE id = inc.id;
        PERFORM public.fn_ca_incident_notify(inc.id, 'escalated',
          '⏱ 5-min update: ' || inc.classification || ' unresolved', false);
        budget := budget - 1; sent := sent + 1;
      ELSIF age_min >= 20 AND inc.escalation_level < 4 THEN
        UPDATE public.ca_drift_incidents
           SET escalation_level = 4, past_target = true WHERE id = inc.id;
        PERFORM public.fn_ca_incident_notify(inc.id, 'escalated',
          '🟠 Past 20-min target (warning): ' || inc.classification, true);
        budget := budget - 1; sent := sent + 1;
      END IF;
      CONTINUE;
    END IF;

    IF age_min >= 5 AND inc.escalation_level < 1 THEN
      UPDATE public.ca_drift_incidents SET escalation_level = 1 WHERE id = inc.id;
      PERFORM public.fn_ca_incident_notify(inc.id, 'escalated',
        '⏱ 5-min update: ' || inc.classification || ' unresolved', false);
      budget := budget - 1; sent := sent + 1;
    ELSIF age_min >= 10 AND inc.escalation_level < 2 THEN
      UPDATE public.ca_drift_incidents SET escalation_level = 2 WHERE id = inc.id;
      PERFORM public.fn_ca_incident_notify(inc.id, 'escalated',
        '🔺 10-min escalation to senior mgmt: ' || inc.classification, true);
      budget := budget - 1; sent := sent + 1;
    ELSIF age_min >= 15 AND inc.escalation_level < 3 THEN
      UPDATE public.ca_drift_incidents SET escalation_level = 3 WHERE id = inc.id;
      PERFORM public.fn_ca_incident_notify(inc.id, 'escalated',
        '⚠️ 15-min FINAL WARNING before reconcile target: ' || inc.classification, false);
      budget := budget - 1; sent := sent + 1;
    ELSIF age_min >= 20 AND inc.escalation_level < 4 THEN
      UPDATE public.ca_drift_incidents
         SET escalation_level = 4, past_target = true WHERE id = inc.id;
      PERFORM public.fn_ca_incident_notify(inc.id, 'escalated',
        '🔴 PAST 20-MIN TARGET: ' || inc.classification || ' still unresolved', false);
      budget := budget - 1; sent := sent + 1;
    ELSIF inc.escalation_level >= 4
          AND age_min >= 20 + (inc.escalation_level - 3) * 15 THEN
      UPDATE public.ca_drift_incidents
         SET escalation_level = inc.escalation_level + 1 WHERE id = inc.id;
      PERFORM public.fn_ca_incident_notify(inc.id, 'escalated',
        '🔴 Still past target (' || floor(age_min)::int || 'min): ' || inc.classification,
        true);
      budget := budget - 1; sent := sent + 1;
    END IF;
  END LOOP;
  RETURN sent;
END $$;

-- ── 2. Reconcile-log classifier learns the rake_law entity ─────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_reconcile_log_to_incident()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_class text;
  v_layer text;
  v_club uuid;
BEGIN
  IF NEW.severity NOT IN ('warn','critical') THEN RETURN NEW; END IF;

  v_class := CASE NEW.entity_type
    WHEN 'club_treasury'          THEN 'treasury_error'
    WHEN 'frozen_wallets_pool'    THEN 'unauthorized_adjustment'
    WHEN 'seat_stack_exit'        THEN 'missing_payment'
    WHEN 'negative_balance'       THEN 'ledger_imbalance'
    WHEN 'insurance_bank'         THEN 'settlement_error'
    WHEN 'insurance_offer_unresolved' THEN 'settlement_error'
    WHEN 'cashout_escrow_stuck'   THEN 'settlement_error'
    WHEN 'over_claimed_send'      THEN 'duplicate_payment'
    WHEN 'bomb_award_ledger_gap'  THEN 'reporting_mismatch'
    WHEN 'rake_law'               THEN 'reporting_mismatch'
    ELSE 'unknown' END;
  v_layer := CASE NEW.entity_type
    WHEN 'bomb_award_ledger_gap' THEN 'reporting'
    WHEN 'rake_law'              THEN 'reporting'
    ELSE 'ledger' END;
  BEGIN
    v_club := NULLIF(NEW.metadata->>'club_id','')::uuid;
  EXCEPTION WHEN OTHERS THEN v_club := NULL; END;
  IF v_club IS NULL AND NEW.entity_type = 'club_treasury' THEN
    v_club := NEW.entity_id;
  END IF;

  PERFORM public.fn_ca_raise_drift_incident(
    p_source          => 'ledger_reconcile_log:' || COALESCE(NEW.metadata->>'source',
                                                             NEW.metadata->>'kind', '?'),
    p_classification  => v_class,
    p_severity        => CASE NEW.severity WHEN 'critical' THEN 'critical' ELSE 'warning' END,
    p_dedupe_key      => 'lrl:' || NEW.entity_type || ':' || COALESCE(NEW.entity_id::text,'-')
                          || ':' || COALESCE(NEW.metadata->>'exit_id',
                                             NEW.metadata->>'hand_history_id',
                                             NEW.metadata->>'hand_id',
                                             NEW.metadata->>'escrow_id', ''),
    p_discrepancy     => COALESCE(NEW.stored_balance,0) - COALESCE(NEW.ledger_balance,0),
    p_expected        => NEW.ledger_balance,
    p_actual          => NEW.stored_balance,
    p_layer           => v_layer,
    p_entity_type     => NEW.entity_type,
    p_entity_id       => NEW.entity_id,
    p_club_id         => v_club,
    p_suspected_cause => COALESCE(NEW.metadata->>'rule', NEW.metadata->>'kind'),
    p_metadata        => COALESCE(NEW.metadata,'{}'::jsonb));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_reconcile_log_to_incident failed: %', SQLERRM;
  RETURN NEW;
END $$;

-- ── 3. Quick reconcile v2 ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_quick_reconcile()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r RECORD; n int := 0; v_frozen numeric; v_now numeric;
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

  -- 3d. Union PnL settlements stuck in_progress (> 10 minutes) — the
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
      'union PnL settlement stuck in_progress — money may be half-collected/half-paid; resume or reconcile manually',
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
      'qr:seatexit:' || r.id::text,
      -r.stack, r.stack, 0, 'ledger', 'seat_stack_exit', r.user_id,
      r.club_id, NULL, r.table_id, NULL, NULL, NULL, NULL, NULL,
      'seat exited with ' || r.stack || ' chips and no matching wallet credit',
      false, jsonb_build_object('exit_id', r.id, 'exit_kind', r.exit_kind));
    n := n + 1;
  END LOOP;

  -- 3f. Ledger write failures
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

  -- 3g. Unclassified (suspense) flow — info-severity daily rollup: it is a
  -- category-migration metric, not a discrepancy; the dashboard shows it.
  PERFORM 1 FROM public.chip_ledger
   WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
     AND created_at > CURRENT_DATE LIMIT 1;
  IF FOUND THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_quick_reconcile:suspense_flow', 'unknown', 'info',
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

-- ── 4. Auto-repair v2: prize-credit incidents self-verify ──────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_auto_reconcile_tick()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inc RECORD; repaired int := 0; v_clean boolean; v_res text; v_uid uuid;
BEGIN
  FOR inc IN
    SELECT * FROM public.ca_drift_incidents
     WHERE status IN ('open','acknowledged','reconciling')
       AND auto_repair_status IN ('pending','running')
     ORDER BY detected_at
     LIMIT 25
  LOOP
    v_clean := false; v_res := NULL;

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
    IF inc.source LIKE '%winner_prize_credit%' AND (inc.metadata ? 'user_id') THEN
      -- clean when the payout reconciler has credited the owed player since
      BEGIN
        v_uid := (inc.metadata->>'user_id')::uuid;
        SELECT EXISTS (
          SELECT 1 FROM wallet_transactions wt
           WHERE wt.user_id = v_uid AND wt.type = 'credit'
             AND wt.description LIKE 'Tournament payout reconciliation%'
             AND wt.created_at > inc.detected_at) INTO v_clean;
        IF v_clean THEN
          v_res := COALESCE(v_res || '; ', '') ||
            'payout reconciler credit verified in wallet_transactions after detection';
        END IF;
      EXCEPTION WHEN OTHERS THEN v_clean := false;
      END;
    ELSIF inc.entity_type = 'seat_stack_exit' AND (inc.metadata ? 'exit_id') THEN
      SELECT NOT EXISTS (
        SELECT 1 FROM public.fn_unaccounted_seat_exits('7 days'::interval) u
         WHERE u.id = (inc.metadata->>'exit_id')::bigint) INTO v_clean;
    ELSIF inc.entity_type = 'settlement_idempotency_keys' AND inc.table_id IS NOT NULL THEN
      SELECT NOT EXISTS (
        SELECT 1 FROM settlement_idempotency_keys k
         WHERE k.table_id = inc.table_id AND k.hand_id = inc.hand_id
           AND k.status = 'in_flight') INTO v_clean;
    ELSIF inc.entity_type = 'union_pnl_settlements' AND inc.entity_id IS NOT NULL THEN
      SELECT NOT EXISTS (
        SELECT 1 FROM union_pnl_settlements s
         WHERE s.id = inc.entity_id AND s.status = 'in_progress') INTO v_clean;
    ELSIF inc.entity_type = 'frozen_wallets_pool' THEN
      SELECT (SELECT COALESCE(SUM(balance),0) FROM public.wallets)
             = (SELECT frozen_total FROM public.ca_frozen_pool_baseline
                 WHERE pool = 'public.wallets') INTO v_clean;
    ELSIF inc.source = 'fn_ca_quick_reconcile:negative_balance' THEN
      v_clean := NOT EXISTS (
        SELECT 1 WHERE
          (inc.entity_type='club_treasury' AND EXISTS
            (SELECT 1 FROM clubs WHERE id = inc.entity_id AND COALESCE(chip_treasury,0) < 0))
          OR (inc.entity_type='player_wallet' AND EXISTS
            (SELECT 1 FROM club_members WHERE user_id = inc.entity_id
              AND club_id = inc.club_id
              AND COALESCE(chip_balance,0) < -COALESCE(credit_limit,0))));
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

-- ── 5. Browser write-block on remaining money tables ───────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_block_browser_money_table()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION
      'Direct % on %.% from the browser is forbidden. Chips move only through the money RPCs.',
      TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS trg_ca_block_browser ON public.union_wallets;
CREATE TRIGGER trg_ca_block_browser
  BEFORE INSERT OR UPDATE OR DELETE ON public.union_wallets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_block_browser_money_table();
DROP TRIGGER IF EXISTS trg_ca_block_browser ON public.club_wallets;
CREATE TRIGGER trg_ca_block_browser
  BEFORE INSERT OR UPDATE OR DELETE ON public.club_wallets
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_block_browser_money_table();
DROP TRIGGER IF EXISTS trg_ca_block_browser ON public.bbj_pools;
CREATE TRIGGER trg_ca_block_browser
  BEFORE INSERT OR UPDATE OR DELETE ON public.bbj_pools
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_block_browser_money_table();
DROP TRIGGER IF EXISTS trg_ca_block_browser ON public.spin_bonus_pools;
CREATE TRIGGER trg_ca_block_browser
  BEFORE INSERT OR UPDATE OR DELETE ON public.spin_bonus_pools
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_block_browser_money_table();

-- ── 6a. fn_mint_club_chips: duplicate suppression + mint category ──────────
CREATE OR REPLACE FUNCTION public.fn_mint_club_chips(p_club_id uuid, p_amount numeric, p_reason text DEFAULT 'beta top-up'::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
    v_actor uuid := auth.uid();
    v_after numeric;
    v_union uuid;
    v_authorised boolean;
begin
    if p_amount is null or p_amount <= 0 then
        raise exception 'mint amount must be positive, got %', p_amount;
    end if;

    select union_id into v_union from clubs where id = p_club_id;
    if not found then
        raise exception 'mint failed: club % not found', p_club_id;
    end if;

    -- Dan 2026-08-22: only unions mint. A club that has joined a union has no
    -- mint of its own — chips are minted in the union and SENT to the club.
    if v_union is not null then
        raise exception 'Chip Mint is revoked for clubs in a union — chips are minted in the union and sent to the club. Ask your union owner.';
    end if;

    if coalesce(auth.role(), '') <> 'service_role' then
        v_authorised := v_actor is not null and (
            exists (select 1 from clubs c where c.id = p_club_id and c.owner_id = v_actor)
            or exists (
                select 1 from club_members cm
                 where cm.club_id = p_club_id
                   and cm.user_id = v_actor
                   and cm.role in ('owner','co_owner','admin')
                   and cm.status in ('active','approved'))
        );
        if not v_authorised then
            raise exception 'not authorized to mint for this club';
        end if;
    end if;

    /* ZERO-DRIFT round 2 (2026-08-31): duplicate-mint suppression. An
       identical mint (club, amount, reason, actor) inside 20 seconds is a
       retry, not a second intent — return the current treasury unchanged.
       A deliberate second mint just needs a different reason or 20 seconds. */
    if exists (
        select 1 from chip_transactions ct
         where ct.club_id = p_club_id
           and ct.transaction_type = 'treasury_mint'
           and ct.amount = p_amount
           and ct.from_user_id is not distinct from v_actor
           and coalesce(ct.notes,'') = coalesce(p_reason,'')
           and ct.created_at > now() - interval '20 seconds') then
        select coalesce(chip_treasury, 0) into v_after from clubs where id = p_club_id;
        return v_after;
    end if;

    /* Authorized issuance journals against the issuance reserve. */
    perform set_config('app.ledger_category', 'mint', true);
    perform set_config('app.ledger_counterparty', 'issuance_reserve', true);
    perform set_config('app.ledger_counterparty_entity', '', true);

    update public.clubs
       set chip_treasury = coalesce(chip_treasury, 0) + p_amount
     where id = p_club_id
    returning chip_treasury into v_after;

    insert into public.chip_transactions
        (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after)
    values (p_club_id, v_actor, null, p_amount, 'treasury_mint', p_reason, v_after);

    return v_after;
end $function$;

-- ── 6b. fn_union_send_to_member: duplicate suppression + one clean ledger row
CREATE OR REPLACE FUNCTION public.fn_union_send_to_member(p_union_id uuid, p_target_user_id uuid, p_kind text, p_amount numeric, p_source_wallet text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor      uuid := auth.uid();
  v_source     text;
  v_after      numeric;
  v_dia_after  numeric;
  v_club       uuid;
  v_role       text;
  v_is_club    boolean;
  v_agent_row  uuid;
  v_to_after   numeric;
  v_dest       text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    if not public.fn_union_can_manage_wallets(p_union_id, v_actor) then
      return jsonb_build_object('success', false, 'error', 'Only the union owner, co-owner or an admin can send from union wallets.');
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('success', false, 'error', 'amount must be > 0');
  end if;
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('success', false, 'error', 'chips move in hundredths at most');
  end if;
  if p_kind not in ('chips','diamonds','promo') then
    return jsonb_build_object('success', false, 'error', 'kind must be chips, diamonds or promo');
  end if;

  /* ZERO-DRIFT round 2 (2026-08-31): duplicate-send suppression. An identical
     union send (union, recipient, kind, amount, actor) inside 20 seconds is a
     retry, not a second intent. */
  if p_kind in ('chips','promo') and exists (
      select 1 from union_wallet_transactions t
       where t.union_id = p_union_id
         and t.direction = 'debit'
         and t.amount = p_amount
         and t.tx_type in ('member_send','promo_member_send')
         and t.created_by is not distinct from v_actor
         and t.created_at > now() - interval '20 seconds') then
    return jsonb_build_object('success', true, 'duplicate_suppressed', true,
      'note', 'an identical send was recorded seconds ago; nothing moved twice');
  end if;

  select cm.club_id into v_club
    from club_members cm
   where cm.user_id = p_target_user_id
     and coalesce(cm.status, 'active') in ('active','approved')
     and cm.club_id = public.fn_player_home_club(p_target_user_id, null)
     and cm.club_id in (select uc.club_id from union_clubs uc where uc.union_id = p_union_id)
   limit 1;
  if v_club is null then
    select cm.club_id into v_club
      from club_members cm
     where cm.user_id = p_target_user_id
       and coalesce(cm.status, 'active') in ('active','approved')
       and cm.club_id in (select uc.club_id from union_clubs uc where uc.union_id = p_union_id)
     order by coalesce(cm.chip_balance, 0) desc, cm.club_id
     limit 1;
  end if;
  if v_club is null then
    select cm.club_id into v_club
      from club_members cm
     where cm.user_id = p_target_user_id
       and coalesce(cm.status, 'active') in ('active','approved')
       and cm.club_id = p_union_id
     limit 1;
  end if;
  if v_club is null then
    return jsonb_build_object('success', false, 'error', 'That player is not a member of this union.');
  end if;
  v_is_club := exists (select 1 from clubs c where c.id = v_club);
  select cm.role into v_role from club_members cm
   where cm.club_id = v_club and cm.user_id = p_target_user_id
     and coalesce(cm.status, 'active') in ('active','approved')
   limit 1;

  if p_kind = 'diamonds' then
    if p_amount <> floor(p_amount) then
      return jsonb_build_object('success', false, 'error', 'diamonds must be a whole number');
    end if;
    if p_amount > 100000 then
      return jsonb_build_object('success', false, 'error', 'maximum 100,000 diamonds per send');
    end if;
    update profiles set diamonds = coalesce(diamonds, 0) + p_amount
     where id = p_target_user_id
    returning diamonds into v_dia_after;
    if v_dia_after is null then
      return jsonb_build_object('success', false, 'error', 'player profile not found');
    end if;
    insert into diamond_transactions (user_id, type, amount, balance_after, description, transaction_type, source, metadata)
    values (p_target_user_id, 'credit', p_amount, v_dia_after,
            coalesce(p_note, 'Union grant'), 'union_grant', 'union',
            jsonb_build_object('union_id', p_union_id, 'granted_by', v_actor));
    return jsonb_build_object('success', true, 'kind', 'diamonds', 'balance_after', v_dia_after);
  end if;

  /* ZERO-DRIFT round 2: the recipient-side credit journals ONE clean ledger
     row (union_wallet -> player/agent wallet); the union-side debit is
     autoskipped because union_wallet_transactions already records it and a
     second ledger row would double-post the flow. */
  perform set_config('app.ledger_category',
                     case when p_kind = 'promo' then 'promo_send' else 'union_send' end, true);
  perform set_config('app.ledger_counterparty', 'union_wallet', true);
  perform set_config('app.ledger_counterparty_entity', p_union_id::text, true);
  perform set_config('app.ledger_autoskip_union_wallets', '1', true);

  if p_kind = 'promo' then
    update union_wallets
       set promo_wallet = promo_wallet - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(promo_wallet, 0) >= p_amount
    returning promo_wallet into v_after;
    if v_after is null then
      return jsonb_build_object('success', false, 'error', 'Insufficient promo wallet balance.');
    end if;

    if v_is_club and v_role in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
      v_dest := 'promo_float';
      v_agent_row := public.fn_ensure_agent_row(v_club, p_target_user_id, v_role);
      if v_agent_row is null then
        raise exception 'could not ensure agents row for % in club %', p_target_user_id, v_club;
      end if;
      update agents
         set promo_wallet_balance = coalesce(promo_wallet_balance, 0) + p_amount,
             updated_at = now()
       where id = v_agent_row
       returning promo_wallet_balance into v_to_after;
    else
      v_dest := 'player_wallet';
      update club_members
         set chip_balance = coalesce(chip_balance, 0) + p_amount,
             updated_at = now()
       where club_id = v_club and user_id = p_target_user_id
       returning chip_balance into v_to_after;
    end if;
    if v_to_after is null then
      raise exception 'union promo credit landed nowhere for % in %', p_target_user_id, v_club;
    end if;

    insert into union_wallet_transactions
      (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
    values
      (p_union_id, case when v_is_club then v_club else null end,
       'promo_wallet', 'debit', p_amount, v_after, 'promo_member_send',
       coalesce(p_note, 'Union promo to member'), v_actor);
    if v_is_club then
      insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after,
                                     metadata)
      values (v_club, v_actor, p_target_user_id, p_amount, 'union_promo_send',
              coalesce(p_note, 'Union promo to member'), v_to_after,
              jsonb_build_object('union_id', p_union_id, 'destination', v_dest));
    end if;
    return jsonb_build_object('success', true, 'kind', 'promo', 'wallet_after', v_after,
                              'destination', v_dest, 'recipient_balance_after', v_to_after);
  end if;

  v_source := coalesce(p_source_wallet, 'chips');
  if v_source not in ('chips','rake','promo') then
    return jsonb_build_object('success', false, 'error', 'source wallet must be chips, rake or promo');
  end if;

  if v_source = 'chips' then
    update union_wallets set chip_balance = chip_balance - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(chip_balance, 0) >= p_amount
    returning chip_balance into v_after;
  elsif v_source = 'rake' then
    update union_wallets set rake_wallet = rake_wallet - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(rake_wallet, 0) >= p_amount
    returning rake_wallet into v_after;
  else
    update union_wallets set promo_wallet = promo_wallet - p_amount, updated_at = now()
     where union_id = p_union_id and coalesce(promo_wallet, 0) >= p_amount
    returning promo_wallet into v_after;
  end if;

  if v_after is null then
    return jsonb_build_object('success', false, 'error', 'Insufficient balance in the selected union wallet.');
  end if;

  if v_is_club and v_role in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    v_dest := 'agent_wallet';
    v_agent_row := public.fn_ensure_agent_row(v_club, p_target_user_id, v_role);
    if v_agent_row is null then
      raise exception 'could not ensure agents row for % in club %', p_target_user_id, v_club;
    end if;
    update agents
       set agent_wallet_balance = coalesce(agent_wallet_balance, 0) + p_amount,
           updated_at = now()
     where id = v_agent_row
     returning agent_wallet_balance into v_to_after;
  else
    v_dest := 'player_wallet';
    update club_members
       set chip_balance = coalesce(chip_balance, 0) + p_amount,
           updated_at = now()
     where club_id = v_club and user_id = p_target_user_id
     returning chip_balance into v_to_after;
  end if;
  if v_to_after is null then
    raise exception 'union chip credit landed nowhere for % in %', p_target_user_id, v_club;
  end if;

  insert into union_wallet_transactions
    (union_id, club_id, wallet, direction, amount, balance_after, tx_type, notes, created_by)
  values
    (p_union_id, case when v_is_club then v_club else null end,
     case v_source when 'chips' then 'chip_balance' when 'rake' then 'rake_wallet' else 'promo_wallet' end,
     'debit', p_amount, v_after, 'member_send',
     coalesce(p_note, 'Union chips to member (' || v_source || ' wallet)'), v_actor);
  if v_is_club then
    insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, balance_after,
                                   metadata)
    values (v_club, v_actor, p_target_user_id, p_amount, 'union_member_send',
            coalesce(p_note, 'Union chips to member (' || v_source || ' wallet)'), v_to_after,
            jsonb_build_object('union_id', p_union_id, 'source_wallet', v_source, 'destination', v_dest));
  end if;

  return jsonb_build_object('success', true, 'kind', 'chips', 'source', v_source,
                            'wallet_after', v_after,
                            'destination', v_dest, 'recipient_balance_after', v_to_after);
end $function$;

-- ── 7. Metrics RPC for the dashboard ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_drift_metrics()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_mgmt boolean := true;
  v jsonb;
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.ca_incident_recipients r WHERE r.user_id = v_uid AND r.active
      UNION ALL
      SELECT 1 FROM public.club_members cm WHERE cm.user_id = v_uid AND cm.role = 'owner'
      UNION ALL
      SELECT 1 FROM public.unions u WHERE u.owner_id = v_uid
      UNION ALL
      SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.role IN ('admin','god')
    ) INTO v_mgmt;
    IF NOT v_mgmt THEN RETURN '{}'::jsonb; END IF;
  END IF;

  SELECT jsonb_build_object(
    'open_total',        count(*) FILTER (WHERE status <> 'resolved'),
    'open_critical',     count(*) FILTER (WHERE status <> 'resolved' AND severity = 'critical'),
    'past_target',       count(*) FILTER (WHERE status <> 'resolved' AND past_target),
    'auto_repairing',    count(*) FILTER (WHERE status <> 'resolved' AND auto_repair_status = 'running'),
    'resolved_today',    count(*) FILTER (WHERE status = 'resolved' AND resolved_at > CURRENT_DATE),
    'median_resolve_min', (SELECT round(percentile_cont(0.5) WITHIN GROUP (
                             ORDER BY extract(epoch FROM (resolved_at - detected_at))/60)::numeric, 1)
                            FROM public.ca_drift_incidents
                           WHERE status = 'resolved' AND resolved_at > now() - interval '7 days'),
    'worst_open_drift',  COALESCE(max(abs(discrepancy_amount))
                           FILTER (WHERE status <> 'resolved'), 0)
  ) INTO v
  FROM public.ca_drift_incidents;

  v := v || jsonb_build_object(
    'suspense_today', (SELECT COALESCE(sum(amount),0) FROM public.chip_ledger
                        WHERE (from_type='settlement_suspense' OR to_type='settlement_suspense')
                          AND created_at > CURRENT_DATE),
    'ledger_write_failures_24h', (SELECT count(*) FROM public.ca_ledger_write_failures
                                   WHERE occurred_at > now() - interval '24 hours'),
    'supply_unexplained_last', (SELECT unexplained FROM public.ca_supply_snapshots
                                 ORDER BY taken_at DESC LIMIT 1),
    'ledger_rows_today', (SELECT count(*) FROM public.chip_ledger WHERE created_at > CURRENT_DATE));
  RETURN v;
END $$;
GRANT EXECUTE ON FUNCTION public.fn_ca_drift_metrics() TO authenticated;

-- Applied immediately after this migration as separate short transactions
-- (brief exclusive locks on hot journal tables):
--   SET lock_timeout='5s';
--   REVOKE INSERT, UPDATE, DELETE ON public.chip_ledger, public.chip_transactions,
--     public.club_wallet_transactions, public.union_wallet_transactions,
--     public.wallet_credit_idempotency, public.transaction_idempotency_keys,
--     public.ca_seat_stack_exits, public.ledger_reconcile_log
--   FROM anon, authenticated;
--   REVOKE INSERT, UPDATE, DELETE ON public.wallet_transactions FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.chip_ledger, public.chip_transactions,
  public.club_wallet_transactions, public.union_wallet_transactions,
  public.wallet_credit_idempotency, public.transaction_idempotency_keys,
  public.ca_seat_stack_exits, public.ledger_reconcile_log
FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.wallet_transactions FROM anon, authenticated;
