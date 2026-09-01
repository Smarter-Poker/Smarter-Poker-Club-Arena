-- ═══════════════════════════════════════════════════════════════════════════
-- THE RESOLUTION LAW LOSES ITS SELF-SERVICE DOOR (2026-09-01, cost+integrity audit)
--
-- 20260901175759_root_cause_or_it_is_not_resolved made resolution require a
-- >=40-char root_cause and a structured correction_ref -- but it let
-- auto_repair_status='repaired' stand in for the correction_ref. Any writer
-- can set that flag IN THE SAME UPDATE that resolves, which is the same shape
-- as the [allow-revert] token an agent used to walk past the Silent Revert
-- Guard on 2026-08-31: a lock with the key hanging beside it.
--
-- Two changes, one transaction:
--   1. fn_ca_auto_reconcile_tick now records its actual evidence as
--      correction_ref ('verified: <what was re-checked and found clean>'), so
--      the legitimate automated resolver satisfies the law on the law's own
--      terms instead of through a side door.
--   2. fn_ca_resolution_needs_a_cause drops the auto_repair_status bypass.
--      EVERY resolver -- human, agent, or cron -- now supplies the same
--      structured correction_ref. No exceptions, no flags.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_ca_auto_reconcile_tick()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
             root_cause = COALESCE(root_cause,
               'Transient drift: the source measurement re-verified clean after an idempotent re-drive; no persistent code defect observed in this occurrence.'),
             -- THE LAW, SATISFIED ON ITS OWN TERMS (2026-09-01): the evidence
             -- the reconciler actually gathered IS the correction reference.
             correction_ref = COALESCE(correction_ref,
               'verified: ' || COALESCE(v_res, 'source measurement re-verified clean'))
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
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_resolution_needs_a_cause()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cause text := btrim(coalesce(NEW.root_cause, ''));
  v_ref   text := btrim(coalesce(NEW.correction_ref, ''));
  v_ok    boolean;
BEGIN
  IF NEW.status <> 'resolved' OR OLD.status = 'resolved' THEN
    RETURN NEW;
  END IF;

  IF length(v_cause) < 40 THEN
    RAISE EXCEPTION
      'An incident is not resolved until the cause is written down. Supply root_cause: what was actually wrong, in a sentence (at least 40 characters). Got %.',
      CASE WHEN v_cause = '' THEN 'nothing' ELSE '"' || v_cause || '"' END
      USING ERRCODE = 'P0404';
  END IF;

  -- 2026-09-01: the auto_repair_status='repaired' bypass is GONE. Any writer
  -- could set that flag in the same UPDATE that resolved, which made the law
  -- optional for exactly the actor it was written to govern (the same shape
  -- as the [allow-revert] token incident of 2026-08-31). The automated
  -- reconciler now writes 'verified: <evidence>' like every other resolver.
  v_ok := v_ref ~* '^(migration\s+\S|PR\s*#\d|chip_ledger\s+\S|correction:\S)'
       OR v_ref ~* '^(ruling:|verified:|no-change-needed:)\s*\S';

  IF NOT v_ok THEN
    RAISE EXCEPTION
      'An incident is not resolved until something stops it happening again. Supply correction_ref as one of: "migration <name>", "PR #<n>", "chip_ledger <id>", "correction:<key>", "ruling: <decision>", "verified: <evidence>", or "no-change-needed: <why>". Got %.',
      CASE WHEN v_ref = '' THEN 'nothing' ELSE '"' || v_ref || '"' END
      USING ERRCODE = 'P0404';
  END IF;

  RETURN NEW;
END;
$function$;