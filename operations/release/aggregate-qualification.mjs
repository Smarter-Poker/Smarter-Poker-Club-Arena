import { providerCall } from './provider-journal.mjs';
import { requireCertificate as need, sameFacts, fullSha } from './component-certificate.mjs';

// One journal operation, with immutable child identities. Child providers are
// the existing credential-free engine qualifier and the existing static writer.
export class AggregateQualificationAdapter {
  constructor({ adapters }) {
    this.adapters = adapters;
  }
  validate(r) {
    need(
      r?.aggregate_version === 1 &&
        ['VALIDATION', 'BUILD'].includes(r.phase) &&
        r.repository === 'Smarter-Poker/Smarter-Poker-Club-Arena' &&
        [
          'source_sha',
          'accepted_head_sha',
          'expected_base_sha',
          'tested_tree_sha',
          'control_sha',
        ].every((k) => fullSha.test(r[k])) &&
        ['["club-arena-web"]', '["club-arena-engine","club-arena-web"]'].includes(
          JSON.stringify(r.components)
        ) &&
        sameFacts(Object.keys(r.children).sort(), r.components)
    );
    for (const target of r.components) {
      const child = r.children[target];
      need(
        child &&
          child.adapter ===
            (target === 'club-arena-engine'
              ? 'github-workflow'
              : r.phase === 'BUILD'
                ? 'github-static'
                : 'github-frontend')
      );
      need(
        [
          'phase',
          'repository',
          'source_sha',
          'accepted_head_sha',
          'expected_base_sha',
          'tested_tree_sha',
          'manifest_digest',
        ].every((key) => child.request[key] === r[key]) &&
          child.request.target === target &&
          (child.adapter === 'github-static' || child.request.control_sha === r.control_sha)
      );
      need(this.adapters[child.adapter], 'RELEASE_COMPONENT_PROVIDER_NOT_INSTALLED');
      this.adapters[child.adapter].validate(child.request);
    }
  }
  async preflight(r) {
    this.validate(r);
    for (const target of r.components) {
      const child = r.children[target];
      await this.adapters[child.adapter].preflight(child.request);
    }
    return {
      aggregate_version: 1,
      components: r.components,
      source_sha: r.source_sha,
      control_sha: r.control_sha,
    };
  }
  async submit(r) {
    this.validate(r);
    // Parent acceptance has no provider effect. Child intent + authorization
    // must commit through the private runner before the first provider call.
    return { terminal: false, reason: 'AGGREGATE_ACCEPTED_CHILD_QUALIFICATION_REQUIRED' };
  }
}

export class AggregateQualificationRunner {
  constructor(runner) {
    this.runner = runner;
  }
  async tick(parent, { execute = false } = {}) {
    const p = this.runner;
    await providerCall(p.client, 'prepare_qualification_children', [
      ...p.args(),
      parent.id,
      ...p.installArgs(),
      p.actor,
    ]);
    const snapshot = await providerCall(p.client, 'qualification_snapshot', [
      ...p.args(),
      parent.id,
    ]);
    for (const child of snapshot.children) {
      if (child.outcome === 'SUCCEEDED') continue;
      if (child.outcome) break;
      const adapter = p.adapters[child.adapter];
      need(adapter, 'RELEASE_COMPONENT_PROVIDER_NOT_INSTALLED');
      adapter.validate(child.request);
      const operation = { id: child.id, created_at: child.created_at, epoch: parent.epoch };
      let result;
      if (!child.submitted) {
        if (!execute)
          return {
            terminal: false,
            reason: 'AGGREGATE_CHILD_AWAITS_EXECUTE',
            component: child.target,
          };
        try {
          await adapter.preflight(child.request, operation);
        } catch {
          result = {
            terminal: true,
            outcome: 'NOT_ACCEPTED',
            accepted: false,
            reason: 'CHILD_PREFLIGHT_REFUSED_BEFORE_AUTHORIZATION',
          };
        }
        if (!result) {
          const grant = await providerCall(p.client, 'authorize_qualification_child', [
            ...p.args(),
            child.id,
            ...p.installArgs(),
            p.actor,
          ]);
          if (grant.may_submit) {
            try {
              result = await adapter.submit(child.request, operation);
            } catch {
              return {
                terminal: false,
                reason: 'AGGREGATE_CHILD_SUBMIT_RESPONSE_LOST',
                component: child.target,
                child_id: child.id,
              };
            }
          }
        }
      }
      if (!result) {
        try {
          result = await adapter.reconcile(child.request, operation);
        } catch {
          return {
            terminal: false,
            reason: 'AGGREGATE_CHILD_READBACK_UNAVAILABLE',
            component: child.target,
            child_id: child.id,
          };
        }
      }
      if (!result.terminal)
        return { ...result, terminal: false, component: child.target, child_id: child.id };
      await providerCall(p.client, 'record_qualification_result', [
        ...p.args(),
        child.id,
        { ...result, operation_id: child.id, manifest_digest: child.request.manifest_digest },
        p.actor,
      ]);
      if (result.outcome !== 'SUCCEEDED') break;
    }
    const result = await providerCall(p.client, 'qualification_terminal', [...p.args(), parent.id]);
    return result ?? { terminal: false, reason: 'AGGREGATE_CHILD_QUALIFICATION_PENDING' };
  }
}
