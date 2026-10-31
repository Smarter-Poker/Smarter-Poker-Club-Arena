-- 20261026150531_the_mint_watch_recognizes_its_completed_issuance_receipt_and.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Recognize completed Mint receipts by their payload, not a display label.
-- Preserve max-three exclusion, launch receipts, opening grants and thresholds.
-- Successful explicit incident actions record investigation on linked inbox rows.
-- No money moves; no schedule or notification suppression is introduced.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_ca_mint_velocity_watch()'::regprocedure)) = '5a9a4914d345b658e20fc1533d3988a2' AND md5(pg_get_functiondef('public.fn_ca_incident_action(uuid,text,text,uuid,text,text)'::regprocedure)) = '3507dce688509aabeaff69a89e787ca0')

--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';
DO $patch$
DECLARE w text := pg_get_functiondef('public.fn_ca_mint_velocity_watch()'::regprocedure);
        a text := pg_get_functiondef('public.fn_ca_incident_action(uuid,text,text,uuid,text,text)'::regprocedure);
BEGIN
  IF w IS DISTINCT FROM $watch$CREATE OR REPLACE FUNCTION public.fn_ca_mint_velocity_watch()
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_mint numeric; v_burn numeric; v_grants bigint; v_grant_chips numeric;
        v_ops bigint; v_op_chips numeric; v_launch_count bigint; v_launch_mint numeric; v_launch_burn numeric;
BEGIN
  /* THE NEW-CLUB OPENING GRANT IS NEVER DRIFT (2026-09-23). Creating a
     standalone chip club mints its declared 100,000-chip opening bank
     (fn_seed_new_club_opening_bank declares it, fn_record_new_club_opening_bank
     registers it). This sum had no entity dimension, so three new clubs
     inside ten minutes filed a warning and eleven a critical, and
     fn_ca_is_midway_scope files a raise with no dimension into Midway's own
     incident flow. A grant is left out ONLY in its exact declared shape:
     the journal leg issuance_reserve (system_mint before 2026-09-03) ->
     club_treasury, category mint, posted, exactly 100,000, landing in the
     club it names, keyed 'club-opening-grant:<that club>', AND linked from
     the mint register row the grant's own trigger wrote for that club and
     that amount. Short of all of it, the leg is still counted. What is
     left out rides along as metadata on any raise this watch still makes;
     it never makes one.

     AN OPERATOR'S DECLARED FUNDING IS NOT A LOOP EITHER (2026-10-03). Both
     mint warnings of 2026-10-03 were deliberate, reviewed settlements: the
     standalone rake bank of Deep Stack Society (607,265.09, two closed weeks
     of rake retired at the hand and banked at the close) and the owner's
     funding of its overdue agent commission (560,017.06). Each was minted
     through fn_ca_fund_club under its own operation key, and the mint
     register row fn_ca_fund_club wrote for it - origin 'operator', op_id
     equal to the leg's idempotency_key, linked to that leg, the same amount,
     with a reason - is the declaration a person has to read anyway. Such a
     mint is left out and rides along as metadata, but only while there are
     at most three of them in the window: a loop through the declaring door
     is still a loop. An auto-registered row (origin 'journal', op_id
     'ledger:<leg>') declares nothing and is still counted. */
  SELECT COALESCE(sum(l.amount) FILTER (WHERE l.from_type IN ('system_mint','issuance_reserve')
                                          AND NOT g.declared_opening_grant
                                          AND NOT o.declared_operator_mint AND NOT x.launch_receipt), 0),
         COALESCE(sum(l.amount) FILTER (WHERE l.to_type   IN ('system_burn','chip_retirement') AND NOT x.launch_receipt), 0),
         count(*) FILTER (WHERE g.declared_opening_grant),
         COALESCE(sum(l.amount) FILTER (WHERE g.declared_opening_grant), 0),
         count(*) FILTER (WHERE o.declared_operator_mint),
         COALESCE(sum(l.amount) FILTER (WHERE o.declared_operator_mint), 0), count(*) FILTER(WHERE x.launch_receipt), COALESCE(sum(l.amount) FILTER(WHERE x.launch_receipt AND l.from_type IN('issuance_reserve','chip_retirement')),0), COALESCE(sum(l.amount) FILTER(WHERE x.launch_receipt AND l.to_type='chip_retirement'),0)
    INTO v_mint, v_burn, v_grants, v_grant_chips, v_ops, v_op_chips, v_launch_count, v_launch_mint, v_launch_burn
    FROM public.chip_ledger l CROSS JOIN LATERAL (SELECT public.fn_ca_launch_velocity_receipt(l.id) AS launch_receipt) x
    CROSS JOIN LATERAL (
      SELECT (l.category = 'mint'
          AND l.from_type IN ('issuance_reserve', 'system_mint')
          AND l.to_type = 'club_treasury'
          AND l.status = 'posted'
          AND l.amount = 100000
          AND l.to_entity_id = l.club_id
          AND l.idempotency_key = 'club-opening-grant:' || l.to_entity_id::text
          AND EXISTS (
            SELECT 1 FROM public.ca_mint_ledger m
             WHERE m.op_id = l.idempotency_key
               AND m.chip_ledger_id = l.id
               AND m.action = 'mint' AND m.asset = 'chips'
               AND m.holder_type = 'club' AND m.holder_id = l.to_entity_id
               AND m.amount = 100000)) IS TRUE AS declared_opening_grant
    ) g
    CROSS JOIN LATERAL (
      SELECT (l.category = 'mint'
          AND l.from_type IN ('issuance_reserve', 'system_mint')
          AND l.status = 'posted'
          AND l.idempotency_key IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.ca_mint_ledger m
             WHERE m.op_id = l.idempotency_key
               AND m.chip_ledger_id = l.id
               AND m.origin = 'operator'
               AND m.performed_by_label = 'fn_ca_fund_club'
               AND m.action = 'mint' AND m.asset = 'chips'
               AND m.amount = l.amount
               AND COALESCE(btrim(m.reason), '') <> '')) IS TRUE AS declared_operator_mint
    ) o
   WHERE l.created_at > now() - interval '10 minutes';

  IF v_ops > 3 THEN
    v_mint := v_mint + v_op_chips;
  END IF;

  IF v_mint > 250000 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_mint_velocity_watch', 'ledger_imbalance',
      CASE WHEN v_mint > 1000000 THEN 'critical' ELSE 'warning' END,
      'mint-velocity:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_mint, 250000, v_mint, 'ledger', 'chip_ledger',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      round(v_mint, 2) || ' chips minted in 10 minutes, declared new-club opening grants and up to three declared operator mints not counted - far above the expected trickle; if this is not a deliberate batch (an epoch reset), a mint loop is running',
      true, jsonb_build_object('mint_10m', round(v_mint,2), 'burn_10m', round(v_burn,2),
                               'opening_grants_10m', v_grants,
                               'opening_grant_chips_10m', round(v_grant_chips,2),
                               'operator_mints_10m', v_ops,
                               'operator_mint_chips_10m', round(v_op_chips,2),
                               'operator_mints_counted', v_ops > 3, 'declared_launch_receipts_10m',v_launch_count,'declared_launch_mint_or_restore_chips_10m',v_launch_mint,'declared_launch_burn_chips_10m',v_launch_burn));
  END IF;

  IF v_burn > 1000000 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_mint_velocity_watch', 'ledger_imbalance', 'warning',
      'burn-velocity:' || to_char(now(), 'YYYY-MM-DD-HH24'),
      v_burn, 1000000, v_burn, 'ledger', 'chip_ledger',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      round(v_burn, 2) || ' chips burned in 10 minutes - expected only during an epoch reset or a mass cleanup; verify the operation is deliberate',
      true, jsonb_build_object('mint_10m', round(v_mint,2), 'burn_10m', round(v_burn,2), 'declared_launch_receipts_10m',v_launch_count,'declared_launch_mint_or_restore_chips_10m',v_launch_mint,'declared_launch_burn_chips_10m',v_launch_burn));
  END IF;

  RETURN v_mint;
