-- @live-proof: (SELECT bool_and(coalesce(md5(pg_get_functiondef(to_regprocedure(signature)))=expected,false)) FROM (VALUES ('fn_ca_ack_tournament_abort_boundary(uuid,uuid,uuid,uuid,bigint,jsonb)','41be36ae0daa566c7bee444ec8d2aebf'),('fn_ca_operator_floor_state(uuid)','a1664a877d1641e6f87f76c4651cf3bb'),('fn_ca_settle_tournament_abort(uuid,uuid,text)','32ffc8212bcbaec490b76fb904707d3c'),('fn_ca_tournament_abort_stop_state(uuid,uuid)','f078025253ce10976e30588e31b46663'),('fn_ca_withdraw_tournament_abort_for_original_recovery(uuid,uuid,uuid,text,uuid,text,timestamp with time zone,uuid,text)','8cea7abe692c880017a4263db3a39f23'),('fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)','903c9322cc0069ecf8ad9291408d18d6'),('smarter_private.assert_tournament_abort_not_recovered(uuid,uuid)','b3661e1f8385ebdcc8e73f938fc9f1c8'),('smarter_private.assert_tournament_abort_quiesced(uuid,uuid)','df9c5fba713a45fabb7bd4f0b411f616'),('smarter_private.tournament_abort_ingress(uuid)','efaf998fc4e268f748060da2806b9764'),('smarter_private.tournament_abort_recovery_immutable()','825ce71870a00caac48400b82b883637'),('smarter_private.tournament_recovery_original_custody(uuid)','2eac78e44a32516db55f155227e2593f')) x(signature,expected)) AND (SELECT relrowsecurity FROM pg_class WHERE oid='smarter_private.tournament_abort_recoveries'::regclass) AND NOT has_function_privilege('anon','public.fn_ca_withdraw_tournament_abort_for_original_recovery(uuid,uuid,uuid,text,uuid,text,timestamptz,uuid,text)','EXECUTE')
-- Latest explicit owner direction: preserve these exact20 started events and
-- finish them naturally; no new tournaments. Original89 abort membership stays
-- immutable. This installs a dormant explicit operator path, never activates it.
-- BEFORE its first use the trusted host/operator must prove the actual containing
-- sealed image/container/local/public/DB leader, its own healthy complete v3 thaw,
-- and canonical native original custody; caller JSON is never that proof.
-- Existing service authority and typed canonical DB checks remain mandatory.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE TABLE smarter_private.tournament_abort_recoveries (
 tournament_id uuid PRIMARY KEY,
 operation_id uuid NOT NULL,
 recovery_id uuid NOT NULL,
 owner_instruction text NOT NULL,
 instance_id text NOT NULL,
 lease_generation uuid NOT NULL,
 release_sha text NOT NULL CHECK(release_sha ~ '^[0-9a-f]{40}$'),
 freeze_started_at timestamptz NOT NULL,
 ownership_token uuid NOT NULL,
 original_target jsonb NOT NULL,
 original_custody jsonb NOT NULL,
 money_snapshot jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE smarter_private.tournament_abort_recoveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.tournament_abort_recoveries FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.tournament_abort_recovery_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN RAISE EXCEPTION 'original_tournament_recovery_disposition_immutable' USING ERRCODE='55000'; END $fn$;
REVOKE ALL ON FUNCTION smarter_private.tournament_abort_recovery_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER tournament_abort_recovery_immutable BEFORE UPDATE OR DELETE ON smarter_private.tournament_abort_recoveries
FOR EACH ROW EXECUTE FUNCTION smarter_private.tournament_abort_recovery_immutable();
CREATE TRIGGER tournament_abort_recovery_no_truncate BEFORE TRUNCATE ON smarter_private.tournament_abort_recoveries FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.tournament_abort_recovery_immutable();
CREATE FUNCTION smarter_private.assert_tournament_abort_not_recovered(p_operation_id uuid,p_tournament_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,smarter_private AS $fn$
BEGIN
 -- An older repeatable-read snapshot cannot safely observe a new append-only disposition.
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'operator_abort_read_committed_required' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.tournament_abort_recoveries WHERE tournament_id=p_tournament_id AND operation_id=p_operation_id) THEN
  RAISE EXCEPTION 'operator_abort_withdrawn_for_original_recovery' USING ERRCODE='55000';
 END IF;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.assert_tournament_abort_not_recovered(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION smarter_private.tournament_recovery_original_custody(p_tournament_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $fn$
 SELECT coalesce(jsonb_agg(jsonb_build_object('original',o.value,'permit',to_jsonb(p),'continuation',to_jsonb(c),
 'accepted',CASE WHEN a.hand_id IS NOT NULL THEN jsonb_build_object('hand_id',a.hand_id,'payload_hash',a.payload_hash,
 'post_commit_payload_hash',a.post_commit_payload_hash,'post_commit_completed_at',a.post_commit_completed_at,
 'post_commit_result',a.post_commit_result,'history_id',hh.id) ELSE NULL END) ORDER BY b.table_id,(o.value->>'hand_number')::bigint),'[]'::jsonb)
 FROM smarter_private.tournament_abort_boundaries b CROSS JOIN LATERAL jsonb_array_elements(b.existing_permits) o
 LEFT JOIN smarter_private.f06_hand_permits p ON p.permit_id=(o.value->>'permit_id')::uuid
 LEFT JOIN smarter_private.hand_continuations c ON c.permit_id=p.permit_id
 LEFT JOIN public.hand_atomic_commits a ON a.table_id=p.table_id AND a.hand_number=p.hand_number AND a.hand_id=p.evidence_id
 LEFT JOIN public.hand_history hh ON hh.id=a.hand_id AND hh.table_id=p.table_id AND hh.hand_number=p.hand_number AND hh.tournament_id=p.tournament_id
 WHERE b.tournament_id=p_tournament_id AND b.operation_id='d44c4440-2911-430c-8ee7-376611ef3f38';
$fn$;
REVOKE ALL ON FUNCTION smarter_private.tournament_recovery_original_custody(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.fn_ca_withdraw_tournament_abort_for_original_recovery(
 p_operation_id uuid,p_tournament_id uuid,p_recovery_id uuid,p_instance_id text,
 p_lease_generation uuid,p_release_sha text,p_freeze_started timestamptz,
 p_ownership_token uuid,p_custody_md5 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $fn$
DECLARE a smarter_private.tournament_abort_targets; prior smarter_private.tournament_abort_recoveries;
 custody jsonb; t public.tournaments; lease public.engine_tournament_leases; thaw public.engine_maintenance_thaws;
BEGIN
 IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN RAISE EXCEPTION 'original_recovery_read_committed_required' USING ERRCODE='55000';END IF;
 IF auth.role() IS DISTINCT FROM 'service_role' AND NOT (session_user='postgres' AND auth.role() IS NULL AND coalesce(current_setting('role',true),'none') IN('none','postgres')) THEN
  RAISE EXCEPTION 'original_recovery_service_or_genuine_management_required' USING ERRCODE='42501';END IF;
 IF p_operation_id IS DISTINCT FROM 'd44c4440-2911-430c-8ee7-376611ef3f38'::uuid
 OR p_tournament_id IS NULL OR p_tournament_id<>ALL(ARRAY['095d7449-3282-46c5-8a39-768fe14dce5a','0cb8e80f-4031-4b72-bbd6-f076605f1575','0ef3dbfb-c092-4008-b7bd-bde65a474e83','135b187e-c096-483a-b347-10be69df956b','19cf1192-d926-4042-a13c-67eca5ebf9a3','2305ddd2-58af-43fb-9089-567108e4ca77','46ba2e7c-c9f8-42b6-b416-d7342a676531','64599cc4-03bb-4f1d-8df7-ef610abe10af','6c6724e5-1ee4-40c0-ad21-44e9f9b6d800','7932d2bb-7cfb-4b0e-ae99-75fcbae82d52','7ab02286-fa29-44a2-a64f-0cb3d60ca572','8229a0af-3c5a-4672-b9df-3d8523613086','85bec2f4-0aa8-42b8-8799-d9d3acff2275','8855c50e-c4ed-4235-91c1-323627023b15','c685ebb7-954d-4a38-a26d-9c23c23600a4','d110fd05-846e-46c1-adca-a2e515e95144','dbaca4cd-8959-427d-8b91-2d97310e6fd6','deaa61a7-0553-4c81-a178-e9ba822a1ba2','debf5e04-6f4d-4858-88a0-84b6fe1ba598','fdfcadfd-4044-4696-874d-5ec50cf93a48']::uuid[])
 OR p_recovery_id IS NULL OR p_instance_id IS NULL OR p_lease_generation IS NULL
 OR p_release_sha IS NULL OR p_release_sha !~ '^[0-9a-f]{40}$'
 OR p_freeze_started IS NULL OR p_ownership_token IS NULL OR p_custody_md5 IS NULL
 OR p_custody_md5 !~ '^[0-9a-f]{32}$' THEN
  RAISE EXCEPTION 'original_recovery_exact_owner_cohort_required' USING ERRCODE='22023';END IF;
 -- Same original cancellation lane, not an unrelated/global transaction owner.
 -- This serializes withdrawal with all original ACK/refund/settlement routes.
 PERFORM smarter_private.cancellation_lane(p_tournament_id);
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'original_recovery_platform_frozen' USING ERRCODE='55000';END IF;
 SELECT * INTO a FROM smarter_private.tournament_abort_targets WHERE tournament_id=p_tournament_id FOR UPDATE;
 IF NOT FOUND OR a.operation_id IS DISTINCT FROM p_operation_id THEN RAISE EXCEPTION 'original_recovery_original_operation_missing' USING ERRCODE='55000';END IF;
 SELECT * INTO prior FROM smarter_private.tournament_abort_recoveries WHERE tournament_id=p_tournament_id;
 IF FOUND THEN
  IF prior.operation_id IS DISTINCT FROM p_operation_id OR prior.recovery_id IS DISTINCT FROM p_recovery_id
  OR prior.instance_id IS DISTINCT FROM p_instance_id OR prior.lease_generation IS DISTINCT FROM p_lease_generation
  OR prior.release_sha IS DISTINCT FROM p_release_sha OR prior.freeze_started_at IS DISTINCT FROM p_freeze_started
  OR prior.ownership_token IS DISTINCT FROM p_ownership_token OR md5(prior.original_custody::text) IS DISTINCT FROM p_custody_md5 THEN
   RAISE EXCEPTION 'original_recovery_identity_reused' USING ERRCODE='22023';END IF;
  RETURN jsonb_build_object('ok',true,'state','recovery','already_recorded',true,'recovery_id',prior.recovery_id,'tournament_id',p_tournament_id);
 END IF;
 SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
 IF t.started_at IS NULL OR upper(t.status) NOT IN('RUNNING','BREAK','LATE_REG')
 OR a.state NOT IN('stop_requested','quiesced') OR a.settled_at IS NOT NULL OR a.receipt IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.tournament_cancellation_receipts WHERE tournament_id=p_tournament_id)
 OR EXISTS(SELECT 1 FROM public.tournament_refund_tranches WHERE tournament_id=p_tournament_id)
 OR EXISTS(SELECT 1 FROM smarter_private.diamond_tournament_abort_receipts WHERE tournament_id=p_tournament_id) THEN
  RAISE EXCEPTION 'original_recovery_terminal_or_refund_forbids_resurrection' USING ERRCODE='55000';END IF;
 -- This control-only operation accepts genuine management as well as service.
 -- Read the same canonical F06 lease predicates directly; never spoof the
 -- engine actor/JWT GUCs required by the financial hand mutation functions.
 SELECT * INTO lease FROM public.engine_tournament_leases WHERE tournament_id=p_tournament_id FOR KEY SHARE;
 IF lease.instance_id IS DISTINCT FROM p_instance_id OR lease.lease_generation IS DISTINCT FROM p_lease_generation
 OR lease.protocol_version IS DISTINCT FROM 2 OR lease.heartbeat_at<clock_timestamp()-interval '15 seconds'
 OR NOT EXISTS(SELECT 1 FROM public.engine_leader l WHERE l.id=true AND l.instance_id=p_instance_id
   AND l.engine_version=left(p_release_sha,8) AND l.heartbeat_at>=clock_timestamp()-interval '15 seconds') THEN
  RAISE EXCEPTION 'original_recovery_current_serving_authority_required' USING ERRCODE='55000';END IF;
 SELECT * INTO thaw FROM public.engine_maintenance_thaws WHERE freeze_started_at=p_freeze_started;
 IF NOT FOUND OR thaw.contract_version IS DISTINCT FROM 3 OR thaw.ownership_token IS DISTINCT FROM p_ownership_token
 OR thaw.thawed_by IS DISTINCT FROM left(p_release_sha,8) OR thaw.thawed_at IS NULL OR thaw.thawed_at>clock_timestamp() OR thaw.release_target_at IS NULL
 OR thaw.release_target_at>clock_timestamp() OR thaw.shifted->>'complete' IS DISTINCT FROM 'true'
 OR NOT(thaw.shifted ?& ARRAY['sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until','reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at','cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at','cluster_break_eligible_since','cluster_move_expires_at','reconnect_presence','reconnect_snapshots'])
 OR EXISTS(SELECT 1 FROM public.engine_maintenance_break) THEN
  RAISE EXCEPTION 'original_recovery_own_complete_v3_thaw_required' USING ERRCODE='55000';END IF;
 custody:=smarter_private.tournament_recovery_original_custody(p_tournament_id);
 IF jsonb_array_length(custody)=0 OR md5(custody::text) IS DISTINCT FROM p_custody_md5
 OR EXISTS(SELECT 1 FROM smarter_private.tournament_abort_boundaries b
  CROSS JOIN LATERAL jsonb_array_elements(b.existing_permits) o
  LEFT JOIN smarter_private.f06_hand_permits h ON h.permit_id=(o.value->>'permit_id')::uuid
  LEFT JOIN smarter_private.hand_continuations c ON c.permit_id=h.permit_id
  WHERE b.operation_id=p_operation_id AND b.tournament_id=p_tournament_id AND (
   h.permit_id IS NULL OR h.tournament_id IS DISTINCT FROM p_tournament_id OR h.table_id IS DISTINCT FROM b.table_id
   OR h.hand_number::text IS DISTINCT FROM o.value->>'hand_number' OR h.lifecycle::text IS DISTINCT FROM o.value->>'lifecycle'
   OR h.custody_id::text IS DISTINCT FROM o.value->>'custody_id' OR h.generation::text IS DISTINCT FROM o.value->>'generation'
   OR EXISTS(SELECT 1 FROM smarter_private.hand_continuation_dispositions z WHERE z.table_id=h.table_id AND z.hand_number=h.hand_number AND z.disposition='disposed')
   OR CASE WHEN h.state='reserved' THEN (
     c.permit_id IS NULL OR c.table_id IS DISTINCT FROM h.table_id OR c.hand_number IS DISTINCT FROM h.hand_number
     OR c.tournament_id IS DISTINCT FROM h.tournament_id OR c.original_generation IS DISTINCT FROM h.generation
     OR c.writer_generation IS DISTINCT FROM p_lease_generation
     OR c.payload_sha256 IS DISTINCT FROM encode(extensions.digest(c.payload,'sha256'),'hex')
     OR NOT EXISTS(SELECT 1 FROM public.tables tb WHERE tb.id=h.table_id AND tb.tournament_id=p_tournament_id AND tb.f06_lifecycle=h.lifecycle)
   ) WHEN h.state='accepted' THEN NOT EXISTS(
     SELECT 1 FROM public.hand_atomic_commits ac JOIN public.hand_history hh ON hh.id=ac.hand_id AND hh.table_id=ac.table_id AND hh.hand_number=ac.hand_number
     WHERE ac.table_id=h.table_id AND ac.hand_number=h.hand_number AND ac.hand_id=h.evidence_id
      AND ac.post_commit_completed_at IS NOT NULL AND ac.post_commit_result->>'ok'='true' AND hh.tournament_id=p_tournament_id
   ) ELSE true END))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.tournament_id=p_tournament_id AND h.state='reserved'
  AND NOT EXISTS(SELECT 1 FROM smarter_private.tournament_abort_boundaries b CROSS JOIN LATERAL jsonb_array_elements(b.existing_permits) o
   WHERE b.operation_id=p_operation_id AND b.tournament_id=p_tournament_id AND o.value->>'permit_id'=h.permit_id::text)) THEN
  RAISE EXCEPTION 'original_recovery_canonical_original_custody_required' USING ERRCODE='55000';END IF;
 INSERT INTO smarter_private.tournament_abort_recoveries(tournament_id,operation_id,recovery_id,owner_instruction,
 instance_id,lease_generation,release_sha,freeze_started_at,ownership_token,original_target,original_custody,money_snapshot)
 VALUES(p_tournament_id,p_operation_id,p_recovery_id,'01a192b6-c749-7ac2-8c18-cadeb3923073: finish exact20 naturally; no new tournaments',
 p_instance_id,p_lease_generation,p_release_sha,p_freeze_started,p_ownership_token,to_jsonb(a),custody,
 smarter_private.tournament_abort_money_snapshot(p_tournament_id));
 RETURN jsonb_build_object('ok',true,'state','recovery','already_recorded',false,'recovery_id',p_recovery_id,'tournament_id',p_tournament_id);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_withdraw_tournament_abort_for_original_recovery(uuid,uuid,uuid,text,uuid,text,timestamptz,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_withdraw_tournament_abort_for_original_recovery(uuid,uuid,uuid,text,uuid,text,timestamptz,uuid,text) TO service_role;
DO $patch$ DECLARE s text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='fn_ca_ack_tournament_abort_boundary(uuid,uuid,uuid,uuid,bigint,jsonb)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND to_jsonb(proacl)='["postgres=X/postgres", "service_role=X/postgres"]'::jsonb) THEN RAISE EXCEPTION 'recovery_owner_or_acl_changed: fn_ca_ack_tournament_abort_boundary(uuid,uuid,uuid,uuid,bigint,jsonb)';END IF;
 s:=pg_get_functiondef('fn_ca_ack_tournament_abort_boundary(uuid,uuid,uuid,uuid,bigint,jsonb)'::regprocedure);
 IF md5(s) IS DISTINCT FROM '7f0baf610a409fb665a9a773db60d9bd' THEN RAISE EXCEPTION 'recovery_source_owner_changed: fn_ca_ack_tournament_abort_boundary(uuid,uuid,uuid,uuid,bigint,jsonb)';END IF;
 EXECUTE $owner_7f0baf610a409fb665a9a773db60d9bd$CREATE OR REPLACE FUNCTION public.fn_ca_ack_tournament_abort_boundary(p_operation_id uuid, p_tournament_id uuid, p_table_id uuid, p_lease_generation uuid, p_hand_number bigint, p_evidence jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE a smarter_private.tournament_abort_targets; t public.tables; snapshot jsonb;
BEGIN
 PERFORM smarter_private.cancellation_lane(p_tournament_id);
 PERFORM smarter_private.assert_tournament_abort_not_recovered(p_operation_id,p_tournament_id);
 -- The only producer is the explicit engine abort request, after its own
 -- physical park, all bank/private writers, and manager callback tails JOIN.
 -- floor_state remains a read and can never manufacture this certificate.
 PERFORM smarter_private.cancellation_lane(p_tournament_id);
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation);
 SELECT * INTO a FROM smarter_private.tournament_abort_targets WHERE operation_id=p_operation_id AND tournament_id=p_tournament_id FOR UPDATE;
 IF NOT FOUND OR a.state='settled' THEN RAISE EXCEPTION 'operator_abort_target_not_acknowledgeable' USING ERRCODE='55000';END IF;
 SELECT * INTO t FROM public.tables WHERE id=p_table_id AND tournament_id=p_tournament_id FOR UPDATE;
 IF NOT FOUND OR p_hand_number IS NULL OR p_hand_number<0 OR p_evidence IS NULL
 OR p_evidence->>'kind' IS DISTINCT FROM 'tournament_abort_boundary_v1'
 OR p_evidence->>'certificate_version' IS DISTINCT FROM '1'
 OR p_evidence->>'physical_stopped' IS DISTINCT FROM 'true'
 OR p_evidence->>'parked_before_retirement' IS DISTINCT FROM 'true'
 OR p_evidence->>'drained' IS DISTINCT FROM 'true'
 OR p_evidence->>'manager_tail_joined' IS DISTINCT FROM 'true'
 OR p_evidence->>'pending_writers' IS DISTINCT FROM '0'
 OR p_evidence->>'bank_state_write_pending' IS DISTINCT FROM 'false'
 OR (p_evidence->>'lifecycle')::bigint IS DISTINCT FROM t.f06_lifecycle
 OR (p_evidence->>'hand_number')::bigint IS DISTINCT FROM p_hand_number THEN
  RAISE EXCEPTION 'operator_abort_physical_boundary_unverified' USING ERRCODE='P0404';END IF;
 IF jsonb_typeof(p_evidence->'source_table_ids') IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM public.tables x WHERE x.tournament_id=p_tournament_id AND lower(x.status)<>'closed' AND NOT coalesce(x.is_deleted,false) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_evidence->'source_table_ids') z WHERE z.value::uuid=x.id))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_evidence->'source_table_ids') z WHERE NOT EXISTS(SELECT 1 FROM public.tables x WHERE x.id=z.value::uuid AND x.tournament_id=p_tournament_id)) THEN
  RAISE EXCEPTION 'operator_abort_physical_roster_incomplete' USING ERRCODE='P0404';END IF;
 IF smarter_private.tournament_abort_pending(p_tournament_id) THEN
  RAISE EXCEPTION 'operator_abort_accepted_hand_or_award_pending' USING ERRCODE='55000';END IF;
 INSERT INTO smarter_private.tournament_abort_boundaries(operation_id,tournament_id,table_id,lifecycle,required,request_generation,existing_permits,acknowledged_generation,acknowledgement,acknowledged_at)
 VALUES(p_operation_id,p_tournament_id,p_table_id,t.f06_lifecycle,lower(t.status)<>'closed' AND NOT coalesce(t.is_deleted,false),a.requested_generation,'[]'::jsonb,p_lease_generation,p_evidence,clock_timestamp())
 ON CONFLICT(table_id) DO UPDATE SET lifecycle=EXCLUDED.lifecycle,required=EXCLUDED.required,
 acknowledged_generation=EXCLUDED.acknowledged_generation,acknowledgement=EXCLUDED.acknowledgement,acknowledged_at=EXCLUDED.acknowledged_at
 WHERE smarter_private.tournament_abort_boundaries.operation_id=p_operation_id AND smarter_private.tournament_abort_boundaries.tournament_id=p_tournament_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'operator_abort_boundary_owned' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables tb WHERE tb.tournament_id=p_tournament_id AND lower(tb.status)<>'closed' AND NOT coalesce(tb.is_deleted,false)
  AND NOT EXISTS(SELECT 1 FROM smarter_private.tournament_abort_boundaries b WHERE b.operation_id=p_operation_id AND b.table_id=tb.id
    AND b.lifecycle=tb.f06_lifecycle AND b.acknowledged_generation=p_lease_generation AND b.acknowledged_at IS NOT NULL)) THEN
  snapshot:=smarter_private.tournament_abort_money_snapshot(p_tournament_id);
  UPDATE smarter_private.tournament_abort_targets SET state='quiesced',money_snapshot=snapshot,
   quiescence=jsonb_build_object('generation',p_lease_generation,'money_hash',md5(snapshot::text),'certified_at',clock_timestamp())
  WHERE tournament_id=p_tournament_id AND operation_id=p_operation_id;
 END IF;
 RETURN jsonb_build_object('ok',true,'operation_id',p_operation_id,'tournament_id',p_tournament_id,'table_id',p_table_id,
 'generation',p_lease_generation,'state',(SELECT state FROM smarter_private.tournament_abort_targets WHERE tournament_id=p_tournament_id));
