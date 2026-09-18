-- Earlier recorded final stack receipts remain locked, unchanged and distinct from canonical outcomes.
-- Snapshot absence is not no-start: retain exact original cards, returned refusal and ended dispatch.
-- The original canonical financial boundary, full roster and both writer-generation fences remain required.
-- No data or money changes on install; the existing disposition remains zero-credit aborted_unsettled.
-- Additive completed-but-unaccepted MTT snapshot boundary. No data or money changes on install.
-- Exact paid custody, original snapshot, private-card hashes and financial receipts remain immutable.
-- Only the existing mixed disposition changes; original/current writer fences are preserved.
-- The interrupted Spin hand keeps the last canonical committed stacks.
-- Completed snapshots and actual refusal records remain intact and are bound
-- into the immutable zero-credit disposition. They never establish no-start.
-- Only the existing mixed RPC changes. No data, money, lease or snapshot is
-- changed by installation. Version reserved by scripts/new-migration.mjs.
-- money-trigger-ok: table_seats.a00_f06_source_seat because its CREATE TRIGGER text is an exact unchanged catalog assertion only.
-- money-trigger-ok: tournament_players.a00_f06_source_roster because its CREATE TRIGGER text is an exact unchanged catalog assertion only.
-- money-trigger-ok: table_seats.zzz_stamp_seat_occupancy because its CREATE TRIGGER text is an exact unchanged catalog assertion only.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
SET LOCAL search_path=pg_catalog,public;
-- Exact G8 20260918130650 contract; online index build remains separately owned.
DO $index_contract$
DECLARE target oid:=to_regclass('public.hand_state_snapshots');
        candidate oid:=to_regclass('public.idx_hand_state_snapshots_table_hand');
BEGIN
 IF candidate IS NULL THEN
  RAISE EXCEPTION 'HAND_SNAPSHOT_INDEX_MISSING_BUILD_ONLINE' USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM pg_index i JOIN pg_class ix ON ix.oid=i.indexrelid
  JOIN pg_class tab ON tab.oid=i.indrelid JOIN pg_am am ON am.oid=ix.relam
  JOIN pg_attribute t ON t.attrelid=tab.oid AND t.attname='table_id' AND NOT t.attisdropped
  JOIN pg_attribute h ON h.attrelid=tab.oid AND h.attname='hand_number' AND NOT h.attisdropped
  WHERE i.indexrelid=candidate AND i.indrelid=target
   AND ix.relkind='i' AND tab.relkind='r' AND am.amname='btree'
   AND pg_get_userbyid(ix.relowner)='postgres' AND pg_get_userbyid(tab.relowner)='postgres'
   AND i.indisvalid AND i.indisready AND i.indislive
   AND NOT i.indisunique AND NOT i.indisprimary AND NOT i.indisexclusion
   AND i.indnkeyatts=2 AND i.indnatts=2
   AND i.indkey::text=t.attnum::text||' '||h.attnum::text
   AND t.atttypid='uuid'::regtype AND h.atttypid='integer'::regtype
   AND i.indpred IS NULL AND i.indexprs IS NULL
   AND i.indoption::text='0 0' AND i.indcollation::text='0 0'
   AND i.indclass[0]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='uuid_ops' AND opcmethod=ix.relam)
   AND i.indclass[1]=(SELECT oid FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='int4_ops' AND opcmethod=ix.relam)
 ) THEN
  RAISE EXCEPTION 'HAND_SNAPSHOT_INDEX_CONTRACT_CHANGED' USING ERRCODE='55000';
 END IF;
END $index_contract$;

