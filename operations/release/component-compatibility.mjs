import {
  requireCertificate as need,
  fullSha,
  artifactIdentity,
  uuid,
  factDigest,
  sameFacts,
} from './component-certificate.mjs';
import { readReceiptArchive } from './adapters/github.mjs';

const targets = ['club-arena-engine', 'club-arena-web'];
function component(value, target) {
  need(fullSha.test(value?.source_sha) && artifactIdentity.test(value.identity));
  if (target === 'club-arena-web') need(value.identity === `sha256:${value.manifest_digest}`);
  return {
    source_sha: value.source_sha,
    identity: value.identity,
    ...(target === 'club-arena-web' ? { manifest_digest: value.manifest_digest } : {}),
  };
}
// Semantic qualification must cover the actual sequential states. A passing
// final tuple says nothing about the intermediate engine/web combination.
export function compatibilityPlan(snapshot, before, contract) {
  const { queue: q, receipts } = snapshot;
  const build = receipts.BUILD;
  need(
    contract?.version === 1 &&
      uuid.test(build?.event_id) &&
      uuid.test(build.data.aggregate_operation_id) &&
      fullSha.test(build.data.source_sha) &&
      /^[0-9a-f]{64}$/.test(contract.schema?.fixture_sha256) &&
      /^[0-9a-f]{64}$/.test(contract.schema?.catalogue_digest) &&
      /^[0-9a-f]{64}$/.test(contract.schema?.database_contract_digest) &&
      /^[1-9][0-9]*$/.test(contract.schema?.artifact_id) &&
      artifactIdentity.test(contract.schema?.archive_digest)
  );
  const changed = q.resolution_manifest.components.map((c) => c.target).sort();
  need(
    changed.includes('club-arena-web') &&
      changed.every((t) => targets.includes(t)) &&
      Array.isArray(contract.cutover_order) &&
      sameFacts([...contract.cutover_order].sort(), changed)
  );
  const current = Object.fromEntries(targets.map((t) => [t, component(before[t], t)]));
  const matrix = [structuredClone(current)];
  const builds = {};
  for (const target of contract.cutover_order) {
    const built = build.data.artifact.components[target];
    need(
      uuid.test(built.build_operation_id) &&
        uuid.test(built.qualification_result_event) &&
        /^[1-9][0-9]*$/.test(built.build_run_id) &&
        /^[1-9][0-9]*$/.test(built.github_artifact_id) &&
        artifactIdentity.test(built.github_archive_digest) &&
        built.aggregate_operation_id === build.data.aggregate_operation_id
    );
    builds[target] = {
      ...component(built, target),
      build_operation_id: built.build_operation_id,
      build_run_id: built.build_run_id,
      qualification_result_event: built.qualification_result_event,
      artifact_id: built.github_artifact_id,
      archive_digest: built.github_archive_digest,
    };
    current[target] = component(built, target);
    matrix.push(structuredClone(current));
  }
  const inputs = {};
  for (const tuple of matrix)
    for (const target of targets) {
      const c = tuple[target],
        key = factDigest({ target, ...c });
      if (inputs[key]) continue;
      const provenance = sameFacts(c, component(before[target], target))
        ? contract.retained_artifacts?.[target]
        : builds[target];
      need(
        provenance &&
          sameFacts(component(provenance, target), c) &&
          /^[1-9][0-9]*$/.test(provenance.build_run_id) &&
          /^[1-9][0-9]*$/.test(provenance.artifact_id) &&
          artifactIdentity.test(provenance.archive_digest),
        'RELEASE_RETAINED_COMPONENT_ARTIFACT_REQUIRED'
      );
      inputs[key] = {
        target,
        ...c,
        build_run_id: provenance.build_run_id,
        artifact_id: provenance.artifact_id,
        archive_digest: provenance.archive_digest,
      };
    }
  need(
    /^[1-9][0-9]*$/.test(contract.schema.build_run_id),
    'RELEASE_SCHEMA_FIXTURE_PROVENANCE_REQUIRED'
  );
  return {
    version: 1,
    release_id: q.release_id,
    manifest_digest: q.resolution_manifest_digest,
    build_receipt: build.event_id,
    aggregate_operation_id: build.data.aggregate_operation_id,
    source_sha: build.data.source_sha,
    component_builds: builds,
    cutover_order: contract.cutover_order,
    schema: contract.schema,
    artifact_inputs: inputs,
    tuples: matrix,
  };
}

