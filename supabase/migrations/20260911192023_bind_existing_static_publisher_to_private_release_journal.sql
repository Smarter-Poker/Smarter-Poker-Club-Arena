-- 20260911192023: reserved by scripts/new-migration.mjs. Source-only private journal extension.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE release_ops.provider_plans DROP CONSTRAINT provider_plans_adapter_check;
ALTER TABLE release_ops.provider_plans ADD CONSTRAINT provider_plans_adapter_check CHECK(adapter IN ('vercel-promote','hetzner-intake','github-static'));
ALTER TABLE release_ops.source_plans DROP CONSTRAINT source_plans_adapter_check;
ALTER TABLE release_ops.source_plans ADD CONSTRAINT source_plans_adapter_check CHECK(adapter IN ('github-merge','github-workflow','engine-stage','github-certification','github-static'));

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
 OR jsonb_typeof(binding->'adapters') IS DISTINCT FROM 'array' OR jsonb_array_length(binding->'adapters') NOT BETWEEN 1 AND 7
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(binding->'adapters') a WHERE a NOT IN ('vercel-promote','hetzner-intake','github-merge','github-workflow','engine-stage','github-certification','github-static'))
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

CREATE FUNCTION release_ops.register_static_publication_ingress(binding jsonb,evidence jsonb,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE i release_ops.certification_ingress_installations; eid uuid;
BEGIN
 PERFORM release_ops.valid_actor(actor);
 IF binding->>'repository' IS DISTINCT FROM 'Smarter-Poker/Smarter-Poker-Club-Arena'
 OR COALESCE(binding->>'repository_id','') !~ '^[1-9][0-9]*$'
 OR COALESCE(binding->>'workflow_id','') !~ '^[1-9][0-9]*$'
 OR binding->>'workflow_path' IS DISTINCT FROM '.github/workflows/publish-club-arena.yml'
 OR COALESCE(binding->>'control_sha','') !~ '^[0-9a-f]{40}$'
 OR COALESCE(binding->>'control_ref','') !~ '^refs/heads/[A-Za-z0-9/_-]+$'
 OR binding->>'audience' IS DISTINCT FROM 'club-arena-static-publication'
 OR COALESCE(binding->>'url','') !~ '^https://[a-z0-9.-]+/static-publication$'
 OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=binding->>'principal' AND r.rolcanlogin
  AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
  AND pg_has_role(r.oid,'release_certification_callback','MEMBER')
  AND NOT pg_has_role(r.oid,'release_journal_controller','MEMBER')
  AND NOT pg_has_role(r.oid,'release_journal_operator','MEMBER')
  AND NOT pg_has_role(r.oid,'release_journal_verifier','MEMBER')
  AND NOT pg_has_role(r.oid,'release_journal_submitter','MEMBER'))
 OR jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR octet_length(evidence::text)>65536
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['installed_code','authenticated_ingress','identity_membership',
   'exact_workflow','same_run_artifact_gate','native_origin_transaction']) k
   WHERE jsonb_typeof(evidence->k) IS DISTINCT FROM 'array' OR jsonb_array_length(evidence->k)=0)
 THEN RAISE EXCEPTION 'RELEASE_STATIC_PUBLICATION_INGRESS_INSTALLATION_REQUIRED'; END IF;
 eid:=release_ops.event(NULL,'STATIC_PUBLICATION_INGRESS_INSTALLATION',actor,jsonb_build_object('binding',binding,'evidence',evidence));
 INSERT INTO release_ops.certification_ingress_installations(binding,evidence,event_id) VALUES(binding,evidence,eid) RETURNING * INTO i;
 RETURN to_jsonb(i);
END $$;

CREATE TABLE release_ops.static_publication_claims (
 operation_id uuid PRIMARY KEY REFERENCES release_ops.external_operations(id),
 build_operation_id uuid NOT NULL UNIQUE REFERENCES release_ops.external_operations(id),
 run_id text NOT NULL, identity jsonb NOT NULL, claim_key uuid NOT NULL,
 event_id uuid NOT NULL REFERENCES release_ops.events(id)
);
CREATE TRIGGER immutable_static_publication_claim BEFORE UPDATE OR DELETE ON release_ops.static_publication_claims
 FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();

