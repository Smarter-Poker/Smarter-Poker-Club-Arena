-- 20260911190350_component_certification_and_durable_fixture_claims.sql
--
-- Version reserved by scripts/new-migration.mjs. Private controller schema only.
-- No login, role membership, ingress installation, activation or fixture effects.

BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='release_certification_callback') THEN
  CREATE ROLE release_certification_callback NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
END $$;

CREATE TABLE release_ops.certification_ingress_installations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), binding jsonb NOT NULL, evidence jsonb NOT NULL,
 event_id uuid NOT NULL REFERENCES release_ops.events(id)
);
CREATE TABLE release_ops.certification_fixture_intents (
 plan_id uuid NOT NULL REFERENCES release_ops.source_plans(id), slot text NOT NULL,
 user_id uuid NOT NULL UNIQUE, email text NOT NULL UNIQUE,
 event_id uuid NOT NULL REFERENCES release_ops.events(id), PRIMARY KEY(plan_id,slot)
);
CREATE TABLE release_ops.certification_run_claims (
 operation_id uuid PRIMARY KEY REFERENCES release_ops.external_operations(id),
 run_id text NOT NULL, identity jsonb NOT NULL, event_id uuid NOT NULL REFERENCES release_ops.events(id)
);
CREATE TABLE release_ops.certification_fixture_claims (
 operation_id uuid NOT NULL REFERENCES release_ops.certification_run_claims(operation_id), slot text NOT NULL,
 claim_key uuid NOT NULL, event_id uuid NOT NULL REFERENCES release_ops.events(id), PRIMARY KEY(operation_id,slot)
);
CREATE TABLE release_ops.certification_cleanup_barriers (
 operation_id uuid PRIMARY KEY REFERENCES release_ops.certification_run_claims(operation_id),
 event_id uuid NOT NULL REFERENCES release_ops.events(id)
);
CREATE TABLE release_ops.certification_fixture_outcomes (
 operation_id uuid NOT NULL, slot text NOT NULL, outcome text NOT NULL CHECK(outcome IN ('CREATED','NOT_SUBMITTED')),
 event_id uuid NOT NULL REFERENCES release_ops.events(id), PRIMARY KEY(operation_id,slot),
 FOREIGN KEY(operation_id,slot) REFERENCES release_ops.certification_fixture_claims(operation_id,slot)
);
CREATE TABLE release_ops.certification_cleanup_receipts (
 operation_id uuid PRIMARY KEY REFERENCES release_ops.certification_cleanup_barriers(operation_id),
 data jsonb NOT NULL, event_id uuid NOT NULL REFERENCES release_ops.events(id)
);
CREATE TABLE release_ops.certification_cleanup_recoveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), operation_id uuid NOT NULL UNIQUE REFERENCES release_ops.external_operations(id),
 original_run jsonb NOT NULL, event_id uuid NOT NULL REFERENCES release_ops.events(id)
);
CREATE TABLE release_ops.certification_cleanup_run_claims (
 recovery_id uuid PRIMARY KEY REFERENCES release_ops.certification_cleanup_recoveries(id),
 identity jsonb NOT NULL, event_id uuid NOT NULL REFERENCES release_ops.events(id)
);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['certification_ingress_installations','certification_fixture_intents',
  'certification_run_claims','certification_fixture_claims','certification_fixture_outcomes','certification_cleanup_barriers','certification_cleanup_receipts',
  'certification_cleanup_recoveries','certification_cleanup_run_claims'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_certificate BEFORE UPDATE OR DELETE ON release_ops.%I FOR EACH ROW EXECUTE FUNCTION release_ops.immutable()',t);
 END LOOP;
END $$;

CREATE FUNCTION release_ops.certification_schema_version() RETURNS integer LANGUAGE sql
 SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT 2 $$;

CREATE FUNCTION release_ops.provider_operation_context(owner uuid,epoch uuid,operation_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE result jsonb;
BEGIN
 PERFORM release_ops.check_owner(owner,epoch,false);
 SELECT to_jsonb(e)||jsonb_build_object('created_at',v.created_at,
 'cleanup_recovery',(SELECT to_jsonb(r)||jsonb_build_object('created_at',rv.created_at) FROM release_ops.certification_cleanup_recoveries r
 JOIN release_ops.events rv ON rv.id=r.event_id WHERE r.operation_id=e.id),
 'fixture_cleanup',(SELECT to_jsonb(c) FROM release_ops.certification_cleanup_receipts c WHERE c.operation_id=e.id)) INTO result
 FROM release_ops.external_operations e JOIN release_ops.events v ON v.id=e.intent_event
 WHERE e.id=operation_id AND v.release_id=e.release_id AND v.kind='EXTERNAL_INTENT'
 AND (v.data->'intent'=e.intent OR v.data=e.intent);
 IF result IS NULL THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_INTENT_EVENT_REQUIRED'; END IF;
 RETURN result;
END $$;

CREATE FUNCTION release_ops.register_certification_ingress(binding jsonb,evidence jsonb,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE i release_ops.certification_ingress_installations; eid uuid;
BEGIN
 PERFORM release_ops.valid_actor(actor);
 IF binding->>'repository' IS DISTINCT FROM 'Smarter-Poker/Smarter-Poker-Club-Arena'
 OR COALESCE(binding->>'repository_id','') !~ '^[1-9][0-9]*$'
 OR COALESCE(binding->>'workflow_id','') !~ '^[1-9][0-9]*$'
 OR binding->>'workflow_path' IS DISTINCT FROM '.github/workflows/post-deploy-e2e.yml'
 OR COALESCE(binding->>'control_sha','') !~ '^[0-9a-f]{40}$'
 OR COALESCE(binding->>'control_ref','') !~ '^refs/heads/[A-Za-z0-9/_-]+$'
 OR binding->>'audience' IS DISTINCT FROM 'club-arena-release-certification'
 OR COALESCE(binding->>'url','') !~ '^https://[a-z0-9.-]+/certification$'
 OR NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=binding->>'principal' AND r.rolcanlogin
  AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
  AND pg_has_role(r.oid,'release_certification_callback','MEMBER')
  AND NOT pg_has_role(r.oid,'release_journal_controller','MEMBER')
  AND NOT pg_has_role(r.oid,'release_journal_operator','MEMBER')
  AND NOT pg_has_role(r.oid,'release_journal_verifier','MEMBER')
  AND NOT pg_has_role(r.oid,'release_journal_submitter','MEMBER'))
 OR jsonb_typeof(evidence) IS DISTINCT FROM 'object' OR octet_length(evidence::text)>65536
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['installed_code','authenticated_ingress','identity_membership',
   'exact_workflow','reserved_auth_uuid','cleanup_authority']) k
   WHERE jsonb_typeof(evidence->k) IS DISTINCT FROM 'array' OR jsonb_array_length(evidence->k)=0)
 THEN RAISE EXCEPTION 'RELEASE_CERTIFICATION_INGRESS_INSTALLATION_REQUIRED'; END IF;
 eid:=release_ops.event(NULL,'CERTIFICATION_INGRESS_INSTALLATION',actor,jsonb_build_object('binding',binding,'evidence',evidence));
 INSERT INTO release_ops.certification_ingress_installations(binding,evidence,event_id) VALUES(binding,evidence,eid) RETURNING * INTO i;
 RETURN to_jsonb(i);
