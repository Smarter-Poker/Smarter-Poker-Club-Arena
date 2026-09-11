-- 20260911160341_provider_operation_boundary.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Add immutable qualified provider plans, installed authority receipts,
-- single-send authorizations and bounded provider readback windows. No login
-- membership, activation, provider mutation, or gameplay schema change.

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
SET LOCAL synchronous_commit=on;

CREATE TABLE release_ops.provider_installations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bundle_digest text NOT NULL,
 binding jsonb NOT NULL, evidence jsonb NOT NULL, principal text NOT NULL,
 event_id uuid NOT NULL REFERENCES release_ops.events(id)
);
CREATE TABLE release_ops.provider_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), release_id uuid NOT NULL REFERENCES release_ops.admissions(id),
 operation_key text NOT NULL, adapter text NOT NULL, request jsonb NOT NULL,
 readiness_event uuid NOT NULL REFERENCES release_ops.events(id), recovery_id uuid,
 event_id uuid NOT NULL REFERENCES release_ops.events(id), event_no bigint NOT NULL,
 UNIQUE(release_id,operation_key), CHECK(adapter IN ('vercel-promote','hetzner-intake'))
);
CREATE TABLE release_ops.provider_submissions (
 operation_id uuid PRIMARY KEY REFERENCES release_ops.external_operations(id),
 installation_id uuid NOT NULL REFERENCES release_ops.provider_installations(id),
 owner_id uuid NOT NULL, epoch uuid NOT NULL, event_id uuid NOT NULL REFERENCES release_ops.events(id)
);
CREATE TABLE release_ops.provider_observations (
 operation_id uuid NOT NULL REFERENCES release_ops.external_operations(id),
 check_no integer NOT NULL CHECK(check_no BETWEEN 1 AND 160), data jsonb NOT NULL,
 event_id uuid NOT NULL REFERENCES release_ops.events(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 next_check_at timestamptz, PRIMARY KEY(operation_id,check_no)
);
CREATE TABLE release_ops.provider_readback_windows (
 operation_id uuid NOT NULL REFERENCES release_ops.external_operations(id), window_no integer NOT NULL CHECK(window_no BETWEEN 1 AND 3),
 event_id uuid NOT NULL REFERENCES release_ops.events(id), PRIMARY KEY(operation_id,window_no)
);
CREATE TRIGGER immutable_provider_installation BEFORE UPDATE OR DELETE ON release_ops.provider_installations FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE TRIGGER immutable_provider_plan BEFORE UPDATE OR DELETE ON release_ops.provider_plans FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE TRIGGER immutable_provider_submission BEFORE UPDATE OR DELETE ON release_ops.provider_submissions FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE TRIGGER immutable_provider_observation BEFORE UPDATE OR DELETE ON release_ops.provider_observations FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE TRIGGER immutable_provider_readback_window BEFORE UPDATE OR DELETE ON release_ops.provider_readback_windows FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();

CREATE FUNCTION release_ops.provider_schema_version() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$;

-- An independent verifier records installed authority. This cannot activate it.
CREATE FUNCTION release_ops.register_provider_installation(bundle_digest text,binding jsonb,evidence jsonb,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE i release_ops.provider_installations; event_id uuid;
BEGIN
 PERFORM release_ops.valid_actor(actor);
 PERFORM 1 FROM release_ops.controller WHERE singleton FOR UPDATE;
 IF COALESCE(bundle_digest,'') !~ '^[0-9a-f]{64}$' OR jsonb_typeof(binding) IS DISTINCT FROM 'object' OR octet_length(binding::text)>65536
 OR COALESCE(binding->>'config_digest','') !~ '^[0-9a-f]{64}$'
 OR COALESCE(binding->>'host_id','')='' OR binding->>'service' IS DISTINCT FROM 'club-arena-release-controller.service'
 OR binding->>'native_lock_path' IS DISTINCT FROM '/var/lib/club-arena-release-controller/controller.lock'
 OR binding->>'schema_version' IS DISTINCT FROM '1' OR binding->>'provider_schema_version' IS DISTINCT FROM '1'
 OR jsonb_typeof(binding->'adapters') IS DISTINCT FROM 'array' OR jsonb_array_length(binding->'adapters') NOT BETWEEN 1 AND 6
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(binding->'adapters') a WHERE a NOT IN ('vercel-promote','hetzner-intake','github-merge','github-workflow','engine-stage','github-certification'))
 OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=binding->>'controller_principal' AND r.rolcanlogin
   AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
   AND pg_has_role(r.oid,'release_journal_controller','MEMBER'))
 OR jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR octet_length(evidence::text)>65536
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['installed_code','identity_membership','exclusive_native_service',
  'legacy_writers_retired','candidate_build_authority_isolated','provider_scope','compatible_recovery']) key
  WHERE jsonb_typeof(evidence->key) IS DISTINCT FROM 'array' OR jsonb_array_length(evidence->key)=0)
 THEN RAISE EXCEPTION 'RELEASE_PROVIDER_INSTALLATION_PROOF_REQUIRED'; END IF;
 event_id:=release_ops.event(NULL,'PROVIDER_INSTALLATION',actor,jsonb_build_object('bundle_digest',bundle_digest,'binding',binding,'evidence',evidence));
 INSERT INTO release_ops.provider_installations(bundle_digest,binding,evidence,principal,event_id)
 VALUES(bundle_digest,binding,evidence,session_user,event_id) RETURNING * INTO i;
 RETURN to_jsonb(i);
