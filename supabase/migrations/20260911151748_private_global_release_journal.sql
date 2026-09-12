-- Private, event-driven global release journal. Bootstrap only: execution OFF.
-- No gameplay tables, production writers, credential values or applied history change.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
SET LOCAL synchronous_commit = on;

CREATE SCHEMA release_ops;
REVOKE ALL ON SCHEMA release_ops FROM PUBLIC;
DO $roles$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['release_journal_reader','release_journal_submitter',
    'release_journal_operator','release_journal_controller','release_journal_verifier'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',r);
    ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
      RAISE EXCEPTION 'RELEASE_ROLE_BOUNDARY_INVALID';
    END IF;
  END LOOP;
END $roles$;

CREATE TABLE release_ops.targets (
  target text PRIMARY KEY, repository text NOT NULL, project text NOT NULL,
  enabled boolean NOT NULL DEFAULT true
);
INSERT INTO release_ops.targets VALUES
 ('club-arena-engine','Smarter-Poker/Smarter-Poker-Club-Arena','engine-01',true),
 ('club-arena-web','Smarter-Poker/Smarter-Poker-Club-Arena','ca-static.smarter.poker',true),
 ('world-hub-web','Smarter-Poker/Smarter-Poker-World-Hub','prj_op66GkZyZcygXQKm76iyycfVFAQx',true),
 ('workers','Smarter-Poker/smarter-poker-workers','smarter-poker-workers',true);
CREATE TABLE release_ops.controller (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
  instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
  epoch uuid NOT NULL DEFAULT gen_random_uuid(), generation bigint NOT NULL DEFAULT 0,
  owner_id uuid, owner_backend integer, active_release uuid,
  last_admission bigint NOT NULL DEFAULT 0, last_event bigint NOT NULL DEFAULT 0,
  reconciliation_required boolean NOT NULL DEFAULT true,
  execution_enabled boolean NOT NULL DEFAULT false,
  installed_adapter_receipt text,
  CHECK (NOT execution_enabled OR installed_adapter_receipt IS NOT NULL)
);
INSERT INTO release_ops.controller(singleton) VALUES(true);
CREATE TABLE release_ops.admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admission_seq bigint NOT NULL UNIQUE,
  canonical_digest text NOT NULL UNIQUE CHECK(canonical_digest ~ '^[0-9a-f]{64}$'),
  manifest_digest text NOT NULL CHECK(manifest_digest ~ '^[0-9a-f]{64}$'),
  intent jsonb NOT NULL, principal text NOT NULL, actor text NOT NULL,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE release_ops.controller ADD FOREIGN KEY(active_release) REFERENCES release_ops.admissions(id);
CREATE TABLE release_ops.queue (
  release_id uuid PRIMARY KEY REFERENCES release_ops.admissions(id),
  queue_order bigint NOT NULL, state text NOT NULL DEFAULT 'QUEUED',
  state_version bigint NOT NULL DEFAULT 1, owner_id uuid, epoch uuid,
  attempt_count integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
  attempt_id uuid, attempt_deadline timestamptz,
  next_retry_at timestamptz, resume_state text, last_error jsonb,
  integrated boolean NOT NULL DEFAULT false,
  terminal_disposition jsonb, selected_receipts jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution_head_sha text NOT NULL, resolution_manifest jsonb NOT NULL, resolution_manifest_digest text NOT NULL,
  recovery_id uuid, recovery_attempt_count integer NOT NULL DEFAULT 0,
  CHECK (state IN ('QUEUED','VALIDATING','MERGING','BUILDING','STAGED','READY','APPLYING',
    'VERIFYING','VERIFIED','DOCUMENTATION_ONLY','RETRY_WAIT','BLOCKED_DEPENDENCIES',
    'BLOCKED','INTEGRATION_FAILED','UNKNOWN_EXTERNAL_OUTCOME','ROLLING_BACK','RECOVERY_REQUIRED','CANCELLED','RECOVERED'))
);
CREATE INDEX release_queue_order ON release_ops.queue(queue_order);
CREATE TABLE release_ops.dependencies (
  release_id uuid NOT NULL REFERENCES release_ops.admissions(id),
  dependency_id uuid NOT NULL REFERENCES release_ops.admissions(id),
  PRIMARY KEY(release_id,dependency_id), CHECK(release_id<>dependency_id)
);
CREATE TABLE release_ops.submissions (
  principal text NOT NULL, client_key text NOT NULL, request_digest text NOT NULL,
  release_id uuid NOT NULL REFERENCES release_ops.admissions(id),
  PRIMARY KEY(principal,client_key)
);
CREATE TABLE release_ops.events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_no bigint NOT NULL UNIQUE,
  release_id uuid REFERENCES release_ops.admissions(id), kind text NOT NULL,
  actor text NOT NULL, principal text NOT NULL, epoch uuid NOT NULL,
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX release_events_lookup ON release_ops.events(release_id,event_no);
CREATE TABLE release_ops.receipts (
  release_id uuid NOT NULL REFERENCES release_ops.admissions(id), receipt_key text NOT NULL,
  kind text NOT NULL, data jsonb NOT NULL, event_id uuid NOT NULL REFERENCES release_ops.events(id), recovery_id uuid,
  PRIMARY KEY(release_id,receipt_key)
);
CREATE TABLE release_ops.external_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), release_id uuid NOT NULL REFERENCES release_ops.admissions(id),
  operation_key text NOT NULL, owner_id uuid NOT NULL, epoch uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('MERGE','BUILD','PUBLISH','CERTIFY','RECOVERY','MIGRATE')),
  intent jsonb NOT NULL, intent_event uuid NOT NULL REFERENCES release_ops.events(id),
  resume_state text NOT NULL, status text NOT NULL DEFAULT 'INTENT',
  result jsonb, terminal_event uuid REFERENCES release_ops.events(id),
  UNIQUE(release_id,operation_key),
  CHECK(status IN ('INTENT','UNKNOWN','SUCCEEDED','FAILED','CANCELLED','NOT_ACCEPTED'))
);
CREATE TABLE release_ops.recovery_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), release_id uuid NOT NULL REFERENCES release_ops.admissions(id),
  recovery_key text NOT NULL, digest text NOT NULL, intent jsonb NOT NULL,
  prior_attempt_id uuid NOT NULL, parent_recovery_id uuid REFERENCES release_ops.recovery_revisions(id),
  attempt_id uuid NOT NULL, deadline timestamptz NOT NULL, budget_seconds integer NOT NULL,
  owner_id uuid NOT NULL, epoch uuid NOT NULL, event_id uuid NOT NULL REFERENCES release_ops.events(id),
  UNIQUE(release_id,recovery_key)
);
ALTER TABLE release_ops.queue ADD FOREIGN KEY(recovery_id) REFERENCES release_ops.recovery_revisions(id);
ALTER TABLE release_ops.receipts ADD FOREIGN KEY(recovery_id) REFERENCES release_ops.recovery_revisions(id);
CREATE UNIQUE INDEX release_one_unresolved_external ON release_ops.external_operations(release_id)
 WHERE status IN ('INTENT','UNKNOWN');

CREATE FUNCTION release_ops.immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
#variable_conflict use_variable
BEGIN RAISE EXCEPTION 'RELEASE_HISTORY_IMMUTABLE'; END $$;
CREATE TRIGGER immutable_admission BEFORE UPDATE OR DELETE ON release_ops.admissions FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE TRIGGER immutable_event BEFORE UPDATE OR DELETE ON release_ops.events FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE TRIGGER immutable_submission BEFORE UPDATE OR DELETE ON release_ops.submissions FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE TRIGGER immutable_dependency BEFORE UPDATE OR DELETE ON release_ops.dependencies FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE TRIGGER immutable_recovery BEFORE UPDATE OR DELETE ON release_ops.recovery_revisions FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE ON release_ops.receipts FOR EACH ROW EXECUTE FUNCTION release_ops.immutable();
CREATE FUNCTION release_ops.external_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
#variable_conflict use_variable
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['status','result','terminal_event']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['status','result','terminal_event']) OR OLD.status NOT IN ('INTENT','UNKNOWN') THEN
   RAISE EXCEPTION 'RELEASE_EXTERNAL_HISTORY_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_external BEFORE UPDATE OR DELETE ON release_ops.external_operations FOR EACH ROW EXECUTE FUNCTION release_ops.external_immutable();