END $$;

-- Planning only consumes immutable selected receipts and completed publication
-- operations. It does not grant a missing static publisher any authority.
CREATE FUNCTION release_ops.submit_component_certification_plan(owner uuid,epoch uuid,release_id uuid,
 request jsonb,bundle_digest text,config_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; a release_ops.admissions; p release_ops.source_plans; installation jsonb;
 ingress release_ops.certification_ingress_installations; b release_ops.receipts; ready release_ops.receipts;
 prior release_ops.receipts; x release_ops.external_operations; c jsonb; target text; changed boolean;
 eid uuid; slot text; uid uuid; roster jsonb:='{}'; complete_request jsonb;
BEGIN
 installation:=release_ops.provider_installation(owner,epoch,bundle_digest,config_digest);
 PERFORM release_ops.valid_actor(actor);
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=submit_component_certification_plan.release_id FOR UPDATE;
 SELECT * INTO a FROM release_ops.admissions WHERE id=release_id;
 SELECT * INTO b FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'BUILD';
 SELECT * INTO ready FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'READINESS';
 SELECT * INTO ingress FROM release_ops.certification_ingress_installations
 WHERE id::text=request->'fixture_authority'->>'installation_receipt';
 IF q.state IS DISTINCT FROM 'VERIFYING' OR q.attempt_deadline<=clock_timestamp()
 OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id
 OR NOT (installation->'binding'->'adapters' ? 'github-certification')
 OR request->>'certificate_version' IS DISTINCT FROM '2' OR request->>'phase' IS DISTINCT FROM 'CERTIFY'
 OR request->>'release_id' IS DISTINCT FROM release_id::text OR request->>'repository' IS DISTINCT FROM a.intent->>'repository'
 OR request->>'admission_sha' IS DISTINCT FROM q.resolution_head_sha
 OR request->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR b.data->>'success' IS DISTINCT FROM 'true' OR ready.data->>'success' IS DISTINCT FROM 'true'
 OR request->>'control_sha' IS DISTINCT FROM installation->'binding'->'github'->>'control_sha'
 OR request->>'workflow_id' IS DISTINCT FROM installation->'binding'->'github'->>'certification_workflow_id'
 OR ingress.id IS NULL OR ingress.binding->>'control_sha' IS DISTINCT FROM request->>'control_sha'
 OR ingress.binding->>'workflow_id' IS DISTINCT FROM request->>'workflow_id'
 OR ingress.binding->>'repository_id' IS DISTINCT FROM request->>'repository_id'
 OR ingress.binding->>'url' IS DISTINCT FROM request->'fixture_authority'->>'url'
 OR ingress.binding->>'audience' IS DISTINCT FROM request->'fixture_authority'->>'audience'
 OR jsonb_typeof(request->'component_tuple') IS DISTINCT FROM 'object'
 OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(request->'component_tuple') key)
    IS DISTINCT FROM ARRAY['club-arena-engine','club-arena-web']
 OR octet_length(request::text)>32768 OR request ? 'fixture_roster'
 THEN RAISE EXCEPTION 'RELEASE_COMPONENT_CERTIFICATION_PREREQUISITES'; END IF;
 FOR target,c IN SELECT key,value FROM jsonb_each(request->'component_tuple') LOOP
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(q.resolution_manifest->'components') m WHERE m->>'target'=target) INTO changed;
  IF COALESCE(c->>'source_sha','') !~ '^[0-9a-f]{40}$' OR COALESCE(c->>'identity','') !~ '^sha256:[0-9a-f]{64}$'
  OR c->>'mode' IS DISTINCT FROM (CASE WHEN changed THEN 'changed' ELSE 'retained' END)
  OR (target='club-arena-web' AND c->>'identity' IS DISTINCT FROM 'sha256:'||(c->>'manifest_digest'))
  THEN RAISE EXCEPTION 'RELEASE_COMPONENT_TUPLE_INVALID'; END IF;
  IF changed THEN
   SELECT * INTO x FROM release_ops.external_operations WHERE id::text=c->>'publication_operation_id';
   IF x.release_id IS DISTINCT FROM release_id OR x.kind IS DISTINCT FROM 'PUBLISH' OR x.status IS DISTINCT FROM 'SUCCEEDED'
   OR x.intent->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest OR x.intent->>'target' IS DISTINCT FROM target
   OR COALESCE(x.result->'proof'->'component'->>'identity',CASE WHEN target='club-arena-engine' THEN x.result->>'image_id' END) IS DISTINCT FROM c->>'identity'
   OR COALESCE(x.result->'proof'->'component'->>'source_sha',CASE WHEN target='club-arena-engine' THEN x.result->>'source_sha' END) IS DISTINCT FROM c->>'source_sha'
   OR b.data->'artifact'->'components'->target->>'identity' IS DISTINCT FROM c->>'identity'
   OR b.data->'artifact'->'components'->target->>'source_sha' IS DISTINCT FROM c->>'source_sha'
   OR NOT EXISTS(SELECT 1 FROM release_ops.provider_plans pp WHERE pp.id::text=x.intent->>'plan_id'
     AND pp.readiness_event=ready.event_id AND pp.recovery_id IS NOT DISTINCT FROM q.recovery_id)
   THEN RAISE EXCEPTION 'RELEASE_COMPONENT_PUBLICATION_REQUIRED'; END IF;
  ELSE
   SELECT * INTO prior FROM release_ops.receipts WHERE event_id::text=c->>'verified_receipt_id';
   IF prior.kind IS DISTINCT FROM 'CERTIFICATION' OR prior.data->>'success' IS DISTINCT FROM 'true'
   OR NOT EXISTS(SELECT 1 FROM release_ops.queue prev WHERE prev.release_id=prior.release_id AND prev.state IN ('VERIFIED','RECOVERED')
     AND prev.selected_receipts->>'CERTIFICATION'=prior.event_id::text)
   OR prior.data->'served_components'->target->>'identity' IS DISTINCT FROM c->>'identity'
   OR prior.data->'served_components'->target->>'source_sha' IS DISTINCT FROM c->>'source_sha'
   OR c->>'compatibility_receipt_id' IS DISTINCT FROM ready.event_id::text
   OR (ready.data->'retained_components'->target)-'compatibility_receipt_id' IS DISTINCT FROM c-'compatibility_receipt_id'
   THEN RAISE EXCEPTION 'RELEASE_RETAINED_COMPONENT_PROOF_REQUIRED'; END IF;
  END IF;
 END LOOP;
 SELECT * INTO p FROM release_ops.source_plans sp WHERE sp.release_id=release_id AND sp.attempt_id=q.attempt_id AND sp.phase='CERTIFY';
 IF FOUND THEN
  IF p.request-'fixture_roster' IS DISTINCT FROM request THEN RAISE EXCEPTION 'RELEASE_CERTIFICATION_PLAN_MISMATCH'; END IF;
  RETURN to_jsonb(p)||jsonb_build_object('duplicate',true);
 END IF;
 FOREACH slot IN ARRAY ARRAY['postdeploy','theme-primary','theme-other','buyer','bundle','observer','missions','settlement','freeze'] LOOP
  uid:=gen_random_uuid();
  roster:=roster||jsonb_build_object(slot,jsonb_build_object('user_id',uid,'email','ca-customization-cert-'||slot||'-'||uid||'@example.invalid'));
 END LOOP;
 complete_request:=request||jsonb_build_object('fixture_roster',roster);
 eid:=release_ops.event(release_id,'COMPONENT_CERTIFICATION_PLAN',actor,complete_request);
 INSERT INTO release_ops.source_plans(release_id,attempt_id,phase,adapter,request,event_id)
 VALUES(release_id,q.attempt_id,'CERTIFY','github-certification',complete_request,eid) RETURNING * INTO p;
 INSERT INTO release_ops.certification_fixture_intents(plan_id,slot,user_id,email,event_id)
 SELECT p.id,key,(value->>'user_id')::uuid,value->>'email',eid FROM jsonb_each(roster);
 RETURN to_jsonb(p);
