-- Run after atomic-terminal-rehearsal-fixture.sql in a disposable PostgreSQL 17
-- database. The real guard is attached only to a temporary table.
-- No financial authority, production guard, or persistent row is changed.
BEGIN;
SET LOCAL session_replication_role=origin;
CREATE TEMP TABLE terminal_window_probe (LIKE public.tournaments INCLUDING DEFAULTS);
CREATE TRIGGER terminal_window_probe_guard
BEFORE UPDATE ON terminal_window_probe
FOR EACH ROW EXECUTE FUNCTION public.trg_tournament_pool_finalization_window_guard();

DO $probe$
DECLARE
  v_template public.tournaments%ROWTYPE;
  v_case jsonb;
  v_rejected boolean;
  v_cases integer := 0;
BEGIN
  SELECT * INTO STRICT v_template FROM public.tournaments
   WHERE id='30000000-0000-0000-0000-000000000001'::uuid;
  INSERT INTO terminal_window_probe SELECT v_template.*;
  UPDATE terminal_window_probe SET prize_pool_finalized=true;
  IF NOT (SELECT prize_pool_finalized FROM terminal_window_probe) THEN
    RAISE EXCEPTION 'closed-window terminal fixture could not finalize';
  END IF;
  v_rejected := false;
  BEGIN
    UPDATE terminal_window_probe SET prize_pool_finalized=false;
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'finalized pool reopened'; END IF;

  FOR v_case IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    jsonb_build_object('current_level',3),
    jsonb_build_object('late_reg_levels',0,'rebuy_levels',0,
      'started_at',now(),'late_reg_mins',60),
    jsonb_build_object('late_reg_levels',0,'rebuy_levels',0,
      'late_reg_mins',0,'is_reentry',true),
    jsonb_build_object('add_on_available',true,
      'addon_period_started_at',now(),
      'addon_period_ends_at',now()+interval '1 minute')
  )) LOOP
    TRUNCATE terminal_window_probe;
    INSERT INTO terminal_window_probe
    SELECT (jsonb_populate_record(NULL::public.tournaments,
      to_jsonb(v_template)||v_case)).*;
    v_rejected := false;
    BEGIN
      UPDATE terminal_window_probe SET prize_pool_finalized=true;
    EXCEPTION WHEN check_violation THEN
      v_rejected := true;
    END;
    IF NOT v_rejected THEN
      RAISE EXCEPTION 'open purchase window finalized: %',v_case;
    END IF;
    v_cases := v_cases+1;
  END LOOP;
  IF v_cases<>4 THEN RAISE EXCEPTION 'missing window refusal scenario'; END IF;
  RAISE NOTICE 'AUDIT_TEST_PASS: six real pool-guard entry-window scenarios';
END;
$probe$;
ROLLBACK;