CREATE FUNCTION release_ops.digest(value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex')
$$;
CREATE FUNCTION release_ops.valid_actor(actor text, reason text DEFAULT 'operation') RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
#variable_conflict use_variable
BEGIN
 IF actor IS NULL OR length(btrim(actor)) NOT BETWEEN 1 AND 128 OR actor ~ '[[:cntrl:]]'
 OR reason IS NULL OR length(btrim(reason)) NOT BETWEEN 3 AND 2000 OR reason ~ '[[:cntrl:]]' THEN
  RAISE EXCEPTION 'RELEASE_ACTOR_REASON_INVALID';
 END IF;
END $$;
CREATE FUNCTION release_ops.event(release_id uuid,kind text,actor text,data jsonb) RETURNS uuid
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE event_id uuid; n bigint; e uuid;
BEGIN
 PERFORM set_config('synchronous_commit','on',true);
 UPDATE release_ops.controller SET last_event=last_event+1 WHERE singleton RETURNING last_event,epoch INTO n,e;
 INSERT INTO release_ops.events(event_no,release_id,kind,actor,principal,epoch,data)
 VALUES(n,release_id,kind,actor,session_user,e,data) RETURNING id INTO event_id;
 PERFORM pg_notify('release_journal_events',n::text);
 RETURN event_id;
END $$;
CREATE FUNCTION release_ops.terminal(state text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT state IN ('VERIFIED','DOCUMENTATION_ONLY','CANCELLED','RECOVERED')
$$;
CREATE FUNCTION release_ops.schema_version() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT schema_version FROM release_ops.controller WHERE singleton
$$;
CREATE FUNCTION release_ops.inspect(release_id uuid DEFAULT NULL,after_admission bigint DEFAULT 0,
 page_size integer DEFAULT 100,after_event bigint DEFAULT 0) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 WITH qpage AS (
  SELECT q.*,a.admission_seq,to_jsonb(a) AS admission FROM release_ops.queue q JOIN release_ops.admissions a ON a.id=q.release_id
  WHERE (inspect.release_id IS NULL OR q.release_id=inspect.release_id) AND a.admission_seq>after_admission
  ORDER BY a.admission_seq LIMIT LEAST(GREATEST(COALESCE(page_size,100),1),200)
 ), epage AS (
  SELECT * FROM release_ops.events e WHERE (inspect.release_id IS NULL OR e.release_id=inspect.release_id)
  AND e.event_no>after_event ORDER BY e.event_no LIMIT LEAST(GREATEST(COALESCE(page_size,100),1),200)
 ), xpage AS (
  SELECT x.* FROM release_ops.external_operations x JOIN release_ops.events e ON e.id=x.intent_event
  WHERE ((inspect.release_id IS NULL AND x.status IN ('INTENT','UNKNOWN')) OR x.release_id=inspect.release_id)
  AND e.event_no>after_event ORDER BY e.event_no LIMIT LEAST(GREATEST(COALESCE(page_size,100),1),200)
 )
 SELECT jsonb_build_object('controller',(SELECT to_jsonb(c)-'owner_backend' FROM release_ops.controller c),
 'queue',COALESCE((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.queue_order) FROM qpage q),'[]'::jsonb),
 'external',COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM xpage x),'[]'::jsonb),
 'events',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.event_no) FROM epage e),'[]'::jsonb),
 'page',jsonb_build_object('size',LEAST(GREATEST(COALESCE(page_size,100),1),200),
 'next_admission',COALESCE((SELECT max(admission_seq) FROM qpage),after_admission),
 'next_event',COALESCE((SELECT max(event_no) FROM epage),after_event)))
$$;
CREATE INDEX release_unresolved_queue_order ON release_ops.queue(queue_order)
 WHERE state NOT IN ('VERIFIED','DOCUMENTATION_ONLY','CANCELLED','RECOVERED');
CREATE INDEX release_retry_deadline ON release_ops.queue(next_retry_at) WHERE state='RETRY_WAIT';
CREATE FUNCTION release_ops.observe_snapshot() RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT jsonb_build_object('controller',(SELECT to_jsonb(c)-'owner_backend' FROM release_ops.controller c),
 'head',(SELECT jsonb_build_object('release_id',q.release_id,'state',q.state,'admission_seq',a.admission_seq)
 FROM release_ops.queue q JOIN release_ops.admissions a ON a.id=q.release_id
 WHERE q.state NOT IN ('VERIFIED','DOCUMENTATION_ONLY','CANCELLED','RECOVERED') ORDER BY q.queue_order LIMIT 1),
 'unresolved_count',(SELECT count(*)::integer FROM release_ops.queue WHERE state NOT IN ('VERIFIED','DOCUMENTATION_ONLY','CANCELLED','RECOVERED')),
 'retry_due_count',(SELECT count(*)::integer FROM release_ops.queue WHERE state='RETRY_WAIT' AND next_retry_at<=clock_timestamp()),
 'next_retry_at',(SELECT min(next_retry_at) FROM release_ops.queue WHERE state='RETRY_WAIT' AND next_retry_at>clock_timestamp()),
 'unresolved_external_count',(SELECT count(*)::integer FROM release_ops.external_operations WHERE status IN ('INTENT','UNKNOWN')))
$$;
CREATE FUNCTION release_ops.enqueue(client_key text, intent jsonb, actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE normalized jsonb; dependency_ids uuid[]; dep uuid; digest text; request_digest text; existing release_ops.admissions;
 submission release_ops.submissions; seq bigint; position bigint; new_id uuid; manifest_hash text; component jsonb;
BEGIN
 PERFORM release_ops.valid_actor(actor);
 IF client_key IS NULL OR length(client_key) NOT BETWEEN 1 AND 200 OR client_key ~ '[[:cntrl:]]'
 OR jsonb_typeof(intent)<>'object' OR octet_length(intent::text)>65536 THEN RAISE EXCEPTION 'RELEASE_ADMISSION_INVALID'; END IF;
 IF intent - ARRAY['repository','project','target','head_sha','base_sha','pull_request','purpose','related_release_id','manifest','dependencies'] <> '{}'::jsonb
 OR COALESCE(intent->>'head_sha','') !~ '^[0-9a-f]{40}$'
 OR (intent ? 'base_sha' AND COALESCE(intent->>'base_sha','') !~ '^[0-9a-f]{40}$')
 OR (intent ? 'pull_request' AND COALESCE(intent->>'pull_request','') !~ '^[1-9][0-9]*$')
 OR COALESCE(intent->>'purpose','') NOT IN ('release','redeploy','recovery','documentation')
 OR jsonb_typeof(intent->'manifest') IS DISTINCT FROM 'object'
 OR jsonb_typeof(intent->'manifest'->'components') IS DISTINCT FROM 'array'
 OR jsonb_array_length(intent->'manifest'->'components')=0
 OR (intent ? 'dependencies' AND jsonb_typeof(intent->'dependencies')<>'array') THEN RAISE EXCEPTION 'RELEASE_INTENT_INVALID'; END IF;
 -- This singleton lock is held through the caller's COMMIT. A sequence is not admission order.
 PERFORM 1 FROM release_ops.controller WHERE singleton FOR UPDATE;
 IF NOT EXISTS (SELECT 1 FROM release_ops.targets t WHERE t.target=intent->>'target'
   AND t.repository=intent->>'repository' AND t.project=intent->>'project' AND t.enabled) THEN RAISE EXCEPTION 'RELEASE_TARGET_NOT_ALLOWED'; END IF;
 FOR component IN SELECT value FROM jsonb_array_elements(intent->'manifest'->'components') LOOP
  IF jsonb_typeof(component)<>'object' OR NOT EXISTS(SELECT 1 FROM release_ops.targets t
    WHERE t.target=component->>'target' AND t.enabled) THEN RAISE EXCEPTION 'RELEASE_COMPONENT_NOT_ALLOWED'; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(intent->'manifest'->'components') v WHERE v->>'target'=intent->>'target') THEN
  RAISE EXCEPTION 'RELEASE_PRIMARY_COMPONENT_MISSING'; END IF;
 SELECT COALESCE(array_agg(DISTINCT value::uuid ORDER BY value::uuid),'{}'::uuid[]) INTO dependency_ids
 FROM jsonb_array_elements_text(COALESCE(intent->'dependencies','[]'::jsonb));
 normalized := intent || jsonb_build_object('dependencies',to_jsonb(dependency_ids));
 request_digest := release_ops.digest(normalized);
 digest := release_ops.digest(normalized-ARRAY['base_sha','pull_request','dependencies']);
 manifest_hash:=release_ops.digest(intent->'manifest');
 SELECT * INTO submission FROM release_ops.submissions s WHERE s.principal=session_user AND s.client_key=enqueue.client_key;
 IF FOUND THEN
  IF submission.request_digest<>request_digest THEN RAISE EXCEPTION 'RELEASE_IDEMPOTENCY_MISMATCH'; END IF;
  SELECT * INTO existing FROM release_ops.admissions WHERE id=submission.release_id;
  RETURN to_jsonb(existing)||jsonb_build_object('duplicate',true);
 END IF;
 SELECT * INTO existing FROM release_ops.admissions a WHERE a.canonical_digest=digest;
 IF FOUND THEN
  IF (existing.intent-ARRAY['base_sha','pull_request'])<>(normalized-ARRAY['base_sha','pull_request']) THEN
   RAISE EXCEPTION 'RELEASE_CANONICAL_PREREQUISITE_CONFLICT'; END IF;
  INSERT INTO release_ops.submissions VALUES(session_user,client_key,request_digest,existing.id);
  PERFORM release_ops.event(existing.id,'DUPLICATE_SUBMISSION',actor,jsonb_build_object('client_key',client_key));
  RETURN to_jsonb(existing)||jsonb_build_object('duplicate',true);
 END IF;
 FOREACH dep IN ARRAY dependency_ids LOOP
  IF NOT EXISTS (SELECT 1 FROM release_ops.admissions a JOIN release_ops.queue q ON q.release_id=a.id
    WHERE a.id=dep AND q.state NOT IN ('CANCELLED','RECOVERED')) THEN RAISE EXCEPTION 'RELEASE_DEPENDENCY_UNKNOWN_OR_WITHDRAWN'; END IF;
 END LOOP;
 IF intent->>'purpose' IN ('redeploy','recovery') THEN
  IF NOT EXISTS(SELECT 1 FROM release_ops.admissions a JOIN release_ops.queue q ON q.release_id=a.id
    WHERE a.id=(intent->>'related_release_id')::uuid AND release_ops.terminal(q.state)) THEN
    RAISE EXCEPTION 'RELEASE_LINKED_PURPOSE_REQUIRES_TERMINAL_PREDECESSOR'; END IF;
 ELSIF intent ? 'related_release_id' THEN RAISE EXCEPTION 'RELEASE_PURPOSE_LINK_INVALID'; END IF;
 UPDATE release_ops.controller SET last_admission=last_admission+1 WHERE singleton RETURNING last_admission INTO seq;
 SELECT COALESCE(max(queue_order),0)+1 INTO position FROM release_ops.queue;
 INSERT INTO release_ops.admissions(admission_seq,canonical_digest,manifest_digest,intent,principal,actor)
 VALUES(seq,digest,manifest_hash,normalized,session_user,actor) RETURNING id INTO new_id;
 INSERT INTO release_ops.queue(release_id,queue_order,resolution_head_sha,resolution_manifest,resolution_manifest_digest)
 VALUES(new_id,position,intent->>'head_sha',intent->'manifest',manifest_hash);
 INSERT INTO release_ops.dependencies SELECT new_id,unnest(dependency_ids);
 INSERT INTO release_ops.submissions VALUES(session_user,client_key,request_digest,new_id);
 PERFORM release_ops.event(new_id,'ADMITTED',actor,jsonb_build_object('admission_seq',seq,'canonical_digest',digest));
 SELECT * INTO existing FROM release_ops.admissions WHERE id=new_id;
 RETURN to_jsonb(existing)||jsonb_build_object('duplicate',false);
