-- SOURCE ONLY / UNRUN. Existing disposable Spin PG17 allocation only.
-- Run AFTER authentic provider-supplement.sql; every change rolls back.
-- This file qualifies source installation, not funded terminal/cancel behavior.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('spin_retention_fixture.execution', :'execution_uuid', true);
DO $boundary$
BEGIN
  IF current_user<>'postgres' OR session_user<>'postgres'
     OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_retention_fixture.execution'),'-','')
     OR current_setting('spin_retention_fixture.execution') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR inet_server_addr() IS NOT NULL
     OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
     OR (SELECT md5(pg_get_functiondef(to_regprocedure('public.sp_prune_hand_history(integer)'))))
        IS DISTINCT FROM '03f156a50f882354f7d09f30fe08afd2' THEN
    RAISE EXCEPTION 'spin retention qualification: exact isolated preimage required';
  END IF;
END;
$boundary$;
\ir fixtures/spin-history-retention/component-inputs.sql
\ir spin-expiry-business-state.sql
\ir fixtures/spin-history-retention/state.sql

DO $catalog$
DECLARE v_before jsonb := pg_temp.spin_history_retention_state();
        v_proc jsonb; v_after jsonb; v_forward text; v_rollback text;
        v_message text;
BEGIN
  SELECT to_jsonb(p) INTO v_proc FROM pg_proc p
    WHERE p.oid='public.sp_prune_hand_history(integer)'::regprocedure;
  SELECT forward_sql,rollback_sql INTO STRICT v_forward,v_rollback
    FROM pg_temp.spin_history_retention_source;
  EXECUTE v_forward;
  IF md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))
      IS DISTINCT FROM '8a5858c8586296d772add9e233abc269' THEN
    RAISE EXCEPTION 'spin retention qualification: wrong candidate';
  END IF;
  EXECUTE v_forward; -- exact replay, not an unguarded CREATE OR REPLACE
  IF pg_temp.spin_history_retention_state() IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'spin retention qualification: installation/replay wrote business state';
  END IF;
  EXECUTE v_rollback;
  EXECUTE v_rollback;
  SELECT to_jsonb(p) INTO v_after FROM pg_proc p
    WHERE p.oid='public.sp_prune_hand_history(integer)'::regprocedure;
  IF v_after IS DISTINCT FROM v_proc
     OR pg_temp.spin_history_retention_state() IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'spin retention qualification: rollback did not restore exact state';
  END IF;

  BEGIN
    GRANT EXECUTE ON FUNCTION public.sp_prune_hand_history(integer) TO anon;
    BEGIN
      EXECUTE v_forward;
      RAISE EXCEPTION 'spin retention qualification: authority drift accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN
      GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
      IF v_message<>'spin history retention: target authority drift' THEN RAISE; END IF;
    END;
    RAISE EXCEPTION USING ERRCODE='PZ001',MESSAGE='rollback authority control';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN NULL;
  END;
  BEGIN
    ALTER FUNCTION public.sp_prune_hand_history(integer) COST 101;
    BEGIN
      EXECUTE v_forward;
      RAISE EXCEPTION 'spin retention qualification: body/attribute drift accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN
      GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
      IF v_message<>'spin history retention: unsupported function drift' THEN RAISE; END IF;
    END;
    RAISE EXCEPTION USING ERRCODE='PZ001',MESSAGE='rollback source control';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN NULL;
  END;
  BEGIN
    ALTER TRIGGER tournament_terminal_settlements_append_only
      ON public.tournament_terminal_settlements RENAME TO retention_qualification_renamed_receipt_guard;
    BEGIN
      EXECUTE v_forward;
      RAISE EXCEPTION 'spin retention qualification: renamed receipt trigger accepted';
    EXCEPTION WHEN SQLSTATE '55000' THEN
      GET STACKED DIAGNOSTICS v_message=MESSAGE_TEXT;
      IF v_message<>'spin history retention: receipt immutability binding drift tournament_terminal_settlements_append_only' THEN RAISE; END IF;
    END;
    RAISE EXCEPTION USING ERRCODE='PZ001',MESSAGE='rollback binding control';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN NULL;
  END;
  -- The renamed binding remains enabled throughout the rolled-back negative
  -- DDL control. No business call occurs during that authority-drift control.
  EXECUTE v_forward; -- proves every negative-control subtransaction restored guards
  EXECUTE v_rollback;
  SELECT to_jsonb(p) INTO v_after FROM pg_proc p
    WHERE p.oid='public.sp_prune_hand_history(integer)'::regprocedure;
  IF v_after IS DISTINCT FROM v_proc
     OR pg_temp.spin_history_retention_state() IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'spin retention qualification: negative controls changed original state';
  END IF;
END;
$catalog$;
ROLLBACK;
SELECT 'spin history retention catalog controls passed; business/race qualification separate' AS qualification;
