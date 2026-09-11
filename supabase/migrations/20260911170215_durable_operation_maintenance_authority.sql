-- Version reserved by scripts/new-migration.mjs. See docs/operations/maintenance-database-authority.md.
-- Durable operation maintenance. Inactive support; no production activation.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='45s';
SET LOCAL synchronous_commit=on;

DO $preflight$ BEGIN
 IF to_regprocedure('release_ops.provider_schema_version()') IS NULL OR release_ops.provider_schema_version()<>1
 OR to_regclass('public.engine_maintenance_thaw_targets') IS NULL THEN RAISE EXCEPTION 'MAINTENANCE_DEPENDENCY_MISSING'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_active_maintenance_release_boundary()') AND md5(p.prosrc)='66f0ca0e4ebf27a74dd4b7c211c4fd0f' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=true AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, auth, pg_temp']::text[] AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'MAINTENANCE_SOURCE_DRIFT: fn_active_maintenance_release_boundary()'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_claim_engine_maintenance_break(uuid,uuid,text)') AND md5(p.prosrc)='cbe93f09bb0a5c5e815ca8faaa0cbb44' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=true AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']::text[] AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'MAINTENANCE_SOURCE_DRIFT: fn_claim_engine_maintenance_break(uuid,uuid,text)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_clear_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,uuid)') AND md5(p.prosrc)='88d87f45e2adfc1e2c7ca5dfb71b9f77' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=true AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']::text[] AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'MAINTENANCE_SOURCE_DRIFT: fn_clear_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,uuid)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_maintenance_break_state()') AND md5(p.prosrc)='6383abf7006f5ecbe0110edb8a1e146a' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=false AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'MAINTENANCE_SOURCE_DRIFT: fn_maintenance_break_state()'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_save_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,uuid)') AND md5(p.prosrc)='5814415121202e3de8377761bc8dc80e' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=true AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']::text[] AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'MAINTENANCE_SOURCE_DRIFT: fn_save_engine_maintenance_break(text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,uuid)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_thaw_platform(timestamp with time zone,numeric,text)') AND md5(p.prosrc)='f058bfbb8fb26b8412868fc9a2cbf900' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=true AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'MAINTENANCE_SOURCE_DRIFT: fn_thaw_platform(timestamp with time zone,numeric,text)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_thaw_platform(timestamp with time zone,timestamp with time zone,numeric,uuid,text)') AND md5(p.prosrc)='071941c4f82d9f676622dc671fb0db40' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=true AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp','statement_timeout=35s','lock_timeout=32s']::text[] AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'MAINTENANCE_SOURCE_DRIFT: fn_thaw_platform(timestamp with time zone,timestamp with time zone,numeric,uuid,text)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_credit_maintenance_thaw_targets(timestamp with time zone,numeric)') AND md5(p.prosrc)='c12308b00489adce1376ba1c1e4ea9d5' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=true AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'MAINTENANCE_SOURCE_DRIFT: fn_credit_maintenance_thaw_targets(timestamp with time zone,numeric)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_platform_frozen()') AND md5(p.prosrc)='112b1265824ee082b8adc67ea367d826' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=false AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'MAINTENANCE_SOURCE_DRIFT: fn_platform_frozen()'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_snapshot_maintenance_thaw_targets(timestamp with time zone,numeric)') AND md5(p.prosrc)='43455b0ff86f51f524b6190fc6bf7dd2' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=true AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'MAINTENANCE_SOURCE_DRIFT: fn_snapshot_maintenance_thaw_targets(timestamp with time zone,numeric)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_thaw_platform_checkpointed(timestamp with time zone,numeric,text)') AND md5(p.prosrc)='8390ea3b5e92685cc29c806c494a680a' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=true AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres}') THEN RAISE EXCEPTION 'MAINTENANCE_SOURCE_DRIFT: fn_thaw_platform_checkpointed(timestamp with time zone,numeric,text)'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_entry_purchases_frozen()') AND md5(p.prosrc)='a29498531e4b7d3889532e80fafc8d57' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=false AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'MAINTENANCE_SOURCE_DRIFT: fn_entry_purchases_frozen()'; END IF;
IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_thaw_reconnect_states(jsonb,numeric,numeric)') AND md5(p.prosrc)='0b5ef6cd1c6ba4e9331714f7c9053bd2' AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef=false AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] AND p.proacl::text IS NOT DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}') THEN RAISE EXCEPTION 'MAINTENANCE_SOURCE_DRIFT: fn_thaw_reconnect_states(jsonb,numeric,numeric)'; END IF;
END $preflight$;

CREATE TABLE release_ops.maintenance_compatibility (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), installation_id uuid NOT NULL REFERENCES release_ops.provider_installations(id),
 policy_digest text NOT NULL CHECK(policy_digest='1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda'),
 components jsonb NOT NULL, evidence jsonb NOT NULL, principal text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE release_ops.maintenance_activation (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), receipt_id uuid REFERENCES release_ops.maintenance_compatibility(id),
 activated_at timestamptz, owner_id uuid, epoch uuid
);
INSERT INTO release_ops.maintenance_activation(singleton) VALUES(true);
CREATE TABLE release_ops.maintenance_needs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), release_id uuid NOT NULL REFERENCES release_ops.admissions(id),
 readiness_event uuid NOT NULL REFERENCES release_ops.events(id), provider_plan_id uuid NOT NULL REFERENCES release_ops.provider_plans(id),
 recovery_id uuid, manifest_digest text NOT NULL, evidence jsonb NOT NULL, principal text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(release_id,readiness_event,provider_plan_id)
);
CREATE TABLE release_ops.maintenance_operations (
 operation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), interval_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 release_id uuid NOT NULL REFERENCES release_ops.admissions(id), need_receipt uuid NOT NULL REFERENCES release_ops.maintenance_needs(id),
 activation_receipt uuid NOT NULL REFERENCES release_ops.maintenance_compatibility(id), ownership_token uuid NOT NULL DEFAULT gen_random_uuid(),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0), controller_owner uuid NOT NULL, controller_epoch uuid NOT NULL,
 phase text NOT NULL CHECK(phase IN ('last_hand','draining','ready','applying','recovering','recovery_required','release_authorized','releasing','resumed')),
 scope jsonb NOT NULL CHECK(scope='{"type":"platform"}'::jsonb), freeze_started_at timestamptz NOT NULL,
 target_at timestamptz NOT NULL, forward_deadline_at timestamptz NOT NULL, deadline_at timestamptz NOT NULL,
 ready_at timestamptz, release_receipt uuid, release_authorized_at timestamptz, resumed_at timestamptz,
 reason text NOT NULL, declared_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(isfinite(freeze_started_at) AND target_at=freeze_started_at+interval '300 seconds'
 AND forward_deadline_at=freeze_started_at+interval '1200 seconds' AND deadline_at=freeze_started_at+interval '1800 seconds'),
 CHECK((phase NOT IN ('release_authorized','releasing','resumed')) OR release_receipt IS NOT NULL)
);
CREATE UNIQUE INDEX maintenance_one_continuous_hold ON release_ops.maintenance_operations((true)) WHERE phase<>'resumed';
CREATE TABLE release_ops.maintenance_tables (
 interval_id uuid NOT NULL REFERENCES release_ops.maintenance_operations(interval_id), table_id uuid NOT NULL,
 tournament_id uuid, PRIMARY KEY(interval_id,table_id)
);
CREATE TABLE release_ops.maintenance_steps (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), operation_id uuid NOT NULL REFERENCES release_ops.maintenance_operations(operation_id),
 step_key text NOT NULL, owner_id uuid NOT NULL, epoch uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('engine_cutover','recovery')),
 estimated_ms bigint NOT NULL, recovery_ms bigint NOT NULL, margin_ms bigint NOT NULL, proof_receipt uuid NOT NULL,
 authorized_at timestamptz NOT NULL, not_after_at timestamptz NOT NULL, UNIQUE(operation_id,step_key)
);
CREATE TABLE release_ops.maintenance_safe_resume (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), operation_id uuid NOT NULL REFERENCES release_ops.maintenance_operations(operation_id),
 provider_operation_id uuid NOT NULL REFERENCES release_ops.external_operations(id), evidence jsonb NOT NULL,
 principal text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(operation_id,provider_operation_id)
);
ALTER TABLE release_ops.maintenance_operations ADD FOREIGN KEY(release_receipt) REFERENCES release_ops.maintenance_safe_resume(id);
CREATE TABLE release_ops.maintenance_waves (
 interval_id uuid NOT NULL REFERENCES release_ops.maintenance_operations(interval_id), wave_index integer NOT NULL CHECK(wave_index>=0),
 table_ids uuid[] NOT NULL, ownership_token uuid NOT NULL, receipt_id uuid UNIQUE,
 credited_through_at timestamptz, resumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(interval_id,wave_index), CHECK(cardinality(table_ids)>0)
);
-- Stable installments are preparation, never release permission. Their endpoint
-- is immutable even after an overrun; finish first, then append another checkpoint.
CREATE TABLE release_ops.maintenance_global_checkpoints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), interval_id uuid NOT NULL REFERENCES release_ops.maintenance_operations(interval_id),
 checkpoint_no integer NOT NULL CHECK(checkpoint_no BETWEEN 1 AND 8), credited_through_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 UNIQUE(interval_id,checkpoint_no), CHECK(isfinite(credited_through_at) AND credited_through_at>created_at)
);
CREATE TABLE release_ops.maintenance_global_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), interval_id uuid NOT NULL UNIQUE REFERENCES release_ops.maintenance_operations(interval_id),
 checkpoint_id uuid NOT NULL UNIQUE REFERENCES release_ops.maintenance_global_checkpoints(id),
 ownership_token uuid NOT NULL, generation bigint NOT NULL, safe_resume_receipt uuid NOT NULL REFERENCES release_ops.maintenance_safe_resume(id),
 wave_receipts jsonb NOT NULL, target_count bigint NOT NULL, target_digest text NOT NULL, step_counts jsonb NOT NULL,
 release_at timestamptz NOT NULL, certified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(isfinite(release_at) AND release_at>certified_at)
);
-- Only this projection is public. It proves an explicit completed credit boundary;
-- neither the normal target nor the maximum deadline can populate it.
CREATE TABLE public.engine_maintenance_global_releases (
 interval_id uuid PRIMARY KEY REFERENCES release_ops.maintenance_operations(interval_id), receipt_id uuid NOT NULL UNIQUE REFERENCES release_ops.maintenance_global_receipts(id),
 generation bigint NOT NULL, release_at timestamptz NOT NULL, certified_at timestamptz NOT NULL
);
ALTER TABLE public.engine_maintenance_global_releases ENABLE ROW LEVEL SECURITY;
CREATE POLICY maintenance_global_release_read ON public.engine_maintenance_global_releases FOR SELECT TO anon,authenticated,service_role USING(true);
REVOKE ALL ON public.engine_maintenance_global_releases FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.engine_maintenance_global_releases TO anon,authenticated,service_role;
CREATE TRIGGER maintenance_global_release_immutable BEFORE UPDATE OR DELETE ON public.engine_maintenance_global_releases FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE TRIGGER maintenance_global_receipt_immutable BEFORE UPDATE OR DELETE ON release_ops.maintenance_global_receipts FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE FUNCTION release_ops.guard_global_checkpoint() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'completed_at') IS DISTINCT FROM (to_jsonb(OLD)-'completed_at')
 OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
 THEN RAISE EXCEPTION 'MAINTENANCE_GLOBAL_CHECKPOINT_IMMUTABLE'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER maintenance_global_checkpoint_immutable BEFORE UPDATE OR DELETE ON release_ops.maintenance_global_checkpoints FOR EACH ROW EXECUTE FUNCTION release_ops.guard_global_checkpoint();

-- This is the latest SQL-level check available before transaction commit.
-- It also covers deferred FK/trigger work and delayed final receipt insertion.
-- PostgreSQL may still stall after deferred triggers while committing WAL; that
-- residual commit/visibility timing is an explicit activation limitation.
CREATE FUNCTION release_ops.check_global_certificate_at_commit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE endpoint timestamptz;
BEGIN
 SELECT release_at INTO endpoint FROM release_ops.maintenance_global_receipts WHERE interval_id=NEW.interval_id;
 IF endpoint IS NULL OR clock_timestamp()>=endpoint THEN
  RAISE EXCEPTION 'MAINTENANCE_GLOBAL_CERTIFICATE_ENDPOINT_ELAPSED' USING ERRCODE='40001';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER maintenance_private_certificate_commit AFTER INSERT ON release_ops.maintenance_global_receipts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION release_ops.check_global_certificate_at_commit();
CREATE CONSTRAINT TRIGGER maintenance_public_certificate_commit AFTER INSERT ON public.engine_maintenance_global_releases
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION release_ops.check_global_certificate_at_commit();

CREATE TABLE release_ops.maintenance_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), interval_id uuid REFERENCES release_ops.maintenance_operations(interval_id),
 kind text NOT NULL, data jsonb NOT NULL, principal text NOT NULL DEFAULT session_user, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Transaction/backend scoped, never granted to an engine or controller role.
CREATE TABLE release_ops.maintenance_write_permits (
 backend integer NOT NULL, transaction_id xid8 NOT NULL, interval_id uuid NOT NULL,
 PRIMARY KEY(backend,transaction_id,interval_id)
);
CREATE TABLE release_ops.maintenance_target_scope (
 freeze_started_at timestamptz NOT NULL, step text NOT NULL, target_id uuid NOT NULL, table_ids uuid[] NOT NULL,
 PRIMARY KEY(freeze_started_at,step,target_id),
 FOREIGN KEY(freeze_started_at,step,target_id) REFERENCES public.engine_maintenance_thaw_targets(freeze_started_at,step,target_id)
);
CREATE TABLE public.engine_maintenance_operation_signal (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), policy_version integer NOT NULL DEFAULT 1 CHECK(policy_version IN (1,2)),
 activation_receipt uuid, interval_id uuid, generation bigint, phase text, active boolean NOT NULL DEFAULT false,
 break_ends_at timestamptz, release_receipt uuid, reason text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.engine_maintenance_operation_signal(id) VALUES(true);