CREATE FUNCTION release_ops.submit_static_build_plan(owner uuid,epoch uuid,release_id uuid,request jsonb,
 bundle_digest text,config_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; p release_ops.source_plans; i jsonb; v release_ops.receipts;
 ingress release_ops.certification_ingress_installations; eid uuid;
BEGIN
 i:=release_ops.provider_installation(owner,epoch,bundle_digest,config_digest);
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=submit_static_build_plan.release_id FOR UPDATE;
 SELECT * INTO v FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'INTEGRATION';
 SELECT * INTO ingress FROM release_ops.certification_ingress_installations WHERE id::text=request->'static_authority'->>'installation_receipt';
 IF q.state IS DISTINCT FROM 'BUILDING' OR q.attempt_deadline<=clock_timestamp()
 OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id
 OR NOT(i->'binding'->'adapters' ? 'github-static') OR request->>'phase' IS DISTINCT FROM 'BUILD'
 OR request->>'static_version' IS DISTINCT FROM '1' OR request->>'repository' IS DISTINCT FROM 'Smarter-Poker/Smarter-Poker-Club-Arena'
 OR request->>'target' IS DISTINCT FROM 'club-arena-web' OR request->>'source_sha' IS DISTINCT FROM v.data->>'merged_sha'
 OR request->>'accepted_head_sha' IS DISTINCT FROM q.resolution_head_sha OR request->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR request->>'control_sha' IS DISTINCT FROM i->'binding'->'github'->>'control_sha'
 OR request->>'workflow_id' IS DISTINCT FROM i->'binding'->'github'->>'static_workflow_id'
 OR request->>'repository_id' IS DISTINCT FROM ingress.binding->>'repository_id'
 OR request->>'control_sha' IS DISTINCT FROM ingress.binding->>'control_sha'
 OR request->>'workflow_id' IS DISTINCT FROM ingress.binding->>'workflow_id'
 OR request->'static_authority'->>'url' IS DISTINCT FROM ingress.binding->>'url'
 OR ingress.binding->>'audience' IS DISTINCT FROM 'club-arena-static-publication'
 OR request->'static_authority'->>'audience' IS DISTINCT FROM ingress.binding->>'audience'
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.resolution_manifest->'components') c WHERE c->>'target'='club-arena-web')
 OR COALESCE(request->>'not_after_epoch','') !~ '^[1-9][0-9]{9}$'
 OR (request->>'not_after_epoch')::bigint>extract(epoch FROM q.attempt_deadline)::bigint
 OR ingress.id IS NULL OR octet_length(request::text)>32768
 THEN RAISE EXCEPTION 'RELEASE_STATIC_BUILD_PLAN_REQUIRED'; END IF;
 SELECT * INTO p FROM release_ops.source_plans WHERE source_plans.release_id=submit_static_build_plan.release_id AND attempt_id=q.attempt_id AND phase='BUILD';
 IF FOUND THEN
  IF p.request IS DISTINCT FROM request THEN RAISE EXCEPTION 'RELEASE_STATIC_BUILD_PLAN_MISMATCH'; END IF;
  RETURN to_jsonb(p);
 END IF;
 eid:=release_ops.event(release_id,'STATIC_BUILD_PLAN',actor,request);
 INSERT INTO release_ops.source_plans(release_id,attempt_id,phase,adapter,request,event_id)
 VALUES(release_id,q.attempt_id,'BUILD','github-static',request,eid) RETURNING * INTO p;
 RETURN to_jsonb(p);
END $$;