END $$;

-- Callback principals may see this one operation's sanitized intent. They
-- cannot acquire an owner, select receipts, dispatch providers, or read secrets.
CREATE FUNCTION release_ops.certification_callback_context(operation_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations; p release_ops.source_plans; i release_ops.certification_ingress_installations;
BEGIN
 SELECT * INTO e FROM release_ops.external_operations WHERE id=operation_id;
 SELECT * INTO p FROM release_ops.source_plans WHERE id::text=e.intent->>'plan_id';
 SELECT * INTO i FROM release_ops.certification_ingress_installations WHERE id::text=p.request->'fixture_authority'->>'installation_receipt';
 IF e.kind IS DISTINCT FROM 'CERTIFY' OR e.status NOT IN ('INTENT','UNKNOWN') OR p.request->>'certificate_version' IS DISTINCT FROM '2'
 OR i.binding->>'principal' IS DISTINCT FROM session_user
 OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM e.release_id
 OR NOT EXISTS(SELECT 1 FROM release_ops.provider_submissions WHERE provider_submissions.operation_id=e.id)
 THEN RAISE EXCEPTION 'RELEASE_CERTIFICATION_CALLBACK_SCOPE_REFUSED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM release_ops.events v WHERE v.id=e.intent_event AND v.release_id=e.release_id
 AND v.kind='EXTERNAL_INTENT' AND (v.data=e.intent OR v.data->'intent'=e.intent))
 THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_INTENT_EVENT_REQUIRED'; END IF;
 RETURN jsonb_build_object('operation_id',e.id,'request',p.request,'binding',i.binding,'created_at',(SELECT created_at FROM release_ops.events WHERE id=e.intent_event),
 'cleanup_started',EXISTS(SELECT 1 FROM release_ops.certification_cleanup_barriers WHERE certification_cleanup_barriers.operation_id=e.id));
