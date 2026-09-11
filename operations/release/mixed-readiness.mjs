import {
  requireCertificate as need,
  sameFacts,
  factDigest,
  fullSha,
  artifactIdentity,
  uuid,
} from './component-certificate.mjs';
import { compatibilityPlan } from './component-compatibility.mjs';

export const mixedCutoverOrder = Object.freeze(['club-arena-engine', 'club-arena-web']);
const identity = (part, target) => ({
  source_sha: part.source_sha,
  identity: part.identity,
  ...(target === 'club-arena-web' ? { manifest_digest: part.manifest_digest } : {}),
});

// This adapter only reads a separately executed semantic qualification. It
// cannot turn a catalogue, manifest or reachable endpoint into a passing run.
export class ComponentCompatibilityReadiness {
  constructor({ contract, readBefore, qualifier, retainedEvidence }) {
    Object.assign(this, { contract, readBefore, qualifier, retainedEvidence });
  }
  async qualification(snapshot) {
    need(
      typeof this.readBefore === 'function' && typeof this.qualifier?.verify === 'function',
      'RELEASE_SEMANTIC_QUALIFIER_INSTALLATION_REQUIRED'
    );
    const before = await this.readBefore(snapshot);
    const plan = compatibilityPlan(snapshot, before, this.contract);
    return { before, plan };
  }
  async plan(snapshot) {
    const { plan } = await this.qualification(snapshot);
    if (typeof this.qualifier.requestFor === 'function')
      return this.qualifier.requestFor(plan, snapshot);
    const q = snapshot.queue,
      integration = snapshot.receipts.INTEGRATION.data;
    return {
      phase: 'COMPATIBILITY',
      repository: 'Smarter-Poker/Smarter-Poker-Club-Arena',
      target: snapshot.admission.intent.target,
      source_sha: plan.source_sha,
      accepted_head_sha: q.resolution_head_sha,
      expected_base_sha: integration.expected_base_sha,
      tested_tree_sha: integration.merged_tree_sha,
      manifest_digest: q.resolution_manifest_digest,
      control_sha: this.qualifier.controlSha,
      workflow_id: this.qualifier.workflowId,
      runtime_image: this.qualifier.runtimeImage,
      qualification: plan,
    };
  }
  async verify(snapshot) {
    const { before, plan } = await this.qualification(snapshot);
    const operation = snapshot.compatibility_operation;
    need(
      operation?.status === 'SUCCEEDED' &&
        operation.intent?.adapter === 'github-compatibility' &&
        sameFacts(operation.intent.provider_request?.qualification, plan),
      'RELEASE_SEMANTIC_QUALIFICATION_REQUIRED'
    );
    const semantic = await this.qualifier.verify(plan, operation.id);
    need(
      semantic?.verified === true &&
        sameFacts(semantic.request, plan) &&
        semantic.request_digest === factDigest(plan) &&
        sameFacts(operation.result?.proof?.compatibility, semantic),
      'RELEASE_SEMANTIC_QUALIFICATION_MISMATCH'
    );
    const changed = snapshot.queue.resolution_manifest.components.map((c) => c.target);
    const retained = {};
    for (const target of mixedCutoverOrder.filter((t) => !changed.includes(t))) {
      need(
        typeof this.retainedEvidence === 'function',
        'RELEASE_RETAINED_COMPONENT_EVIDENCE_REQUIRED'
      );
      const part = await this.retainedEvidence(
        snapshot.queue.release_id,
        target,
        before[target].source_sha,
        before[target].identity
      );
      need(
        part?.mode === 'retained' &&
          uuid.test(part.verified_receipt_id) &&
          sameFacts(identity(part, target), identity(before[target], target)),
        'RELEASE_RETAINED_COMPONENT_EVIDENCE_REQUIRED'
      );
      retained[target] = part;
    }
    return {
      verified: true,
      manifest_digest: snapshot.queue.resolution_manifest_digest,
      source_sha: snapshot.receipts.BUILD.data.source_sha,
      receipt_refs: [
        `github-compatibility:${semantic.run_id}:${semantic.artifact_id}:${semantic.archive_digest}`,
      ],
      before_components: before,
      retained_components: retained,
      semantic,
      compatibility_operation_id: operation.id,
    };
  }
}

