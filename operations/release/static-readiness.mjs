import { requireCertificate as need, fullSha, artifactIdentity } from './component-certificate.mjs';
import {
  proveExistingArtifact,
  publicDocuments,
  requirePriorPublication,
} from './frontend-artifact-proof.mjs';
import { validateMixedCompatibility } from './mixed-readiness.mjs';

// The existing independent compatibility authority must be installed and bound
// by the owner. A reachable origin or a declared manifest is not that authority.
export class StaticReadiness {
  constructor({
    adapter,
    readNative,
    readPublic = publicDocuments,
    github,
    verifyCompatibility,
    compatibilityReadiness,
  }) {
    Object.assign(this, {
      adapter,
      readNative,
      readPublic,
      github,
      compatibilityReadiness,
      verifyCompatibility:
        verifyCompatibility ?? compatibilityReadiness?.verify.bind(compatibilityReadiness),
    });
  }
  async verify(snapshot, options = {}) {
    need(
      typeof this.verifyCompatibility === 'function' || options.compatibility,
      'RELEASE_STATIC_COMPATIBILITY_AUTHORITY_NOT_INSTALLED'
    );
    const { queue: q, receipts } = snapshot;
    const built = receipts.BUILD.data.artifact.components['club-arena-web'];
    need(built && fullSha.test(built.source_sha) && artifactIdentity.test(built.identity));
    const compatibility = options.compatibility ?? (await this.verifyCompatibility(snapshot));
    const mixed = snapshot.queue.resolution_manifest.components.some(
      (c) => c.target === 'club-arena-engine'
    );
    if (mixed) validateMixedCompatibility(snapshot, compatibility);
    need(
      compatibility?.verified === true &&
        compatibility.manifest_digest === q.resolution_manifest_digest &&
        compatibility.source_sha === built.source_sha &&
        Array.isArray(compatibility.receipt_refs) &&
        compatibility.receipt_refs.length > 0 &&
        (mixed || compatibility.retained_components?.['club-arena-engine']?.mode === 'retained')
    );
    const current = await proveExistingArtifact({
      readNative: this.readNative,
      readPublic: this.readPublic,
      priorPublication: async (proof) =>
        requirePriorPublication(
          await this.github(`/repos/${this.adapter.repo}/actions/runs/${proof.build_info.run_id}`),
          await this.github(
            `/repos/${this.adapter.repo}/actions/runs/${proof.build_info.run_id}/jobs?filter=latest&per_page=100`
          ),
          proof
        ),
    });
    const expected_current = {
      source_sha: current.native.source_sha,
      manifest_digest: current.native.manifest_sha256,
    };
    if (compatibility.before_components) {
      const before = compatibility.before_components['club-arena-web'];
      need(
        before?.source_sha === expected_current.source_sha &&
          before.manifest_digest === expected_current.manifest_digest &&
          before.identity === `sha256:${expected_current.manifest_digest}`,
        'RELEASE_STATIC_BASELINE_CHANGED_AFTER_QUALIFICATION'
      );
    }
    const request = {
      static_version: 1,
      phase: 'PUBLISH',
      target: 'club-arena-web',
      repository: this.adapter.repo,
      repository_id: this.adapter.repositoryId,
      control_sha: built.control_sha ?? this.adapter.controlSha,
      ...(built.control_closure ? { control_closure: built.control_closure } : {}),
      workflow_id: this.adapter.workflowId,
      source_sha: built.source_sha,
      manifest_digest: q.resolution_manifest_digest,
      build_operation_id: built.build_operation_id,
      build_run_id: built.build_run_id,
      artifact: built,
      expected_current,
      not_after_epoch: Math.floor(Date.parse(q.attempt_deadline) / 1000),
    };
    await this.adapter.preflight(request);
    return {
      compatibility_verified: true,
      technical_gates_passed: true,
      expected_current,
      static_expected_current: expected_current,
      retained_components: compatibility.retained_components,
      compatibility_receipt_refs: compatibility.receipt_refs,
      ...(compatibility.semantic
        ? {
            compatibility_operation_id: compatibility.compatibility_operation_id,
            semantic_qualification: compatibility.semantic,
          }
        : {}),
      provider_requests: { 'github-static': request },
    };
  }
}
