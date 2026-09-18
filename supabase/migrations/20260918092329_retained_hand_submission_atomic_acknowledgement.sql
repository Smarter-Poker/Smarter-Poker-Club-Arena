-- Preserve the original protocol-2 settlement request before dispatch.
-- The 2026-09-18 Spin refusal exposed a completed preflop snapshot but no
-- durable original request after a canonical XX000 rollback and engine kill.
-- New receipt-only continuation uses existing exact lease and financial owners.
-- Snapshot completion and accepted receipt commit together. No old hand is
-- reconstructed. A positive canonical failure can delegate the unchanged
-- original once to a verified successor; accepted postcommit remains replayable.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock_shared(530090,1);
DO $$ BEGIN IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'HAND_SUBMISSION_INSTALL_FROZEN'; END IF; END $$;
LOCK TABLE smarter_private.f06_hand_permits,public.hand_state_snapshots IN SHARE ROW EXCLUSIVE MODE;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.complete_hand_snapshot(uuid,integer)'::regprocedure AND md5(pg_get_functiondef(oid))='dd69801c4d64338a2d20ce8b4b60641c' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.complete_hand_snapshot(uuid,integer)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'::regprocedure AND md5(pg_get_functiondef(oid))='b49192e78f472d7a931bcf20de46a702' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='c555fb7b83c889312995bc0038c1b275' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure AND md5(pg_get_functiondef(oid))='8c0acda3b19e958ecd5bbbc07c845afe' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_share_settlement_lane_for_table(uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='409b14ee72ce888d3b26524c52d49a68' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.fn_ca_share_settlement_lane_for_table(uuid)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_hand_dispatch_guard(uuid,bigint)'::regprocedure AND md5(pg_get_functiondef(oid))='fa3b6cc670788a490c42f324ecf74a76' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','smarter_private.f06_hand_dispatch_guard(uuid,bigint)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.promo_apply_playthrough(uuid,uuid,numeric)'::regprocedure AND md5(pg_get_functiondef(oid))='ee9bcdf31b5f212b67e0ff536033f20c' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.promo_apply_playthrough(uuid,uuid,numeric)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_abort_receipt_immutable()'::regprocedure AND md5(pg_get_functiondef(oid))='811127b67caea34bd7d3e5bc6c41ed94' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','smarter_private.f06_abort_receipt_immutable()'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_prepared_cancellation_immutable()'::regprocedure AND md5(pg_get_functiondef(oid))='02bf681ff7ba388c19cbdebb9efe42ac' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','smarter_private.f06_prepared_cancellation_immutable()'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_f06_cancel_prepared_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='2eaabb545cbc3251be0cef438b08f989' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.fn_f06_cancel_prepared_hand(uuid,uuid,uuid,bigint,uuid,bigint,uuid)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_immutable_identity()'::regprocedure AND md5(pg_get_functiondef(oid))='0fe40a0711ef6d196c6883d3b9e8b86f' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','smarter_private.f06_immutable_identity()'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_cancelled_preparation_writer_guard()'::regprocedure AND md5(pg_get_functiondef(oid))='a7467e2cb64bab202a359eed42432299' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','smarter_private.f06_cancelled_preparation_writer_guard()'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_insert_hand_with_awards(jsonb,jsonb)'::regprocedure AND md5(pg_get_functiondef(oid))='e7f05bb7d61360be7424c5f429066047' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.fn_ca_insert_hand_with_awards(jsonb,jsonb)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[])'::regprocedure AND md5(pg_get_functiondef(oid))='dae9d5b5f71a68362f202dfdf89c8fae' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[])'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_generation_aborted(uuid,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='3530559a94372866bf3baec006a8fd3c' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','smarter_private.f06_generation_aborted(uuid,uuid)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_aborted_generation_guard()'::regprocedure AND md5(pg_get_functiondef(oid))='78bdb7fde133088800446a0da7dddc57' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','smarter_private.f06_aborted_generation_guard()'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_authority(uuid,uuid,boolean)'::regprocedure AND md5(pg_get_functiondef(oid))='848b06c8e958ad739e0a60b388430f38' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','smarter_private.f06_authority(uuid,uuid,boolean)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_process_hand_post_commit_obligations(uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='8d18dde12765610895b25e297a1f403f' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.fn_ca_process_hand_post_commit_obligations(uuid)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)'::regprocedure AND md5(pg_get_functiondef(oid))='d5700b1c4e4663c5b9e12915a75d269b' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.fn_f06_finish_hand(uuid,uuid,uuid,text,uuid)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'::regprocedure AND md5(pg_get_functiondef(oid))='1d5fdcf284efb107c4f5e2a3be364fb0' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.claim_tournament_lease_v2(uuid,text,text,uuid,integer)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.claim_table_lease_v2(uuid,text,text,uuid,integer)'::regprocedure AND md5(pg_get_functiondef(oid))='2c6a2555d927c8dbbad47b8ac7b60552' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.claim_table_lease_v2(uuid,text,text,uuid,integer)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_engine_lease_stale_seconds()'::regprocedure AND md5(pg_get_functiondef(oid))='483a7e0ee940744fd557f1f2144d9eba' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.fn_engine_lease_stale_seconds()'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_platform_frozen()'::regprocedure AND md5(pg_get_functiondef(oid))='ec683805e052fceeae74789e82dce4cc' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.fn_platform_frozen()'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_serialize_engine_maintenance_break_write()'::regprocedure AND md5(pg_get_functiondef(oid))='6d62a5f9ad5e8fa615e3eac9396266a3' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.fn_serialize_engine_maintenance_break_write()'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_active_maintenance_release_boundary()'::regprocedure AND md5(pg_get_functiondef(oid))='0d9548e27105b7172d83be4f7d10ea47' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.fn_active_maintenance_release_boundary()'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.trg_finish_hand_post_commit_obligations()'::regprocedure AND md5(pg_get_functiondef(oid))='66d5a81792f64fc5ec1ab33ced6a05ba' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.trg_finish_hand_post_commit_obligations()'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.trg_notify_hand_projection_outbox()'::regprocedure AND md5(pg_get_functiondef(oid))='57069a33071dbb02460486310802be90' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.trg_notify_hand_projection_outbox()'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure AND md5(pg_get_functiondef(oid))='04e0218bf245c99a60b4d34f233c3b7a' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'; END IF; END $pin$;
DO $pin$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='smarter_private.f06_no_start_continuation_immutable()'::regprocedure AND md5(pg_get_functiondef(oid))='2c87da2a00030dcc36ecb62bf51b2a89' AND proowner='postgres'::regrole AND proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'HAND_SUBMISSION_AUTHORITY_DRIFT: %','smarter_private.f06_no_start_continuation_immutable()'; END IF; END $pin$;
DO $binding$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_hand_permits_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_immutable_identity()' AND tgenabled='O') THEN RAISE EXCEPTION 'HAND_SUBMISSION_TRIGGER_DRIFT'; END IF; END $binding$;
DO $binding$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND pg_get_triggerdef(oid)='CREATE TRIGGER aa_serialize_maintenance_break_write BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.engine_maintenance_break FOR EACH STATEMENT EXECUTE FUNCTION fn_serialize_engine_maintenance_break_write()' AND tgenabled='O') THEN RAISE EXCEPTION 'HAND_SUBMISSION_TRIGGER_DRIFT'; END IF; END $binding$;
DO $absent$ BEGIN IF to_regclass('smarter_private.hand_submissions') IS NOT NULL OR to_regclass('smarter_private.hand_submission_dispositions') IS NOT NULL OR to_regprocedure('public.fn_ca_commit_hand_submission(uuid,text,uuid)') IS NOT NULL OR to_regprocedure('public.fn_ca_retain_hand_submission(jsonb)') IS NOT NULL THEN RAISE EXCEPTION 'HAND_SUBMISSION_ALREADY_INSTALLED'; END IF; END $absent$;
-- Exact original requests, not inferred hand outcomes. No foreign keys to hot gameplay rows.
CREATE TABLE smarter_private.hand_submissions (
 submission_id uuid PRIMARY KEY,
 table_id uuid NOT NULL,
 hand_number bigint NOT NULL CHECK (hand_number>0),
 instance_id text NOT NULL CHECK (length(btrim(instance_id))>0),
 lease_generation uuid NOT NULL,
 request jsonb NOT NULL CHECK (jsonb_typeof(request)='object'),
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 retained_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(table_id,hand_number)
);
CREATE TABLE smarter_private.hand_submission_dispositions (
 table_id uuid NOT NULL,
 hand_number bigint NOT NULL CHECK(hand_number>0),
 permit_id uuid UNIQUE,
 disposition text NOT NULL CHECK(disposition IN ('retained','disposed')),
 submission_id uuid,
 PRIMARY KEY(table_id,hand_number),
 CHECK((disposition='retained')=(submission_id IS NOT NULL))
);
ALTER TABLE smarter_private.hand_submissions OWNER TO postgres;
ALTER TABLE smarter_private.hand_submission_dispositions OWNER TO postgres;
ALTER TABLE smarter_private.hand_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.hand_submission_dispositions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.hand_submissions,smarter_private.hand_submission_dispositions FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.hand_submission_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
BEGIN RAISE EXCEPTION 'HAND_SUBMISSION_IMMUTABLE' USING ERRCODE='55000'; END
$function$;
REVOKE ALL ON FUNCTION smarter_private.hand_submission_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER hand_submission_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submissions
 FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_disposition_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submission_dispositions
 FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();