END $$;

CREATE FUNCTION release_ops.submit_provider_plan(release_id uuid,operation_key text,adapter text,request jsonb,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; p release_ops.provider_plans; r release_ops.receipts; b release_ops.receipts; event_id uuid;
BEGIN
 PERFORM release_ops.valid_actor(actor);
 PERFORM 1 FROM release_ops.controller WHERE singleton FOR UPDATE;
 SELECT * INTO p FROM release_ops.provider_plans x WHERE x.release_id=submit_provider_plan.release_id AND x.operation_key=submit_provider_plan.operation_key;
 IF FOUND THEN
  IF p.adapter IS DISTINCT FROM adapter OR p.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'RELEASE_PROVIDER_PLAN_MISMATCH'; END IF;
  RETURN to_jsonb(p);
 END IF;
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=submit_provider_plan.release_id FOR UPDATE;
 SELECT * INTO r FROM release_ops.receipts WHERE receipts.release_id=q.release_id AND receipts.event_id=(q.selected_receipts->>'READINESS')::uuid;
 SELECT * INTO b FROM release_ops.receipts WHERE receipts.release_id=q.release_id AND receipts.event_id=(q.selected_receipts->>'BUILD')::uuid;
 IF q.release_id IS NULL OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id
 OR q.state<>'APPLYING' OR q.attempt_deadline<=clock_timestamp()
 OR adapter IS NULL OR adapter NOT IN ('vercel-promote','hetzner-intake')
 OR operation_key IS NULL OR length(operation_key) NOT BETWEEN 1 AND 600
 OR jsonb_typeof(request) IS DISTINCT FROM 'object' OR octet_length(request::text)>65536
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(request) key WHERE NOT key=ANY(
   CASE adapter WHEN 'vercel-promote' THEN ARRAY['target','manifest_digest','source_sha','project_id','team_id','deployment_id','domains','expected_current']
   ELSE ARRAY['target','manifest_digest','source_sha','control_sha','run_key','server_tree_sha','artifact_image_id','actor','not_after_epoch','expected_current'] END))
 OR b.event_id IS NULL OR request->>'source_sha' IS DISTINCT FROM b.data->>'source_sha'
 OR COALESCE(request->>'source_sha','') !~ '^[a-f0-9]{40}$'
 OR (CASE adapter WHEN 'vercel-promote' THEN request->>'deployment_id' ELSE request->>'artifact_image_id' END)
    IS DISTINCT FROM b.data->'artifact'->'components'->(request->>'target')->>'identity'
 OR request->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR request->>'target' IS DISTINCT FROM (CASE adapter WHEN 'vercel-promote' THEN 'world-hub-web' ELSE 'club-arena-engine' END)
 OR (adapter='vercel-promote' AND request->>'project_id' IS DISTINCT FROM (SELECT project FROM release_ops.targets WHERE target='world-hub-web'))
 OR jsonb_typeof(request->'expected_current') IS DISTINCT FROM 'object'
 OR r.event_id IS NULL OR r.recovery_id IS DISTINCT FROM q.recovery_id OR b.recovery_id IS DISTINCT FROM q.recovery_id
 OR r.data->'provider_requests'->adapter IS DISTINCT FROM request
 THEN RAISE EXCEPTION 'RELEASE_PROVIDER_QUALIFIED_PLAN_REQUIRED'; END IF;
 event_id:=release_ops.event(release_id,'PROVIDER_PLAN',actor,jsonb_build_object('operation_key',operation_key,'adapter',adapter,'request',request));
 INSERT INTO release_ops.provider_plans(release_id,operation_key,adapter,request,readiness_event,recovery_id,event_id,event_no)
 VALUES(release_id,operation_key,adapter,request,r.event_id,q.recovery_id,event_id,(SELECT last_event FROM release_ops.controller WHERE singleton)) RETURNING * INTO p;
 RETURN to_jsonb(p);
END $$;

