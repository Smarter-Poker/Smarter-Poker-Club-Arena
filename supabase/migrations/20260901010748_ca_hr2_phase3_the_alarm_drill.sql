-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

-- ═══════════════════════════════════════════════════════════════════════════
-- HARDENING ROUND 2, PHASE 3: the alarm drill. Smoke detectors get tested;
-- so do ours. Weekly, the drill deliberately creates each drift condition
-- inside a subtransaction, asserts the matching detector actually fires,
-- and unwinds every mutation. All-pass records quietly; ANY silent alarm
-- raises one critical (which pushes - that is the point). Twice on
-- 2026-08-31/09-01 an alarm failed silently and only a manual probe caught
-- it; this makes that class of failure page within a week, always.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.ca_alarm_drills (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_at timestamptz NOT NULL DEFAULT now(),
  pass boolean NOT NULL,
  failing text[],
  results jsonb NOT NULL
);
ALTER TABLE public.ca_alarm_drills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_alarm_drills FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fn_ca_alarm_drill()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_results jsonb := '[]'::jsonb;
  v_failing text[] := '{}';
  v_ok boolean; v_note text; v_n int; v_sev text;
  c_midway_club constant uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  c_cert_user  constant uuid := '00000000-0000-0000-0000-000000000017';
  c_other_club constant uuid := 'd08cf7f1-d50b-4e44-851c-8369ebbb706f';
