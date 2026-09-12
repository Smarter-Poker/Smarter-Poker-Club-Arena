-- Reserved by scripts/new-migration.mjs. Private subordinate qualification only.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE FUNCTION release_ops.aggregate_schema_version() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 1 $$;
ALTER TABLE release_ops.source_plans DROP CONSTRAINT source_plans_adapter_check;
ALTER TABLE release_ops.source_plans ADD CONSTRAINT source_plans_adapter_check CHECK(adapter IN
 ('github-merge','github-workflow','engine-stage','github-certification','github-static','component-aggregate','github-compatibility'));
CREATE TABLE release_ops.qualification_children (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent_id uuid NOT NULL REFERENCES release_ops.external_operations(id),
 target text NOT NULL CHECK(target IN ('club-arena-engine','club-arena-web')), adapter text NOT NULL,
 request jsonb NOT NULL, event_id uuid NOT NULL REFERENCES release_ops.events(id), UNIQUE(parent_id,target)
);
CREATE TABLE release_ops.qualification_submissions (
 child_id uuid PRIMARY KEY REFERENCES release_ops.qualification_children(id), owner_id uuid NOT NULL, epoch uuid NOT NULL,
 event_id uuid NOT NULL REFERENCES release_ops.events(id)
);
CREATE TABLE release_ops.qualification_results (
 child_id uuid PRIMARY KEY REFERENCES release_ops.qualification_children(id), outcome text NOT NULL
 CHECK(outcome IN ('SUCCEEDED','FAILED','CANCELLED','NOT_ACCEPTED')), result jsonb NOT NULL,
 event_id uuid NOT NULL REFERENCES release_ops.events(id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['qualification_children','qualification_submissions','qualification_results'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_qualification BEFORE UPDATE OR DELETE ON release_ops.%I FOR EACH ROW EXECUTE FUNCTION release_ops.immutable()',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION release_ops.register_provider_installation(bundle_digest text,binding jsonb,evidence jsonb,actor text) RETURNS jsonb
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
 OR jsonb_typeof(binding->'adapters') IS DISTINCT FROM 'array' OR jsonb_array_length(binding->'adapters') NOT BETWEEN 1 AND 10
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(binding->'adapters') a WHERE a NOT IN ('vercel-promote','hetzner-intake','github-merge','github-workflow','engine-stage','github-certification','github-static','github-frontend','component-aggregate','github-compatibility'))
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

CREATE FUNCTION release_ops.submit_aggregate_source_plan(owner uuid,epoch uuid,release_id uuid,request jsonb,
 bundle_digest text,config_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; a release_ops.admissions; i jsonb; p release_ops.source_plans;
 target text; c jsonb; r jsonb; eid uuid; integration jsonb; targets jsonb;
BEGIN
 i:=release_ops.provider_installation(owner,epoch,bundle_digest,config_digest);
 PERFORM release_ops.valid_actor(actor);
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=submit_aggregate_source_plan.release_id FOR UPDATE;
 SELECT * INTO a FROM release_ops.admissions WHERE id=release_id;
 SELECT jsonb_agg(part.value->>'target' ORDER BY part.value->>'target') INTO targets FROM jsonb_array_elements(q.resolution_manifest->'components') AS part(value);
 IF request->>'aggregate_version' IS DISTINCT FROM '1' OR request->>'phase' NOT IN ('VALIDATION','BUILD')
 OR request->>'phase' IS NULL OR q.state IS DISTINCT FROM (CASE request->>'phase' WHEN 'VALIDATION' THEN 'VALIDATING' ELSE 'BUILDING' END)
 OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id
 OR q.attempt_deadline<=clock_timestamp() OR NOT(i->'binding'->'adapters' ? 'component-aggregate')
 OR a.intent->>'repository' IS DISTINCT FROM 'Smarter-Poker/Smarter-Poker-Club-Arena'
 OR request->>'repository' IS DISTINCT FROM a.intent->>'repository' OR request->>'target' IS DISTINCT FROM a.intent->>'target'
 OR request->>'accepted_head_sha' IS DISTINCT FROM q.resolution_head_sha OR request->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR request->>'control_sha' IS DISTINCT FROM i->'binding'->'github'->>'control_sha'
 OR targets NOT IN ('["club-arena-web"]'::jsonb,'["club-arena-engine","club-arena-web"]'::jsonb)
 OR request->'components' IS DISTINCT FROM targets
 OR (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(request->'children') k) IS DISTINCT FROM targets
 OR jsonb_typeof(request->'children') IS DISTINCT FROM 'object' OR octet_length(request::text)>32768
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['source_sha','expected_base_sha','tested_tree_sha']) k WHERE COALESCE(request->>k,'') !~ '^[0-9a-f]{40}$')
 THEN RAISE EXCEPTION 'RELEASE_AGGREGATE_PLAN_REQUIRED'; END IF;
 IF request->>'phase'='BUILD' THEN
  SELECT data INTO integration FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'INTEGRATION';
  IF request->>'source_sha' IS DISTINCT FROM integration->>'merged_sha'
  OR request->>'expected_base_sha' IS DISTINCT FROM integration->>'expected_base_sha'
  OR request->>'tested_tree_sha' IS DISTINCT FROM integration->>'merged_tree_sha'
  THEN RAISE EXCEPTION 'RELEASE_AGGREGATE_SOURCE_UNQUALIFIED'; END IF;
 END IF;
 FOR target,c IN SELECT key,value FROM jsonb_each(request->'children') LOOP
  r:=c->'request';
  IF r->>'target' IS DISTINCT FROM target OR NOT(i->'binding'->'adapters' ? (c->>'adapter'))
  OR COALESCE(r->>'workflow_id','') !~ '^[1-9][0-9]*$'
  OR (c->>'adapter'<>'github-static' AND COALESCE(r->>'runtime_image','') !~ '^node:22[^@ ]*@sha256:[0-9a-f]{64}$')
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['phase','repository','source_sha','accepted_head_sha','expected_base_sha','tested_tree_sha','manifest_digest']) k
   WHERE r->>k IS DISTINCT FROM request->>k)
  OR (c->>'adapter'<>'github-static' AND r->>'control_sha' IS DISTINCT FROM request->>'control_sha')
  OR (target='club-arena-engine' AND (c->>'adapter' IS DISTINCT FROM 'github-workflow'
   OR r->>'workflow_id' IS DISTINCT FROM i->'binding'->'github'->>'workflow_id'
   OR r->>'runtime_image' IS DISTINCT FROM i->'binding'->'github'->>'runtime_image'
   OR r->'components' IS DISTINCT FROM '["club-arena-engine"]'::jsonb))
  OR (target='club-arena-web' AND request->>'phase'='VALIDATION' AND (c->>'adapter' IS DISTINCT FROM 'github-frontend'
   OR r->>'workflow_id' IS DISTINCT FROM i->'binding'->'github'->>'frontend_qualification_workflow_id'
   OR r->>'runtime_image' IS DISTINCT FROM i->'binding'->'github'->>'frontend_runtime_image'
   OR r->'components' IS DISTINCT FROM '["club-arena-web"]'::jsonb))
  OR (target='club-arena-web' AND request->>'phase'='BUILD' AND (c->>'adapter' IS DISTINCT FROM 'github-static'
   OR r->>'workflow_id' IS DISTINCT FROM i->'binding'->'github'->>'static_workflow_id'
   OR r->>'static_version' IS DISTINCT FROM '1' OR COALESCE(r->>'not_after_epoch','') !~ '^[1-9][0-9]{9}$'
   OR (r->>'not_after_epoch')::bigint>extract(epoch FROM q.attempt_deadline)::bigint
   OR NOT EXISTS(SELECT 1 FROM release_ops.certification_ingress_installations x
    WHERE x.id::text=r->'static_authority'->>'installation_receipt' AND x.binding->>'audience'='club-arena-static-publication'
    AND x.binding->>'url'=r->'static_authority'->>'url'
    AND release_ops.static_control_request_valid(i->'binding',x.binding,r)
    AND x.binding->>'repository_id'=r->>'repository_id' AND x.binding->>'workflow_id'=r->>'workflow_id')))
  THEN RAISE EXCEPTION 'RELEASE_AGGREGATE_CHILD_CONTRACT_REFUSED'; END IF;
 END LOOP;
 SELECT * INTO p FROM release_ops.source_plans WHERE source_plans.release_id=submit_aggregate_source_plan.release_id
 AND attempt_id=q.attempt_id AND phase=request->>'phase';
 IF FOUND THEN
  IF p.request IS DISTINCT FROM request OR p.adapter<>'component-aggregate' THEN RAISE EXCEPTION 'RELEASE_AGGREGATE_PLAN_MISMATCH'; END IF;
  RETURN to_jsonb(p);
 END IF;
 eid:=release_ops.event(release_id,'AGGREGATE_SOURCE_PLAN',actor,request);
 INSERT INTO release_ops.source_plans(release_id,attempt_id,phase,adapter,request,event_id)
 VALUES(release_id,q.attempt_id,request->>'phase','component-aggregate',request,eid) RETURNING * INTO p;
 RETURN to_jsonb(p);
END $$;