CREATE TABLE public.engine_maintenance_operation_status (
 interval_id uuid PRIMARY KEY, policy_version integer NOT NULL CHECK(policy_version=2), activation_receipt uuid NOT NULL,
 generation bigint NOT NULL, active boolean NOT NULL, phase text NOT NULL, break_ends_at timestamptz,
 release_receipt uuid, reason text NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE public.engine_maintenance_table_releases (
 interval_id uuid NOT NULL,table_id uuid NOT NULL,wave_receipt uuid NOT NULL,credited_through_at timestamptz NOT NULL,resumed_at timestamptz NOT NULL,
 PRIMARY KEY(interval_id,table_id),FOREIGN KEY(interval_id) REFERENCES release_ops.maintenance_operations(interval_id)
);
CREATE TRIGGER maintenance_table_release_immutable BEFORE UPDATE OR DELETE ON public.engine_maintenance_table_releases FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
ALTER TABLE public.engine_maintenance_table_releases ENABLE ROW LEVEL SECURITY;
CREATE POLICY maintenance_table_release_read ON public.engine_maintenance_table_releases FOR SELECT TO anon,authenticated,service_role USING(true);
REVOKE ALL ON public.engine_maintenance_table_releases FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.engine_maintenance_table_releases TO anon,authenticated,service_role;
ALTER TABLE public.engine_maintenance_operation_signal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engine_maintenance_operation_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY maintenance_signal_read ON public.engine_maintenance_operation_signal FOR SELECT TO anon,authenticated,service_role USING(true);
CREATE POLICY maintenance_status_read ON public.engine_maintenance_operation_status FOR SELECT TO anon,authenticated,service_role USING(true);
REVOKE ALL ON public.engine_maintenance_operation_signal,public.engine_maintenance_operation_status FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.engine_maintenance_operation_signal,public.engine_maintenance_operation_status TO anon,authenticated,service_role;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.engine_maintenance_operation_signal;
 END IF;
END $$;

CREATE FUNCTION release_ops.maintenance_signal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r uuid;
BEGIN
 SELECT receipt_id INTO r FROM release_ops.maintenance_activation WHERE singleton;
 IF TG_TABLE_NAME='maintenance_operations' THEN
  INSERT INTO public.engine_maintenance_operation_status VALUES(NEW.interval_id,2,NEW.activation_receipt,NEW.generation,
   NEW.phase<>'resumed',NEW.phase,CASE WHEN NEW.phase='resumed' THEN NEW.resumed_at ELSE NEW.target_at END,
   NEW.release_receipt,NEW.reason,clock_timestamp())
  ON CONFLICT(interval_id) DO UPDATE SET generation=excluded.generation,active=excluded.active,phase=excluded.phase,
   break_ends_at=excluded.break_ends_at,release_receipt=excluded.release_receipt,reason=excluded.reason,updated_at=excluded.updated_at;
  UPDATE public.engine_maintenance_operation_signal SET policy_version=CASE WHEN r IS NULL THEN 1 ELSE 2 END,
   activation_receipt=r,interval_id=NEW.interval_id,generation=NEW.generation,phase=NEW.phase,active=NEW.phase<>'resumed',
   break_ends_at=NEW.target_at,release_receipt=NEW.release_receipt,reason=NEW.reason,updated_at=clock_timestamp() WHERE id;
 ELSE
  UPDATE public.engine_maintenance_operation_signal SET policy_version=CASE WHEN r IS NULL THEN 1 ELSE 2 END,
   activation_receipt=r,updated_at=clock_timestamp() WHERE id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER maintenance_operation_signal AFTER INSERT OR UPDATE ON release_ops.maintenance_operations FOR EACH ROW EXECUTE FUNCTION release_ops.maintenance_signal();
CREATE TRIGGER maintenance_activation_signal AFTER UPDATE ON release_ops.maintenance_activation FOR EACH ROW EXECUTE FUNCTION release_ops.maintenance_signal();

CREATE FUNCTION release_ops.maintenance_permit(p_interval uuid,p_add boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_add THEN INSERT INTO release_ops.maintenance_write_permits VALUES(pg_backend_pid(),pg_current_xact_id(),p_interval) ON CONFLICT DO NOTHING;
 ELSE DELETE FROM release_ops.maintenance_write_permits WHERE backend=pg_backend_pid() AND transaction_id=pg_current_xact_id() AND interval_id=p_interval; END IF;
END $$;
CREATE FUNCTION release_ops.guard_operation_maintenance_rows() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o release_ops.maintenance_operations;
BEGIN
 SELECT * INTO o FROM release_ops.maintenance_operations WHERE phase<>'resumed';
 IF o.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM release_ops.maintenance_write_permits
  WHERE backend=pg_backend_pid() AND transaction_id=pg_current_xact_id() AND interval_id=o.interval_id) THEN
  RAISE EXCEPTION 'MAINTENANCE_OPERATION_ROW_OWNED' USING ERRCODE='55006';
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER operation_owned_break BEFORE INSERT OR UPDATE OR DELETE ON public.engine_maintenance_break FOR EACH ROW EXECUTE FUNCTION release_ops.guard_operation_maintenance_rows();
CREATE TRIGGER operation_owned_thaw BEFORE INSERT OR UPDATE OR DELETE ON public.engine_maintenance_thaws FOR EACH ROW EXECUTE FUNCTION release_ops.guard_operation_maintenance_rows();
CREATE TRIGGER operation_owned_target BEFORE INSERT OR UPDATE OR DELETE ON public.engine_maintenance_thaw_targets FOR EACH ROW EXECUTE FUNCTION release_ops.guard_operation_maintenance_rows();
CREATE FUNCTION release_ops.reject_legacy_maintenance_writer() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM release_ops.maintenance_activation WHERE receipt_id IS NOT NULL) THEN
  RAISE EXCEPTION 'MAINTENANCE_POLICY2_REQUIRES_OPERATION_AUTHORITY' USING ERRCODE='55006';
 END IF;
END $$;
CREATE FUNCTION release_ops.lock_maintenance_operation(p_interval uuid,p_token uuid DEFAULT NULL) RETURNS release_ops.maintenance_operations
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o release_ops.maintenance_operations;
BEGIN
 PERFORM pg_advisory_xact_lock(530090,1);
 SELECT * INTO o FROM release_ops.maintenance_operations WHERE interval_id=p_interval FOR UPDATE;
 IF o.operation_id IS NULL THEN RAISE EXCEPTION 'MAINTENANCE_INTERVAL_UNKNOWN'; END IF;
 IF p_token IS NOT NULL AND o.ownership_token IS DISTINCT FROM p_token THEN RAISE EXCEPTION 'MAINTENANCE_STALE_ENGINE_OWNER'; END IF;
 -- The certificate already committed the exact boundary. This mutation only
 -- records readback; pure public predicates enforce that boundary without it.
 IF o.phase<>'resumed' AND EXISTS(SELECT 1 FROM release_ops.maintenance_global_receipts r WHERE r.interval_id=o.interval_id AND r.release_at<=clock_timestamp()) THEN
  UPDATE release_ops.maintenance_operations SET phase='resumed',resumed_at=(SELECT release_at FROM release_ops.maintenance_global_receipts WHERE interval_id=o.interval_id),updated_at=clock_timestamp()
   WHERE interval_id=o.interval_id RETURNING * INTO o;
  INSERT INTO release_ops.maintenance_events(interval_id,kind,data) SELECT o.interval_id,'FULLY_RESUMED',jsonb_build_object('global_receipt',id,'resumed_at',release_at) FROM release_ops.maintenance_global_receipts WHERE interval_id=o.interval_id;
 END IF;
 IF o.phase NOT IN ('resumed','recovery_required') AND clock_timestamp()>=o.deadline_at
 AND NOT (o.phase IN ('release_authorized','releasing') AND o.release_authorized_at>=o.deadline_at) THEN
  UPDATE release_ops.maintenance_operations SET phase='recovery_required',reason='Maintenance requires verified recovery',updated_at=clock_timestamp()
   WHERE operation_id=o.operation_id RETURNING * INTO o;
  INSERT INTO release_ops.maintenance_events(interval_id,kind,data) VALUES(o.interval_id,'DEADLINE_REQUIRES_RECOVERY','{}');
 END IF;
 RETURN o;
