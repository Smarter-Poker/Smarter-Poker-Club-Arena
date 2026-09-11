import { GitHubWorkflowAdapter } from './github.mjs';
import { certificateSnapshot } from '../certificate-proof.mjs';
import { operationPolicy, operationPolicyDigest } from '../operation-policy.mjs';

const need = (v) => { if (!v) throw new Error('RELEASE_CERTIFICATION_CONTRACT_REFUSED'); };
export class GitHubCertificationAdapter extends GitHubWorkflowAdapter {
  constructor({ publicationReadback, publicJSON, now = Date.now, ...config }) {
    super({ ...config, workflowPath: '.github/workflows/post-deploy-e2e.yml' });
    Object.assign(this, { publicationReadback, publicJSON, now });
  }
  validate(r) {
    need(r?.repository === this.repo && r.phase === 'CERTIFY' && r.target === 'club-arena-engine' &&
      r.control_sha === this.controlSha && r.workflow_id === this.workflowId &&
      /^[0-9a-f]{40}$/.test(r.source_sha) && /^[0-9a-f]{40}$/.test(r.frontend_source_sha) &&
      /^[0-9a-f]{64}$/.test(r.manifest_digest) && /^sha256:[0-9a-f]{64}$/.test(r.artifact_image_id) &&
      /^[0-9a-f-]{36}$/.test(r.publication_operation_id) && r.operation_policy_digest === operationPolicyDigest);
  }
  async preflight(r, operation) {
    await super.preflight(r, operation);
    const publication = await this.publicationReadback(r);
    need(publication.terminal === true && publication.outcome === 'SUCCEEDED' && publication.image_id === r.artifact_image_id);
    const served = await certificateSnapshot(r, this.publicJSON);
    return { ...served, operation_policy_digest: operationPolicyDigest };
  }
  async reconcile(r, operation) {
    const result = await super.reconcile(r, operation);
    if (result.terminal && result.outcome !== 'SUCCEEDED') return result;
    // Every bounded pending readback also samples the resumed exact release.
    // A gap over two sample periods or instance change restarts observation.
    const current = await certificateSnapshot(r, this.publicJSON);
    const now = this.now(), previous = operation.previous_observation;
    const same = previous?.engine_instance === current.engine_instance &&
      previous?.maintenance_activation_receipt === current.maintenance_activation_receipt &&
      Number.isFinite(previous.observed_at_ms) && now >= previous.observed_at_ms && now - previous.observed_at_ms <= 120000;
    const stableSince = same && Number.isFinite(previous.stable_since_ms) ? previous.stable_since_ms : now;
    const evidence = { ...current, observed_at_ms: now, stable_since_ms: stableSince,
      required_observation_ms: operationPolicy.postResumeObservationMs };
    if (!result.terminal || now - stableSince < operationPolicy.postResumeObservationMs)
      return { ...result, ...evidence, terminal: false, reason: result.terminal ? 'POST_RESUME_OBSERVATION_PENDING' : result.reason };
    const proof = result.proof;
    need(proof.cleanup_complete === true && proof.unchanged_release === true &&
      proof.served_components?.['club-arena-engine']?.identity === r.artifact_image_id &&
      proof.engine_instance === current.engine_instance && proof.frontend_source_sha === r.frontend_source_sha);
    const publication = await this.publicationReadback(r);
    need(publication.terminal === true && publication.outcome === 'SUCCEEDED' && publication.image_id === r.artifact_image_id);
    return { ...result, ...evidence, terminal: true, outcome: 'SUCCEEDED' };
  }
}