DO $preimages$
BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)') AND md5(pg_get_functiondef(oid))='4415d0e65aec71ecff0e0db366364ecb' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_prior_committed_stacks(uuid,jsonb,jsonb)') AND md5(pg_get_functiondef(oid))='4f914e43de444919d99229775a2ac2e5' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','smarter_private.f06_prior_committed_stacks(uuid,jsonb,jsonb)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_generation_aborted(uuid,uuid)') AND md5(pg_get_functiondef(oid))='3530559a94372866bf3baec006a8fd3c' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','smarter_private.f06_generation_aborted(uuid,uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_aborted_hand_guard()') AND md5(pg_get_functiondef(oid))='56c232740eb495dd2e2164159dfe782c' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','smarter_private.f06_aborted_hand_guard()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_immutable_identity()') AND md5(pg_get_functiondef(oid))='0fe40a0711ef6d196c6883d3b9e8b86f' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','smarter_private.f06_immutable_identity()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_source_guard()') AND md5(pg_get_functiondef(oid))='de1b25f96d2c08bf20213c0e194ae261' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','smarter_private.f06_source_guard()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_try_lane(uuid)') AND md5(pg_get_functiondef(oid))='78a3a191b9991b0a3a343db39de335aa' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','smarter_private.f06_try_lane(uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_stamp_seat_occupancy()') AND md5(pg_get_functiondef(oid))='4d2645a24bd3b88d7ffc51097b37d640' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','public.fn_stamp_seat_occupancy()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_cancelled_preparation_writer_guard()') AND md5(pg_get_functiondef(oid))='a7467e2cb64bab202a359eed42432299' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','smarter_private.f06_cancelled_preparation_writer_guard()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_no_start_continuation_immutable()') AND md5(pg_get_functiondef(oid))='2c87da2a00030dcc36ecb62bf51b2a89' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','smarter_private.f06_no_start_continuation_immutable()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_accept_hand()') AND md5(pg_get_functiondef(oid))='6a0ab2a61b4fb7f741a423b8a0a99353' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','smarter_private.f06_accept_hand()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('smarter_private.f06_hand_dispatch_guard(uuid,bigint)') AND md5(pg_get_functiondef(oid))='fa3b6cc670788a490c42f324ecf74a76' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','smarter_private.f06_hand_dispatch_guard(uuid,bigint)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)') AND md5(pg_get_functiondef(oid))='b49192e78f472d7a931bcf20de46a702' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','public.fn_ca_commit_hand_settlement_before_lease_generation(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)') AND md5(pg_get_functiondef(oid))='c555fb7b83c889312995bc0038c1b275' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','public.fn_ca_commit_hand_settlement_exact_before_obligations(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_engine_lease_stale_seconds()') AND md5(pg_get_functiondef(oid))='483a7e0ee940744fd557f1f2144d9eba' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_SPIN_PRIOR_AUTHORITY_CHANGED: %','public.fn_engine_lease_stale_seconds()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('smarter_private.hand_submission_immutable()') AND md5(p.prosrc)='4d8069ee5da05825cf4beb3d36bd8ef2' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog"]'::jsonb AND l.lanname='plpgsql' AND p.prosecdef AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f' AND p.pronargdefaults=0 AND p.prorettype='trigger'::regtype) THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_AUTHORITY_CHANGED: %','smarter_private.hand_submission_immutable()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('smarter_private.f06_retained_submission_guard()') AND md5(p.prosrc)='3ada0d8599460649be4fe90e7c338e84' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog"]'::jsonb AND l.lanname='plpgsql' AND p.prosecdef AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f' AND p.pronargdefaults=0 AND p.prorettype='trigger'::regtype) THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_AUTHORITY_CHANGED: %','smarter_private.f06_retained_submission_guard()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('smarter_private.hand_submission_snapshot_guard()') AND md5(p.prosrc)='02f37342e61d71aeee2cd67ce701d678' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog"]'::jsonb AND l.lanname='plpgsql' AND p.prosecdef AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f' AND p.pronargdefaults=0 AND p.prorettype='trigger'::regtype) THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_AUTHORITY_CHANGED: %','smarter_private.hand_submission_snapshot_guard()'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('smarter_private.assert_retained_hand_submission(jsonb)') AND md5(p.prosrc)='1bd5f0f6fc7070e073478bdab317e249' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog"]'::jsonb AND l.lanname='plpgsql' AND p.prosecdef AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f' AND p.pronargdefaults=0 AND p.prorettype='void'::regtype) THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_AUTHORITY_CHANGED: %','smarter_private.assert_retained_hand_submission(jsonb)'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure('public.fn_ca_retain_hand_submission(jsonb)') AND md5(p.prosrc)='965d4ac44f53b51e72d3df8ef5584b4b' AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND to_jsonb(p.proconfig)='["search_path=pg_catalog, public, extensions"]'::jsonb AND l.lanname='plpgsql' AND p.prosecdef AND NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset AND p.provolatile='v' AND p.proparallel='u' AND p.prokind='f' AND p.pronargdefaults=0 AND p.prorettype='jsonb'::regtype) THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_AUTHORITY_CHANGED: %','public.fn_ca_retain_hand_submission(jsonb)'; END IF;
 IF md5(pg_get_functiondef('smarter_private.assert_retained_hand_submission(jsonb)'::regprocedure)) IS DISTINCT FROM '6a3ab631fdab87ae9bcd353907de80b6' THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_AUTHORITY_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.hand_submissions'::regclass AND tgname='hand_submission_immutable' AND tgenabled='O' AND tgfoid=to_regprocedure('smarter_private.hand_submission_immutable()') AND pg_get_triggerdef(oid)='CREATE TRIGGER hand_submission_immutable BEFORE DELETE OR UPDATE ON smarter_private.hand_submissions FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable()') THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_BINDING_CHANGED: %','hand_submission_immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.hand_submission_dispositions'::regclass AND tgname='hand_submission_disposition_immutable' AND tgenabled='O' AND tgfoid=to_regprocedure('smarter_private.hand_submission_immutable()') AND pg_get_triggerdef(oid)='CREATE TRIGGER hand_submission_disposition_immutable BEFORE DELETE OR UPDATE ON smarter_private.hand_submission_dispositions FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_immutable()') THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_BINDING_CHANGED: %','hand_submission_disposition_immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.hand_submissions'::regclass AND tgname='hand_submission_no_truncate' AND tgenabled='O' AND tgfoid=to_regprocedure('smarter_private.hand_submission_immutable()') AND pg_get_triggerdef(oid)='CREATE TRIGGER hand_submission_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submissions FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable()') THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_BINDING_CHANGED: %','hand_submission_no_truncate'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.hand_submission_dispositions'::regclass AND tgname='hand_submission_disposition_no_truncate' AND tgenabled='O' AND tgfoid=to_regprocedure('smarter_private.hand_submission_immutable()') AND pg_get_triggerdef(oid)='CREATE TRIGGER hand_submission_disposition_no_truncate BEFORE TRUNCATE ON smarter_private.hand_submission_dispositions FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.hand_submission_immutable()') THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_BINDING_CHANGED: %','hand_submission_disposition_no_truncate'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_hand_permits'::regclass AND tgname='f06_retained_submission_guard' AND tgenabled='O' AND tgfoid=to_regprocedure('smarter_private.f06_retained_submission_guard()') AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_retained_submission_guard AFTER UPDATE OF state ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_retained_submission_guard()') THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_BINDING_CHANGED: %','f06_retained_submission_guard'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.hand_state_snapshots'::regclass AND tgname='hand_submission_snapshot_guard' AND tgenabled='O' AND tgfoid=to_regprocedure('smarter_private.hand_submission_snapshot_guard()') AND pg_get_triggerdef(oid)='CREATE TRIGGER hand_submission_snapshot_guard AFTER INSERT OR UPDATE OF is_complete ON public.hand_state_snapshots FOR EACH ROW EXECUTE FUNCTION smarter_private.hand_submission_snapshot_guard()') THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_BINDING_CHANGED: %','hand_submission_snapshot_guard'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_no_start_continuations'::regclass AND tgname='f06_no_start_continuation_immutable' AND tgenabled='O' AND tgfoid=to_regprocedure('smarter_private.f06_no_start_continuation_immutable()') AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_no_start_continuation_immutable BEFORE DELETE OR UPDATE ON smarter_private.f06_no_start_continuations FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_no_start_continuation_immutable()') THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_BINDING_CHANGED: %','f06_no_start_continuation_immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.f06_no_start_continuations'::regclass AND tgname='f06_no_start_continuation_no_truncate' AND tgenabled='O' AND tgfoid=to_regprocedure('smarter_private.f06_no_start_continuation_immutable()') AND pg_get_triggerdef(oid)='CREATE TRIGGER f06_no_start_continuation_no_truncate BEFORE TRUNCATE ON smarter_private.f06_no_start_continuations FOR EACH STATEMENT EXECUTE FUNCTION smarter_private.f06_no_start_continuation_immutable()') THEN RAISE EXCEPTION 'F06_SPIN_RETENTION_BINDING_CHANGED: %','f06_no_start_continuation_no_truncate'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='smarter_private.hand_submission_dispatch'::regclass AND c.relkind='r' AND c.relrowsecurity AND pg_get_userbyid(c.relowner)='postgres'
 AND NOT EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
 AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)='[["transaction_id", "bigint", true, null], ["submission_id", "uuid", true, null], ["request_hash", "text", true, null], ["instance_id", "text", true, null], ["lease_generation", "uuid", true, null]]'::jsonb
 AND (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid)='["PRIMARY KEY (transaction_id, submission_id)"]'::jsonb
 AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND (NOT k.convalidated OR k.condeferrable))
 AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND (NOT i.indisvalid OR NOT i.indisready))) THEN
 RAISE EXCEPTION 'F06_SPIN_DEPENDENCY_SCHEMA_CHANGED: %','smarter_private.hand_submission_dispatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='smarter_private.hand_submissions'::regclass AND c.relkind='r' AND c.relrowsecurity AND pg_get_userbyid(c.relowner)='postgres'
 AND NOT EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
 AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)='[["submission_id", "uuid", true, null], ["table_id", "uuid", true, null], ["hand_number", "bigint", true, null], ["instance_id", "text", true, null], ["lease_generation", "uuid", true, null], ["request", "jsonb", true, null], ["request_hash", "text", true, null], ["retained_at", "timestamp with time zone", true, "clock_timestamp()"]]'::jsonb
 AND (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid)='["CHECK ((hand_number > 0))", "CHECK ((jsonb_typeof(request) = ''object''::text))", "CHECK ((length(btrim(instance_id)) > 0))", "CHECK ((request_hash ~ ''^[0-9a-f]{64}$''::text))", "PRIMARY KEY (submission_id)", "UNIQUE (table_id, hand_number)"]'::jsonb
 AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND (NOT k.convalidated OR k.condeferrable))
 AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND (NOT i.indisvalid OR NOT i.indisready))) THEN
 RAISE EXCEPTION 'F06_SPIN_DEPENDENCY_SCHEMA_CHANGED: %','smarter_private.hand_submissions'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='smarter_private.hand_submission_dispositions'::regclass AND c.relkind='r' AND c.relrowsecurity AND pg_get_userbyid(c.relowner)='postgres'
 AND NOT EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
 AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)='[["table_id", "uuid", true, null], ["hand_number", "bigint", true, null], ["permit_id", "uuid", false, null], ["disposition", "text", true, null], ["submission_id", "uuid", false, null]]'::jsonb
 AND (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid)='["CHECK (((disposition = ''retained''::text) = (submission_id IS NOT NULL)))", "CHECK ((disposition = ANY (ARRAY[''retained''::text, ''disposed''::text])))", "CHECK ((hand_number > 0))", "PRIMARY KEY (table_id, hand_number)", "UNIQUE (permit_id)"]'::jsonb
 AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND (NOT k.convalidated OR k.condeferrable))
 AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND (NOT i.indisvalid OR NOT i.indisready))) THEN
 RAISE EXCEPTION 'F06_SPIN_DEPENDENCY_SCHEMA_CHANGED: %','smarter_private.hand_submission_dispositions'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='smarter_private.f06_no_start_continuations'::regclass AND c.relkind='r' AND c.relrowsecurity AND pg_get_userbyid(c.relowner)='postgres'
 AND NOT EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
 AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)='[["receipt_id", "uuid", true, "gen_random_uuid()"], ["break_id", "uuid", true, null], ["permit_id", "uuid", true, null], ["tournament_id", "uuid", true, null], ["table_id", "uuid", true, null], ["lifecycle", "bigint", true, null], ["hand_number", "bigint", true, null], ["original_generation", "uuid", true, null], ["current_generation", "uuid", true, null], ["park", "jsonb", true, null], ["permit", "jsonb", true, null], ["roster", "jsonb", true, null], ["prior_committed", "jsonb", true, null], ["created_at", "timestamp with time zone", true, "clock_timestamp()"]]'::jsonb
 AND (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid)='["PRIMARY KEY (receipt_id)", "UNIQUE (break_id)", "UNIQUE (permit_id)", "UNIQUE (table_id, hand_number)"]'::jsonb
 AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND (NOT k.convalidated OR k.condeferrable))
 AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND (NOT i.indisvalid OR NOT i.indisready))) THEN
 RAISE EXCEPTION 'F06_SPIN_DEPENDENCY_SCHEMA_CHANGED: %','smarter_private.f06_no_start_continuations'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.hand_state_snapshots'::regclass
 AND tgname='a00_f06_cancelled_preparation' AND tgenabled='O' AND tgtype=23
 AND tgfoid=to_regprocedure('smarter_private.f06_cancelled_preparation_writer_guard()')
 AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_cancelled_preparation BEFORE INSERT OR UPDATE ON public.hand_state_snapshots FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_cancelled_preparation_writer_guard()')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass
 AND tgname='a00_f06_source_seat' AND tgenabled='O' AND tgtype=31
 AND tgfoid=to_regprocedure('smarter_private.f06_source_guard()')
 AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()')
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_players'::regclass
 AND tgname='a00_f06_source_roster' AND tgenabled='O' AND tgtype=31
 AND tgfoid=to_regprocedure('smarter_private.f06_source_guard()')
 AND pg_get_triggerdef(oid)='CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard()') THEN
 RAISE EXCEPTION 'F06_SPIN_PRIOR_BINDING_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.table_seats'::regclass
 AND tgname='zzz_stamp_seat_occupancy' AND tgenabled='O' AND tgtype=23 AND tgqual IS NULL
 AND tgfoid=to_regprocedure('public.fn_stamp_seat_occupancy()')
 AND pg_get_triggerdef(oid)='CREATE TRIGGER zzz_stamp_seat_occupancy BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_occupancy()')
 OR NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname='occupancy_id'
 WHERE i.indexrelid=to_regclass('public.table_seats_occupancy_id_unique') AND i.indrelid='public.table_seats'::regclass
 AND i.indisvalid AND i.indisready AND i.indisunique AND i.indnkeyatts=1 AND i.indnatts=1
 AND i.indkey::text=a.attnum::text AND i.indpred IS NULL AND i.indexprs IS NULL) THEN
 RAISE EXCEPTION 'F06_SPIN_PRIOR_OCCUPANCY_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_guard_original_paid_stack_receipt()') AND md5(pg_get_functiondef(oid))='06bbbafae6950b54fdb00297830a30a4' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_COMPLETED_MTT_PAID_AUTHORITY_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_original_paid_stack_must_complete()') AND md5(pg_get_functiondef(oid))='8e221724e453fe284280f1f72dedaa7d' AND pg_get_userbyid(proowner)='postgres' AND proacl::text='{postgres=X/postgres}') THEN RAISE EXCEPTION 'F06_COMPLETED_MTT_PAID_AUTHORITY_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_paid_stack_custody_receipts'::regclass AND tgname='original_paid_custody_completed' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE CONSTRAINT TRIGGER original_paid_custody_completed AFTER INSERT OR UPDATE ON public.tournament_paid_stack_custody_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_original_paid_stack_must_complete()') THEN RAISE EXCEPTION 'F06_COMPLETED_MTT_PAID_BINDING_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_paid_stack_custody_receipts'::regclass AND tgname='original_paid_custody_immutable' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER original_paid_custody_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.tournament_paid_stack_custody_receipts FOR EACH ROW EXECUTE FUNCTION fn_ca_guard_original_paid_stack_receipt()') THEN RAISE EXCEPTION 'F06_COMPLETED_MTT_PAID_BINDING_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_paid_stack_custody_receipts'::regclass AND tgname='original_paid_custody_no_truncate' AND tgenabled='O' AND pg_get_triggerdef(oid)='CREATE TRIGGER original_paid_custody_no_truncate BEFORE TRUNCATE ON public.tournament_paid_stack_custody_receipts FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_guard_original_paid_stack_receipt()') THEN RAISE EXCEPTION 'F06_COMPLETED_MTT_PAID_BINDING_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.tournament_paid_stack_custody_receipts'::regclass
 AND c.relkind='r' AND c.relrowsecurity AND pg_get_userbyid(c.relowner)='postgres'
 AND NOT EXISTS(SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee<>c.relowner)
 AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
 AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)
 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)='[["id", "uuid", true, null], ["transaction_id", "xid8", true, "pg_current_xact_id()"], ["tournament_id", "uuid", true, null], ["user_id", "uuid", true, null], ["candidate_id", "uuid", true, null], ["entitlement_id", "uuid", true, null], ["source_ledger_id", "uuid", true, null], ["source_wallet_id", "uuid", true, null], ["destination_table_id", "uuid", true, null], ["destination_seat_number", "integer", true, null], ["grant_chips", "numeric", true, null], ["live_chips_before", "numeric", true, null], ["funded_supply", "numeric", true, null], ["scoring_excess", "numeric", true, null], ["expected", "jsonb", true, null], ["state", "text", true, null], ["assignment", "jsonb", false, null], ["created_at", "timestamp with time zone", true, "clock_timestamp()"], ["completed_at", "timestamp with time zone", false, null]]'::jsonb
 AND (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY pg_get_constraintdef(k.oid)) FROM pg_constraint k WHERE k.conrelid=c.oid)='["CHECK ((((state = ''reserved''::text) AND (assignment IS NULL) AND (completed_at IS NULL)) OR ((state = ''seated''::text) AND (assignment IS NOT NULL) AND (completed_at IS NOT NULL))))", "CHECK (((destination_seat_number >= 1) AND (destination_seat_number <= 10)))", "CHECK (((funded_supply > (0)::numeric) AND (funded_supply < ''Infinity''::numeric)))", "CHECK (((grant_chips > (0)::numeric) AND (grant_chips = trunc(grant_chips)) AND (grant_chips < (''2147483648''::bigint)::numeric)))", "CHECK (((live_chips_before >= (0)::numeric) AND (live_chips_before < ''Infinity''::numeric)))", "CHECK ((jsonb_typeof(expected) = ''object''::text))", "CHECK ((scoring_excess = ((live_chips_before + grant_chips) - funded_supply)))", "CHECK ((state = ANY (ARRAY[''reserved''::text, ''seated''::text])))", "PRIMARY KEY (id)", "TRIGGER DEFERRABLE INITIALLY DEFERRED", "UNIQUE (candidate_id)", "UNIQUE (entitlement_id)", "UNIQUE (source_ledger_id)", "UNIQUE (source_wallet_id)"]'::jsonb
 AND NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND NOT k.convalidated)
 AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND (NOT i.indisvalid OR NOT i.indisready))) THEN
 RAISE EXCEPTION 'F06_COMPLETED_MTT_PAID_SCHEMA_CHANGED'; END IF;