END $$;
CREATE FUNCTION release_ops.maintenance_global_progress(p_interval uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE c release_ops.maintenance_global_checkpoints; r release_ops.maintenance_global_receipts; o release_ops.maintenance_operations; remaining bigint;
BEGIN
 SELECT * INTO c FROM release_ops.maintenance_global_checkpoints WHERE interval_id=p_interval ORDER BY checkpoint_no DESC LIMIT 1;
 IF c.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO o FROM release_ops.maintenance_operations WHERE interval_id=p_interval;
 SELECT * INTO r FROM release_ops.maintenance_global_receipts WHERE interval_id=p_interval;
 SELECT count(*) INTO remaining FROM public.engine_maintenance_thaw_targets t JOIN release_ops.maintenance_target_scope s USING(freeze_started_at,step,target_id)
 WHERE t.freeze_started_at=o.freeze_started_at AND cardinality(s.table_ids)=0 AND t.credited_seconds<extract(epoch FROM c.credited_through_at-o.freeze_started_at);
 RETURN jsonb_build_object('checkpoint_id',c.id,'checkpoint_no',c.checkpoint_no,'credited_through_at',c.credited_through_at,'remaining',remaining,
  'receipt_id',r.id,'receipt_ownership_token',r.ownership_token,'receipt_generation',r.generation,'certified_at',r.certified_at,
  'target_count',r.target_count,'target_digest',r.target_digest,
  'status',CASE WHEN r.id IS NULL THEN 'pending' WHEN r.release_at>clock_timestamp() THEN 'certified' ELSE 'released' END);
END $$;
CREATE FUNCTION release_ops.maintenance_snapshot(p_known_interval uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
DECLARE o release_ops.maintenance_operations; a uuid; result jsonb; waves jsonb; ts timestamptz;
BEGIN
 SELECT receipt_id INTO a FROM release_ops.maintenance_activation WHERE singleton;
 IF p_known_interval IS NOT NULL THEN SELECT * INTO o FROM release_ops.maintenance_operations WHERE interval_id=p_known_interval; END IF;
 IF o.operation_id IS NULL THEN SELECT * INTO o FROM release_ops.maintenance_operations WHERE phase<>'resumed'; END IF;
 IF o.operation_id IS NOT NULL THEN
  o:=release_ops.lock_maintenance_operation(o.interval_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('index',wave_index,'table_ids',table_ids,'receipt_id',receipt_id,
   'credited_through_at',credited_through_at,'resumed_at',resumed_at) ORDER BY wave_index),'[]') INTO waves
   FROM release_ops.maintenance_waves WHERE interval_id=o.interval_id;
  ts:=clock_timestamp();
  result:=jsonb_build_object('policy_version',2,'operation_id',o.operation_id,'release_id',o.release_id,'interval_id',o.interval_id,
   'ownership_token',o.ownership_token,'generation',o.generation,'phase',o.phase,'scope',o.scope,'freeze_started_at',o.freeze_started_at,
   'target_at',o.target_at,'forward_deadline_at',o.forward_deadline_at,'deadline_at',o.deadline_at,'observed_at',ts,
   'release_receipt',o.release_receipt,'reason',o.reason,'resume_waves',waves,'global_tail',release_ops.maintenance_global_progress(o.interval_id));
 END IF;
 RETURN jsonb_build_object('policy_version',CASE WHEN a IS NULL THEN 1 ELSE 2 END,'activation_receipt',a,
  'observed_at',COALESCE(ts,clock_timestamp()),'operation',result);
END $$;
CREATE FUNCTION public.fn_engine_maintenance_operation(p_known_interval_id uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT release_ops.maintenance_snapshot(p_known_interval_id) $$;
CREATE FUNCTION public.fn_maintenance_break_state_v2(p_table_id uuid DEFAULT NULL,p_known_interval_id uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE sql SET search_path=pg_catalog,public,pg_temp AS $$
 WITH signal AS (SELECT * FROM public.engine_maintenance_operation_signal WHERE id), chosen AS (
  SELECT s.* FROM public.engine_maintenance_operation_status s
  WHERE s.interval_id=p_known_interval_id OR (p_known_interval_id IS NULL AND s.active)
  ORDER BY (s.interval_id=p_known_interval_id) DESC,s.updated_at DESC LIMIT 1
 ) SELECT CASE WHEN c.interval_id IS NOT NULL THEN (to_jsonb(c)-'updated_at') || CASE WHEN w.table_id IS NOT NULL THEN jsonb_build_object('active',false,'phase','resumed','break_ends_at',w.resumed_at,'release_receipt',w.wave_receipt) WHEN g.interval_id IS NOT NULL AND g.release_at<=clock_timestamp() THEN jsonb_build_object('active',false,'phase','resumed','break_ends_at',g.release_at,'release_receipt',g.receipt_id) ELSE '{}'::jsonb END || jsonb_build_object('global_release_receipt',g.receipt_id,'global_release_at',g.release_at)
 WHEN p_known_interval_id IS NOT NULL THEN jsonb_build_object('policy_version',s.policy_version,'activation_receipt',s.activation_receipt,
  'interval_id',p_known_interval_id,'generation',NULL,'active',true,'phase','recovery_required','break_ends_at',NULL,'release_receipt',NULL,'reason','Maintenance identity requires reconciliation')
 ELSE jsonb_build_object('policy_version',s.policy_version,'activation_receipt',s.activation_receipt,'interval_id',NULL,'generation',NULL,
  'active',false,'phase',NULL,'break_ends_at',NULL,'release_receipt',NULL,'reason',NULL) END FROM signal s LEFT JOIN chosen c ON true LEFT JOIN public.engine_maintenance_table_releases w ON w.interval_id=c.interval_id AND w.table_id=p_table_id LEFT JOIN public.engine_maintenance_global_releases g ON g.interval_id=c.interval_id;
$$;

CREATE FUNCTION release_ops.register_maintenance_compatibility(p_installation_id uuid,p_components jsonb,p_evidence jsonb,p_actor text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE id uuid; k text; digest constant text:='1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda';
BEGIN
 PERFORM release_ops.valid_actor(p_actor);
 IF NOT EXISTS(SELECT 1 FROM release_ops.provider_installations WHERE provider_installations.id=p_installation_id)
 OR jsonb_typeof(p_components) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p_components))<>6
 OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' OR octet_length(p_evidence::text)>65536 THEN RAISE EXCEPTION 'MAINTENANCE_COMPATIBILITY_PROOF_REQUIRED'; END IF;
 FOREACH k IN ARRAY ARRAY['database','engine','client','controller','host_cutover','retained_recovery'] LOOP
  IF p_components->k->>'policy_version' IS DISTINCT FROM '2' OR p_components->k->>'policy_digest' IS DISTINCT FROM digest
  OR COALESCE(p_components->k->>'artifact_digest','') !~ '^[a-f0-9]{64}$'
  OR jsonb_typeof(p_components->k->'receipt_refs') IS DISTINCT FROM 'array' OR jsonb_array_length(p_components->k->'receipt_refs')=0
  THEN RAISE EXCEPTION 'MAINTENANCE_COMPONENT_COMPATIBILITY_REQUIRED: %',k; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=p_components->'host_cutover'->>'principal' AND r.rolcanlogin
  AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
  AND pg_has_role(r.oid,'release_journal_actuator','MEMBER')) THEN RAISE EXCEPTION 'MAINTENANCE_EXISTING_ACTUATOR_IDENTITY_REQUIRED'; END IF;
 IF p_evidence->>'forward_verified' IS DISTINCT FROM 'true' OR p_evidence->>'retained_recovery_verified' IS DISTINCT FROM 'true'
 OR p_evidence->>'long_hold_clock_verified' IS DISTINCT FROM 'true' OR p_evidence->>'resume_waves_verified' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'MAINTENANCE_ROLLBACK_COMPATIBILITY_REQUIRED'; END IF;
 INSERT INTO release_ops.maintenance_compatibility(installation_id,policy_digest,components,evidence,principal)
 VALUES(p_installation_id,digest,p_components,p_evidence,session_user) RETURNING maintenance_compatibility.id INTO id;
 RETURN id;
END $$;
CREATE FUNCTION release_ops.activate_operation_maintenance(owner uuid,epoch uuid,compatibility_receipt uuid,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE c release_ops.maintenance_compatibility; a uuid;
BEGIN
 PERFORM release_ops.valid_actor(actor); PERFORM release_ops.check_owner(owner,epoch);
 PERFORM pg_advisory_xact_lock(530090,1);
 SELECT * INTO c FROM release_ops.maintenance_compatibility WHERE id=compatibility_receipt;
 SELECT receipt_id INTO a FROM release_ops.maintenance_activation WHERE singleton FOR UPDATE;
 IF a IS NOT NULL THEN
  IF a<>compatibility_receipt THEN RAISE EXCEPTION 'MAINTENANCE_ACTIVATION_ALREADY_PINNED'; END IF;
  RETURN release_ops.maintenance_snapshot();
 END IF;
 IF c.id IS NULL OR c.installation_id::text IS DISTINCT FROM (SELECT installed_adapter_receipt FROM release_ops.controller WHERE singleton)
 THEN RAISE EXCEPTION 'MAINTENANCE_INSTALLED_COMPATIBILITY_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM public.engine_maintenance_break) OR public.fn_active_maintenance_release_boundary()>clock_timestamp()
 OR EXISTS(SELECT 1 FROM public.engine_maintenance_thaws WHERE COALESCE((shifted->>'complete')::boolean,false)=false)
 THEN RAISE EXCEPTION 'MAINTENANCE_LEGACY_INTERVAL_UNRESOLVED'; END IF;
 UPDATE release_ops.maintenance_activation SET receipt_id=c.id,activated_at=clock_timestamp(),owner_id=owner,epoch=activate_operation_maintenance.epoch WHERE singleton;
 PERFORM release_ops.event(NULL,'MAINTENANCE_POLICY_ACTIVATED',actor,jsonb_build_object('compatibility_receipt',c.id,'policy_digest',c.policy_digest));
 RETURN release_ops.maintenance_snapshot();
END $$;
CREATE FUNCTION release_ops.register_engine_maintenance_need(release_id uuid,readiness_event uuid,provider_plan_id uuid,evidence jsonb,actor text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; p release_ops.provider_plans; id uuid;
BEGIN
 PERFORM release_ops.valid_actor(actor); PERFORM 1 FROM release_ops.controller WHERE singleton FOR UPDATE;
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=register_engine_maintenance_need.release_id;
 SELECT * INTO p FROM release_ops.provider_plans WHERE provider_plans.id=provider_plan_id;
 IF q.release_id IS NULL OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id
 OR q.state<>'APPLYING' OR q.attempt_deadline<=clock_timestamp() OR p.id IS NULL OR p.release_id<>release_id
 OR p.adapter<>'hetzner-intake' OR p.request->>'target'<>'club-arena-engine'
 OR p.readiness_event::text IS DISTINCT FROM q.selected_receipts->>'READINESS' OR p.readiness_event IS DISTINCT FROM readiness_event
 OR p.recovery_id IS DISTINCT FROM q.recovery_id OR p.request->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR octet_length(evidence::text)>65536
 OR evidence->>'purpose' IS DISTINCT FROM 'engine_replacement' OR evidence->'scope' IS DISTINCT FROM '{"type":"platform"}'::jsonb
 OR evidence->>'policy_digest' IS DISTINCT FROM '1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda'
 OR jsonb_typeof(evidence->'receipt_refs') IS DISTINCT FROM 'array' OR jsonb_array_length(evidence->'receipt_refs')=0
 OR COALESCE(evidence->>'actual_recovery_ms','') !~ '^[1-9][0-9]{0,8}$' OR COALESCE(evidence->>'recovery_margin_ms','') !~ '^[1-9][0-9]{0,8}$'
 THEN RAISE EXCEPTION 'MAINTENANCE_VALIDATED_ENGINE_NEED_REQUIRED'; END IF;
 SELECT n.id INTO id FROM release_ops.maintenance_needs n WHERE n.release_id=release_id AND n.readiness_event=readiness_event AND n.provider_plan_id=provider_plan_id;
 IF id IS NOT NULL THEN
  IF (SELECT n.evidence FROM release_ops.maintenance_needs n WHERE n.id=id) IS DISTINCT FROM evidence THEN RAISE EXCEPTION 'MAINTENANCE_NEED_REPLAY_MISMATCH'; END IF;
  RETURN id;
 END IF;
 INSERT INTO release_ops.maintenance_needs(release_id,readiness_event,provider_plan_id,recovery_id,manifest_digest,evidence,principal)
 VALUES(release_id,readiness_event,provider_plan_id,q.recovery_id,q.resolution_manifest_digest,evidence,session_user) RETURNING maintenance_needs.id INTO id;
 RETURN id;
END $$;
CREATE FUNCTION release_ops.admit_engine_maintenance(owner uuid,epoch uuid,release_id uuid,need_receipt uuid,estimated_ms bigint,recovery_ms bigint,margin_ms bigint,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE n release_ops.maintenance_needs; q release_ops.queue; a uuid; o release_ops.maintenance_operations; ts timestamptz;
BEGIN
 PERFORM release_ops.valid_actor(actor); PERFORM release_ops.check_owner(owner,epoch);
 PERFORM pg_advisory_xact_lock(530090,1);
 SELECT receipt_id INTO a FROM release_ops.maintenance_activation WHERE singleton;
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=admit_engine_maintenance.release_id;
 SELECT * INTO n FROM release_ops.maintenance_needs WHERE id=need_receipt;
 SELECT * INTO o FROM release_ops.maintenance_operations WHERE phase<>'resumed';
 IF o.operation_id IS NOT NULL THEN
  IF o.release_id<>release_id OR o.need_receipt<>need_receipt THEN RAISE EXCEPTION 'MAINTENANCE_CONTINUOUS_HOLD_EXISTS'; END IF;
  RETURN release_ops.maintenance_snapshot(o.interval_id);
 END IF;
 IF a IS NULL OR n.id IS NULL OR n.release_id IS DISTINCT FROM release_id OR q.state<>'APPLYING'
 OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id
 OR n.readiness_event::text IS DISTINCT FROM q.selected_receipts->>'READINESS' OR n.recovery_id IS DISTINCT FROM q.recovery_id
 OR n.manifest_digest IS DISTINCT FROM q.resolution_manifest_digest OR q.attempt_deadline<=clock_timestamp()
 OR estimated_ms IS NULL OR estimated_ms<1 OR recovery_ms IS NULL OR recovery_ms<(n.evidence->>'actual_recovery_ms')::bigint
 OR margin_ms IS NULL OR margin_ms<(n.evidence->>'recovery_margin_ms')::bigint
 OR estimated_ms+margin_ms>1200000 OR estimated_ms+GREATEST(600000,recovery_ms)+margin_ms>1800000
 THEN RAISE EXCEPTION 'MAINTENANCE_ADMISSION_NOT_QUALIFIED'; END IF;
 IF EXISTS(SELECT 1 FROM public.engine_maintenance_break) OR public.fn_active_maintenance_release_boundary()>clock_timestamp()
 THEN RAISE EXCEPTION 'MAINTENANCE_PRIOR_INTERVAL_NOT_RELEASED'; END IF;
 ts:=date_trunc('milliseconds',clock_timestamp());
 INSERT INTO release_ops.maintenance_operations(release_id,need_receipt,activation_receipt,controller_owner,controller_epoch,phase,scope,
 freeze_started_at,target_at,forward_deadline_at,deadline_at,reason,declared_by)
 VALUES(release_id,need_receipt,a,owner,epoch,'last_hand','{"type":"platform"}',ts,ts+interval '300 seconds',ts+interval '1200 seconds',ts+interval '1800 seconds','Engine maintenance',actor) RETURNING * INTO o;
 INSERT INTO release_ops.maintenance_tables SELECT o.interval_id,t.id,t.tournament_id FROM public.tables t
 WHERE t.status::text IN ('running','waiting') AND (t.tournament_id IS NULL OR EXISTS(SELECT 1 FROM public.tournaments x WHERE x.id=t.tournament_id AND x.status::text IN ('RUNNING','REGISTERING','SCHEDULED')));
 PERFORM release_ops.maintenance_permit(o.interval_id,true);
 INSERT INTO public.engine_maintenance_break(id,phase,announced_at,break_started_at,break_ends_at,reason,declared_by,enforce_freeze,ownership_token)
 VALUES(true,'counting_down',ts,ts,ts+interval '300 seconds',o.reason,actor,true,o.ownership_token);
 PERFORM release_ops.maintenance_permit(o.interval_id,false);
 PERFORM release_ops.event(release_id,'MAINTENANCE_ADMITTED',actor,jsonb_build_object('operation_id',o.operation_id,'interval_id',o.interval_id,'need_receipt',need_receipt,'freeze_started_at',ts));
 RETURN release_ops.maintenance_snapshot(o.interval_id);
END $$;

CREATE FUNCTION public.fn_claim_engine_maintenance_operation(p_interval_id uuid,p_expected_ownership_token uuid,p_new_ownership_token uuid,p_declared_by text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o release_ops.maintenance_operations;
BEGIN
 IF p_expected_ownership_token IS NULL OR p_new_ownership_token IS NULL OR p_new_ownership_token=p_expected_ownership_token
 OR length(COALESCE(p_declared_by,'')) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'MAINTENANCE_OWNER_IDENTITY_REQUIRED'; END IF;
 o:=release_ops.lock_maintenance_operation(p_interval_id,p_expected_ownership_token);
 IF o.phase='resumed' THEN RETURN release_ops.maintenance_snapshot(p_interval_id); END IF;
 PERFORM release_ops.maintenance_permit(p_interval_id,true);
 UPDATE release_ops.maintenance_operations SET ownership_token=p_new_ownership_token,generation=generation+1,declared_by=p_declared_by,
 phase=CASE WHEN EXISTS(SELECT 1 FROM release_ops.maintenance_waves WHERE interval_id=p_interval_id AND receipt_id IS NOT NULL AND resumed_at IS NULL)
  THEN 'recovery_required' ELSE phase END,updated_at=clock_timestamp() WHERE interval_id=p_interval_id;
 UPDATE public.engine_maintenance_break SET ownership_token=p_new_ownership_token,declared_by=p_declared_by,updated_at=clock_timestamp()
 WHERE id AND ownership_token=p_expected_ownership_token AND announced_at=o.freeze_started_at;
 UPDATE public.engine_maintenance_thaws SET ownership_token=p_new_ownership_token
 WHERE freeze_started_at=o.freeze_started_at AND ownership_token=p_expected_ownership_token AND contract_version=3;
 PERFORM release_ops.maintenance_permit(p_interval_id,false);
 INSERT INTO release_ops.maintenance_events(interval_id,kind,data) VALUES(p_interval_id,'ENGINE_OWNER_ADOPTED',jsonb_build_object('generation',o.generation+1));
 RETURN release_ops.maintenance_snapshot(p_interval_id);
END $$;
CREATE FUNCTION public.fn_engine_maintenance_ready(p_interval_id uuid,p_ownership_token uuid,p_table_ids uuid[],p_proof jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o release_ops.maintenance_operations; planned uuid[]; admitted uuid[]; supplied uuid[]; groups jsonb; v_group jsonb; idx integer:=0;
BEGIN
 IF p_ownership_token IS NULL THEN RAISE EXCEPTION 'MAINTENANCE_OWNER_IDENTITY_REQUIRED'; END IF;
 o:=release_ops.lock_maintenance_operation(p_interval_id,p_ownership_token);
 IF o.phase NOT IN ('last_hand','draining','ready') THEN RAISE EXCEPTION 'MAINTENANCE_READY_PHASE_INVALID'; END IF;
 IF jsonb_typeof(p_proof) IS DISTINCT FROM 'object' OR p_proof->>'policy_version' IS DISTINCT FROM '2'
 OR p_proof->>'policy_digest' IS DISTINCT FROM '1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda'
 OR length(COALESCE(p_proof->>'runtime_version','')) NOT BETWEEN 1 AND 200 OR p_proof->>'parked' IS DISTINCT FROM 'true'
 OR p_proof->>'between_hands' IS DISTINCT FROM 'true' OR p_proof->>'pending_mutations' IS DISTINCT FROM '0'
 OR jsonb_typeof(p_proof->'resume_wave_table_ids') IS DISTINCT FROM 'array' OR octet_length(p_proof::text)>1048576
 THEN RAISE EXCEPTION 'MAINTENANCE_REAL_DRAIN_PROOF_REQUIRED'; END IF;
 groups:=p_proof->'resume_wave_table_ids';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(groups) g WHERE jsonb_typeof(g)<>'array' OR jsonb_array_length(g)=0)
 THEN RAISE EXCEPTION 'MAINTENANCE_WAVE_PLAN_INVALID'; END IF;
 SELECT COALESCE(array_agg(x ORDER BY x),'{}') INTO planned FROM jsonb_array_elements(groups) g CROSS JOIN LATERAL jsonb_array_elements_text(g) s CROSS JOIN LATERAL (SELECT s::uuid x) v;
 SELECT COALESCE(array_agg(table_id ORDER BY table_id),'{}') INTO admitted FROM release_ops.maintenance_tables WHERE interval_id=p_interval_id;
 SELECT COALESCE(array_agg(x ORDER BY x),'{}') INTO supplied FROM unnest(p_table_ids) x;
 IF planned IS DISTINCT FROM admitted OR supplied IS DISTINCT FROM admitted THEN RAISE EXCEPTION 'MAINTENANCE_DRAIN_INVENTORY_MISMATCH'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(groups) WITH ORDINALITY g(ids,idx)
 CROSS JOIN LATERAL jsonb_array_elements_text(g.ids) s JOIN release_ops.maintenance_tables t ON t.table_id=s::uuid AND t.interval_id=p_interval_id
 WHERE t.tournament_id IS NOT NULL GROUP BY t.tournament_id HAVING count(DISTINCT g.idx)>1)
 THEN RAISE EXCEPTION 'MAINTENANCE_EVENT_WAVE_SPLIT'; END IF;
 IF EXISTS(SELECT 1 FROM release_ops.maintenance_waves WHERE interval_id=p_interval_id) THEN
  IF groups IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(table_ids) ORDER BY wave_index) FROM release_ops.maintenance_waves WHERE interval_id=p_interval_id)
  THEN RAISE EXCEPTION 'MAINTENANCE_WAVE_PLAN_IMMUTABLE'; END IF;
 ELSE
  FOR v_group IN SELECT value FROM jsonb_array_elements(groups) LOOP
   INSERT INTO release_ops.maintenance_waves(interval_id,wave_index,table_ids,ownership_token)
   SELECT p_interval_id,idx,array_agg(s::uuid ORDER BY n),p_ownership_token FROM jsonb_array_elements_text(v_group) WITH ORDINALITY x(s,n);
   idx:=idx+1;
  END LOOP;
 END IF;
 UPDATE release_ops.maintenance_operations SET phase='ready',ready_at=COALESCE(ready_at,clock_timestamp()),updated_at=clock_timestamp() WHERE interval_id=p_interval_id;
 INSERT INTO release_ops.maintenance_events(interval_id,kind,data) VALUES(p_interval_id,'ENGINE_READY',p_proof);
 RETURN release_ops.maintenance_snapshot(p_interval_id);
END $$;
CREATE FUNCTION public.fn_engine_maintenance_recovery(p_interval_id uuid,p_ownership_token uuid,p_reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o release_ops.maintenance_operations;
BEGIN
 IF p_ownership_token IS NULL OR length(COALESCE(p_reason,'')) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'MAINTENANCE_RECOVERY_REASON_REQUIRED'; END IF;
 o:=release_ops.lock_maintenance_operation(p_interval_id,p_ownership_token);
 IF o.phase<>'resumed' AND NOT EXISTS(SELECT 1 FROM release_ops.maintenance_global_receipts WHERE interval_id=p_interval_id) THEN
  UPDATE release_ops.maintenance_operations SET phase=CASE WHEN clock_timestamp()>=o.deadline_at THEN 'recovery_required' ELSE 'recovering' END,reason='Maintenance requires verified recovery',updated_at=clock_timestamp() WHERE interval_id=p_interval_id;
  INSERT INTO release_ops.maintenance_events(interval_id,kind,data) VALUES(p_interval_id,'ENGINE_RECOVERY_REQUIRED',jsonb_build_object('reason',p_reason));
 END IF;
 RETURN release_ops.maintenance_snapshot(p_interval_id);
END $$;
CREATE FUNCTION release_ops.authorize_maintenance_step(owner uuid,epoch uuid,operation_id uuid,step_key text,estimated_ms bigint,recovery_ms bigint,margin_ms bigint,kind text,proof_receipt uuid,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE o release_ops.maintenance_operations; s release_ops.maintenance_steps; n release_ops.maintenance_needs; ts timestamptz; fits boolean;
BEGIN
 PERFORM release_ops.valid_actor(actor); PERFORM release_ops.check_owner(owner,epoch);
 SELECT * INTO o FROM release_ops.maintenance_operations WHERE maintenance_operations.operation_id=authorize_maintenance_step.operation_id;
 o:=release_ops.lock_maintenance_operation(o.interval_id);
 IF o.release_id IS DISTINCT FROM (SELECT active_release FROM release_ops.controller WHERE singleton) THEN RAISE EXCEPTION 'RELEASE_NOT_ACTIVE'; END IF;
 SELECT * INTO n FROM release_ops.maintenance_needs WHERE id=o.need_receipt;
 SELECT * INTO s FROM release_ops.maintenance_steps WHERE maintenance_steps.operation_id=authorize_maintenance_step.operation_id AND maintenance_steps.step_key=authorize_maintenance_step.step_key;
 IF s.id IS NOT NULL THEN
  IF s.owner_id<>owner OR s.epoch<>epoch OR s.kind<>kind OR s.estimated_ms<>estimated_ms OR s.recovery_ms<>recovery_ms OR s.margin_ms<>margin_ms OR s.proof_receipt<>proof_receipt
  THEN RAISE EXCEPTION 'MAINTENANCE_STEP_REPLAY_OR_OWNER_MISMATCH'; END IF;
  RETURN jsonb_build_object('authorized',false,'reason','previous_authorization_requires_readback','step',to_jsonb(s),'snapshot',release_ops.maintenance_snapshot(o.interval_id));
 END IF;
 IF step_key IS NULL OR length(step_key) NOT BETWEEN 1 AND 200 OR kind IS NULL OR kind NOT IN ('engine_cutover','recovery')
 OR estimated_ms IS NULL OR estimated_ms NOT BETWEEN 1 AND 1800000 OR recovery_ms IS NULL OR recovery_ms NOT BETWEEN 1 AND 1800000
 OR margin_ms IS NULL OR margin_ms NOT BETWEEN 1 AND 1800000 OR recovery_ms<(n.evidence->>'actual_recovery_ms')::bigint
 OR margin_ms<(n.evidence->>'recovery_margin_ms')::bigint OR proof_receipt IS NULL
 THEN RAISE EXCEPTION 'MAINTENANCE_STEP_ESTIMATE_REQUIRED'; END IF;
 IF kind='engine_cutover' AND (proof_receipt<>n.id OR n.readiness_event::text IS DISTINCT FROM (SELECT selected_receipts->>'READINESS' FROM release_ops.queue WHERE release_id=o.release_id)
 OR o.phase NOT IN ('ready','applying')) THEN RAISE EXCEPTION 'MAINTENANCE_CURRENT_READY_RECEIPT_REQUIRED'; END IF;
 IF kind='recovery' AND NOT EXISTS(SELECT 1 FROM release_ops.recovery_revisions r JOIN release_ops.queue q ON q.recovery_id=r.id
  WHERE q.release_id=o.release_id AND r.event_id=proof_receipt AND r.deadline>clock_timestamp()) THEN RAISE EXCEPTION 'MAINTENANCE_CURRENT_RECOVERY_PROOF_REQUIRED'; END IF;
 ts:=clock_timestamp();
 fits:=ts+make_interval(secs=>(estimated_ms+margin_ms)/1000.0)<=o.deadline_at;
 IF kind='engine_cutover' THEN fits:=fits AND ts+make_interval(secs=>(estimated_ms+margin_ms)/1000.0)<=o.forward_deadline_at
  AND ts+make_interval(secs=>(estimated_ms+GREATEST(600000,recovery_ms)+margin_ms)/1000.0)<=o.deadline_at; END IF;
 IF NOT fits OR ts>=o.deadline_at THEN
  UPDATE release_ops.maintenance_operations SET phase='recovery_required',reason='Maintenance requires verified recovery',updated_at=ts WHERE interval_id=o.interval_id;
  INSERT INTO release_ops.maintenance_events(interval_id,kind,data) VALUES(o.interval_id,'STEP_BUDGET_REFUSED',jsonb_build_object('step_key',step_key,'estimated_ms',estimated_ms,'recovery_ms',recovery_ms,'margin_ms',margin_ms));
  RETURN jsonb_build_object('authorized',false,'reason','recovery_required','snapshot',release_ops.maintenance_snapshot(o.interval_id));
 END IF;
 INSERT INTO release_ops.maintenance_steps(operation_id,step_key,owner_id,epoch,kind,estimated_ms,recovery_ms,margin_ms,proof_receipt,authorized_at,not_after_at)
 VALUES(operation_id,step_key,owner,epoch,kind,estimated_ms,recovery_ms,margin_ms,proof_receipt,ts,
 CASE WHEN kind='engine_cutover' THEN LEAST(o.forward_deadline_at,o.deadline_at-make_interval(secs=>(GREATEST(600000,recovery_ms)+margin_ms)/1000.0)) ELSE o.deadline_at-make_interval(secs=>margin_ms/1000.0) END) RETURNING * INTO s;
 UPDATE release_ops.maintenance_operations SET controller_owner=owner,controller_epoch=epoch,phase=CASE WHEN kind='engine_cutover' THEN 'applying' ELSE 'recovering' END,updated_at=ts WHERE interval_id=o.interval_id;
 RETURN jsonb_build_object('authorized',true,'step',to_jsonb(s),'snapshot',release_ops.maintenance_snapshot(o.interval_id));
END $$;
CREATE FUNCTION release_ops.register_maintenance_safe_resume(operation_id uuid,provider_operation_id uuid,evidence jsonb,actor text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE o release_ops.maintenance_operations; e release_ops.external_operations; p release_ops.provider_plans; q release_ops.queue; n release_ops.maintenance_needs; k text; id uuid;
BEGIN
 PERFORM release_ops.valid_actor(actor); PERFORM 1 FROM release_ops.controller WHERE singleton FOR UPDATE;
 SELECT * INTO o FROM release_ops.maintenance_operations WHERE maintenance_operations.operation_id=register_maintenance_safe_resume.operation_id;
 o:=release_ops.lock_maintenance_operation(o.interval_id);
 SELECT * INTO e FROM release_ops.external_operations WHERE external_operations.id=provider_operation_id;
 SELECT * INTO p FROM release_ops.provider_plans WHERE provider_plans.id=(e.intent->>'plan_id')::uuid;
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=o.release_id;
 SELECT * INTO n FROM release_ops.maintenance_needs WHERE id=o.need_receipt;
 IF o.release_id IS DISTINCT FROM (SELECT active_release FROM release_ops.controller WHERE singleton) OR e.id IS NULL OR e.release_id<>o.release_id
 OR e.kind<>'PUBLISH' OR e.status<>'SUCCEEDED' OR e.intent->>'target' IS DISTINCT FROM 'club-arena-engine'
 OR e.intent->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest OR p.id IS NULL OR p.release_id<>o.release_id
 OR p.readiness_event::text IS DISTINCT FROM q.selected_receipts->>'READINESS' OR p.recovery_id IS DISTINCT FROM q.recovery_id
 OR p.request IS DISTINCT FROM e.intent->'provider_request' OR p.request->>'artifact_image_id' IS DISTINCT FROM e.result->>'image_id'
 OR p.request->>'source_sha' IS DISTINCT FROM e.result->>'source_sha' OR p.request->>'run_key' IS DISTINCT FROM e.result->>'run_key'
 OR e.result->>'terminal' IS DISTINCT FROM 'true' OR e.result->>'outcome' IS DISTINCT FROM 'SUCCEEDED'
 OR e.result->>'operation_id' IS DISTINCT FROM e.id::text OR e.result->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR e.result->>'result' NOT IN ('sealed','already-released') OR e.result->>'provider' IS DISTINCT FROM 'hetzner-engine'
 OR jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR octet_length(evidence::text)>65536
 OR evidence->>'policy_digest' IS DISTINCT FROM '1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda'
 OR evidence->>'source_sha' IS DISTINCT FROM e.result->>'source_sha' OR evidence->>'image_id' IS DISTINCT FROM e.result->>'image_id'
 OR evidence->>'readiness_event' IS DISTINCT FROM p.readiness_event::text OR evidence->>'schema_compatible' IS DISTINCT FROM 'true'
 OR evidence->>'retained_recovery_compatible' IS DISTINCT FROM 'true'
 THEN RAISE EXCEPTION 'MAINTENANCE_SAFE_RESUME_PROOF_REQUIRED'; END IF;
 FOREACH k IN ARRAY ARRAY['native_seal','local_runtime','public_runtime','database_leader','retired_writers','schema','retained_recovery'] LOOP
  IF jsonb_typeof(evidence->'checks'->k) IS DISTINCT FROM 'array' OR jsonb_array_length(evidence->'checks'->k)=0 THEN RAISE EXCEPTION 'MAINTENANCE_SAFE_RESUME_CHECK_REQUIRED: %',k; END IF;
 END LOOP;
 SELECT s.id INTO id FROM release_ops.maintenance_safe_resume s WHERE s.operation_id=operation_id AND s.provider_operation_id=provider_operation_id;
 IF id IS NOT NULL THEN
  IF (SELECT s.evidence FROM release_ops.maintenance_safe_resume s WHERE s.id=id) IS DISTINCT FROM evidence THEN RAISE EXCEPTION 'MAINTENANCE_SAFE_RESUME_REPLAY_MISMATCH'; END IF;
  RETURN id;
 END IF;
 INSERT INTO release_ops.maintenance_safe_resume(operation_id,provider_operation_id,evidence,principal) VALUES(operation_id,provider_operation_id,evidence,session_user) RETURNING maintenance_safe_resume.id INTO id;
 RETURN id;
END $$;
CREATE FUNCTION release_ops.authorize_maintenance_release(owner uuid,epoch uuid,operation_id uuid,safe_resume_receipt uuid,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE o release_ops.maintenance_operations; s release_ops.maintenance_safe_resume; e release_ops.external_operations; q release_ops.queue;
BEGIN
 PERFORM release_ops.valid_actor(actor); PERFORM release_ops.check_owner(owner,epoch);
 SELECT * INTO o FROM release_ops.maintenance_operations WHERE maintenance_operations.operation_id=authorize_maintenance_release.operation_id;
 o:=release_ops.lock_maintenance_operation(o.interval_id);
 SELECT * INTO s FROM release_ops.maintenance_safe_resume WHERE id=safe_resume_receipt;
 SELECT * INTO e FROM release_ops.external_operations WHERE id=s.provider_operation_id;
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=o.release_id;
 IF o.release_id IS DISTINCT FROM (SELECT active_release FROM release_ops.controller WHERE singleton) OR s.id IS NULL OR s.operation_id<>o.operation_id
 OR e.status<>'SUCCEEDED' OR s.evidence->>'readiness_event' IS DISTINCT FROM q.selected_receipts->>'READINESS'
 OR e.intent->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest OR o.ready_at IS NULL
 OR EXISTS(SELECT 1 FROM release_ops.maintenance_waves WHERE interval_id=o.interval_id AND receipt_id IS NOT NULL AND resumed_at IS NULL)
 THEN RAISE EXCEPTION 'MAINTENANCE_RELEASE_PROOF_STALE_OR_UNKNOWN'; END IF;
 IF o.release_receipt IS NOT NULL THEN
  IF o.release_receipt<>safe_resume_receipt THEN RAISE EXCEPTION 'MAINTENANCE_RELEASE_RECEIPT_IMMUTABLE'; END IF;
  RETURN release_ops.maintenance_snapshot(o.interval_id);
 END IF;
 -- A verified recovery can release after the budget, but the deadline itself never can.
 UPDATE release_ops.maintenance_operations SET phase='release_authorized',release_receipt=s.id,release_authorized_at=clock_timestamp(),
  controller_owner=owner,controller_epoch=epoch,updated_at=clock_timestamp() WHERE interval_id=o.interval_id;
 RETURN release_ops.maintenance_snapshot(o.interval_id);
END $$;

CREATE FUNCTION release_ops.engine_maintenance_verification_context(release_id uuid,operation_id uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; p release_ops.provider_plans; e release_ops.external_operations; o release_ops.maintenance_operations; n uuid; s uuid; r jsonb;
BEGIN
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=engine_maintenance_verification_context.release_id;
 IF q.release_id IS NULL OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id THEN RAISE EXCEPTION 'RELEASE_NOT_ACTIVE'; END IF;
 SELECT * INTO p FROM release_ops.provider_plans x WHERE x.release_id=release_id AND x.adapter='hetzner-intake'
 AND x.readiness_event::text=q.selected_receipts->>'READINESS' AND x.recovery_id IS NOT DISTINCT FROM q.recovery_id
 AND x.request->>'manifest_digest'=q.resolution_manifest_digest ORDER BY x.event_no DESC LIMIT 1;
 SELECT * INTO e FROM release_ops.external_operations x WHERE x.release_id=release_id AND x.kind='PUBLISH'
 AND x.intent->>'plan_id'=p.id::text ORDER BY x.id LIMIT 1;
 SELECT * INTO o FROM release_ops.maintenance_operations x WHERE x.release_id=release_id
 AND (operation_id IS NULL OR x.operation_id=operation_id) ORDER BY x.freeze_started_at DESC LIMIT 1;
 SELECT id INTO n FROM release_ops.maintenance_needs x WHERE x.release_id=release_id AND x.provider_plan_id=p.id AND x.readiness_event=p.readiness_event;
 SELECT id INTO s FROM release_ops.maintenance_safe_resume x WHERE x.operation_id=o.operation_id AND x.provider_operation_id=e.id;
 SELECT jsonb_object_agg(kind,to_jsonb(x)) INTO r FROM release_ops.receipts x WHERE x.release_id=release_id
 AND x.kind IN ('BUILD','READINESS') AND x.event_id::text=q.selected_receipts->>x.kind;
 RETURN jsonb_build_object('queue',to_jsonb(q),'receipts',r,'provider_plan',CASE WHEN p.id IS NULL THEN NULL ELSE to_jsonb(p) END,
 'provider_operation',CASE WHEN e.id IS NULL THEN NULL ELSE to_jsonb(e) END,'operation',CASE WHEN o.operation_id IS NULL THEN NULL ELSE to_jsonb(o) END,
 'need_receipt',n,'need_evidence',(SELECT x.evidence FROM release_ops.maintenance_needs x WHERE x.id=n),'safe_resume_receipt',s,'next_check_at',(SELECT x.next_check_at FROM release_ops.maintenance_observations x WHERE x.operation_id=o.operation_id ORDER BY check_no DESC LIMIT 1),'steps',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY authorized_at) FROM release_ops.maintenance_steps x WHERE x.operation_id=o.operation_id),'[]'::jsonb));
END $$;
CREATE FUNCTION release_ops.snapshot_operation_target_scope(p_interval uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE o release_ops.maintenance_operations; x record; tids uuid[]; tid uuid; tournament uuid;
BEGIN
 SELECT * INTO o FROM release_ops.maintenance_operations WHERE interval_id=p_interval;
 FOR x IN SELECT t.* FROM public.engine_maintenance_thaw_targets t WHERE freeze_started_at=o.freeze_started_at LOOP
  tid:=NULL; tournament:=NULL;
  CASE x.step
   WHEN 'sit_out_at' THEN SELECT table_id INTO tid FROM public.table_seats WHERE id=x.target_id;
   WHEN 'hold_expires_at' THEN SELECT table_id INTO tid FROM public.table_waitlist WHERE id=x.target_id;
   WHEN 'addon_period_ends_at' THEN NULL; -- Buying remains globally held through the certified purchasing release.
   WHEN 'level_started_at' THEN tournament:=x.target_id;
   WHEN 'reversible_until' THEN SELECT table_id INTO tid FROM public.chip_transactions WHERE id=x.target_id;
   WHEN 'reveal_deadline_at' THEN SELECT tournament_id INTO tournament FROM public.tournament_bounty_awards WHERE id=x.target_id;
   WHEN 'rebuy_prompt_until' THEN SELECT tournament_id INTO tournament FROM public.tournament_players WHERE id=x.target_id;
   WHEN 'bomb_pot_next_due_at','cluster_break_eligible_since','reconnect_presence' THEN tid:=x.target_id;
   WHEN 'cash_stay_last_tick_at' THEN SELECT (to_jsonb(t)->>'table_id')::uuid INTO tid FROM public.cash_player_session t WHERE id=x.target_id;
   WHEN 'cash_rejoin_expires_at' THEN SELECT (to_jsonb(t)->>'table_id')::uuid INTO tid FROM public.cash_rejoin_constraints t WHERE id=x.target_id;
   WHEN 'cluster_move_expires_at' THEN NULL; -- Cross-table move authority remains globally held until every wave returns.
   WHEN 'reconnect_snapshots' THEN SELECT table_id INTO tid FROM public.hand_state_snapshots WHERE id=x.target_id;
   ELSE RAISE EXCEPTION 'MAINTENANCE_CLOCK_CLASS_UNMAPPED: %',x.step;
  END CASE;
  SELECT COALESCE(array_agg(t.table_id ORDER BY t.table_id),'{}') INTO tids FROM release_ops.maintenance_tables t
   WHERE t.interval_id=p_interval AND (t.table_id=tid OR (tournament IS NOT NULL AND t.tournament_id=tournament));
  INSERT INTO release_ops.maintenance_target_scope VALUES(o.freeze_started_at,x.step,x.target_id,tids) ON CONFLICT DO NOTHING;
 END LOOP;
END $$;
CREATE FUNCTION release_ops.operation_target_in_wave(p_freeze timestamptz,p_step text,p_target uuid,p_interval uuid,p_wave integer) RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM release_ops.maintenance_target_scope s WHERE s.freeze_started_at=p_freeze AND s.step=p_step AND s.target_id=p_target
  AND CASE WHEN p_wave=-1 THEN cardinality(s.table_ids)=0 ELSE cardinality(s.table_ids)>0 AND s.table_ids <@ (
   SELECT w.table_ids FROM release_ops.maintenance_waves w WHERE w.interval_id=p_interval AND w.wave_index=p_wave) END)
$$;

CREATE FUNCTION release_ops.retained_v3_thaw(p_announced_at timestamp with time zone, p_freeze_started timestamp with time zone, p_frozen_seconds numeric, p_ownership_token uuid, p_thawed_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '35s'
 SET lock_timeout TO '32s'
AS $function$
DECLARE
  c_contract_version CONSTANT integer := 3;
  c_required_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_now timestamptz;
  v_due_at timestamptz;
  v_break public.engine_maintenance_break%ROWTYPE;
  v_expected_start timestamptz;
  v_effective_seconds numeric;
  v_existing public.engine_maintenance_thaws%ROWTYPE;
  v_checkpoint_exists boolean;
  v_result jsonb;
  v_shifted jsonb;
  v_target_count integer;
  v_reserve_seconds numeric;
  v_release_target timestamptz;
  v_retry_after_ms integer;
BEGIN
  IF p_announced_at IS NULL OR p_freeze_started IS NULL OR p_ownership_token IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_identity_required'
    );
  END IF;

  PERFORM pg_advisory_xact_lock(530090, 1);
  v_now := clock_timestamp();

  SELECT * INTO v_break
    FROM public.engine_maintenance_break b
   WHERE b.id = true
   FOR UPDATE;

  IF NOT FOUND THEN
    SELECT * INTO v_existing
      FROM public.engine_maintenance_thaws t
     WHERE t.freeze_started_at = p_freeze_started
       AND t.announced_at IS NOT DISTINCT FROM p_announced_at
       AND t.ownership_token = p_ownership_token;
    IF FOUND
       AND COALESCE(v_existing.contract_version, 0) = c_contract_version
       AND COALESCE((v_existing.shifted->>'complete')::boolean, false)
       AND v_existing.shifted ?& c_required_steps THEN
      RETURN jsonb_build_object(
        'ok', true, 'complete', true, 'retryable', false,
        'reason', 'release_receipt_recovered', 'released', true,
        'abandoned', false,
        'freeze_started_at', p_freeze_started,
        'credited_through_at', v_existing.release_target_at,
        'effective_frozen_seconds', v_existing.frozen_seconds,
        'ownership_token', p_ownership_token,
        'shifted', v_existing.shifted
      );
    END IF;
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_row_missing'
    );
  END IF;

  IF v_break.ownership_token <> p_ownership_token THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_ownership_changed'
    );
  END IF;

  v_expected_start := COALESCE(
    v_break.break_started_at,
    v_break.announced_at + INTERVAL '2 minutes'
  );
  IF v_break.announced_at IS DISTINCT FROM p_announced_at
     OR v_expected_start IS DISTINCT FROM p_freeze_started THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_identity_mismatch'
    );
  END IF;

  v_due_at := COALESCE(
    v_break.break_ends_at,
    v_break.announced_at + INTERVAL '7 minutes'
  );
  IF v_now < v_due_at THEN
    v_retry_after_ms := GREATEST(
      1,
      CEIL(EXTRACT(EPOCH FROM (v_due_at - v_now)) * 1000)::integer
    );
    RETURN jsonb_build_object(
      'ok', true, 'complete', false, 'retryable', true,
      'reason', 'maintenance_break_not_due', 'released', false,
      'retry_after_ms', v_retry_after_ms,
      'freeze_started_at', p_freeze_started,
      'ownership_token', p_ownership_token
    );
  END IF;

  SELECT * INTO v_existing
    FROM public.engine_maintenance_thaws t
   WHERE t.freeze_started_at = p_freeze_started
   FOR UPDATE;
  v_checkpoint_exists := FOUND;

  IF v_checkpoint_exists
     AND v_existing.announced_at IS DISTINCT FROM p_announced_at THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_checkpoint_identity_mismatch'
    );
  END IF;

  -- A replacement process adopts the exact break row under this same lock.
  -- Carry that proven ownership into an in-flight v3 checkpoint so recovery
  -- can continue; the retired token fails against the row before reaching it.
  IF v_checkpoint_exists
     AND v_existing.ownership_token IS DISTINCT FROM p_ownership_token
     AND COALESCE(v_existing.contract_version,0)=c_contract_version THEN
    UPDATE public.engine_maintenance_thaws t
       SET ownership_token=p_ownership_token, thawed_by=p_thawed_by
     WHERE t.freeze_started_at=p_freeze_started
       AND t.announced_at IS NOT DISTINCT FROM p_announced_at
       AND t.ownership_token IS NOT DISTINCT FROM v_existing.ownership_token;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'ok', false, 'complete', false, 'retryable', false,
        'reason', 'maintenance_checkpoint_identity_mismatch'
      );
    END IF;
    v_existing.ownership_token := p_ownership_token;
  END IF;

  -- A legacy partial checkpoint has aggregate counts but no row identities.
  -- Inventing row receipts for it could double-shift one clock and omit
  -- another.  The migration asserts a quiescent cutover; fail closed if that
  -- precondition was violated rather than guessing.
  IF v_checkpoint_exists
     AND COALESCE(v_existing.contract_version, 0) <> c_contract_version THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'legacy_inflight_thaw_requires_quiescent_cutover'
    );
  END IF;

  v_effective_seconds := CASE
    WHEN v_checkpoint_exists THEN v_existing.frozen_seconds
    ELSE EXTRACT(EPOCH FROM (v_now - p_freeze_started))
  END;
  IF v_effective_seconds <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'implausible_frozen_seconds'
    );
  END IF;

  -- p_frozen_seconds is retained for rolling-call compatibility and logging.
  -- The database clock sampled after the admission boundary is authoritative.
  INSERT INTO public.engine_maintenance_thaws (
    freeze_started_at, frozen_seconds, shifted, thawed_by,
    announced_at, ownership_token, contract_version,
    release_target_at, release_generation
  ) VALUES (
    p_freeze_started, v_effective_seconds, '{}'::jsonb, p_thawed_by,
    p_announced_at, p_ownership_token, c_contract_version, NULL, 0
  )
  ON CONFLICT (freeze_started_at) DO NOTHING;

  SELECT * INTO v_existing
    FROM public.engine_maintenance_thaws t
   WHERE t.freeze_started_at=p_freeze_started
   FOR UPDATE;
  IF v_existing.announced_at IS DISTINCT FROM p_announced_at
     OR v_existing.ownership_token IS DISTINCT FROM p_ownership_token
     OR v_existing.contract_version <> c_contract_version THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_checkpoint_identity_mismatch'
    );
  END IF;

  -- Stage one keeps the deployed installment worker, but snapshots its exact
  -- UUID targets first.  As each legacy step commits, its row receipts advance
  -- in this same outer transaction to the identical initial duration.
  IF v_existing.release_target_at IS NULL THEN
    IF COALESCE((v_existing.shifted->>'_targets_snapshotted')::boolean, false) = false THEN
      PERFORM public.fn_snapshot_maintenance_thaw_targets(
        p_freeze_started, v_existing.frozen_seconds
      );
    END IF;
    -- The retained checkpoint worker validates its CALL argument against its
    -- historical 900-second ceiling, but reads the authoritative duration from
    -- this v3 ledger row. Pass the largest legacy-valid value; the worker and
    -- the exact per-target suffix both use v_existing.frozen_seconds, so a
    -- long-lived owner is recovered in full without weakening its old public
    -- input guard.
    v_result := public.fn_thaw_platform_checkpointed(
      p_freeze_started,
      LEAST(v_existing.frozen_seconds, 900::numeric),
      p_thawed_by
    );
    IF COALESCE((v_result->>'ok')::boolean, false) = false THEN
      RETURN v_result || jsonb_build_object(
        'complete', false, 'retryable', false, 'released', false,
        'freeze_started_at', p_freeze_started,
        'ownership_token', p_ownership_token
      );
    END IF;
    SELECT t.shifted INTO v_shifted
      FROM public.engine_maintenance_thaws t
     WHERE t.freeze_started_at=p_freeze_started;
    UPDATE public.engine_maintenance_thaw_targets x
       SET credited_seconds=v_existing.frozen_seconds
     WHERE x.freeze_started_at=p_freeze_started
       AND x.credited_seconds<v_existing.frozen_seconds
       AND (
         (x.step <> 'level_started_at' AND v_shifted ? x.step)
         OR (
           x.step='level_started_at'
           AND (
             v_shifted ? 'level_started_at'
             OR (
               v_shifted ? 'level_started_at_cursor'
               AND x.target_id <= (v_shifted->>'level_started_at_cursor')::uuid
             )
           )
         )
       );
    IF NOT COALESCE((v_result->>'complete')::boolean, false)
       OR NOT COALESCE((v_shifted->>'complete')::boolean, false)
       OR NOT (v_shifted ?& c_required_steps) THEN
      RETURN v_result || jsonb_build_object(
        'ok', true, 'complete', false, 'retryable', true,
        'reason', 'thaw_checkpointed', 'released', false, 'abandoned', false,
        'retry_after_ms', 0,
        'freeze_started_at', p_freeze_started,
        'credited_through_at', p_freeze_started
          + make_interval(secs=>v_existing.frozen_seconds),
        'effective_frozen_seconds', v_existing.frozen_seconds,
        'ownership_token', p_ownership_token,
        'shifted', v_shifted
      );
    END IF;

    -- The broad work is known now.  Rebase every exact target to a future
    -- endpoint with enough runway to finish in bounded batches.  If the
    -- estimate is missed a later generation doubles it; no door opens on an
    -- expired estimate.
    SELECT count(*) INTO v_target_count
      FROM public.engine_maintenance_thaw_targets x
     WHERE x.freeze_started_at=p_freeze_started;
    v_reserve_seconds := GREATEST(
      8::numeric,
      4::numeric + CEIL(v_target_count::numeric / 40::numeric) * 4::numeric
    );
    v_release_target := clock_timestamp()
      + make_interval(secs=>v_reserve_seconds);
    v_effective_seconds := EXTRACT(EPOCH FROM (v_release_target-p_freeze_started));
    UPDATE public.engine_maintenance_thaws t
       SET frozen_seconds=v_effective_seconds,
           release_target_at=v_release_target,
           release_generation=1,
           shifted=t.shifted-'complete',
           thawed_at=clock_timestamp()
     WHERE t.freeze_started_at=p_freeze_started;
    RETURN jsonb_build_object(
      'ok', true, 'complete', false, 'retryable', true,
      'reason', 'release_boundary_planned', 'released', false, 'abandoned', false,
      'retry_after_ms', 0,
      'freeze_started_at', p_freeze_started,
      'credited_through_at', v_release_target,
      'effective_frozen_seconds', v_effective_seconds,
      'ownership_token', p_ownership_token,
      'shifted', v_shifted-'complete'
    );
  END IF;

  -- Stage two advances only each target's uncredited suffix.  No completed
  -- step is ever shifted by the full duration twice.
  v_result := public.fn_credit_maintenance_thaw_targets(
    p_freeze_started, v_existing.frozen_seconds
  );
  IF COALESCE((v_result->>'ok')::boolean, false) = false THEN
    RETURN v_result || jsonb_build_object(
      'complete', false, 'retryable', false, 'released', false,
      'freeze_started_at', p_freeze_started,
      'ownership_token', p_ownership_token
    );
  END IF;
  SELECT * INTO v_existing
    FROM public.engine_maintenance_thaws t
   WHERE t.freeze_started_at=p_freeze_started
   FOR UPDATE;
  v_shifted := v_existing.shifted;
  IF NOT COALESCE((v_result->>'complete')::boolean, false) THEN
    RETURN v_result || jsonb_build_object(
      'ok', true, 'complete', false, 'retryable', true,
      'reason', 'thaw_tail_checkpointed', 'released', false, 'abandoned', false,
      'retry_after_ms', 0,
      'freeze_started_at', p_freeze_started,
      'credited_through_at', v_existing.release_target_at,
      'effective_frozen_seconds', v_existing.frozen_seconds,
      'ownership_token', p_ownership_token,
      'shifted', v_shifted
    );
  END IF;

  v_now := clock_timestamp();
  IF v_now >= v_existing.release_target_at THEN
    SELECT count(*) INTO v_target_count
      FROM public.engine_maintenance_thaw_targets x
     WHERE x.freeze_started_at=p_freeze_started;
    v_reserve_seconds := GREATEST(
      8::numeric,
      (4::numeric + CEIL(v_target_count::numeric/40::numeric)*4::numeric)
        * power(2::numeric, LEAST(v_existing.release_generation, 8))
    );
    v_release_target := v_now + make_interval(secs=>v_reserve_seconds);
    v_effective_seconds := EXTRACT(EPOCH FROM (v_release_target-p_freeze_started));
    UPDATE public.engine_maintenance_thaws t
       SET frozen_seconds=v_effective_seconds,
           release_target_at=v_release_target,
           release_generation=t.release_generation+1,
           shifted=t.shifted-'complete',
           thawed_at=clock_timestamp()
     WHERE t.freeze_started_at=p_freeze_started;
    RETURN jsonb_build_object(
      'ok', true, 'complete', false, 'retryable', true,
      'reason', 'release_boundary_rebased', 'released', false, 'abandoned', false,
      'retry_after_ms', 0,
      'freeze_started_at', p_freeze_started,
      'credited_through_at', v_release_target,
      'effective_frozen_seconds', v_effective_seconds,
      'ownership_token', p_ownership_token,
      'shifted', v_shifted-'complete'
    );
  END IF;

  -- Every target is already credited through the future endpoint.  Commit the
  -- exact row clear now; the certified ledger (consulted by both public freeze
  -- predicates) keeps admission closed until that instant.  This removes the
  -- otherwise-uncreditable DELETE/commit/network tail from the frozen interval.
  UPDATE public.engine_maintenance_thaws t
     SET thawed_at=clock_timestamp()
   WHERE t.freeze_started_at=p_freeze_started;
  DELETE FROM public.engine_maintenance_break b
   WHERE b.id=true
     AND b.announced_at IS NOT DISTINCT FROM p_announced_at
     AND COALESCE(b.break_started_at,b.announced_at+INTERVAL '2 minutes')
         IS NOT DISTINCT FROM p_freeze_started
     AND b.ownership_token=p_ownership_token;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'retryable', false,
      'reason', 'maintenance_release_identity_changed'
    );
  END IF;
  RETURN v_result || jsonb_build_object(
    'ok', true, 'complete', true, 'retryable', false,
    'reason', 'thaw_complete_release_scheduled',
    'released', true, 'abandoned', false,
    'freeze_started_at', p_freeze_started,
    'credited_through_at', v_existing.release_target_at,
    'effective_frozen_seconds', v_existing.frozen_seconds,
    'ownership_token', p_ownership_token,
    'shifted', v_shifted
  );