CREATE FUNCTION release_ops.prepare_qualification_children(owner uuid,epoch uuid,parent_id uuid,
 bundle_digest text,config_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations; c jsonb; target text; eid uuid; i jsonb;
BEGIN
 i:=release_ops.provider_installation(owner,epoch,bundle_digest,config_digest,false);
 SELECT * INTO e FROM release_ops.external_operations WHERE id=parent_id FOR UPDATE;
 IF e.kind IS DISTINCT FROM 'BUILD' OR e.status NOT IN ('INTENT','UNKNOWN')
 OR e.intent->>'adapter' IS DISTINCT FROM 'component-aggregate' OR e.intent->'provider_request'->>'aggregate_version' IS DISTINCT FROM '1'
 OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM e.release_id
 OR NOT EXISTS(SELECT 1 FROM release_ops.provider_submissions s WHERE s.operation_id=e.id)
 THEN RAISE EXCEPTION 'RELEASE_AGGREGATE_PARENT_REQUIRED'; END IF;
 FOR target,c IN SELECT key,value FROM jsonb_each(e.intent->'provider_request'->'children') ORDER BY key LOOP
  IF NOT EXISTS(SELECT 1 FROM release_ops.qualification_children ch WHERE ch.parent_id=e.id AND ch.target=target) THEN
   eid:=release_ops.event(e.release_id,'COMPONENT_QUALIFICATION_INTENT',actor,jsonb_build_object('parent_id',e.id,'target',target,'adapter',c->>'adapter','request',c->'request'));
   INSERT INTO release_ops.qualification_children(parent_id,target,adapter,request,event_id) VALUES(e.id,target,c->>'adapter',c->'request',eid);
  END IF;
 END LOOP;
 RETURN jsonb_build_object('parent_id',e.id,'prepared',true);
END $$;

CREATE FUNCTION release_ops.qualification_snapshot(owner uuid,epoch uuid,parent_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
BEGIN
 PERFORM release_ops.check_owner(owner,epoch,false);
 RETURN jsonb_build_object('parent',release_ops.provider_operation_context(owner,epoch,parent_id),
 'children',(SELECT COALESCE(jsonb_agg(to_jsonb(c)||jsonb_build_object('created_at',v.created_at,
 'submitted',s.child_id IS NOT NULL,'outcome',r.outcome,'result',r.result,'result_event',r.event_id) ORDER BY c.target),'[]'::jsonb)
 FROM release_ops.qualification_children c JOIN release_ops.events v ON v.id=c.event_id
 LEFT JOIN release_ops.qualification_submissions s ON s.child_id=c.id LEFT JOIN release_ops.qualification_results r ON r.child_id=c.id
 WHERE c.parent_id=qualification_snapshot.parent_id));
END $$;

CREATE FUNCTION release_ops.authorize_qualification_child(owner uuid,epoch uuid,child_id uuid,bundle_digest text,config_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations; c release_ops.qualification_children; i jsonb; eid uuid;
BEGIN
 i:=release_ops.provider_installation(owner,epoch,bundle_digest,config_digest);
 SELECT * INTO c FROM release_ops.qualification_children WHERE id=child_id;
 SELECT * INTO e FROM release_ops.external_operations WHERE id=c.parent_id FOR UPDATE;
 IF c.id IS NULL OR e.status NOT IN ('INTENT','UNKNOWN') OR e.intent->>'adapter' IS DISTINCT FROM 'component-aggregate'
 OR NOT(i->'binding'->'adapters' ? c.adapter) OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM e.release_id
 OR (SELECT attempt_deadline<=clock_timestamp() FROM release_ops.queue WHERE release_id=e.release_id)
 OR EXISTS(SELECT 1 FROM release_ops.qualification_results r JOIN release_ops.qualification_children x ON x.id=r.child_id WHERE x.parent_id=e.id AND r.outcome<>'SUCCEEDED')
 OR EXISTS(SELECT 1 FROM release_ops.qualification_children x WHERE x.parent_id=e.id AND x.target<c.target AND NOT EXISTS(
  SELECT 1 FROM release_ops.qualification_results r WHERE r.child_id=x.id AND r.outcome='SUCCEEDED'))
 THEN RAISE EXCEPTION 'RELEASE_AGGREGATE_CHILD_SUBMIT_REFUSED'; END IF;
 IF EXISTS(SELECT 1 FROM release_ops.qualification_submissions s WHERE s.child_id=c.id)
 THEN RETURN jsonb_build_object('may_submit',false,'child_id',c.id); END IF;
 eid:=release_ops.event(e.release_id,'COMPONENT_QUALIFICATION_SUBMIT_AUTHORIZED',actor,jsonb_build_object('parent_id',e.id,'child_id',c.id));
 INSERT INTO release_ops.qualification_submissions VALUES(c.id,owner,epoch,eid);
 RETURN jsonb_build_object('may_submit',true,'child_id',c.id,'event_id',eid);
END $$;

CREATE FUNCTION release_ops.record_qualification_result(owner uuid,epoch uuid,child_id uuid,result jsonb,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations; c release_ops.qualification_children; r release_ops.qualification_results; eid uuid;
BEGIN
 PERFORM release_ops.check_owner(owner,epoch,false);
 SELECT * INTO c FROM release_ops.qualification_children WHERE id=child_id;
 SELECT * INTO e FROM release_ops.external_operations WHERE id=c.parent_id FOR UPDATE;
 IF c.id IS NULL OR e.status NOT IN ('INTENT','UNKNOWN') OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM e.release_id
 OR result->>'terminal' IS DISTINCT FROM 'true' OR result->>'outcome' NOT IN ('SUCCEEDED','FAILED','CANCELLED','NOT_ACCEPTED')
 OR result->>'outcome' IS NULL OR result->>'operation_id' IS DISTINCT FROM c.id::text
 OR result->>'manifest_digest' IS DISTINCT FROM c.request->>'manifest_digest' OR octet_length(result::text)>65536
 OR (result->>'outcome'='NOT_ACCEPTED' AND (result->>'accepted' IS DISTINCT FROM 'false' OR EXISTS(SELECT 1 FROM release_ops.qualification_submissions s WHERE s.child_id=c.id)))
 OR (result->>'outcome'<>'NOT_ACCEPTED' AND NOT EXISTS(SELECT 1 FROM release_ops.qualification_submissions s WHERE s.child_id=c.id))
 OR (result->>'outcome'='SUCCEEDED' AND (result->'proof'->'request' IS DISTINCT FROM c.request
  OR result->'proof'->>'operation_id' IS DISTINCT FROM c.id::text OR result->'proof'->>'control_sha' IS DISTINCT FROM c.request->>'control_sha'
  OR result->'proof'->>'success' IS DISTINCT FROM 'true' OR result->'proof'->>'run_id' IS DISTINCT FROM result->>'provider_operation_id'
  OR COALESCE(result->>'provider_operation_id','') !~ '^[1-9][0-9]*$'))
 THEN RAISE EXCEPTION 'RELEASE_AGGREGATE_CHILD_RESULT_REFUSED'; END IF;
 SELECT * INTO r FROM release_ops.qualification_results WHERE qualification_results.child_id=c.id;
 IF FOUND THEN
  IF r.result IS DISTINCT FROM result THEN RAISE EXCEPTION 'RELEASE_AGGREGATE_CHILD_RESULT_MISMATCH'; END IF;
  RETURN to_jsonb(r);
 END IF;
 eid:=release_ops.event(e.release_id,'COMPONENT_QUALIFICATION_TERMINAL',actor,result);
 INSERT INTO release_ops.qualification_results VALUES(c.id,result->>'outcome',result,eid) RETURNING * INTO r;
 RETURN to_jsonb(r);
END $$;

CREATE FUNCTION release_ops.qualification_terminal_proof(parent_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations; child record; c jsonb; artifacts jsonb:='{}'; refs jsonb:='[]'; doors jsonb;
 failed boolean:=false; proof jsonb;
BEGIN
 SELECT * INTO e FROM release_ops.external_operations WHERE id=parent_id;
 IF e.intent->>'adapter' IS DISTINCT FROM 'component-aggregate' THEN RAISE EXCEPTION 'RELEASE_AGGREGATE_PARENT_REQUIRED'; END IF;
 IF (SELECT count(*) FROM release_ops.qualification_children WHERE qualification_children.parent_id=e.id)
 IS DISTINCT FROM jsonb_array_length(e.intent->'provider_request'->'components') THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM release_ops.qualification_children c JOIN release_ops.qualification_submissions sub ON sub.child_id=c.id
 WHERE c.parent_id=e.id AND NOT EXISTS(SELECT 1 FROM release_ops.qualification_results r WHERE r.child_id=c.id)) THEN RETURN NULL; END IF;
 SELECT EXISTS(SELECT 1 FROM release_ops.qualification_children c JOIN release_ops.qualification_results r ON r.child_id=c.id
 WHERE c.parent_id=e.id AND r.outcome<>'SUCCEEDED') INTO failed;
 IF NOT failed AND EXISTS(SELECT 1 FROM release_ops.qualification_children c WHERE c.parent_id=e.id
 AND NOT EXISTS(SELECT 1 FROM release_ops.qualification_results r WHERE r.child_id=c.id AND r.outcome='SUCCEEDED')) THEN RETURN NULL; END IF;
 FOR child IN SELECT ch.*,r.result,r.event_id AS result_event,r.outcome FROM release_ops.qualification_children ch
 LEFT JOIN release_ops.qualification_results r ON r.child_id=ch.id WHERE ch.parent_id=e.id ORDER BY ch.target LOOP
  refs:=refs||jsonb_build_array(jsonb_build_object('target',child.target,'operation_id',child.id,
   'provider_operation_id',child.result->>'provider_operation_id','result_event',child.result_event,'outcome',COALESCE(child.outcome,'NOT_SUBMITTED')));
  IF NOT failed AND e.intent->'provider_request'->>'phase'='BUILD' THEN
   c:=child.result->'proof'->'artifact'->'components'->child.target;
   IF COALESCE(c->>'identity','') !~ '^sha256:[0-9a-f]{64}$' OR c IS NULL
   OR c->>'build_operation_id' IS DISTINCT FROM child.id::text
   OR COALESCE(c->>'github_artifact_id','') !~ '^[1-9][0-9]*$'
   OR COALESCE(c->>'github_archive_digest','') !~ '^sha256:[0-9a-f]{64}$'
   THEN RAISE EXCEPTION 'RELEASE_AGGREGATE_COMPONENT_ARTIFACT_REQUIRED'; END IF;
   IF child.target='club-arena-web' AND (c->>'source_sha' IS DISTINCT FROM child.request->>'source_sha'
   OR c->>'identity' IS DISTINCT FROM 'sha256:'||(c->>'manifest_digest')
   OR c->>'build_run_id' IS DISTINCT FROM child.result->>'provider_operation_id')
   THEN RAISE EXCEPTION 'RELEASE_AGGREGATE_COMPONENT_ARTIFACT_REQUIRED'; END IF;
   c:=c||jsonb_build_object('source_sha',child.request->>'source_sha','build_run_id',child.result->>'provider_operation_id',
    'qualification_result_event',child.result_event,'aggregate_operation_id',e.id);
   IF child.target='club-arena-web' THEN c:=c||jsonb_build_object('control_sha',child.request->>'control_sha');
    IF child.request ? 'control_closure' THEN c:=c||jsonb_build_object('control_closure',child.request->'control_closure'); END IF;
   END IF;
   artifacts:=artifacts||jsonb_build_object(child.target,c);
   IF child.target='club-arena-engine' THEN doors:=child.result->'proof'->'database_doors'; END IF;
  END IF;
 END LOOP;
 proof:=jsonb_build_object('operation_id',e.id,'request',e.intent->'provider_request','control_sha',e.intent->'provider_request'->>'control_sha',
  'success',NOT failed,'aggregate_operation_id',e.id,'component_qualifications',refs);
 IF NOT failed AND e.intent->'provider_request'->>'phase'='BUILD' THEN
  proof:=proof||jsonb_build_object('artifact',jsonb_build_object('components',artifacts),'database_doors',doors);
 END IF;
 RETURN jsonb_build_object('terminal',true,'outcome',CASE WHEN failed THEN 'FAILED' ELSE 'SUCCEEDED' END,
  'provider_operation_id','aggregate:'||e.id,'proof',proof);
END $$;

CREATE FUNCTION release_ops.qualification_terminal(owner uuid,epoch uuid,parent_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM release_ops.check_owner(owner,epoch,false);
 RETURN release_ops.qualification_terminal_proof(parent_id);
END $$;

CREATE FUNCTION release_ops.guard_aggregate_terminal() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE expected jsonb;
BEGIN
 IF OLD.intent->>'adapter' IS DISTINCT FROM 'component-aggregate' OR NEW.status IN ('INTENT','UNKNOWN') THEN RETURN NEW; END IF;
 IF NEW.status='NOT_ACCEPTED' AND NOT EXISTS(SELECT 1 FROM release_ops.provider_submissions WHERE operation_id=OLD.id) THEN RETURN NEW; END IF;
 expected:=release_ops.qualification_terminal_proof(OLD.id);
 IF expected IS NULL OR expected->>'outcome' IS DISTINCT FROM NEW.status
 OR expected->'proof' IS DISTINCT FROM NEW.result->'proof'
 OR expected->>'provider_operation_id' IS DISTINCT FROM NEW.result->>'provider_operation_id'
 THEN RAISE EXCEPTION 'RELEASE_COMPLETE_AGGREGATE_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_aggregate_terminal BEFORE UPDATE ON release_ops.external_operations FOR EACH ROW EXECUTE FUNCTION release_ops.guard_aggregate_terminal();

REVOKE ALL ON FUNCTION release_ops.qualification_terminal_proof(uuid),release_ops.qualification_terminal(uuid,uuid,uuid),release_ops.guard_aggregate_terminal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_ops.qualification_terminal(uuid,uuid,uuid) TO release_journal_controller;

REVOKE ALL ON ALL TABLES IN SCHEMA release_ops FROM PUBLIC,release_certification_callback;
REVOKE ALL ON FUNCTION release_ops.aggregate_schema_version(),
 release_ops.submit_aggregate_source_plan(uuid,uuid,uuid,jsonb,text,text,text),
 release_ops.prepare_qualification_children(uuid,uuid,uuid,text,text,text),release_ops.qualification_snapshot(uuid,uuid,uuid),
 release_ops.authorize_qualification_child(uuid,uuid,uuid,text,text,text),release_ops.record_qualification_result(uuid,uuid,uuid,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_ops.aggregate_schema_version(),
 release_ops.submit_aggregate_source_plan(uuid,uuid,uuid,jsonb,text,text,text),
 release_ops.prepare_qualification_children(uuid,uuid,uuid,text,text,text),release_ops.qualification_snapshot(uuid,uuid,uuid),
 release_ops.authorize_qualification_child(uuid,uuid,uuid,text,text,text),release_ops.record_qualification_result(uuid,uuid,uuid,jsonb,text) TO release_journal_controller;

-- The installed closure receipt is an owner-reviewed native bundle input. A
-- newer default SHA is allowed only after the private controller proves every
-- fixed privileged blob unchanged. Callback callers cannot supply this proof.
CREATE FUNCTION release_ops.static_control_request_valid(binding jsonb,ingress jsonb,request jsonb) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT COALESCE(ingress->>'control_sha'=binding->'github'->>'control_sha' AND
 request->>'workflow_id'=binding->'github'->>'static_workflow_id' AND
 (request->>'control_sha'=binding->'github'->>'control_sha' OR
 (request->>'control_sha'=request->>'source_sha' AND request->>'control_sha' ~ '^[0-9a-f]{40}$'
 AND binding->'github'->'static_control_closure'->>'digest' ~ '^[0-9a-f]{64}$'
 AND request->'control_closure'=jsonb_build_object('version',1,'installed_control_sha',binding->'github'->>'control_sha',
 'control_sha',request->>'control_sha','repository_id',ingress->>'repository_id',
 'workflow_id',(ingress->>'workflow_id')::bigint,'closure_digest',binding->'github'->'static_control_closure'->>'digest','file_count',16))),false)
$$;

-- Returns only an exact persisted BUILD or its exact persisted subordinate.
-- No caller-supplied evidence or child outcome can replace the parent result.
CREATE FUNCTION release_ops.static_build_evidence(build_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations; c release_ops.qualification_children; v release_ops.events;
 r release_ops.qualification_results; req jsonb; res jsonb; submitted boolean; observed_at timestamptz;
BEGIN
 SELECT * INTO e FROM release_ops.external_operations WHERE id=build_id;
 IF FOUND THEN
  IF e.kind<>'BUILD' OR e.intent->>'adapter'<>'github-static' THEN RAISE EXCEPTION 'RELEASE_STATIC_BUILD_ID_REQUIRED'; END IF;
  req:=e.intent->'provider_request'; res:=e.result;
  SELECT * INTO v FROM release_ops.events WHERE id=e.intent_event;
  IF v.kind<>'EXTERNAL_INTENT' OR v.release_id IS DISTINCT FROM e.release_id
  OR (v.data IS DISTINCT FROM e.intent AND v.data->'intent' IS DISTINCT FROM e.intent)
  THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_INTENT_EVENT_REQUIRED'; END IF;
  submitted:=EXISTS(SELECT 1 FROM release_ops.provider_submissions WHERE operation_id=e.id);
 ELSE
  SELECT * INTO c FROM release_ops.qualification_children WHERE id=build_id;
  SELECT * INTO e FROM release_ops.external_operations WHERE id=c.parent_id;
  SELECT * INTO v FROM release_ops.events WHERE id=c.event_id;
  SELECT * INTO r FROM release_ops.qualification_results WHERE child_id=c.id;
  IF c.id IS NULL OR c.target<>'club-arena-web' OR c.adapter<>'github-static'
  OR e.kind<>'BUILD' OR e.intent->>'adapter'<>'component-aggregate'
  OR e.intent->'provider_request'->>'phase'<>'BUILD'
  OR c.request IS DISTINCT FROM e.intent->'provider_request'->'children'->'club-arena-web'->'request'
  OR v.kind<>'COMPONENT_QUALIFICATION_INTENT' OR v.release_id IS DISTINCT FROM e.release_id
  OR v.data IS DISTINCT FROM jsonb_build_object('parent_id',e.id,'target',c.target,'adapter',c.adapter,'request',c.request)
  THEN RAISE EXCEPTION 'RELEASE_STATIC_BUILD_ID_REQUIRED'; END IF;
  req:=c.request; res:=r.result;
  submitted:=EXISTS(SELECT 1 FROM release_ops.qualification_submissions WHERE child_id=c.id);
 END IF;
 RETURN jsonb_build_object('id',build_id,'parent_id',e.id,'child_id',c.id,'release_id',e.release_id,
 'status',e.status,'request',req,'result',res,'submitted',submitted,'created_at',v.created_at);
END $$;
ALTER TABLE release_ops.static_publication_claims ADD COLUMN qualification_child_id uuid UNIQUE REFERENCES release_ops.qualification_children(id);

CREATE OR REPLACE FUNCTION release_ops.static_publication_context(build_operation_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b jsonb; i release_ops.certification_ingress_installations; installed release_ops.provider_installations;
BEGIN
 b:=release_ops.static_build_evidence(build_operation_id);
 SELECT * INTO i FROM release_ops.certification_ingress_installations WHERE id::text=b->'request'->'static_authority'->>'installation_receipt';
 SELECT p.* INTO installed FROM release_ops.provider_installations p JOIN release_ops.controller c ON c.installed_adapter_receipt=p.id::text WHERE c.singleton;
 IF b->'request'->>'static_version' IS DISTINCT FROM '1' OR b->>'status' NOT IN ('INTENT','UNKNOWN','SUCCEEDED')
 OR b->>'submitted' IS DISTINCT FROM 'true' OR i.binding->>'principal' IS DISTINCT FROM session_user
 OR i.binding->>'audience' IS DISTINCT FROM 'club-arena-static-publication'
 OR (SELECT active_release::text FROM release_ops.controller WHERE singleton) IS DISTINCT FROM b->>'release_id'
 OR NOT release_ops.static_control_request_valid(installed.binding,i.binding,b->'request')
 THEN RAISE EXCEPTION 'RELEASE_STATIC_CALLBACK_SCOPE_REFUSED'; END IF;
 RETURN jsonb_build_object('request',b->'request','binding',i.binding,'build_operation_id',build_operation_id,'created_at',b->'created_at');
END $$;

CREATE OR REPLACE FUNCTION release_ops.claim_static_publication(build_operation_id uuid,identity jsonb,claim_key uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE context jsonb; build jsonb; publication release_ops.external_operations; q release_ops.queue;
 prior release_ops.static_publication_claims; eid uuid;
BEGIN
 context:=release_ops.static_publication_context(build_operation_id);
 build:=release_ops.static_build_evidence(build_operation_id);
 SELECT * INTO q FROM release_ops.queue WHERE release_id::text=build->>'release_id' FOR UPDATE;
 IF identity->>'repository_id' IS DISTINCT FROM context->'binding'->>'repository_id'
 OR identity->>'workflow_id' IS DISTINCT FROM context->'binding'->>'workflow_id'
 OR identity->>'control_sha' IS DISTINCT FROM context->'request'->>'control_sha'
 OR identity->>'run_attempt' IS DISTINCT FROM '1' OR COALESCE(identity->>'run_id','') !~ '^[1-9][0-9]*$'
 OR claim_key IS NULL OR q.attempt_deadline<=clock_timestamp()
 THEN RAISE EXCEPTION 'RELEASE_STATIC_CALLBACK_IDENTITY_REFUSED'; END IF;
 IF build->>'status'<>'SUCCEEDED' THEN RETURN jsonb_build_object('ready',false); END IF;
 IF identity->>'run_id' IS DISTINCT FROM build->'result'->>'provider_operation_id' THEN RAISE EXCEPTION 'RELEASE_STATIC_CALLBACK_RUN_MISMATCH'; END IF;
 SELECT * INTO publication FROM release_ops.external_operations e WHERE e.release_id=q.release_id AND e.kind='PUBLISH'
 AND e.status IN ('INTENT','UNKNOWN') AND e.intent->>'adapter'='github-static'
 AND e.intent->'provider_request'->>'build_operation_id'=build_operation_id::text;
 IF publication.id IS NULL OR NOT EXISTS(SELECT 1 FROM release_ops.provider_submissions WHERE operation_id=publication.id)
 THEN RETURN jsonb_build_object('ready',false); END IF;
 IF q.state NOT IN ('APPLYING','UNKNOWN_EXTERNAL_OUTCOME') OR publication.intent->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR NOT EXISTS(SELECT 1 FROM release_ops.provider_plans p WHERE p.id::text=publication.intent->>'plan_id'
   AND p.readiness_event::text=q.selected_receipts->>'READINESS' AND p.recovery_id IS NOT DISTINCT FROM q.recovery_id)
 THEN RAISE EXCEPTION 'RELEASE_STATIC_PUBLICATION_OWNERSHIP_CHANGED'; END IF;
 SELECT * INTO prior FROM release_ops.static_publication_claims WHERE operation_id=publication.id;
 IF FOUND THEN
  IF prior.identity IS DISTINCT FROM identity OR prior.claim_key IS DISTINCT FROM claim_key THEN RAISE EXCEPTION 'RELEASE_STATIC_PUBLICATION_ALREADY_CLAIMED'; END IF;
  RETURN jsonb_build_object('ready',true,'may_publish',false,'operation_id',publication.id,'request',publication.intent->'provider_request','claim_receipt',prior.event_id);
 END IF;
 eid:=release_ops.event(q.release_id,'STATIC_PUBLICATION_CLAIM','static-publication-callback',jsonb_build_object('build_operation_id',build_operation_id,'build_parent_id',build->>'parent_id','operation_id',publication.id,'identity',identity));
 INSERT INTO release_ops.static_publication_claims(operation_id,build_operation_id,run_id,identity,claim_key,event_id,qualification_child_id)
 VALUES(publication.id,(build->>'parent_id')::uuid,identity->>'run_id',identity,claim_key,eid,(build->>'child_id')::uuid);
 RETURN jsonb_build_object('ready',true,'may_publish',true,'operation_id',publication.id,'request',publication.intent->'provider_request','claim_receipt',eid);
END $$;
REVOKE ALL ON FUNCTION release_ops.static_control_request_valid(jsonb,jsonb,jsonb),release_ops.static_build_evidence(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_ops.submit_static_publication_plan(owner uuid,epoch uuid,release_id uuid,operation_key text,
 request jsonb,bundle_digest text,config_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; p release_ops.provider_plans; i jsonb; b release_ops.receipts; r release_ops.receipts;
 build jsonb; eid uuid; qualified jsonb;
BEGIN
 i:=release_ops.provider_installation(owner,epoch,bundle_digest,config_digest);
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=submit_static_publication_plan.release_id FOR UPDATE;
 SELECT * INTO b FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'BUILD';
 SELECT * INTO r FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'READINESS';
 build:=release_ops.static_build_evidence((request->>'build_operation_id')::uuid);
 qualified:=build->'result'->'proof'->'artifact'->'components'->'club-arena-web';
 IF build->>'child_id' IS NOT NULL THEN
  qualified:=qualified||jsonb_build_object('qualification_result_event',(SELECT event_id FROM release_ops.qualification_results WHERE child_id=(build->>'child_id')::uuid),'aggregate_operation_id',build->>'parent_id','control_sha',build->'request'->>'control_sha');
  IF build->'request' ? 'control_closure' THEN qualified:=qualified||jsonb_build_object('control_closure',build->'request'->'control_closure'); END IF;
 END IF;
 IF q.state IS DISTINCT FROM 'APPLYING' OR q.attempt_deadline<=clock_timestamp()
 OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id
 OR NOT(i->'binding'->'adapters' ? 'github-static') OR request->>'phase' IS DISTINCT FROM 'PUBLISH'
 OR request->>'static_version' IS DISTINCT FROM '1' OR request->>'target' IS DISTINCT FROM 'club-arena-web'
 OR request->>'repository' IS DISTINCT FROM 'Smarter-Poker/Smarter-Poker-Club-Arena'
 OR request->>'control_sha' IS DISTINCT FROM build->'request'->>'control_sha'
 OR request->'control_closure' IS DISTINCT FROM build->'request'->'control_closure'
 OR request->>'workflow_id' IS DISTINCT FROM i->'binding'->'github'->>'static_workflow_id'
 OR request->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR request->'artifact' IS DISTINCT FROM b.data->'artifact'->'components'->'club-arena-web'
 OR request->>'source_sha' IS DISTINCT FROM request->'artifact'->>'source_sha'
 OR request->>'build_run_id' IS DISTINCT FROM build->'result'->>'provider_operation_id'
 OR build->>'status' IS DISTINCT FROM 'SUCCEEDED' OR build->>'release_id' IS DISTINCT FROM release_id::text
 OR build->'request'->>'static_version' IS DISTINCT FROM '1'
 OR request->'artifact' IS DISTINCT FROM qualified
 OR request->'expected_current' IS DISTINCT FROM r.data->'static_expected_current'
 OR request IS DISTINCT FROM r.data->'provider_requests'->'github-static'
 OR b.recovery_id IS DISTINCT FROM q.recovery_id OR r.recovery_id IS DISTINCT FROM q.recovery_id
 OR COALESCE(request->>'not_after_epoch','') !~ '^[1-9][0-9]{9}$'
 OR (request->>'not_after_epoch')::bigint>extract(epoch FROM q.attempt_deadline)::bigint
 OR octet_length(request::text)>32768 THEN RAISE EXCEPTION 'RELEASE_STATIC_QUALIFIED_PUBLICATION_REQUIRED'; END IF;
 SELECT * INTO p FROM release_ops.provider_plans WHERE provider_plans.release_id=submit_static_publication_plan.release_id AND provider_plans.operation_key=submit_static_publication_plan.operation_key;
 IF FOUND THEN
  IF p.request IS DISTINCT FROM request OR p.adapter<>'github-static' THEN RAISE EXCEPTION 'RELEASE_STATIC_PUBLICATION_PLAN_MISMATCH'; END IF;
  RETURN to_jsonb(p);
 END IF;
 eid:=release_ops.event(release_id,'STATIC_PUBLICATION_PLAN',actor,request);
 INSERT INTO release_ops.provider_plans(release_id,operation_key,adapter,request,readiness_event,recovery_id,event_id,event_no)
 VALUES(release_id,operation_key,'github-static',request,r.event_id,q.recovery_id,eid,(SELECT last_event FROM release_ops.controller WHERE singleton)) RETURNING * INTO p;
 RETURN to_jsonb(p);
END $$;

CREATE OR REPLACE FUNCTION release_ops.guard_static_publication_resolution() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE claim release_ops.static_publication_claims; proof jsonb;
BEGIN
 IF OLD.intent->>'adapter' IS DISTINCT FROM 'github-static' OR NEW.status<>'SUCCEEDED' THEN RETURN NEW; END IF;
 proof:=NEW.result->'proof';
 IF proof->>'operation_id' IS DISTINCT FROM OLD.id::text OR proof->'request' IS DISTINCT FROM OLD.intent->'provider_request'
 OR proof->>'control_sha' IS DISTINCT FROM OLD.intent->'provider_request'->>'control_sha'
 OR proof->>'run_id' IS DISTINCT FROM NEW.result->>'provider_operation_id'
 OR proof->>'run_attempt' IS DISTINCT FROM '1' OR proof->>'success' IS DISTINCT FROM 'true'
 OR COALESCE(proof->>'job_id','') !~ '^[1-9][0-9]*$'
 THEN RAISE EXCEPTION 'RELEASE_STATIC_TERMINAL_PROOF_REQUIRED'; END IF;
 IF OLD.kind='PUBLISH' THEN
  SELECT * INTO claim FROM release_ops.static_publication_claims WHERE operation_id=OLD.id;
  IF claim.operation_id IS NULL OR proof->>'publication_claim' IS DISTINCT FROM claim.event_id::text
  OR claim.run_id IS DISTINCT FROM proof->>'run_id'
  OR COALESCE(claim.qualification_child_id,claim.build_operation_id)::text IS DISTINCT FROM OLD.intent->'provider_request'->>'build_operation_id'
  OR proof->'component' IS DISTINCT FROM OLD.intent->'provider_request'->'artifact'
  OR proof->'native'->>'source_sha' IS DISTINCT FROM proof->'component'->>'source_sha'
  OR proof->'native'->>'manifest_sha256' IS DISTINCT FROM proof->'component'->>'manifest_digest'
  OR proof->'native'->'build_info'->>'run_id' IS DISTINCT FROM claim.run_id
  THEN RAISE EXCEPTION 'RELEASE_STATIC_ONE_USE_PUBLICATION_PROOF_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION release_ops.guard_aggregate_receipt() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q release_ops.queue; p release_ops.source_plans; e release_ops.external_operations;
BEGIN
 IF NEW.kind NOT IN ('VALIDATION','BUILD') THEN RETURN NEW; END IF;
 SELECT * INTO q FROM release_ops.queue WHERE release_id=NEW.release_id;
 SELECT * INTO p FROM release_ops.source_plans WHERE release_id=q.release_id AND attempt_id=q.attempt_id AND phase=NEW.kind;
 IF p.adapter IS DISTINCT FROM 'component-aggregate' THEN RETURN NEW; END IF;
 SELECT * INTO e FROM release_ops.external_operations WHERE release_id=q.release_id AND intent->>'plan_id'=p.id::text;
 IF e.id IS NULL OR e.status<>'SUCCEEDED' OR e.intent->>'adapter'<>'component-aggregate'
 OR NEW.receipt_key IS DISTINCT FROM e.id::text OR NEW.data->>'aggregate_operation_id' IS DISTINCT FROM e.id::text
 OR NEW.data->'component_qualifications' IS DISTINCT FROM e.result->'proof'->'component_qualifications'
 OR (NEW.kind='BUILD' AND (NEW.data->'artifact' IS DISTINCT FROM e.result->'proof'->'artifact'
  OR NEW.data->'database_doors' IS DISTINCT FROM e.result->'proof'->'database_doors'
  OR NEW.data->>'source_sha' IS DISTINCT FROM p.request->>'source_sha'
  OR NEW.data->>'build_run_id' IS DISTINCT FROM e.result->>'provider_operation_id'))
 OR (NEW.kind='VALIDATION' AND (NEW.data->>'accepted_head_sha' IS DISTINCT FROM p.request->>'accepted_head_sha'
  OR NEW.data->>'expected_base_sha' IS DISTINCT FROM p.request->>'expected_base_sha'
  OR NEW.data->>'tested_tree_sha' IS DISTINCT FROM p.request->>'tested_tree_sha'
  OR NEW.data->>'qualification_run_id' IS DISTINCT FROM e.result->>'provider_operation_id'))
 THEN RAISE EXCEPTION 'RELEASE_AGGREGATE_RECEIPT_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_aggregate_receipt BEFORE INSERT ON release_ops.receipts FOR EACH ROW EXECUTE FUNCTION release_ops.guard_aggregate_receipt();
REVOKE ALL ON FUNCTION release_ops.guard_aggregate_receipt() FROM PUBLIC;


-- These functions expose bounded persisted readback inputs, never a mutation
-- capability or caller-created provider request. Public application roles have
-- no access. Callback responses never return the internal native envelope.
CREATE FUNCTION release_ops.component_read_scope(release_id uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
BEGIN
 IF (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id
 OR NOT ((pg_has_role(session_user,'release_journal_controller','MEMBER') AND release_ops.has_session_lock())
 OR (pg_has_role(session_user,'release_certification_callback','MEMBER') AND EXISTS(
 SELECT 1 FROM release_ops.certification_ingress_installations i JOIN release_ops.provider_installations p
 ON i.binding->>'control_sha'=p.binding->'github'->>'control_sha' JOIN release_ops.controller c ON c.installed_adapter_receipt=p.id::text
 WHERE c.singleton AND i.binding->>'principal'=session_user AND i.binding->>'audience'='club-arena-release-certification')))
 THEN RAISE EXCEPTION 'RELEASE_COMPONENT_READER_SCOPE_REQUIRED'; END IF;
END $$;
CREATE FUNCTION release_ops.component_retained_evidence(release_id uuid,target text,source_sha text,identity text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE r release_ops.receipts;
BEGIN
 PERFORM release_ops.component_read_scope(release_id);
 IF target NOT IN ('club-arena-engine','club-arena-web') OR target IS NULL
 OR COALESCE(source_sha,'') !~ '^[0-9a-f]{40}$' OR COALESCE(identity,'') !~ '^sha256:[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'RELEASE_COMPONENT_IDENTITY_REQUIRED'; END IF;
 SELECT receipts.* INTO r FROM release_ops.receipts JOIN release_ops.queue q USING(release_id)
 JOIN release_ops.events v ON v.id=receipts.event_id WHERE q.release_id<>component_retained_evidence.release_id
 AND q.state IN ('VERIFIED','RECOVERED') AND q.selected_receipts->>'CERTIFICATION'=receipts.event_id::text
 AND receipts.kind='CERTIFICATION' AND receipts.data->>'success'='true'
 AND receipts.data->'served_components'->target->>'source_sha'=source_sha
 AND receipts.data->'served_components'->target->>'identity'=identity ORDER BY v.event_no DESC LIMIT 1;
 IF r.event_id IS NULL THEN RAISE EXCEPTION 'RELEASE_VERIFIED_COMPONENT_PREHISTORY_REQUIRED'; END IF;
 RETURN jsonb_build_object('mode','retained','source_sha',source_sha,'identity',identity,'verified_receipt_id',r.event_id)
 ||CASE WHEN target='club-arena-web' THEN jsonb_build_object('manifest_digest',r.data->'served_components'->target->>'manifest_digest') ELSE '{}'::jsonb END;
END $$;
CREATE FUNCTION release_ops.component_engine_publication(release_id uuid,component jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE part jsonb:=component; prior release_ops.receipts; e release_ops.external_operations; visited uuid[]:='{}'; old boolean:=false;
BEGIN
 PERFORM release_ops.component_read_scope(release_id);
 FOR depth IN 1..64 LOOP
  IF part->>'mode'='changed' THEN EXIT; END IF;
  IF part->>'mode' IS DISTINCT FROM 'retained' OR COALESCE(part->>'verified_receipt_id','') !~ '^[0-9a-f-]{36}$'
  OR (part->>'verified_receipt_id')::uuid=ANY(visited) THEN RAISE EXCEPTION 'RELEASE_COMPONENT_HISTORY_UNPROVEN'; END IF;
  visited:=array_append(visited,(part->>'verified_receipt_id')::uuid);
  SELECT r.* INTO prior FROM release_ops.receipts r JOIN release_ops.queue q USING(release_id)
  WHERE r.event_id::text=part->>'verified_receipt_id' AND r.kind='CERTIFICATION' AND r.data->>'success'='true'
  AND q.state IN ('VERIFIED','RECOVERED') AND q.selected_receipts->>'CERTIFICATION'=r.event_id::text;
  part:=prior.data->'served_components'->'club-arena-engine'; old:=true;
  IF part->>'source_sha' IS DISTINCT FROM component->>'source_sha' OR part->>'identity' IS DISTINCT FROM component->>'identity'
  THEN RAISE EXCEPTION 'RELEASE_COMPONENT_HISTORY_UNPROVEN'; END IF;
 END LOOP;
 IF part->>'mode' IS DISTINCT FROM 'changed' THEN RAISE EXCEPTION 'RELEASE_COMPONENT_HISTORY_UNPROVEN'; END IF;
 SELECT * INTO e FROM release_ops.external_operations WHERE id::text=part->>'publication_operation_id';
 IF e.kind IS DISTINCT FROM 'PUBLISH' OR e.status IS DISTINCT FROM 'SUCCEEDED' OR e.intent->>'adapter' IS DISTINCT FROM 'hetzner-intake'
 OR (NOT old AND e.release_id IS DISTINCT FROM release_id)
 OR e.intent->'provider_request'->>'source_sha' IS DISTINCT FROM component->>'source_sha'
 OR e.intent->'provider_request'->>'artifact_image_id' IS DISTINCT FROM component->>'identity'
 OR e.result->>'source_sha' IS DISTINCT FROM component->>'source_sha' OR e.result->>'image_id' IS DISTINCT FROM component->>'identity'
 THEN RAISE EXCEPTION 'RELEASE_EXACT_NATIVE_PUBLICATION_REQUIRED'; END IF;
 RETURN jsonb_build_object('id',e.id,'epoch',e.epoch,'status',e.status,'request',e.intent->'provider_request','result',e.result);
END $$;
REVOKE ALL ON FUNCTION release_ops.component_read_scope(uuid),release_ops.component_retained_evidence(uuid,text,text,text),
 release_ops.component_engine_publication(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_ops.component_retained_evidence(uuid,text,text,text),
 release_ops.component_engine_publication(uuid,jsonb) TO release_journal_controller,release_certification_callback;

-- Mixed releases retain the engine child run and artifact identity at STAGE.
-- The aggregate owner is not a GitHub run and cannot replace that child receipt.
CREATE OR REPLACE FUNCTION release_ops.submit_source_plan(owner uuid,epoch uuid,release_id uuid,phase text,request jsonb,bundle_digest text,config_digest text,actor text) RETURNS jsonb
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
  OR request->>'build_run_id' IS DISTINCT FROM (CASE WHEN v ? 'aggregate_operation_id'
   THEN v->'artifact'->'components'->'club-arena-engine'->>'build_run_id' ELSE v->>'build_run_id' END)
  OR (v ? 'aggregate_operation_id' AND NOT EXISTS(
   SELECT 1 FROM release_ops.qualification_children child
   JOIN release_ops.qualification_results result ON result.child_id=child.id
   JOIN release_ops.external_operations parent ON parent.id=child.parent_id
   WHERE child.id::text=request->>'build_operation_id' AND child.parent_id::text=v->>'aggregate_operation_id'
   AND child.target='club-arena-engine' AND child.adapter='github-workflow'
   AND child.request->>'phase'='BUILD' AND child.request->>'source_sha'=request->>'source_sha'
   AND result.outcome='SUCCEEDED' AND result.result->>'provider_operation_id'=request->>'build_run_id'
   AND result.event_id::text=v->'artifact'->'components'->'club-arena-engine'->>'qualification_result_event'
   AND parent.release_id=release_id AND parent.status='SUCCEEDED' AND parent.kind='BUILD'
   AND parent.intent->>'adapter'='component-aggregate'
   AND parent.result->'proof'->'artifact'=v->'artifact'))
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

ALTER TABLE release_ops.source_plans DROP CONSTRAINT source_plans_phase_check;
ALTER TABLE release_ops.source_plans ADD CONSTRAINT source_plans_phase_check CHECK(phase IN ('VALIDATION','MERGE','BUILD','STAGE','CERTIFY','COMPATIBILITY'));

CREATE OR REPLACE FUNCTION release_ops.source_snapshot(owner uuid,epoch uuid) RETURNS jsonb
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
 'stage_plan',(SELECT to_jsonb(sp) FROM release_ops.source_plans sp WHERE sp.release_id=q.release_id
 AND sp.attempt_id=q.attempt_id AND sp.phase='STAGE'),
 'stage_operation',(SELECT to_jsonb(sx) FROM release_ops.external_operations sx JOIN release_ops.source_plans sp
 ON sx.intent->>'plan_id'=sp.id::text WHERE sp.release_id=q.release_id AND sp.attempt_id=q.attempt_id AND sp.phase='STAGE'),
 'compatibility_plan',(SELECT to_jsonb(cp) FROM release_ops.source_plans cp WHERE cp.release_id=q.release_id
 AND cp.attempt_id=q.attempt_id AND cp.phase='COMPATIBILITY'),
 'compatibility_operation',(SELECT to_jsonb(cx) FROM release_ops.external_operations cx JOIN release_ops.source_plans cp
 ON cx.intent->>'plan_id'=cp.id::text WHERE cp.release_id=q.release_id AND cp.attempt_id=q.attempt_id AND cp.phase='COMPATIBILITY'),
 'publication_results',(SELECT COALESCE(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM release_ops.external_operations x
 WHERE x.release_id=q.release_id AND x.kind='PUBLISH' AND x.intent->>'manifest_digest'=q.resolution_manifest_digest
 AND x.status IN ('SUCCEEDED','FAILED','CANCELLED','NOT_ACCEPTED')
 AND EXISTS(SELECT 1 FROM release_ops.provider_plans pp WHERE pp.id::text=x.intent->>'plan_id'
 AND pp.readiness_event::text=q.selected_receipts->>'READINESS' AND pp.recovery_id IS NOT DISTINCT FROM q.recovery_id)));
END $$;

CREATE OR REPLACE FUNCTION release_ops.begin_source_plan(owner uuid,epoch uuid,plan_id uuid,bundle_digest text,config_digest text,actor text) RETURNS jsonb
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
 IF p.phase NOT IN ('VALIDATION','STAGE','COMPATIBILITY') THEN
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
-- Semantic qualification is a distinct owned operation at STAGED. It shares
-- the existing external BUILD barrier and cannot dispatch from a verifier.
CREATE FUNCTION release_ops.submit_component_compatibility_plan(owner uuid,epoch uuid,release_id uuid,
 request jsonb,bundle_digest text,config_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; a release_ops.admissions; b release_ops.receipts; integration release_ops.receipts;
 i jsonb; plan release_ops.source_plans; build release_ops.external_operations; semantic jsonb;
 targets jsonb; expected_order jsonb; target text; component jsonb; expected_builds jsonb:='{}';
 current_tuple jsonb; expected_tuples jsonb; eid uuid;
BEGIN
 i:=release_ops.provider_installation(owner,epoch,bundle_digest,config_digest);
 PERFORM release_ops.valid_actor(actor);
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=submit_component_compatibility_plan.release_id FOR UPDATE;
 SELECT * INTO a FROM release_ops.admissions WHERE id=q.release_id;
 SELECT * INTO b FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'BUILD';
 SELECT * INTO integration FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'INTEGRATION';
 SELECT * INTO build FROM release_ops.external_operations WHERE id::text=b.data->>'aggregate_operation_id';
 SELECT jsonb_agg(c->>'target' ORDER BY c->>'target') INTO targets FROM jsonb_array_elements(q.resolution_manifest->'components') c;
 SELECT jsonb_agg(value ORDER BY ord) INTO expected_order
 FROM jsonb_array_elements(i->'binding'->'compatibility'->'cutover_order') WITH ORDINALITY t(value,ord)
 WHERE targets ? (value#>>'{}');
 semantic:=request->'qualification';
 IF q.state IS DISTINCT FROM 'STAGED' OR q.attempt_deadline<=clock_timestamp()
 OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM q.release_id
 OR NOT(i->'binding'->'adapters' ? 'github-compatibility')
 OR request->>'phase' IS DISTINCT FROM 'COMPATIBILITY'
 OR request->>'repository' IS DISTINCT FROM 'Smarter-Poker/Smarter-Poker-Club-Arena'
 OR request->>'repository' IS DISTINCT FROM a.intent->>'repository' OR request->>'target' IS DISTINCT FROM a.intent->>'target'
 OR request->>'accepted_head_sha' IS DISTINCT FROM q.resolution_head_sha
 OR request->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR request->>'source_sha' IS DISTINCT FROM b.data->>'source_sha'
 OR request->>'source_sha' IS DISTINCT FROM integration.data->>'merged_sha'
 OR request->>'expected_base_sha' IS DISTINCT FROM integration.data->>'expected_base_sha'
 OR request->>'tested_tree_sha' IS DISTINCT FROM integration.data->>'merged_tree_sha'
 OR request->>'control_sha' IS DISTINCT FROM i->'binding'->'github'->>'control_sha'
 OR request->>'workflow_id' IS DISTINCT FROM i->'binding'->'github'->>'component_qualification_workflow_id'
 OR COALESCE(request->>'workflow_id','') !~ '^[1-9][0-9]*$'
 OR request->>'runtime_image' IS DISTINCT FROM i->'binding'->'github'->>'component_runtime_image'
 OR COALESCE(request->>'runtime_image','') !~ '^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$'
 OR b.data->>'success' IS DISTINCT FROM 'true' OR b.release_id IS DISTINCT FROM q.release_id
 OR b.recovery_id IS DISTINCT FROM q.recovery_id OR build.status IS DISTINCT FROM 'SUCCEEDED'
 OR build.release_id IS DISTINCT FROM q.release_id OR build.intent->>'adapter' IS DISTINCT FROM 'component-aggregate'
 OR build.intent->'provider_request'->>'phase' IS DISTINCT FROM 'BUILD'
 OR build.result->'proof'->'artifact' IS DISTINCT FROM b.data->'artifact'
 OR semantic->>'version' IS DISTINCT FROM '1' OR semantic->>'release_id' IS DISTINCT FROM q.release_id::text
 OR semantic->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR semantic->>'build_receipt' IS DISTINCT FROM b.event_id::text
 OR semantic->>'aggregate_operation_id' IS DISTINCT FROM build.id::text
 OR semantic->>'source_sha' IS DISTINCT FROM b.data->>'source_sha'
 OR jsonb_typeof(semantic->'schema') IS DISTINCT FROM 'object'
 OR semantic->'schema' IS DISTINCT FROM i->'binding'->'compatibility'->'schema'
 OR COALESCE(semantic->'schema'->>'fixture_sha256','') !~ '^[0-9a-f]{64}$'
 OR COALESCE(semantic->'schema'->>'catalogue_digest','') !~ '^[0-9a-f]{64}$'
 OR COALESCE(semantic->'schema'->>'artifact_id','') !~ '^[1-9][0-9]*$'
 OR COALESCE(semantic->'schema'->>'archive_digest','') !~ '^sha256:[0-9a-f]{64}$'
 OR expected_order IS NULL OR semantic->'cutover_order' IS DISTINCT FROM expected_order
 OR (SELECT jsonb_agg(value ORDER BY value) FROM jsonb_array_elements(expected_order)) IS DISTINCT FROM targets
 OR targets NOT IN ('["club-arena-web"]'::jsonb,'["club-arena-engine","club-arena-web"]'::jsonb)
 OR jsonb_typeof(semantic->'tuples') IS DISTINCT FROM 'array'
 OR jsonb_array_length(semantic->'tuples') IS DISTINCT FROM jsonb_array_length(targets)+1
 OR jsonb_typeof(semantic->'artifact_inputs') IS DISTINCT FROM 'object'
 OR octet_length(request::text)>65536
 THEN RAISE EXCEPTION 'RELEASE_OWNED_COMPONENT_COMPATIBILITY_PLAN_REQUIRED'; END IF;
 IF targets ? 'club-arena-engine' AND NOT EXISTS(
  SELECT 1 FROM release_ops.source_plans stage JOIN release_ops.external_operations e ON e.intent->>'plan_id'=stage.id::text
  WHERE stage.release_id=q.release_id AND stage.attempt_id=q.attempt_id AND stage.phase='STAGE'
  AND e.status='SUCCEEDED' AND e.intent->>'adapter'='engine-stage')
 THEN RAISE EXCEPTION 'RELEASE_COMPONENT_STAGE_REQUIRED'; END IF;
 current_tuple:=semantic->'tuples'->0;
 IF (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(current_tuple) key) IS DISTINCT FROM ARRAY['club-arena-engine','club-arena-web']
 OR EXISTS(SELECT 1 FROM jsonb_each(current_tuple) t WHERE COALESCE(value->>'source_sha','') !~ '^[0-9a-f]{40}$'
  OR COALESCE(value->>'identity','') !~ '^sha256:[0-9a-f]{64}$'
  OR (key='club-arena-web' AND value->>'identity' IS DISTINCT FROM 'sha256:'||(value->>'manifest_digest')))
 THEN RAISE EXCEPTION 'RELEASE_COMPONENT_BEFORE_TUPLE_REQUIRED'; END IF;
 expected_tuples:=jsonb_build_array(current_tuple);
 FOR target IN SELECT jsonb_array_elements_text(expected_order) LOOP
  component:=b.data->'artifact'->'components'->target;
  expected_builds:=expected_builds||jsonb_build_object(target,jsonb_build_object('source_sha',component->>'source_sha',
   'identity',component->>'identity','build_operation_id',component->>'build_operation_id','build_run_id',component->>'build_run_id',
   'qualification_result_event',component->>'qualification_result_event','artifact_id',component->>'github_artifact_id',
   'archive_digest',component->>'github_archive_digest')||CASE WHEN target='club-arena-web'
    THEN jsonb_build_object('manifest_digest',component->>'manifest_digest') ELSE '{}'::jsonb END);
  current_tuple:=jsonb_set(current_tuple,ARRAY[target],jsonb_build_object('source_sha',component->>'source_sha','identity',component->>'identity')
   ||CASE WHEN target='club-arena-web' THEN jsonb_build_object('manifest_digest',component->>'manifest_digest') ELSE '{}'::jsonb END);
  expected_tuples:=expected_tuples||jsonb_build_array(current_tuple);
 END LOOP;
 IF semantic->'component_builds' IS DISTINCT FROM expected_builds OR semantic->'tuples' IS DISTINCT FROM expected_tuples
 THEN RAISE EXCEPTION 'RELEASE_EXACT_COMPONENT_COMBINATIONS_REQUIRED'; END IF;
 SELECT * INTO plan FROM release_ops.source_plans WHERE source_plans.release_id=q.release_id AND attempt_id=q.attempt_id AND phase='COMPATIBILITY';
 IF FOUND THEN
  IF plan.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'RELEASE_COMPONENT_COMPATIBILITY_PLAN_MISMATCH'; END IF;
  RETURN to_jsonb(plan);
 END IF;
 eid:=release_ops.event(q.release_id,'COMPONENT_COMPATIBILITY_PLAN',actor,request);
 INSERT INTO release_ops.source_plans(release_id,attempt_id,phase,adapter,request,event_id)
 VALUES(q.release_id,q.attempt_id,'COMPATIBILITY','github-compatibility',request,eid) RETURNING * INTO plan;
 RETURN to_jsonb(plan);
END $$;

-- Component receipts use compact, lexically ordered JSON, unlike the original
-- journal digest's PostgreSQL jsonb text. Keep request/tuple cleanup hashes bound
-- to the immutable protocol facts rather than trusting a supplied digest.
CREATE FUNCTION release_ops.component_fact_json(fact jsonb) RETURNS text
 LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE encoded text;
BEGIN
 CASE jsonb_typeof(fact)
 WHEN 'object' THEN
  SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||release_ops.component_fact_json(value),',' ORDER BY key COLLATE "C"),'')||'}'
   INTO encoded FROM jsonb_each(fact);
 WHEN 'array' THEN
  SELECT '['||COALESCE(string_agg(release_ops.component_fact_json(value),',' ORDER BY ordinal),'')||']'
   INTO encoded FROM jsonb_array_elements(fact) WITH ORDINALITY AS item(value,ordinal);
 ELSE encoded:=fact::text;
 END CASE;
 RETURN encoded;
END $$;
CREATE FUNCTION release_ops.component_fact_digest(fact jsonb) RETURNS text
 LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(release_ops.component_fact_json(fact),'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION release_ops.component_fact_json(jsonb),release_ops.component_fact_digest(jsonb) FROM PUBLIC;

CREATE FUNCTION release_ops.guard_component_compatibility_terminal() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE proof jsonb; semantic jsonb; qualification jsonb; cleanup jsonb; fixture jsonb; checked jsonb; tuple_index integer;
BEGIN
 IF OLD.intent->>'adapter' IS DISTINCT FROM 'github-compatibility' OR NEW.status IN ('INTENT','UNKNOWN') THEN RETURN NEW; END IF;
 IF NEW.status='NOT_ACCEPTED' AND NOT EXISTS(SELECT 1 FROM release_ops.provider_submissions WHERE operation_id=OLD.id) THEN RETURN NEW; END IF;
 IF NEW.status='NOT_ACCEPTED' OR NOT EXISTS(SELECT 1 FROM release_ops.provider_submissions WHERE operation_id=OLD.id)
 OR COALESCE(NEW.result->>'provider_operation_id','') !~ '^[1-9][0-9]*$'
 OR NEW.result->'accepted' IS DISTINCT FROM 'true'::jsonb
 THEN RAISE EXCEPTION 'RELEASE_COMPONENT_COMPATIBILITY_TERMINAL_REQUIRED'; END IF;
 proof:=NEW.result->'proof'; semantic:=proof->'compatibility'; qualification:=OLD.intent->'provider_request'->'qualification';
 IF proof->>'operation_id' IS DISTINCT FROM OLD.id::text OR proof->'request' IS DISTINCT FROM OLD.intent->'provider_request'
 OR proof->>'control_sha' IS DISTINCT FROM OLD.intent->'provider_request'->>'control_sha'
 OR proof->>'run_id' IS DISTINCT FROM NEW.result->>'provider_operation_id' OR proof->>'run_attempt' IS DISTINCT FROM '1'
 THEN RAISE EXCEPTION 'RELEASE_EXACT_COMPONENT_COMPATIBILITY_PROOF_REQUIRED'; END IF;
 IF NEW.status='SUCCEEDED' THEN
  cleanup:=semantic->'cleanup';
 ELSE
  cleanup:=proof->'cleanup';
  IF proof->>'success' IS DISTINCT FROM 'false'
  OR COALESCE(proof->>'cleanup_artifact_id','') !~ '^[1-9][0-9]*$'
  OR COALESCE(proof->>'cleanup_archive_digest','') !~ '^sha256:[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'RELEASE_COMPONENT_COMPATIBILITY_FAILURE_CLEANUP_REQUIRED'; END IF;
 END IF;
 IF cleanup->'version' IS DISTINCT FROM '1'::jsonb OR cleanup->'complete' IS DISTINCT FROM 'true'::jsonb
 OR cleanup->'images_removed' IS DISTINCT FROM 'true'::jsonb OR cleanup->>'operation_id' IS DISTINCT FROM OLD.id::text
 OR cleanup->>'run_id' IS DISTINCT FROM proof->>'run_id' OR cleanup->'run_attempt' IS DISTINCT FROM '1'::jsonb
 OR cleanup->>'request_digest' IS DISTINCT FROM release_ops.component_fact_digest(qualification)
 OR jsonb_typeof(cleanup->'fixtures') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'RELEASE_EXACT_COMPONENT_COMPATIBILITY_CLEANUP_REQUIRED'; END IF;
 IF jsonb_array_length(cleanup->'fixtures')>jsonb_array_length(qualification->'tuples')
 OR (NEW.status='SUCCEEDED' AND jsonb_array_length(cleanup->'fixtures')<>jsonb_array_length(qualification->'tuples'))
 THEN RAISE EXCEPTION 'RELEASE_EXACT_COMPONENT_COMPATIBILITY_CLEANUP_REQUIRED'; END IF;
 FOR fixture,tuple_index IN SELECT value,(ordinal-1)::integer FROM jsonb_array_elements(cleanup->'fixtures') WITH ORDINALITY AS item(value,ordinal)
 LOOP
  IF fixture->'index' IS DISTINCT FROM to_jsonb(tuple_index) OR fixture->'complete' IS DISTINCT FROM 'true'::jsonb
  OR fixture->'remaining_objects' IS DISTINCT FROM '0'::jsonb
  OR fixture->>'tuple_digest' IS DISTINCT FROM release_ops.component_fact_digest(qualification->'tuples'->tuple_index)
  THEN RAISE EXCEPTION 'RELEASE_EXACT_COMPONENT_COMPATIBILITY_CLEANUP_REQUIRED'; END IF;
 END LOOP;
 IF NEW.status<>'SUCCEEDED' THEN RETURN NEW; END IF;
 IF proof->>'success' IS DISTINCT FROM 'true' OR semantic->>'version' IS DISTINCT FROM '1' OR semantic->>'verified' IS DISTINCT FROM 'true'
 OR semantic->>'operation_id' IS DISTINCT FROM OLD.id::text OR semantic->'request' IS DISTINCT FROM qualification
 OR semantic->>'request_digest' IS DISTINCT FROM release_ops.component_fact_digest(qualification)
 OR semantic->>'run_id' IS DISTINCT FROM proof->>'run_id' OR semantic->>'run_attempt' IS DISTINCT FROM '1'
 OR semantic->>'control_sha' IS DISTINCT FROM proof->>'control_sha'
 OR semantic->>'workflow_id' IS DISTINCT FROM OLD.intent->'provider_request'->>'workflow_id'
 OR semantic->>'workflow_path' IS DISTINCT FROM '.github/workflows/release-component-qualification.yml'
 OR COALESCE(semantic->>'artifact_id','') !~ '^[1-9][0-9]*$' OR COALESCE(semantic->>'archive_digest','') !~ '^sha256:[0-9a-f]{64}$'
 OR jsonb_typeof(semantic->'combinations') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'RELEASE_EXACT_COMPONENT_COMPATIBILITY_PROOF_REQUIRED'; END IF;
 IF jsonb_array_length(semantic->'combinations') IS DISTINCT FROM jsonb_array_length(qualification->'tuples')
 THEN RAISE EXCEPTION 'RELEASE_EXACT_COMPONENT_COMPATIBILITY_PROOF_REQUIRED'; END IF;
 FOR checked,tuple_index IN SELECT value,(ordinal-1)::integer FROM jsonb_array_elements(semantic->'combinations') WITH ORDINALITY AS item(value,ordinal)
 LOOP
  IF checked->>'success' IS DISTINCT FROM 'true' OR checked->>'failed' IS DISTINCT FROM '0'
  OR checked->>'retries' IS DISTINCT FROM '0' OR checked->>'skipped' IS DISTINCT FROM '0' OR checked->>'executed' IS DISTINCT FROM '5'
  OR checked->>'tuple_digest' IS DISTINCT FROM release_ops.component_fact_digest(qualification->'tuples'->tuple_index)
  OR checked->'cleanup'->'complete' IS DISTINCT FROM 'true'::jsonb OR checked->'cleanup'->'remaining_objects' IS DISTINCT FROM '0'::jsonb
  THEN RAISE EXCEPTION 'RELEASE_EXACT_COMPONENT_COMPATIBILITY_PROOF_REQUIRED'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_component_compatibility_terminal BEFORE UPDATE ON release_ops.external_operations
 FOR EACH ROW EXECUTE FUNCTION release_ops.guard_component_compatibility_terminal();

CREATE FUNCTION release_ops.guard_component_compatibility_selection() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE q release_ops.queue; build release_ops.receipts; operation release_ops.external_operations;
BEGIN
 IF NEW.kind NOT IN ('STAGED','READINESS') THEN RETURN NEW; END IF;
 SELECT * INTO q FROM release_ops.queue WHERE release_id=NEW.release_id;
 SELECT * INTO build FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'BUILD';
 IF NOT (build.data ? 'aggregate_operation_id') THEN RETURN NEW; END IF;
 SELECT e.* INTO operation FROM release_ops.external_operations e JOIN release_ops.source_plans p ON p.id::text=e.intent->>'plan_id'
 WHERE p.release_id=q.release_id AND p.attempt_id=q.attempt_id AND p.phase='COMPATIBILITY';
 IF operation.status IS DISTINCT FROM 'SUCCEEDED' OR operation.intent->>'adapter' IS DISTINCT FROM 'github-compatibility'
 OR operation.intent->'provider_request'->'qualification'->>'build_receipt' IS DISTINCT FROM build.event_id::text
 OR NEW.data->>'compatibility_operation_id' IS DISTINCT FROM operation.id::text
 OR NEW.data->'semantic_qualification' IS DISTINCT FROM operation.result->'proof'->'compatibility'
 THEN RAISE EXCEPTION 'RELEASE_OWNED_COMPONENT_COMPATIBILITY_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_component_compatibility_selection BEFORE INSERT ON release_ops.receipts
 FOR EACH ROW EXECUTE FUNCTION release_ops.guard_component_compatibility_selection();
REVOKE ALL ON FUNCTION release_ops.submit_component_compatibility_plan(uuid,uuid,uuid,jsonb,text,text,text),
 release_ops.guard_component_compatibility_terminal(),release_ops.guard_component_compatibility_selection() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_ops.submit_component_compatibility_plan(uuid,uuid,uuid,jsonb,text,text,text) TO release_journal_controller;
CREATE FUNCTION release_ops.check_component_publication_order(release_id uuid,request jsonb) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; ready release_ops.receipts; build release_ops.receipts; target text; adapter text;
BEGIN
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=check_component_publication_order.release_id;
 SELECT * INTO ready FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'READINESS';
 SELECT * INTO build FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'BUILD';
 IF NOT (build.data ? 'aggregate_operation_id') THEN RETURN; END IF;
 IF ready.data->'semantic_qualification'->'request'->>'build_receipt' IS DISTINCT FROM build.event_id::text
 OR jsonb_typeof(ready.data->'semantic_qualification'->'request'->'cutover_order') IS DISTINCT FROM 'array'
 OR NOT (ready.data->'semantic_qualification'->'request'->'cutover_order' ? (request->>'target'))
 THEN RAISE EXCEPTION 'RELEASE_COMPONENT_PUBLICATION_ORDER_REQUIRED'; END IF;
 FOR target IN SELECT jsonb_array_elements_text(ready.data->'semantic_qualification'->'request'->'cutover_order') LOOP
  IF target=request->>'target' THEN RETURN; END IF;
  adapter:=CASE target WHEN 'club-arena-engine' THEN 'hetzner-intake' WHEN 'club-arena-web' THEN 'github-static' END;
  IF adapter IS NULL OR NOT EXISTS(
   SELECT 1 FROM release_ops.external_operations e JOIN release_ops.provider_plans p ON p.id::text=e.intent->>'plan_id'
   WHERE e.release_id=q.release_id AND e.kind='PUBLISH' AND e.status='SUCCEEDED'
   AND p.readiness_event=ready.event_id AND p.recovery_id IS NOT DISTINCT FROM q.recovery_id
   AND e.intent->>'adapter'=adapter AND e.intent->>'manifest_digest'=q.resolution_manifest_digest
   AND e.intent->'provider_request'=ready.data->'provider_requests'->adapter
   AND e.intent->'provider_request'->>'target'=target)
  THEN RAISE EXCEPTION 'RELEASE_COMPONENT_PUBLICATION_ORDER_REQUIRED'; END IF;
 END LOOP;
 RAISE EXCEPTION 'RELEASE_COMPONENT_PUBLICATION_ORDER_REQUIRED';
END $$;
CREATE FUNCTION release_ops.guard_component_publication_plan() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM release_ops.check_component_publication_order(NEW.release_id,NEW.request);
 RETURN NEW;
END $$;
CREATE FUNCTION release_ops.guard_component_publication_intent() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.kind='PUBLISH' THEN PERFORM release_ops.check_component_publication_order(NEW.release_id,NEW.intent->'provider_request'); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_component_publication_plan BEFORE INSERT ON release_ops.provider_plans
 FOR EACH ROW EXECUTE FUNCTION release_ops.guard_component_publication_plan();
CREATE TRIGGER guard_component_publication_intent BEFORE INSERT ON release_ops.external_operations
 FOR EACH ROW EXECUTE FUNCTION release_ops.guard_component_publication_intent();
REVOKE ALL ON FUNCTION release_ops.check_component_publication_order(uuid,jsonb),
 release_ops.guard_component_publication_plan(),release_ops.guard_component_publication_intent() FROM PUBLIC;
COMMIT;