// This is an artifact verifier for the separately trusted semantic qualifier.
// It does not generate passing semantic results from a manifest, a catalog, or
// reachable endpoints. The installed qualification workflow must actually test
// these combinations against the exact schema fixture before writing evidence.
export class GitHubComponentCompatibility {
  constructor({
    repositoryId,
    workflowId,
    workflowPath,
    controlRef,
    controlSha,
    runtimeImage,
    request,
  }) {
    need(
      /^[1-9][0-9]*$/.test(String(repositoryId)) &&
        Number.isSafeInteger(workflowId) &&
        workflowId > 0 &&
        workflowPath === '.github/workflows/release-component-qualification.yml' &&
        fullSha.test(controlSha) &&
        /^heads\/[A-Za-z0-9_./-]+$/.test(controlRef) &&
        /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/.test(runtimeImage),
      'RELEASE_SEMANTIC_QUALIFIER_INSTALLATION_REQUIRED'
    );
    Object.assign(this, {
      repositoryId: String(repositoryId),
      workflowId,
      workflowPath,
      controlRef,
      controlSha,
      runtimeImage,
      request,
    });
  }
  validate(r) {
    need(
      r?.phase === 'COMPATIBILITY' &&
        r.repository === 'Smarter-Poker/Smarter-Poker-Club-Arena' &&
        targets.includes(r.target) &&
        r.control_sha === this.controlSha &&
        r.workflow_id === this.workflowId &&
        r.runtime_image === this.runtimeImage &&
        /^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$/.test(r.runtime_image) &&
        ['source_sha', 'accepted_head_sha', 'expected_base_sha', 'tested_tree_sha'].every((k) =>
          fullSha.test(r[k])
        ) &&
        r.qualification?.source_sha === r.source_sha &&
        r.qualification?.manifest_digest === r.manifest_digest &&
        uuid.test(r.qualification?.aggregate_operation_id),
      'RELEASE_COMPATIBILITY_REQUEST_REFUSED'
    );
  }
  requestFor(plan, snapshot) {
    const q = snapshot.queue;
    const r = {
      phase: 'COMPATIBILITY',
      repository: 'Smarter-Poker/Smarter-Poker-Club-Arena',
      target: snapshot.admission.intent.target,
      source_sha: plan.source_sha,
      accepted_head_sha: q.resolution_head_sha,
      expected_base_sha: snapshot.receipts.INTEGRATION.data.expected_base_sha,
      tested_tree_sha: snapshot.receipts.INTEGRATION.data.merged_tree_sha,
      manifest_digest: plan.manifest_digest,
      control_sha: this.controlSha,
      workflow_id: this.workflowId,
      runtime_image: this.runtimeImage,
      qualification: plan,
    };
    this.validate(r);
    return r;
  }
  async preflight(r) {
    this.validate(r);
    const workflow = await this.request(
      `/repos/${r.repository}/actions/workflows/${this.workflowId}`
    );
    need(
      workflow.id === this.workflowId &&
        workflow.path === this.workflowPath &&
        workflow.state === 'active',
      'RELEASE_SEMANTIC_QUALIFIER_INSTALLATION_REQUIRED'
    );
    const ref = await this.request(`/repos/${r.repository}/git/ref/${this.controlRef}`);
    need(
      ref.object?.type === 'commit' && ref.object.sha === this.controlSha,
      'RELEASE_COMPATIBILITY_CONTROL_CHANGED'
    );
  }
  async submit(r, operation) {
    await this.preflight(r);
    need(uuid.test(operation?.id));
    // Only ProviderRunner calls this after its immutable external intent and
    // submission authorization commit. A lost response is reconciliation-only.
    await this.request(`/repos/${r.repository}/actions/workflows/${this.workflowId}/dispatches`, {
      method: 'POST',
      body: {
        ref: this.controlRef.slice(6),
        inputs: { operation_id: operation.id, request: JSON.stringify(r) },
      },
    });
    return { terminal: false, reason: 'COMPATIBILITY_RESPONSE_REQUIRES_EXACT_READBACK' };
  }
  async reconcile(r, operation) {
    this.validate(r);
    need(uuid.test(operation?.id));
    const result = await this.inspect(r.qualification, operation.id, r);
    if (!result.terminal) return result;
    if (result.outcome !== 'SUCCEEDED') return result;
    return {
      ...result,
      proof: {
        operation_id: operation.id,
        request: r,
        control_sha: this.controlSha,
        run_id: result.proof.run_id,
        run_attempt: 1,
        success: true,
        compatibility: result.proof,
      },
    };
  }
  async verify(plan, operationId) {
    const result = await this.inspect(plan, operationId);
    need(
      result.terminal && result.outcome === 'SUCCEEDED',
      'RELEASE_SEMANTIC_QUALIFICATION_REQUIRED'
    );
    return result.proof;
  }
  async inspect(plan, operationId, wrapper) {
    need(uuid.test(operationId), 'RELEASE_COMPATIBILITY_OPERATION_REQUIRED');
    const prefix = '/repos/Smarter-Poker/Smarter-Poker-Club-Arena';
    const workflow = await this.request(`${prefix}/actions/workflows/${this.workflowId}`);
    need(
      workflow.id === this.workflowId &&
        workflow.path === this.workflowPath &&
        workflow.state === 'active',
      'RELEASE_SEMANTIC_QUALIFIER_INSTALLATION_REQUIRED'
    );
    const title = `release:${operationId}:COMPATIBILITY`;
    const inventory = await this.request(
      `${prefix}/actions/workflows/${this.workflowId}/runs?event=workflow_dispatch&head_sha=${this.controlSha}&per_page=100`
    );
    need(
      Array.isArray(inventory.workflow_runs) &&
        inventory.total_count === inventory.workflow_runs.length &&
        inventory.total_count <= 100,
      'RELEASE_COMPATIBILITY_RUN_INVENTORY_REQUIRED'
    );
    const found = inventory.workflow_runs.filter((r) => r.display_title === title);
    if (!found.length) return { terminal: false, reason: 'COMPATIBILITY_RUN_NOT_VISIBLE' };
    need(found.length === 1, 'RELEASE_COMPATIBILITY_RUN_AMBIGUOUS');
    const run = await this.request(`${prefix}/actions/runs/${found[0].id}`);
    const validRun = (r) =>
      r.id === found[0].id &&
      Number.isSafeInteger(r.id) &&
      r.workflow_id === this.workflowId &&
      r.path === this.workflowPath &&
      r.head_sha === this.controlSha &&
      r.event === 'workflow_dispatch' &&
      r.display_title === title &&
      r.run_attempt === 1 &&
      String(r.repository?.id) === this.repositoryId &&
      String(r.head_repository?.id) === this.repositoryId;
    need(validRun(run), 'RELEASE_COMPATIBILITY_RUN_REFUSED');
    if (run.status !== 'completed')
      return { terminal: false, reason: 'COMPATIBILITY_RUN_IN_PROGRESS' };
    const artifacts = await this.request(`${prefix}/actions/runs/${run.id}/artifacts?per_page=100`);
    need(
      Array.isArray(artifacts.artifacts) &&
        artifacts.total_count === artifacts.artifacts.length &&
        artifacts.total_count <= 100
    );
    if (run.conclusion !== 'success') {
      const cleanupArtifacts = artifacts.artifacts.filter(
        (a) => a.name === `release-compatibility-cleanup-${operationId}`
      );
      const uncertain = () => ({
        terminal: false,
        reason: 'COMPATIBILITY_FAILURE_CLEANUP_UNPROVEN',
        provider_operation_id: String(run.id),
      });
      if (
        cleanupArtifacts.length !== 1 ||
        cleanupArtifacts[0].expired ||
        !artifactIdentity.test(cleanupArtifacts[0].digest)
      )
        return uncertain();
      const cleanupArtifact = cleanupArtifacts[0];
      const cleanup = readReceiptArchive(
        await this.request(`${prefix}/actions/artifacts/${cleanupArtifact.id}/zip`, {
          archive: true,
        }),
        cleanupArtifact.digest
      );
      if (
        cleanup?.version !== 1 ||
        cleanup.complete !== true ||
        cleanup.images_removed !== true ||
        cleanup.operation_id !== operationId ||
        cleanup.run_id !== String(run.id) ||
        cleanup.run_attempt !== 1 ||
        cleanup.request_digest !== factDigest(plan) ||
        !Array.isArray(cleanup.fixtures) ||
        cleanup.fixtures.length > plan.tuples.length ||
        !cleanup.fixtures.every(
          (item, index) =>
            item.index === index &&
            item.complete === true &&
            item.remaining_objects === 0 &&
            item.tuple_digest === factDigest(plan.tuples[index])
        )
      )
        return uncertain();
      const finalRun = await this.request(`${prefix}/actions/runs/${run.id}`);
      need(
        validRun(finalRun) &&
          finalRun.status === 'completed' &&
          finalRun.conclusion === run.conclusion,
        'RELEASE_COMPATIBILITY_RUN_CHANGED'
      );
      return {
        terminal: true,
        outcome: 'FAILED',
        accepted: true,
        provider_operation_id: String(run.id),
        reason: 'COMPATIBILITY_EXECUTION_FAILED_FIXTURE_CLEANUP_VERIFIED',
        proof: {
          operation_id: operationId,
          request: wrapper,
          control_sha: this.controlSha,
          run_id: String(run.id),
          run_attempt: 1,
          success: false,
          cleanup,
          cleanup_artifact_id: String(cleanupArtifact.id),
          cleanup_archive_digest: cleanupArtifact.digest,
        },
      };
    }
    const matches = artifacts.artifacts.filter(
      (a) => a.name === `release-compatibility-${operationId}`
    );
    need(
      matches.length === 1 && !matches[0].expired && artifactIdentity.test(matches[0].digest),
      'RELEASE_SEMANTIC_QUALIFICATION_REQUIRED'
    );
    const artifact = matches[0];
    const proof = readReceiptArchive(
      await this.request(`${prefix}/actions/artifacts/${artifact.id}/zip`, { archive: true }),
      artifact.digest
    );
    need(
      proof.version === 1 &&
        proof.success === true &&
        proof.operation_id === operationId &&
        proof.control_sha === this.controlSha &&
        proof.runtime_image === this.runtimeImage &&
        (!wrapper || sameFacts(proof.provider_request, wrapper)) &&
        proof.run_id === String(run.id) &&
        proof.run_attempt === 1 &&
        sameFacts(proof.request, plan) &&
        proof.request_digest === factDigest(plan) &&
        proof.cleanup?.complete === true &&
        proof.cleanup.images_removed === true &&
        proof.cleanup.operation_id === operationId &&
        proof.cleanup.run_id === String(run.id) &&
        proof.cleanup.run_attempt === 1 &&
        proof.cleanup.request_digest === factDigest(plan) &&
        Array.isArray(proof.cleanup.fixtures) &&
        proof.cleanup.fixtures.length === plan.tuples.length &&
        proof.cleanup.fixtures.every(
          (item, index) =>
            item.index === index &&
            item.complete === true &&
            item.remaining_objects === 0 &&
            item.tuple_digest === factDigest(plan.tuples[index])
        ) &&
        Array.isArray(proof.combinations) &&
        proof.combinations.length === plan.tuples.length,
      'RELEASE_SEMANTIC_QUALIFICATION_MISMATCH'
    );
    for (let i = 0; i < plan.tuples.length; i++) {
      const checked = proof.combinations[i];
      need(
        checked.tuple_digest === factDigest(plan.tuples[i]) &&
          checked.schema_fixture_sha256 === plan.schema.fixture_sha256 &&
          checked.component_builds_digest === factDigest(plan.component_builds) &&
          checked.success === true &&
          checked.failed === 0 &&
          checked.retries === 0 &&
          checked.skipped === 0 &&
          checked.executed === 5 &&
          checked.cleanup?.complete === true &&
          checked.cleanup.remaining_objects === 0 &&
          checked.native?.scope === 'club-arena-product' &&
          sameFacts(checked.native.tuple, plan.tuples[i]) &&
          checked.native.schema_fixture_sha256 === plan.schema.fixture_sha256 &&
          checked.native.schema_catalogue_digest === plan.schema.catalogue_digest &&
          checked.native.runtime_image === this.runtimeImage &&
          checked.native.product_suite === 'live-table-schema-v1' &&
          checked.native.success === true &&
          checked.native.executed === checked.executed &&
          checked.native.failed === 0 &&
          checked.native.skipped === 0 &&
          checked.native.retries === 0 &&
          sameFacts(
            checked.native.cases,
            [
              'exact-schema-catalogue',
              'authenticated-web-bundle',
              'engine-browser-causal-hand',
              'completed-hand-persisted',
              'spectator-does-not-acquire-seat',
            ].map((name) => ({ name, passed: true }))
          ) &&
          checked.native_receipt_digest === `sha256:${factDigest(checked.native)}` &&
          artifactIdentity.test(checked.native_receipt_digest) &&
          /^[1-9][0-9]*$/.test(checked.job_id),
        'RELEASE_UNCOVERED_COMPONENT_COMBINATION'
      );
    }
    const jobs = await this.request(
      `${prefix}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`
    );
    need(
      Array.isArray(jobs.jobs) &&
        jobs.total_count === jobs.jobs.length &&
        jobs.total_count <= 100 &&
        proof.combinations.every((c) =>
          jobs.jobs.some(
            (j) =>
              String(j.id) === c.job_id && j.status === 'completed' && j.conclusion === 'success'
          )
        ),
      'RELEASE_COMPATIBILITY_EXECUTION_REQUIRED'
    );
    const finalRun = await this.request(`${prefix}/actions/runs/${run.id}`);
    need(
      validRun(finalRun) && finalRun.status === 'completed' && finalRun.conclusion === 'success',
      'RELEASE_COMPATIBILITY_RUN_CHANGED'
    );
    return {
      terminal: true,
      outcome: 'SUCCEEDED',
      accepted: true,
      provider_operation_id: String(run.id),
      proof: {
        version: 1,
        verified: true,
        request: plan,
        request_digest: factDigest(plan),
        operation_id: operationId,
        control_sha: this.controlSha,
        workflow_id: this.workflowId,
        workflow_path: this.workflowPath,
        run_id: String(run.id),
        run_attempt: 1,
        artifact_id: String(artifact.id),
        archive_digest: artifact.digest,
        combinations: proof.combinations,
        cleanup: proof.cleanup,
      },
    };
  }
}