END $preimages$;
CREATE OR REPLACE FUNCTION public.fn_f06_abort_mixed_unsettled_generation(p_receipt_id uuid,p_expected jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE
 t uuid:=(p_expected->>'tournament_id')::uuid;
 g uuid:=(p_expected->>'generation')::uuid;
 lease public.engine_tournament_leases;
 event public.tournaments;
 h smarter_private.f06_hand_permits;
 o smarter_private.f06_operations;
 snap public.hand_state_snapshots;
 prior smarter_private.f06_mixed_aborts;
 generations uuid[]; prior_proof jsonb; expected_item jsonb; known_started integer:=0; prior_based integer:=0;
 item jsonb; hands jsonb:='[]'; parks jsonb; open_tables jsonb; roster jsonb; event_roster jsonb;
 accepted jsonb; actual jsonb; users uuid[]; u uuid; tab_ids uuid[]; reserved_ids uuid[];
 v_break_id uuid; player_count integer; hu boolean; historical jsonb; retired_dispatch jsonb;
 snapshot_absent_spin boolean;
 paid public.tournament_paid_stack_custody_receipts;
 v_dispatch smarter_private.f06_hand_dispatch; v_refusal public.financial_alerts;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role'
 OR current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'service' THEN
 RAISE EXCEPTION 'F06_ABORT_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
 IF p_receipt_id IS NULL OR t IS NULL OR g IS NULL OR jsonb_typeof(p_expected) IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_expected->'hands') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_GENERATION_IDENTITY_REQUIRED' USING ERRCODE='22023'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('f06:abort:'||p_receipt_id::text,0));
 SELECT * INTO prior FROM smarter_private.f06_mixed_aborts WHERE receipt_id=p_receipt_id;
 IF FOUND THEN
 IF prior.expected IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_ABORT_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('ok',true,'outcome',prior.outcome,'receipt_id',p_receipt_id,
 'hands',jsonb_array_length(prior.expected->'hands'),'credit',0);
 END IF;

 -- The lease FOR UPDATE drains protocol-2 HTTP requests admitted FOR KEY SHARE.
 -- Never wait on an earlier lane while holding it: direct SQL may own that lane.
 SELECT * INTO lease FROM public.engine_tournament_leases
 WHERE tournament_id=t AND lease_generation=g AND protocol_version=2 FOR UPDATE;
 IF NOT FOUND OR lease.instance_id IS DISTINCT FROM p_expected->>'instance_id'
 OR lease.engine_version IS DISTINCT FROM p_expected->>'engine_version' THEN
 RAISE EXCEPTION 'F06_GENERATION_LEASE_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_try_lane(t);
 SELECT array_agg(permit_id ORDER BY permit_id) INTO reserved_ids FROM smarter_private.f06_hand_permits
 WHERE tournament_id=t AND state='reserved';
 IF reserved_ids IS NULL OR (SELECT count(DISTINCT generation) FROM smarter_private.f06_hand_permits WHERE permit_id=ANY(reserved_ids)) NOT BETWEEN 1 AND 2
 OR reserved_ids IS DISTINCT FROM (SELECT array_agg((x->'permit'->>'permit_id')::uuid ORDER BY (x->'permit'->>'permit_id')::uuid)
 FROM jsonb_array_elements(p_expected->'hands') x) THEN
 RAISE EXCEPTION 'F06_GENERATION_WHOLE_RESERVED_SET_REQUIRED' USING ERRCODE='55000'; END IF;
