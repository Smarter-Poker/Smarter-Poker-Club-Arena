-- Applied to production via Supabase MCP on 2026-08-31 (zero-drift round 2).
-- Byte-exact mirror of the applied migration.
-- ZERO-DRIFT round 2b: the fn_rake_bbj_audit incidents classify as
-- incorrect_rake, so the repair tick ran only the rake redrive and the
-- unbanked BBJ drops sat there (10 found + banked by hand on 2026-08-31).
-- Fix: incorrect_rake runs BOTH idempotent redrives; those incidents
-- auto-verify against the live unbanked counts; and a standing 15-minute
-- cron self-heals unbanked BBJ drops even when no incident is open.

CREATE OR REPLACE FUNCTION public.fn_ca_auto_reconcile_tick()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  inc RECORD; repaired int := 0; v_clean boolean; v_res text; v_uid uuid; v_n int;
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
      IF inc.classification IN ('incorrect_rake','bbj_error') THEN
        -- the rake/BBJ audit covers both invariants; both redrives are
        -- idempotent, so run both regardless of which word won the classifier
        PERFORM public.fn_redrive_unbanked_rake(100);
        PERFORM public.fn_bbj_repair_unbanked(24, 200);
        v_res := 'ran fn_redrive_unbanked_rake(100) + fn_bbj_repair_unbanked(24,200)';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_res := 'redrive failed: ' || SQLERRM;
    END;

    IF inc.source LIKE '%winner_prize_credit%' AND (inc.metadata ? 'user_id') THEN
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
    ELSIF inc.source = 'financial_alerts:fn_rake_bbj_audit' THEN
      -- clean when no unbanked BBJ drops and no unbanked raked hands remain
      -- in the audit's 2-hour window
      SELECT count(*) INTO v_n
        FROM rake_records rr
       WHERE rr.hand_id IS NOT NULL
         AND rr.created_at > now() - interval '2 hours'
         AND rr.created_at < now() - interval '5 minutes'
         AND ((COALESCE(rr.bbj_contribution,0) > 0 AND NOT EXISTS
                (SELECT 1 FROM bbj_contributions bc WHERE bc.hand_id = rr.hand_id))
           OR (rr.rake_amount > 0 AND NOT EXISTS
                (SELECT 1 FROM rake_distribution_legs l WHERE l.leg_key = rr.hand_id)));
      v_clean := (v_n = 0);
      IF v_clean THEN
        v_res := COALESCE(v_res || '; ', '') || 'zero unbanked fees remain in the 2h audit window';
      END IF;
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

-- standing self-heal: unbanked BBJ drops re-bank within 15 minutes even with
-- no incident open (the engine drops ~2% of banking calls under load; the
-- engine-side root cause is an open follow-up, this makes it harmless)
SELECT cron.schedule('ca-bbj-repair-unbanked-15m', '*/15 * * * *',
  $cron$ SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-bbj-repair-unbanked'))
    THEN (SELECT count(*)::int FROM public.fn_bbj_repair_unbanked(3, 200)) ELSE -1 END; $cron$);