CREATE TRIGGER hand_submission_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submissions
 FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_disposition_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submission_dispositions
 FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();

-- First committed unique fence wins even when a contender has an old MVCC snapshot.
-- The existing F06 owner still validates every disposition; this only rejects loss
-- of a retained settlement request. It never accepts, withdraws or fabricates a hand.
CREATE FUNCTION smarter_private.f06_retained_submission_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE d smarter_private.hand_submission_dispositions;
BEGIN
 IF NEW.state NOT IN ('never_started','aborted_unsettled') THEN RETURN NEW; END IF;
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,permit_id,disposition,submission_id)
 VALUES(NEW.table_id,NEW.hand_number,NEW.permit_id,'disposed',NULL) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF d.disposition<>'disposed' OR (d.permit_id IS NOT NULL AND d.permit_id IS DISTINCT FROM NEW.permit_id) THEN
  RAISE EXCEPTION 'F06_RETAINED_HAND_SUBMISSION_REQUIRES_ACCEPTED_DISPOSITION' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_retained_submission_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER f06_retained_submission_guard AFTER UPDATE OF state ON smarter_private.f06_hand_permits
 FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_retained_submission_guard();

-- A legacy startup/cleanup may not certify an unaccepted retained hand.
-- The unique fence also serializes a snapshot closer whose MVCC snapshot
-- predates retention: ON CONFLICT cannot silently ignore the winning row.
CREATE FUNCTION smarter_private.hand_submission_snapshot_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE d smarter_private.hand_submission_dispositions;
BEGIN
 IF NOT NEW.is_complete THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=NEW.table_id
   AND a.hand_number=NEW.hand_number AND a.hand_id IS NOT NULL AND a.post_commit_payload IS NOT NULL) THEN RETURN NEW; END IF;
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,disposition,submission_id)
 VALUES(NEW.table_id,NEW.hand_number,'disposed',NULL) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF d.disposition<>'disposed' THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_REQUIRED_FOR_COMPLETION' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.hand_submission_snapshot_guard() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER hand_submission_snapshot_guard AFTER INSERT OR UPDATE OF is_complete ON public.hand_state_snapshots
 FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_snapshot_guard();