END $$;

CREATE FUNCTION release_ops.has_session_lock() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
 AND classid=77319011::oid AND objid=1::oid AND objsubid=2 AND granted)
$$;
CREATE FUNCTION release_ops.acquire_owner(owner uuid,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE c release_ops.controller;
BEGIN
 PERFORM release_ops.valid_actor(actor);
 IF owner IS NULL THEN RAISE EXCEPTION 'RELEASE_OWNER_INVALID'; END IF;
 IF NOT release_ops.has_session_lock() AND NOT pg_try_advisory_lock(77319011,1) THEN RAISE EXCEPTION 'RELEASE_OWNER_BUSY'; END IF;
 SELECT * INTO c FROM release_ops.controller WHERE singleton FOR UPDATE;
 IF c.owner_id=owner AND c.owner_backend=pg_backend_pid() THEN RETURN to_jsonb(c)-'owner_backend'; END IF;
 UPDATE release_ops.controller SET owner_id=owner,owner_backend=pg_backend_pid(),epoch=gen_random_uuid(),
 generation=generation+1,reconciliation_required=true WHERE singleton RETURNING * INTO c;
 -- A new executor never assumes an accepted or unsent-looking intent was harmless.
 UPDATE release_ops.external_operations SET status='UNKNOWN' WHERE status='INTENT';
 UPDATE release_ops.queue q SET state=CASE WHEN EXISTS(SELECT 1 FROM release_ops.external_operations e
 WHERE e.release_id=q.release_id AND e.status='UNKNOWN') THEN 'UNKNOWN_EXTERNAL_OUTCOME' ELSE q.state END,
 state_version=state_version+1,owner_id=owner,epoch=c.epoch WHERE q.release_id=c.active_release;
 PERFORM release_ops.event(c.active_release,'OWNER_EPOCH_STARTED',actor,jsonb_build_object('owner_id',owner,'generation',c.generation));
 RETURN (SELECT to_jsonb(x)-'owner_backend' FROM release_ops.controller x);
END $$;
CREATE FUNCTION release_ops.check_owner(owner uuid,epoch uuid,execute boolean DEFAULT true) RETURNS void
 LANGUAGE plpgsql SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE c release_ops.controller;
BEGIN
 SELECT * INTO c FROM release_ops.controller WHERE singleton FOR UPDATE;
 IF NOT release_ops.has_session_lock() OR c.owner_id IS DISTINCT FROM owner OR c.epoch IS DISTINCT FROM epoch
 OR c.owner_backend IS DISTINCT FROM pg_backend_pid() THEN RAISE EXCEPTION 'RELEASE_STALE_OWNER'; END IF;
 IF execute AND (c.reconciliation_required OR NOT c.execution_enabled OR c.installed_adapter_receipt IS NULL) THEN
  RAISE EXCEPTION 'RELEASE_EXECUTION_NOT_ACTIVATED'; END IF;
END $$;
CREATE FUNCTION release_ops.reconcile(expected_epoch uuid,observed_event bigint,evidence jsonb,actor text,reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE c release_ops.controller; actual uuid[]; stated uuid[]; event_id uuid;
BEGIN
 PERFORM release_ops.valid_actor(actor,reason);
 SELECT * INTO c FROM release_ops.controller WHERE singleton FOR UPDATE;
 IF c.epoch IS DISTINCT FROM expected_epoch OR c.last_event IS DISTINCT FROM observed_event THEN RAISE EXCEPTION 'RELEASE_RECONCILIATION_STALE'; END IF;
 IF evidence->>'instance_id' IS DISTINCT FROM c.instance_id::text
 OR jsonb_typeof(evidence->'repository_heads') IS DISTINCT FROM 'object'
 OR jsonb_typeof(evidence->'components') IS DISTINCT FROM 'object'
 OR jsonb_typeof(evidence->'unresolved_external_ids') IS DISTINCT FROM 'array'
 OR jsonb_typeof(evidence->'receipt_refs') IS DISTINCT FROM 'array'
 OR jsonb_array_length(evidence->'receipt_refs')=0 OR evidence->>'verified' IS DISTINCT FROM 'true' THEN
 RAISE EXCEPTION 'RELEASE_RECONCILIATION_EVIDENCE_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM release_ops.targets t WHERE t.enabled AND
  (COALESCE(evidence->'repository_heads'->>t.repository,'') !~ '^[0-9a-f]{40}$'
  OR NOT evidence->'components' ? t.target)) THEN RAISE EXCEPTION 'RELEASE_RECONCILIATION_TARGETS_MISSING'; END IF;
 SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO actual FROM release_ops.external_operations WHERE status IN ('INTENT','UNKNOWN');
 SELECT COALESCE(array_agg(DISTINCT value::uuid ORDER BY value::uuid),'{}'::uuid[]) INTO stated
 FROM jsonb_array_elements_text(evidence->'unresolved_external_ids');
 IF actual<>stated THEN RAISE EXCEPTION 'RELEASE_RECONCILIATION_EXTERNAL_MISMATCH'; END IF;
 event_id:=release_ops.event(c.active_release,'RECONCILIATION',actor,jsonb_build_object('reason',reason,'evidence',evidence));
 UPDATE release_ops.controller SET reconciliation_required=false WHERE singleton;
 RETURN jsonb_build_object('receipt_id',event_id,'epoch',c.epoch,'execution_enabled',c.execution_enabled,
   'unresolved_external_count',cardinality(actual));
END $$;
CREATE FUNCTION release_ops.claim_next(owner uuid,epoch uuid,deadline timestamptz,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE c release_ops.controller; q release_ops.queue;
BEGIN
 PERFORM release_ops.valid_actor(actor); PERFORM release_ops.check_owner(owner,epoch);
 SELECT * INTO c FROM release_ops.controller WHERE singleton;
 IF c.active_release IS NOT NULL THEN RETURN (SELECT to_jsonb(x) FROM release_ops.queue x WHERE release_id=c.active_release); END IF;
 IF deadline IS NULL OR NOT isfinite(deadline) OR deadline<=clock_timestamp() THEN RAISE EXCEPTION 'RELEASE_DEADLINE_INVALID'; END IF;
 SELECT * INTO q FROM release_ops.queue WHERE NOT release_ops.terminal(state) ORDER BY queue_order LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF q.state<>'QUEUED' THEN RAISE EXCEPTION 'RELEASE_HEAD_BLOCKED'; END IF;
 IF EXISTS(SELECT 1 FROM release_ops.dependencies d JOIN release_ops.queue p ON p.release_id=d.dependency_id
 WHERE d.release_id=q.release_id AND p.state NOT IN ('VERIFIED','DOCUMENTATION_ONLY')) THEN RAISE EXCEPTION 'RELEASE_DEPENDENCIES_UNVERIFIED'; END IF;
 UPDATE release_ops.controller SET active_release=q.release_id WHERE singleton;
 UPDATE release_ops.queue SET state='VALIDATING',state_version=state_version+1,owner_id=owner,epoch=claim_next.epoch,
 attempt_count=attempt_count+1,attempt_id=gen_random_uuid(),attempt_deadline=deadline WHERE release_id=q.release_id RETURNING * INTO q;
 PERFORM release_ops.event(q.release_id,'CLAIMED',actor,jsonb_build_object('attempt_id',q.attempt_id,'deadline',deadline));
 RETURN to_jsonb(q);
END $$;
CREATE FUNCTION release_ops.record_receipt(owner uuid,epoch uuid,release_id uuid,receipt_key text,kind text,data jsonb,actor text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE prior release_ops.receipts; event_id uuid; expected_digest text;
BEGIN
 PERFORM release_ops.valid_actor(actor); PERFORM release_ops.check_owner(owner,epoch);
 IF (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id THEN RAISE EXCEPTION 'RELEASE_NOT_ACTIVE'; END IF;
 IF kind NOT IN ('VALIDATION','INTEGRATION','BUILD','STAGED','READINESS','CERTIFICATION','RECOVERY','DOCUMENTATION')
 OR receipt_key IS NULL OR length(receipt_key) NOT BETWEEN 1 AND 200 OR jsonb_typeof(data)<>'object'
 OR octet_length(data::text)>65536 OR jsonb_typeof(data->'receipt_refs') IS DISTINCT FROM 'array'
 OR jsonb_array_length(data->'receipt_refs')=0 THEN RAISE EXCEPTION 'RELEASE_RECEIPT_INVALID'; END IF;
 SELECT resolution_manifest_digest INTO expected_digest FROM release_ops.queue WHERE queue.release_id=record_receipt.release_id;
 IF data->>'manifest_digest' IS DISTINCT FROM expected_digest THEN RAISE EXCEPTION 'RELEASE_RECEIPT_MANIFEST_MISMATCH'; END IF;
 SELECT * INTO prior FROM release_ops.receipts r WHERE r.release_id=record_receipt.release_id AND r.receipt_key=record_receipt.receipt_key;
 IF FOUND THEN
  IF prior.kind<>kind OR prior.data<>data THEN RAISE EXCEPTION 'RELEASE_RECEIPT_IDEMPOTENCY_MISMATCH'; END IF;
  RETURN prior.event_id;
 END IF;
 event_id:=release_ops.event(release_id,'RECEIPT_'||kind,actor,data);
 INSERT INTO release_ops.receipts VALUES(release_id,receipt_key,kind,data,event_id,
  (SELECT q.recovery_id FROM release_ops.queue q WHERE q.release_id=record_receipt.release_id));
 RETURN event_id;
END $$;
CREATE FUNCTION release_ops.select_receipt(owner uuid,epoch uuid,release_id uuid,expected_version bigint,event_id uuid,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; r release_ops.receipts; predecessor text; link_key text; keep text[]; selected jsonb;
BEGIN
 PERFORM release_ops.valid_actor(actor); PERFORM release_ops.check_owner(owner,epoch);
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=select_receipt.release_id FOR UPDATE;
 SELECT * INTO r FROM release_ops.receipts x WHERE x.release_id=select_receipt.release_id AND x.event_id=select_receipt.event_id;
 IF q.release_id IS NULL OR q.state_version IS DISTINCT FROM expected_version OR
 (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id THEN RAISE EXCEPTION 'RELEASE_STATE_CONFLICT'; END IF;
 IF r.event_id IS NULL OR r.data->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR r.recovery_id IS DISTINCT FROM q.recovery_id
 OR r.data->>'success' IS DISTINCT FROM 'true' OR NOT ((q.state||':'||r.kind)=ANY(ARRAY[
 'VALIDATING:VALIDATION','MERGING:INTEGRATION','MERGING:DOCUMENTATION','BUILDING:BUILD',
 'STAGED:STAGED','READY:READINESS','VERIFYING:CERTIFICATION'])) THEN RAISE EXCEPTION 'RELEASE_RECEIPT_SELECTION_INVALID'; END IF;
 CASE r.kind
 WHEN 'VALIDATION' THEN keep:='{}'::text[];
 WHEN 'INTEGRATION' THEN predecessor:='VALIDATION'; link_key:='validation_receipt'; keep:=ARRAY['VALIDATION'];
 WHEN 'BUILD' THEN predecessor:='INTEGRATION'; link_key:='integration_receipt'; keep:=ARRAY['VALIDATION','INTEGRATION'];
 WHEN 'STAGED' THEN predecessor:='BUILD'; link_key:='build_receipt'; keep:=ARRAY['VALIDATION','INTEGRATION','BUILD'];
 WHEN 'READINESS' THEN predecessor:='STAGED'; link_key:='stage_receipt'; keep:=ARRAY['VALIDATION','INTEGRATION','BUILD','STAGED'];
 WHEN 'CERTIFICATION' THEN predecessor:='BUILD'; link_key:='build_receipt'; keep:=ARRAY['VALIDATION','INTEGRATION','BUILD','STAGED','READINESS'];
 WHEN 'DOCUMENTATION' THEN predecessor:='INTEGRATION'; link_key:='integration_receipt'; keep:=ARRAY['VALIDATION','INTEGRATION'];
 END CASE;
 IF predecessor IS NOT NULL AND (q.selected_receipts->>predecessor IS NULL OR
 r.data->>link_key IS DISTINCT FROM q.selected_receipts->>predecessor) THEN RAISE EXCEPTION 'RELEASE_RECEIPT_SELECTED_CHAIN_MISMATCH'; END IF;
 SELECT COALESCE(jsonb_object_agg(key,value),'{}'::jsonb) INTO selected FROM jsonb_each(q.selected_receipts) WHERE key=ANY(keep);
 selected:=selected||jsonb_build_object(r.kind,event_id);
 UPDATE release_ops.queue SET selected_receipts=selected,state_version=state_version+1
 WHERE queue.release_id=select_receipt.release_id RETURNING * INTO q;
 PERFORM release_ops.event(release_id,'RECEIPT_SELECTED',actor,jsonb_build_object('receipt_id',event_id,'kind',r.kind,'selected_chain',selected));
 RETURN to_jsonb(q);
END $$;

CREATE FUNCTION release_ops.transition(owner uuid,epoch uuid,release_id uuid,expected_version bigint,next_state text,actor text,reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; allowed boolean;
BEGIN
 PERFORM release_ops.valid_actor(actor,reason); PERFORM release_ops.check_owner(owner,epoch);
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=transition.release_id FOR UPDATE;
 IF (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id OR q.release_id IS NULL OR expected_version IS NULL OR q.state_version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'RELEASE_STATE_CONFLICT'; END IF;
 IF EXISTS(SELECT 1 FROM release_ops.external_operations e WHERE e.release_id=transition.release_id AND status IN ('INTENT','UNKNOWN')) THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_OUTCOME_UNRESOLVED'; END IF;
 IF q.attempt_deadline<=clock_timestamp() AND next_state NOT IN ('BLOCKED','RECOVERY_REQUIRED') THEN RAISE EXCEPTION 'RELEASE_ATTEMPT_EXPIRED'; END IF;
 allowed := (q.state||'>'||next_state) = ANY(ARRAY[
 'VALIDATING>MERGING','MERGING>DOCUMENTATION_ONLY','MERGING>BUILDING','BUILDING>STAGED','STAGED>READY',
 'READY>APPLYING','READY>ROLLING_BACK','APPLYING>VERIFYING','VERIFYING>VERIFIED','VERIFYING>RECOVERED','MERGING>INTEGRATION_FAILED',
 'ROLLING_BACK>VERIFYING']);
 IF q.state='BLOCKED' AND q.attempt_count>=q.max_attempts AND next_state<>'RECOVERY_REQUIRED' THEN RAISE EXCEPTION 'RELEASE_RETRY_EXHAUSTED'; END IF;
 IF NOT allowed AND NOT (next_state IN ('BLOCKED','RECOVERY_REQUIRED') AND NOT release_ops.terminal(q.state)) THEN RAISE EXCEPTION 'RELEASE_TRANSITION_INVALID'; END IF;
 IF next_state='MERGING' AND NOT EXISTS(SELECT 1 FROM release_ops.receipts r JOIN release_ops.admissions a ON a.id=r.release_id
 WHERE r.release_id=transition.release_id AND r.kind='VALIDATION' AND r.event_id=(q.selected_receipts->>'VALIDATION')::uuid AND r.data->>'success'='true'
 AND r.data->>'accepted_head_sha'=q.resolution_head_sha AND COALESCE(r.data->>'expected_base_sha','') ~ '^[0-9a-f]{40}$'
 AND (q.recovery_id IS NULL OR r.data->>'expected_base_sha'=(SELECT rr.intent->>'expected_base_sha' FROM release_ops.recovery_revisions rr WHERE rr.id=q.recovery_id))
 AND COALESCE(r.data->>'tested_tree_sha','') ~ '^[0-9a-f]{40}$') THEN RAISE EXCEPTION 'RELEASE_VALIDATION_RECEIPT_REQUIRED'; END IF;
 IF next_state IN ('BUILDING','DOCUMENTATION_ONLY') AND NOT EXISTS(SELECT 1 FROM release_ops.receipts r JOIN release_ops.admissions a ON a.id=r.release_id
 JOIN release_ops.receipts v ON v.event_id=(r.data->>'validation_receipt')::uuid AND v.release_id=r.release_id AND v.kind='VALIDATION'
 WHERE r.release_id=transition.release_id AND r.kind='INTEGRATION' AND r.event_id=(q.selected_receipts->>'INTEGRATION')::uuid AND r.data->>'success'='true'
 AND r.data->>'accepted_head_sha'=q.resolution_head_sha AND COALESCE(r.data->>'merged_sha','') ~ '^[0-9a-f]{40}$'
 AND r.data->>'expected_base_sha'=v.data->>'expected_base_sha' AND r.data->>'merged_tree_sha'=v.data->>'tested_tree_sha'
 AND v.data->>'success'='true') THEN RAISE EXCEPTION 'RELEASE_INTEGRATION_RECEIPT_REQUIRED'; END IF;
 IF next_state='STAGED' AND NOT EXISTS(SELECT 1 FROM release_ops.receipts r
 JOIN release_ops.receipts i ON i.event_id=(r.data->>'integration_receipt')::uuid AND i.release_id=r.release_id AND i.kind='INTEGRATION'
 WHERE r.release_id=transition.release_id AND r.kind='BUILD' AND r.event_id=(q.selected_receipts->>'BUILD')::uuid AND r.data->>'success'='true'
 AND r.data->>'source_sha'=i.data->>'merged_sha' AND jsonb_typeof(r.data->'artifact')='object'
 AND jsonb_typeof(r.data->'artifact'->'components')='object'
 AND NOT EXISTS(SELECT 1 FROM release_ops.admissions a CROSS JOIN LATERAL jsonb_array_elements(q.resolution_manifest->'components') component
 WHERE a.id=transition.release_id AND COALESCE(r.data->'artifact'->'components'->(component->>'target')->>'identity','')='')
 AND i.data->>'success'='true') THEN RAISE EXCEPTION 'RELEASE_BUILD_RECEIPT_REQUIRED'; END IF;
 IF next_state='READY' AND NOT EXISTS(SELECT 1 FROM release_ops.receipts r
 JOIN release_ops.receipts b ON b.event_id=(r.data->>'build_receipt')::uuid AND b.release_id=r.release_id AND b.kind='BUILD'
 WHERE r.release_id=transition.release_id AND r.kind='STAGED' AND r.event_id=(q.selected_receipts->>'STAGED')::uuid AND r.data->>'success'='true'
 AND r.data->>'compatibility_verified'='true' AND b.data->>'success'='true') THEN RAISE EXCEPTION 'RELEASE_STAGE_RECEIPT_REQUIRED'; END IF;
 IF next_state IN ('APPLYING','ROLLING_BACK') AND NOT EXISTS(SELECT 1 FROM release_ops.receipts r
 JOIN release_ops.receipts st ON st.event_id=(r.data->>'stage_receipt')::uuid AND st.release_id=r.release_id AND st.kind='STAGED'
 WHERE r.release_id=transition.release_id AND r.kind='READINESS' AND r.event_id=(q.selected_receipts->>'READINESS')::uuid AND r.data->>'success'='true'
 AND r.data->>'technical_gates_passed'='true' AND jsonb_typeof(r.data->'expected_current')='object'
 AND st.data->>'success'='true') THEN RAISE EXCEPTION 'RELEASE_READINESS_RECEIPT_REQUIRED'; END IF;
 IF next_state IN ('VERIFIED','RECOVERED') AND NOT EXISTS(SELECT 1 FROM release_ops.receipts r
 JOIN release_ops.receipts b ON b.event_id=(r.data->>'build_receipt')::uuid AND b.release_id=r.release_id AND b.kind='BUILD'
 WHERE r.release_id=transition.release_id AND r.kind='CERTIFICATION' AND r.event_id=(q.selected_receipts->>'CERTIFICATION')::uuid AND r.data->>'success'='true'
 AND r.data->>'cleanup_complete'='true' AND r.data->>'unchanged_release'='true'
 AND jsonb_typeof(r.data->'served_components')='object' AND COALESCE(r.data->>'certification_run_id','')<>''
 AND b.event_id=(q.selected_receipts->>'BUILD')::uuid AND b.data->>'success'='true'
 AND NOT EXISTS(SELECT 1 FROM release_ops.admissions a CROSS JOIN LATERAL jsonb_array_elements(q.resolution_manifest->'components') component
 WHERE a.id=transition.release_id AND (COALESCE(r.data->'served_components'->(component->>'target')->>'identity','')=''
 OR r.data->'served_components'->(component->>'target')->>'identity' IS DISTINCT FROM
 b.data->'artifact'->'components'->(component->>'target')->>'identity'))) THEN RAISE EXCEPTION 'RELEASE_CERTIFICATION_REQUIRED'; END IF;
 IF next_state='ROLLING_BACK' AND (q.recovery_id IS NULL OR NOT EXISTS(SELECT 1 FROM release_ops.recovery_revisions rr
 WHERE rr.id=q.recovery_id AND rr.intent->>'purpose'='forward-revert')) THEN RAISE EXCEPTION 'RELEASE_RECOVERY_REVISION_REQUIRED'; END IF;
 IF next_state IN ('VERIFIED','RECOVERED') AND q.recovery_id IS NOT NULL THEN
  IF (next_state='RECOVERED') IS DISTINCT FROM (SELECT rr.intent->>'purpose'='forward-revert' FROM release_ops.recovery_revisions rr WHERE rr.id=q.recovery_id)
   THEN RAISE EXCEPTION 'RELEASE_RECOVERY_DISPOSITION_MISMATCH'; END IF;
  IF NOT EXISTS(SELECT 1 FROM release_ops.receipts r WHERE r.event_id=(q.selected_receipts->>'CERTIFICATION')::uuid
   AND r.data->>'recovery_revision_id'=q.recovery_id::text AND r.data->>'source_reconciled'='true'
   AND r.data->>'source_revision'=q.resolution_head_sha) THEN RAISE EXCEPTION 'RELEASE_RECOVERY_SOURCE_PROOF_REQUIRED'; END IF;
 ELSIF next_state='RECOVERED' THEN RAISE EXCEPTION 'RELEASE_RECOVERY_REVISION_REQUIRED'; END IF;
 IF next_state='DOCUMENTATION_ONLY' AND (
 q.recovery_id IS NOT NULL OR
 (SELECT intent->>'purpose' FROM release_ops.admissions WHERE id=release_id)<>'documentation' OR
 NOT EXISTS(SELECT 1 FROM release_ops.receipts r WHERE r.release_id=transition.release_id AND r.kind='DOCUMENTATION'
 AND r.event_id=(q.selected_receipts->>'DOCUMENTATION')::uuid
 AND r.data->>'success'='true' AND r.data->>'no_runtime_change'='true'
 AND EXISTS(SELECT 1 FROM release_ops.receipts i WHERE i.event_id=(r.data->>'integration_receipt')::uuid
 AND i.event_id=(q.selected_receipts->>'INTEGRATION')::uuid
 AND i.release_id=r.release_id AND i.kind='INTEGRATION' AND i.data->>'success'='true'))) THEN RAISE EXCEPTION 'RELEASE_DOCUMENTATION_PROOF_REQUIRED'; END IF;
 UPDATE release_ops.queue SET state=next_state,state_version=state_version+1,integrated=integrated OR next_state IN ('BUILDING','DOCUMENTATION_ONLY'),
 terminal_disposition=CASE WHEN release_ops.terminal(next_state) THEN jsonb_build_object('actor',actor,'reason',reason,'recovery_revision_id',q.recovery_id,'resolution_head_sha',q.resolution_head_sha) ELSE NULL END
 WHERE queue.release_id=transition.release_id RETURNING * INTO q;
 PERFORM release_ops.event(release_id,'STATE_'||next_state,actor,jsonb_build_object('reason',reason,'state_version',q.state_version));
 IF release_ops.terminal(next_state) THEN UPDATE release_ops.controller SET active_release=NULL WHERE singleton; END IF;
 RETURN to_jsonb(q);
END $$;

CREATE FUNCTION release_ops.begin_external(owner uuid,epoch uuid,release_id uuid,operation_key text,kind text,intent jsonb,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; e release_ops.external_operations; event_id uuid; expected_digest text;
BEGIN
 PERFORM release_ops.valid_actor(actor); PERFORM release_ops.check_owner(owner,epoch);
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=begin_external.release_id FOR UPDATE;
 IF (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id THEN RAISE EXCEPTION 'RELEASE_NOT_ACTIVE'; END IF;
 SELECT * INTO e FROM release_ops.external_operations x WHERE x.release_id=begin_external.release_id AND x.operation_key=begin_external.operation_key;
 IF FOUND THEN
  IF e.kind<>kind OR e.intent<>intent THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_IDEMPOTENCY_MISMATCH'; END IF;
  -- Returning the existing ID is reattachment only, never authorization to send again.
  RETURN to_jsonb(e)||jsonb_build_object('may_submit',false);
 END IF;
 IF q.attempt_deadline<=clock_timestamp() THEN RAISE EXCEPTION 'RELEASE_ATTEMPT_EXPIRED'; END IF;
 IF NOT ((q.state||':'||kind)=ANY(ARRAY['MERGING:MERGE','BUILDING:BUILD','APPLYING:PUBLISH',
 'APPLYING:MIGRATE','VERIFYING:CERTIFY','ROLLING_BACK:RECOVERY'])) THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_PHASE_INVALID'; END IF;
 expected_digest:=q.resolution_manifest_digest;
 IF operation_key IS NULL OR length(operation_key) NOT BETWEEN 1 AND 200 OR jsonb_typeof(intent)<>'object'
 OR intent->>'manifest_digest' IS DISTINCT FROM expected_digest OR jsonb_typeof(intent->'expected_current') IS DISTINCT FROM 'object'
 OR intent->>'target' IS NULL OR NOT EXISTS(SELECT 1 FROM release_ops.targets t WHERE t.target=intent->>'target' AND t.enabled)
 OR NOT EXISTS(SELECT 1 FROM release_ops.admissions a CROSS JOIN LATERAL jsonb_array_elements(q.resolution_manifest->'components') component
 WHERE a.id=begin_external.release_id AND component->>'target'=intent->>'target') THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_INTENT_INVALID'; END IF;
 IF EXISTS(SELECT 1 FROM release_ops.external_operations x WHERE x.status IN ('INTENT','UNKNOWN')) THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_OUTCOME_UNRESOLVED'; END IF;
 event_id:=release_ops.event(release_id,'EXTERNAL_INTENT',actor,jsonb_build_object('operation_key',operation_key,'kind',kind,'intent',intent));
 INSERT INTO release_ops.external_operations(release_id,operation_key,owner_id,epoch,kind,intent,intent_event,resume_state)
 VALUES(release_id,operation_key,owner,begin_external.epoch,kind,intent,event_id,q.state) RETURNING * INTO e;
 RETURN to_jsonb(e)||jsonb_build_object('may_submit',true);
END $$;
CREATE FUNCTION release_ops.mark_unknown(owner uuid,epoch uuid,operation_id uuid,actor text,reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations;
BEGIN
 PERFORM release_ops.valid_actor(actor,reason); PERFORM release_ops.check_owner(owner,epoch,false);
 SELECT * INTO e FROM release_ops.external_operations WHERE id=operation_id FOR UPDATE;
 IF NOT FOUND OR e.status NOT IN ('INTENT','UNKNOWN') THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_NOT_PENDING'; END IF;
 UPDATE release_ops.external_operations SET status='UNKNOWN' WHERE id=operation_id RETURNING * INTO e;
 UPDATE release_ops.queue SET state='UNKNOWN_EXTERNAL_OUTCOME',state_version=state_version+1 WHERE release_id=e.release_id;
 PERFORM release_ops.event(e.release_id,'UNKNOWN_EXTERNAL_OUTCOME',actor,jsonb_build_object('operation_id',operation_id,'reason',reason));
 RETURN to_jsonb(e);
END $$;
CREATE FUNCTION release_ops.resolve_external(owner uuid,epoch uuid,operation_id uuid,outcome text,evidence jsonb,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE e release_ops.external_operations; event_id uuid; expected_digest text;
BEGIN
 PERFORM release_ops.valid_actor(actor); PERFORM release_ops.check_owner(owner,epoch,false);
 SELECT * INTO e FROM release_ops.external_operations WHERE id=operation_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_UNKNOWN'; END IF;
 IF e.status NOT IN ('INTENT','UNKNOWN') THEN
  IF e.status<>outcome OR e.result<>evidence THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_TERMINAL_MISMATCH'; END IF;
  RETURN to_jsonb(e);
 END IF;
 IF outcome NOT IN ('SUCCEEDED','FAILED','CANCELLED','NOT_ACCEPTED') OR evidence->>'terminal' IS DISTINCT FROM 'true'
 OR evidence->>'operation_id' IS DISTINCT FROM operation_id::text OR evidence->>'outcome' IS DISTINCT FROM outcome
 OR jsonb_typeof(evidence->'receipt_refs') IS DISTINCT FROM 'array' OR jsonb_array_length(evidence->'receipt_refs')=0
 OR (outcome='NOT_ACCEPTED' AND evidence->>'accepted' IS DISTINCT FROM 'false') THEN RAISE EXCEPTION 'RELEASE_PROVIDER_TERMINAL_PROOF_REQUIRED'; END IF;
 expected_digest:=e.intent->>'manifest_digest';
 IF evidence->>'manifest_digest' IS DISTINCT FROM expected_digest THEN RAISE EXCEPTION 'RELEASE_RECEIPT_MANIFEST_MISMATCH'; END IF;
 event_id:=release_ops.event(e.release_id,'EXTERNAL_'||outcome,actor,jsonb_build_object('operation_id',operation_id,'evidence',evidence));
 UPDATE release_ops.external_operations SET status=outcome,result=evidence,terminal_event=event_id WHERE id=operation_id RETURNING * INTO e;
 UPDATE release_ops.queue SET state=CASE WHEN outcome='SUCCEEDED' OR outcome='NOT_ACCEPTED' THEN e.resume_state
 ELSE 'RECOVERY_REQUIRED' END,state_version=state_version+1,owner_id=owner,epoch=resolve_external.epoch WHERE release_id=e.release_id;
 RETURN to_jsonb(e);
END $$;
CREATE FUNCTION release_ops.begin_recovery(owner uuid,epoch uuid,release_id uuid,expected_version bigint,
 recovery_key text,intent jsonb,actor text,reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; prior release_ops.recovery_revisions; revision release_ops.recovery_revisions;
 digest text; fresh_deadline timestamptz; budget integer; event_id uuid; attempt uuid:=gen_random_uuid(); component jsonb;
BEGIN
 PERFORM release_ops.valid_actor(actor,reason); PERFORM release_ops.check_owner(owner,epoch);
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=begin_recovery.release_id FOR UPDATE;
 IF q.release_id IS NULL OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id THEN
  RAISE EXCEPTION 'RELEASE_NOT_ACTIVE'; END IF;
 digest:=release_ops.digest(intent);
 SELECT * INTO prior FROM release_ops.recovery_revisions rr WHERE rr.release_id=begin_recovery.release_id AND rr.recovery_key=begin_recovery.recovery_key;
 IF FOUND THEN
  IF prior.digest IS DISTINCT FROM digest OR prior.intent IS DISTINCT FROM intent THEN RAISE EXCEPTION 'RELEASE_RECOVERY_IDEMPOTENCY_MISMATCH'; END IF;
  RETURN to_jsonb(prior)||jsonb_build_object('duplicate',true,'may_start',false);
 END IF;
 IF EXISTS(SELECT 1 FROM release_ops.external_operations e WHERE e.status IN ('INTENT','UNKNOWN')) THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_OUTCOME_UNRESOLVED'; END IF;
 IF expected_version IS NULL OR q.state_version<>expected_version THEN RAISE EXCEPTION 'RELEASE_STATE_CONFLICT'; END IF;
 IF release_ops.terminal(q.state) OR (q.state NOT IN ('RECOVERY_REQUIRED','BLOCKED','INTEGRATION_FAILED')
 AND q.attempt_deadline>clock_timestamp()) THEN RAISE EXCEPTION 'RELEASE_RECOVERY_NOT_REQUIRED'; END IF;
 IF q.recovery_attempt_count>=3 THEN RAISE EXCEPTION 'RELEASE_RECOVERY_BUDGET_EXHAUSTED'; END IF;
 IF recovery_key IS NULL OR length(recovery_key) NOT BETWEEN 1 AND 200 OR jsonb_typeof(intent) IS DISTINCT FROM 'object'
 OR octet_length(intent::text)>65536 OR COALESCE(intent->>'purpose','') NOT IN ('forward-repair','forward-revert')
 OR COALESCE(intent->>'source_revision','') !~ '^[0-9a-f]{40}$'
 OR COALESCE(intent->>'expected_base_sha','') !~ '^[0-9a-f]{40}$'
 OR intent->>'failed_release_id' IS DISTINCT FROM release_id::text
 OR intent->>'prior_attempt_id' IS DISTINCT FROM q.attempt_id::text
 OR intent->>'parent_recovery_id' IS DISTINCT FROM q.recovery_id::text
 OR jsonb_typeof(intent->'scope') IS DISTINCT FROM 'array' OR jsonb_array_length(intent->'scope')=0
 OR jsonb_typeof(intent->'manifest') IS DISTINCT FROM 'object'
 OR jsonb_typeof(intent->'manifest'->'components') IS DISTINCT FROM 'array'
 OR jsonb_array_length(intent->'manifest'->'components')=0
 OR jsonb_typeof(intent->'expected_current') IS DISTINCT FROM 'object'
 OR jsonb_typeof(intent->'compatibility_evidence') IS DISTINCT FROM 'array' OR jsonb_array_length(intent->'compatibility_evidence')=0
 OR jsonb_typeof(intent->'receipt_refs') IS DISTINCT FROM 'array' OR jsonb_array_length(intent->'receipt_refs')=0
 OR COALESCE(intent->>'budget_seconds','') !~ '^[1-9][0-9]{0,4}$'
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(intent->'scope') v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 500)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(intent->'compatibility_evidence') v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 500)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(intent->'receipt_refs') v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}') NOT BETWEEN 1 AND 500)
 THEN RAISE EXCEPTION 'RELEASE_RECOVERY_INTENT_INVALID'; END IF;
 budget:=(intent->>'budget_seconds')::integer;
 fresh_deadline:=(intent->>'deadline')::timestamptz;
 IF budget NOT BETWEEN 1 AND 21600 OR fresh_deadline IS NULL OR NOT isfinite(fresh_deadline)
 OR fresh_deadline<=clock_timestamp() OR fresh_deadline>clock_timestamp()+make_interval(secs=>budget) THEN RAISE EXCEPTION 'RELEASE_RECOVERY_DEADLINE_INVALID'; END IF;
 -- A recovery revision cannot quietly acquire another target or drop an
 -- existing component. Provider/source compatibility remains trusted evidence.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(intent->'manifest'->'components') c WHERE NOT EXISTS(
 SELECT 1 FROM release_ops.admissions a CROSS JOIN LATERAL jsonb_array_elements(a.intent->'manifest'->'components') original
 WHERE a.id=release_id AND original->>'target'=c->>'target')) OR EXISTS(
 SELECT 1 FROM release_ops.admissions a CROSS JOIN LATERAL jsonb_array_elements(a.intent->'manifest'->'components') original
 WHERE a.id=release_id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(intent->'manifest'->'components') c WHERE c->>'target'=original->>'target')) THEN
 RAISE EXCEPTION 'RELEASE_RECOVERY_TARGET_SCOPE_MISMATCH'; END IF;
 IF (SELECT count(*)<>count(DISTINCT c->>'target') FROM jsonb_array_elements(intent->'manifest'->'components') c) THEN
 RAISE EXCEPTION 'RELEASE_RECOVERY_TARGET_SCOPE_MISMATCH'; END IF;
 event_id:=release_ops.event(release_id,'RECOVERY_REVISION',actor,jsonb_build_object('reason',reason,'intent',intent,'attempt_id',attempt));
 INSERT INTO release_ops.recovery_revisions(release_id,recovery_key,digest,intent,prior_attempt_id,parent_recovery_id,
 attempt_id,deadline,budget_seconds,owner_id,epoch,event_id) VALUES(release_id,recovery_key,digest,intent,q.attempt_id,q.recovery_id,
 attempt,fresh_deadline,budget,owner,begin_recovery.epoch,event_id) RETURNING * INTO revision;
 UPDATE release_ops.queue SET recovery_id=revision.id,recovery_attempt_count=recovery_attempt_count+1,
 attempt_id=attempt,attempt_deadline=fresh_deadline,state='VALIDATING',state_version=state_version+1,
 next_retry_at=NULL,resume_state=NULL,selected_receipts='{}'::jsonb,owner_id=owner,epoch=begin_recovery.epoch,
 resolution_head_sha=intent->>'source_revision',resolution_manifest=intent->'manifest',
 resolution_manifest_digest=release_ops.digest(intent->'manifest') WHERE queue.release_id=begin_recovery.release_id;
 RETURN to_jsonb(revision)||jsonb_build_object('duplicate',false,'may_start',true);
END $$;

CREATE FUNCTION release_ops.retry(release_id uuid,expected_version bigint,delay_seconds integer,error_class text,actor text,reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue;
BEGIN
 PERFORM release_ops.valid_actor(actor,reason); PERFORM 1 FROM release_ops.controller WHERE singleton FOR UPDATE;
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=retry.release_id FOR UPDATE;
 IF q.release_id IS NULL OR expected_version IS NULL OR q.state_version IS DISTINCT FROM expected_version OR (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id THEN RAISE EXCEPTION 'RELEASE_STATE_CONFLICT'; END IF;
 IF q.recovery_id IS NOT NULL THEN RAISE EXCEPTION 'RELEASE_RECOVERY_RETRY_REQUIRES_NEW_REVISION'; END IF;
 IF error_class IS NULL OR error_class NOT IN ('TRANSPORT','PROVIDER_TEMPORARY') OR delay_seconds IS NULL OR delay_seconds NOT BETWEEN 1 AND 3600
 OR q.state IN ('QUEUED','RETRY_WAIT','UNKNOWN_EXTERNAL_OUTCOME','INTEGRATION_FAILED','BLOCKED','BLOCKED_DEPENDENCIES','RECOVERY_REQUIRED')
 OR release_ops.terminal(q.state) THEN RAISE EXCEPTION 'RELEASE_RETRY_NOT_ALLOWED'; END IF;
 IF EXISTS(SELECT 1 FROM release_ops.external_operations e WHERE e.release_id=retry.release_id AND e.status IN ('INTENT','UNKNOWN')) THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_OUTCOME_UNRESOLVED'; END IF;
 UPDATE release_ops.queue SET resume_state=q.state,state=CASE WHEN attempt_count>=max_attempts THEN 'BLOCKED' ELSE 'RETRY_WAIT' END,
 next_retry_at=CASE WHEN attempt_count<max_attempts THEN clock_timestamp()+make_interval(secs=>delay_seconds) END,
 last_error=jsonb_build_object('class',error_class,'reason',reason),state_version=state_version+1
 WHERE queue.release_id=retry.release_id RETURNING * INTO q;
 PERFORM release_ops.event(release_id,'RETRY_'||q.state,actor,jsonb_build_object('reason',reason,'next_retry_at',q.next_retry_at,'attempt_count',q.attempt_count));
 RETURN to_jsonb(q);
END $$;
CREATE FUNCTION release_ops.resume_retry(owner uuid,epoch uuid,release_id uuid,deadline timestamptz,actor text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue;
BEGIN
 PERFORM release_ops.valid_actor(actor); PERFORM release_ops.check_owner(owner,epoch);
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=resume_retry.release_id FOR UPDATE;
 IF (SELECT active_release FROM release_ops.controller WHERE singleton) IS DISTINCT FROM release_id OR q.state<>'RETRY_WAIT'
 OR q.next_retry_at IS NULL OR q.next_retry_at>clock_timestamp() OR q.attempt_count>=q.max_attempts OR deadline IS NULL OR NOT isfinite(deadline) OR deadline<=clock_timestamp() THEN RAISE EXCEPTION 'RELEASE_RETRY_NOT_DUE'; END IF;
 IF EXISTS(SELECT 1 FROM release_ops.external_operations e WHERE e.status IN ('INTENT','UNKNOWN')) THEN RAISE EXCEPTION 'RELEASE_EXTERNAL_OUTCOME_UNRESOLVED'; END IF;
 UPDATE release_ops.queue SET state=resume_state,state_version=state_version+1,attempt_count=attempt_count+1,
 attempt_id=gen_random_uuid(),attempt_deadline=deadline,next_retry_at=NULL,owner_id=owner,epoch=resume_retry.epoch
 WHERE queue.release_id=resume_retry.release_id RETURNING * INTO q;
 PERFORM release_ops.event(release_id,'RETRY_STARTED',actor,jsonb_build_object('attempt_id',q.attempt_id,'attempt_count',q.attempt_count,'deadline',deadline));
 RETURN to_jsonb(q);
END $$;
CREATE FUNCTION release_ops.withdraw(release_id uuid,expected_version bigint,actor text,reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue;
BEGIN
 PERFORM release_ops.valid_actor(actor,reason); PERFORM 1 FROM release_ops.controller WHERE singleton FOR UPDATE;
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=withdraw.release_id FOR UPDATE;
 IF q.release_id IS NULL OR expected_version IS NULL OR q.state_version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'RELEASE_STATE_CONFLICT'; END IF;
 IF q.state NOT IN ('QUEUED','BLOCKED_DEPENDENCIES') OR q.integrated OR
 (SELECT active_release FROM release_ops.controller WHERE singleton)=release_id THEN RAISE EXCEPTION 'RELEASE_WITHDRAW_ACTIVE_OR_INTEGRATED'; END IF;
 IF EXISTS(SELECT 1 FROM release_ops.dependencies d JOIN release_ops.queue child ON child.release_id=d.release_id
 WHERE d.dependency_id=withdraw.release_id AND NOT release_ops.terminal(child.state)) THEN RAISE EXCEPTION 'RELEASE_WITHDRAW_HAS_DEPENDENTS'; END IF;
 UPDATE release_ops.queue SET state='CANCELLED',state_version=state_version+1,
 terminal_disposition=jsonb_build_object('actor',actor,'reason',reason,'integrated',false) WHERE queue.release_id=withdraw.release_id RETURNING * INTO q;
 PERFORM release_ops.event(release_id,'WITHDRAWN',actor,q.terminal_disposition); RETURN to_jsonb(q);
END $$;
CREATE FUNCTION release_ops.reprioritize(release_id uuid,before_release uuid,expected_version bigint,actor text,reason text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; before_q release_ops.queue; ordered uuid[]; proposed uuid[]; item uuid; i integer:=0;
BEGIN
 PERFORM release_ops.valid_actor(actor,reason); PERFORM 1 FROM release_ops.controller WHERE singleton FOR UPDATE;
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=reprioritize.release_id FOR UPDATE;
 SELECT * INTO before_q FROM release_ops.queue WHERE queue.release_id=before_release FOR UPDATE;
 IF q.release_id IS NULL OR expected_version IS NULL OR q.state_version IS DISTINCT FROM expected_version OR q.state<>'QUEUED' OR before_q.state IS DISTINCT FROM 'QUEUED'
 OR before_release=release_id THEN RAISE EXCEPTION 'RELEASE_REPRIORITIZE_QUEUED_ONLY'; END IF;
 SELECT array_agg(x.release_id ORDER BY queue_order) INTO ordered FROM release_ops.queue x WHERE NOT release_ops.terminal(state);
 proposed:='{}'::uuid[];
 FOREACH item IN ARRAY ordered LOOP
  IF item=before_release THEN proposed:=array_append(proposed,release_id); END IF;
  IF item<>release_id THEN proposed:=array_append(proposed,item); END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM release_ops.dependencies d WHERE d.release_id=ANY(proposed) AND d.dependency_id=ANY(proposed)
 AND array_position(proposed,d.dependency_id)>=array_position(proposed,d.release_id)) THEN RAISE EXCEPTION 'RELEASE_PRIORITY_DEPENDENCY_ORDER'; END IF;
 IF (SELECT active_release FROM release_ops.controller WHERE singleton) IS NOT NULL AND
 proposed[1] IS DISTINCT FROM (SELECT active_release FROM release_ops.controller WHERE singleton) THEN RAISE EXCEPTION 'RELEASE_PRIORITY_ACTIVE_BARRIER'; END IF;
 SELECT COALESCE((SELECT x.queue_order FROM release_ops.queue x JOIN release_ops.controller c ON c.active_release=x.release_id WHERE c.singleton),0) INTO i;
 FOREACH item IN ARRAY proposed LOOP
  IF item IS NOT DISTINCT FROM (SELECT active_release FROM release_ops.controller WHERE singleton) THEN CONTINUE; END IF;
  i:=i+1; UPDATE release_ops.queue SET queue_order=i,state_version=state_version+1 WHERE queue.release_id=item AND queue_order<>i;
 END LOOP;
 PERFORM release_ops.event(release_id,'EMERGENCY_PRIORITY',actor,jsonb_build_object('reason',reason,'before',to_jsonb(ordered),'after',to_jsonb(proposed)));
 RETURN (SELECT to_jsonb(x) FROM release_ops.queue x WHERE x.release_id=reprioritize.release_id);
END $$;

-- All tables and helper functions remain private. NOLOGIN groups bind existing
-- dedicated identities during reviewed installation; this migration changes no credentials.
REVOKE ALL ON ALL TABLES IN SCHEMA release_ops FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA release_ops FROM PUBLIC;
GRANT USAGE ON SCHEMA release_ops TO release_journal_reader,release_journal_submitter,
 release_journal_operator,release_journal_controller,release_journal_verifier;
GRANT EXECUTE ON FUNCTION release_ops.inspect(uuid,bigint,integer,bigint),release_ops.observe_snapshot(),release_ops.schema_version() TO release_journal_reader,release_journal_submitter,
 release_journal_operator,release_journal_controller,release_journal_verifier;
GRANT EXECUTE ON FUNCTION release_ops.enqueue(text,jsonb,text) TO release_journal_submitter;
GRANT EXECUTE ON FUNCTION release_ops.retry(uuid,bigint,integer,text,text,text),
 release_ops.withdraw(uuid,bigint,text,text),release_ops.reprioritize(uuid,uuid,bigint,text,text) TO release_journal_operator;
GRANT EXECUTE ON FUNCTION release_ops.reconcile(uuid,bigint,jsonb,text,text) TO release_journal_verifier;
GRANT EXECUTE ON FUNCTION release_ops.acquire_owner(uuid,text),release_ops.claim_next(uuid,uuid,timestamptz,text),
 release_ops.record_receipt(uuid,uuid,uuid,text,text,jsonb,text),release_ops.select_receipt(uuid,uuid,uuid,bigint,uuid,text),release_ops.transition(uuid,uuid,uuid,bigint,text,text,text),
 release_ops.begin_external(uuid,uuid,uuid,text,text,jsonb,text),release_ops.mark_unknown(uuid,uuid,uuid,text,text),
 release_ops.resolve_external(uuid,uuid,uuid,text,jsonb,text),release_ops.begin_recovery(uuid,uuid,uuid,bigint,text,jsonb,text,text),release_ops.resume_retry(uuid,uuid,uuid,timestamptz,text)
 TO release_journal_controller;
COMMENT ON SCHEMA release_ops IS 'Private global release journal v1. Bootstrap OBSERVE only; no installed publishing authority.';
COMMIT;