END $$;

-- One authorization precedes the recovery dispatch. A lost dispatch response
-- must be reconciled by exact correlation; it never permits a second dispatch.
CREATE FUNCTION release_ops.authorize_certification_cleanup(owner uuid,epoch uuid,operation_id uuid,
 original_run jsonb,bundle_digest text,config_digest text,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations; r release_ops.certification_cleanup_recoveries;
 claim release_ops.certification_run_claims; identity jsonb; eid uuid; installation jsonb;
BEGIN
 installation:=release_ops.provider_installation(owner,epoch,bundle_digest,config_digest);
 PERFORM release_ops.valid_actor(actor);
 SELECT * INTO e FROM release_ops.external_operations WHERE id=operation_id FOR UPDATE;
 IF e.kind IS DISTINCT FROM 'CERTIFY' OR e.status NOT IN ('INTENT','UNKNOWN')
 OR e.intent->'provider_request'->>'certificate_version' IS DISTINCT FROM '2'
 OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM e.release_id
 OR NOT EXISTS(SELECT 1 FROM release_ops.provider_submissions s WHERE s.operation_id=e.id)
 OR original_run->>'status' IS DISTINCT FROM 'completed'
 OR original_run->>'conclusion' NOT IN ('success','failure','cancelled','timed_out','action_required','neutral','skipped','stale')
 OR original_run->>'conclusion' IS NULL
 OR original_run->>'operation_id' IS DISTINCT FROM e.id::text
 OR original_run->>'repository_id' IS DISTINCT FROM e.intent->'provider_request'->>'repository_id'
 OR original_run->>'workflow_id' IS DISTINCT FROM e.intent->'provider_request'->>'workflow_id'
 OR original_run->>'control_sha' IS DISTINCT FROM e.intent->'provider_request'->>'control_sha'
 OR original_run->>'run_attempt' IS DISTINCT FROM '1' OR COALESCE(original_run->>'run_id','') !~ '^[1-9][0-9]*$'
 OR EXISTS(SELECT 1 FROM release_ops.certification_cleanup_receipts c WHERE c.operation_id=e.id)
 THEN RAISE EXCEPTION 'RELEASE_CLEANUP_RECOVERY_SCOPE_REFUSED'; END IF;
 identity:=original_run-ARRAY['operation_id','status','conclusion'];
 SELECT * INTO claim FROM release_ops.certification_run_claims c WHERE c.operation_id=e.id;
 IF FOUND AND claim.identity IS DISTINCT FROM identity THEN RAISE EXCEPTION 'RELEASE_CERTIFICATION_RUN_ALREADY_OWNED'; END IF;
 SELECT * INTO r FROM release_ops.certification_cleanup_recoveries c WHERE c.operation_id=e.id;
 IF FOUND THEN
  IF r.original_run IS DISTINCT FROM original_run THEN RAISE EXCEPTION 'RELEASE_CLEANUP_RECOVERY_MISMATCH'; END IF;
  RETURN to_jsonb(r)||jsonb_build_object('may_submit',false);
 END IF;
 IF claim.operation_id IS NULL THEN
  eid:=release_ops.event(e.release_id,'CERTIFICATION_RUN_CLAIM',actor,identity||jsonb_build_object('operation_id',e.id));
  INSERT INTO release_ops.certification_run_claims VALUES(e.id,identity->>'run_id',identity,eid);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM release_ops.certification_cleanup_barriers c WHERE c.operation_id=e.id) THEN
  eid:=release_ops.event(e.release_id,'FIXTURE_CLEANUP_BARRIER',actor,jsonb_build_object('operation_id',e.id));
  INSERT INTO release_ops.certification_cleanup_barriers VALUES(e.id,eid);
 END IF;
 eid:=release_ops.event(e.release_id,'CERTIFICATION_CLEANUP_DISPATCH_INTENT',actor,original_run);
 INSERT INTO release_ops.certification_cleanup_recoveries(operation_id,original_run,event_id) VALUES(e.id,original_run,eid) RETURNING * INTO r;
 RETURN to_jsonb(r)||jsonb_build_object('may_submit',true);