END $function$
$owner_7f0baf610a409fb665a9a773db60d9bd$;
 IF md5(pg_get_functiondef('fn_ca_ack_tournament_abort_boundary(uuid,uuid,uuid,uuid,bigint,jsonb)'::regprocedure)) IS DISTINCT FROM '41be36ae0daa566c7bee444ec8d2aebf' THEN RAISE EXCEPTION 'recovery_source_postimage_changed';END IF;
END $patch$;

DO $patch$ DECLARE s text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='fn_ca_operator_floor_state(uuid)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND to_jsonb(proacl)='["postgres=X/postgres", "service_role=X/postgres"]'::jsonb) THEN RAISE EXCEPTION 'recovery_owner_or_acl_changed: fn_ca_operator_floor_state(uuid)';END IF;
 s:=pg_get_functiondef('fn_ca_operator_floor_state(uuid)'::regprocedure);
 IF md5(s) IS DISTINCT FROM '2b435ae83349dd87fa926caf79ff8236' THEN RAISE EXCEPTION 'recovery_source_owner_changed: fn_ca_operator_floor_state(uuid)';END IF;
 EXECUTE $owner_2b435ae83349dd87fa926caf79ff8236$CREATE OR REPLACE FUNCTION public.fn_ca_operator_floor_state(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object(
 'hold',coalesce(
  (SELECT jsonb_build_object('operation_id',c.operation_id,'mode','park','reason',c.reason)
   FROM public.ca_diamond_arena_owner_closure c JOIN public.tables t ON t.club_id=c.club_id
   -- Park at the existing engine boundary, including old retained originals.
   -- Their persisted permits, continuations, snapshots and money remain intact.
   -- Recovery must wait for a separately authorized reopening.
   WHERE t.id=p_table_id AND c.closed),
  (SELECT to_jsonb(h) FROM public.ca_operator_floor_hold h WHERE NOT EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=h.operation_id) OR EXISTS(SELECT 1 FROM public.ca_launch_operator_scopes m WHERE m.operation_id=h.operation_id AND EXISTS(SELECT 1 FROM public.tables st WHERE st.id=p_table_id AND st.tournament_id IS NULL AND (st.club_id=ANY(m.club_ids) OR st.union_id=ANY(m.club_ids))))),
  (SELECT jsonb_build_object('operation_id',a.operation_id,'mode','park','reason',op.reason,'tournament_abort',true,'tournament_id',a.tournament_id)
   FROM smarter_private.tournament_abort_targets a JOIN public.tables t ON t.tournament_id=a.tournament_id
   JOIN smarter_private.tournament_abort_operations op ON op.operation_id=a.operation_id
   WHERE t.id=p_table_id AND NOT EXISTS(SELECT 1 FROM smarter_private.tournament_abort_recoveries r WHERE r.tournament_id=a.tournament_id AND r.operation_id=a.operation_id)
    -- Startup asks before it restores an original hand. An unfinished original
    -- is allowed through this READ so its existing permit can finish; the new
    -- permit door above is already stopped. Never mistake this read for ACK.
    AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.table_id=t.id AND h.state='reserved')
    AND NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots s WHERE s.table_id=t.id AND NOT s.is_complete))),
 'close',(SELECT to_jsonb(c) FROM public.ca_operator_table_closes c WHERE c.table_id=p_table_id AND c.status='pending'));