export function validateMixedCompatibility(snapshot, compatibility) {
  const { queue: q, receipts } = snapshot;
  const built = receipts.BUILD?.data;
  const proof = compatibility?.semantic;
  const plan = proof?.request;
  need(
    sameFacts(q.resolution_manifest.components.map((c) => c.target).sort(), mixedCutoverOrder) &&
      compatibility?.verified === true &&
      compatibility.manifest_digest === q.resolution_manifest_digest &&
      compatibility.source_sha === built?.source_sha &&
      fullSha.test(built.source_sha) &&
      Array.isArray(compatibility.receipt_refs) &&
      compatibility.receipt_refs.length > 0 &&
      sameFacts(compatibility.retained_components, {}) &&
      proof?.verified === true &&
      uuid.test(compatibility.compatibility_operation_id) &&
      proof.operation_id === compatibility.compatibility_operation_id &&
      snapshot.compatibility_operation?.id === compatibility.compatibility_operation_id &&
      snapshot.compatibility_operation.status === 'SUCCEEDED' &&
      sameFacts(snapshot.compatibility_operation.result?.proof?.compatibility, proof) &&
      proof.request_digest === factDigest(plan) &&
      plan?.release_id === q.release_id &&
      plan.manifest_digest === q.resolution_manifest_digest &&
      plan.build_receipt === receipts.BUILD.event_id &&
      plan.aggregate_operation_id === built.aggregate_operation_id &&
      plan.source_sha === built.source_sha &&
      sameFacts(plan.cutover_order, mixedCutoverOrder) &&
      plan.tuples?.length === 3,
    'RELEASE_MIXED_COMPATIBILITY_REQUIRED'
  );
  const before = compatibility.before_components;
  const expected = {};
  for (const target of mixedCutoverOrder) {
    const prior = before?.[target],
      next = built.artifact.components[target];
    need(
      fullSha.test(prior?.source_sha) &&
        artifactIdentity.test(prior?.identity) &&
        next.source_sha === built.source_sha &&
        artifactIdentity.test(next.identity) &&
        next.aggregate_operation_id === built.aggregate_operation_id &&
        uuid.test(next.build_operation_id) &&
        uuid.test(next.qualification_result_event) &&
        /^[1-9][0-9]*$/.test(next.build_run_id),
      'RELEASE_MIXED_BUILD_TUPLE_REQUIRED'
    );
    if (target === 'club-arena-web')
      need(
        prior.identity === `sha256:${prior.manifest_digest}` &&
          next.identity === `sha256:${next.manifest_digest}`,
        'RELEASE_MIXED_BUILD_TUPLE_REQUIRED'
      );
    need(
      sameFacts(plan.component_builds?.[target], {
        ...identity(next, target),
        build_operation_id: next.build_operation_id,
        build_run_id: next.build_run_id,
        qualification_result_event: next.qualification_result_event,
        artifact_id: next.github_artifact_id,
        archive_digest: next.github_archive_digest,
      }),
      'RELEASE_MIXED_BUILD_TUPLE_REQUIRED'
    );
    expected[target] = identity(prior, target);
  }
  need(sameFacts(plan.tuples[0], expected), 'RELEASE_UNCOVERED_COMPONENT_COMBINATION');
  for (let n = 0; n < mixedCutoverOrder.length; n++) {
    const target = mixedCutoverOrder[n];
    expected[target] = identity(built.artifact.components[target], target);
    need(sameFacts(plan.tuples[n + 1], expected), 'RELEASE_UNCOVERED_COMPONENT_COMBINATION');
  }
  need(
    proof.combinations?.length === 3 &&
      proof.combinations.every(
        (c, n) =>
          c.tuple_digest === factDigest(plan.tuples[n]) &&
          c.success === true &&
          c.failed === 0 &&
          c.retries === 0 &&
          c.skipped === 0 &&
          c.cleanup?.complete === true &&
          c.cleanup.remaining_objects === 0 &&
          Number.isSafeInteger(c.executed) &&
          c.executed > 0 &&
          c.schema_fixture_sha256 === plan.schema.fixture_sha256 &&
          c.component_builds_digest === factDigest(plan.component_builds)
      ),
    'RELEASE_UNCOVERED_COMPONENT_COMBINATION'
  );
  return compatibility;
}

export class MixedReadiness {
  constructor({ engineReadiness, staticReadiness, verifyCompatibility, compatibilityReadiness }) {
    Object.assign(this, {
      engineReadiness,
      staticReadiness,
      compatibilityReadiness,
      verifyCompatibility:
        verifyCompatibility ?? compatibilityReadiness?.verify.bind(compatibilityReadiness),
    });
  }
  async verify(snapshot, request, operation) {
    need(
      typeof this.verifyCompatibility === 'function' &&
        this.engineReadiness &&
        this.staticReadiness,
      'RELEASE_MIXED_COMPATIBILITY_AUTHORITY_NOT_INSTALLED'
    );
    const compatibility = validateMixedCompatibility(
      snapshot,
      await this.verifyCompatibility(snapshot)
    );
    const bound = {
      version: 1,
      build_receipt: snapshot.receipts.BUILD.event_id,
      component_builds: snapshot.receipts.BUILD.data.artifact.components,
      before_components: compatibility.before_components,
      cutover_order: [...mixedCutoverOrder],
      semantic: compatibility.semantic,
    };
    // READY cannot adopt a different run, baseline, or component build after
    // STAGED. Every tuple and subordinate artifact remains the same.
    if (snapshot.receipts.STAGED)
      need(
        sameFacts(snapshot.receipts.STAGED.data.component_readiness, bound),
        'RELEASE_MIXED_READINESS_CHANGED_AFTER_STAGING'
      );
    const engine = await this.engineReadiness.verify(snapshot, request, operation, {
      compatibility,
    });
    const web = await this.staticReadiness.verify(snapshot, { compatibility });
    return {
      ...engine,
      static_expected_current: web.static_expected_current,
      retained_components: {},
      compatibility_receipt_refs: compatibility.receipt_refs,
      compatibility_operation_id: compatibility.compatibility_operation_id,
      semantic_qualification: compatibility.semantic,
      component_readiness: bound,
      publication_order: [...mixedCutoverOrder],
      provider_requests: { ...engine.provider_requests, ...web.provider_requests },
    };
  }
}