END;
$function$
;
CREATE FUNCTION release_ops.credit_operation_wave_targets(p_freeze_started timestamp with time zone, p_target_seconds numeric, p_interval uuid, p_wave integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_budget CONSTANT interval := INTERVAL '4 seconds';
  c_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_started timestamptz := clock_timestamp();
  v_counts jsonb;
  v_step text;
  v_batch integer;
  v_moved integer;
  v_marked integer;
  v_done text[] := '{}';
  v_complete boolean;
BEGIN
  IF p_target_seconds IS NULL OR p_target_seconds <= 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'reason', 'invalid_credit_target'
    );
  END IF;

  SELECT COALESCE(t.shifted, '{}'::jsonb) INTO v_counts
    FROM public.engine_maintenance_thaws t
   WHERE t.freeze_started_at = p_freeze_started
   FOR UPDATE;
  IF NOT FOUND OR COALESCE((v_counts->>'_targets_snapshotted')::boolean, false) = false THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false, 'reason', 'thaw_targets_not_snapshotted'
    );
  END IF;

  PERFORM set_config('app.freeze_bypass', 'on', true);

  FOREACH v_step IN ARRAY c_steps LOOP
    EXIT WHEN clock_timestamp() - v_started > c_budget;
    v_batch := CASE WHEN v_step = 'level_started_at' THEN 40 ELSE 200 END;
    v_moved := 0;
    v_marked := 0;

    IF v_step = 'sit_out_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id, x.credited_seconds
          FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at = p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step = v_step
           AND x.credited_seconds < p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.table_seats r
           SET sit_out_at = r.sit_out_at
             + make_interval(secs => p_target_seconds - d.credited_seconds)
          FROM due d WHERE r.id = d.target_id AND r.sit_out_at IS NOT NULL
        RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x
           SET credited_seconds = p_target_seconds
          FROM due d
         WHERE x.freeze_started_at = p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step = v_step
           AND x.target_id = d.target_id
        RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved), (SELECT count(*) FROM marked)
          INTO v_moved, v_marked;
    ELSIF v_step = 'hold_expires_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id, x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.table_waitlist r SET hold_expires_at=r.hold_expires_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.hold_expires_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'addon_period_ends_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tournaments r SET addon_period_ends_at=r.addon_period_ends_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.addon_period_ends_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'reversible_until' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.chip_transactions r SET reversible_until=r.reversible_until
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.reversible_until IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'reveal_deadline_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tournament_bounty_awards r SET reveal_deadline_at=r.reveal_deadline_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.reveal_deadline_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'rebuy_prompt_until' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tournament_players r SET rebuy_prompt_until=r.rebuy_prompt_until
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.rebuy_prompt_until IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'bomb_pot_next_due_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tables r SET bomb_pot_next_due_at=r.bomb_pot_next_due_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.bomb_pot_next_due_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'cash_stay_last_tick_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.cash_player_session r SET stay_last_tick_at=r.stay_last_tick_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'cash_rejoin_expires_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.cash_rejoin_constraints r SET expires_at=r.expires_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'level_started_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tournaments r SET level_started_at=r.level_started_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.level_started_at IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'cluster_break_eligible_since' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.tables r SET break_eligible_since=r.break_eligible_since
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id AND r.break_eligible_since IS NOT NULL RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'cluster_move_expires_at' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.cash_seat_moves r SET expires_at=r.expires_at
          + make_interval(secs=>p_target_seconds-d.credited_seconds)
          FROM due d WHERE r.id=d.target_id RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'reconnect_presence' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.engine_presence_parked r
           SET disconnect_states=public.fn_thaw_reconnect_states(
             r.disconnect_states, EXTRACT(EPOCH FROM p_freeze_started)*1000,
             EXTRACT(EPOCH FROM p_freeze_started+make_interval(secs=>p_target_seconds))*1000)
          FROM due d WHERE r.table_id=d.target_id RETURNING r.table_id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    ELSIF v_step = 'reconnect_snapshots' THEN
      WITH due AS MATERIALIZED (
        SELECT x.target_id,x.credited_seconds FROM public.engine_maintenance_thaw_targets x
         WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
           AND x.credited_seconds<p_target_seconds
         ORDER BY x.target_id LIMIT v_batch FOR UPDATE
      ), moved AS (
        UPDATE public.hand_state_snapshots r
           SET disconnect_states=public.fn_thaw_reconnect_states(
             r.disconnect_states, EXTRACT(EPOCH FROM p_freeze_started)*1000,
             EXTRACT(EPOCH FROM p_freeze_started+make_interval(secs=>p_target_seconds))*1000)
          FROM due d WHERE r.id=d.target_id RETURNING r.id
      ), marked AS (
        UPDATE public.engine_maintenance_thaw_targets x SET credited_seconds=p_target_seconds
          FROM due d WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave) AND x.step=v_step
            AND x.target_id=d.target_id RETURNING x.target_id
      ) SELECT (SELECT count(*) FROM moved),(SELECT count(*) FROM marked) INTO v_moved,v_marked;
    END IF;

    IF v_moved <> v_marked THEN
      RAISE EXCEPTION 'MAINTENANCE_THAW_TARGET_CHANGED: % moved %, receipted %',
        v_step, v_moved, v_marked
        USING ERRCODE = '40001';
    END IF;
    IF v_marked > 0 THEN
      v_done := array_append(v_done, v_step || ':' || v_marked::text);
    END IF;
  END LOOP;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.engine_maintenance_thaw_targets x
     WHERE x.freeze_started_at=p_freeze_started AND release_ops.operation_target_in_wave(x.freeze_started_at,x.step,x.target_id,p_interval,p_wave)
       AND x.credited_seconds<p_target_seconds
  ) INTO v_complete;
  RETURN jsonb_build_object(
    'ok', true, 'complete', v_complete, 'steps_this_call', to_jsonb(v_done),
    'elapsed_ms', round(EXTRACT(EPOCH FROM clock_timestamp()-v_started)*1000),
    'shifted', v_counts
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_thaw_platform(p_announced_at timestamp with time zone, p_freeze_started timestamp with time zone, p_frozen_seconds numeric, p_ownership_token uuid, p_thawed_by text DEFAULT NULL::text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='35s' SET lock_timeout='32s' AS $$
DECLARE o release_ops.maintenance_operations; r jsonb;
BEGIN
 SELECT * INTO o FROM release_ops.maintenance_operations WHERE freeze_started_at=p_freeze_started;
 IF o.operation_id IS NULL THEN
  IF EXISTS(SELECT 1 FROM release_ops.maintenance_operations WHERE phase<>'resumed') THEN RAISE EXCEPTION 'MAINTENANCE_WRONG_INTERVAL_THAW'; END IF;
  RETURN release_ops.retained_v3_thaw(p_announced_at,p_freeze_started,p_frozen_seconds,p_ownership_token,p_thawed_by);
 END IF;
 IF p_ownership_token IS NULL OR p_announced_at IS DISTINCT FROM o.freeze_started_at THEN RAISE EXCEPTION 'MAINTENANCE_THAW_IDENTITY_MISMATCH'; END IF;
 o:=release_ops.lock_maintenance_operation(o.interval_id,p_ownership_token);
 IF o.phase NOT IN ('release_authorized','releasing','resumed') OR o.release_receipt IS NULL THEN RAISE EXCEPTION 'MAINTENANCE_RELEASE_NOT_AUTHORIZED'; END IF;
 PERFORM release_ops.maintenance_permit(o.interval_id,true);
 -- Original freeze identity is preserved. Explicit release proof, not target expiry, makes the retained worker due.
 UPDATE public.engine_maintenance_break SET break_ends_at=GREATEST(o.freeze_started_at+interval '1 microsecond',LEAST(break_ends_at,clock_timestamp()))
 WHERE id AND ownership_token=p_ownership_token AND announced_at=o.freeze_started_at;
 r:=release_ops.retained_v3_thaw(p_announced_at,p_freeze_started,p_frozen_seconds,p_ownership_token,p_thawed_by);
 IF r->>'complete'='true' AND r->>'released'='true' THEN
  PERFORM release_ops.snapshot_operation_target_scope(o.interval_id);
  IF o.phase<>'resumed' THEN UPDATE release_ops.maintenance_operations SET phase='releasing',updated_at=clock_timestamp() WHERE interval_id=o.interval_id; END IF;
 END IF;
 PERFORM release_ops.maintenance_permit(o.interval_id,false);
 RETURN r;
END $$;
CREATE FUNCTION public.fn_authorize_engine_maintenance_wave(p_interval_id uuid,p_ownership_token uuid,p_wave_index integer,p_table_ids uuid[]) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o release_ops.maintenance_operations; w release_ops.maintenance_waves; t public.engine_maintenance_thaws; r jsonb; seconds numeric;
BEGIN
 IF p_ownership_token IS NULL THEN RAISE EXCEPTION 'MAINTENANCE_OWNER_IDENTITY_REQUIRED'; END IF;
 o:=release_ops.lock_maintenance_operation(p_interval_id,p_ownership_token);
 SELECT * INTO w FROM release_ops.maintenance_waves WHERE interval_id=p_interval_id AND wave_index=p_wave_index FOR UPDATE;
 IF w.interval_id IS NULL OR w.table_ids IS DISTINCT FROM p_table_ids THEN RAISE EXCEPTION 'MAINTENANCE_WAVE_PLAN_MISMATCH'; END IF;
 IF w.receipt_id IS NOT NULL THEN
  IF w.resumed_at IS NULL AND clock_timestamp()>w.credited_through_at THEN
   UPDATE release_ops.maintenance_operations SET phase='recovery_required',reason='Maintenance wave requires outcome reconciliation',updated_at=clock_timestamp() WHERE interval_id=p_interval_id;
  END IF;
  RETURN release_ops.maintenance_snapshot(p_interval_id);
 END IF;
 IF o.phase<>'releasing' OR o.release_receipt IS NULL THEN RAISE EXCEPTION 'MAINTENANCE_WAVE_RELEASE_NOT_AUTHORIZED'; END IF;
 IF EXISTS(SELECT 1 FROM release_ops.maintenance_waves WHERE interval_id=p_interval_id AND wave_index<p_wave_index AND resumed_at IS NULL)
 THEN RAISE EXCEPTION 'MAINTENANCE_PREVIOUS_WAVE_NOT_RESUMED'; END IF;
 SELECT * INTO t FROM public.engine_maintenance_thaws WHERE freeze_started_at=o.freeze_started_at;
 IF t.contract_version<>3 OR t.ownership_token IS DISTINCT FROM p_ownership_token OR t.release_target_at IS NULL
 OR COALESCE((t.shifted->>'complete')::boolean,false)=false OR EXISTS(SELECT 1 FROM public.engine_maintenance_break)
 THEN RAISE EXCEPTION 'MAINTENANCE_BASE_THAW_REQUIRED'; END IF;
 -- Checkpoint future target. If an installment overruns it, no receipt is issued;
 -- the next call rebases the still-held targets before any physical resume.
 IF w.credited_through_at IS NULL OR w.credited_through_at<=clock_timestamp() THEN
  UPDATE release_ops.maintenance_waves SET credited_through_at=GREATEST(t.release_target_at,date_trunc('milliseconds',clock_timestamp())+interval '5 seconds'),ownership_token=p_ownership_token
   WHERE interval_id=p_interval_id AND wave_index=p_wave_index RETURNING * INTO w;
 END IF;
 seconds:=extract(epoch FROM w.credited_through_at-o.freeze_started_at);
 PERFORM release_ops.maintenance_permit(p_interval_id,true);
 r:=release_ops.credit_operation_wave_targets(o.freeze_started_at,seconds,p_interval_id,p_wave_index);
 PERFORM release_ops.maintenance_permit(p_interval_id,false);
 IF r->>'complete'='true' AND clock_timestamp()<w.credited_through_at THEN
  UPDATE release_ops.maintenance_waves SET receipt_id=gen_random_uuid() WHERE interval_id=p_interval_id AND wave_index=p_wave_index;
  INSERT INTO release_ops.maintenance_events(interval_id,kind,data) VALUES(p_interval_id,'WAVE_RELEASE_AUTHORIZED',jsonb_build_object('index',p_wave_index,'credited_through_at',w.credited_through_at));
 END IF;
 RETURN release_ops.maintenance_snapshot(p_interval_id);
END $$;
CREATE FUNCTION public.fn_ack_engine_maintenance_wave(p_interval_id uuid,p_ownership_token uuid,p_wave_index integer,p_receipt_id uuid,p_resumed_table_ids uuid[],p_resumed_at timestamptz) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE o release_ops.maintenance_operations; w release_ops.maintenance_waves; ts timestamptz; result jsonb;
BEGIN
 IF p_ownership_token IS NULL OR p_receipt_id IS NULL THEN RAISE EXCEPTION 'MAINTENANCE_WAVE_RECEIPT_REQUIRED'; END IF;
 o:=release_ops.lock_maintenance_operation(p_interval_id,p_ownership_token);
 SELECT * INTO w FROM release_ops.maintenance_waves WHERE interval_id=p_interval_id AND wave_index=p_wave_index FOR UPDATE;
 IF w.receipt_id IS DISTINCT FROM p_receipt_id OR w.table_ids IS DISTINCT FROM p_resumed_table_ids OR w.interval_id IS NULL
 THEN RAISE EXCEPTION 'MAINTENANCE_WAVE_ACK_MISMATCH'; END IF;
 IF w.resumed_at IS NOT NULL THEN RETURN release_ops.maintenance_snapshot(p_interval_id); END IF;
 IF o.phase<>'releasing' OR w.ownership_token IS DISTINCT FROM p_ownership_token THEN RAISE EXCEPTION 'MAINTENANCE_WAVE_OUTCOME_UNKNOWN'; END IF;
 ts:=p_resumed_at;
 IF ts IS NULL OR NOT isfinite(ts) OR ts<w.credited_through_at THEN
  RAISE EXCEPTION 'MAINTENANCE_ACTUAL_RESUME_TIME_INVALID';
 END IF;
 IF ts>clock_timestamp() THEN
  -- Explicit pre-write rejection. The engine may retry this same captured ACK
  -- briefly while the DB clock catches up; it may never repeat physical resume.
  RAISE EXCEPTION 'MAINTENANCE_ACTUAL_RESUME_TIME_IN_FUTURE' USING ERRCODE='22008';
 END IF;
 PERFORM release_ops.maintenance_permit(p_interval_id,true);
 BEGIN
  result:=release_ops.credit_operation_wave_targets(o.freeze_started_at,extract(epoch FROM ts-o.freeze_started_at),p_interval_id,p_wave_index);
 EXCEPTION WHEN OTHERS THEN
  result:=jsonb_build_object('complete',false);
 END;
 PERFORM release_ops.maintenance_permit(p_interval_id,false);
 IF result->>'complete' IS DISTINCT FROM 'true' THEN
  UPDATE release_ops.maintenance_operations SET phase='recovery_required',reason='Maintenance wave requires outcome reconciliation',updated_at=clock_timestamp() WHERE interval_id=p_interval_id;
  INSERT INTO release_ops.maintenance_events(interval_id,kind,data) VALUES(p_interval_id,'PHYSICAL_RESUME_SUFFIX_UNPROVEN',jsonb_build_object('index',p_wave_index,'reported_resumed_at',ts));
  RETURN release_ops.maintenance_snapshot(p_interval_id);
 END IF;
 UPDATE release_ops.maintenance_waves SET resumed_at=ts WHERE interval_id=p_interval_id AND wave_index=p_wave_index;
 INSERT INTO public.engine_maintenance_table_releases SELECT p_interval_id,id,p_receipt_id,ts,ts FROM unnest(w.table_ids) id;
 UPDATE public.engine_maintenance_operation_signal SET updated_at=clock_timestamp() WHERE id;
 INSERT INTO release_ops.maintenance_events(interval_id,kind,data) VALUES(p_interval_id,'WAVE_RESUMED',jsonb_build_object('index',p_wave_index,'receipt_id',p_receipt_id,'observed_at',ts));
 RETURN release_ops.maintenance_snapshot(p_interval_id);
END $$;
CREATE FUNCTION public.fn_ack_engine_maintenance_resumed(p_interval_id uuid,p_ownership_token uuid,p_wave_receipts uuid[]) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' SET statement_timeout='8s' SET lock_timeout='2s' AS $$
DECLARE o release_ops.maintenance_operations; ids uuid[]; supplied uuid[]; result jsonb;
 c release_ops.maintenance_global_checkpoints; r release_ops.maintenance_global_receipts;
 endpoint timestamptz; duration interval; all_waves jsonb; total bigint; digest text; counts jsonb;
BEGIN
 IF p_ownership_token IS NULL THEN RAISE EXCEPTION 'MAINTENANCE_OWNER_IDENTITY_REQUIRED'; END IF;
 o:=release_ops.lock_maintenance_operation(p_interval_id,p_ownership_token);
 SELECT COALESCE(array_agg(receipt_id ORDER BY receipt_id),'{}') INTO ids FROM release_ops.maintenance_waves WHERE interval_id=p_interval_id;
 SELECT COALESCE(array_agg(x ORDER BY x),'{}') INTO supplied FROM unnest(p_wave_receipts) x;
 IF ids IS DISTINCT FROM supplied OR EXISTS(SELECT 1 FROM release_ops.maintenance_waves WHERE interval_id=p_interval_id AND (receipt_id IS NULL OR resumed_at IS NULL))
 THEN RAISE EXCEPTION 'MAINTENANCE_FULL_RESUME_RECEIPTS_REQUIRED'; END IF;
 SELECT * INTO r FROM release_ops.maintenance_global_receipts WHERE interval_id=p_interval_id;
 IF r.id IS NOT NULL THEN RETURN release_ops.maintenance_snapshot(p_interval_id); END IF;
 SET CONSTRAINTS release_ops.maintenance_private_certificate_commit,public.maintenance_public_certificate_commit DEFERRED;
 IF o.phase<>'releasing' THEN RAISE EXCEPTION 'MAINTENANCE_FULL_RESUME_PHASE_INVALID'; END IF;
 SELECT * INTO c FROM release_ops.maintenance_global_checkpoints WHERE interval_id=p_interval_id ORDER BY checkpoint_no DESC LIMIT 1 FOR UPDATE;
 IF c.id IS NULL OR (c.completed_at IS NOT NULL AND c.credited_through_at<=clock_timestamp()) THEN
  IF COALESCE(c.checkpoint_no,0)>=8 THEN
   UPDATE release_ops.maintenance_operations SET phase='recovery_required',reason='Maintenance global credit requires verified recovery',updated_at=clock_timestamp() WHERE interval_id=p_interval_id;
   RETURN release_ops.maintenance_snapshot(p_interval_id);
  END IF;
  -- A completed overrun informs the next reserve. The continuous hold deadline
  -- never changes, and a partially processed checkpoint is never rebased.
  duration:=GREATEST(interval '5 seconds',COALESCE((c.completed_at-c.created_at)*2+interval '5 seconds',interval '5 seconds'));
  endpoint:=date_trunc('milliseconds',clock_timestamp()+LEAST(interval '60 seconds',duration));
  endpoint:=GREATEST(endpoint,(SELECT date_trunc('milliseconds',release_target_at)+interval '1 millisecond' FROM public.engine_maintenance_thaws WHERE freeze_started_at=o.freeze_started_at));
  IF o.release_authorized_at<o.deadline_at THEN endpoint:=LEAST(endpoint,o.deadline_at); END IF;
  IF endpoint<=clock_timestamp()+interval '100 milliseconds' THEN
   UPDATE release_ops.maintenance_operations SET phase='recovery_required',reason='Maintenance global credit requires verified recovery',updated_at=clock_timestamp() WHERE interval_id=p_interval_id;
   RETURN release_ops.maintenance_snapshot(p_interval_id);
  END IF;
  INSERT INTO release_ops.maintenance_global_checkpoints(interval_id,checkpoint_no,credited_through_at)
  VALUES(p_interval_id,COALESCE(c.checkpoint_no,0)+1,endpoint) RETURNING * INTO c;
 END IF;
 PERFORM release_ops.maintenance_permit(p_interval_id,true);
 result:=release_ops.credit_operation_wave_targets(o.freeze_started_at,extract(epoch FROM c.credited_through_at-o.freeze_started_at),p_interval_id,-1);
 PERFORM release_ops.maintenance_permit(p_interval_id,false);
 IF result->>'complete' IS DISTINCT FROM 'true' THEN RETURN release_ops.maintenance_snapshot(p_interval_id); END IF;
 UPDATE release_ops.maintenance_global_checkpoints SET completed_at=COALESCE(completed_at,clock_timestamp()) WHERE id=c.id RETURNING * INTO c;
 IF clock_timestamp()+interval '100 milliseconds'>=c.credited_through_at THEN RETURN release_ops.maintenance_snapshot(p_interval_id); END IF;
 -- Bind every immutable wave ACK and every captured target, including clocks
 -- already stopped at their table/event wave. No source inventory is omitted.
 SELECT COALESCE(jsonb_agg(jsonb_build_object('index',wave_index,'table_ids',table_ids,'receipt_id',receipt_id,'resumed_at',resumed_at) ORDER BY wave_index),'[]') INTO all_waves
 FROM release_ops.maintenance_waves WHERE interval_id=p_interval_id;
 SELECT count(*),encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_array(t.step,t.target_id,t.credited_seconds) ORDER BY t.step,t.target_id),'[]')::text,'UTF8')),'hex') INTO total,digest
 FROM public.engine_maintenance_thaw_targets t WHERE t.freeze_started_at=o.freeze_started_at;
 IF EXISTS(SELECT 1 FROM public.engine_maintenance_thaw_targets t LEFT JOIN release_ops.maintenance_target_scope s USING(freeze_started_at,step,target_id)
 WHERE t.freeze_started_at=o.freeze_started_at AND (s.target_id IS NULL OR
  (cardinality(s.table_ids)=0 AND t.credited_seconds<>extract(epoch FROM c.credited_through_at-o.freeze_started_at)) OR
  (cardinality(s.table_ids)>0 AND NOT EXISTS(SELECT 1 FROM release_ops.maintenance_waves w WHERE w.interval_id=p_interval_id AND s.table_ids<@w.table_ids AND w.resumed_at IS NOT NULL AND t.credited_seconds=extract(epoch FROM w.resumed_at-o.freeze_started_at)))))
 THEN RAISE EXCEPTION 'MAINTENANCE_GLOBAL_TARGET_PROOF_INCOMPLETE'; END IF;
 SELECT COALESCE(jsonb_object_agg(step,n),'{}') INTO counts FROM (SELECT step,count(*) n FROM public.engine_maintenance_thaw_targets WHERE freeze_started_at=o.freeze_started_at GROUP BY step) t;
 INSERT INTO release_ops.maintenance_global_receipts(interval_id,checkpoint_id,ownership_token,generation,safe_resume_receipt,wave_receipts,target_count,target_digest,step_counts,release_at)
 VALUES(p_interval_id,c.id,o.ownership_token,o.generation,o.release_receipt,all_waves,total,digest,counts,c.credited_through_at) RETURNING * INTO r;
 INSERT INTO public.engine_maintenance_global_releases VALUES(p_interval_id,r.id,r.generation,r.release_at,r.certified_at);
 INSERT INTO release_ops.maintenance_events(interval_id,kind,data) VALUES(p_interval_id,'GLOBAL_RELEASE_CERTIFIED',jsonb_build_object('receipt_id',r.id,'release_at',r.release_at,'target_digest',digest));
 UPDATE public.engine_maintenance_operation_signal SET updated_at=clock_timestamp() WHERE id;
 UPDATE release_ops.maintenance_operations SET updated_at=clock_timestamp() WHERE interval_id=p_interval_id;
 RETURN release_ops.maintenance_snapshot(p_interval_id);