BEGIN
  SET LOCAL statement_timeout = '110s';
  SET LOCAL lock_timeout = '4s';

  -- 1. negative balance fires
  v_ok := false; v_note := '';
  BEGIN
    PERFORM set_config('app.ledger_autoskip_club_members','1',true);
    UPDATE club_members SET chip_balance = -3
     WHERE club_id = c_midway_club AND user_id = c_cert_user;
    PERFORM public.fn_ca_negative_balance_watch();
    SELECT count(*) INTO v_n FROM ca_drift_incidents
     WHERE dedupe_key LIKE 'negative-balance:club_members:%' AND status <> 'resolved';
    v_ok := v_n > 0;
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','negative_balance','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := v_failing || 'negative_balance'; END IF;

  -- 2. suspense regression fires
  v_ok := false; v_note := '';
  BEGIN
    INSERT INTO chip_ledger (performed_by, from_type, to_type, amount, category, description)
    VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','settlement_suspense','club_treasury',
            60.00,'adjustment','alarm drill synthetic suspense');
    PERFORM public.fn_ca_suspense_regression_check();
    SELECT count(*) INTO v_n FROM ca_drift_incidents
     WHERE dedupe_key LIKE 'suspense-regression:%' AND status <> 'resolved';
    v_ok := v_n > 0;
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','suspense_regression','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := v_failing || 'suspense_regression'; END IF;

  -- 3. mint velocity fires
  v_ok := false; v_note := '';
  BEGIN
    PERFORM set_config('app.ledger_category','mint',true);
    INSERT INTO chip_ledger (performed_by, from_type, to_type, to_entity_id, amount, category, description)
    VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d','issuance_reserve','club_treasury',
            c_other_club, 300000.00, 'mint', 'alarm drill synthetic mint');
    PERFORM public.fn_ca_mint_velocity_watch();
    SELECT count(*) INTO v_n FROM ca_drift_incidents
     WHERE dedupe_key LIKE 'mint-velocity:%' AND status <> 'resolved';
    v_ok := v_n > 0;
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','mint_velocity','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := v_failing || 'mint_velocity'; END IF;

  -- 4. a raise in Midway scope files critical AND notifies; out of scope stays out
  v_ok := false; v_note := '';
  BEGIN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_alarm_drill','unknown','critical','alarm-drill-raise-probe', 1.00,
      NULL, NULL, 'ledger', 'drill', NULL, c_midway_club);
    SELECT count(*) INTO v_n FROM ca_drift_incidents
     WHERE dedupe_key = 'alarm-drill-raise-probe' AND severity = 'critical' AND status <> 'resolved';
    IF v_n = 1 THEN
      SELECT count(*) INTO v_n FROM notifications
       WHERE type='financial_incident' AND created_at > now() - interval '5 seconds';
      IF v_n > 0 THEN
        PERFORM public.fn_ca_raise_drift_incident(
          'fn_ca_alarm_drill','unknown','critical','alarm-drill-scope-probe', 1.00,
          NULL, NULL, 'ledger', 'drill', NULL, c_other_club);
        SELECT count(*) INTO v_n FROM ca_drift_incidents
         WHERE dedupe_key = 'alarm-drill-scope-probe';
        v_ok := v_n = 0;  -- the other-club raise must be filtered
        IF NOT v_ok THEN v_note := 'scope filter did not filter'; END IF;
      ELSE v_note := 'raise did not notify'; END IF;
    ELSE v_note := 'raise did not file critical'; END IF;
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','raise_scope_and_notify','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := v_failing || 'raise_scope_and_notify'; END IF;

  -- 5. conservation alerts map to info (quarantine intact)
  v_ok := false; v_note := '';
  BEGIN
    INSERT INTO financial_alerts (source, severity, message, context)
    VALUES ('fn_spin_chip_conservation_check','critical',
            'alarm drill conservation probe ' || clock_timestamp()::text, '{"minted_games":1}'::jsonb);
    SELECT severity INTO v_sev FROM ca_drift_incidents
     WHERE source = 'financial_alerts:fn_spin_chip_conservation_check'
     ORDER BY detected_at DESC LIMIT 1;
    v_ok := v_sev = 'info';
    IF NOT v_ok THEN v_note := 'mapped severity=' || COALESCE(v_sev,'NONE'); END IF;
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','conservation_quarantine','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := v_failing || 'conservation_quarantine'; END IF;

  -- 6. journals are append-only (chip + diamond)
  v_ok := false; v_note := '';
  BEGIN
    UPDATE chip_ledger SET amount = amount + 1
     WHERE id = (SELECT id FROM chip_ledger ORDER BY created_at DESC LIMIT 1);
    v_note := 'chip_ledger accepted a rewrite';
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%append-only%' THEN
      BEGIN
        DELETE FROM diamond_transactions
         WHERE id = (SELECT id FROM diamond_transactions LIMIT 1);
        v_note := 'diamond_transactions accepted a delete';
        RAISE EXCEPTION 'CA_DRILL_UNWIND';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM ILIKE '%append-only%' THEN v_ok := true;
        ELSIF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_note := left(SQLERRM, 120); END IF;
      END;
    ELSIF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','journals_append_only','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := v_failing || 'journals_append_only'; END IF;

  -- 7. deleting a balance-holding row journals its burn
  v_ok := false; v_note := '';
  BEGIN
    DELETE FROM club_members WHERE club_id = c_midway_club AND user_id = c_cert_user;
    SELECT count(*) INTO v_n FROM chip_ledger
     WHERE created_at > now() - interval '5 seconds'
       AND to_type = 'chip_retirement' AND category = 'burn' AND from_type = 'player_wallet';
    v_ok := v_n > 0;
    IF NOT v_ok THEN v_note := 'delete journaled no burn'; END IF;
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','delete_journals_burn','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := v_failing || 'delete_journals_burn'; END IF;

  -- 8. settlement state machine refuses an illegal jump
  v_ok := false; v_note := '';
  BEGIN
    UPDATE ca_settlements SET state = 'open'
     WHERE id = (SELECT id FROM ca_settlements WHERE state = 'final' LIMIT 1);
    v_note := 'final settlement accepted a state change';
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%final%' THEN v_ok := true;
    ELSIF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','settlement_guard','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := v_failing || 'settlement_guard'; END IF;

  -- 9. corrections refuse to post without linkage
  v_ok := false; v_note := '';
  BEGIN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    v_ok := (public.fn_ca_post_correction('club_treasury', NULL, 'player_wallet', NULL,
             1.00, 'alarm drill probing the linkage requirement') ->> 'reason')
            = 'linkage_required_incident_or_write_failure';
    RAISE EXCEPTION 'CA_DRILL_UNWIND';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'CA_DRILL_UNWIND' THEN v_ok := false; v_note := left(SQLERRM, 120); END IF;
  END;
  v_results := v_results || jsonb_build_object('check','correction_linkage','pass',v_ok,'note',v_note);
  IF NOT v_ok THEN v_failing := v_failing || 'correction_linkage'; END IF;

  -- record; page ONLY if an alarm stayed silent
  INSERT INTO public.ca_alarm_drills (pass, failing, results)
  VALUES (cardinality(v_failing) = 0, NULLIF(v_failing, '{}'), v_results);

  IF cardinality(v_failing) > 0 THEN
    PERFORM public.fn_ca_raise_drift_incident(
      'fn_ca_alarm_drill', 'unknown', 'critical',
      'alarm-drill-failed:' || to_char(now(), 'YYYY-MM-DD'),
      cardinality(v_failing), NULL, NULL, 'reporting', 'ca_alarm_drills',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'THE ALARM DRILL FAILED: ' || array_to_string(v_failing, ', ')
        || ' stayed silent when their drift condition was created. The detectors need repair before anything else.',
      true, jsonb_build_object('failing', v_failing));
  END IF;

  RETURN jsonb_build_object('pass', cardinality(v_failing) = 0,
                            'failing', v_failing, 'results', v_results);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_alarm_drill() FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('ca-alarm-drill-weekly', '0 11 * * 1',
  $$SELECT public.fn_ca_alarm_drill()$$);

INSERT INTO public.ca_guard_inventory (kind, object_a, object_b, note, active)
SELECT 'cron', 'ca-alarm-drill-weekly', NULL,
       'weekly rolled-back drill: creates each drift condition, asserts its detector fires, pages only if an alarm stayed silent', true
WHERE NOT EXISTS (SELECT 1 FROM public.ca_guard_inventory WHERE object_a='ca-alarm-drill-weekly');;