END $$;

CREATE FUNCTION release_ops.certification_cleanup_context(operation_id uuid,recovery_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE context jsonb; recovery jsonb;
BEGIN
 context:=release_ops.certification_callback_context(operation_id);
 SELECT to_jsonb(r)||jsonb_build_object('created_at',v.created_at) INTO recovery
 FROM release_ops.certification_cleanup_recoveries r JOIN release_ops.events v ON v.id=r.event_id
 WHERE r.id=recovery_id AND r.operation_id=operation_id AND v.kind='CERTIFICATION_CLEANUP_DISPATCH_INTENT';
 IF recovery IS NULL THEN RAISE EXCEPTION 'RELEASE_CLEANUP_RECOVERY_SCOPE_REFUSED'; END IF;
 RETURN context||jsonb_build_object('cleanup_recovery',recovery);
END $$;

CREATE FUNCTION release_ops.certification_fixture_callback(operation_id uuid,identity jsonb,action text,slot text,claim_key uuid,proof jsonb,recovery_id uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE context jsonb; e release_ops.external_operations; claim release_ops.certification_run_claims;
 consumed release_ops.certification_fixture_claims; account release_ops.certification_fixture_intents;
 cleanup release_ops.certification_cleanup_receipts; eid uuid; facts jsonb; recovery jsonb; recovery_claim jsonb;
BEGIN
 context:=release_ops.certification_callback_context(operation_id);
 SELECT * INTO e FROM release_ops.external_operations WHERE id=operation_id FOR UPDATE;
 -- Recheck after the lock: cleanup and a concurrent consume serialize here.
 context:=release_ops.certification_callback_context(operation_id);
 IF jsonb_typeof(identity) IS DISTINCT FROM 'object' OR octet_length(identity::text)>4096
 OR identity->>'repository_id' IS DISTINCT FROM context->'binding'->>'repository_id'
 OR identity->>'workflow_id' IS DISTINCT FROM context->'binding'->>'workflow_id'
 OR identity->>'control_sha' IS DISTINCT FROM context->'binding'->>'control_sha'
 OR identity->>'run_attempt' IS DISTINCT FROM '1' OR COALESCE(identity->>'run_id','') !~ '^[1-9][0-9]*$'
 THEN RAISE EXCEPTION 'RELEASE_CERTIFICATION_RUN_IDENTITY_REFUSED'; END IF;
 SELECT * INTO claim FROM release_ops.certification_run_claims WHERE certification_run_claims.operation_id=e.id;
 IF recovery_id IS NOT NULL THEN
  recovery:=release_ops.certification_cleanup_context(operation_id,recovery_id)->'cleanup_recovery';
  IF action NOT IN ('creation-result','begin-cleanup','cleanup-complete')
  OR identity->>'run_id'=claim.run_id OR (action='creation-result' AND proof->>'outcome' IS DISTINCT FROM 'CREATED')
  THEN RAISE EXCEPTION 'RELEASE_CLEANUP_ONLY_ACTION_REFUSED'; END IF;
  SELECT c.identity INTO recovery_claim FROM release_ops.certification_cleanup_run_claims c WHERE c.recovery_id=recovery_id;
  IF FOUND THEN
   IF recovery_claim IS DISTINCT FROM identity THEN RAISE EXCEPTION 'RELEASE_CLEANUP_RUN_ALREADY_OWNED'; END IF;
  ELSE
   eid:=release_ops.event(e.release_id,'CERTIFICATION_CLEANUP_RUN_CLAIM','certification-callback',identity||jsonb_build_object('recovery_id',recovery_id));
   INSERT INTO release_ops.certification_cleanup_run_claims VALUES(recovery_id,identity,eid);
  END IF;
 ELSIF EXISTS(SELECT 1 FROM release_ops.certification_cleanup_recoveries c WHERE c.operation_id=e.id) THEN
  RAISE EXCEPTION 'RELEASE_ORIGINAL_CERTIFICATION_RUN_RETIRED';
 ELSIF FOUND THEN
  IF claim.identity IS DISTINCT FROM identity THEN RAISE EXCEPTION 'RELEASE_CERTIFICATION_RUN_ALREADY_OWNED'; END IF;
 ELSE
  eid:=release_ops.event(e.release_id,'CERTIFICATION_RUN_CLAIM','certification-callback',identity||jsonb_build_object('operation_id',e.id));
  INSERT INTO release_ops.certification_run_claims(operation_id,run_id,identity,event_id)
  VALUES(e.id,identity->>'run_id',identity,eid);
 END IF;
 IF action='consume' THEN
  IF EXISTS(SELECT 1 FROM release_ops.certification_cleanup_barriers WHERE certification_cleanup_barriers.operation_id=e.id)
  OR EXISTS(SELECT 1 FROM release_ops.queue WHERE release_id=e.release_id AND attempt_deadline<=clock_timestamp())
  OR claim_key IS NULL THEN RAISE EXCEPTION 'RELEASE_FIXTURE_EFFECT_WINDOW_CLOSED'; END IF;
  SELECT * INTO account FROM release_ops.certification_fixture_intents WHERE plan_id::text=e.intent->>'plan_id' AND certification_fixture_intents.slot=slot;
  IF NOT FOUND THEN RAISE EXCEPTION 'RELEASE_FIXTURE_SLOT_UNKNOWN'; END IF;
  SELECT * INTO consumed FROM release_ops.certification_fixture_claims WHERE certification_fixture_claims.operation_id=e.id AND certification_fixture_claims.slot=slot;
  IF FOUND THEN
   IF consumed.claim_key IS DISTINCT FROM claim_key THEN RAISE EXCEPTION 'RELEASE_FIXTURE_SLOT_ALREADY_CONSUMED'; END IF;
   RETURN jsonb_build_object('may_create',false,'user_id',account.user_id,'email',account.email,'claim_event',consumed.event_id);
  END IF;
  eid:=release_ops.event(e.release_id,'FIXTURE_CREATE_INTENT','certification-callback',jsonb_build_object('operation_id',e.id,'slot',slot,'user_id',account.user_id,'email',account.email,'run_id',identity->>'run_id','run_attempt',1));
  INSERT INTO release_ops.certification_fixture_claims(operation_id,slot,claim_key,event_id) VALUES(e.id,slot,claim_key,eid);
  RETURN jsonb_build_object('may_create',true,'user_id',account.user_id,'email',account.email,'claim_event',eid);
 ELSIF action='creation-result' THEN
  SELECT * INTO account FROM release_ops.certification_fixture_intents WHERE plan_id::text=e.intent->>'plan_id' AND certification_fixture_intents.slot=slot;
  IF account.user_id IS NULL OR proof->>'user_id' IS DISTINCT FROM account.user_id::text OR proof->>'email' IS DISTINCT FROM account.email
  OR proof->>'outcome' NOT IN ('CREATED','NOT_SUBMITTED') OR proof->>'outcome' IS NULL
  OR NOT EXISTS(SELECT 1 FROM release_ops.certification_fixture_claims fc WHERE fc.operation_id=e.id AND fc.slot=slot)
  THEN RAISE EXCEPTION 'RELEASE_FIXTURE_CREATION_OUTCOME_REQUIRED'; END IF;
  SELECT event_id INTO eid FROM release_ops.certification_fixture_outcomes fo WHERE fo.operation_id=e.id AND fo.slot=slot;
  IF FOUND THEN
   IF EXISTS(SELECT 1 FROM release_ops.certification_fixture_outcomes fo WHERE fo.operation_id=e.id AND fo.slot=slot AND fo.outcome<>proof->>'outcome')
   THEN RAISE EXCEPTION 'RELEASE_FIXTURE_CREATION_OUTCOME_MISMATCH'; END IF;
   RETURN jsonb_build_object('creation_receipt',eid,'duplicate',true);
  END IF;
  eid:=release_ops.event(e.release_id,'FIXTURE_CREATION_'||(proof->>'outcome'),'certification-callback',jsonb_build_object('operation_id',e.id,'slot',slot,'user_id',account.user_id));
  INSERT INTO release_ops.certification_fixture_outcomes(operation_id,slot,outcome,event_id) VALUES(e.id,slot,proof->>'outcome',eid);
  RETURN jsonb_build_object('creation_receipt',eid,'duplicate',false);
 ELSIF action='begin-cleanup' THEN
  SELECT event_id INTO eid FROM release_ops.certification_cleanup_barriers WHERE certification_cleanup_barriers.operation_id=e.id;
  IF NOT FOUND THEN
   eid:=release_ops.event(e.release_id,'FIXTURE_CLEANUP_BARRIER','certification-callback',jsonb_build_object('operation_id',e.id));
   INSERT INTO release_ops.certification_cleanup_barriers(operation_id,event_id) VALUES(e.id,eid);
  END IF;
  RETURN jsonb_build_object('cleanup_event',eid,'fixture_roster',context->'request'->'fixture_roster');
 ELSIF action='cleanup-complete' THEN
  IF NOT EXISTS(SELECT 1 FROM release_ops.certification_cleanup_barriers WHERE certification_cleanup_barriers.operation_id=e.id)
  OR jsonb_typeof(proof) IS DISTINCT FROM 'object' OR octet_length(proof::text)>32768
  OR proof->>'operation_id' IS DISTINCT FROM e.id::text OR proof->>'run_id' IS DISTINCT FROM identity->>'run_id'
  OR proof->>'run_attempt' IS DISTINCT FROM '1' OR jsonb_typeof(proof->'accounts') IS DISTINCT FROM 'object'
  OR (SELECT count(*) FROM jsonb_object_keys(proof->'accounts'))<>9
  OR EXISTS(SELECT 1 FROM release_ops.certification_fixture_claims fc WHERE fc.operation_id=e.id AND NOT EXISTS(
    SELECT 1 FROM release_ops.certification_fixture_outcomes fo WHERE fo.operation_id=fc.operation_id AND fo.slot=fc.slot))
  THEN RAISE EXCEPTION 'RELEASE_EXACT_FIXTURE_CLEANUP_REQUIRED'; END IF;
  FOR account IN SELECT * FROM release_ops.certification_fixture_intents WHERE plan_id::text=e.intent->>'plan_id' LOOP
   facts:=proof->'accounts'->account.slot;
   IF facts->>'user_id' IS DISTINCT FROM account.user_id::text OR facts->>'email' IS DISTINCT FROM account.email
   OR facts->>'auth_absent' IS DISTINCT FROM 'true' OR facts->>'resources_absent' IS DISTINCT FROM 'true'
   OR COALESCE(facts->>'evidence_sha256','') !~ '^[0-9a-f]{64}$'
   THEN RAISE EXCEPTION 'RELEASE_EXACT_FIXTURE_CLEANUP_REQUIRED'; END IF;
  END LOOP;
  SELECT * INTO cleanup FROM release_ops.certification_cleanup_receipts WHERE certification_cleanup_receipts.operation_id=e.id;
  IF FOUND THEN
   IF cleanup.data IS DISTINCT FROM proof THEN RAISE EXCEPTION 'RELEASE_CLEANUP_RECEIPT_MISMATCH'; END IF;
   RETURN jsonb_build_object('cleanup_receipt',cleanup.event_id,'duplicate',true);
  END IF;
  eid:=release_ops.event(e.release_id,'FIXTURE_CLEANUP_COMPLETE','certification-callback',proof);
  INSERT INTO release_ops.certification_cleanup_receipts(operation_id,data,event_id) VALUES(e.id,proof,eid);
  RETURN jsonb_build_object('cleanup_receipt',eid,'duplicate',false);
 END IF;
 RAISE EXCEPTION 'RELEASE_CERTIFICATION_CALLBACK_ACTION_REFUSED';
END $$;

-- The ordinary resolver cannot turn a cancelled/red runner into a clean
-- terminal operation while any reserved fixture is unresolved.
CREATE FUNCTION release_ops.guard_component_certificate_resolution() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cleanup release_ops.certification_cleanup_receipts; claim release_ops.certification_run_claims;
BEGIN
 IF OLD.kind<>'CERTIFY' OR OLD.intent->'provider_request'->>'certificate_version' IS DISTINCT FROM '2'
 OR NEW.status IN ('INTENT','UNKNOWN') THEN RETURN NEW; END IF;
 IF NEW.status='NOT_ACCEPTED' AND NOT EXISTS(SELECT 1 FROM release_ops.provider_submissions WHERE operation_id=OLD.id)
 THEN RETURN NEW; END IF;
 SELECT * INTO cleanup FROM release_ops.certification_cleanup_receipts WHERE operation_id=OLD.id;
 SELECT * INTO claim FROM release_ops.certification_run_claims WHERE operation_id=OLD.id;
 IF cleanup.operation_id IS NULL OR claim.operation_id IS NULL
 OR NEW.result->'proof'->>'cleanup_receipt' IS DISTINCT FROM cleanup.event_id::text
 OR NEW.result->>'provider_operation_id' IS DISTINCT FROM claim.run_id
 OR NEW.result->'proof'->>'operation_id' IS DISTINCT FROM OLD.id::text
 OR NEW.result->'proof'->>'run_id' IS DISTINCT FROM claim.run_id
 OR NEW.result->'proof'->>'run_attempt' IS DISTINCT FROM '1'
 OR NEW.result->'proof'->>'control_sha' IS DISTINCT FROM OLD.intent->'provider_request'->>'control_sha'
 OR NEW.result->'proof'->'request' IS DISTINCT FROM OLD.intent->'provider_request'
 THEN RAISE EXCEPTION 'RELEASE_DURABLE_FIXTURE_CLEANUP_REQUIRED'; END IF;
 IF NEW.status='SUCCEEDED' AND (NEW.result->'proof'->>'success' IS DISTINCT FROM 'true'
 OR EXISTS(SELECT 1 FROM release_ops.certification_cleanup_recoveries r WHERE r.operation_id=OLD.id)
 OR NEW.result->'proof'->>'run_attempt' IS DISTINCT FROM '1'
 OR NEW.result->'proof'->'served_components' IS DISTINCT FROM OLD.intent->'provider_request'->'component_tuple'
 OR NEW.result->'proof'->>'unchanged_release' IS DISTINCT FROM 'true'
 OR NEW.result->'proof'->>'cleanup_complete' IS DISTINCT FROM 'true'
 OR jsonb_typeof(NEW.result->'proof'->'reports') IS DISTINCT FROM 'array'
 OR (SELECT array_agg(r->>'name' ORDER BY r->>'name') FROM jsonb_array_elements(NEW.result->'proof'->'reports') r)
 IS DISTINCT FROM ARRAY['cashier','club-members','customization-commerce','customization-realtime','daily-missions',
  'daily-missions-accessibility','daily-missions-settlement','live-table-realtime','lobby','stats','sweep']
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.result->'proof'->'reports') r WHERE
  r->>'complete' IS DISTINCT FROM 'true' OR r->>'failed' IS DISTINCT FROM '0' OR r->>'retried' IS DISTINCT FROM '0'
  OR COALESCE(r->>'executed','') !~ '^[1-9][0-9]*$' OR COALESCE(r->>'sha256','') !~ '^[0-9a-f]{64}$'))
 THEN RAISE EXCEPTION 'RELEASE_FULL_COMPONENT_CERTIFICATE_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_component_certificate_resolution BEFORE UPDATE ON release_ops.external_operations
 FOR EACH ROW EXECUTE FUNCTION release_ops.guard_component_certificate_resolution();

