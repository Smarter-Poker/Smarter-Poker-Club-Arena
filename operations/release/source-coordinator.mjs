import { operationPolicyDigest } from './operation-policy.mjs';
import { call } from './journal.mjs';
import { providerCall } from './provider-journal.mjs';
import {
  validateComponentTuple,
  sameFacts,
  requireCertificate as need,
} from './component-certificate.mjs';
import { mixedCutoverOrder } from './mixed-readiness.mjs';

// The journal remains authoritative across every await and restart. Network
// snapshots are immutable plan inputs; their admission never advances state.
export class SourceCoordinator {
  constructor({ runner, github, readiness, staticReadiness, mixedReadiness, maintenance }) {
    Object.assign(this, {
      runner,
      github,
      readiness,
      staticReadiness,
      mixedReadiness,
      maintenance,
      attemptMilliseconds: 6 * 60 * 60 * 1000,
    });
  }
  get client() {
    return this.runner.client;
  }
  async snapshot() {
    return providerCall(this.client, 'source_snapshot', this.runner.args());
  }
  async transition(q, next) {
    return call(this.client, 'transition', [
      ...this.runner.args(),
      q.release_id,
      q.state_version,
      next,
      this.runner.actor,
      `Selected exact evidence advances to ${next}`,
    ]);
  }
  async selected(q, kind, key, data) {
    const event = await call(this.client, 'record_receipt', [
      ...this.runner.args(),
      q.release_id,
      key,
      kind,
      {
        ...data,
        success: true,
        manifest_digest: q.resolution_manifest_digest,
        receipt_refs: [`release-operation:${key}`],
      },
      this.runner.actor,
    ]);
    return call(this.client, 'select_receipt', [
      ...this.runner.args(),
      q.release_id,
      q.state_version,
      event,
      this.runner.actor,
    ]);
  }
  async qualifyCompatibility(state, readiness) {
    if (!readiness?.compatibilityReadiness) return null;
    if (!this.runner.adapters['github-compatibility'])
      return { state: 'INSTALLED_SEMANTIC_QUALIFIER_REQUIRED' };
    if (!state.compatibility_plan) {
      const request = await readiness.compatibilityReadiness.plan(state);
      await providerCall(this.client, 'submit_component_compatibility_plan', [
        ...this.runner.args(),
        state.queue.release_id,
        request,
        ...this.runner.installArgs(),
        this.runner.actor,
      ]);
      return { state: 'SEMANTIC_COMPATIBILITY_PLAN_PERSISTED' };
    }
    if (!state.compatibility_operation)
      return this.runner.submit(state.compatibility_plan, 'begin_source_plan');
    if (state.compatibility_operation.status !== 'SUCCEEDED')
      return { state: 'SEMANTIC_COMPATIBILITY_REQUIRES_OWNED_RECOVERY' };
    return null;
  }
  async plan(q, admission, receipts) {
    const phase = {
      VALIDATING: 'VALIDATION',
      MERGING: 'MERGE',
      BUILDING: 'BUILD',
      STAGED: 'STAGE',
      VERIFYING: 'CERTIFY',
    }[q.state];
    if (!phase || !this.github) return null;
    const intent = admission.intent;
    const components = q.resolution_manifest.components.map((c) => c.target);
    if (['VALIDATION', 'BUILD'].includes(phase) && components.includes('club-arena-web')) {
      if (
        intent.repository !== this.github.repo ||
        this.github.certificationVersion !== 2 ||
        !this.runner.adapters['component-aggregate'] ||
        q.recovery_id ||
        !Number.isSafeInteger(intent.pull_request) ||
        components.some((t) => !['club-arena-web', 'club-arena-engine'].includes(t))
      )
        return null;
      const merge = this.runner.adapters['github-merge'];
      if (!merge) return null;
      const source =
        phase === 'VALIDATION'
          ? await merge.candidate(intent.pull_request, q.resolution_head_sha)
          : {
              expected_base_sha: receipts.INTEGRATION.data.expected_base_sha,
              tested_tree_sha: receipts.INTEGRATION.data.merged_tree_sha,
              candidate_sha: receipts.INTEGRATION.data.merged_sha,
            };
      const request = {
        aggregate_version: 1,
        phase,
        repository: intent.repository,
        target: intent.target,
        source_sha: source.candidate_sha,
        expected_base_sha: source.expected_base_sha,
        tested_tree_sha: source.tested_tree_sha,
        accepted_head_sha: q.resolution_head_sha,
        manifest_digest: q.resolution_manifest_digest,
        control_sha: this.github.controlSha,
        components: [...components].sort(),
        children: {},
      };
      for (const target of request.components) {
        const name =
          target === 'club-arena-engine'
            ? 'github-workflow'
            : phase === 'VALIDATION'
              ? 'github-frontend'
              : 'github-static';
        const adapter = this.runner.adapters[name];
        if (!adapter) return null;
        const { aggregate_version: _version, children: _children, ...common } = request;
        const child = {
          ...common,
          target,
          components: [target],
          control_sha: adapter.controlSha,
          workflow_id: adapter.workflowId,
        };
        if (name === 'github-static') {
          child.control_closure = await adapter.qualifyControl(request.source_sha);
          child.control_sha = child.control_closure.control_sha;
          child.static_version = 1;
          child.repository_id = adapter.repositoryId;
          child.static_authority = this.github.staticAuthority;
          child.not_after_epoch = Math.floor(Date.parse(q.attempt_deadline) / 1000);
        } else {
          child.runtime_image = adapter.runtimeImage;
          if (name === 'github-frontend') child.frontend_qualification_version = 1;
        }
        request.children[target] = { adapter: name, request: child };
      }
      return providerCall(this.client, 'submit_aggregate_source_plan', [
        ...this.runner.args(),
        q.release_id,
        request,
        ...this.runner.installArgs(),
        this.runner.actor,
      ]);
    }
    if (phase === 'CERTIFY' && this.github.certificationVersion === 2) {
      const certifier = this.runner.adapters['github-certification'];
      if (!certifier || intent.repository !== this.github.repo || q.recovery_id) return null;
      const snapshot = await this.snapshot();
      const tuple = Object.fromEntries(
        Object.entries(receipts.READINESS.data.retained_components ?? {}).map(([target, c]) => [
          target,
          { ...c, compatibility_receipt_id: receipts.READINESS.event_id },
        ])
      );
      for (const target of components) {
        const built = receipts.BUILD.data.artifact.components[target];
        const matches = snapshot.publication_results.filter(
          (p) =>
            p.status === 'SUCCEEDED' &&
            p.intent.target === target &&
            (p.result.proof?.component?.identity ?? p.result.image_id) === built.identity
        );
        if (matches.length !== 1) throw new Error('RELEASE_COMPONENT_PUBLICATION_REQUIRED');
        tuple[target] = {
          mode: 'changed',
          source_sha: built.source_sha,
          identity: built.identity,
          ...(target === 'club-arena-web' ? { manifest_digest: built.manifest_digest } : {}),
          publication_operation_id: matches[0].id,
        };
      }
      validateComponentTuple(tuple);
      const request = {
        certificate_version: 2,
        phase,
        repository: intent.repository,
        target: intent.target,
        release_id: q.release_id,
        admission_sha: q.resolution_head_sha,
        manifest_digest: q.resolution_manifest_digest,
        component_tuple: tuple,
        control_sha: certifier.controlSha,
        workflow_id: certifier.workflowId,
        repository_id: String(this.github.repositoryId),
        fixture_authority: this.github.fixtureAuthority,
        operation_policy_digest: operationPolicyDigest,
      };
      if (components.includes('club-arena-engine')) {
        if (!this.maintenance) return null;
        const maintenance = await this.maintenance.context(q.release_id);
        if (maintenance.operation?.phase !== 'resumed') return null;
        request.maintenance_operation_id = maintenance.operation.operation_id;
      }
      return providerCall(this.client, 'submit_component_certification_plan', [
        ...this.runner.args(),
        q.release_id,
        request,
        ...this.runner.installArgs(),
        this.runner.actor,
      ]);
    }
    // Other repositories and coordinated/cross-source builds need their own
    // installed native builder contracts. Never send them to this engine job.
    if (
      intent.repository !== this.github.repo ||
      components.some((t) => !['club-arena-engine', 'club-arena-web'].includes(t)) ||
      (components.includes('club-arena-web') &&
        !(
          this.runner.adapters['component-aggregate'] &&
          (phase === 'MERGE' || (phase === 'STAGE' && components.includes('club-arena-engine')))
        )) ||
      !Number.isSafeInteger(intent.pull_request) ||
      q.recovery_id
    )
      return null;
    const merge = this.runner.adapters['github-merge'];
    const workflow = this.runner.adapters['github-workflow'];
    if (!merge || !workflow) return null;
    const common = {
      repository: intent.repository,
      target: intent.target,
      accepted_head_sha: q.resolution_head_sha,
      manifest_digest: q.resolution_manifest_digest,
    };
    let request;
    if (phase === 'VALIDATION') {
      const candidate = await merge.candidate(intent.pull_request, q.resolution_head_sha);
      request = { ...common, phase, ...candidate, source_sha: candidate.candidate_sha, components };
      delete request.candidate_sha;
    } else if (phase === 'MERGE') {
      const v = receipts.VALIDATION.data;
      request = {
        ...common,
        pr: intent.pull_request,
        expected_base_sha: v.expected_base_sha,
        tested_tree_sha: v.tested_tree_sha,
      };
    } else {
      const i = receipts.INTEGRATION.data;
      request = {
        ...common,
        phase,
        expected_base_sha: i.expected_base_sha,
        tested_tree_sha: i.merged_tree_sha,
        source_sha: i.merged_sha,
        components,
      };
    }
    if (phase === 'STAGE') {
      const adapter = this.runner.adapters['engine-stage'];
      if (!adapter) return null;
      const build = receipts.BUILD.data,
        artifact = build.artifact.components['club-arena-engine'];
      request = {
        ...request,
        control_sha: adapter.controlSha,
        target: 'club-arena-engine',
        source_sha: build.source_sha,
        artifact_image_id: artifact.identity,
        archive_digest: artifact.archive_digest,
        archive_bytes: artifact.archive_bytes,
        github_artifact_id: artifact.github_artifact_id,
        github_archive_digest: artifact.github_archive_digest,
        github_archive_bytes: artifact.github_archive_bytes,
        build_operation_id: artifact.build_operation_id,
        build_run_id: artifact.build_run_id ?? build.build_run_id,
        server_tree_sha: artifact.server_tree_sha,
        run_key: `${artifact.build_run_id ?? build.build_run_id}-1`,
        not_after_epoch: Math.min(
          Math.floor(Date.parse(q.attempt_deadline) / 1000),
          Math.floor(Date.now() / 1000) + 21600
        ),
      };
      request.expected_current = await adapter.current(request, {
        id: q.release_id,
        epoch: this.runner.owner.epoch,
      });
    }
    if (phase === 'CERTIFY') {
      const certifier = this.runner.adapters['github-certification'];
      if (!certifier) return null;
      const snapshot = await this.snapshot();
      const publication = snapshot.publication_results.find(
        (p) => p.status === 'SUCCEEDED' && p.intent.provider_request?.target === 'club-arena-engine'
      );
      if (!publication) throw new Error('RELEASE_CERTIFICATION_PUBLICATION_REQUIRED');
      request = {
        ...request,
        control_sha: certifier.controlSha,
        workflow_id: certifier.workflowId,
        artifact_image_id: receipts.BUILD.data.artifact.components['club-arena-engine'].identity,
        frontend_source_sha:
          receipts.READINESS.data.retained_components['club-arena-web'].source_sha,
        publication_operation_id: publication.id,
        operation_policy_digest: operationPolicyDigest,
      };
      if (this.maintenance) {
        const maintenance = await this.maintenance.context(q.release_id);
        if (maintenance.operation?.phase !== 'resumed') return null;
        request.maintenance_operation_id = maintenance.operation.operation_id;
      }
    }
    if (['VALIDATION', 'BUILD'].includes(phase))
      Object.assign(request, {
        control_sha: workflow.controlSha,
        workflow_id: workflow.workflowId,
        runtime_image: workflow.runtimeImage,
      });
    return providerCall(this.client, 'submit_source_plan', [
      ...this.runner.args(),
      q.release_id,
      phase,
      request,
      ...this.runner.installArgs(),
      this.runner.actor,
    ]);
  }
  async tick({ mode = 'OBSERVE', now = Date.now() } = {}) {
    const provider = await this.runner.snapshot();
    if (mode === 'OBSERVE' || provider.external || mode === 'RECONCILE')
      return this.runner.tick({ mode, now });
    if (mode !== 'EXECUTE') throw new Error('RELEASE_PROVIDER_MODE_INVALID');
    await providerCall(this.client, 'provider_installation', [
      ...this.runner.args(),
      ...this.runner.installArgs(),
      true,
    ]);
    let state = await this.snapshot();
    if (!state.queue) {
      if (!this.github) return { state: 'SOURCE_ORCHESTRATION_NOT_INSTALLED' };
      const q = await call(this.client, 'claim_next', [
        ...this.runner.args(),
        new Date(now + this.attemptMilliseconds).toISOString(),
        this.runner.actor,
      ]);
      return { state: q ? 'CLAIMED' : 'QUEUE_EMPTY' };
    }
    const { queue: q, admission, receipts, operation } = state;
    if (q.state === 'RETRY_WAIT') {
      if (Date.parse(q.next_retry_at) > now)
        return { state: 'RETRY_WAIT', next_retry_at: q.next_retry_at };
      await call(this.client, 'resume_retry', [
        ...this.runner.args(),
        q.release_id,
        new Date(now + this.attemptMilliseconds).toISOString(),
        this.runner.actor,
      ]);
      return { state: 'BOUNDED_RETRY_STARTED' };
    }
    if (
      Date.parse(q.attempt_deadline) <= now &&
      !['BLOCKED', 'RECOVERY_REQUIRED'].includes(q.state)
    ) {
      await this.transition(q, 'RECOVERY_REQUIRED');
      return { state: 'EXPIRED_ATTEMPT_REQUIRES_OWNED_RECOVERY' };
    }
    if (['VALIDATING', 'MERGING', 'BUILDING'].includes(q.state)) {
      const phase = { VALIDATING: 'VALIDATION', MERGING: 'INTEGRATION', BUILDING: 'BUILD' }[
        q.state
      ];
      if (receipts[phase]) {
        await this.transition(
          q,
          { VALIDATING: 'MERGING', MERGING: 'BUILDING', BUILDING: 'STAGED' }[q.state]
        );
        return { state: `${phase}_SELECTED` };
      }
      if (!state.plan) {
        try {
          const plan = await this.plan(q, admission, receipts);
          return { state: plan ? 'SOURCE_PLAN_PERSISTED' : 'SOURCE_TARGET_CONTRACT_UNAVAILABLE' };
        } catch (error) {
          if (error.message === 'RELEASE_GITHUB_CONTRACT_REFUSED') {
            await this.transition(q, 'BLOCKED');
            return { state: 'EXACT_SOURCE_PRECONDITION_REFUSED' };
          }
          if (error.code || /^RELEASE_/.test(error.message)) throw error;
          await call(this.client, 'retry', [
            q.release_id,
            q.state_version,
            30,
            'TRANSPORT',
            this.runner.actor,
            'Source provider read did not complete',
          ]);
          return { state: 'SOURCE_READ_RETRY_RECORDED' };
        }
      }
      if (!operation) return this.runner.submit(state.plan, 'begin_source_plan');
      if (operation.status !== 'SUCCEEDED') {
        if (operation.status === 'NOT_ACCEPTED') await this.transition(q, 'BLOCKED');
        return { state: 'SOURCE_OPERATION_REQUIRES_RECONCILIATION_OR_RECOVERY' };
      }
      const result = operation.result;
      const request = state.plan.request;
      let data;
      if (phase === 'VALIDATION')
        data = {
          accepted_head_sha: request.accepted_head_sha,
          expected_base_sha: request.expected_base_sha,
          tested_tree_sha: request.tested_tree_sha,
          qualification_run_id: result.provider_operation_id,
        };
      if (phase === 'INTEGRATION')
        data = {
          accepted_head_sha: request.accepted_head_sha,
          expected_base_sha: request.expected_base_sha,
          merged_sha: result.merged_sha,
          merged_tree_sha: result.merged_tree_sha,
          validation_receipt: receipts.VALIDATION.event_id,
        };
      if (phase === 'BUILD')
        data = {
          source_sha: request.source_sha,
          artifact: result.proof.artifact,
          build_run_id: result.provider_operation_id,
          database_doors: result.proof.database_doors,
          integration_receipt: receipts.INTEGRATION.event_id,
        };
      if (request.aggregate_version === 1)
        Object.assign(data, {
          aggregate_operation_id: operation.id,
          component_qualifications: result.proof.component_qualifications,
        });
      await this.selected(q, phase, operation.id, data);
      return { state: `${phase}_RECEIPT_SELECTED` };
    }
    if (q.state === 'STAGED') {
      if (receipts.STAGED) {
        await this.transition(q, 'READY');
        return { state: 'STAGING_PROOF_SELECTED' };
      }
      if (q.resolution_manifest.components.every((c) => c.target === 'club-arena-web')) {
        if (!this.staticReadiness) return { state: 'INSTALLED_STATIC_COMPATIBILITY_REQUIRED' };
        const qualification = await this.qualifyCompatibility(state, this.staticReadiness);
        if (qualification) return qualification;
        const proof = await this.staticReadiness.verify(state);
        await this.selected(q, 'STAGED', `static-stage:${q.attempt_id}`, {
          ...proof,
          build_receipt: receipts.BUILD.event_id,
        });
        return { state: 'STATIC_ARTIFACT_AND_COMPATIBILITY_SELECTED' };
      }
      if (!this.runner.adapters['engine-stage'] || !this.readiness)
        return { state: 'INSTALLED_STAGING_PROOF_REQUIRED' };
      if (!state.plan) {
        await this.plan(q, admission, receipts);
        return { state: 'EXACT_STAGE_PLAN_PERSISTED' };
      }
      if (!operation) return this.runner.submit(state.plan, 'begin_source_plan');
      if (operation.status !== 'SUCCEEDED')
        return { state: 'STAGING_REQUIRES_OWNED_RECONCILIATION' };
      const r = state.plan.request;
      const request = {
        target: r.target,
        source_sha: r.source_sha,
        control_sha: r.control_sha,
        server_tree_sha: r.server_tree_sha,
        artifact_image_id: r.artifact_image_id,
        run_key: r.run_key,
        manifest_digest: r.manifest_digest,
        expected_current: r.expected_current,
        not_after_epoch: r.not_after_epoch,
        actor: this.runner.actor,
      };
      const mixed = q.resolution_manifest.components.some((c) => c.target === 'club-arena-web');
      if (mixed && !this.mixedReadiness) return { state: 'INSTALLED_MIXED_COMPATIBILITY_REQUIRED' };
      if (mixed) {
        const qualification = await this.qualifyCompatibility(state, this.mixedReadiness);
        if (qualification) return qualification;
      }
      const proof = await (mixed ? this.mixedReadiness : this.readiness).verify(
        state,
        request,
        operation
      );
      await this.selected(q, 'STAGED', operation.id, {
        ...proof,
        build_receipt: receipts.BUILD.event_id,
        intake_request: request,
        stage_operation_id: operation.id,
      });
      return { state: 'EXACT_STAGING_AND_COMPATIBILITY_SELECTED' };
    }
    if (q.state === 'READY') {
      if (receipts.READINESS) {
        await this.transition(q, 'APPLYING');
        return { state: 'READINESS_PROOF_SELECTED' };
      }
      if (q.resolution_manifest.components.every((c) => c.target === 'club-arena-web')) {
        if (!this.staticReadiness) return { state: 'INSTALLED_STATIC_COMPATIBILITY_REQUIRED' };
        const proof = await this.staticReadiness.verify(state);
        await this.selected(q, 'READINESS', `static-readiness:${q.attempt_id}`, {
          ...proof,
          stage_receipt: receipts.STAGED.event_id,
        });
        return { state: 'STATIC_READINESS_SELECTED' };
      }
      if (!this.readiness) return { state: 'INSTALLED_READINESS_PROOF_REQUIRED' };
      const mixed = q.resolution_manifest.components.some((c) => c.target === 'club-arena-web');
      if (mixed && !this.mixedReadiness) return { state: 'INSTALLED_MIXED_COMPATIBILITY_REQUIRED' };
      const proof = await (mixed ? this.mixedReadiness : this.readiness).verify(
        state,
        receipts.STAGED.data.intake_request,
        {
          id: receipts.STAGED.data.stage_operation_id,
          epoch: this.runner.owner.epoch,
        }
      );
      await this.selected(q, 'READINESS', `readiness:${q.attempt_id}`, {
        ...proof,
        stage_receipt: receipts.STAGED.event_id,
      });
      return { state: 'EXACT_READINESS_SELECTED' };
    }
    if (q.state === 'APPLYING') {
      const requests = receipts.READINESS?.data.provider_requests ?? {};
      const changed = q.resolution_manifest.components.map((c) => c.target);
      const mixed = changed.includes('club-arena-web') && changed.includes('club-arena-engine');
      const components = mixed ? receipts.READINESS.data.publication_order : changed;
      if (mixed)
        need(sameFacts(components, mixedCutoverOrder), 'RELEASE_MIXED_PUBLICATION_ORDER_REQUIRED');
      const succeeded = (target) =>
        state.publication_results.some((e) => {
          const request = e.intent.provider_request;
          const built = receipts.BUILD.data.artifact.components[target];
          if (
            e.status !== 'SUCCEEDED' ||
            request?.target !== target ||
            (request.deployment_id ?? request.artifact_image_id ?? request.artifact?.identity) !==
              built.identity
          )
            return false;
          if (!mixed) return true;
          const selected = Object.values(requests).find((r) => r.target === target);
          return (
            sameFacts(request, selected) &&
            request.source_sha === built.source_sha &&
            (target === 'club-arena-engine'
              ? e.result.source_sha === built.source_sha && e.result.image_id === built.identity
              : sameFacts(e.result.proof?.component, built))
          );
        });
      if (provider.plan) {
        if (mixed) {
          const next = components.find((target) => !succeeded(target));
          need(
            provider.plan.request.target === next &&
              sameFacts(provider.plan.request, requests[provider.plan.adapter]),
            'RELEASE_MIXED_PUBLICATION_ORDER_REQUIRED'
          );
        }
        if (provider.plan.request.target === 'club-arena-engine') {
          if (!this.maintenance) return { state: 'INSTALLED_MAINTENANCE_AUTHORITY_REQUIRED' };
          const maintenance = await this.maintenance.beforePublish(provider.plan);
          if (!maintenance.ready) return maintenance;
        }
        return this.runner.tick({ mode, now });
      }
      for (const target of components) {
        if (succeeded(target)) continue;
        const pair = Object.entries(requests).find(([, r]) => r.target === target);
        if (!pair || !this.runner.adapters[pair[0]])
          return { state: 'INSTALLED_PUBLICATION_CONTRACT_UNAVAILABLE' };
        const [adapter, request] = pair;
        const key = `publish:${q.attempt_id}:${target}`;
        if (state.publication_results.some((e) => e.operation_key === key))
          return { state: 'PUBLICATION_REQUIRES_OWNED_RECOVERY' };
        if (adapter === 'github-static')
          await providerCall(this.client, 'submit_static_publication_plan', [
            ...this.runner.args(),
            q.release_id,
            key,
            request,
            ...this.runner.installArgs(),
            this.runner.actor,
          ]);
        else
          await providerCall(this.client, 'submit_provider_plan', [
            q.release_id,
            key,
            adapter,
            request,
            this.runner.actor,
          ]);
        return { state: 'QUALIFIED_PUBLICATION_PLAN_PERSISTED' };
      }
      if (components.includes('club-arena-engine')) {
        if (!this.maintenance) return { state: 'INSTALLED_MAINTENANCE_AUTHORITY_REQUIRED' };
        const maintenance = await this.maintenance.afterPublish(q.release_id);
        if (!maintenance.ready) return maintenance;
      }
      await this.transition(q, 'VERIFYING');
      return { state: 'ALL_COMPONENT_PUBLICATIONS_TERMINAL' };
    }
    if (q.state === 'VERIFYING') {
      if (receipts.CERTIFICATION) {
        await this.transition(
          q,
          q.recovery_id && receipts.CERTIFICATION.data.recovered ? 'RECOVERED' : 'VERIFIED'
        );
        return { state: 'SERVED_CERTIFICATION_SELECTED_AND_VERIFIED' };
      }
      if (!this.runner.adapters['github-certification'])
        return { state: 'EXACT_SERVED_CERTIFICATION_REQUIRED' };
      if (!state.plan) {
        const plan = await this.plan(q, admission, receipts);
        return {
          state: plan
            ? 'EXACT_CERTIFICATION_PLAN_PERSISTED'
            : 'CERTIFICATION_PREREQUISITES_UNAVAILABLE',
        };
      }
      if (!operation) return this.runner.submit(state.plan, 'begin_source_plan');
      if (operation.status !== 'SUCCEEDED')
        return { state: 'CERTIFICATION_REQUIRES_OWNED_RECONCILIATION' };
      const result = operation.result;
      await this.selected(q, 'CERTIFICATION', operation.id, {
        ...result.proof,
        build_receipt: receipts.BUILD.event_id,
        certification_run_id: result.provider_operation_id,
        post_resume_stable_since: result.stable_since_ms,
        post_resume_observed_at: result.observed_at_ms,
        required_observation_ms: result.required_observation_ms,
      });
      return { state: 'EXACT_SERVED_CERTIFICATE_SELECTED' };
    }
    return {
      state:
        {
          STAGED: 'INSTALLED_STAGING_PROOF_REQUIRED',
          READY: 'INSTALLED_READINESS_PROOF_REQUIRED',
          VERIFYING: 'EXACT_SERVED_CERTIFICATION_REQUIRED',
        }[q.state] ?? q.state,
    };
  }
}