CREATE FUNCTION release_ops.provider_installation(owner uuid,epoch uuid,bundle_digest text,config_digest text,execute boolean DEFAULT true) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE i release_ops.provider_installations;
BEGIN
 PERFORM release_ops.check_owner(owner,epoch,execute);
 SELECT * INTO i FROM release_ops.provider_installations WHERE id::text=(SELECT installed_adapter_receipt FROM release_ops.controller WHERE singleton);
 IF i.id IS NULL OR i.bundle_digest IS DISTINCT FROM bundle_digest OR i.binding->>'config_digest' IS DISTINCT FROM config_digest
 OR i.binding->>'controller_principal' IS DISTINCT FROM session_user THEN RAISE EXCEPTION 'RELEASE_PROVIDER_INSTALLED_IDENTITY_REQUIRED'; END IF;
 RETURN to_jsonb(i);
END $$;

CREATE FUNCTION release_ops.begin_provider_plan(owner uuid,epoch uuid,plan_id uuid,bundle_digest text,config_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE p release_ops.provider_plans; q release_ops.queue; i jsonb; intent jsonb;
BEGIN
 i:=release_ops.provider_installation(owner,epoch,bundle_digest,config_digest);
 SELECT * INTO p FROM release_ops.provider_plans WHERE id=plan_id;
 SELECT * INTO q FROM release_ops.queue WHERE release_id=p.release_id;
 IF p.id IS NULL OR NOT (i->'binding'->'adapters' ? p.adapter)
 OR p.readiness_event::text IS DISTINCT FROM q.selected_receipts->>'READINESS'
 OR p.recovery_id IS DISTINCT FROM q.recovery_id OR p.request->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 THEN RAISE EXCEPTION 'RELEASE_PROVIDER_PLAN_STALE'; END IF;
 intent:=jsonb_build_object('target',p.request->>'target','manifest_digest',p.request->>'manifest_digest',
 'expected_current',p.request->'expected_current','provider_request',p.request,'adapter',p.adapter,'plan_id',p.id,'installation_id',i->>'id');
 RETURN release_ops.begin_external(owner,epoch,p.release_id,p.operation_key,'PUBLISH',intent,actor);
END $$;

-- Lost authorization responses are readback-only, including after restart.
CREATE FUNCTION release_ops.authorize_provider_submit(owner uuid,epoch uuid,operation_id uuid,bundle_digest text,config_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations; i jsonb; event_id uuid;
BEGIN
 PERFORM release_ops.valid_actor(actor);
 i:=release_ops.provider_installation(owner,epoch,bundle_digest,config_digest);
 SELECT * INTO e FROM release_ops.external_operations WHERE id=operation_id FOR UPDATE;
 IF e.id IS NULL OR e.owner_id IS DISTINCT FROM owner OR e.epoch IS DISTINCT FROM epoch OR e.status<>'INTENT'
 OR e.intent->>'installation_id' IS DISTINCT FROM i->>'id' THEN RAISE EXCEPTION 'RELEASE_PROVIDER_SUBMIT_FENCE'; END IF;
 IF EXISTS(SELECT 1 FROM release_ops.provider_submissions WHERE provider_submissions.operation_id=authorize_provider_submit.operation_id) THEN
  RETURN jsonb_build_object('may_submit',false);
 END IF;
 IF (SELECT attempt_deadline<=clock_timestamp() FROM release_ops.queue WHERE release_id=e.release_id) THEN RAISE EXCEPTION 'RELEASE_ATTEMPT_EXPIRED'; END IF;
 event_id:=release_ops.event(e.release_id,'PROVIDER_SUBMIT_AUTHORIZED',actor,jsonb_build_object('operation_id',operation_id,'installation_id',i->>'id'));
 INSERT INTO release_ops.provider_submissions VALUES(operation_id,(i->>'id')::uuid,owner,epoch,event_id);
 RETURN jsonb_build_object('may_submit',true,'event_id',event_id);
END $$;

CREATE FUNCTION release_ops.provider_snapshot(owner uuid,epoch uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE c release_ops.controller; e release_ops.external_operations; p release_ops.provider_plans; o release_ops.provider_observations;
BEGIN
 PERFORM release_ops.check_owner(owner,epoch,false);
 SELECT * INTO c FROM release_ops.controller WHERE singleton;
 SELECT * INTO e FROM release_ops.external_operations WHERE status IN ('INTENT','UNKNOWN') LIMIT 1;
 SELECT * INTO o FROM release_ops.provider_observations WHERE operation_id=e.id ORDER BY check_no DESC LIMIT 1;
 SELECT provider_plans.* INTO p FROM release_ops.provider_plans JOIN release_ops.queue q USING(release_id)
 WHERE release_id=c.active_release AND provider_plans.recovery_id IS NOT DISTINCT FROM q.recovery_id
 AND provider_plans.readiness_event::text=q.selected_receipts->>'READINESS'
 AND NOT EXISTS(SELECT 1 FROM release_ops.external_operations x WHERE x.release_id=provider_plans.release_id AND x.operation_key=provider_plans.operation_key)
 ORDER BY event_no LIMIT 1;
 RETURN jsonb_build_object('controller',to_jsonb(c)-'owner_backend','external',CASE WHEN e.id IS NULL THEN NULL ELSE to_jsonb(e) END,
 'plan',CASE WHEN p.id IS NULL THEN NULL ELSE to_jsonb(p) END,'observation',CASE WHEN o.operation_id IS NULL THEN NULL ELSE to_jsonb(o) END,
 'readback_remaining',(CASE WHEN e.kind='CERTIFY' THEN 160 ELSE 40*(1+(SELECT count(*) FROM release_ops.provider_readback_windows WHERE operation_id=e.id)) END)-COALESCE(o.check_no,0));
END $$;

CREATE FUNCTION release_ops.authorize_provider_readback(operation_id uuid,actor text,reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations; windows integer; checks integer; event_id uuid;
BEGIN
 PERFORM release_ops.valid_actor(actor,reason);
 PERFORM 1 FROM release_ops.controller WHERE singleton FOR UPDATE;
 SELECT * INTO e FROM release_ops.external_operations WHERE id=operation_id FOR UPDATE;
 IF e.id IS NULL OR e.status NOT IN ('INTENT','UNKNOWN') THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_NOT_PENDING'; END IF;
 SELECT count(*) INTO windows FROM release_ops.provider_readback_windows w WHERE w.operation_id=authorize_provider_readback.operation_id;
 SELECT COALESCE(max(check_no),0) INTO checks FROM release_ops.provider_observations o WHERE o.operation_id=authorize_provider_readback.operation_id;
 IF e.kind='CERTIFY' OR windows>=3 OR checks<40*(1+windows) THEN RAISE EXCEPTION 'RELEASE_PROVIDER_READBACK_EXTENSION_INVALID'; END IF;
 event_id:=release_ops.event(e.release_id,'PROVIDER_READBACK_WINDOW',actor,jsonb_build_object('operation_id',operation_id,'reason',reason,'window_no',windows+1));
 INSERT INTO release_ops.provider_readback_windows VALUES(operation_id,windows+1,event_id);
 RETURN jsonb_build_object('operation_id',operation_id,'window_no',windows+1,'read_only_checks',40);
END $$;

CREATE FUNCTION release_ops.record_provider_observation(owner uuid,epoch uuid,operation_id uuid,data jsonb,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations; n integer; budget integer; event_id uuid; o release_ops.provider_observations;
BEGIN
 PERFORM release_ops.valid_actor(actor); PERFORM release_ops.check_owner(owner,epoch,false);
 SELECT * INTO e FROM release_ops.external_operations WHERE id=operation_id FOR UPDATE;
 IF e.id IS NULL OR e.status NOT IN ('INTENT','UNKNOWN') OR jsonb_typeof(data) IS DISTINCT FROM 'object'
 OR octet_length(data::text)>65536 OR data->>'operation_id' IS DISTINCT FROM operation_id::text THEN RAISE EXCEPTION 'RELEASE_PROVIDER_OBSERVATION_INVALID'; END IF;
 SELECT COALESCE(max(check_no),0)+1 INTO n FROM release_ops.provider_observations WHERE provider_observations.operation_id=record_provider_observation.operation_id;
 SELECT CASE WHEN e.kind='CERTIFY' THEN 160 ELSE 40*(1+count(*)) END INTO budget FROM release_ops.provider_readback_windows w WHERE w.operation_id=record_provider_observation.operation_id;
 IF n>budget THEN RAISE EXCEPTION 'RELEASE_PROVIDER_READBACK_BUDGET_EXHAUSTED'; END IF;
 event_id:=release_ops.event(e.release_id,'PROVIDER_OBSERVATION',actor,data);
 INSERT INTO release_ops.provider_observations VALUES(operation_id,n,data,event_id,clock_timestamp(),
 CASE WHEN n<budget AND data->>'terminal' IS DISTINCT FROM 'true' THEN clock_timestamp()+make_interval(secs=>LEAST(60,5*n)) ELSE NULL END) RETURNING * INTO o;
 RETURN to_jsonb(o);
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA release_ops FROM PUBLIC;
REVOKE ALL ON FUNCTION release_ops.provider_schema_version(),release_ops.register_provider_installation(text,jsonb,jsonb,text),
 release_ops.submit_provider_plan(uuid,text,text,jsonb,text),release_ops.provider_installation(uuid,uuid,text,text,boolean),
 release_ops.begin_provider_plan(uuid,uuid,uuid,text,text,text),release_ops.authorize_provider_submit(uuid,uuid,uuid,text,text,text),
 release_ops.provider_snapshot(uuid,uuid),release_ops.record_provider_observation(uuid,uuid,uuid,jsonb,text),release_ops.authorize_provider_readback(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_ops.provider_schema_version() TO release_journal_reader,release_journal_controller,release_journal_operator,release_journal_verifier;
GRANT EXECUTE ON FUNCTION release_ops.register_provider_installation(text,jsonb,jsonb,text) TO release_journal_verifier;
GRANT EXECUTE ON FUNCTION release_ops.submit_provider_plan(uuid,text,text,jsonb,text),release_ops.authorize_provider_readback(uuid,text,text) TO release_journal_operator;
GRANT EXECUTE ON FUNCTION release_ops.provider_installation(uuid,uuid,text,text,boolean),release_ops.begin_provider_plan(uuid,uuid,uuid,text,text,text),
 release_ops.authorize_provider_submit(uuid,uuid,uuid,text,text,text),release_ops.provider_snapshot(uuid,uuid),
 release_ops.record_provider_observation(uuid,uuid,uuid,jsonb,text) TO release_journal_controller;
ALTER TABLE release_ops.external_operations ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE TABLE release_ops.source_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), release_id uuid NOT NULL REFERENCES release_ops.admissions(id),
 attempt_id uuid NOT NULL, phase text NOT NULL CHECK(phase IN ('VALIDATION','MERGE','BUILD','STAGE','CERTIFY')),
 adapter text NOT NULL CHECK(adapter IN ('github-merge','github-workflow','engine-stage','github-certification')), request jsonb NOT NULL,
 event_id uuid NOT NULL REFERENCES release_ops.events(id), UNIQUE(release_id,attempt_id,phase)
);
CREATE TABLE release_ops.admission_deliveries (
 delivery_id uuid PRIMARY KEY, payload_digest text NOT NULL, receipt jsonb NOT NULL,
 event_id uuid NOT NULL REFERENCES release_ops.events(id)
);
CREATE TRIGGER immutable_source_plan BEFORE UPDATE OR DELETE ON release_ops.source_plans FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE TRIGGER immutable_admission_delivery BEFORE UPDATE OR DELETE ON release_ops.admission_deliveries FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();

-- Authenticated delivery handling is implemented in the installed consumer.
-- This API is no more privileged than ordinary enqueue and commits both once.
CREATE FUNCTION release_ops.enqueue_delivery(delivery_id uuid,payload_digest text,client_key text,intent jsonb,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE prior release_ops.admission_deliveries; receipt jsonb; event_id uuid;
BEGIN
 PERFORM 1 FROM release_ops.controller WHERE singleton FOR UPDATE;
 IF delivery_id IS NULL OR COALESCE(payload_digest,'') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'RELEASE_EVENT_DELIVERY_INVALID'; END IF;
 SELECT * INTO prior FROM release_ops.admission_deliveries d WHERE d.delivery_id=enqueue_delivery.delivery_id;
 IF FOUND THEN
  IF prior.payload_digest<>payload_digest THEN RAISE EXCEPTION 'RELEASE_EVENT_DELIVERY_MISMATCH'; END IF;
  RETURN prior.receipt;
 END IF;
 receipt:=release_ops.enqueue(client_key,intent,actor);
 event_id:=release_ops.event((receipt->>'id')::uuid,'ADMISSION_DELIVERY',actor,jsonb_build_object('delivery_id',delivery_id,'payload_digest',payload_digest));
 INSERT INTO release_ops.admission_deliveries VALUES(delivery_id,payload_digest,receipt,event_id);
 RETURN receipt;
END $$;

CREATE FUNCTION release_ops.source_snapshot(owner uuid,epoch uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; a release_ops.admissions; p release_ops.source_plans; e release_ops.external_operations;
BEGIN
 PERFORM release_ops.check_owner(owner,epoch,false);
 SELECT * INTO q FROM release_ops.queue WHERE release_id=(SELECT active_release FROM release_ops.controller WHERE singleton);
 SELECT * INTO a FROM release_ops.admissions WHERE id=q.release_id;
 SELECT * INTO p FROM release_ops.source_plans WHERE release_id=q.release_id AND attempt_id=q.attempt_id
 AND phase=CASE q.state WHEN 'VALIDATING' THEN 'VALIDATION' WHEN 'MERGING' THEN 'MERGE' WHEN 'BUILDING' THEN 'BUILD' WHEN 'STAGED' THEN 'STAGE' WHEN 'VERIFYING' THEN 'CERTIFY' END;
 SELECT * INTO e FROM release_ops.external_operations WHERE release_id=q.release_id AND operation_key='source:'||p.id;
 RETURN jsonb_build_object('queue',CASE WHEN q.release_id IS NULL THEN NULL ELSE to_jsonb(q) END,
 'admission',CASE WHEN a.id IS NULL THEN NULL ELSE to_jsonb(a) END,
 'plan',CASE WHEN p.id IS NULL THEN NULL ELSE to_jsonb(p) END,
 'operation',CASE WHEN e.id IS NULL THEN NULL ELSE to_jsonb(e) END,
 'receipts',(SELECT COALESCE(jsonb_object_agg(r.kind,to_jsonb(r)),'{}'::jsonb) FROM release_ops.receipts r
 WHERE r.release_id=q.release_id AND r.event_id::text IN (SELECT value FROM jsonb_each_text(q.selected_receipts))),
 'publication_results',(SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM release_ops.external_operations x
 WHERE x.release_id=q.release_id AND x.kind='PUBLISH' AND x.intent->>'manifest_digest'=q.resolution_manifest_digest
 AND x.status IN ('SUCCEEDED','FAILED','CANCELLED','NOT_ACCEPTED')
 AND EXISTS(SELECT 1 FROM release_ops.provider_plans pp WHERE pp.id::text=x.intent->>'plan_id'
 AND pp.readiness_event::text=q.selected_receipts->>'READINESS' AND pp.recovery_id IS NOT DISTINCT FROM q.recovery_id)));
END $$;

CREATE FUNCTION release_ops.submit_source_plan(owner uuid,epoch uuid,release_id uuid,phase text,request jsonb,bundle_digest text,config_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; a release_ops.admissions; p release_ops.source_plans; i jsonb; adapter text; event_id uuid; v jsonb;
BEGIN
 i:=release_ops.provider_installation(owner,epoch,bundle_digest,config_digest);
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=submit_source_plan.release_id;
 SELECT * INTO a FROM release_ops.admissions WHERE id=q.release_id;
 adapter:=CASE phase WHEN 'MERGE' THEN 'github-merge' WHEN 'STAGE' THEN 'engine-stage' WHEN 'CERTIFY' THEN 'github-certification' ELSE 'github-workflow' END;
 IF (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id
 OR q.state IS DISTINCT FROM (CASE phase WHEN 'VALIDATION' THEN 'VALIDATING' WHEN 'MERGE' THEN 'MERGING' WHEN 'BUILD' THEN 'BUILDING' WHEN 'STAGE' THEN 'STAGED' WHEN 'CERTIFY' THEN 'VERIFYING' END)
 OR q.attempt_deadline<=clock_timestamp() OR NOT(i->'binding'->'adapters' ? adapter)
 OR jsonb_typeof(request) IS DISTINCT FROM 'object' OR octet_length(request::text)>65536
 OR request->>'repository' IS DISTINCT FROM a.intent->>'repository'
 OR request->>'accepted_head_sha' IS DISTINCT FROM q.resolution_head_sha
 OR request->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR COALESCE(request->>'expected_base_sha','') !~ '^[0-9a-f]{40}$'
 OR COALESCE(request->>'tested_tree_sha','') !~ '^[0-9a-f]{40}$'
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.resolution_manifest->'components') c WHERE c->>'target'=request->>'target')
 THEN RAISE EXCEPTION 'RELEASE_SOURCE_PLAN_INVALID'; END IF;
 IF phase='MERGE' THEN
  SELECT r.data INTO v FROM release_ops.receipts r WHERE r.event_id=(q.selected_receipts->>'VALIDATION')::uuid;
  IF request->>'pr' IS DISTINCT FROM a.intent->>'pull_request' OR request->>'expected_base_sha' IS DISTINCT FROM v->>'expected_base_sha'
  OR request->>'tested_tree_sha' IS DISTINCT FROM v->>'tested_tree_sha' THEN RAISE EXCEPTION 'RELEASE_SOURCE_PLAN_UNQUALIFIED'; END IF;
 ELSIF phase IN ('VALIDATION','BUILD') THEN
  IF request->>'phase' IS DISTINCT FROM phase OR request->>'control_sha' IS DISTINCT FROM i->'binding'->'github'->>'control_sha'
  OR request->>'workflow_id' IS DISTINCT FROM i->'binding'->'github'->>'workflow_id'
  OR request->>'runtime_image' IS DISTINCT FROM i->'binding'->'github'->>'runtime_image'
  OR (SELECT COALESCE(jsonb_agg(x ORDER BY x),'[]'::jsonb) FROM jsonb_array_elements_text(request->'components') x)
   IS DISTINCT FROM (SELECT jsonb_agg(c->>'target' ORDER BY c->>'target') FROM jsonb_array_elements(q.resolution_manifest->'components') c)
  OR COALESCE(request->>'source_sha','') !~ '^[0-9a-f]{40}$' THEN RAISE EXCEPTION 'RELEASE_SOURCE_WORKFLOW_SCOPE_INVALID'; END IF;
  IF phase='BUILD' THEN
   SELECT r.data INTO v FROM release_ops.receipts r WHERE r.event_id=(q.selected_receipts->>'INTEGRATION')::uuid;
   IF request->>'source_sha' IS DISTINCT FROM v->>'merged_sha' OR request->>'tested_tree_sha' IS DISTINCT FROM v->>'merged_tree_sha'
   OR request->>'expected_base_sha' IS DISTINCT FROM v->>'expected_base_sha' THEN RAISE EXCEPTION 'RELEASE_SOURCE_PLAN_UNQUALIFIED'; END IF;
  END IF;
 ELSIF phase='STAGE' THEN
  SELECT r.data INTO v FROM release_ops.receipts r WHERE r.event_id=(q.selected_receipts->>'BUILD')::uuid;
  IF request->>'source_sha' IS DISTINCT FROM v->>'source_sha'
  OR request->>'artifact_image_id' IS DISTINCT FROM v->'artifact'->'components'->'club-arena-engine'->>'identity'
  OR request->>'archive_digest' IS DISTINCT FROM v->'artifact'->'components'->'club-arena-engine'->>'archive_digest'
  OR request->>'archive_bytes' IS DISTINCT FROM v->'artifact'->'components'->'club-arena-engine'->>'archive_bytes'
  OR request->>'github_artifact_id' IS DISTINCT FROM v->'artifact'->'components'->'club-arena-engine'->>'github_artifact_id'
  OR request->>'github_archive_digest' IS DISTINCT FROM v->'artifact'->'components'->'club-arena-engine'->>'github_archive_digest'
  OR request->>'github_archive_bytes' IS DISTINCT FROM v->'artifact'->'components'->'club-arena-engine'->>'github_archive_bytes'
  OR request->>'build_operation_id' IS DISTINCT FROM v->'artifact'->'components'->'club-arena-engine'->>'build_operation_id'
  OR request->>'build_run_id' IS DISTINCT FROM v->>'build_run_id'
  OR request->>'server_tree_sha' IS DISTINCT FROM v->'artifact'->'components'->'club-arena-engine'->>'server_tree_sha'
  OR COALESCE(request->>'control_sha','') !~ '^[0-9a-f]{40}$'
  OR request->>'control_sha' IS DISTINCT FROM i->'binding'->'engine'->>'control_sha'
  OR jsonb_typeof(request->'expected_current') IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION 'RELEASE_STAGE_BUILD_BINDING_REQUIRED'; END IF;
 ELSIF phase='CERTIFY' THEN
  SELECT r.data INTO v FROM release_ops.receipts r WHERE r.event_id=(q.selected_receipts->>'BUILD')::uuid;
  IF request->>'phase' IS DISTINCT FROM 'CERTIFY' OR request->>'target' IS DISTINCT FROM 'club-arena-engine'
  OR request->>'source_sha' IS DISTINCT FROM v->>'source_sha'
  OR request->>'artifact_image_id' IS DISTINCT FROM v->'artifact'->'components'->'club-arena-engine'->>'identity'
  OR request->>'frontend_source_sha' IS DISTINCT FROM (SELECT r.data->'retained_components'->'club-arena-web'->>'source_sha'
   FROM release_ops.receipts r WHERE r.event_id=(q.selected_receipts->>'READINESS')::uuid)
  OR request->>'control_sha' IS DISTINCT FROM i->'binding'->'github'->>'control_sha'
  OR request->>'workflow_id' IS DISTINCT FROM i->'binding'->'github'->>'certification_workflow_id'
  OR request->>'operation_policy_digest' IS DISTINCT FROM '1fed78c7afc00a220839dd198f2a362befe0fbe9655b2574d9d037d2864b2bda'
  OR NOT EXISTS(SELECT 1 FROM release_ops.external_operations x JOIN release_ops.provider_plans pp ON pp.id::text=x.intent->>'plan_id'
   WHERE x.id::text=request->>'publication_operation_id' AND x.release_id=q.release_id AND x.status='SUCCEEDED'
   AND x.kind='PUBLISH' AND pp.readiness_event::text=q.selected_receipts->>'READINESS'
   AND x.intent->'provider_request'->>'artifact_image_id'=request->>'artifact_image_id')
  THEN RAISE EXCEPTION 'RELEASE_EXACT_PUBLICATION_CERTIFICATE_REQUIRED'; END IF;
 ELSE
  RAISE EXCEPTION 'RELEASE_SOURCE_PHASE_UNSUPPORTED';
 END IF;
 SELECT * INTO p FROM release_ops.source_plans x WHERE x.release_id=q.release_id AND x.attempt_id=q.attempt_id AND x.phase=submit_source_plan.phase;
 IF FOUND THEN
  IF p.request<>request THEN RAISE EXCEPTION 'RELEASE_SOURCE_PLAN_IDEMPOTENCY_MISMATCH'; END IF;
  RETURN to_jsonb(p);
 END IF;
 event_id:=release_ops.event(release_id,'SOURCE_PLAN',actor,jsonb_build_object('phase',phase,'request',request));
 INSERT INTO release_ops.source_plans(release_id,attempt_id,phase,adapter,request,event_id)
 VALUES(release_id,q.attempt_id,phase,adapter,request,event_id) RETURNING * INTO p;
 RETURN to_jsonb(p);
END $$;
CREATE FUNCTION release_ops.begin_source_plan(owner uuid,epoch uuid,plan_id uuid,bundle_digest text,config_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE p release_ops.source_plans; q release_ops.queue; i jsonb; intent jsonb; e release_ops.external_operations; event_id uuid;
BEGIN
 i:=release_ops.provider_installation(owner,epoch,bundle_digest,config_digest);
 SELECT * INTO p FROM release_ops.source_plans WHERE id=plan_id;
 SELECT * INTO q FROM release_ops.queue WHERE release_id=p.release_id;
 IF p.id IS NULL OR NOT(i->'binding'->'adapters' ? p.adapter) OR p.attempt_id IS DISTINCT FROM q.attempt_id
 THEN RAISE EXCEPTION 'RELEASE_SOURCE_PLAN_STALE'; END IF;
 intent:=jsonb_build_object('target',p.request->>'target','manifest_digest',p.request->>'manifest_digest',
 'expected_current',jsonb_build_object('source_base',p.request->>'expected_base_sha'),'provider_request',p.request,
 'adapter',p.adapter,'plan_id',p.id,'installation_id',i->>'id');
 IF p.phase NOT IN ('VALIDATION','STAGE') THEN
  RETURN release_ops.begin_external(owner,epoch,p.release_id,'source:'||p.id,p.phase,intent,actor);
 END IF;
 -- Qualification is itself an external BUILD operation before MERGING. Keep
 -- the frozen bootstrap API unchanged; this narrower entry point owns it.
 SELECT * INTO e FROM release_ops.external_operations WHERE release_id=p.release_id AND operation_key='source:'||p.id;
 IF FOUND THEN RETURN to_jsonb(e)||jsonb_build_object('may_submit',false); END IF;
 IF q.state IS DISTINCT FROM (CASE p.phase WHEN 'VALIDATION' THEN 'VALIDATING' ELSE 'STAGED' END) OR q.attempt_deadline<=clock_timestamp()
 OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM p.release_id
 OR EXISTS(SELECT 1 FROM release_ops.external_operations WHERE status IN ('INTENT','UNKNOWN'))
 THEN RAISE EXCEPTION 'RELEASE_SOURCE_VALIDATION_PHASE_INVALID'; END IF;
 event_id:=release_ops.event(p.release_id,'EXTERNAL_INTENT',actor,intent);
 INSERT INTO release_ops.external_operations(release_id,operation_key,owner_id,epoch,kind,intent,intent_event,resume_state)
 VALUES(p.release_id,'source:'||p.id,owner,epoch,'BUILD',intent,event_id,q.state) RETURNING * INTO e;
 RETURN to_jsonb(e)||jsonb_build_object('may_submit',true);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA release_ops FROM PUBLIC;
REVOKE ALL ON FUNCTION release_ops.enqueue_delivery(uuid,text,text,jsonb,text),release_ops.source_snapshot(uuid,uuid),
 release_ops.submit_source_plan(uuid,uuid,uuid,text,jsonb,text,text,text),release_ops.begin_source_plan(uuid,uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_ops.enqueue_delivery(uuid,text,text,jsonb,text) TO release_journal_submitter;
GRANT EXECUTE ON FUNCTION release_ops.source_snapshot(uuid,uuid),release_ops.submit_source_plan(uuid,uuid,uuid,text,jsonb,text,text,text),
 release_ops.begin_source_plan(uuid,uuid,uuid,text,text,text) TO release_journal_controller;

GRANT EXECUTE ON FUNCTION release_ops.submit_provider_plan(uuid,text,text,jsonb,text) TO release_journal_controller;
GRANT EXECUTE ON FUNCTION release_ops.provider_schema_version() TO release_journal_submitter;
GRANT EXECUTE ON FUNCTION release_ops.retry(uuid,bigint,integer,text,text,text) TO release_journal_controller;
COMMIT;