CREATE FUNCTION release_ops.guard_component_certificate_selection() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.state IN ('VERIFIED','RECOVERED') AND EXISTS(SELECT 1 FROM release_ops.source_plans p
  WHERE p.release_id=NEW.release_id AND p.attempt_id=NEW.attempt_id AND p.phase='CERTIFY' AND p.request->>'certificate_version'='2')
 AND NOT EXISTS(SELECT 1 FROM release_ops.external_operations e JOIN release_ops.receipts r ON r.event_id::text=NEW.selected_receipts->>'CERTIFICATION'
  WHERE e.release_id=NEW.release_id AND e.kind='CERTIFY' AND e.status='SUCCEEDED'
  AND e.intent->'provider_request'->>'certificate_version'='2' AND e.result->'proof'->>'operation_id'=e.id::text
  AND r.data->>'operation_id'=e.id::text AND r.data->'served_components'=e.result->'proof'->'served_components'
  AND r.data @> (e.result->'proof')
  AND r.data->>'cleanup_receipt'=e.result->'proof'->>'cleanup_receipt')
 THEN RAISE EXCEPTION 'RELEASE_JOURNALED_COMPONENT_CERTIFICATE_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_component_certificate_selection BEFORE UPDATE ON release_ops.queue
 FOR EACH ROW EXECUTE FUNCTION release_ops.guard_component_certificate_selection();

