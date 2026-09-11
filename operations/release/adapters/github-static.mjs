import { readReceiptArchive } from './github.mjs';
import {
  requireCertificate as need,
  fullSha,
  artifactIdentity,
  uuid,
  sameFacts,
} from '../component-certificate.mjs';
import { proveExistingArtifact, publicDocuments } from '../frontend-artifact-proof.mjs';
import { proveStaticControl, validateStaticControlReceipt } from '../static-control-closure.mjs';

const workflowPath = '.github/workflows/publish-club-arena.yml';
const pending = (reason, run) => ({
  terminal: false,
  reason,
  ...(run ? { provider_operation_id: String(run.id) } : {}),
});
// One existing publisher run owns build and host transaction. PUBLISH does not
// dispatch another run: its durable submit authorization releases that run's
// authenticated wait gate. A lost grant response is reconciliation-only.
export class GitHubStaticAdapter {
  constructor({
    repo,
    repositoryId,
    controlSha,
    workflowId,
    request,
    readNative,
    installedControlReceipt,
    readPublic = publicDocuments,
  }) {
    need(
      repo === 'Smarter-Poker/Smarter-Poker-Club-Arena' &&
        /^[1-9][0-9]*$/.test(String(repositoryId)) &&
        fullSha.test(controlSha) &&
        Number.isSafeInteger(workflowId) &&
        workflowId > 0
    );
    Object.assign(this, {
      repo,
      repositoryId: String(repositoryId),
      controlSha,
      workflowId,
      request,
      readNative,
      installedControlReceipt,
      readPublic,
    });
    if (installedControlReceipt) {
      validateStaticControlReceipt(installedControlReceipt);
      need(
        installedControlReceipt.source_sha === controlSha &&
          installedControlReceipt.repository_id === this.repositoryId
      );
    }
  }
  async qualifyControl(sourceSha) {
    need(this.installedControlReceipt, 'RELEASE_STATIC_CONTROL_INSTALLATION_REQUIRED');
    return proveStaticControl({
      request: this.request,
      installedReceipt: this.installedControlReceipt,
      sourceSha,
      workflowId: this.workflowId,
    });
  }
  validate(r) {
    need(
      r?.static_version === 1 &&
        r.repository === this.repo &&
        String(r.repository_id) === this.repositoryId &&
        r.target === 'club-arena-web' &&
        ['BUILD', 'PUBLISH'].includes(r.phase) &&
        (r.control_sha === this.controlSha ||
          (this.installedControlReceipt &&
            fullSha.test(r.control_sha) &&
            r.control_sha === r.source_sha &&
            sameFacts(r.control_closure, {
              version: 1,
              installed_control_sha: this.controlSha,
              control_sha: r.control_sha,
              repository_id: this.repositoryId,
              workflow_id: this.workflowId,
              closure_digest: this.installedControlReceipt.digest,
              file_count: this.installedControlReceipt.files.length,
            }))) &&
        r.workflow_id === this.workflowId &&
        fullSha.test(r.source_sha) &&
        /^[0-9a-f]{64}$/.test(r.manifest_digest) &&
        Number.isSafeInteger(r.not_after_epoch)
    );
    if (r.phase === 'PUBLISH')
      need(
        uuid.test(r.build_operation_id) &&
          /^[1-9][0-9]*$/.test(r.build_run_id) &&
          artifactIdentity.test(r.artifact.identity) &&
          r.artifact.identity === `sha256:${r.artifact.manifest_digest}` &&
          r.artifact.source_sha === r.source_sha &&
          /^[1-9][0-9]*$/.test(r.artifact.github_artifact_id) &&
          artifactIdentity.test(r.artifact.github_archive_digest) &&
          fullSha.test(r.expected_current?.source_sha) &&
          /^[0-9a-f]{64}$/.test(r.expected_current?.manifest_digest)
      );
  }
  async preflight(r) {
    this.validate(r);
    if (r.control_closure || r.control_sha !== this.controlSha) {
      need(
        sameFacts(await this.qualifyControl(r.source_sha), r.control_closure),
        'RELEASE_STATIC_CONTROL_UPGRADE_REQUIRED'
      );
    }
    const ref = await this.request(`/repos/${this.repo}/git/ref/heads/main`);
    const workflow = await this.request(`/repos/${this.repo}/actions/workflows/${this.workflowId}`);
    need(
      ref.object?.sha === r.control_sha &&
        r.source_sha === r.control_sha &&
        workflow.id === this.workflowId &&
        workflow.path === workflowPath &&
        workflow.state === 'active' &&
        Date.now() < r.not_after_epoch * 1000
    );
    if (r.phase === 'PUBLISH') {
      const artifact = await this.request(
        `/repos/${this.repo}/actions/artifacts/${r.artifact.github_artifact_id}`
      );
      need(
        String(artifact.id) === r.artifact.github_artifact_id &&
          !artifact.expired &&
          artifact.digest === r.artifact.github_archive_digest &&
          String(artifact.workflow_run?.id) === r.build_run_id
      );
      need(typeof this.readNative === 'function');
      const prior = await this.readNative(r.expected_current.source_sha);
      need(
        prior.source_sha === r.expected_current.source_sha &&
          prior.manifest_sha256 === r.expected_current.manifest_digest
      );
    }
    return {
      control_sha: r.control_sha,
      workflow_id: this.workflowId,
      ...(r.control_closure ? { control_closure: r.control_closure } : {}),
    };
  }
  async submit(r, operation) {
    this.validate(r);
    need(uuid.test(operation.id));
    if (r.phase === 'BUILD')
      await this.request(`/repos/${this.repo}/dispatches`, {
        method: 'POST',
        body: {
          event_type: 'publish-club-arena',
          client_payload: {
            ref_sha: r.source_sha,
            release_operation_id: operation.id,
            release_request: r,
          },
        },
      });
    return pending(
      r.phase === 'BUILD'
        ? 'STATIC_BUILD_DISPATCHED'
        : 'EXISTING_STATIC_RUN_AUTHORIZED_AWAITING_TERMINAL_PROOF'
    );
  }
  async reconcile(r, operation) {
    this.validate(r);
    need(uuid.test(operation.id));
    let run;
    if (r.phase === 'BUILD') {
      const list = await this.request(
        `/repos/${this.repo}/actions/workflows/${this.workflowId}/runs?event=repository_dispatch&head_sha=${r.control_sha}&created=${encodeURIComponent(`>=${operation.created_at}`)}&per_page=100`
      );
      if (!Array.isArray(list.workflow_runs) || list.total_count > 100)
        return pending('STATIC_RUN_INVENTORY_INCOMPLETE');
      const found = list.workflow_runs.filter(
        (x) => x.display_title === `release:${operation.id}:STATIC`
      );
      if (found.length !== 1) return pending('STATIC_EXACT_RUN_UNAVAILABLE');
      [run] = found;
    } else run = await this.request(`/repos/${this.repo}/actions/runs/${r.build_run_id}`);
    need(
      run.workflow_id === this.workflowId &&
        run.path === workflowPath &&
        run.head_sha === r.control_sha &&
        run.event === 'repository_dispatch' &&
        run.head_branch === 'main' &&
        run.run_attempt === 1 &&
        String(run.repository?.id) === this.repositoryId &&
        String(run.head_repository?.id) === this.repositoryId &&
        run.display_title ===
          `release:${r.phase === 'BUILD' ? operation.id : r.build_operation_id}:STATIC`
    );
    const jobs = await this.request(
      `/repos/${this.repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`
    );
    if (
      !Array.isArray(jobs.jobs) ||
      jobs.total_count !== jobs.jobs.length ||
      jobs.total_count > 100
    )
      return pending('STATIC_JOB_INVENTORY_INCOMPLETE', run);
    const named = jobs.jobs.filter(
      (x) => x.name === (r.phase === 'BUILD' ? 'build-and-store' : 'publish-to-origin')
    );
    if (named.length !== 1 || named[0].status !== 'completed' || named[0].conclusion !== 'success')
      return pending('STATIC_EXACT_JOB_NOT_SUCCESSFUL', run);
    const inventory = await this.request(
      `/repos/${this.repo}/actions/runs/${run.id}/artifacts?per_page=100`
    );
    if (!Array.isArray(inventory.artifacts) || inventory.total_count > 100)
      return pending('STATIC_ARTIFACT_INVENTORY_INCOMPLETE', run);
    const matches = inventory.artifacts.filter(
      (x) => x.name === `release-${r.phase === 'BUILD' ? 'build' : 'publication'}-${operation.id}`
    );
    if (matches.length !== 1 || matches[0].expired || !artifactIdentity.test(matches[0].digest))
      return pending('STATIC_RECEIPT_UNAVAILABLE', run);
    const receipt = matches[0],
      proof = readReceiptArchive(
        await this.request(`/repos/${this.repo}/actions/artifacts/${receipt.id}/zip`, {
          archive: true,
        }),
        receipt.digest
      );
    need(
      proof.operation_id === operation.id &&
        proof.control_sha === r.control_sha &&
        proof.run_id === String(run.id) &&
        proof.run_attempt === 1 &&
        proof.job_id === String(named[0].id) &&
        sameFacts(proof.request, r) &&
        proof.success === true
    );
    if (r.phase === 'BUILD') {
      const a = proof.artifact?.components?.['club-arena-web'];
      need(
        a &&
          artifactIdentity.test(a.identity) &&
          a.identity === `sha256:${a.manifest_digest}` &&
          a.source_sha === r.source_sha
      );
      const files = inventory.artifacts.filter((x) => String(x.id) === a.github_artifact_id);
      need(
        files.length === 1 &&
          !files[0].expired &&
          files[0].digest === a.github_archive_digest &&
          files[0].name === `club-arena-dist-${r.source_sha}`
      );
    } else {
      need(sameFacts(proof.component, r.artifact) && typeof this.readNative === 'function');
      const served = await proveExistingArtifact({
        readNative: this.readNative,
        readPublic: this.readPublic,
        priorPublication: async (native) => {
          need(
            native.source_sha === r.source_sha &&
              native.manifest_sha256 === r.artifact.manifest_digest &&
              native.build_info?.run_id === String(run.id)
          );
          return { run_id: String(run.id), run_attempt: 1, origin_job_id: named[0].id };
        },
      });
      need(
        sameFacts(served.native.build_info, proof.native.build_info) &&
          served.native.manifest_sha256 === proof.native.manifest_sha256
      );
    }
    return {
      terminal: true,
      outcome: 'SUCCEEDED',
      provider_operation_id: String(run.id),
      proof,
      receipt_artifact_id: String(receipt.id),
      receipt_archive_digest: receipt.digest,
    };
  }
}