END $function$
$watch$
     OR a IS DISTINCT FROM $action$CREATE OR REPLACE FUNCTION public.fn_ca_incident_action(p_incident_id uuid, p_action text, p_note text DEFAULT NULL::text, p_assignee uuid DEFAULT NULL::uuid, p_root_cause text DEFAULT NULL::text, p_correction_ref text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  inc public.ca_drift_incidents;
  v_allowed boolean;
BEGIN
  SELECT * INTO inc FROM public.ca_drift_incidents WHERE id = p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;

  v_allowed := v_uid IS NULL OR v_uid = ANY (public.fn_ca_incident_recipient_ids(inc, false));
  IF NOT v_allowed THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  IF p_action = 'acknowledge' THEN
    UPDATE public.ca_drift_incidents
       SET status = CASE WHEN status = 'open' THEN 'acknowledged' ELSE status END,
           acknowledged_by = COALESCE(acknowledged_by, v_uid),
           acknowledged_at = COALESCE(acknowledged_at, now())
     WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'acknowledged', v_uid, jsonb_build_object('note', p_note));

  ELSIF p_action = 'assign' THEN
    UPDATE public.ca_drift_incidents SET assigned_to = p_assignee WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'assigned', v_uid,
            jsonb_build_object('assignee', p_assignee, 'note', p_note));

  ELSIF p_action = 'comment' THEN
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'comment', v_uid, jsonb_build_object('note', p_note));

  ELSIF p_action = 'reconciling' THEN
    UPDATE public.ca_drift_incidents SET status = 'reconciling' WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'status_change', v_uid,
            jsonb_build_object('to', 'reconciling', 'note', p_note));

  ELSIF p_action = 'resolve' THEN
    IF inc.classification = 'unknown'
       AND COALESCE(p_root_cause, inc.root_cause) IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'root_cause_required_for_unknown');
    END IF;
    UPDATE public.ca_drift_incidents
       SET status = 'resolved', resolved_by = v_uid, resolved_at = now(),
           resolution = COALESCE(p_note, resolution),
           root_cause = COALESCE(p_root_cause, root_cause),
           correction_ref = COALESCE(p_correction_ref, correction_ref)
     WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'resolved', v_uid,
            jsonb_build_object('note', p_note, 'root_cause', p_root_cause,
                               'correction_ref', p_correction_ref));
    -- SIGNAL-NOT-NOISE (2026-08-31): only a critical's resolution pushes.
    IF inc.severity = 'critical' THEN
      PERFORM public.fn_ca_incident_notify(p_incident_id, 'notified',
        '✅ Resolved: ' || inc.classification || ' drift', false);
    END IF;

  ELSIF p_action = 'reopen' THEN
    UPDATE public.ca_drift_incidents
       SET status = 'open', resolved_at = NULL, resolved_by = NULL,
           past_target = false, escalation_level = 0,
           detected_at = now(), deadline_at = now() + interval '20 minutes'
     WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'reopened', v_uid, jsonb_build_object('note', p_note));
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'unknown_action');
  END IF;

  RETURN jsonb_build_object('ok', true);