SELECT array_agg(DISTINCT x ORDER BY x) INTO generations FROM (SELECT generation x FROM smarter_private.f06_hand_permits WHERE permit_id=ANY(reserved_ids) UNION SELECT g) q;
 IF EXISTS(SELECT 1 FROM unnest(generations) x WHERE smarter_private.f06_generation_aborted(t,x)) THEN
 RAISE EXCEPTION 'F06_MIXED_GENERATION_ALREADY_DISPOSED' USING ERRCODE='55000'; END IF;
  FOR u IN SELECT unnest(reserved_ids) LOOP
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||u::text,0)) THEN
 RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 END LOOP;
 SELECT array_agg(id ORDER BY id) INTO tab_ids FROM public.tables
 WHERE tournament_id=t AND lower(status)<>'closed' AND NOT COALESCE(is_deleted,false);
 SELECT array_agg(DISTINCT user_id ORDER BY user_id) INTO users FROM public.table_seats
 WHERE table_id=ANY(tab_ids) AND left_at IS NULL;
 FOR u IN SELECT unnest(users) LOOP
 IF NOT pg_try_advisory_xact_lock(hashtextextended('table_cap:'||u::text,0)) THEN
 RAISE EXCEPTION 'F06_ABORT_RETRY_PLAYER_LANE' USING ERRCODE='40001'; END IF;
 END LOOP;
 SELECT * INTO event FROM public.tournaments WHERE id=t FOR UPDATE;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=t ORDER BY user_id FOR UPDATE;
 PERFORM 1 FROM public.tables WHERE tournament_id=t ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.table_seats WHERE table_id=ANY(tab_ids) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_hand_permits WHERE tournament_id=t ORDER BY permit_id FOR UPDATE;
 PERFORM 1 FROM smarter_private.f06_operations WHERE tournament_id=t ORDER BY break_id FOR UPDATE;
 IF event.status IS DISTINCT FROM 'RUNNING' OR event.format_contract NOT IN ('mtt-v1','mtt-v2','spin-v1','sng-v1')
 OR event.format_contract IS NULL OR tab_ids IS NULL
 OR (event.format_contract='spin-v1' AND cardinality(tab_ids)<>1)
 OR EXISTS(SELECT 1 FROM public.tables WHERE id=ANY(tab_ids)
 AND (lower(status) NOT IN ('waiting','running') OR f06_lifecycle IS NULL)) THEN
 RAISE EXCEPTION 'F06_GENERATION_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 hu:=event.format_contract='sng-v1';
 IF hu AND (event.table_size IS DISTINCT FROM 2 OR cardinality(tab_ids)<>1
 OR EXISTS(SELECT 1 FROM public.tables WHERE id=ANY(tab_ids) AND max_players IS DISTINCT FROM 2)) THEN
 RAISE EXCEPTION 'F06_MIXED_HU_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 -- Every occupied chair in the complete open-table generation has one exact
 -- playing registration; every playing registration has that current chair.
 IF EXISTS(SELECT 1 FROM public.table_seats s LEFT JOIN public.tournament_players p
 ON p.tournament_id=t AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=ANY(tab_ids) AND s.left_at IS NULL AND (p.id IS NULL OR s.occupancy_id IS NULL
 OR s.joined_at IS NULL OR s.terminal_closed_at IS NOT NULL OR s.stack IS DISTINCT FROM p.chips::numeric
 OR s.stack IS NULL OR s.stack<0 OR s.stack::text IN ('NaN','Infinity','-Infinity')))
 OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=t AND p.status='playing'
 AND NOT EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=ANY(tab_ids) AND s.table_id=p.table_id
 AND s.user_id=p.user_id AND s.seat_number=p.seat_number AND s.left_at IS NULL)) THEN
 RAISE EXCEPTION 'F06_GENERATION_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',id,'status',status,'deleted',is_deleted,'lifecycle',f06_lifecycle) ORDER BY id)
 INTO open_tables FROM public.tables WHERE id=ANY(tab_ids);
 SELECT jsonb_agg(jsonb_build_object('seat_id',s.id,'occupancy_id',s.occupancy_id,'registration_id',p.id,
 'user_id',s.user_id,'joined_at',s.joined_at,'table_id',s.table_id,'seat_number',s.seat_number,'stack',s.stack,'chips',p.chips) ORDER BY s.id)
 INTO event_roster FROM public.table_seats s JOIN public.tournament_players p
 ON p.tournament_id=t AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=ANY(tab_ids) AND s.left_at IS NULL;
 IF (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(event_roster) x)<>jsonb_array_length(event_roster) THEN
 RAISE EXCEPTION 'F06_GENERATION_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 -- The explicitly supported HU boundary is one real two-chair event. A stale
 -- display counter cannot replace exact live seat/registration identity.
 IF hu AND (jsonb_array_length(event_roster) IS DISTINCT FROM 2
 OR (SELECT count(DISTINCT (x->>'seat_number')::integer) FROM jsonb_array_elements(event_roster) x)<>2
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(event_roster) x WHERE (x->>'seat_number')::integer NOT BETWEEN 1 AND 2)) THEN
 RAISE EXCEPTION 'F06_MIXED_HU_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 -- Pending post-commit work is an accepted financial outcome, never an abort.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits p WHERE p.tournament_id=t AND p.table_id=ANY(tab_ids)
 AND p.state='accepted' AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits later WHERE later.table_id=p.table_id AND later.hand_number>p.hand_number) AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits c
 WHERE c.table_id=p.table_id AND c.hand_number=p.hand_number AND c.hand_id=p.evidence_id AND c.post_commit_completed_at IS NOT NULL
 AND c.post_commit_result->'ok'='true'::jsonb)) THEN
 RAISE EXCEPTION 'F06_GENERATION_ACCEPTED_PROOF_INCOMPLETE' USING ERRCODE='55000'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('permit',to_jsonb(p),'atomic_hash',md5(to_jsonb(c)::text)) ORDER BY p.permit_id),'[]')
 INTO accepted FROM smarter_private.f06_hand_permits p JOIN public.hand_atomic_commits c
 ON c.table_id=p.table_id AND c.hand_number=p.hand_number
 WHERE p.tournament_id=t AND p.table_id=ANY(tab_ids) AND p.state='accepted' AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits later WHERE later.table_id=p.table_id AND later.hand_number>p.hand_number);
 -- Keep accepted-source parks intact for the genuine new-generation F06 owner.
 -- Only a target hand's pre-manifest park can receive a truthful withdrawal.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_operations p WHERE p.tournament_id=t
 AND p.state NOT IN ('acknowledged','withdrawn_before_manifest') AND
 (p.state<>'park_requested' OR p.manifest IS NOT NULL OR p.close_receipt IS NOT NULL OR p.cleanup_kind IS NOT NULL
 OR p.abort_receipt_id IS NOT NULL OR NOT p.source_table_id=ANY(tab_ids)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members WHERE break_id=p.break_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=p.break_id))) THEN
 RAISE EXCEPTION 'F06_GENERATION_PARK_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.break_id),'[]') INTO parks FROM smarter_private.f06_operations p
 WHERE p.tournament_id=t AND p.state NOT IN ('acknowledged','withdrawn_before_manifest');

 FOR h IN SELECT * FROM smarter_private.f06_hand_permits WHERE permit_id=ANY(reserved_ids) ORDER BY permit_id LOOP
 retired_dispatch:=NULL;
 SELECT x INTO expected_item FROM jsonb_array_elements(p_expected->'hands') x WHERE x->'permit'->>'permit_id'=h.permit_id::text;
 snapshot_absent_spin:=COALESCE(expected_item#>>'{interruption,kind}'='snapshot_absent_unaccepted_spin',false);
 IF h.state IS DISTINCT FROM 'reserved' OR h.evidence_id IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=h.table_id AND id=ANY(tab_ids) AND f06_lifecycle=h.lifecycle)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=h.table_id AND hand_number>h.hand_number) THEN
 RAISE EXCEPTION 'F06_GENERATION_PERMIT_CHANGED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=h.table_id AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE='55000'; END IF;
 -- A legacy returned refusal can leave its dispatch row committed while the
 -- nested financial subtransaction rolls back. Preserve that row. It is not
 -- evidence of accepted play, nor intrinsically linked to an alert transaction.
 SELECT * INTO v_dispatch FROM smarter_private.f06_hand_dispatch
 WHERE permit_id=h.permit_id FOR UPDATE;
 IF FOUND THEN
 IF event.format_contract IS DISTINCT FROM 'spin-v1'
 OR cardinality(reserved_ids)<>1 OR jsonb_array_length(event_roster) IS DISTINCT FROM 3
 OR txid_status(v_dispatch.xid) IS DISTINCT FROM 'committed'
 OR EXISTS(SELECT 1 FROM pg_stat_activity
   WHERE backend_xid::text::bigint=mod(v_dispatch.xid,4294967296::bigint))
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id AND NOT is_complete)
 OR (NOT snapshot_absent_spin AND NOT EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id
   AND hand_number=h.hand_number AND is_complete))
 OR (snapshot_absent_spin AND EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id
   AND hand_number>=h.hand_number))
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submissions WHERE table_id=h.table_id AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_ABORT_COMMITTED_OR_DISPATCHED' USING ERRCODE='55000'; END IF;
 SELECT * INTO v_refusal FROM public.financial_alerts
 WHERE id=(expected_item#>>'{interruption,retired_dispatch,refusal,id}')::uuid FOR SHARE;
 IF NOT FOUND OR v_refusal.source IS DISTINCT FROM 'ServerTableEngine.authoritative_hand_semantic_refusal'
 OR v_refusal.context->>'channel' IS DISTINCT FROM 'server_rpc'
 OR v_refusal.context->>'table_id' IS DISTINCT FROM h.table_id::text
 OR v_refusal.context->>'hand_number' IS DISTINCT FROM h.hand_number::text
 OR v_refusal.context->>'error' IS DISTINCT FROM 'atomic hand commit refused (atomic_hand_rolled_back): cannot find parent statement on pldbgapi2 call stack'
 OR v_refusal.context#>>'{hand_request_identity_v1,version}' IS DISTINCT FROM '1'
 OR v_refusal.context#>>'{hand_request_identity_v1,table_id}' IS DISTINCT FROM h.table_id::text
 OR v_refusal.context#>>'{hand_request_identity_v1,hand_number}' IS DISTINCT FROM h.hand_number::text
 OR v_refusal.context#>'{hand_request_identity_v1,post_commit_required}' IS DISTINCT FROM 'true'::jsonb
 OR NOT COALESCE(pg_input_is_valid(v_refusal.context#>>'{hand_request_identity_v1,hand_id}','uuid'),false)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE hand_id=(v_refusal.context#>>'{hand_request_identity_v1,hand_id}')::uuid)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE id=(v_refusal.context#>>'{hand_request_identity_v1,hand_id}')::uuid)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox WHERE hand_id=(v_refusal.context#>>'{hand_request_identity_v1,hand_id}')::uuid) THEN
 RAISE EXCEPTION 'F06_SPIN_ORIGINAL_REFUSAL_CHANGED' USING ERRCODE='55000'; END IF;
 -- Every retained financial receipt must belong to an already accepted hand.
 -- Join the actual stored stack receipt identity; never guess the missing ref.
 PERFORM 1 FROM public.ca_settlements WHERE table_id=h.table_id ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.settlement_idempotency_keys WHERE table_id=h.table_id ORDER BY hand_id FOR SHARE;
 IF EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k
 LEFT JOIN public.hand_atomic_commits a ON a.table_id=k.table_id AND a.stack_result->>'hand_id'=k.hand_id::text
 WHERE k.table_id=h.table_id AND (k.status IS DISTINCT FROM 'succeeded' OR a.hand_id IS NULL
 OR k.result IS DISTINCT FROM a.stack_result))
 OR EXISTS(SELECT 1 FROM public.ca_settlements c LEFT JOIN public.settlement_idempotency_keys k
 ON k.table_id=c.table_id AND k.hand_id=c.hand_id
 WHERE c.table_id=h.table_id AND (c.settlement_type IS DISTINCT FROM 'hand_stacks'
 OR c.state IS DISTINCT FROM 'final' OR k.hand_id IS NULL))
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=h.table_id AND (
 a.hand_number>=h.hand_number OR a.post_commit_completed_at IS NULL OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR NOT EXISTS(SELECT 1 FROM public.hand_history x WHERE x.id=a.hand_id AND x.table_id=a.table_id AND x.hand_number=a.hand_number)
 OR NOT EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k WHERE k.table_id=a.table_id AND k.hand_id::text=a.stack_result->>'hand_id')
 OR (SELECT count(*) FROM public.ca_settlements c WHERE c.table_id=a.table_id AND c.hand_id::text=a.stack_result->>'hand_id')<>1))
 OR EXISTS(SELECT 1 FROM public.hand_history x WHERE x.table_id=h.table_id
 AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.hand_id=x.id AND a.table_id=x.table_id AND a.hand_number=x.hand_number)) THEN
 RAISE EXCEPTION 'F06_SPIN_FINANCIAL_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 retired_dispatch:=jsonb_build_object('dispatch',to_jsonb(v_dispatch),'dispatch_hash',md5(to_jsonb(v_dispatch)::text),
   'transaction_status','committed','refusal',to_jsonb(v_refusal),'refusal_hash',md5(to_jsonb(v_refusal)::text),
   'proof_kind','ended_dispatch_prior_canonical_stack_boundary','transaction_link_asserted',false,
   'financial_receipts',jsonb_build_object(
     'settlements',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'hand_id',c.hand_id,'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id) FROM public.ca_settlements c WHERE c.table_id=h.table_id),
     'settlement_keys',(SELECT jsonb_agg(jsonb_build_object('hand_id',k.hand_id,'row_hash',md5(to_jsonb(k)::text)) ORDER BY k.hand_id) FROM public.settlement_idempotency_keys k WHERE k.table_id=h.table_id),
     'atomic',(SELECT jsonb_agg(jsonb_build_object('hand_id',a.hand_id,'hand_number',a.hand_number,'row_hash',md5(to_jsonb(a)::text)) ORDER BY a.hand_number) FROM public.hand_atomic_commits a WHERE a.table_id=h.table_id),
     'history',(SELECT jsonb_agg(jsonb_build_object('hand_id',x.id,'hand_number',x.hand_number,'row_hash',md5(to_jsonb(x)::text)) ORDER BY x.hand_number) FROM public.hand_history x WHERE x.table_id=h.table_id)));
 END IF;
 IF snapshot_absent_spin AND retired_dispatch IS NULL THEN
 RAISE EXCEPTION 'F06_SPIN_ABSENT_ORIGINAL_DISPATCH_REQUIRED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(x ORDER BY x->>'user_id') INTO roster FROM jsonb_array_elements(event_roster) x
 WHERE x->>'table_id'=h.table_id::text;
 prior_proof:=NULL; historical:=NULL;
 SELECT * INTO snap FROM public.hand_state_snapshots
 WHERE table_id=h.table_id AND hand_number=h.hand_number AND NOT is_complete FOR UPDATE;
 IF NOT FOUND AND expected_item#>>'{interruption,kind}'='completed_unaccepted_mtt' THEN
 SELECT * INTO snap FROM public.hand_state_snapshots WHERE id=(expected_item->>'snapshot_id')::uuid FOR UPDATE;
 IF NOT FOUND OR snap.table_id IS DISTINCT FROM h.table_id OR snap.hand_number IS DISTINCT FROM h.hand_number
 OR NOT snap.is_complete THEN RAISE EXCEPTION 'F06_COMPLETED_MTT_SNAPSHOT_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 IF snap.id IS NOT NULL THEN
 known_started:=known_started+1;
 IF snap.stage IS DISTINCT FROM 'preflop'
 OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'
 OR jsonb_typeof(snap.state_json->'players') IS DISTINCT FROM 'array'
 OR jsonb_array_length(snap.state_json->'players') NOT BETWEEN 2 AND 10 THEN
 RAISE EXCEPTION 'F06_ABORT_SNAPSHOT_CHANGED' USING ERRCODE='55000'; END IF;
 player_count:=jsonb_array_length(roster);
 IF player_count IS DISTINCT FROM jsonb_array_length(snap.state_json->'players')
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(snap.state_json->'players') x)<>player_count
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x WHERE NOT EXISTS(
 SELECT 1 FROM jsonb_array_elements(roster) r WHERE r->>'user_id'=x->>'user_id'
 AND (r->>'seat_number')::integer=(x->>'seat')::integer
 AND (r->>'stack')::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric
 AND (x->>'stack')::numeric>=0 AND (x->>'totalInvested')::numeric>=0
 AND (x->>'stack')::numeric::text NOT IN ('NaN','Infinity','-Infinity')
 AND (x->>'totalInvested')::numeric::text NOT IN ('NaN','Infinity','-Infinity')
 -- BBA dead investment is already part of totalInvested. Do not credit it twice.
 AND COALESCE((x->>'deadInvested')::numeric,0) BETWEEN 0 AND (x->>'totalInvested')::numeric
 AND COALESCE((x->>'returnedUncalled')::numeric,0)=0
 -- Individual MTT antes are already included in dead and total investment.
 AND (COALESCE((x->>'individualAnteInvested')::numeric,0)=0
 OR (event.format_contract IN ('mtt-v1','mtt-v2')
 AND COALESCE((x->>'individualAnteInvested')::numeric,0) BETWEEN 0 AND COALESCE((x->>'deadInvested')::numeric,0)))))
 OR (snap.state_json->>'pot')::numeric IS DISTINCT FROM
 (SELECT sum((x->>'totalInvested')::numeric) FROM jsonb_array_elements(snap.state_json->'players') x) THEN
 RAISE EXCEPTION 'F06_ABORT_SAVED_STACKS_CHANGED' USING ERRCODE='55000'; END IF;
 -- A legacy engine completed this preflop snapshot before settlement was
 -- accepted. Its exact persisted investment and original paid-custody receipt
 -- prove the unchanged committed roster, never a hand result or no-start.
 IF snap.is_complete THEN
 IF event.format_contract NOT IN ('mtt-v1','mtt-v2')
 OR cardinality(tab_ids)<>1 OR cardinality(reserved_ids)<>1
 OR expected_item#>>'{interruption,kind}' IS DISTINCT FROM 'completed_unaccepted_mtt'
 OR jsonb_typeof(snap.state_json->'actionHistory') IS DISTINCT FROM 'array'
 OR jsonb_array_length(snap.state_json->'actionHistory')<>0 THEN
 RAISE EXCEPTION 'F06_COMPLETED_MTT_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO paid FROM public.tournament_paid_stack_custody_receipts
 WHERE id=(expected_item#>>'{interruption,paid_receipt_id}')::uuid FOR SHARE;
 IF NOT FOUND OR paid.state IS DISTINCT FROM 'seated'
 OR paid.tournament_id IS DISTINCT FROM t OR paid.destination_table_id IS DISTINCT FROM h.table_id
 OR paid.expected->>'generation' IS DISTINCT FROM h.generation::text
 OR paid.completed_at IS NULL OR paid.completed_at>snap.created_at
 OR paid.assignment->'ok' IS DISTINCT FROM 'true'::jsonb
 OR paid.assignment->>'receipt_id' IS DISTINCT FROM paid.id::text
 OR paid.assignment->>'original_ledger_id' IS DISTINCT FROM paid.source_ledger_id::text
 OR paid.assignment->>'original_entitlement_id' IS DISTINCT FROM paid.entitlement_id::text
 OR jsonb_typeof(paid.expected->'live_seats') IS DISTINCT FROM 'array'
 OR jsonb_array_length(paid.expected->'live_seats')<>jsonb_array_length(roster)-1
 OR (SELECT sum((x->>'stack')::numeric) FROM jsonb_array_elements(roster) x)
    IS DISTINCT FROM paid.live_chips_before+paid.grant_chips
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roster) r
 WHERE r->>'user_id'=paid.user_id::text AND r->>'seat_id'=paid.assignment->>'seat_id'
 AND r->>'occupancy_id'=paid.assignment->>'occupancy_id'
 AND (r->>'joined_at')::timestamptz=(paid.assignment->>'assigned_at')::timestamptz
 AND (r->>'seat_number')::integer=paid.destination_seat_number
 AND (r->>'stack')::numeric=paid.grant_chips)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(roster) r WHERE r->>'user_id'<>paid.user_id::text
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(paid.expected->'live_seats') x
 WHERE x->>'id'=r->>'seat_id' AND x->>'occupancy_id'=r->>'occupancy_id'
 AND x->>'user_id'=r->>'user_id' AND x->>'table_id'=r->>'table_id'
 AND (x->>'joined_at')::timestamptz=(r->>'joined_at')::timestamptz
 AND (x->>'seat_number')::integer=(r->>'seat_number')::integer
 AND (x->>'stack')::numeric=(r->>'stack')::numeric)) THEN
 RAISE EXCEPTION 'F06_COMPLETED_MTT_PAID_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 -- Lease/lane admission above drains real writers; the retained-submission
 -- disposition fence also serializes a racing original payload retention.
 IF EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id
 AND (hand_number>h.hand_number OR (hand_number=h.hand_number AND id<>snap.id)))
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number>h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submissions WHERE table_id=h.table_id AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_COMPLETED_MTT_LATER_CUSTODY' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number ORDER BY id FOR SHARE;
 IF (SELECT count(*) FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)<>jsonb_array_length(roster)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roster) r WHERE r->>'user_id'=c.user_id::text
 AND (r->>'seat_number')::integer=c.seat_number)) THEN
 RAISE EXCEPTION 'F06_COMPLETED_MTT_CARDS_CHANGED' USING ERRCODE='55000'; END IF;
 -- An orphan monetary receipt is not evidence of a safely unaccepted hand.
 -- Join actual recorded stack receipt identity, never a guessed hand ref.
 PERFORM 1 FROM public.ca_settlements WHERE table_id=h.table_id ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.settlement_idempotency_keys WHERE table_id=h.table_id ORDER BY hand_id FOR SHARE;
 IF EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k
 LEFT JOIN public.hand_atomic_commits a ON a.table_id=k.table_id AND a.stack_result->>'hand_id'=k.hand_id::text
 WHERE k.table_id=h.table_id AND (k.status IS DISTINCT FROM 'succeeded'
 OR CASE WHEN a.hand_id IS NOT NULL THEN k.result IS DISTINCT FROM a.stack_result
 ELSE NOT COALESCE(
   CASE WHEN jsonb_typeof(k.result->'hand_number')='number'
          AND k.result->>'hand_number' ~ '^[1-9][0-9]*$'
        THEN (k.result->>'hand_number')::numeric<h.hand_number
        ELSE false END
   AND k.result->>'table_id'=k.table_id::text
   AND k.result->>'hand_id'=k.hand_id::text
   AND k.result->'success'='true'::jsonb
   AND k.result->'conservation_checked'='true'::jsonb
   AND k.result->>'mode'='delta'
   AND k.result->'rake'='0'::jsonb AND k.result->'bbj'='0'::jsonb
   AND k.result->'inflow'='0'::jsonb AND k.result->'net_deltas'='0'::jsonb
   AND k.result->'rebased'='{}'::jsonb AND k.result->'departed'='[]'::jsonb
   AND k.result->'players' IN ('2'::jsonb,'3'::jsonb,'4'::jsonb,'5'::jsonb,'6'::jsonb,'7'::jsonb,'8'::jsonb,'9'::jsonb,'10'::jsonb)
   AND k.attempt_count>0 AND isfinite(k.first_attempt_at) AND isfinite(k.completed_at)
   AND isfinite(k.last_attempt_at) AND isfinite(paid.completed_at)
   AND k.error IS NULL
   AND k.first_attempt_at<=k.completed_at
   AND k.completed_at<=k.last_attempt_at
   AND k.last_attempt_at<paid.completed_at
   AND (SELECT count(*) FROM public.ca_settlements c
        WHERE c.table_id=k.table_id AND c.hand_id=k.hand_id)=1
   AND EXISTS(SELECT 1 FROM public.ca_settlements c
        WHERE c.table_id=k.table_id AND c.hand_id=k.hand_id
        AND c.settlement_type='hand_stacks' AND c.state='final'
        AND c.error_detail IS NULL
        AND c.external_ref=k.table_id::text||':'||k.hand_id::text
        AND c.idempotency_key='hand:'||k.table_id::text||':'||k.hand_id::text
        AND c.totals->'mode'=k.result->'mode' AND c.totals->'players'=k.result->'players'
        AND c.totals->'rake'=k.result->'rake' AND c.totals->'bbj'=k.result->'bbj'
        AND c.totals->'inflow'=k.result->'inflow' AND c.totals->'net_deltas'=k.result->'net_deltas'
        AND c.totals->'rebased'=k.result->'rebased' AND c.totals->'departed'=k.result->'departed'
        AND isfinite(c.created_at) AND isfinite(c.updated_at)
        AND c.created_at<=c.updated_at AND c.updated_at<paid.completed_at)
 ,false) END))
 OR EXISTS(SELECT 1 FROM public.ca_settlements c LEFT JOIN public.settlement_idempotency_keys k
 ON k.table_id=c.table_id AND k.hand_id=c.hand_id
 WHERE c.table_id=h.table_id AND (c.settlement_type IS DISTINCT FROM 'hand_stacks'
 OR c.state IS DISTINCT FROM 'final' OR k.hand_id IS NULL))
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.table_id=h.table_id AND (
 a.hand_number>=h.hand_number OR a.post_commit_completed_at IS NULL OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR NOT EXISTS(SELECT 1 FROM public.hand_history x WHERE x.id=a.hand_id AND x.table_id=a.table_id AND x.hand_number=a.hand_number)
 OR NOT EXISTS(SELECT 1 FROM public.settlement_idempotency_keys k WHERE k.table_id=a.table_id AND k.hand_id::text=a.stack_result->>'hand_id')
 OR (SELECT count(*) FROM public.ca_settlements c WHERE c.table_id=a.table_id AND c.hand_id::text=a.stack_result->>'hand_id')<>1))
 OR EXISTS(SELECT 1 FROM public.hand_history x WHERE x.table_id=h.table_id
 AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits a WHERE a.hand_id=x.id AND a.table_id=x.table_id AND a.hand_number=x.hand_number)) THEN
 RAISE EXCEPTION 'F06_COMPLETED_MTT_FINANCIAL_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 historical:=jsonb_build_object('kind','completed_unaccepted_mtt','paid_receipt_id',paid.id,
 'paid_receipt_hash',md5(to_jsonb(paid)::text),
 'cards',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'user_id',c.user_id,'seat_number',c.seat_number,
 'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id) FROM public.table_hole_cards c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number),
 'registrations',(SELECT jsonb_agg(jsonb_build_object('id',p.id,'user_id',p.user_id,'row_hash',md5(to_jsonb(p)::text)) ORDER BY p.id)
 FROM public.tournament_players p WHERE p.tournament_id=t),
 'financial_receipts',jsonb_build_object(
 'settlements',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id) FROM public.ca_settlements c WHERE c.table_id=h.table_id),
 'settlement_keys',(SELECT jsonb_agg(jsonb_build_object('hand_id',k.hand_id,'row_hash',md5(to_jsonb(k)::text)) ORDER BY k.hand_id) FROM public.settlement_idempotency_keys k WHERE k.table_id=h.table_id),
 'atomic',(SELECT jsonb_agg(jsonb_build_object('hand_id',a.hand_id,'row_hash',md5(to_jsonb(a)::text)) ORDER BY a.hand_number) FROM public.hand_atomic_commits a WHERE a.table_id=h.table_id),
 'history',(SELECT jsonb_agg(jsonb_build_object('hand_id',x.id,'row_hash',md5(to_jsonb(x)::text)) ORDER BY x.hand_number) FROM public.hand_history x WHERE x.table_id=h.table_id)));
 END IF;
 ELSE
 prior_based:=prior_based+1;
 SELECT x INTO expected_item FROM jsonb_array_elements(p_expected->'hands') x WHERE x->'permit'->>'permit_id'=h.permit_id::text;
 IF expected_item#>>'{prior,kind}'='aborted_unsettled' THEN
 IF NOT hu THEN RAISE EXCEPTION 'F06_MIXED_PRIOR_ABORT_HU_ONLY' USING ERRCODE='55000'; END IF;
 prior_proof:=smarter_private.f06_prior_aborted_stacks(h.permit_id,expected_item->'prior',roster);
 ELSE
 prior_proof:=smarter_private.f06_prior_committed_stacks(h.permit_id,expected_item->'prior',roster);
 -- A completed snapshot records that this hand existed, not an accepted
 -- monetary outcome. The preceding canonical receipt remains the sole stack
 -- authority. Bind all retained original evidence without rewriting it.
 IF event.format_contract='spin-v1' THEN
 IF event.table_size IS DISTINCT FROM 3 OR cardinality(tab_ids)<>1
 OR cardinality(reserved_ids)<>1 OR jsonb_array_length(roster) NOT BETWEEN 2 AND 3
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=h.table_id AND max_players=3)
 OR (SELECT count(DISTINCT (x->>'seat_number')::integer) FROM jsonb_array_elements(roster) x)<>jsonb_array_length(roster)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(roster) x
 WHERE (x->>'seat_number')::integer NOT BETWEEN 1 AND 3 OR (x->>'stack')::numeric<=0)
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=t)<>3
 OR (SELECT count(DISTINCT user_id) FROM public.tournament_players WHERE tournament_id=t)<>3
 OR EXISTS(SELECT 1 FROM public.tournament_players WHERE tournament_id=t AND status IS DISTINCT FROM 'playing'
 AND (status IS DISTINCT FROM 'eliminated' OR chips IS DISTINCT FROM 0))
 OR expected_item#>>'{prior,kind}' IS NOT NULL THEN
 RAISE EXCEPTION 'F06_SPIN_PRIOR_SCOPE_CHANGED' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=h.table_id
 AND hand_number>(prior_proof->>'hand_number')::bigint AND state='accepted')
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id AND hand_number>h.hand_number)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=h.table_id
 AND (hand_number>h.hand_number OR (hand_number=h.hand_number AND NOT snapshot_absent_spin)))
 OR EXISTS(SELECT 1 FROM public.hand_projection_outbox WHERE table_id=h.table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM smarter_private.hand_submissions WHERE table_id=h.table_id AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_SPIN_PRIOR_LATER_CUSTODY' USING ERRCODE='55000'; END IF;
 -- Missing storage is never a claim that this hand did not start. The original
 -- ended dispatch/refusal and prior accepted stack boundary remain mandatory.
 IF snapshot_absent_spin THEN
 IF event.format_contract IS DISTINCT FROM 'spin-v1' OR jsonb_array_length(roster)<>3
 OR retired_dispatch IS NULL
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id AND hand_number>=h.hand_number) THEN
 RAISE EXCEPTION 'F06_SPIN_ABSENT_SNAPSHOT_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number ORDER BY id FOR SHARE;
 IF (SELECT count(*) FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)<>3
 OR (SELECT count(DISTINCT user_id) FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)<>3
 OR (SELECT count(DISTINCT seat_number) FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)<>3
 OR EXISTS(SELECT 1 FROM public.table_hole_cards c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roster) r
 WHERE r->>'user_id'=c.user_id::text AND (r->>'seat_number')::integer=c.seat_number)) THEN
 RAISE EXCEPTION 'F06_SPIN_ABSENT_CARDS_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 PERFORM 1 FROM public.hand_state_snapshots WHERE table_id=h.table_id
 AND hand_number>=h.hand_number ORDER BY id FOR SHARE;
 PERFORM 1 FROM public.financial_alerts WHERE source='ServerTableEngine.authoritative_hand_semantic_refusal'
 AND context->>'table_id'=h.table_id::text AND context->>'hand_number'=h.hand_number::text
 ORDER BY id FOR SHARE;
 historical:=jsonb_build_object(
 'registrations',(SELECT jsonb_agg(jsonb_build_object('registration_id',p.id,'user_id',p.user_id,
   'row_hash',md5(to_jsonb(p)::text)) ORDER BY p.id) FROM public.tournament_players p WHERE p.tournament_id=t),
 'completed_snapshots',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'id',s.id,'hand_number',s.hand_number,'is_complete',s.is_complete,'row_hash',md5(to_jsonb(s)::text)) ORDER BY s.id),'[]')
   FROM public.hand_state_snapshots s WHERE s.table_id=h.table_id AND s.hand_number>=h.hand_number),
 'atomic_refusals',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
   'id',a.id,'row_hash',md5(to_jsonb(a)::text)) ORDER BY a.id),'[]')
   FROM public.financial_alerts a WHERE a.source='ServerTableEngine.authoritative_hand_semantic_refusal'
   AND a.context->>'table_id'=h.table_id::text AND a.context->>'hand_number'=h.hand_number::text))
   || CASE WHEN retired_dispatch IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('retired_dispatch',retired_dispatch) END
   || CASE WHEN snapshot_absent_spin THEN jsonb_build_object('kind','snapshot_absent_unaccepted_spin',
     'cards',(SELECT jsonb_agg(jsonb_build_object('id',c.id,'user_id',c.user_id,'seat_number',c.seat_number,
       'hand_number',c.hand_number,'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id)
       FROM public.table_hole_cards c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number)) ELSE '{}'::jsonb END;
 END IF;
 END IF;
 END IF;
 v_break_id:=NULL;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE source_table_id=h.table_id
 AND state NOT IN ('acknowledged','withdrawn_before_manifest');
 IF FOUND THEN
 IF o.origin_generation IS DISTINCT FROM h.generation OR o.lifecycle IS DISTINCT FROM h.lifecycle
 OR (o.custody_generation IS NOT NULL AND o.custody_generation<>h.generation) THEN
 RAISE EXCEPTION 'F06_GENERATION_PARK_CHANGED' USING ERRCODE='55000'; END IF;
 v_break_id:=o.break_id;
 END IF;
 hands:=hands||jsonb_build_array(jsonb_build_object('permit',to_jsonb(h),'snapshot_id',snap.id,
 'snapshot_hash',CASE WHEN snap.id IS NULL THEN NULL ELSE md5(to_jsonb(snap)::text) END,'roster',roster,'break_id',v_break_id,'prior',prior_proof) || CASE WHEN historical IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('interruption',historical) END);
 END LOOP;
 IF prior_based>1
 OR (hu AND (prior_based<>1 OR known_started<>0 OR cardinality(reserved_ids)<>1 OR jsonb_array_length(parks)<>0))
 OR (NOT hu AND prior_based=1 AND event.format_contract<>'spin-v1'
 AND (event.format_contract NOT IN ('mtt-v1','mtt-v2') OR known_started<1)) THEN
 RAISE EXCEPTION 'F06_MIXED_BOUNDARIES_REQUIRED' USING ERRCODE='55000'; END IF;
 actual:=jsonb_build_object('tournament_id',t,'generations',to_jsonb(generations),'generation',g,'instance_id',lease.instance_id,
 'engine_version',lease.engine_version,'format_contract',event.format_contract,'open_tables',open_tables,
 'roster',event_roster,'parks',parks,'accepted',accepted,'hands',hands);
 IF actual IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'F06_ABORT_EXPECTED_CHANGED' USING ERRCODE='55000'; END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.f06_mixed_aborts(receipt_id,tournament_id,expected) VALUES(p_receipt_id,t,actual);
 INSERT INTO smarter_private.f06_mixed_abort_generations(tournament_id,generation,receipt_id) SELECT t,x,p_receipt_id FROM unnest(generations) x;
 FOR item IN SELECT value FROM jsonb_array_elements(hands) LOOP
 INSERT INTO smarter_private.f06_mixed_abort_hands
 (permit_id,receipt_id,tournament_id,generation,table_id,hand_number,snapshot_id,break_id,prior_hand_id,prior_abort_receipt_id,expected)
 VALUES((item->'permit'->>'permit_id')::uuid,p_receipt_id,t,(item->'permit'->>'generation')::uuid,(item->'permit'->>'table_id')::uuid,
 (item->'permit'->>'hand_number')::bigint,(item->>'snapshot_id')::uuid,(item->>'break_id')::uuid,(item#>>'{prior,atomic_hand_id}')::uuid,(item#>>'{prior,receipt_id}')::uuid,item);
 END LOOP;
 UPDATE smarter_private.f06_hand_permits SET state='aborted_unsettled',evidence_id=p_receipt_id WHERE permit_id=ANY(reserved_ids);
 UPDATE public.hand_state_snapshots SET is_complete=true
 WHERE NOT is_complete AND id IN(SELECT a.snapshot_id FROM smarter_private.f06_mixed_abort_hands a WHERE a.receipt_id=p_receipt_id);
 UPDATE smarter_private.f06_operations SET state='withdrawn_before_manifest',abort_receipt_id=p_receipt_id
 WHERE break_id IN(SELECT a.break_id FROM smarter_private.f06_mixed_abort_hands a WHERE a.receipt_id=p_receipt_id);
 PERFORM public.release_tournament_leases_v2(lease.instance_id,
 jsonb_build_array(jsonb_build_object('tournament_id',t,'lease_generation',g)));
 IF EXISTS(SELECT 1 FROM public.engine_tournament_leases WHERE tournament_id=t AND lease_generation=g) THEN
 RAISE EXCEPTION 'F06_ABORT_LEASE_NOT_WITHDRAWN' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('ok',true,'outcome','aborted_unsettled','receipt_id',p_receipt_id,
 'hands',jsonb_array_length(hands),'credit',0);
END $function$;
REVOKE ALL ON FUNCTION public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_abort_mixed_unsettled_generation(uuid,jsonb) TO service_role;
COMMIT;
