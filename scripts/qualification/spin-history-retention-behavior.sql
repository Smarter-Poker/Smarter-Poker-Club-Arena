-- SOURCE ONLY / UNRUN. Actual pruner regression in the existing isolated Spin
-- allocation, BEFORE real_funded_paid_seat_fixture. All table/trigger/function
-- changes roll back; natural sequence advancement is disclosed, not reset.
-- No successful hand/financial/terminal receipt is fabricated.
\set ON_ERROR_STOP on
SELECT set_config('spin_retention_fixture.execution', :'execution_uuid', false);
DO $boundary$
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
  OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_retention_fixture.execution'),'-','')
  OR current_setting('spin_retention_fixture.execution') IS DISTINCT FROM current_setting('qualification.execution_uuid',true)
  OR current_setting('spin_retention_fixture.execution') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
  OR current_setting('session_replication_role')<>'origin'
  OR current_setting('server_version_num')::integer NOT BETWEEN 170000 AND 179999
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper)
  OR md5(pg_get_functiondef(to_regprocedure('public.sp_prune_hand_history(integer)')))
     IS DISTINCT FROM '03f156a50f882354f7d09f30fe08afd2' THEN
  RAISE EXCEPTION 'spin retention behavior: exact isolated preimage required'; END IF;
END $boundary$;
\ir fixtures/spin-history-retention/database-state.sql
CREATE TEMP TABLE retention_initial_state AS SELECT pg_temp.retention_database_state() row_state,
 pg_temp.retention_catalog_state() catalog_state,pg_temp.retention_sequence_state() sequences;
BEGIN;
\ir fixtures/spin-history-retention/component-inputs.sql
\ir fixtures/spin-history-retention/estate.sql
DO $behavior$
DECLARE v_original jsonb:=pg_temp.retention_database_state(); v_catalog jsonb:=pg_temp.retention_catalog_state();
 v_expected jsonb; v_expected_ids uuid[]; v_forward text; v_rollback text;
 v_case integer; v_removed integer; v_asserted boolean;
BEGIN
 IF (SELECT count(*) FROM public.hand_history)<>7
  OR (SELECT count(*) FROM retention_cases)<>7
  OR EXISTS(SELECT 1 FROM retention_cases c LEFT JOIN public.hand_history h ON h.id=c.hand_id
    WHERE h.id IS NULL OR h.table_id IS DISTINCT FROM c.table_id
     OR h.tournament_id IS DISTINCT FROM c.tournament_id OR h.created_at>=now()-interval '7 days'
     OR h.rake_amount IS DISTINCT FROM 0 OR h.bbj_amount IS DISTINCT FROM 0)
  OR EXISTS(SELECT 1 FROM public.hand_atomic_commits)
  OR EXISTS(SELECT 1 FROM public.settlement_idempotency_keys)
  OR EXISTS(SELECT 1 FROM public.hand_projection_outbox)
  OR EXISTS(SELECT 1 FROM public.tournament_knockout_candidates WHERE state='pending')
 THEN RAISE EXCEPTION 'retention behavior: exact no-first-receipt estate differs'; END IF;
 SELECT forward_sql,rollback_sql INTO STRICT v_forward,v_rollback FROM pg_temp.spin_history_retention_source;
 FOR v_case IN 1..2 LOOP
  v_asserted:=false;
  BEGIN
   IF v_case=1 THEN EXECUTE v_rollback; ELSE EXECUTE v_forward; END IF;
   SELECT array_agg(hand_id ORDER BY hand_id) INTO v_expected_ids FROM retention_cases
    WHERE CASE WHEN v_case=1 THEN original_deletes ELSE candidate_deletes END;
   IF cardinality(v_expected_ids) IS DISTINCT FROM CASE WHEN v_case=1 THEN 5 ELSE 2 END THEN
    RAISE EXCEPTION 'retention behavior: independently enumerated oracle cardinality changed'; END IF;
   v_expected:=pg_temp.retention_database_state(v_expected_ids);
   v_removed:=public.sp_prune_hand_history(1);
   IF v_removed IS DISTINCT FROM cardinality(v_expected_ids)
    OR pg_temp.retention_database_state() IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'retention behavior: wrong exact deletion/write result for image %',v_case; END IF;
   v_asserted:=true;
   RAISE EXCEPTION USING ERRCODE='PZ001',MESSAGE='rollback actual pruner image';
  EXCEPTION WHEN SQLSTATE 'PZ001' THEN IF NOT v_asserted THEN RAISE; END IF;
  END;
  IF pg_temp.retention_database_state() IS DISTINCT FROM v_original
   OR pg_temp.retention_catalog_state() IS DISTINCT FROM v_catalog THEN
   RAISE EXCEPTION 'retention behavior: image rollback did not restore exact rows/catalog'; END IF;
 END LOOP;
END $behavior$;
ROLLBACK;
DO $restored$
BEGIN
 IF pg_temp.retention_database_state() IS DISTINCT FROM (SELECT row_state FROM retention_initial_state)
  OR pg_temp.retention_catalog_state() IS DISTINCT FROM (SELECT catalog_state FROM retention_initial_state) THEN
  RAISE EXCEPTION 'retention behavior: whole fixture rollback changed initial rows/catalog'; END IF;
END $restored$;
SELECT jsonb_build_object('qualification','spin_history_retention_behavior',
 'old_deleted',5,'candidate_deleted',2,'canonical_cancellation_count',2,
 'table_and_catalog_rollback_verified',true,'sequence_counters_restored',false,
 'completed_spin_qualified',false,'multi_session_race_qualified',false,
 'sequence_before',(SELECT sequences FROM retention_initial_state),
 'sequence_after',pg_temp.retention_sequence_state()) AS qualification;