END $$;

CREATE TABLE release_ops.maintenance_observations (
 operation_id uuid NOT NULL REFERENCES release_ops.maintenance_operations(operation_id),check_no integer NOT NULL CHECK(check_no BETWEEN 1 AND 400),
 observed_at timestamptz NOT NULL,next_check_at timestamptz NOT NULL,owner_id uuid NOT NULL,epoch uuid NOT NULL,PRIMARY KEY(operation_id,check_no)
);
CREATE FUNCTION release_ops.authorize_maintenance_observation(owner uuid,epoch uuid,operation_id uuid,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE o release_ops.maintenance_operations; last release_ops.maintenance_observations; ts timestamptz;
BEGIN
 PERFORM release_ops.valid_actor(actor);PERFORM release_ops.check_owner(owner,epoch,false);
 SELECT * INTO o FROM release_ops.maintenance_operations WHERE maintenance_operations.operation_id=authorize_maintenance_observation.operation_id;
 o:=release_ops.lock_maintenance_operation(o.interval_id);
 IF o.release_id IS DISTINCT FROM (SELECT active_release FROM release_ops.controller WHERE singleton) THEN RAISE EXCEPTION 'RELEASE_NOT_ACTIVE'; END IF;
 SELECT * INTO last FROM release_ops.maintenance_observations x WHERE x.operation_id=o.operation_id ORDER BY check_no DESC LIMIT 1;
 ts:=clock_timestamp();
 IF o.phase IN ('resumed','recovery_required') OR COALESCE(last.check_no,0)>=400 OR last.next_check_at>ts THEN
  RETURN jsonb_build_object('authorized',false,'next_check_at',CASE WHEN o.phase IN ('resumed','recovery_required') THEN NULL ELSE last.next_check_at END,'phase',o.phase);
 END IF;
 INSERT INTO release_ops.maintenance_observations VALUES(o.operation_id,COALESCE(last.check_no,0)+1,ts,LEAST(o.deadline_at,ts+interval '5 seconds'),owner,epoch) RETURNING * INTO last;
 RETURN jsonb_build_object('authorized',true,'observation',to_jsonb(last),'next_check_at',last.next_check_at,'phase',o.phase);
END $$;
CREATE FUNCTION release_ops.maintenance_notify_journal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM pg_notify('release_journal_events','maintenance');
 RETURN NEW;
END $$;
CREATE TRIGGER maintenance_wakeup AFTER INSERT OR UPDATE ON release_ops.maintenance_operations FOR EACH ROW EXECUTE FUNCTION release_ops.maintenance_notify_journal();
CREATE TRIGGER maintenance_compatibility_wakeup AFTER INSERT ON release_ops.maintenance_compatibility FOR EACH ROW EXECUTE FUNCTION release_ops.maintenance_notify_journal();
CREATE FUNCTION release_ops.guard_active_maintenance_release() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.active_release IS DISTINCT FROM OLD.active_release AND EXISTS(SELECT 1 FROM release_ops.maintenance_operations WHERE phase<>'resumed')
 THEN RAISE EXCEPTION 'MAINTENANCE_ACTIVE_RELEASE_CANNOT_BE_REPLACED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER maintenance_holds_global_release BEFORE UPDATE ON release_ops.controller FOR EACH ROW EXECUTE FUNCTION release_ops.guard_active_maintenance_release();
CREATE FUNCTION release_ops.guard_maintenance_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'MAINTENANCE_HISTORY_IMMUTABLE'; END IF;
 IF TG_TABLE_NAME='maintenance_operations' THEN
  IF EXISTS(SELECT 1 FROM release_ops.maintenance_global_receipts r WHERE r.interval_id=OLD.interval_id AND
   (NEW.phase NOT IN ('releasing','resumed') OR (NEW.phase='resumed' AND (NEW.resumed_at IS DISTINCT FROM r.release_at OR clock_timestamp()<r.release_at))))
  THEN RAISE EXCEPTION 'MAINTENANCE_GLOBAL_RELEASE_ALREADY_CERTIFIED'; END IF;
  IF (to_jsonb(NEW)-ARRAY['ownership_token','generation','controller_owner','controller_epoch','phase','ready_at','release_receipt','release_authorized_at','resumed_at','reason','declared_by','updated_at'])
  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['ownership_token','generation','controller_owner','controller_epoch','phase','ready_at','release_receipt','release_authorized_at','resumed_at','reason','declared_by','updated_at'])
  OR (OLD.release_receipt IS NOT NULL AND NEW.release_receipt IS DISTINCT FROM OLD.release_receipt)
  OR (OLD.phase='resumed' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
  THEN RAISE EXCEPTION 'MAINTENANCE_INTERVAL_IDENTITY_IMMUTABLE'; END IF;
 ELSE
  IF NEW.interval_id<>OLD.interval_id OR NEW.wave_index<>OLD.wave_index OR NEW.table_ids<>OLD.table_ids
  OR (OLD.receipt_id IS NOT NULL AND (NEW.receipt_id IS DISTINCT FROM OLD.receipt_id OR NEW.credited_through_at IS DISTINCT FROM OLD.credited_through_at OR NEW.ownership_token<>OLD.ownership_token))
  OR (OLD.resumed_at IS NOT NULL AND NEW.resumed_at IS DISTINCT FROM OLD.resumed_at)
  THEN RAISE EXCEPTION 'MAINTENANCE_WAVE_RECEIPT_IMMUTABLE'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER maintenance_interval_identity BEFORE UPDATE OR DELETE ON release_ops.maintenance_operations FOR EACH ROW EXECUTE FUNCTION release_ops.guard_maintenance_identity();
CREATE TRIGGER maintenance_wave_identity BEFORE UPDATE OR DELETE ON release_ops.maintenance_waves FOR EACH ROW EXECUTE FUNCTION release_ops.guard_maintenance_identity();
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['maintenance_compatibility','maintenance_needs','maintenance_tables','maintenance_steps','maintenance_safe_resume','maintenance_events','maintenance_target_scope','maintenance_observations'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_%I BEFORE UPDATE OR DELETE ON release_ops.%I FOR EACH ROW EXECUTE FUNCTION release_ops.immutable()',name,name);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.fn_platform_frozen()
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS(SELECT 1 FROM public.engine_maintenance_operation_status s WHERE active AND NOT EXISTS(SELECT 1 FROM public.engine_maintenance_global_releases r WHERE r.interval_id=s.interval_id AND r.release_at<=clock_timestamp())) OR EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                  AND b.announced_at + INTERVAL '2 minutes' <= clock_timestamp()
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$function$
;
CREATE OR REPLACE FUNCTION public.fn_entry_purchases_frozen()
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS(SELECT 1 FROM public.engine_maintenance_operation_status s WHERE active AND NOT EXISTS(SELECT 1 FROM public.engine_maintenance_global_releases r WHERE r.interval_id=s.interval_id AND r.release_at<=clock_timestamp())) OR EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$function$
;
CREATE OR REPLACE FUNCTION public.fn_save_engine_maintenance_break(p_phase text, p_announced_at timestamp with time zone, p_break_started_at timestamp with time zone, p_break_ends_at timestamp with time zone, p_reason text, p_declared_by text, p_ownership_token uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '35s'
 SET lock_timeout TO '32s'
AS $function$
DECLARE
  v_rows integer;
  v_now timestamptz;
BEGIN
  PERFORM release_ops.reject_legacy_maintenance_writer();
  IF p_ownership_token IS NULL THEN
    RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_TOKEN_REQUIRED'
      USING ERRCODE = '22004';
  END IF;

  -- This is also the serialization point for admission. Sample time only after
  -- acquiring it, so a request queued behind an admitted purchase cannot commit
  -- a last-hand row after the fixed boundary and surface a break nobody honors.
  PERFORM pg_advisory_xact_lock(530090, 1);
  v_now := clock_timestamp();

  IF p_phase = 'last_hand' AND (
    p_break_started_at IS NOT NULL
    OR p_break_ends_at IS NOT NULL
    OR p_announced_at > v_now + INTERVAL '5 seconds'
    OR v_now >= p_announced_at + INTERVAL '2 minutes'
  ) THEN
    RAISE EXCEPTION 'MAINTENANCE_LAST_HAND_BOUNDARY_EXPIRED'
      USING ERRCODE = '57014';
  END IF;

  IF p_phase = 'counting_down' AND (
    p_break_started_at IS NULL
    OR p_break_ends_at IS NULL
    OR v_now >= p_break_ends_at
  ) THEN
    RAISE EXCEPTION 'MAINTENANCE_COUNTDOWN_BOUNDARY_EXPIRED'
      USING ERRCODE = '57014';
  END IF;

  INSERT INTO public.engine_maintenance_break (
    id, phase, announced_at, break_started_at, enforce_freeze,
    break_ends_at, reason, declared_by, ownership_token, updated_at
  ) VALUES (
    true, p_phase, p_announced_at, p_break_started_at, true,
    p_break_ends_at, p_reason, p_declared_by, p_ownership_token, v_now
  )
  ON CONFLICT (id) DO UPDATE SET
    phase = EXCLUDED.phase,
    announced_at = EXCLUDED.announced_at,
    break_started_at = EXCLUDED.break_started_at,
    enforce_freeze = EXCLUDED.enforce_freeze,
    break_ends_at = EXCLUDED.break_ends_at,
    reason = EXCLUDED.reason,
    declared_by = EXCLUDED.declared_by,
    ownership_token = EXCLUDED.ownership_token,
    updated_at = EXCLUDED.updated_at
  WHERE public.engine_maintenance_break.ownership_token = EXCLUDED.ownership_token;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_LOST: save refused'
      USING ERRCODE = '40001';
  END IF;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_claim_engine_maintenance_break(p_expected_ownership_token uuid, p_new_ownership_token uuid, p_declared_by text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '35s'
 SET lock_timeout TO '32s'
AS $function$
DECLARE
  v_row public.engine_maintenance_break%ROWTYPE;
BEGIN
  PERFORM release_ops.reject_legacy_maintenance_writer();
  IF p_expected_ownership_token IS NULL OR p_new_ownership_token IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ownership_token_required');
  END IF;
  PERFORM pg_advisory_xact_lock(530090, 1);
  SELECT * INTO v_row
    FROM public.engine_maintenance_break b
   WHERE b.id = true
   FOR UPDATE;
  IF NOT FOUND OR v_row.ownership_token <> p_expected_ownership_token THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ownership_changed');
  END IF;
  UPDATE public.engine_maintenance_break
     SET ownership_token = p_new_ownership_token,
         declared_by = p_declared_by,
         updated_at = clock_timestamp()
   WHERE id = true
     AND ownership_token = p_expected_ownership_token
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'ownership_changed');
  END IF;
  RETURN jsonb_build_object(
    'ok', true,
    'phase', v_row.phase,
    'announced_at', v_row.announced_at,
    'break_started_at', v_row.break_started_at,
    'break_ends_at', v_row.break_ends_at,
    'reason', v_row.reason,
    'ownership_token', v_row.ownership_token
  );
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_clear_engine_maintenance_break(p_phase text, p_announced_at timestamp with time zone, p_break_started_at timestamp with time zone, p_break_ends_at timestamp with time zone, p_reason text, p_ownership_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '35s'
 SET lock_timeout TO '32s'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  PERFORM release_ops.reject_legacy_maintenance_writer();
  IF p_ownership_token IS NULL THEN
    RAISE EXCEPTION 'MAINTENANCE_OWNERSHIP_REQUIRED: a break may only clear its own generation'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(530090, 1);
  DELETE FROM public.engine_maintenance_break b
   WHERE b.id = true
     AND b.phase IS NOT DISTINCT FROM p_phase
     AND b.announced_at IS NOT DISTINCT FROM p_announced_at
     AND b.break_started_at IS NOT DISTINCT FROM p_break_started_at
     AND b.break_ends_at IS NOT DISTINCT FROM p_break_ends_at
     AND b.reason IS NOT DISTINCT FROM p_reason
     AND b.ownership_token = p_ownership_token;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted = 1;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_thaw_platform(p_freeze_started timestamp with time zone, p_frozen_seconds numeric, p_thawed_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_break public.engine_maintenance_break%ROWTYPE;
  v_expected_start timestamptz;
BEGIN
  PERFORM release_ops.reject_legacy_maintenance_writer();
  PERFORM pg_advisory_xact_lock(530090, 1);
  SELECT * INTO v_break
    FROM public.engine_maintenance_break b
   WHERE b.id=true
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false,
      'reason', 'maintenance_row_missing'
    );
  END IF;

  v_expected_start := COALESCE(
    v_break.break_started_at,
    v_break.announced_at + INTERVAL '2 minutes'
  );
  IF v_expected_start IS DISTINCT FROM p_freeze_started THEN
    RETURN jsonb_build_object(
      'ok', false, 'complete', false,
      'reason', 'maintenance_identity_mismatch'
    );
  END IF;

  RETURN public.fn_thaw_platform_checkpointed(
    p_freeze_started,
    p_frozen_seconds,
    p_thawed_by
  );
END;
$function$
;

-- Every support function is private unless explicitly granted here. None of
-- these grants create a login, membership, credential or activated receipt.
DO $$ DECLARE p regprocedure; BEGIN
 FOR p IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='release_ops'::regnamespace AND (proname LIKE '%maintenance%' OR proname IN ('retained_v3_thaw','snapshot_operation_target_scope','operation_target_in_wave','credit_operation_wave_targets')) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,release_journal_reader,release_journal_submitter,release_journal_operator,release_journal_controller,release_journal_verifier',p);
 END LOOP;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA release_ops FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_engine_maintenance_operation(uuid),public.fn_claim_engine_maintenance_operation(uuid,uuid,uuid,text),
 public.fn_engine_maintenance_ready(uuid,uuid,uuid[],jsonb),public.fn_engine_maintenance_recovery(uuid,uuid,text),
 public.fn_authorize_engine_maintenance_wave(uuid,uuid,integer,uuid[]),public.fn_ack_engine_maintenance_wave(uuid,uuid,integer,uuid,uuid[],timestamptz),
 public.fn_ack_engine_maintenance_resumed(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_engine_maintenance_operation(uuid),public.fn_claim_engine_maintenance_operation(uuid,uuid,uuid,text),
 public.fn_engine_maintenance_ready(uuid,uuid,uuid[],jsonb),public.fn_engine_maintenance_recovery(uuid,uuid,text),
 public.fn_authorize_engine_maintenance_wave(uuid,uuid,integer,uuid[]),public.fn_ack_engine_maintenance_wave(uuid,uuid,integer,uuid,uuid[],timestamptz),
 public.fn_ack_engine_maintenance_resumed(uuid,uuid,uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.fn_maintenance_break_state_v2(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_maintenance_break_state_v2(uuid,uuid) TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION release_ops.register_maintenance_compatibility(uuid,jsonb,jsonb,text),release_ops.register_engine_maintenance_need(uuid,uuid,uuid,jsonb,text),
 release_ops.register_maintenance_safe_resume(uuid,uuid,jsonb,text) TO release_journal_verifier;
GRANT EXECUTE ON FUNCTION release_ops.activate_operation_maintenance(uuid,uuid,uuid,text),
 release_ops.admit_engine_maintenance(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text),
 release_ops.authorize_maintenance_step(uuid,uuid,uuid,text,bigint,bigint,bigint,text,uuid,text),
 release_ops.authorize_maintenance_release(uuid,uuid,uuid,uuid,text),release_ops.authorize_maintenance_observation(uuid,uuid,uuid,text) TO release_journal_controller;
GRANT EXECUTE ON FUNCTION release_ops.engine_maintenance_verification_context(uuid,uuid) TO release_journal_verifier,release_journal_controller;
-- Independently installed host capability: role only, no login or membership.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='release_journal_actuator') THEN
  CREATE ROLE release_journal_actuator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 ELSIF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='release_journal_actuator' AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
 THEN RAISE EXCEPTION 'MAINTENANCE_ACTUATOR_ROLE_INVALID'; END IF;
END $$;
GRANT USAGE ON SCHEMA release_ops TO release_journal_actuator;
CREATE TABLE release_ops.maintenance_step_consumptions (
 receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),step_id uuid NOT NULL UNIQUE REFERENCES release_ops.maintenance_steps(id),
 provider_operation_id uuid NOT NULL UNIQUE REFERENCES release_ops.external_operations(id),owner_id uuid NOT NULL,epoch uuid NOT NULL,
 host_bundle_digest text NOT NULL,principal text NOT NULL,consumed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON release_ops.maintenance_step_consumptions FROM PUBLIC,anon,authenticated,service_role,release_journal_actuator;
CREATE TRIGGER immutable_maintenance_consumption BEFORE UPDATE OR DELETE ON release_ops.maintenance_step_consumptions FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE FUNCTION release_ops.engine_maintenance_actuator_context(provider_operation_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations; o release_ops.maintenance_operations; c release_ops.maintenance_compatibility; p release_ops.provider_plans; s release_ops.maintenance_steps;
BEGIN
 SELECT * INTO e FROM release_ops.external_operations WHERE id=provider_operation_id;
 SELECT * INTO p FROM release_ops.provider_plans WHERE id=(e.intent->>'plan_id')::uuid;
 SELECT x.* INTO o FROM release_ops.maintenance_operations x JOIN release_ops.maintenance_needs n ON n.id=x.need_receipt
  WHERE x.release_id=e.release_id AND n.provider_plan_id=p.id ORDER BY x.freeze_started_at DESC LIMIT 1;
 SELECT * INTO c FROM release_ops.maintenance_compatibility WHERE id=o.activation_receipt;
 IF e.id IS NULL OR o.operation_id IS NULL OR c.components->'host_cutover'->>'principal' IS DISTINCT FROM session_user
 OR NOT pg_has_role(session_user,'release_journal_actuator','MEMBER') THEN RAISE EXCEPTION 'MAINTENANCE_ACTUATOR_IDENTITY_REQUIRED'; END IF;
 SELECT * INTO s FROM release_ops.maintenance_steps WHERE operation_id=o.operation_id AND step_key='publish:'||p.id::text ORDER BY authorized_at DESC LIMIT 1;
 RETURN jsonb_build_object('policy_version',2,'policy_digest',c.policy_digest,'activation_receipt',c.id,'provider_operation',to_jsonb(e),
 'provider_plan',to_jsonb(p),'provider_request',p.request,'expected_current',p.request->'expected_current','step',CASE WHEN s.id IS NULL THEN NULL ELSE to_jsonb(s) END,
 'interval',to_jsonb(o),'observed_at',clock_timestamp(),'consumption',(SELECT to_jsonb(x) FROM release_ops.maintenance_step_consumptions x WHERE x.provider_operation_id=e.id),
 'current_owner',(SELECT jsonb_build_object('owner_id',owner_id,'epoch',epoch,'active_release',active_release) FROM release_ops.controller WHERE singleton));
END $$;
CREATE FUNCTION release_ops.consume_engine_maintenance_step(owner uuid,epoch uuid,operation_id uuid,step_id uuid,provider_operation_id uuid,host_bundle_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE ctl release_ops.controller; o release_ops.maintenance_operations; s release_ops.maintenance_steps; e release_ops.external_operations;
 p release_ops.provider_plans; q release_ops.queue; c release_ops.maintenance_compatibility; claim release_ops.maintenance_step_consumptions; context jsonb; ts timestamptz;
BEGIN
 PERFORM release_ops.valid_actor(actor);
 SELECT * INTO ctl FROM release_ops.controller WHERE singleton FOR UPDATE;
 -- Host is a separate backend. It proves the controller's existing live session
 -- lock instead of acquiring another publisher lock or adopting its identity.
 IF ctl.owner_id IS DISTINCT FROM owner OR ctl.epoch IS DISTINCT FROM epoch OR ctl.reconciliation_required OR NOT ctl.execution_enabled
 OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=ctl.owner_backend AND locktype='advisory' AND classid=77319011 AND objid=1 AND objsubid=2 AND granted)
 THEN RAISE EXCEPTION 'MAINTENANCE_CONTROLLER_OWNER_NOT_LIVE'; END IF;
 SELECT * INTO o FROM release_ops.maintenance_operations WHERE maintenance_operations.operation_id=consume_engine_maintenance_step.operation_id;
 o:=release_ops.lock_maintenance_operation(o.interval_id);
 SELECT * INTO s FROM release_ops.maintenance_steps WHERE id=step_id;
 SELECT * INTO e FROM release_ops.external_operations WHERE id=provider_operation_id;
 SELECT * INTO p FROM release_ops.provider_plans WHERE id=(e.intent->>'plan_id')::uuid;
 SELECT * INTO q FROM release_ops.queue WHERE release_id=o.release_id;
 SELECT * INTO c FROM release_ops.maintenance_compatibility WHERE id=o.activation_receipt;
 IF c.components->'host_cutover'->>'principal' IS DISTINCT FROM session_user OR NOT pg_has_role(session_user,'release_journal_actuator','MEMBER')
 OR c.components->'host_cutover'->>'artifact_digest' IS DISTINCT FROM host_bundle_digest THEN RAISE EXCEPTION 'MAINTENANCE_ACTUATOR_BINDING_MISMATCH'; END IF;
 SELECT * INTO claim FROM release_ops.maintenance_step_consumptions WHERE maintenance_step_consumptions.step_id=consume_engine_maintenance_step.step_id;
 IF claim.receipt_id IS NOT NULL THEN RETURN jsonb_build_object('consumed',false,'reason','already_consumed_readback_only','receipt_id',claim.receipt_id); END IF;
 ts:=clock_timestamp();
 IF ctl.active_release IS DISTINCT FROM o.release_id OR o.controller_owner IS DISTINCT FROM owner OR o.controller_epoch IS DISTINCT FROM epoch
 OR o.phase<>'applying' OR o.ready_at IS NULL OR s.id IS NULL OR s.operation_id IS DISTINCT FROM o.operation_id
 OR s.owner_id IS DISTINCT FROM owner OR s.epoch IS DISTINCT FROM epoch OR s.kind<>'engine_cutover' OR s.proof_receipt<>o.need_receipt
 OR s.not_after_at<=ts OR s.step_key IS DISTINCT FROM 'publish:'||p.id::text OR e.id IS NULL OR e.kind<>'PUBLISH' OR e.status NOT IN ('INTENT','UNKNOWN')
 OR e.owner_id IS DISTINCT FROM owner OR e.epoch IS DISTINCT FROM epoch OR e.release_id IS DISTINCT FROM o.release_id
 OR p.id IS NULL OR p.readiness_event::text IS DISTINCT FROM q.selected_receipts->>'READINESS' OR p.recovery_id IS DISTINCT FROM q.recovery_id
 OR p.request IS DISTINCT FROM e.intent->'provider_request' OR p.request->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR p.request->>'target' IS DISTINCT FROM 'club-arena-engine' OR c.installation_id::text IS DISTINCT FROM ctl.installed_adapter_receipt
 OR NOT EXISTS(SELECT 1 FROM release_ops.provider_submissions x WHERE x.operation_id=e.id AND x.owner_id=owner AND x.epoch=epoch AND x.installation_id=c.installation_id)
 THEN RAISE EXCEPTION 'MAINTENANCE_ACTUATOR_STEP_NOT_CURRENT'; END IF;
 IF ts+make_interval(secs=>(s.estimated_ms+s.margin_ms)/1000.0)>o.forward_deadline_at
 OR ts+make_interval(secs=>(s.estimated_ms+GREATEST(600000,s.recovery_ms)+s.margin_ms)/1000.0)>o.deadline_at THEN
  UPDATE release_ops.maintenance_operations SET phase='recovery_required',reason='Maintenance requires verified recovery',updated_at=ts WHERE interval_id=o.interval_id;
  RETURN jsonb_build_object('consumed',false,'reason','recovery_required');
 END IF;
 INSERT INTO release_ops.maintenance_step_consumptions(step_id,provider_operation_id,owner_id,epoch,host_bundle_digest,principal)
 VALUES(step_id,provider_operation_id,owner,epoch,host_bundle_digest,session_user) RETURNING * INTO claim;
 context:=release_ops.engine_maintenance_actuator_context(provider_operation_id);
 RETURN jsonb_build_object('consumed',true,'receipt_id',claim.receipt_id,'authority',context||jsonb_build_object(
  'readiness',(SELECT to_jsonb(r) FROM release_ops.receipts r WHERE r.event_id::text=q.selected_receipts->>'READINESS' AND r.release_id=o.release_id),
  'build',(SELECT to_jsonb(r) FROM release_ops.receipts r WHERE r.event_id::text=q.selected_receipts->>'BUILD' AND r.release_id=o.release_id)));
END $$;
REVOKE ALL ON FUNCTION release_ops.engine_maintenance_actuator_context(uuid),release_ops.consume_engine_maintenance_step(uuid,uuid,uuid,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION release_ops.engine_maintenance_actuator_context(uuid),release_ops.consume_engine_maintenance_step(uuid,uuid,uuid,uuid,uuid,text,text) TO release_journal_actuator;

-- The actual actuator transport checks both versions before reading/consuming
-- authority. One returns a constant; the other reads only the singleton version.
-- Pin those narrow read bodies before adding this existing role's EXECUTE.
DO $actuator_versions$ BEGIN
 IF EXISTS(
  SELECT 1 FROM (VALUES
   ('release_ops.schema_version()','e54beb7b18120e78e52d2f404b103a38'),
   ('release_ops.provider_schema_version()','0df94e01a9bac1ebb35ed4cfae23bb4f')
  ) expected(signature,body_md5)
  LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE p.oid IS NULL OR md5(p.prosrc)<>expected.body_md5
   OR pg_get_userbyid(p.proowner)<>'postgres' OR NOT p.prosecdef
   OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='sql')
   OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[]
   OR p.prorettype<>'integer'::regtype OR p.proretset OR p.pronargs<>0
 ) THEN RAISE EXCEPTION 'MAINTENANCE_ACTUATOR_VERSION_SOURCE_DRIFT'; END IF;
END $actuator_versions$;
GRANT EXECUTE ON FUNCTION release_ops.schema_version(),release_ops.provider_schema_version() TO release_journal_actuator;


-- Individual declarations retain the observed server-only ACLs and make them
-- independently reviewable by the repository authorization gate.
REVOKE ALL ON FUNCTION public.fn_engine_maintenance_operation(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_engine_maintenance_operation(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_claim_engine_maintenance_operation(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_engine_maintenance_operation(uuid,uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_engine_maintenance_ready(uuid,uuid,uuid[],jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_engine_maintenance_ready(uuid,uuid,uuid[],jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.fn_engine_maintenance_recovery(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_engine_maintenance_recovery(uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_authorize_engine_maintenance_wave(uuid,uuid,integer,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_authorize_engine_maintenance_wave(uuid,uuid,integer,uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ack_engine_maintenance_wave(uuid,uuid,integer,uuid,uuid[],timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ack_engine_maintenance_wave(uuid,uuid,integer,uuid,uuid[],timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ack_engine_maintenance_resumed(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ack_engine_maintenance_resumed(uuid,uuid,uuid[]) TO service_role;
REVOKE ALL ON FUNCTION public.fn_save_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_save_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_claim_engine_maintenance_break(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_engine_maintenance_break(uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_clear_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_clear_engine_maintenance_break(text,timestamptz,timestamptz,timestamptz,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_thaw_platform(timestamptz,timestamptz,numeric,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_thaw_platform(timestamptz,numeric,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_thaw_platform(timestamptz,numeric,text) TO service_role;

COMMIT;