END $function$
$action$ THEN
    RAISE EXCEPTION 'ALERT_LEDGER_PREIMAGE_CHANGED';
  END IF;
  IF position($needle$             WHERE m.op_id = l.idempotency_key
               AND m.chip_ledger_id = l.id
               AND m.origin = 'operator'
               AND m.performed_by_label = 'fn_ca_fund_club'$needle$ in w) = 0
     OR position($needle$  RETURN jsonb_build_object('ok', true);
END$needle$ in a) = 0 THEN
    RAISE EXCEPTION 'ALERT_LEDGER_PATCH_TARGET_MISSING';
  END IF;
  EXECUTE replace(w, $needle$             WHERE m.op_id = l.idempotency_key
               AND m.chip_ledger_id = l.id
               AND m.origin = 'operator'
               AND m.performed_by_label = 'fn_ca_fund_club'$needle$, $replacement$             WHERE m.chip_ledger_id = l.id
               AND m.origin = 'operator'
               AND (
                 (m.op_id = l.idempotency_key AND m.performed_by_label = 'fn_ca_fund_club')
                 OR (
                   l.idempotency_key = 'mint:' || m.op_id
                   AND m.holder_type IN ('club', 'union')
                   AND l.to_type = CASE m.holder_type WHEN 'club' THEN 'club_treasury' ELSE 'union_bank' END
                   AND m.holder_id = l.to_entity_id
                   AND m.balance_after = m.balance_before + m.amount
                   AND length(btrim(m.reason)) >= 10
                   AND EXISTS (
                     SELECT 1 FROM public.ca_op_claims c
                      WHERE c.op_id = m.op_id AND c.fn_name = 'fn_ca_mint'
                        AND c.finalized_at IS NOT NULL
                        AND c.result @> jsonb_build_object(
                          'ok', true, 'op_id', m.op_id, 'action', 'mint', 'asset', 'chips',
                          'ledger_id', l.id, 'amount', l.amount, 'destination', m.holder_type,
                          'target_id', m.holder_id, 'balance_before', m.balance_before,
                          'balance_after', m.balance_after, 'minted_by', m.performed_by,
                          'reason', m.reason))
                 )
               )$replacement$);
  EXECUTE replace(a, $needle$  RETURN jsonb_build_object('ok', true);
END$needle$, $replacement$  -- A successful explicit incident action is an investigation of its routed
  -- inbox record. Bell reads, failed actions and automated incident writes are not.
  -- Keep terminal investigations terminal; acknowledgement never proves a fix.
  UPDATE public.operational_alert_events e
     SET investigation = e.investigation || jsonb_build_object(
           'incident_action', p_action, 'incident_id', p_incident_id,
           'actor', v_uid, 'note', p_note, 'recorded_at', clock_timestamp()),
         investigation_status = CASE WHEN e.investigation_status = 'new'
                                     THEN 'investigating' ELSE e.investigation_status END
    FROM public.operational_notification_destinations d
   WHERE e.id = d.inbox_event_id
     AND e.source = 'owner-operational-notifications'
     AND d.original_notification->'data'->>'incident_id' = p_incident_id::text;

  RETURN jsonb_build_object('ok', true);
END$replacement$);
END $patch$;
-- CREATE OR REPLACE preserves this live ACL; declare it explicitly for source guards.
REVOKE ALL ON FUNCTION public.fn_ca_mint_velocity_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_velocity_watch() TO service_role;
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_mint_velocity_watch', 'migration completed_mint_receipt_and_incident_investigation');
SELECT public.fn_ca_declare_guard_redefinition('fn_ca_incident_action', 'migration completed_mint_receipt_and_incident_investigation');

COMMIT;