$function$
$owner_2b435ae83349dd87fa926caf79ff8236$;
 IF md5(pg_get_functiondef('fn_ca_operator_floor_state(uuid)'::regprocedure)) IS DISTINCT FROM 'a1664a877d1641e6f87f76c4651cf3bb' THEN RAISE EXCEPTION 'recovery_source_postimage_changed';END IF;
END $patch$;

DO $patch$ DECLARE s text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='fn_ca_settle_tournament_abort(uuid,uuid,text)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND to_jsonb(proacl)='["postgres=X/postgres", "service_role=X/postgres"]'::jsonb) THEN RAISE EXCEPTION 'recovery_owner_or_acl_changed: fn_ca_settle_tournament_abort(uuid,uuid,text)';END IF;
 s:=pg_get_functiondef('fn_ca_settle_tournament_abort(uuid,uuid,text)'::regprocedure);
 IF md5(s) IS DISTINCT FROM '4fc62beaf628ed3531b4de8c48165d57' THEN RAISE EXCEPTION 'recovery_source_owner_changed: fn_ca_settle_tournament_abort(uuid,uuid,text)';END IF;
 EXECUTE $owner_4fc62beaf628ed3531b4de8c48165d57$CREATE OR REPLACE FUNCTION public.fn_ca_settle_tournament_abort(p_operation_id uuid, p_tournament_id uuid, p_expected_money_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE a smarter_private.tournament_abort_targets;t public.tournaments; financial jsonb; v_receipt jsonb; pre_roster jsonb; pre_seats jsonb; before_history jsonb; after_history jsonb;
 player_ids uuid[];refunded_ids uuid[];zero_ids uuid[];table_ids uuid[];seat_ids uuid[];released_ids uuid[];fee_ids uuid[]:='{}';
 fee record;fee_id uuid; rake_before numeric;rake_after numeric;fees_reversed numeric:=0; settled timestamptz:=clock_timestamp();
 actor constant uuid:='2d1cd6c3-5700-4af9-a271-d4863fdab20d'; v_close_note constant text:='Explicit operator started-event abort after generation-bound physical and manager drain';
BEGIN
 PERFORM smarter_private.cancellation_lane(p_tournament_id);
 PERFORM smarter_private.assert_tournament_abort_not_recovered(p_operation_id,p_tournament_id);
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'operator_abort_service_required' USING ERRCODE='42501';END IF;
 PERFORM smarter_private.cancellation_lane(p_tournament_id);
 SELECT * INTO t FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
 SELECT * INTO a FROM smarter_private.tournament_abort_targets WHERE operation_id=p_operation_id AND tournament_id=p_tournament_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'operator_abort_target_not_owned';END IF;
 IF a.state='settled' THEN RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id);END IF;
 PERFORM smarter_private.assert_tournament_abort_quiesced(p_operation_id,p_tournament_id);
 IF p_expected_money_hash IS NULL OR p_expected_money_hash IS DISTINCT FROM a.quiescence->>'money_hash' THEN RAISE EXCEPTION 'operator_abort_review_hash_mismatch' USING ERRCODE='55000';END IF;
 IF t.started_at IS NULL OR upper(t.status) NOT IN('RUNNING','BREAK','LATE_REG') THEN RAISE EXCEPTION 'operator_abort_parent_not_running';END IF;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=p_tournament_id ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id ORDER BY s.id FOR UPDATE OF s;
 SELECT coalesce(array_agg(id ORDER BY id),'{}'),coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]') INTO player_ids,pre_roster FROM public.tournament_players p WHERE tournament_id=p_tournament_id;
 SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO table_ids FROM public.tables WHERE tournament_id=p_tournament_id;
 SELECT coalesce(array_agg(s.id ORDER BY s.id),'{}') INTO seat_ids FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'table_id',s.table_id,'user_id',s.user_id,'seat_number',s.seat_number,'stack',s.stack,'status',s.status,'left_at',s.left_at,'occupancy_id',to_jsonb(s)->'occupancy_id') ORDER BY s.id),'[]'::jsonb) INTO pre_seats FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id;
 SELECT coalesce(array_agg(s.id ORDER BY s.id),'{}') INTO released_ids FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id WHERE tb.tournament_id=p_tournament_id AND s.left_at IS NULL;
 before_history:=jsonb_build_object('awards',a.money_snapshot->'awards','bounty_awards',a.money_snapshot->'bounty_awards','satellite_awards',a.money_snapshot->'satellite_awards',
  'hands',(SELECT md5(coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.id)::text,'[]')) FROM public.hand_history h WHERE h.tournament_id=p_tournament_id));
 IF a.asset='diamonds' THEN financial:=smarter_private.diamond_tournament_abort_refunds(p_operation_id,p_tournament_id);
 ELSE financial:=smarter_private.chip_tournament_abort_refunds(p_operation_id,p_tournament_id);END IF;
 IF financial->>'fully_settled' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'operator_abort_financial_receipt_incomplete';END IF;
 SELECT coalesce(sum(rake_amount),0) INTO rake_before FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 IF rake_before<0 OR rake_before::text IN('NaN','Infinity','-Infinity') OR round(coalesce(t.total_rake,0),2) IS DISTINCT FROM rake_before THEN RAISE EXCEPTION 'operator_abort_rake_cache_mismatch';END IF;
 FOR fee IN SELECT club_id,metadata->>'user_id' user_id,sum(rake_amount) amount,jsonb_agg(id ORDER BY id) source_ids FROM public.rake_records
  WHERE tournament_id=p_tournament_id AND is_tournament GROUP BY club_id,metadata->>'user_id' HAVING sum(rake_amount)>0 ORDER BY club_id,metadata->>'user_id' LOOP
  IF fee.club_id IS NULL OR fee.user_id IS NULL THEN RAISE EXCEPTION 'operator_abort_unattributed_rake_source';END IF;
  INSERT INTO public.rake_records(club_id,rake_amount,pot_size,num_players,bbj_contribution,is_tournament,tournament_id,source,metadata)
  VALUES(fee.club_id,-fee.amount,fee.amount,1,0,true,p_tournament_id,'operator_abort_tournament',jsonb_build_object('kind','tournament_fee_refund','operation_id',p_operation_id,'user_id',fee.user_id,'original_rake_record_ids',fee.source_ids)) RETURNING id INTO fee_id;
  fee_ids:=array_append(fee_ids,fee_id);fees_reversed:=fees_reversed+fee.amount;
 END LOOP;
 SELECT coalesce(sum(rake_amount),0) INTO rake_after FROM public.rake_records WHERE tournament_id=p_tournament_id AND is_tournament;
 IF rake_after<>0 OR fees_reversed IS DISTINCT FROM rake_before THEN RAISE EXCEPTION 'operator_abort_rake_not_exactly_closed';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournament_escrow WHERE tournament_id=p_tournament_id AND enforced AND closed_at IS NULL AND prize_balance=0 AND bounty_balance=0 AND fee_balance=0) THEN RAISE EXCEPTION 'operator_abort_escrow_not_exact_zero';END IF;
 UPDATE public.tournament_escrow SET closed_at=settled,close_note=v_close_note,updated_at=now() WHERE tournament_id=p_tournament_id;
 -- Keep original eliminated_at, elimination sequence, finish position and prize.
 -- Active remaining virtual stacks are administrative retirements, not results.
 UPDATE public.tournament_players SET status='eliminated',chips=0,current_bounty=0 WHERE tournament_id=p_tournament_id AND status::text<>'eliminated';
 UPDATE public.table_seats s SET left_at=coalesce(s.left_at,settled),status='left',stack=0,leave_pending=false,is_sitting_out=false,is_away=false,sit_out_at=NULL,scheduled_leave_hands=NULL
  FROM public.tables tb WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id;
 UPDATE public.tournaments SET status='CANCELLED',ended_at=settled,updated_at=now(),prize_pool=0,bounty_pool=0,total_rake=0,current_players=0,on_break=false,break_started_at=NULL,break_ends_at=NULL WHERE id=p_tournament_id;
 UPDATE public.tables SET status='closed',lifecycle='closed',current_players=0,terminal_closed_at=settled,updated_at=now() WHERE tournament_id=p_tournament_id;
 after_history:=jsonb_build_object('awards',smarter_private.tournament_abort_money_snapshot(p_tournament_id)->'awards','bounty_awards',smarter_private.tournament_abort_money_snapshot(p_tournament_id)->'bounty_awards','satellite_awards',smarter_private.tournament_abort_money_snapshot(p_tournament_id)->'satellite_awards',
  'hands',(SELECT md5(coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.id)::text,'[]')) FROM public.hand_history h WHERE h.tournament_id=p_tournament_id));
 IF before_history IS DISTINCT FROM after_history THEN RAISE EXCEPTION 'operator_abort_earned_results_or_original_hands_changed:%:%:%:%',before_history,after_history,financial->'prior_awards_preserved',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM public.tournament_obligations o WHERE tournament_id=p_tournament_id AND kind<>'refund');END IF;
 SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO refunded_ids FROM public.tournament_players p WHERE p.tournament_id=p_tournament_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(financial->'refunds') r WHERE (r->>'user_id')::uuid=p.user_id);
 SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO zero_ids FROM unnest(player_ids) id WHERE NOT id=ANY(refunded_ids);
 v_receipt:=jsonb_build_object('ok',true,'success',true,'fully_settled',true,'receipt_version',3,'mode','started_operator_abort','operation_id',p_operation_id,'tournament_id',p_tournament_id,'actor_id',actor,'status','CANCELLED',
 'source_player_count',cardinality(player_ids),'refunded_count',cardinality(refunded_ids),'refund_line_count',jsonb_array_length(financial->'refunds'),'ticket_return_count',0,'ticket_returns','[]'::jsonb,'total_ticket_returned',0,
 'total_refunded',(financial->>'total_refunded')::numeric,'fees_reversed',fees_reversed,'closed_table_count',cardinality(table_ids),'source_seat_count',cardinality(seat_ids),'released_seat_count',cardinality(released_ids),'refunds',financial->'refunds','settled_at',settled,
 'original_started_at',t.started_at,'financial',financial,'pre_abort_roster',pre_roster,'pre_abort_seats',pre_seats,'preserved_history',before_history,'quiescence',a.quiescence,'terminal_snapshot',smarter_private.tournament_abort_terminal_snapshot(p_tournament_id));
 UPDATE smarter_private.tournament_abort_targets SET state='settled',receipt=v_receipt,settled_at=settled WHERE tournament_id=p_tournament_id AND operation_id=p_operation_id;
 INSERT INTO public.tournament_cancellation_receipts(tournament_id,actor_id,receipt_version,source_player_count,source_player_ids,refunded_count,refunded_registration_ids,refund_line_count,ticket_return_count,ticket_return_ids,total_ticket_returned,zero_refund_count,zero_refund_registration_ids,total_refunded,fees_reversed,total_rake_before,total_rake_after,closed_table_count,closed_table_ids,source_seat_count,source_seat_ids,released_seat_count,released_seat_ids,fee_reversal_ids,escrow_closed_at,escrow_close_note,spin_unwind_tournament_id,receipt,settled_at)
 VALUES(p_tournament_id,actor,3,cardinality(player_ids),player_ids,cardinality(refunded_ids),refunded_ids,jsonb_array_length(financial->'refunds'),0,'{}',0,cardinality(zero_ids),zero_ids,(financial->>'total_refunded')::numeric,fees_reversed,rake_before,rake_after,cardinality(table_ids),table_ids,cardinality(seat_ids),seat_ids,cardinality(released_ids),released_ids,fee_ids,settled,v_close_note,NULL,v_receipt,settled);
 IF a.asset='chips' THEN PERFORM public.fn_record_accounting_tournament_cancellation(p_tournament_id);END IF;
 RETURN public.fn_ca_tournament_cancellation_receipt(p_tournament_id);