REVOKE ALL ON ALL TABLES IN SCHEMA release_ops FROM release_certification_callback;
GRANT USAGE ON SCHEMA release_ops TO release_certification_callback;
REVOKE ALL ON FUNCTION release_ops.certification_schema_version(),release_ops.register_certification_ingress(jsonb,jsonb,text),
 release_ops.provider_operation_context(uuid,uuid,uuid),
 release_ops.submit_component_certification_plan(uuid,uuid,uuid,jsonb,text,text,text),
 release_ops.certification_callback_context(uuid),release_ops.certification_fixture_callback(uuid,jsonb,text,text,uuid,jsonb,uuid),
 release_ops.authorize_certification_cleanup(uuid,uuid,uuid,jsonb,text,text,text),release_ops.certification_cleanup_context(uuid,uuid),
 release_ops.guard_component_certificate_resolution(),release_ops.guard_component_certificate_selection() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_ops.certification_schema_version(),release_ops.submit_component_certification_plan(uuid,uuid,uuid,jsonb,text,text,text)
 TO release_journal_controller;
GRANT EXECUTE ON FUNCTION release_ops.provider_operation_context(uuid,uuid,uuid) TO release_journal_controller;
GRANT EXECUTE ON FUNCTION release_ops.authorize_certification_cleanup(uuid,uuid,uuid,jsonb,text,text,text) TO release_journal_controller;
GRANT EXECUTE ON FUNCTION release_ops.certification_schema_version(),release_ops.certification_callback_context(uuid),
 release_ops.certification_fixture_callback(uuid,jsonb,text,text,uuid,jsonb,uuid),release_ops.certification_cleanup_context(uuid,uuid) TO release_certification_callback;
COMMIT;
