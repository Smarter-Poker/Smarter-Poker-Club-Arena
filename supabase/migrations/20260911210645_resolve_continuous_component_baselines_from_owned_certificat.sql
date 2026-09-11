-- 20260911210645_resolve_continuous_component_baselines_from_owned_certificat.sql
-- Version reserved by scripts/new-migration.mjs against origin/main and remote branches.
-- Private read-side provenance for a continuous component release train.
-- No identities, activation, provider effects or application data changes.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

CREATE FUNCTION release_ops.component_baseline_certificate(certificate_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r release_ops.receipts; q release_ops.queue; p release_ops.source_plans;
 e release_ops.external_operations; cleanup release_ops.certification_cleanup_receipts;
 claim release_ops.certification_run_claims; generation release_ops.events; n integer;
BEGIN
 SELECT count(*) INTO n FROM release_ops.receipts WHERE event_id=certificate_id;
 IF n<>1 THEN RAISE EXCEPTION 'RELEASE_BASELINE_CERTIFICATE_AMBIGUOUS'; END IF;
 SELECT * INTO r FROM release_ops.receipts WHERE event_id=certificate_id;
 SELECT * INTO q FROM release_ops.queue WHERE release_id=r.release_id;
 SELECT * INTO e FROM release_ops.external_operations WHERE id::text=r.data->>'operation_id';
 SELECT * INTO p FROM release_ops.source_plans WHERE id::text=e.intent->>'plan_id';
 SELECT * INTO cleanup FROM release_ops.certification_cleanup_receipts WHERE operation_id=e.id;
 SELECT * INTO claim FROM release_ops.certification_run_claims WHERE operation_id=e.id;
 SELECT count(*) INTO n FROM release_ops.events WHERE release_id=q.release_id AND kind='STATE_'||q.state
  AND data->>'state_version'=q.state_version::text;
 IF n<>1 THEN RAISE EXCEPTION 'RELEASE_BASELINE_GENERATION_REQUIRED'; END IF;
 SELECT * INTO generation FROM release_ops.events WHERE release_id=q.release_id AND kind='STATE_'||q.state
  AND data->>'state_version'=q.state_version::text;
 IF q.state NOT IN ('VERIFIED','RECOVERED') OR q.state IS NULL
 OR r.kind IS DISTINCT FROM 'CERTIFICATION' OR q.selected_receipts->>'CERTIFICATION' IS DISTINCT FROM certificate_id::text
 OR r.recovery_id IS DISTINCT FROM q.recovery_id OR r.data->>'success' IS DISTINCT FROM 'true'
 OR r.data->>'build_receipt' IS DISTINCT FROM q.selected_receipts->>'BUILD'
 OR e.release_id IS DISTINCT FROM q.release_id OR e.kind IS DISTINCT FROM 'CERTIFY' OR e.status IS DISTINCT FROM 'SUCCEEDED'
 OR p.release_id IS DISTINCT FROM q.release_id OR p.attempt_id IS DISTINCT FROM q.attempt_id
 OR p.phase IS DISTINCT FROM 'CERTIFY' OR p.adapter IS DISTINCT FROM 'github-certification'
 OR p.request IS DISTINCT FROM e.intent->'provider_request' OR p.request->>'certificate_version' IS DISTINCT FROM '2'
 OR p.request->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR NOT EXISTS(SELECT 1 FROM release_ops.events terminal JOIN release_ops.events receipt ON receipt.id=r.event_id
   WHERE terminal.id=e.terminal_event AND terminal.release_id=q.release_id AND terminal.kind='EXTERNAL_SUCCEEDED'
   AND receipt.release_id=q.release_id AND receipt.event_no>terminal.event_no AND generation.event_no>receipt.event_no)
 OR e.result->'proof'->>'operation_id' IS DISTINCT FROM e.id::text
 OR e.result->'proof'->'request' IS DISTINCT FROM p.request OR NOT COALESCE(r.data @> (e.result->'proof'),false)
 OR r.data->'served_components' IS DISTINCT FROM p.request->'component_tuple'
 OR r.data->>'cleanup_complete' IS DISTINCT FROM 'true' OR r.data->>'unchanged_release' IS DISTINCT FROM 'true'
 OR claim.operation_id IS NULL OR cleanup.operation_id IS NULL
 OR r.data->>'cleanup_receipt' IS DISTINCT FROM cleanup.event_id::text
 OR e.result->>'provider_operation_id' IS DISTINCT FROM claim.run_id
 OR cleanup.data->>'operation_id' IS DISTINCT FROM e.id::text OR cleanup.data->>'run_id' IS DISTINCT FROM claim.run_id
 OR cleanup.data->>'run_attempt' IS DISTINCT FROM '1'
 OR NOT EXISTS(SELECT 1 FROM release_ops.provider_submissions WHERE operation_id=e.id)
 OR NOT EXISTS(SELECT 1 FROM release_ops.certification_cleanup_barriers WHERE operation_id=e.id)
 OR EXISTS(SELECT 1 FROM release_ops.certification_cleanup_recoveries WHERE operation_id=e.id)
 OR (SELECT count(*) FROM release_ops.certification_fixture_intents WHERE plan_id=p.id)<>9
 OR jsonb_typeof(cleanup.data->'accounts') IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'RELEASE_BASELINE_CLEAN_CERTIFICATE_REQUIRED'; END IF;
 IF q.state='RECOVERED' AND (q.recovery_id IS NULL
 OR NOT EXISTS(SELECT 1 FROM release_ops.recovery_revisions revision WHERE revision.id=q.recovery_id
   AND revision.release_id=q.release_id AND revision.attempt_id=q.attempt_id AND revision.intent->>'purpose'='forward-revert')
 OR r.data->>'recovery_revision_id' IS DISTINCT FROM q.recovery_id::text
 OR r.data->>'source_reconciled' IS DISTINCT FROM 'true' OR r.data->>'source_revision' IS DISTINCT FROM q.resolution_head_sha)
 THEN RAISE EXCEPTION 'RELEASE_BASELINE_RECOVERED_SOURCE_REQUIRED'; END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(cleanup.data->'accounts'))<>9
 OR EXISTS(SELECT 1 FROM release_ops.certification_fixture_intents f WHERE f.plan_id=p.id AND
   (cleanup.data->'accounts'->f.slot->>'user_id' IS DISTINCT FROM f.user_id::text
   OR cleanup.data->'accounts'->f.slot->>'email' IS DISTINCT FROM f.email
   OR cleanup.data->'accounts'->f.slot->>'auth_absent' IS DISTINCT FROM 'true'
   OR cleanup.data->'accounts'->f.slot->>'resources_absent' IS DISTINCT FROM 'true'
   OR COALESCE(cleanup.data->'accounts'->f.slot->>'evidence_sha256','') !~ '^[0-9a-f]{64}$'))
 OR EXISTS(SELECT 1 FROM release_ops.certification_fixture_claims f WHERE f.operation_id=e.id AND NOT EXISTS(
   SELECT 1 FROM release_ops.certification_fixture_outcomes o WHERE o.operation_id=e.id AND o.slot=f.slot))
 OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(r.data->'served_components') key)
   IS DISTINCT FROM ARRAY['club-arena-engine','club-arena-web']
 THEN RAISE EXCEPTION 'RELEASE_BASELINE_CLEAN_CERTIFICATE_REQUIRED'; END IF;
 RETURN jsonb_build_object('baseline_release_id',q.release_id,'baseline_event_id',r.event_id,
  'generation_event_id',generation.id,'generation_event_no',generation.event_no,
  'certificate_operation_id',e.id,'cleanup_receipt',cleanup.event_id,'served_components',r.data->'served_components',
  'build_receipt',q.selected_receipts->>'BUILD','readiness_event_id',q.selected_receipts->>'READINESS');
