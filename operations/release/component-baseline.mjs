import {
  requireCertificate as need,
  fullSha,
  artifactIdentity,
  uuid,
  sameFacts,
} from './component-certificate.mjs';

const targets = ['club-arena-engine', 'club-arena-web'];
const positive = /^[1-9][0-9]*$/;
export function baselineGeneration(resolved) {
  if (resolved.origin === 'attempt') {
    need(
      resolved.captured_baseline &&
        ['bootstrap', 'completed'].includes(resolved.captured_baseline.origin),
      'RELEASE_COMPONENT_BASELINE_ATTEMPT_CHANGED'
    );
    return structuredClone(resolved.captured_baseline);
  }
  return Object.fromEntries(
    [
      'origin',
      'baseline_event_id',
      'baseline_release_id',
      'generation_event_id',
      'generation_event_no',
      'certificate_operation_id',
      'cleanup_receipt',
    ]
      .filter((key) => resolved[key] !== undefined)
      .map((key) => [key, resolved[key]])
  );
}
export function baselineComponent(value, target) {
  need(
    fullSha.test(value?.source_sha) && artifactIdentity.test(value?.identity),
    'RELEASE_COMPONENT_BASELINE_IDENTITY_REQUIRED'
  );
  if (target === 'club-arena-web')
    need(
      value.identity === `sha256:${value.manifest_digest}`,
      'RELEASE_COMPONENT_BASELINE_IDENTITY_REQUIRED'
    );
  return {
    source_sha: value.source_sha,
    identity: value.identity,
    ...(target === 'club-arena-web' ? { manifest_digest: value.manifest_digest } : {}),
  };
}
function tuple(value) {
  need(
    value && sameFacts(Object.keys(value).sort(), targets),
    'RELEASE_COMPONENT_BASELINE_TUPLE_REQUIRED'
  );
  return Object.fromEntries(
    targets.map((target) => [target, baselineComponent(value[target], target)])
  );
}
function artifacts(value, before) {
  need(
    value && sameFacts(Object.keys(value).sort(), targets),
    'RELEASE_COMPONENT_BASELINE_ARTIFACTS_REQUIRED'
  );
  return Object.fromEntries(
    targets.map((target) => {
      const part = value[target];
      need(
        (part.target === undefined || part.target === target) &&
          sameFacts(baselineComponent(part, target), before[target]) &&
          positive.test(part.build_run_id) &&
          positive.test(part.artifact_id) &&
          artifactIdentity.test(part.archive_digest),
        'RELEASE_COMPONENT_BASELINE_ARTIFACTS_REQUIRED'
      );
      return [
        target,
        {
          target,
          ...before[target],
          build_run_id: part.build_run_id,
          artifact_id: part.artifact_id,
          archive_digest: part.archive_digest,
        },
      ];
    })
  );
}
function planArtifacts(plan, before) {
  const values = Object.values(plan.artifact_inputs ?? {});
  const result = {};
  for (const target of targets) {
    const found = values.filter(
      (part) => part.target === target && sameFacts(baselineComponent(part, target), before[target])
    );
    need(found.length === 1, 'RELEASE_COMPONENT_BASELINE_ANCESTRY_AMBIGUOUS');
    result[target] = found[0];
  }
  return artifacts(result, before);
}

// Derive the expected live tuple only from this attempt's exact selected
// publication receipts. A native current value never advances this prefix.
function publicationPrefix(snapshot, resolved, before, plan) {
  need(
    Array.isArray(resolved.pending_external) && resolved.pending_external.length === 0,
    'RELEASE_COMPONENT_BASELINE_EXTERNAL_UNRESOLVED'
  );
  need(
    Array.isArray(resolved.publication_results),
    'RELEASE_COMPONENT_BASELINE_PUBLICATIONS_REQUIRED'
  );
  const publications = resolved.publication_results;
  const order = plan.cutover_order;
  need(
    Array.isArray(order) &&
      sameFacts(
        order,
        targets.filter((target) => order.includes(target))
      ),
    'RELEASE_COMPONENT_BASELINE_PUBLICATION_ORDER_REQUIRED'
  );
  const live = structuredClone(before),
    selected = snapshot.receipts.READINESS;
  const prefix = [];
  for (const publication of publications) {
    need(publication.status === 'SUCCEEDED', 'RELEASE_COMPONENT_BASELINE_EXTERNAL_UNRESOLVED');
    need(
      publication.kind === 'PUBLISH' &&
        uuid.test(publication.id) &&
        uuid.test(publication.epoch) &&
        order.includes(publication.intent?.target),
      'RELEASE_COMPONENT_BASELINE_PUBLICATION_REQUIRED'
    );
  }
  let gap = false;
  for (const target of order) {
    const found = publications.filter((part) => part.intent.target === target);
    need(found.length <= 1, 'RELEASE_COMPONENT_BASELINE_ANCESTRY_AMBIGUOUS');
    if (!found.length) {
      gap = true;
      continue;
    }
    need(!gap, 'RELEASE_COMPONENT_BASELINE_PUBLICATION_ORDER_REQUIRED');
    const operation = found[0],
      request = operation.intent.provider_request;
    const built = snapshot.receipts.BUILD?.data.artifact.components[target];
    const adapter = target === 'club-arena-engine' ? 'hetzner-intake' : 'github-static';
    need(
      selected &&
        resolved.readiness_event_id === selected.event_id &&
        operation.readiness_event === selected.event_id &&
        operation.intent.adapter === adapter &&
        operation.intent.manifest_digest === snapshot.queue.resolution_manifest_digest &&
        sameFacts(request, selected.data.provider_requests?.[adapter]) &&
        request.target === target &&
        built &&
        request.source_sha === built.source_sha &&
        operation.result?.outcome === 'SUCCEEDED',
      'RELEASE_COMPONENT_BASELINE_PUBLICATION_REQUIRED'
    );
    if (target === 'club-arena-engine')
      need(
        request.artifact_image_id === built.identity &&
          operation.result.source_sha === built.source_sha &&
          operation.result.image_id === built.identity &&
          ['sealed', 'already-released'].includes(operation.result.result),
        'RELEASE_COMPONENT_BASELINE_PUBLICATION_REQUIRED'
      );
    else
      need(
        sameFacts(request.artifact, built) &&
          sameFacts(operation.result.proof?.component, built) &&
          uuid.test(operation.result.proof?.publication_claim),
        'RELEASE_COMPONENT_BASELINE_PUBLICATION_REQUIRED'
      );
    live[target] = baselineComponent(built, target);
    need(
      sameFacts(plan.tuples[prefix.length + 1], live),
      'RELEASE_COMPONENT_BASELINE_PUBLICATION_REQUIRED'
    );
    prefix.push({ target, operation_id: operation.id, epoch: operation.epoch });
  }
  return { expected_current: live, publication_prefix: prefix };
}