END $function$
$owner_4fc62beaf628ed3531b4de8c48165d57$;
 IF md5(pg_get_functiondef('fn_ca_settle_tournament_abort(uuid,uuid,text)'::regprocedure)) IS DISTINCT FROM '32ffc8212bcbaec490b76fb904707d3c' THEN RAISE EXCEPTION 'recovery_source_postimage_changed';END IF;
END $patch$;

DO $patch$ DECLARE s text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='fn_ca_tournament_abort_stop_state(uuid,uuid)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND to_jsonb(proacl)='["postgres=X/postgres", "service_role=X/postgres"]'::jsonb) THEN RAISE EXCEPTION 'recovery_owner_or_acl_changed: fn_ca_tournament_abort_stop_state(uuid,uuid)';END IF;
 s:=pg_get_functiondef('fn_ca_tournament_abort_stop_state(uuid,uuid)'::regprocedure);
 IF md5(s) IS DISTINCT FROM '7ea88407cc10cbb625fcae9d16c70c30' THEN RAISE EXCEPTION 'recovery_source_owner_changed: fn_ca_tournament_abort_stop_state(uuid,uuid)';END IF;
 EXECUTE $owner_7ea88407cc10cbb625fcae9d16c70c30$CREATE OR REPLACE FUNCTION public.fn_ca_tournament_abort_stop_state(p_operation_id uuid, p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE a smarter_private.tournament_abort_targets; g uuid;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'operator_abort_service_required' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM smarter_private.tournament_abort_targets WHERE operation_id=p_operation_id AND tournament_id=p_tournament_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'operator_abort_target_not_owned' USING ERRCODE='55000';END IF;
 SELECT lease_generation INTO g FROM public.engine_tournament_leases WHERE tournament_id=p_tournament_id AND protocol_version=2 AND heartbeat_at>=clock_timestamp()-interval '30 seconds';
 RETURN jsonb_build_object('ok',true,'operation_id',a.operation_id,'tournament_id',a.tournament_id,'state',CASE WHEN EXISTS(SELECT 1 FROM smarter_private.tournament_abort_recoveries r WHERE r.tournament_id=a.tournament_id AND r.operation_id=a.operation_id) THEN 'recovery' ELSE a.state END,
  'requested_generation',a.requested_generation,'current_generation',g,'quiescence_generation',a.quiescence->>'generation',
  'current_boundary_valid',(a.state='quiesced' AND g IS NOT NULL AND a.quiescence->>'generation'=g::text AND a.money_snapshot=smarter_private.tournament_abort_money_snapshot(p_tournament_id) AND a.quiescence->>'money_hash'=md5(a.money_snapshot::text) AND NOT smarter_private.tournament_abort_pending(p_tournament_id) AND NOT EXISTS(SELECT 1 FROM public.tables tb WHERE tb.tournament_id=p_tournament_id AND lower(tb.status)<>'closed' AND NOT coalesce(tb.is_deleted,false) AND NOT EXISTS(SELECT 1 FROM smarter_private.tournament_abort_boundaries b WHERE b.operation_id=p_operation_id AND b.table_id=tb.id AND b.lifecycle=tb.f06_lifecycle AND b.acknowledged_generation=g AND b.acknowledged_at IS NOT NULL))),'receipt',a.receipt,'tournament_status',(SELECT status FROM public.tournaments WHERE id=p_tournament_id),'money_snapshot',a.money_snapshot,'money_hash',a.quiescence->>'money_hash','pending',smarter_private.tournament_abort_pending(p_tournament_id),
  'tables',coalesce((SELECT jsonb_agg(jsonb_build_object('table_id',t.id,'lifecycle',t.f06_lifecycle::text,'required',lower(t.status)<>'closed' AND NOT coalesce(t.is_deleted,false),'requested_generation',a.requested_generation,'current_generation',g) ORDER BY t.id) FROM public.tables t WHERE t.tournament_id=p_tournament_id),'[]'::jsonb));
END $function$
$owner_7ea88407cc10cbb625fcae9d16c70c30$;
 IF md5(pg_get_functiondef('fn_ca_tournament_abort_stop_state(uuid,uuid)'::regprocedure)) IS DISTINCT FROM 'f078025253ce10976e30588e31b46663' THEN RAISE EXCEPTION 'recovery_source_postimage_changed';END IF;
END $patch$;

DO $patch$ DECLARE s text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND to_jsonb(proacl)='["postgres=X/postgres", "service_role=X/postgres"]'::jsonb) THEN RAISE EXCEPTION 'recovery_owner_or_acl_changed: fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)';END IF;
 s:=pg_get_functiondef('fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)'::regprocedure);
 IF md5(s) IS DISTINCT FROM '1469a8f499a4669d893863d129b1bb0d' THEN RAISE EXCEPTION 'recovery_source_owner_changed: fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)';END IF;
 EXECUTE $owner_1469a8f499a4669d893863d129b1bb0d$CREATE OR REPLACE FUNCTION public.fn_f06_begin_hand(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid, p_lifecycle bigint, p_permit_id uuid, p_hand_number bigint, p_custody_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE h smarter_private.f06_hand_permits;
BEGIN
 /* A TABLE'S HAND DOES NOT WAIT FOR ITS SIBLING TABLES (2026-10-03): the
    tournament lane T(id) shared, then this table and its seats FOR
    UPDATE. See fn_ca_f06_share_table_lane. */
 PERFORM public.fn_ca_f06_share_table_lane(p_tournament_id,p_lease_generation,p_table_id);
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE permit_id=p_permit_id;
 IF FOUND THEN
 IF (h.tournament_id,h.table_id,h.lifecycle,h.hand_number,h.custody_id,h.generation) IS DISTINCT FROM(p_tournament_id,p_table_id,p_lifecycle,p_hand_number,p_custody_id,p_lease_generation) THEN
 RAISE EXCEPTION 'F06_CHANGED_HAND_PERMIT' USING ERRCODE='22023'; END IF;
 RETURN to_jsonb(h)||jsonb_build_object('ok',h.state='reserved','lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text); END IF;
 -- Exact existing permit replay above stays lawful; only new hands stop.
 IF EXISTS(SELECT 1 FROM public.ca_diamond_arena_owner_closure c JOIN public.tables t ON t.club_id=c.club_id WHERE t.id=p_table_id AND c.closed) THEN
  RETURN jsonb_build_object('ok',false,'reason','diamond_arena_closed');
 END IF;
 -- A permit its engine attested absent (fn_park_stopped_time_bank_custody, 2026-09-27)
 -- can never be begun afterwards: the absence was recorded under this same lane.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_absent_permit_releases WHERE permit_id=p_permit_id) THEN
 RETURN jsonb_build_object('ok',false,'reason','permit_released_absent'); END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id=p_table_id AND state NOT IN ('acknowledged','withdrawn_before_manifest')) THEN
 RETURN jsonb_build_object('ok',false,'reason','source_excluded'); END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tables tb JOIN public.tournaments t ON t.id=tb.tournament_id WHERE tb.id=p_table_id AND t.id=p_tournament_id AND upper(t.status)='RUNNING' AND tb.f06_lifecycle=p_lifecycle
 AND lower(tb.status)<>'closed' AND NOT COALESCE(tb.is_deleted,false)) THEN RAISE EXCEPTION 'F06_HAND_LIFECYCLE' USING ERRCODE='55000'; END IF;
 IF p_hand_number IS NULL OR p_hand_number<1 OR p_custody_id IS NULL THEN RAISE EXCEPTION 'F06_HAND_IDENTITY' USING ERRCODE='22023'; END IF;
 -- Hand numbers are permanently unique for the physical table, across every lifecycle.
 -- Exact permit replay above is lawful; a new permit cannot adopt historical evidence.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table_id AND hand_number=p_hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table_id AND hand_number=p_hand_number) THEN
 RETURN jsonb_build_object('ok',false,'reason','hand_number_already_used'); END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id AND state='reserved') THEN
 RETURN jsonb_build_object('ok',false,'reason','hand_permit_unresolved'); END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.tournament_abort_targets a WHERE a.tournament_id=p_tournament_id AND NOT EXISTS(SELECT 1 FROM smarter_private.tournament_abort_recoveries r WHERE r.tournament_id=a.tournament_id AND r.operation_id=a.operation_id)) THEN
  RETURN jsonb_build_object('ok',false,'reason','operator_abort_stopped');
 END IF;
 INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation)
 VALUES(p_permit_id,p_tournament_id,p_table_id,p_lifecycle,p_hand_number,p_custody_id,p_lease_generation) RETURNING * INTO h;
 RETURN to_jsonb(h)||jsonb_build_object('ok',true,'lifecycle',h.lifecycle::text,'hand_number',h.hand_number::text);