END $$;

CREATE FUNCTION release_ops.component_baseline_artifact(certificate_id uuid,target text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE current_id uuid:=certificate_id; visited uuid[]:='{}'; cert jsonb; part jsonb; expected jsonb; artifact jsonb;
 q release_ops.queue; b release_ops.receipts; parent release_ops.external_operations; build_plan release_ops.source_plans;
 publication release_ops.external_operations; publication_plan release_ops.provider_plans;
 child release_ops.qualification_children; child_result release_ops.qualification_results;
 run_id text; previous_generation bigint; n integer;
BEGIN
 IF target NOT IN ('club-arena-engine','club-arena-web') OR target IS NULL THEN RAISE EXCEPTION 'RELEASE_BASELINE_TARGET_REQUIRED'; END IF;
 FOR depth IN 1..64 LOOP
  IF current_id=ANY(visited) THEN RAISE EXCEPTION 'RELEASE_BASELINE_ANCESTRY_CYCLE'; END IF;
  visited:=array_append(visited,current_id);
  cert:=release_ops.component_baseline_certificate(current_id);
  IF previous_generation IS NOT NULL AND (cert->>'generation_event_no')::bigint>=previous_generation
  THEN RAISE EXCEPTION 'RELEASE_BASELINE_ANCESTRY_ORDER_REQUIRED'; END IF;
  previous_generation:=(cert->>'generation_event_no')::bigint;
  part:=cert->'served_components'->target;
  artifact:=jsonb_build_object('source_sha',part->>'source_sha','identity',part->>'identity')
   ||CASE WHEN target='club-arena-web' THEN jsonb_build_object('manifest_digest',part->>'manifest_digest') ELSE '{}'::jsonb END;
  IF expected IS NULL THEN expected:=artifact; END IF;
  IF artifact IS DISTINCT FROM expected OR COALESCE(part->>'source_sha','') !~ '^[0-9a-f]{40}$'
  OR COALESCE(part->>'identity','') !~ '^sha256:[0-9a-f]{64}$'
  OR (target='club-arena-web' AND part->>'identity' IS DISTINCT FROM 'sha256:'||(part->>'manifest_digest'))
  THEN RAISE EXCEPTION 'RELEASE_BASELINE_ANCESTRY_IDENTITY_REQUIRED'; END IF;
  IF part->>'mode'='changed' THEN EXIT; END IF;
  IF part->>'mode' IS DISTINCT FROM 'retained' OR COALESCE(part->>'verified_receipt_id','') !~ '^[0-9a-f-]{36}$'
  OR part->>'compatibility_receipt_id' IS DISTINCT FROM cert->>'readiness_event_id'
  THEN RAISE EXCEPTION 'RELEASE_BASELINE_ANCESTRY_REQUIRED'; END IF;
  current_id:=(part->>'verified_receipt_id')::uuid;
 END LOOP;
 IF part->>'mode' IS DISTINCT FROM 'changed' THEN RAISE EXCEPTION 'RELEASE_BASELINE_ANCESTRY_LIMIT'; END IF;
 SELECT * INTO q FROM release_ops.queue WHERE release_id::text=cert->>'baseline_release_id';
 SELECT count(*) INTO n FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'BUILD';
 IF n<>1 THEN RAISE EXCEPTION 'RELEASE_BASELINE_BUILD_AMBIGUOUS'; END IF;
 SELECT * INTO b FROM release_ops.receipts WHERE event_id::text=q.selected_receipts->>'BUILD';
 artifact:=b.data->'artifact'->'components'->target;
 SELECT * INTO parent FROM release_ops.external_operations WHERE id::text=COALESCE(b.data->>'aggregate_operation_id',artifact->>'build_operation_id');
 SELECT * INTO build_plan FROM release_ops.source_plans WHERE id::text=parent.intent->>'plan_id';
 SELECT * INTO publication FROM release_ops.external_operations WHERE id::text=part->>'publication_operation_id';
 SELECT * INTO publication_plan FROM release_ops.provider_plans WHERE id::text=publication.intent->>'plan_id';
 IF b.release_id IS DISTINCT FROM q.release_id OR b.recovery_id IS DISTINCT FROM q.recovery_id OR b.kind IS DISTINCT FROM 'BUILD'
 OR b.data->>'success' IS DISTINCT FROM 'true' OR b.data->>'source_sha' IS DISTINCT FROM part->>'source_sha'
 OR artifact->>'identity' IS DISTINCT FROM part->>'identity'
 OR COALESCE(artifact->>'github_artifact_id','') !~ '^[1-9][0-9]*$'
 OR COALESCE(artifact->>'github_archive_digest','') !~ '^sha256:[0-9a-f]{64}$'
 OR parent.release_id IS DISTINCT FROM q.release_id OR parent.kind IS DISTINCT FROM 'BUILD' OR parent.status IS DISTINCT FROM 'SUCCEEDED'
 OR parent.result->'proof'->'artifact' IS DISTINCT FROM b.data->'artifact'
 OR build_plan.release_id IS DISTINCT FROM q.release_id OR build_plan.attempt_id IS DISTINCT FROM q.attempt_id
 OR build_plan.phase IS DISTINCT FROM 'BUILD' OR build_plan.request IS DISTINCT FROM parent.intent->'provider_request'
 OR NOT EXISTS(SELECT 1 FROM release_ops.provider_submissions WHERE operation_id=parent.id)
 OR publication.release_id IS DISTINCT FROM q.release_id OR publication.kind IS DISTINCT FROM 'PUBLISH'
 OR publication.status IS DISTINCT FROM 'SUCCEEDED' OR publication.intent->>'target' IS DISTINCT FROM target
 OR publication.intent->>'manifest_digest' IS DISTINCT FROM q.resolution_manifest_digest
 OR publication_plan.release_id IS DISTINCT FROM q.release_id OR publication_plan.recovery_id IS DISTINCT FROM q.recovery_id
 OR publication_plan.readiness_event::text IS DISTINCT FROM q.selected_receipts->>'READINESS'
 OR publication_plan.request IS DISTINCT FROM publication.intent->'provider_request'
 OR publication_plan.request->>'source_sha' IS DISTINCT FROM part->>'source_sha'
 OR NOT EXISTS(SELECT 1 FROM release_ops.provider_submissions WHERE operation_id=publication.id)
 THEN RAISE EXCEPTION 'RELEASE_BASELINE_OWNED_BUILD_PUBLICATION_REQUIRED'; END IF;
 IF b.data ? 'aggregate_operation_id' THEN
  SELECT * INTO child FROM release_ops.qualification_children WHERE id::text=artifact->>'build_operation_id';
  SELECT * INTO child_result FROM release_ops.qualification_results WHERE child_id=child.id;
  IF parent.intent->>'adapter' IS DISTINCT FROM 'component-aggregate' OR child.parent_id IS DISTINCT FROM parent.id
  OR child.target IS DISTINCT FROM target OR child.request->>'source_sha' IS DISTINCT FROM part->>'source_sha'
  OR child_result.outcome IS DISTINCT FROM 'SUCCEEDED' OR child_result.event_id::text IS DISTINCT FROM artifact->>'qualification_result_event'
  OR child_result.result->'proof'->'artifact'->'components'->target->>'identity' IS DISTINCT FROM part->>'identity'
  OR child_result.result->'proof'->'artifact'->'components'->target->>'github_artifact_id' IS DISTINCT FROM artifact->>'github_artifact_id'
  OR child_result.result->'proof'->'artifact'->'components'->target->>'github_archive_digest' IS DISTINCT FROM artifact->>'github_archive_digest'
  OR artifact->>'aggregate_operation_id' IS DISTINCT FROM parent.id::text
  OR NOT EXISTS(SELECT 1 FROM release_ops.qualification_submissions WHERE child_id=child.id)
  THEN RAISE EXCEPTION 'RELEASE_BASELINE_CHILD_PROVENANCE_REQUIRED'; END IF;
  run_id:=child_result.result->>'provider_operation_id';
 ELSE
  IF target<>'club-arena-engine' OR parent.intent->>'adapter' IS DISTINCT FROM 'github-workflow'
  OR artifact->>'build_operation_id' IS DISTINCT FROM parent.id::text
  THEN RAISE EXCEPTION 'RELEASE_BASELINE_BUILD_PROVENANCE_REQUIRED'; END IF;
  run_id:=parent.result->>'provider_operation_id';
 END IF;
 IF COALESCE(run_id,'') !~ '^[1-9][0-9]*$' OR COALESCE(artifact->>'build_run_id',b.data->>'build_run_id') IS DISTINCT FROM run_id
 OR (target='club-arena-engine' AND (publication.intent->>'adapter' IS DISTINCT FROM 'hetzner-intake'
  OR publication_plan.request->>'artifact_image_id' IS DISTINCT FROM part->>'identity'
  OR publication_plan.request->>'run_key' IS DISTINCT FROM run_id||'-1'
  OR publication.result->>'source_sha' IS DISTINCT FROM part->>'source_sha' OR publication.result->>'image_id' IS DISTINCT FROM part->>'identity'
  OR publication.result->>'result' NOT IN ('sealed','already-released') OR publication.result->>'result' IS NULL))
 OR (target='club-arena-web' AND (publication.intent->>'adapter' IS DISTINCT FROM 'github-static'
  OR publication_plan.request->>'build_operation_id' IS DISTINCT FROM artifact->>'build_operation_id'
  OR publication_plan.request->>'build_run_id' IS DISTINCT FROM run_id
  OR publication_plan.request->'artifact' IS DISTINCT FROM artifact
  OR publication.result->'proof'->'component' IS DISTINCT FROM artifact
  OR artifact->>'manifest_digest' IS DISTINCT FROM part->>'manifest_digest'))
 THEN RAISE EXCEPTION 'RELEASE_BASELINE_EXACT_PUBLICATION_REQUIRED'; END IF;
 RETURN expected||jsonb_build_object('target',target,'build_run_id',run_id,'artifact_id',artifact->>'github_artifact_id',
  'archive_digest',artifact->>'github_archive_digest','build_operation_id',artifact->>'build_operation_id',
  'publication_operation_id',publication.id,'certificate_event_id',current_id,'ancestry',to_jsonb(visited));
END $$;

CREATE FUNCTION release_ops.component_compatibility_baseline(release_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
#variable_conflict use_variable
DECLARE q release_ops.queue; p release_ops.source_plans; latest release_ops.events; cert jsonb; answer jsonb;
 before_tuple jsonb:='{}'; artifacts jsonb:='{}'; target text; part jsonb; matches jsonb; n integer;
 publications jsonb; pending jsonb;
BEGIN
 PERFORM release_ops.component_read_scope(release_id);
 SELECT * INTO q FROM release_ops.queue WHERE queue.release_id=component_compatibility_baseline.release_id;
 IF q.attempt_id IS NULL OR NOT EXISTS(SELECT 1 FROM release_ops.admissions a WHERE a.id=q.release_id
  AND a.intent->>'repository'='Smarter-Poker/Smarter-Poker-Club-Arena')
 THEN RAISE EXCEPTION 'RELEASE_BASELINE_ACTIVE_ATTEMPT_REQUIRED'; END IF;
 IF EXISTS(SELECT 1 FROM release_ops.queue completed WHERE completed.release_id<>q.release_id
  AND completed.state IN ('VERIFIED','RECOVERED') AND EXISTS(SELECT 1 FROM jsonb_array_elements(completed.resolution_manifest->'components') c
   WHERE c->>'target' IN ('club-arena-engine','club-arena-web'))
  AND NOT EXISTS(SELECT 1 FROM release_ops.events generation WHERE generation.release_id=completed.release_id
   AND generation.kind='STATE_'||completed.state AND generation.data->>'state_version'=completed.state_version::text))
 THEN RAISE EXCEPTION 'RELEASE_BASELINE_GENERATION_REQUIRED'; END IF;
 SELECT v.* INTO latest FROM release_ops.events v JOIN release_ops.queue completed ON completed.release_id=v.release_id
  WHERE v.release_id<>q.release_id AND completed.state IN ('VERIFIED','RECOVERED') AND v.kind='STATE_'||completed.state
  AND v.data->>'state_version'=completed.state_version::text
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(completed.resolution_manifest->'components') c
   WHERE c->>'target' IN ('club-arena-engine','club-arena-web')) ORDER BY v.event_no DESC LIMIT 1;
 IF EXISTS(SELECT 1 FROM release_ops.external_operations e JOIN release_ops.events v ON v.id=e.intent_event
  WHERE e.release_id<>q.release_id AND (e.status IN ('INTENT','UNKNOWN') OR
   (e.kind IN ('PUBLISH','RECOVERY','MIGRATE') AND e.status<>'NOT_ACCEPTED' AND v.event_no>COALESCE(latest.event_no,0)))
  AND EXISTS(SELECT 1 FROM release_ops.queue other WHERE other.release_id=e.release_id
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(other.resolution_manifest->'components') c
    WHERE c->>'target' IN ('club-arena-engine','club-arena-web'))))
 THEN RAISE EXCEPTION 'RELEASE_BASELINE_NEWER_EFFECT_UNRESOLVED'; END IF;
 SELECT * INTO p FROM release_ops.source_plans WHERE source_plans.release_id=q.release_id AND attempt_id=q.attempt_id AND phase='COMPATIBILITY';
 answer:=jsonb_build_object('version',1,'release_id',q.release_id,'attempt_id',q.attempt_id);
 IF p.id IS NOT NULL THEN
  before_tuple:=p.request->'qualification'->'tuples'->0;
  IF jsonb_typeof(before_tuple) IS DISTINCT FROM 'object' OR jsonb_typeof(p.request->'qualification'->'artifact_inputs') IS DISTINCT FROM 'object'
  OR p.request->'qualification'->'baseline'->>'origin' NOT IN ('completed','bootstrap')
  OR p.request->'qualification'->'baseline'->>'origin' IS NULL
  THEN RAISE EXCEPTION 'RELEASE_BASELINE_ATTEMPT_PROVENANCE_REQUIRED'; END IF;
  FOR target IN SELECT unnest(ARRAY['club-arena-engine','club-arena-web']) LOOP
   part:=before_tuple->target;
   SELECT count(*),jsonb_agg(value) INTO n,matches FROM jsonb_each(p.request->'qualification'->'artifact_inputs') input
    WHERE value->>'target'=target AND value->>'source_sha'=part->>'source_sha' AND value->>'identity'=part->>'identity';
   IF n<>1 OR COALESCE(matches->0->>'build_run_id','') !~ '^[1-9][0-9]*$'
   OR COALESCE(matches->0->>'artifact_id','') !~ '^[1-9][0-9]*$' OR COALESCE(matches->0->>'archive_digest','') !~ '^sha256:[0-9a-f]{64}$'
   OR (target='club-arena-web' AND matches->0->>'manifest_digest' IS DISTINCT FROM part->>'manifest_digest')
   THEN RAISE EXCEPTION 'RELEASE_BASELINE_ATTEMPT_PROVENANCE_REQUIRED'; END IF;
   artifacts:=artifacts||jsonb_build_object(target,matches->0);
  END LOOP;
  IF EXISTS(SELECT 1 FROM release_ops.external_operations e WHERE e.release_id=q.release_id AND e.kind='PUBLISH'
   AND e.status<>'NOT_ACCEPTED' AND NOT EXISTS(SELECT 1 FROM release_ops.provider_plans pp WHERE pp.id::text=e.intent->>'plan_id'
    AND pp.readiness_event::text=q.selected_receipts->>'READINESS' AND pp.recovery_id IS NOT DISTINCT FROM q.recovery_id))
  THEN RAISE EXCEPTION 'RELEASE_BASELINE_UNSELECTED_PUBLICATION_REQUIRED'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(e)||jsonb_build_object('readiness_event',pp.readiness_event) ORDER BY ev.event_no),'[]') INTO publications
   FROM release_ops.external_operations e JOIN release_ops.provider_plans pp ON pp.id::text=e.intent->>'plan_id'
   JOIN release_ops.events ev ON ev.id=e.intent_event WHERE e.release_id=q.release_id AND e.kind='PUBLISH'
   AND pp.readiness_event::text=q.selected_receipts->>'READINESS' AND pp.recovery_id IS NOT DISTINCT FROM q.recovery_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'status',status,'kind',kind)),'[]') INTO pending
   FROM release_ops.external_operations e WHERE e.release_id=q.release_id AND (e.status IN ('INTENT','UNKNOWN')
    OR (e.status IN ('FAILED','CANCELLED') AND (EXISTS(SELECT 1 FROM release_ops.source_plans source
      WHERE source.id::text=e.intent->>'plan_id' AND source.attempt_id=q.attempt_id)
     OR EXISTS(SELECT 1 FROM release_ops.provider_plans publication WHERE publication.id::text=e.intent->>'plan_id'
      AND publication.readiness_event::text=q.selected_receipts->>'READINESS' AND publication.recovery_id IS NOT DISTINCT FROM q.recovery_id))));
  RETURN answer||jsonb_build_object('origin','attempt','baseline_release_id',q.release_id,'baseline_event_id',p.event_id,
   'generation_event_id',p.event_id,'generation_event_no',(SELECT event_no FROM release_ops.events WHERE id=p.event_id),
   'plan_id',p.id,'readiness_event_id',q.selected_receipts->>'READINESS','before_components',before_tuple,'retained_artifacts',artifacts,
   'publication_results',publications,'pending_external',pending,'captured_baseline',p.request->'qualification'->'baseline');
 END IF;
 IF EXISTS(SELECT 1 FROM release_ops.external_operations e WHERE e.release_id=q.release_id AND
   (e.status IN ('INTENT','UNKNOWN') OR (e.kind IN ('PUBLISH','RECOVERY','MIGRATE') AND e.status<>'NOT_ACCEPTED')))
 THEN RAISE EXCEPTION 'RELEASE_BASELINE_ATTEMPT_EFFECT_UNRESOLVED'; END IF;
 IF latest.id IS NULL THEN
  IF EXISTS(SELECT 1 FROM release_ops.queue other WHERE other.release_id<>q.release_id AND other.state IN ('VERIFIED','RECOVERED')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(other.resolution_manifest->'components') c WHERE c->>'target' IN ('club-arena-engine','club-arena-web')))
  THEN RAISE EXCEPTION 'RELEASE_BASELINE_GENERATION_REQUIRED'; END IF;
  RETURN answer||jsonb_build_object('origin','bootstrap','baseline_release_id',NULL,'baseline_event_id',NULL,
   'generation_event_id',NULL,'generation_event_no',NULL);
 END IF;
 SELECT selected_receipts->>'CERTIFICATION' INTO target FROM release_ops.queue WHERE queue.release_id=latest.release_id;
 IF target IS NULL THEN RAISE EXCEPTION 'RELEASE_BASELINE_CLEAN_CERTIFICATE_REQUIRED'; END IF;
 cert:=release_ops.component_baseline_certificate(target::uuid);
 FOR target IN SELECT unnest(ARRAY['club-arena-engine','club-arena-web']) LOOP
  part:=release_ops.component_baseline_artifact((cert->>'baseline_event_id')::uuid,target);
  artifacts:=artifacts||jsonb_build_object(target,part);
  before_tuple:=before_tuple||jsonb_build_object(target,jsonb_build_object('source_sha',part->>'source_sha','identity',part->>'identity')
   ||CASE WHEN target='club-arena-web' THEN jsonb_build_object('manifest_digest',part->>'manifest_digest') ELSE '{}'::jsonb END);
 END LOOP;
 RETURN answer||(cert-ARRAY['served_components','build_receipt','readiness_event_id'])||jsonb_build_object('origin','completed',
  'before_components',before_tuple,'retained_artifacts',artifacts);
