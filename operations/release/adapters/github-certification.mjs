import { GitHubWorkflowAdapter } from './github.mjs';
import { certificateSnapshot } from '../certificate-proof.mjs';
import { operationPolicy, operationPolicyDigest } from '../operation-policy.mjs';
import { validateComponentRequest, sameFacts, reportsPassed } from '../component-certificate.mjs';

const need = (v) => {
  if (!v) throw new Error('RELEASE_CERTIFICATION_CONTRACT_REFUSED');
};
export class GitHubCertificationAdapter extends GitHubWorkflowAdapter {
  constructor({ publicationReadback, componentReadback, publicJSON, now = Date.now, ...config }) {
    super({ ...config, workflowPath: '.github/workflows/post-deploy-e2e.yml' });
    Object.assign(this, { publicationReadback, componentReadback, publicJSON, now });
  }
  validate(r) {
    if (r?.certificate_version === 2) {
      validateComponentRequest(r, r.release_id, {
        GITHUB_REPOSITORY: this.repo,
        GITHUB_SHA: this.controlSha,
      });
      need(r.workflow_id === this.workflowId);
      return;
    }
    need(
      r?.repository === this.repo &&
        r.phase === 'CERTIFY' &&
        r.target === 'club-arena-engine' &&
        r.control_sha === this.controlSha &&
        r.workflow_id === this.workflowId &&
        /^[0-9a-f]{40}$/.test(r.source_sha) &&
        /^[0-9a-f]{40}$/.test(r.frontend_source_sha) &&
        /^[0-9a-f]{64}$/.test(r.manifest_digest) &&
        /^sha256:[0-9a-f]{64}$/.test(r.artifact_image_id) &&
        /^[0-9a-f-]{36}$/.test(r.publication_operation_id) &&
        r.operation_policy_digest === operationPolicyDigest
    );
  }
  async preflight(r, operation) {
    await super.preflight(r, operation);
    if (r.certificate_version === 2) {
      need(typeof this.componentReadback === 'function');
      const observed = await this.componentReadback(r, operation);
      need(sameFacts(observed.served_components, r.component_tuple));
      return observed;
    }
    const publication = await this.publicationReadback(r);
    need(
      publication.terminal === true &&
        publication.outcome === 'SUCCEEDED' &&
        publication.image_id === r.artifact_image_id
    );
    const served = await certificateSnapshot(r, this.publicJSON);
    return { ...served, operation_policy_digest: operationPolicyDigest };
  }
  receiptRequiredOnFailure(r) {
    return r?.certificate_version === 2;
  }
  async correlatedRun(r, operation, recovery) {
    const title = recovery ? `release:${recovery.id}:CLEANUP` : `release:${operation.id}:CERTIFY`;
    const created = recovery?.created_at ?? operation.created_at;
    need(Number.isFinite(Date.parse(created)));
    const list = await this.request(
      `/repos/${this.repo}/actions/workflows/${this.workflowId}/runs?event=workflow_dispatch&head_sha=${this.controlSha}&created=${encodeURIComponent(`>=${created}`)}&per_page=100`
    );
    need(Array.isArray(list.workflow_runs) && list.total_count <= 100);
    const matches = list.workflow_runs.filter((run) => run.display_title === title);
    need(matches.length === 1 && Number.isSafeInteger(matches[0].id));
    const run = await this.request(`/repos/${this.repo}/actions/runs/${matches[0].id}`);
    need(
      run.id === matches[0].id &&
        run.display_title === title &&
        run.run_attempt === 1 &&
        run.workflow_id === this.workflowId &&
        run.head_sha === this.controlSha &&
        run.path === this.workflowPath &&
        run.event === 'workflow_dispatch' &&
        String(run.repository?.id) === r.repository_id &&
        String(run.head_repository?.id) === r.repository_id
    );
    return run;
  }
  async cleanupOriginal(r, operation) {
    const run = await this.correlatedRun(r, operation);
    need(
      run.status === 'completed' &&
        [
          'success',
          'failure',
          'cancelled',
          'timed_out',
          'action_required',
          'neutral',
          'skipped',
          'stale',
        ].includes(run.conclusion)
    );
    return {
      operation_id: operation.id,
      repository_id: r.repository_id,
      workflow_id: String(this.workflowId),
      control_sha: this.controlSha,
      run_id: String(run.id),
      run_attempt: 1,
      status: run.status,
      conclusion: run.conclusion,
    };
  }
  async submitCleanup(r, operation, recovery) {
    // Preflight has been re-read before the controller's committed dispatch
    // authorization. A lost response leaves this one dispatch owned forever.
    need(recovery.operation_id === operation.id && recovery.may_submit === true);
    await this.request(`/repos/${this.repo}/actions/workflows/${this.workflowId}/dispatches`, {
      method: 'POST',
      body: {
        ref: this.controlRef.slice(6),
        inputs: {
          operation_id: operation.id,
          request: JSON.stringify(r),
          cleanup_recovery_id: recovery.id,
        },
      },
    });
  }
  async reconcileCleanup(r, operation) {
    const recovery = operation.cleanup_recovery;
    const run = await this.correlatedRun(r, operation, recovery);
    const cleanup = operation.fixture_cleanup;
    if (
      run.status !== 'completed' ||
      run.conclusion !== 'success' ||
      !cleanup ||
      cleanup.data.run_id !== String(run.id)
    )
      return {
        terminal: false,
        reason: 'CERTIFICATION_CLEANUP_RECOVERY_PENDING',
        recovery_id: recovery.id,
      };
    const original = await this.cleanupOriginal(r, operation);
    need(sameFacts(original, recovery.original_run));
    return {
      terminal: true,
      outcome: original.conclusion === 'cancelled' ? 'CANCELLED' : 'FAILED',
      provider_operation_id: original.run_id,
      reason: 'ORIGINAL_CERTIFICATE_FAILED_CLEANUP_RECOVERED',
      proof: {
        operation_id: operation.id,
        control_sha: r.control_sha,
        request: r,
        run_id: original.run_id,
        run_attempt: 1,
        success: false,
        cleanup_complete: true,
        cleanup_receipt: cleanup.event_id,
        cleanup_recovery_id: recovery.id,
        cleanup_run_id: String(run.id),
        original_conclusion: original.conclusion,
      },
    };
  }
  async reconcile(r, operation) {
    if (r.certificate_version === 2 && operation.cleanup_recovery)
      return this.reconcileCleanup(r, operation);
    let result;
    try {
      result = await super.reconcile(r, operation);
    } catch (error) {
      if (r.certificate_version !== 2) throw error;
      const original = await this.cleanupOriginal(r, operation);
      return {
        terminal: false,
        cleanup_required: true,
        original_run: original,
        reason: 'TERMINAL_CERTIFICATE_PROOF_UNAVAILABLE',
      };
    }
    if (r.certificate_version === 2) {
      if (!result.terminal) {
        const run = await this.correlatedRun(r, operation);
        if (run.status === 'completed')
          return {
            terminal: false,
            cleanup_required: true,
            reason: 'TERMINAL_CERTIFICATE_CLEANUP_UNPROVEN',
          };
      }
      if (result.terminal && result.outcome !== 'SUCCEEDED') {
        need(
          result.proof?.success === false &&
            result.proof.cleanup_complete === true &&
            typeof result.proof.cleanup_receipt === 'string' &&
            result.proof.run_attempt === 1
        );
        return result;
      }
      need(typeof this.componentReadback === 'function');
      const current = await this.componentReadback(r, operation);
      need(sameFacts(current.served_components, r.component_tuple));
      const now = this.now(),
        previous = operation.previous_observation;
      const same =
        previous?.engine_instance === current.engine_instance &&
        previous?.maintenance_activation_receipt === current.maintenance_activation_receipt &&
        Number.isFinite(previous.observed_at_ms) &&
        now >= previous.observed_at_ms &&
        now - previous.observed_at_ms <= 120000;
      const stableSince =
        same && Number.isFinite(previous.stable_since_ms) ? previous.stable_since_ms : now;
      const required =
        r.component_tuple['club-arena-engine'].mode === 'changed'
          ? operationPolicy.postResumeObservationMs
          : 0;
      const evidence = {
        ...current,
        observed_at_ms: now,
        stable_since_ms: stableSince,
        required_observation_ms: required,
      };
      if (!result.terminal || now - stableSince < required)
        return {
          ...result,
          ...evidence,
          terminal: false,
          reason: result.terminal ? 'POST_RESUME_OBSERVATION_PENDING' : result.reason,
        };
      need(
        result.proof.run_attempt === 1 &&
          result.proof.cleanup_complete === true &&
          typeof result.proof.cleanup_receipt === 'string' &&
          result.proof.unchanged_release === true &&
          sameFacts(result.proof.served_components, r.component_tuple) &&
          result.proof.engine_instance === current.engine_instance &&
          reportsPassed(result.proof.reports)
      );
      return { ...result, ...evidence };
    }
    if (result.terminal && result.outcome !== 'SUCCEEDED') return result;
    // Every bounded pending readback also samples the resumed exact release.
    // A gap over two sample periods or instance change restarts observation.
    const current = await certificateSnapshot(r, this.publicJSON);
    const now = this.now(),
      previous = operation.previous_observation;
    const same =
      previous?.engine_instance === current.engine_instance &&
      previous?.maintenance_activation_receipt === current.maintenance_activation_receipt &&
      Number.isFinite(previous.observed_at_ms) &&
      now >= previous.observed_at_ms &&
      now - previous.observed_at_ms <= 120000;
    const stableSince =
      same && Number.isFinite(previous.stable_since_ms) ? previous.stable_since_ms : now;
    const evidence = {
      ...current,
      observed_at_ms: now,
      stable_since_ms: stableSince,
      required_observation_ms: operationPolicy.postResumeObservationMs,
    };
    if (!result.terminal || now - stableSince < operationPolicy.postResumeObservationMs)
      return {
        ...result,
        ...evidence,
        terminal: false,
        reason: result.terminal ? 'POST_RESUME_OBSERVATION_PENDING' : result.reason,
      };
    const proof = result.proof;
    need(
      proof.cleanup_complete === true &&
        proof.unchanged_release === true &&
        proof.served_components?.['club-arena-engine']?.identity === r.artifact_image_id &&
        proof.engine_instance === current.engine_instance &&
        proof.frontend_source_sha === r.frontend_source_sha
    );
    const publication = await this.publicationReadback(r);
    need(
      publication.terminal === true &&
        publication.outcome === 'SUCCEEDED' &&
        publication.image_id === r.artifact_image_id
    );
    return { ...result, ...evidence, terminal: true, outcome: 'SUCCEEDED' };
  }
}