CREATE FUNCTION release_ops.submit_static_publication_plan(owner uuid,epoch uuid,release_id uuid,operation_key text,
 request jsonb,bundle_digest text,config_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; p release_ops.provider_plans; i jsonb; b release_ops.receipts; r release_ops.receipts;
 build release_ops.external_operations; eid uuid;
BEGIN
 i:=release_ops.provider_installation(owner,epoch,bundle_digest,config_digest);
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=submit_static_publication_plan.release_id FOR UPDATE;
 SELECT * INTO b FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'BUILD';
 SELECT * INTO r FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'READINESS';
 SELECT * INTO build FROM release_ops.external_operations WHERE id::text=request->>'build_operation_id';
 IF q.state IS DISTINCT FROM 'APPLYING' OR q.attempt_deadline<=clock_timestamp()
 OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id
 OR NOT(i->'binding'->'adapters' ? 'github-static') OR request->>'phase' IS DISTINCT FROM 'PUBLISH'
 OR request->>'static_version' IS DISTINCT FROM '1' OR request->>'target' IS DISTINCT FROM 'club-arena-web'
 OR request->>'repository' IS DISTINCT FROM 'Smarter-Poker/Smarter-Poker-Club-Arena'
 OR request->>'control_sha' IS DISTINCT FROM i->'binding'->'github'->>'control_sha'
 OR request->>'workflow_id' IS DISTINCT FROM i->'binding'->'github'->>'static_workflow_id'
 OR request->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR request->'artifact' IS DISTINCT FROM b.data->'artifact'->'components'->'club-arena-web'
 OR request->>'source_sha' IS DISTINCT FROM request->'artifact'->>'source_sha'
 OR request->>'build_run_id' IS DISTINCT FROM build.result->>'provider_operation_id'
 OR build.status IS DISTINCT FROM 'SUCCEEDED' OR build.release_id IS DISTINCT FROM release_id OR build.kind IS DISTINCT FROM 'BUILD'
 OR build.intent->'provider_request'->>'static_version' IS DISTINCT FROM '1'
 OR request->'artifact' IS DISTINCT FROM build.result->'proof'->'artifact'->'components'->'club-arena-web'
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

CREATE FUNCTION release_ops.static_publication_context(build_operation_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations; i release_ops.certification_ingress_installations;
BEGIN
 SELECT * INTO e FROM release_ops.external_operations WHERE id=build_operation_id;
 SELECT * INTO i FROM release_ops.certification_ingress_installations WHERE id::text=e.intent->'provider_request'->'static_authority'->>'installation_receipt';
 IF e.kind IS DISTINCT FROM 'BUILD' OR e.intent->'provider_request'->>'static_version' IS DISTINCT FROM '1'
 OR e.status NOT IN ('INTENT','UNKNOWN','SUCCEEDED') OR i.binding->>'principal' IS DISTINCT FROM session_user
 OR i.binding->>'audience' IS DISTINCT FROM 'club-arena-static-publication'
 OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM e.release_id
 OR NOT EXISTS(SELECT 1 FROM release_ops.provider_submissions WHERE operation_id=e.id)
 THEN RAISE EXCEPTION 'RELEASE_STATIC_CALLBACK_SCOPE_REFUSED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM release_ops.events v WHERE v.id=e.intent_event AND v.release_id=e.release_id
 AND v.kind='EXTERNAL_INTENT' AND (v.data=e.intent OR v.data->'intent'=e.intent))
 THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_INTENT_EVENT_REQUIRED'; END IF;
 RETURN jsonb_build_object('request',e.intent->'provider_request','binding',i.binding,'build_operation_id',e.id,
 'created_at',(SELECT created_at FROM release_ops.events WHERE id=e.intent_event));
END $$;

CREATE FUNCTION release_ops.claim_static_publication(build_operation_id uuid,identity jsonb,claim_key uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE context jsonb; build release_ops.external_operations; publication release_ops.external_operations;
 q release_ops.queue; prior release_ops.static_publication_claims; eid uuid;
BEGIN
 context:=release_ops.static_publication_context(build_operation_id);
 SELECT * INTO build FROM release_ops.external_operations WHERE id=build_operation_id;
 SELECT * INTO q FROM release_ops.queue WHERE release_id=build.release_id FOR UPDATE;
 IF identity->>'repository_id' IS DISTINCT FROM context->'binding'->>'repository_id'
 OR identity->>'workflow_id' IS DISTINCT FROM context->'binding'->>'workflow_id'
 OR identity->>'control_sha' IS DISTINCT FROM context->'binding'->>'control_sha'
 OR identity->>'run_attempt' IS DISTINCT FROM '1' OR COALESCE(identity->>'run_id','') !~ '^[1-9][0-9]*$'
 OR claim_key IS NULL OR q.attempt_deadline<=clock_timestamp()
 THEN RAISE EXCEPTION 'RELEASE_STATIC_CALLBACK_IDENTITY_REFUSED'; END IF;
 IF build.status<>'SUCCEEDED' THEN RETURN jsonb_build_object('ready',false); END IF;
 IF identity->>'run_id' IS DISTINCT FROM build.result->>'provider_operation_id' THEN RAISE EXCEPTION 'RELEASE_STATIC_CALLBACK_RUN_MISMATCH'; END IF;
 SELECT * INTO publication FROM release_ops.external_operations e WHERE e.release_id=build.release_id AND e.kind='PUBLISH'
 AND e.status IN ('INTENT','UNKNOWN') AND e.intent->>'adapter'='github-static'
 AND e.intent->'provider_request'->>'build_operation_id'=build.id::text;
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
 eid:=release_ops.event(build.release_id,'STATIC_PUBLICATION_CLAIM','static-publication-callback',jsonb_build_object('build_operation_id',build.id,'operation_id',publication.id,'identity',identity));
 INSERT INTO release_ops.static_publication_claims VALUES(publication.id,build.id,identity->>'run_id',identity,claim_key,eid);
 RETURN jsonb_build_object('ready',true,'may_publish',true,'operation_id',publication.id,'request',publication.intent->'provider_request','claim_receipt',eid);
END $$;

CREATE FUNCTION release_ops.guard_static_publication_resolution() RETURNS trigger
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
  OR claim.build_operation_id::text IS DISTINCT FROM OLD.intent->'provider_request'->>'build_operation_id'
  OR proof->'component' IS DISTINCT FROM OLD.intent->'provider_request'->'artifact'
  OR proof->'native'->>'source_sha' IS DISTINCT FROM proof->'component'->>'source_sha'
  OR proof->'native'->>'manifest_sha256' IS DISTINCT FROM proof->'component'->>'manifest_digest'
  OR proof->'native'->'build_info'->>'run_id' IS DISTINCT FROM claim.run_id
  THEN RAISE EXCEPTION 'RELEASE_STATIC_ONE_USE_PUBLICATION_PROOF_REQUIRED'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_static_publication_resolution BEFORE UPDATE ON release_ops.external_operations
 FOR EACH ROW EXECUTE FUNCTION release_ops.guard_static_publication_resolution();

REVOKE ALL ON TABLE release_ops.static_publication_claims FROM PUBLIC,release_certification_callback;
REVOKE ALL ON FUNCTION release_ops.register_static_publication_ingress(jsonb,jsonb,text),
 release_ops.submit_static_build_plan(uuid,uuid,uuid,jsonb,text,text,text),
 release_ops.submit_static_publication_plan(uuid,uuid,uuid,text,jsonb,text,text,text),
 release_ops.static_publication_context(uuid),release_ops.claim_static_publication(uuid,jsonb,uuid),
 release_ops.guard_static_publication_resolution() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_ops.submit_static_build_plan(uuid,uuid,uuid,jsonb,text,text,text),
 release_ops.submit_static_publication_plan(uuid,uuid,uuid,text,jsonb,text,text,text) TO release_journal_controller;
GRANT EXECUTE ON FUNCTION release_ops.static_publication_context(uuid),release_ops.claim_static_publication(uuid,jsonb,uuid) TO release_certification_callback;
COMMIT;