END $$;

CREATE FUNCTION release_ops.guard_component_baseline_plan() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE resolved jsonb; expected jsonb; seed jsonb; target text; original jsonb; inputs jsonb; matching jsonb; n integer;
BEGIN
 IF NEW.phase<>'COMPATIBILITY' THEN RETURN NEW; END IF;
 resolved:=release_ops.component_compatibility_baseline(NEW.release_id);
 IF resolved->>'origin'='attempt' THEN RAISE EXCEPTION 'RELEASE_BASELINE_ATTEMPT_ALREADY_CAPTURED'; END IF;
 expected:=resolved-ARRAY['version','release_id','attempt_id','before_components','retained_artifacts'];
 IF resolved->>'origin'='bootstrap' THEN
  SELECT i.binding->'compatibility'->'bootstrap' INTO seed FROM release_ops.provider_installations i
   JOIN release_ops.controller c ON c.installed_adapter_receipt=i.id::text WHERE c.singleton;
 ELSE seed:=resolved; END IF;
 IF NEW.request->'qualification'->'baseline' IS DISTINCT FROM expected
 OR jsonb_typeof(seed->'before_components') IS DISTINCT FROM 'object'
 OR jsonb_typeof(seed->'retained_artifacts') IS DISTINCT FROM 'object'
 OR NEW.request->'qualification'->'tuples'->0 IS DISTINCT FROM seed->'before_components'
 OR jsonb_typeof(NEW.request->'qualification'->'artifact_inputs') IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'RELEASE_BASELINE_CAPTURE_REQUIRED'; END IF;
 inputs:=NEW.request->'qualification'->'artifact_inputs';
 FOR target IN SELECT unnest(ARRAY['club-arena-engine','club-arena-web']) LOOP
  original:=seed->'retained_artifacts'->target;
  SELECT count(*),jsonb_agg(value) INTO n,matching FROM jsonb_each(inputs) input
   WHERE value->>'target'=target AND value->>'source_sha'=original->>'source_sha' AND value->>'identity'=original->>'identity';
  IF n<>1 OR COALESCE(original->>'build_run_id','') !~ '^[1-9][0-9]*$'
  OR original->>'source_sha' IS DISTINCT FROM seed->'before_components'->target->>'source_sha'
  OR original->>'identity' IS DISTINCT FROM seed->'before_components'->target->>'identity'
  OR COALESCE(original->>'artifact_id','') !~ '^[1-9][0-9]*$' OR COALESCE(original->>'archive_digest','') !~ '^sha256:[0-9a-f]{64}$'
  OR matching->0->>'build_run_id' IS DISTINCT FROM original->>'build_run_id'
  OR matching->0->>'artifact_id' IS DISTINCT FROM original->>'artifact_id'
  OR matching->0->>'archive_digest' IS DISTINCT FROM original->>'archive_digest'
  OR (target='club-arena-web' AND (matching->0->>'manifest_digest' IS DISTINCT FROM original->>'manifest_digest'
   OR original->>'manifest_digest' IS DISTINCT FROM seed->'before_components'->target->>'manifest_digest'))
  THEN RAISE EXCEPTION 'RELEASE_BASELINE_CAPTURE_ARTIFACT_REQUIRED'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_component_baseline_plan BEFORE INSERT ON release_ops.source_plans
 FOR EACH ROW EXECUTE FUNCTION release_ops.guard_component_baseline_plan();
REVOKE ALL ON FUNCTION release_ops.component_baseline_certificate(uuid),release_ops.component_baseline_artifact(uuid,text),
 release_ops.component_compatibility_baseline(uuid),release_ops.guard_component_baseline_plan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION release_ops.component_compatibility_baseline(uuid) TO release_journal_controller,release_certification_callback;
COMMIT;