END $function$
$owner_1469a8f499a4669d893863d129b1bb0d$;
 IF md5(pg_get_functiondef('fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)'::regprocedure)) IS DISTINCT FROM '903c9322cc0069ecf8ad9291408d18d6' THEN RAISE EXCEPTION 'recovery_source_postimage_changed';END IF;
END $patch$;

DO $patch$ DECLARE s text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.assert_tournament_abort_quiesced(uuid,uuid)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND to_jsonb(proacl)='["postgres=X/postgres"]'::jsonb) THEN RAISE EXCEPTION 'recovery_owner_or_acl_changed: smarter_private.assert_tournament_abort_quiesced(uuid,uuid)';END IF;
 s:=pg_get_functiondef('smarter_private.assert_tournament_abort_quiesced(uuid,uuid)'::regprocedure);
 IF md5(s) IS DISTINCT FROM 'cd958a8d0c527752b0301be577efb952' THEN RAISE EXCEPTION 'recovery_source_owner_changed: smarter_private.assert_tournament_abort_quiesced(uuid,uuid)';END IF;
 EXECUTE $owner_cd958a8d0c527752b0301be577efb952$CREATE OR REPLACE FUNCTION smarter_private.assert_tournament_abort_quiesced(p_operation_id uuid, p_tournament_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE a smarter_private.tournament_abort_targets; g uuid;
BEGIN
 PERFORM smarter_private.cancellation_lane(p_tournament_id);
 PERFORM smarter_private.assert_tournament_abort_not_recovered(p_operation_id,p_tournament_id);
 SELECT * INTO a FROM smarter_private.tournament_abort_targets WHERE operation_id=p_operation_id AND tournament_id=p_tournament_id FOR UPDATE;
 IF NOT FOUND OR a.state IS DISTINCT FROM 'quiesced' THEN RAISE EXCEPTION 'operator_abort_not_quiesced' USING ERRCODE='55000';END IF;
 SELECT lease_generation INTO g FROM public.engine_tournament_leases WHERE tournament_id=p_tournament_id AND protocol_version=2 AND heartbeat_at>=clock_timestamp()-interval '30 seconds' FOR KEY SHARE;
 IF g IS NULL OR a.quiescence->>'generation' IS DISTINCT FROM g::text
 OR smarter_private.tournament_abort_pending(p_tournament_id)
 OR EXISTS(SELECT 1 FROM public.tables t WHERE t.tournament_id=p_tournament_id AND lower(t.status)<>'closed' AND NOT coalesce(t.is_deleted,false)
  AND NOT EXISTS(SELECT 1 FROM smarter_private.tournament_abort_boundaries b WHERE b.operation_id=p_operation_id AND b.table_id=t.id
   AND b.lifecycle=t.f06_lifecycle AND b.acknowledged_generation=g AND b.acknowledged_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'operator_abort_current_owner_or_boundary_changed' USING ERRCODE='55000';END IF;
 IF a.money_snapshot IS DISTINCT FROM smarter_private.tournament_abort_money_snapshot(p_tournament_id) THEN
  RAISE EXCEPTION 'operator_abort_money_review_changed' USING ERRCODE='55000';END IF;
END $function$
$owner_cd958a8d0c527752b0301be577efb952$;
 IF md5(pg_get_functiondef('smarter_private.assert_tournament_abort_quiesced(uuid,uuid)'::regprocedure)) IS DISTINCT FROM 'df9c5fba713a45fabb7bd4f0b411f616' THEN RAISE EXCEPTION 'recovery_source_postimage_changed';END IF;
END $patch$;

DO $patch$ DECLARE s text; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.tournament_abort_ingress(uuid)'::regprocedure AND pg_get_userbyid(proowner)='postgres' AND to_jsonb(proacl)='["postgres=X/postgres"]'::jsonb) THEN RAISE EXCEPTION 'recovery_owner_or_acl_changed: smarter_private.tournament_abort_ingress(uuid)';END IF;
 s:=pg_get_functiondef('smarter_private.tournament_abort_ingress(uuid)'::regprocedure);
 IF md5(s) IS DISTINCT FROM 'c84b394b07220ef06c7221114773d338' THEN RAISE EXCEPTION 'recovery_source_owner_changed: smarter_private.tournament_abort_ingress(uuid)';END IF;
 EXECUTE $owner_c84b394b07220ef06c7221114773d338$CREATE OR REPLACE FUNCTION smarter_private.tournament_abort_ingress(p_tournament_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
BEGIN
 IF EXISTS(SELECT 1 FROM smarter_private.tournament_abort_targets a WHERE a.tournament_id=p_tournament_id AND NOT EXISTS(SELECT 1 FROM smarter_private.tournament_abort_recoveries r WHERE r.tournament_id=a.tournament_id AND r.operation_id=a.operation_id)) THEN
  RAISE EXCEPTION 'TOURNAMENT_OPERATOR_ABORT: new entry, rebuy or add-on is stopped' USING ERRCODE='55000';
 END IF;
END $function$
$owner_c84b394b07220ef06c7221114773d338$;
 IF md5(pg_get_functiondef('smarter_private.tournament_abort_ingress(uuid)'::regprocedure)) IS DISTINCT FROM 'efaf998fc4e268f748060da2806b9764' THEN RAISE EXCEPTION 'recovery_source_postimage_changed';END IF;
END $patch$;
REVOKE ALL ON FUNCTION fn_ca_ack_tournament_abort_boundary(uuid,uuid,uuid,uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION fn_ca_ack_tournament_abort_boundary(uuid,uuid,uuid,uuid,bigint,jsonb) TO service_role;
REVOKE ALL ON FUNCTION fn_ca_operator_floor_state(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION fn_ca_operator_floor_state(uuid) TO service_role;
REVOKE ALL ON FUNCTION fn_ca_settle_tournament_abort(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION fn_ca_settle_tournament_abort(uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION fn_ca_tournament_abort_stop_state(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION fn_ca_tournament_abort_stop_state(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION fn_f06_begin_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid) TO service_role;
REVOKE ALL ON FUNCTION smarter_private.assert_tournament_abort_quiesced(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION smarter_private.tournament_abort_ingress(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