export class ComponentBaselineResolver {
  constructor({ resolve, observe, bootstrap }) {
    Object.assign(this, { resolve, observe, bootstrap });
  }
  async read(snapshot) {
    const q = snapshot.queue;
    need(
      uuid.test(q?.release_id) && uuid.test(q.attempt_id),
      'RELEASE_COMPONENT_PREHISTORY_REQUIRED'
    );
    need(
      typeof this.resolve === 'function' && typeof this.observe === 'function',
      'RELEASE_COMPONENT_BASELINE_AUTHORITY_REQUIRED'
    );
    const resolved = await this.resolve(q.release_id);
    need(
      resolved?.version === 1 &&
        resolved.release_id === q.release_id &&
        resolved.attempt_id === q.attempt_id &&
        ['attempt', 'completed', 'bootstrap'].includes(resolved.origin),
      'RELEASE_COMPONENT_BASELINE_GENERATION_REQUIRED'
    );
    const currentPlan = snapshot.compatibility_plan;
    need(
      !currentPlan || resolved.origin === 'attempt',
      'RELEASE_COMPONENT_BASELINE_GENERATION_REQUIRED'
    );
    let before,
      retained,
      prefix = { publication_prefix: [] };
    if (resolved.origin === 'bootstrap') {
      need(
        !currentPlan &&
          resolved.baseline_event_id == null &&
          resolved.generation_event_id == null &&
          resolved.before_components == null &&
          resolved.retained_artifacts == null &&
          this.bootstrap,
        'RELEASE_COMPONENT_BOOTSTRAP_BASELINE_REQUIRED'
      );
      before = tuple(this.bootstrap.before_components);
      retained = artifacts(this.bootstrap.retained_artifacts, before);
      prefix.expected_current = structuredClone(before);
    } else {
      need(
        uuid.test(resolved.baseline_event_id) &&
          uuid.test(resolved.baseline_release_id) &&
          uuid.test(resolved.generation_event_id) &&
          Number.isSafeInteger(resolved.generation_event_no) &&
          resolved.generation_event_no > 0,
        'RELEASE_COMPONENT_BASELINE_GENERATION_REQUIRED'
      );
      before = tuple(resolved.before_components);
      retained = artifacts(resolved.retained_artifacts, before);
      if (resolved.origin === 'completed') {
        need(
          resolved.baseline_release_id !== q.release_id &&
            uuid.test(resolved.certificate_operation_id) &&
            uuid.test(resolved.cleanup_receipt),
          'RELEASE_COMPONENT_BASELINE_CERTIFICATE_REQUIRED'
        );
        prefix.expected_current = structuredClone(before);
      } else {
        const plan = currentPlan?.request?.qualification;
        need(
          currentPlan?.phase === 'COMPATIBILITY' &&
            currentPlan.id === resolved.plan_id &&
            currentPlan.event_id === resolved.baseline_event_id &&
            resolved.generation_event_id === currentPlan.event_id &&
            resolved.baseline_release_id === q.release_id &&
            currentPlan.attempt_id === q.attempt_id &&
            plan?.release_id === q.release_id &&
            plan.manifest_digest === q.resolution_manifest_digest &&
            plan.build_receipt === snapshot.receipts.BUILD?.event_id &&
            sameFacts(before, plan.tuples?.[0]) &&
            sameFacts(retained, planArtifacts(plan, before)) &&
            sameFacts(plan.baseline, baselineGeneration(resolved)),
          'RELEASE_COMPONENT_BASELINE_ATTEMPT_CHANGED'
        );
        prefix = publicationPrefix(snapshot, resolved, before, plan);
      }
    }
    const value = {
      ...resolved,
      before_components: before,
      retained_artifacts: retained,
      ...prefix,
    };
    // Read both native identities and public provenance against this expected
    // tuple. The callback may refuse, but cannot rewrite the baseline.
    const observed = await this.observe(value.expected_current, { snapshot, baseline: value });
    need(
      sameFacts(tuple(observed), value.expected_current),
      'RELEASE_COMPONENT_BASELINE_NATIVE_DRIFT'
    );
    // A generation change during remote observation invalidates the entire
    // read. Do not combine old artifact ancestry with a newer live publication.
    need(
      sameFacts(await this.resolve(q.release_id), resolved),
      'RELEASE_COMPONENT_BASELINE_GENERATION_CHANGED'
    );
    return value;
  }
}