CREATE FUNCTION smarter_private.assert_retained_hand_submission(p_request jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE s smarter_private.hand_submissions;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||(p_request->>'p_table_id')||':'||(p_request->>'p_hand_number'),0));
 SELECT * INTO s FROM smarter_private.hand_submissions
 WHERE table_id=(p_request->>'p_table_id')::uuid AND hand_number=(p_request->>'p_hand_number')::bigint;
 IF FOUND AND s.request IS DISTINCT FROM p_request THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_PAYLOAD_REQUIRED' USING ERRCODE='55000';
 END IF;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.assert_retained_hand_submission(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.fn_ca_retain_hand_submission(p_request jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,extensions AS $function$
DECLARE s smarter_private.hand_submissions; h smarter_private.f06_hand_permits;
 d smarter_private.hand_submission_dispositions;
 tid uuid; hn bigint; sid uuid; instance text; generation uuid; tour uuid; locked_tour uuid;
 holder text; lease uuid; protocol integer; beat timestamptz; request_hash text;
BEGIN
 IF jsonb_typeof(p_request) IS DISTINCT FROM 'object'
 OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p_request) k) IS DISTINCT FROM
 ARRAY['p_bbj','p_hand_number','p_hand_row','p_inflow','p_instance_id','p_lease_generation','p_post_commit_obligations','p_rake','p_ref','p_stacks','p_table_id','p_units']
 OR jsonb_typeof(p_request->'p_stacks') IS DISTINCT FROM 'array'
 OR jsonb_typeof(p_request->'p_hand_row') IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_request->'p_post_commit_obligations') IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_request->'p_units') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_INVALID_REQUEST' USING ERRCODE='22023';
 END IF;
 tid:=(p_request->>'p_table_id')::uuid; hn:=(p_request->>'p_hand_number')::bigint;
 sid:=(p_request->'p_hand_row'->>'id')::uuid;
 instance:=p_request->>'p_instance_id'; generation:=(p_request->>'p_lease_generation')::uuid;
 IF tid IS NULL OR hn IS NULL OR hn<=0 OR sid IS NULL OR generation IS NULL OR length(btrim(COALESCE(instance,'')))=0
 OR (p_request->'p_hand_row'->>'table_id')::uuid IS DISTINCT FROM tid
 OR (p_request->'p_hand_row'->>'hand_number')::bigint IS DISTINCT FROM hn THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_INVALID_IDENTITY' USING ERRCODE='22023';
 END IF;
 PERFORM public.fn_ca_share_settlement_lane_for_table(tid);
 PERFORM smarter_private.assert_retained_hand_submission(p_request);
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE table_id=tid AND hand_number=hn;
 IF FOUND THEN
  RETURN jsonb_build_object('retained',true,'submission_id',s.submission_id,'request_hash',s.request_hash,'replay',true);
 END IF;
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=tid AND hand_number=hn;
 IF FOUND THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
   RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
  SELECT * INTO STRICT h FROM smarter_private.f06_hand_permits WHERE permit_id=h.permit_id;
  IF h.state NOT IN ('reserved','accepted') OR h.generation IS DISTINCT FROM generation THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_PERMIT_FENCED' USING ERRCODE='55000'; END IF;
 END IF;
 SELECT tournament_id INTO tour FROM public.tables WHERE id=tid;
 IF NOT FOUND THEN RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_MISSING' USING ERRCODE='55000'; END IF;
 IF tour IS NOT NULL AND (h.permit_id IS NULL OR h.tournament_id IS DISTINCT FROM tour) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_PERMIT_REQUIRED' USING ERRCODE='55000'; END IF;
 IF tour IS NULL THEN
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,lease,protocol,beat
  FROM public.engine_table_leases WHERE table_id=tid FOR KEY SHARE;
 ELSE
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,lease,protocol,beat
  FROM public.engine_tournament_leases WHERE tournament_id=tour FOR KEY SHARE;
 END IF;
 IF holder IS DISTINCT FROM instance OR lease IS DISTINCT FROM generation OR protocol IS DISTINCT FROM 2
 OR beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
 IF tour IS NOT NULL THEN PERFORM 1 FROM public.tournaments WHERE id=tour FOR SHARE; END IF;
 SELECT tournament_id INTO locked_tour FROM public.tables WHERE id=tid FOR UPDATE;
 IF NOT FOUND OR locked_tour IS DISTINCT FROM tour THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.hand_submission_dispositions(table_id,hand_number,permit_id,disposition,submission_id)
 VALUES(tid,hn,h.permit_id,'retained',sid) ON CONFLICT(table_id,hand_number) DO NOTHING;
 SELECT * INTO STRICT d FROM smarter_private.hand_submission_dispositions WHERE table_id=tid AND hand_number=hn;
 IF d.disposition<>'retained' OR d.submission_id IS DISTINCT FROM sid OR d.permit_id IS DISTINCT FROM h.permit_id THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_PERMIT_DISPOSED' USING ERRCODE='55000'; END IF;
 request_hash:=encode(extensions.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex');
 INSERT INTO smarter_private.hand_submissions(submission_id,table_id,hand_number,instance_id,lease_generation,request,request_hash)
 VALUES(sid,tid,hn,instance,generation,p_request,request_hash);
 RETURN jsonb_build_object('retained',true,'submission_id',sid,'request_hash',request_hash,'replay',false);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_retain_hand_submission(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_retain_hand_submission(jsonb) TO service_role;

-- New receipt-only entry. Financial computation and exact-generation admission
-- remain in the existing public authority; the payload cannot be reconstructed.
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
 VALUES('fn_ca_commit_hand_submission','approved',
 'Exact retained original hand payload delegates existing 12-argument settlement; snapshot completes only with accepted receipt.');
CREATE FUNCTION public.fn_ca_commit_hand_submission(p_submission_id uuid,p_instance_id text,p_lease_generation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE s smarter_private.hand_submissions; r jsonb; q jsonb; completed integer;
BEGIN
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=p_submission_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'HAND_SUBMISSION_NOT_RETAINED' USING ERRCODE='55000'; END IF;
 IF s.instance_id IS DISTINCT FROM p_instance_id OR s.lease_generation IS DISTINCT FROM p_lease_generation THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_OWNER_REQUIRED' USING ERRCODE='55000'; END IF;
 q:=s.request;
 r:=public.fn_ca_commit_hand_settlement(s.table_id,s.hand_number,q->'p_stacks',
 (q->>'p_rake')::numeric,(q->>'p_bbj')::numeric,q->>'p_ref',(q->>'p_inflow')::numeric,
 q->'p_hand_row',q->'p_units',s.instance_id,s.lease_generation,q->'p_post_commit_obligations');
 IF r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true' THEN RETURN r; END IF;
 IF r->>'history_id' IS DISTINCT FROM s.submission_id::text OR r->>'post_commit_obligations' IS DISTINCT FROM 'true'
 OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number=s.hand_number
 AND hand_id=s.submission_id AND post_commit_payload IS NOT NULL) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000'; END IF;
 UPDATE public.hand_state_snapshots SET is_complete=true,updated_at=clock_timestamp()
 WHERE table_id=s.table_id AND hand_number=s.hand_number AND NOT is_complete;
 GET DIAGNOSTICS completed=ROW_COUNT;
 RETURN r||jsonb_build_object('submission_id',s.submission_id,'submission_hash',s.request_hash,
 'snapshot_completed',true,'snapshots_completed',completed);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_submission(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_submission(uuid,text,uuid) TO service_role;

-- A canonical failure is positive original-owner evidence, never inferred from
-- missing history, transport loss, an old snapshot, or a successor's presence.
CREATE TABLE smarter_private.hand_submission_failures (
 submission_id uuid PRIMARY KEY, transaction_id bigint NOT NULL,
 request_hash text NOT NULL, result jsonb NOT NULL,
 CHECK(result->>'success'='false' AND result->>'reason'='atomic_hand_rolled_back'
   AND length(result->>'sqlstate')=5)
);
CREATE TABLE smarter_private.hand_submission_handoffs (
 submission_id uuid PRIMARY KEY, original_generation uuid NOT NULL,
 instance_id text NOT NULL, lease_generation uuid NOT NULL,
 request_hash text NOT NULL, transaction_id bigint NOT NULL,
 CHECK(original_generation<>lease_generation)
);
CREATE TABLE smarter_private.hand_submission_handoff_results (
 submission_id uuid PRIMARY KEY, result jsonb NOT NULL
);
-- A consumed capability is usable only inside the one owning transaction.
CREATE TABLE smarter_private.hand_submission_dispatch (
 transaction_id bigint NOT NULL, submission_id uuid NOT NULL,
 request_hash text NOT NULL, instance_id text NOT NULL, lease_generation uuid NOT NULL,
 PRIMARY KEY(transaction_id,submission_id)
);
ALTER TABLE smarter_private.hand_submission_failures OWNER TO postgres;
ALTER TABLE smarter_private.hand_submission_handoffs OWNER TO postgres;
ALTER TABLE smarter_private.hand_submission_handoff_results OWNER TO postgres;
ALTER TABLE smarter_private.hand_submission_dispatch OWNER TO postgres;
ALTER TABLE smarter_private.hand_submission_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.hand_submission_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.hand_submission_handoff_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE smarter_private.hand_submission_dispatch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON smarter_private.hand_submission_failures,smarter_private.hand_submission_handoffs,
 smarter_private.hand_submission_handoff_results,smarter_private.hand_submission_dispatch
 FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER hand_submission_failure_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submission_failures FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_failure_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submission_failures FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_handoff_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submission_handoffs FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_handoff_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submission_handoffs FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_handoff_result_immutable BEFORE UPDATE OR DELETE ON smarter_private.hand_submission_handoff_results FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable();
CREATE TRIGGER hand_submission_handoff_result_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submission_handoff_results FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable();

CREATE OR REPLACE FUNCTION smarter_private.assert_retained_hand_submission(p_request jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $function$
DECLARE s smarter_private.hand_submissions; consumed integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||(p_request->>'p_table_id')||':'||(p_request->>'p_hand_number'),0));
 SELECT * INTO s FROM smarter_private.hand_submissions
 WHERE table_id=(p_request->>'p_table_id')::uuid AND hand_number=(p_request->>'p_hand_number')::bigint;
 IF NOT FOUND OR s.request IS NOT DISTINCT FROM p_request THEN RETURN; END IF;
 IF (s.request-'p_instance_id'-'p_lease_generation') IS NOT DISTINCT FROM
    (p_request-'p_instance_id'-'p_lease_generation') THEN
  DELETE FROM smarter_private.hand_submission_dispatch d WHERE d.transaction_id=txid_current()
   AND d.submission_id=s.submission_id AND d.request_hash=s.request_hash
   AND d.instance_id=p_request->>'p_instance_id'
   AND d.lease_generation=(p_request->>'p_lease_generation')::uuid;
  GET DIAGNOSTICS consumed=ROW_COUNT;
  IF consumed=1 THEN RETURN; END IF;
 END IF;
 RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_PAYLOAD_REQUIRED' USING ERRCODE='55000';
END $function$;
REVOKE ALL ON FUNCTION smarter_private.assert_retained_hand_submission(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION smarter_private.acknowledge_hand_submission(p_submission_id uuid,p_result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE s smarter_private.hand_submissions; completed integer;
BEGIN
 SELECT * INTO STRICT s FROM smarter_private.hand_submissions WHERE submission_id=p_submission_id;
 IF p_result->>'success' IS DISTINCT FROM 'true' OR p_result->>'atomic_hand_commit' IS DISTINCT FROM 'true'
 OR p_result->>'history_id' IS DISTINCT FROM s.submission_id::text
 OR p_result->>'post_commit_obligations' IS DISTINCT FROM 'true'
 OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=s.table_id AND a.hand_number=s.hand_number
   AND a.hand_id=s.submission_id AND a.payload_hash=p_result->>'commit_hash'
   AND a.post_commit_request_hash=encode(extensions.digest(convert_to((s.request->'p_post_commit_obligations')::text,'UTF8'),'sha256'),'hex')
   AND a.post_commit_payload IS NOT NULL AND a.post_commit_payload_hash=p_result->>'post_commit_payload_hash') THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000'; END IF;
 UPDATE public.hand_state_snapshots SET is_complete=true,updated_at=clock_timestamp()
 WHERE table_id=s.table_id AND hand_number=s.hand_number AND NOT is_complete;
 GET DIAGNOSTICS completed=ROW_COUNT;
 RETURN p_result||jsonb_build_object('submission_id',s.submission_id,'submission_hash',s.request_hash,
 'snapshot_completed',true,'snapshots_completed',completed);
END $function$;
REVOKE ALL ON FUNCTION smarter_private.acknowledge_hand_submission(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_submission(p_submission_id uuid,p_instance_id text,p_lease_generation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE s smarter_private.hand_submissions; r jsonb; q jsonb;
BEGIN
 SELECT * INTO s FROM smarter_private.hand_submissions WHERE submission_id=p_submission_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'HAND_SUBMISSION_NOT_RETAINED' USING ERRCODE='55000'; END IF;
 IF s.instance_id IS DISTINCT FROM p_instance_id OR s.lease_generation IS DISTINCT FROM p_lease_generation THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_OWNER_REQUIRED' USING ERRCODE='55000'; END IF;
 q:=s.request;
 r:=public.fn_ca_commit_hand_settlement(s.table_id,s.hand_number,q->'p_stacks',
 (q->>'p_rake')::numeric,(q->>'p_bbj')::numeric,q->>'p_ref',(q->>'p_inflow')::numeric,
 q->'p_hand_row',q->'p_units',s.instance_id,s.lease_generation,q->'p_post_commit_obligations');
 IF r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true' THEN
  IF r->>'success'='false' AND r->>'reason'='atomic_hand_rolled_back' AND length(r->>'sqlstate')=5 THEN
   INSERT INTO smarter_private.hand_submission_failures(submission_id,transaction_id,request_hash,result)
   VALUES(s.submission_id,txid_current(),s.request_hash,r) ON CONFLICT(submission_id) DO NOTHING;
  END IF;
  RETURN r;
 END IF;
 RETURN smarter_private.acknowledge_hand_submission(s.submission_id,r);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_submission(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_submission(uuid,text,uuid) TO service_role;

INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
 VALUES('fn_ca_resume_hand_submission','approved',
 'One exact failed-original handoff under the current lease, followed by repeatable accepted-receipt postcommit and original F06 finish.');
CREATE FUNCTION public.fn_ca_resume_hand_submission(p_table_id uuid,p_instance_id text,p_lease_generation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $function$
DECLARE s smarter_private.hand_submissions; h smarter_private.f06_hand_permits;
 a public.hand_atomic_commits; q jsonb; r jsonb; post jsonb; finished jsonb;
 tour uuid; locked_tour uuid; holder text; generation uuid; protocol integer; beat timestamptz;
 users uuid[]; code text; message text; claimed boolean:=false;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'HAND_SUBMISSION_ENGINE_ONLY' USING ERRCODE='42501'; END IF;
 SELECT j.* INTO s FROM smarter_private.hand_submissions j
 LEFT JOIN public.hand_atomic_commits c ON c.table_id=j.table_id AND c.hand_number=j.hand_number
 LEFT JOIN smarter_private.f06_hand_permits p ON p.table_id=j.table_id AND p.hand_number=j.hand_number
 WHERE j.table_id=p_table_id AND (c.hand_id IS DISTINCT FROM j.submission_id OR c.post_commit_completed_at IS NULL
   OR c.post_commit_result->>'ok' IS DISTINCT FROM 'true' OR p.state='reserved')
 ORDER BY j.hand_number LIMIT 1;
 IF NOT FOUND THEN RETURN jsonb_build_object('found',false); END IF;
 -- This is startup continuation, not an in-flight original settlement. Keep
 -- both financial handoff and accepted postcommit behind the existing freeze
 -- boundary, before any lease or lifecycle lane. Refusal spends no claim.
 IF NOT pg_try_advisory_xact_lock_shared(530090,1) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_MAINTENANCE_BUSY' USING ERRCODE='55P03'; END IF;
 IF public.fn_platform_frozen() THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 SELECT tournament_id INTO tour FROM public.tables WHERE id=p_table_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_MISSING' USING ERRCODE='55000'; END IF;
 IF tour IS NOT NULL THEN
  SELECT array_agg((x->>'user_id')::uuid ORDER BY x->>'user_id') INTO users FROM jsonb_array_elements(s.request->'p_stacks') x;
  PERFORM smarter_private.f06_prefix(tour,p_lease_generation,users,ARRAY[p_table_id]);
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,generation,protocol,beat
   FROM public.engine_tournament_leases WHERE tournament_id=tour FOR KEY SHARE;
 ELSE
  SELECT instance_id,lease_generation,protocol_version,heartbeat_at INTO holder,generation,protocol,beat
   FROM public.engine_table_leases WHERE table_id=p_table_id FOR KEY SHARE;
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
  PERFORM 1 FROM public.tables WHERE id=p_table_id FOR UPDATE;
  PERFORM 1 FROM public.table_seats WHERE table_id=p_table_id ORDER BY id FOR UPDATE;
 END IF;
 IF holder IS DISTINCT FROM p_instance_id OR generation IS DISTINCT FROM p_lease_generation OR protocol IS DISTINCT FROM 2
 OR beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
  RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
 SELECT tournament_id INTO locked_tour FROM public.tables WHERE id=p_table_id;
 IF locked_tour IS DISTINCT FROM tour THEN RAISE EXCEPTION 'HAND_SUBMISSION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('hand:submission:'||s.table_id::text||':'||s.hand_number::text,0));
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF tour IS NOT NULL THEN
  IF h.permit_id IS NULL OR h.tournament_id IS DISTINCT FROM tour OR h.generation IS DISTINCT FROM s.lease_generation
   OR h.state NOT IN('reserved','accepted') THEN RAISE EXCEPTION 'HAND_SUBMISSION_ORIGINAL_PERMIT_REQUIRED' USING ERRCODE='55000'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
   RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number=s.hand_number;
 IF FOUND THEN
  IF a.hand_id IS DISTINCT FROM s.submission_id OR a.post_commit_payload IS NULL THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_ACCEPTANCE_UNPROVEN' USING ERRCODE='55000'; END IF;
  r:=a.stack_result||jsonb_build_object('success',true,'atomic_hand_commit',true,'history_id',a.hand_id,
    'commit_hash',a.payload_hash,'post_commit_obligations',true,'post_commit_payload_hash',a.post_commit_payload_hash);
 ELSE
  IF EXISTS(SELECT 1 FROM smarter_private.hand_submission_handoffs WHERE submission_id=s.submission_id) THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','successor_financial_claim_spent'); END IF;
  IF s.lease_generation=p_lease_generation OR NOT EXISTS(SELECT 1 FROM smarter_private.hand_submission_failures f
   WHERE f.submission_id=s.submission_id AND f.request_hash=s.request_hash) THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','original_failure_or_handoff_unproven'); END IF;
  -- The original exact generations and before-stacks must still occupy the
  -- whole table. No later hand/permit may have consumed this starting state.
  q:=s.request;
  IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=s.table_id
      AND NOT COALESCE(is_deleted,false) AND lifecycle='live' AND lower(status) IN ('waiting','running'))
   OR (tour IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=tour AND upper(status)='RUNNING')) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_TABLE_NOT_ADMITTED' USING ERRCODE='55000'; END IF;
  IF jsonb_array_length(q->'p_stacks')=0 OR
   (SELECT count(*) FROM public.table_seats WHERE table_id=s.table_id AND left_at IS NULL)<>jsonb_array_length(q->'p_stacks')
   OR (SELECT count(DISTINCT x->>'seat_id') FROM jsonb_array_elements(q->'p_stacks') x)<>jsonb_array_length(q->'p_stacks')
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(q->'p_stacks') x WHERE NOT EXISTS(
     SELECT 1 FROM public.table_seats seat WHERE seat.table_id=s.table_id AND seat.id=(x->>'seat_id')::uuid
       AND seat.user_id=(x->>'user_id')::uuid AND seat.joined_at=(x->>'seat_joined_at')::timestamptz
       AND seat.left_at IS NULL AND seat.stack=(x->>'stack_before')::numeric))
   OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=s.table_id AND hand_number>=s.hand_number)
   OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=s.table_id AND hand_number>=s.hand_number)
   OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=s.table_id AND hand_number>s.hand_number) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_HANDOFF_STATE_CHANGED' USING ERRCODE='55000'; END IF;
  -- A wait for another lane may outlast the heartbeat or cross the existing
  -- announced freeze clock. Recheck immediately before the irreversible claim.
  IF public.fn_platform_frozen() THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
  IF tour IS NULL THEN
   SELECT heartbeat_at INTO beat FROM public.engine_table_leases WHERE table_id=s.table_id;
  ELSE
   SELECT heartbeat_at INTO beat FROM public.engine_tournament_leases WHERE tournament_id=tour;
  END IF;
  IF beat IS NULL OR beat<clock_timestamp()-make_interval(secs=>public.fn_engine_lease_stale_seconds()) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_LEASE_UNPROVEN' USING ERRCODE='55000'; END IF;
  INSERT INTO smarter_private.hand_submission_handoffs(submission_id,original_generation,instance_id,lease_generation,request_hash,transaction_id)
   VALUES(s.submission_id,s.lease_generation,p_instance_id,p_lease_generation,s.request_hash,txid_current());
  claimed:=true;
  BEGIN
   INSERT INTO smarter_private.hand_submission_dispatch VALUES(txid_current(),s.submission_id,s.request_hash,p_instance_id,p_lease_generation);
   r:=public.fn_ca_commit_hand_settlement(s.table_id,s.hand_number,q->'p_stacks',
    (q->>'p_rake')::numeric,(q->>'p_bbj')::numeric,q->>'p_ref',(q->>'p_inflow')::numeric,
    q->'p_hand_row',q->'p_units',p_instance_id,p_lease_generation,q->'p_post_commit_obligations');
  EXCEPTION WHEN OTHERS THEN
   GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
   r:=jsonb_build_object('success',false,'atomic_hand_commit',false,'reason','successor_authority_refused','sqlstate',code,'error',message);
  END;
  -- A lock/freeze/lease admission refusal is not the one financial attempt.
  -- Raise outside the caught subtransaction so its claim also rolls back.
  IF r->>'success' IS DISTINCT FROM 'true' AND (
    r->>'sqlstate' IN ('55P03','40001','40P01')
    OR r->>'reason' IN ('hand_lease_lost','hand_lease_stale','hand_lease_scope_changed','invalid_hand_lease_authority')
    OR (r->>'sqlstate'='42501' AND r->>'error'='F06_LEASE_FENCED')
    OR public.fn_platform_frozen()) THEN
   RAISE EXCEPTION 'HAND_SUBMISSION_ADMISSION_CHANGED: %',r USING ERRCODE='40001';
  END IF;
  DELETE FROM smarter_private.hand_submission_dispatch WHERE transaction_id=txid_current() AND submission_id=s.submission_id;
  INSERT INTO smarter_private.hand_submission_handoff_results VALUES(s.submission_id,r);
  IF r->>'success' IS DISTINCT FROM 'true' OR r->>'atomic_hand_commit' IS DISTINCT FROM 'true' THEN
   RETURN jsonb_build_object('found',true,'completed',false,'submission_id',s.submission_id,'reason','successor_financial_refused','outcome',r); END IF;
 END IF;
 r:=smarter_private.acknowledge_hand_submission(s.submission_id,r);
 -- A later current owner may replay this branch after acknowledgment loss.
 -- It never spends or recreates the one-time financial claim.
 BEGIN
  post:=public.fn_ca_process_hand_post_commit_obligations(s.submission_id);
  IF post->>'ok' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits
    WHERE table_id=s.table_id AND hand_number=s.hand_number AND hand_id=s.submission_id
    AND post_commit_completed_at IS NOT NULL AND post_commit_result->>'ok'='true') THEN
   RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending'); END IF;
  IF tour IS NOT NULL THEN
   finished:=public.fn_f06_finish_hand(tour,p_lease_generation,h.permit_id,'accepted',s.submission_id);
   IF finished->>'ok' IS DISTINCT FROM 'true' OR finished->>'state' IS DISTINCT FROM 'accepted'
    OR finished->>'evidence_id' IS DISTINCT FROM s.submission_id::text THEN
    RAISE EXCEPTION 'HAND_SUBMISSION_PERMIT_COMPLETION_UNPROVEN' USING ERRCODE='55000'; END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
  RETURN r||jsonb_build_object('found',true,'completed',false,'reason','accepted_postcommit_pending','sqlstate',code,'error',message);
 END;
 RETURN r||jsonb_build_object('found',true,'completed',true,'hand_number',s.hand_number::text,
   'financial_handoff',claimed,'permit_id',h.permit_id,'post_commit_completed',true);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_resume_hand_submission(uuid,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb, p_instance_id text, p_lease_generation uuid, p_post_commit_obligations jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_diamond boolean := false;
  v_hand_id uuid;
  v_request_hash text;
  v_hash text;
  v_existing_request_hash text;
  v_existing_hash text;
  v_payload jsonb;
  v_club_id uuid;
  v_tournament_id uuid;
  v_item jsonb;
  v_expected integer;
  v_updated integer;
  v_row_count integer;
  v_exact_seat_generation boolean := false;
BEGIN
  -- This public 12-argument door is the outermost accepted-hand authority.
  -- Take the lifecycle root before its preserved exact-generation core can
  -- lock a lease, tournament or table. The owner-only nine-argument core
  -- re-enters this shared transaction lock defensively; that acquisition is
  -- harmless and keeps the private core safe from future owner-only callers.
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM smarter_private.assert_retained_hand_submission(jsonb_build_object('p_table_id',p_table_id,'p_hand_number',p_hand_number,'p_stacks',p_stacks,'p_rake',p_rake,'p_bbj',p_bbj,'p_ref',p_ref,'p_inflow',p_inflow,'p_hand_row',p_hand_row,'p_units',p_units,'p_instance_id',p_instance_id,'p_lease_generation',p_lease_generation,'p_post_commit_obligations',p_post_commit_obligations));
  PERFORM smarter_private.f06_hand_dispatch_guard(p_table_id,p_hand_number);

  IF jsonb_typeof(p_post_commit_obligations) IS DISTINCT FROM 'object'
     OR p_post_commit_obligations->>'version' <> '1'
     OR jsonb_typeof(p_post_commit_obligations->'time_banks') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'promo_playthrough') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'insurance') IS DISTINCT FROM 'array'
     OR NOT (p_post_commit_obligations ? 'pending_addons')
     OR NOT (p_post_commit_obligations ? 'rake')
     OR NOT (p_post_commit_obligations ? 'bbj_contribution')
     OR p_post_commit_obligations ? 'accepted_hand_facts'
     OR jsonb_typeof(p_post_commit_obligations->'rake') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'pending_addons') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_obligations)';
  END IF;

  -- Database-first expansion. The previous engine may send an entirely legacy
  -- roster while it drains, but exact and legacy identities never mix.
  IF jsonb_typeof(p_stacks) = 'array' AND jsonb_array_length(p_stacks) > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_stacks) x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_stack_seat_generation)';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'seat_id')
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'seat_id')) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (mixed_stack_seat_generation_protocol)';
    END IF;
    SELECT COALESCE(bool_and(x ? 'seat_id' AND x ? 'seat_joined_at'), false)
      INTO v_exact_seat_generation
      FROM jsonb_array_elements(p_stacks) x;

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
          OR (x ? 'seat_id') IS DISTINCT FROM v_exact_seat_generation
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_time_bank_seat_generation)';
    END IF;

    IF v_exact_seat_generation AND EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_stacks) s
          WHERE s->>'user_id' = x->>'user_id'
            AND s->>'seat_id' = x->>'seat_id'
            AND (s->>'seat_joined_at')::timestamptz =
                (x->>'seat_joined_at')::timestamptz
       )
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_generation_mismatch)';
    END IF;
  END IF;

  IF jsonb_typeof(p_hand_row->'_accepted_post_commit_facts') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'pot_size') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_hand_row->'big_blind') IS DISTINCT FROM 'number'
     OR COALESCE(p_rake, 0) < 0
     OR COALESCE(p_bbj, 0) < 0
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'contributions')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'insurance')
          IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'contributions') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     )
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_accepted_post_commit_facts)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'uses_remaining') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'seconds_remaining') IS DISTINCT FROM 'number'
        OR (x->>'uses_remaining') !~ '^[0-9]+$'
        OR (x->>'seconds_remaining') !~ '^[0-9]+$'
        OR CASE WHEN (x->>'uses_remaining') ~ '^[0-9]+$'
                THEN (x->>'uses_remaining')::numeric > 2147483647 ELSE false END
        OR CASE WHEN (x->>'seconds_remaining') ~ '^[0-9]+$'
                THEN (x->>'seconds_remaining')::numeric > 2147483647 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'wagered') IS DISTINCT FROM 'number'
        OR CASE WHEN jsonb_typeof(x->'wagered') = 'number'
                THEN (x->>'wagered')::numeric <= 0 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'player_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'equity_percent') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'premium') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'insured_amount') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'payout') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'player_won') IS DISTINCT FROM 'boolean'
        OR COALESCE(x->>'kind', '') NOT IN ('insurance', 'ev_cashout')
        OR CASE WHEN jsonb_typeof(x->'equity_percent') = 'number'
                THEN (x->>'equity_percent')::numeric NOT BETWEEN 0 AND 100 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'premium') = 'number'
                THEN (x->>'premium')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'insured_amount') = 'number'
                THEN (x->>'insured_amount')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'payout') = 'number'
                THEN (x->>'payout')::numeric < 0 ELSE false END
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_item)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake'->'amount') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'bbj') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'pot') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'num_players') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'contributions') IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'returned_uncalled') IS DISTINCT FROM 'object'
       OR (p_post_commit_obligations->'rake'->>'num_players') !~ '^[0-9]+$'
       OR COALESCE((p_post_commit_obligations->'rake'->>'amount')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'bbj')::numeric, 0) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'pot')::numeric, -1) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0)
            > 2147483647
       OR (p_post_commit_obligations->'rake'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_rake)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'amount')
         IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'big_blind')
         IS DISTINCT FROM 'number'
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric, 0)
            <= 0
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric, 0)
            <= 0
       OR (p_post_commit_obligations->'bbj_contribution'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_bbj)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled')
         IS DISTINCT FROM 'boolean'
       OR CASE
            WHEN jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled') = 'boolean'
            THEN COALESCE(
              (p_post_commit_obligations->'pending_addons'->>'enabled')::boolean,
              false
            ) IS NOT TRUE
            ELSE false
          END
       OR jsonb_typeof(p_post_commit_obligations->'pending_addons'->'max_buy_in')
            IS DISTINCT FROM 'number'
       OR COALESCE(
            (p_post_commit_obligations->'pending_addons'->>'max_buy_in')::numeric,
            0
          ) <= 0
       OR p_post_commit_obligations->'pending_addons' ? 'ids'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_addons)';
  END IF;

  IF p_hand_number > 2147483647
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
       OR jsonb_array_length(p_post_commit_obligations->'insurance') > 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_hand_number_out_of_range)';
  END IF;

  -- DIAMOND PHASE 8: the Diamond cash rules below are cash rules; a Diamond
  -- tournament hand carries a tournament rake scope and no add-on lane, and
  -- is judged by the tournament rules exactly as a chip tournament hand is.
  SELECT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
    WHERE t.id=p_table_id AND c.asset='diamonds' AND t.tournament_id IS NULL) INTO v_diamond;
  IF v_diamond AND (
    jsonb_array_length(p_post_commit_obligations->'promo_playthrough')<>0
    OR jsonb_array_length(p_post_commit_obligations->'insurance')<>0
    OR jsonb_typeof(p_post_commit_obligations->'rake') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_post_commit_obligations->'pending_addons') IS DISTINCT FROM 'null'
    OR p_hand_row->>'game_variant' IS DISTINCT FROM 'nlh'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_units,'[]'::jsonb)) u
      WHERE (u->>'amount') IS NULL
         OR (u->>'amount')::numeric<>trunc((u->>'amount')::numeric))
    OR COALESCE(NULLIF(p_hand_row->'daily_mission_events','null'::jsonb),'[]'::jsonb)<>'[]'::jsonb
    OR (p_hand_row->>'pot_size')::numeric<>trunc((p_hand_row->>'pot_size')::numeric)
    OR EXISTS(SELECT 1 FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'contributions') e
      WHERE (e.value::text)::numeric<>trunc((e.value::text)::numeric))
    OR EXISTS(SELECT 1 FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled') e
      WHERE (e.value::text)::numeric<>trunc((e.value::text)::numeric))
  ) THEN
    RAISE EXCEPTION 'atomic hand commit refused (diamond_chip_obligation_or_fractional_fact)';
  END IF;

  v_request_hash := encode(
    extensions.digest(convert_to(p_post_commit_obligations::text, 'UTF8'), 'sha256'),
    'hex'
  );

  /* ONE SEAT WRITE PER HAND (2026-09-10). The time-bank items above are
     already proven well formed and bound to the exact stack roster. Publish
     them for this exact table+hand in a transaction-local setting so the
     stack core (fn_ca_settle_hand_stacks_absolute) can carry the two
     time-bank columns on its stack write instead of this door writing every
     seat row a second time. The setting is cleared as soon as the core
     returns; a stale value can only name a hand the core refuses as a
     replay. The loop below still proves the resulting seat state before it
     counts it, and still writes any seat the core did not carry. */
  PERFORM set_config(
    'app.ca_hand_time_banks',
    jsonb_build_object(
      'table_id', p_table_id,
      'hand_number', p_hand_number,
      'exact', v_exact_seat_generation,
      'items', p_post_commit_obligations->'time_banks'
    )::text,
    true
  );

  /* The owner-only exact-generation core locks and proves the cash-table or
     tournament generation, then runs the unchanged accepted-hand core. Its
     lease/table locks remain held until this outer transaction commits. */
  v_result := public.fn_ca_commit_hand_settlement_exact_before_obligations(
    p_table_id,
    p_hand_number,
    p_stacks,
    p_rake,
    p_bbj,
    p_ref,
    p_inflow,
    p_hand_row,
    p_units,
    p_instance_id,
    p_lease_generation
  );
  PERFORM set_config('app.ca_hand_time_banks', '', true);

  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'atomic_hand_commit')::boolean, false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  BEGIN
    v_hand_id := (v_result->>'history_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_history_receipt)';
  END;
  IF v_hand_id IS NULL THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_history_receipt)';
  END IF;

  SELECT t.club_id, t.tournament_id
    INTO v_club_id, v_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND OR v_club_id IS NULL THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_table_scope_missing)';
  END IF;

  /* The envelope cannot contradict the accepted hand. Amounts bind to the
     settlement arguments; every per-player item binds to its authoritative
     stack roster; every money item binds to the table's club. */
  IF (COALESCE(p_rake, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'rake') = 'object')
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'amount')::numeric
             IS DISTINCT FROM p_rake
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'bbj')::numeric
             IS DISTINCT FROM COALESCE(p_bbj, 0)
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'pot')::numeric
             IS DISTINCT FROM (p_hand_row->>'pot_size')::numeric
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'num_players')::integer
             IS DISTINCT FROM (
               SELECT count(*)::integer
                 FROM jsonb_object_keys(
                   p_hand_row->'_accepted_post_commit_facts'->'contributions'
                 )
             )
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'contributions'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'contributions'
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'returned_uncalled'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
     )
     OR (COALESCE(p_bbj, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object')
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric
             IS DISTINCT FROM p_bbj
     )
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric
             IS DISTINCT FROM (p_hand_row->>'big_blind')::numeric
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_fee_mismatch)';
  END IF;

  IF p_post_commit_obligations->'insurance' IS DISTINCT FROM
       p_hand_row->'_accepted_post_commit_facts'->'insurance' THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_insurance_fact_mismatch)';
  END IF;

  IF (
       v_tournament_id IS NULL AND NOT v_diamond
       AND (
         jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
           IS DISTINCT FROM (
             SELECT count(*)::integer
               FROM jsonb_each(
                 p_hand_row->'_accepted_post_commit_facts'->'contributions'
               ) e
              WHERE (e.value::text)::numeric > 0
           )
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
            WHERE (x->>'wagered')::numeric IS DISTINCT FROM
                  (
                    p_hand_row->'_accepted_post_commit_facts'->'contributions'->>
                    (x->>'user_id')
                  )::numeric
         )
       )
     ) OR (
       (v_tournament_id IS NOT NULL OR v_diamond)
       AND jsonb_array_length(p_post_commit_obligations->'promo_playthrough') <> 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_promo_fact_mismatch)';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
        WHERE s->>'user_id' = x->>'user_id'
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'contributions'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'user_id'
        )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'player_id'
        )
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_player_or_club_mismatch)';
  END IF;

  /* Repeated recipients would turn one accepted-hand fact into two additive
     mutations. Time-bank rows are exhaustive because omitting one would make
     the accepted seat state depend on whichever process ran before this one. */
  IF jsonb_array_length(p_post_commit_obligations->'time_banks')
       IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     ) IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
     OR (
       /* The durable insurance writer is unique per table/hand/player. Two
          different kinds for one player would look like two obligations here
          but collapse to one receipt downstream. Refuse that ambiguity. */
       SELECT count(DISTINCT x->>'player_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'insurance') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_duplicate_or_missing_recipient)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'contributions', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'returned_uncalled', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_rake_recipient_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND p_post_commit_obligations->'rake'->>'club_id' IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND p_post_commit_obligations->'bbj_contribution'->>'club_id'
           IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_bbj_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       COALESCE(p_post_commit_obligations->'rake'->>'tournament_id', '')
         IS DISTINCT FROM COALESCE(v_tournament_id::text, '')
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_scope_mismatch)';
  END IF;
  IF (v_tournament_id IS NULL AND NOT v_diamond) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object') THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_addon_scope_mismatch)';
  END IF;

  SELECT c.post_commit_request_hash, c.post_commit_payload_hash
    INTO v_existing_request_hash, v_existing_hash
    FROM public.hand_atomic_commits c
   WHERE c.table_id = p_table_id
     AND c.hand_number = p_hand_number
     AND c.hand_id = v_hand_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_atomic_receipt)';
  END IF;
  IF v_existing_request_hash IS NOT NULL
     AND v_existing_request_hash IS DISTINCT FROM v_request_hash THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_payload_conflict)';
  END IF;

  IF v_existing_request_hash IS NULL THEN
    /* A rolling 11-argument engine may already have committed this hand and
       run its legacy post-commit steps. Never attach a new additive envelope
       to that receipt. A response-loss replay from this 12-argument door
       always finds the request hash written by its first transaction. */
    IF COALESCE((v_result->>'replay')::boolean, false) IS TRUE THEN
      RAISE EXCEPTION
        'atomic hand commit refused (legacy_receipt_has_no_post_commit_envelope)';
    END IF;

    /* Copy the independently accepted facts into the immutable stored envelope.
       The caller is forbidden from supplying this key itself. Besides the core
       hand hash, the durable processor/audit row can therefore show exactly
       which first-narrative facts every derived obligation was checked against. */
    v_payload := jsonb_set(
      p_post_commit_obligations,
      '{accepted_hand_facts}',
      p_hand_row->'_accepted_post_commit_facts',
      true
    );
    IF jsonb_typeof(v_payload->'pending_addons') = 'object' THEN
      /* Own the exact eligible rows through commit. A legacy/manual resolver
         cannot consume one after it was frozen but before the obligation
         transaction gets its causal wake. */
      PERFORM 1
        FROM public.table_pending_addons a
       WHERE a.table_id = p_table_id
         AND a.resolved_at IS NULL
         AND a.created_at <= transaction_timestamp()
       ORDER BY a.created_at, a.id
       FOR UPDATE;
      v_payload := jsonb_set(
        v_payload,
        '{pending_addons,ids}',
        COALESCE((
          SELECT jsonb_agg(a.id ORDER BY a.created_at, a.id)
            FROM public.table_pending_addons a
           WHERE a.table_id = p_table_id
             AND a.resolved_at IS NULL
             AND a.created_at <= transaction_timestamp()
        ), '[]'::jsonb),
        true
      );
    END IF;
    v_hash := encode(
      extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
      'hex'
    );

    /* Time-bank state belongs to the accepted-hand boundary itself. Apply it
       while the exact lease/table/seat locks inherited from the owner-only
       exact-generation core are still held, never later from a stale envelope. */
    v_expected := jsonb_array_length(v_payload->'time_banks');
    v_updated := 0;
    FOR v_item IN
      SELECT value FROM jsonb_array_elements(v_payload->'time_banks')
       ORDER BY value->>'user_id'
    LOOP
      IF (v_item->>'user_id') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR (v_item->>'uses_remaining') !~ '^[0-9]+$'
         OR (v_item->>'seconds_remaining') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION
          'atomic hand commit refused (invalid_time_bank_obligation)';
      END IF;
      /* ONE SEAT WRITE PER HAND (2026-09-10). The stack core carried these
         two columns on its stack write from the envelope published above.
         Prove that exact state on the exact row first (the same predicate
         the lawful-noop rule below has always used) and count it without a
         second write. Only a seat the core did not carry - a cash seat that
         left during the hand is settled against its wallet and gets no stack
         write - takes the UPDATE, exactly as before. */
      SELECT count(*)::integer INTO v_row_count
        FROM public.table_seats s
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
         AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );
      IF v_row_count = 0 THEN
      UPDATE public.table_seats s
         SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
             time_bank_remaining = (v_item->>'seconds_remaining')::integer
       WHERE s.table_id = p_table_id
         AND s.user_id = (v_item->>'user_id')::uuid
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      /* Preserve the stack writer's lawful-noop rule. If a redundant-update
         suppressor is installed, ROW_COUNT may be zero even though the exact
         row already stores the requested state. Prove that exact state before
         counting it; a missing or replaced generation still refuses whole. */
      IF v_row_count = 0 AND EXISTS (
        SELECT 1
          FROM public.table_seats s
         WHERE s.table_id = p_table_id
           AND s.user_id = (v_item->>'user_id')::uuid
           AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
           AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
           AND (
             (v_exact_seat_generation
               AND s.id = (v_item->>'seat_id')::uuid
               AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
             OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
           )
      ) THEN
        v_row_count := 1;
      END IF;
      END IF;
      v_updated := v_updated + v_row_count;
    END LOOP;
    IF v_updated IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_mismatch)';
    END IF;

    UPDATE public.hand_atomic_commits c
       SET post_commit_payload = v_payload,
           post_commit_request_hash = v_request_hash,
           post_commit_payload_hash = v_hash
     WHERE c.table_id = p_table_id
       AND c.hand_number = p_hand_number
       AND c.hand_id = v_hand_id
       AND c.post_commit_request_hash IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_receipt_raced)';
    END IF;
  ELSE
    v_hash := v_existing_hash;
    IF v_hash IS NULL THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_payload_hash_missing)';
    END IF;
  END IF;

  RETURN v_result || jsonb_build_object(
    'post_commit_obligations', true,
    'post_commit_payload_hash', v_hash
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) TO service_role;
COMMIT;
