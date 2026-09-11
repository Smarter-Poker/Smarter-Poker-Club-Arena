import { call } from './journal.mjs';
import { AggregateQualificationRunner } from './aggregate-qualification.mjs';

const commands = new Set([
  'register_provider_installation',
  'enqueue_delivery',
  'source_snapshot',
  'submit_source_plan',
  'submit_component_certification_plan',
  'provider_operation_context',
  'authorize_certification_cleanup',
  'submit_aggregate_source_plan',
  'submit_component_compatibility_plan',
  'prepare_qualification_children',
  'qualification_snapshot',
  'authorize_qualification_child',
  'record_qualification_result',
  'qualification_terminal',
  'submit_static_build_plan',
  'submit_static_publication_plan',
  'begin_source_plan',
  'submit_provider_plan',
  'provider_installation',
  'begin_provider_plan',
  'authorize_provider_submit',
  'provider_snapshot',
  'record_provider_observation',
  'authorize_provider_readback',
]);
export async function providerCall(client, name, args = []) {
  if (!commands.has(name)) throw new Error('RELEASE_PROVIDER_COMMAND_INVALID');
  if (
    (
      await client.query(
        'SELECT release_ops.schema_version() AS v, release_ops.provider_schema_version() AS p'
      )
    ).rows.some((row) => row.v !== 1 || row.p !== 1)
  )
    throw new Error('RELEASE_SCHEMA_VERSION_UNSUPPORTED');
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL synchronous_commit=on');
    const result = await client.query(
      `SELECT release_ops.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS v`,
      args
    );
    await client.query('COMMIT');
    return result.rows[0].v;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

// All provider implementations return only allowlisted, non-secret evidence.
// This runner never performs a source merge, build, readiness/certification or
// release-state transition. Those unavailable gates cannot be inferred here.
export class ProviderRunner {
  constructor({ client, owner, installation, adapters, actor = 'release-provider-controller' }) {
    Object.assign(this, { client, owner, installation, adapters, actor });
  }
  args() {
    return [this.owner.owner_id, this.owner.epoch];
  }
  installArgs() {
    return [this.installation.bundle_digest, this.installation.config_digest];
  }
  async snapshot() {
    return providerCall(this.client, 'provider_snapshot', this.args());
  }
  adapter(operation) {
    const adapter = this.adapters[operation.intent.adapter];
    if (!adapter) throw new Error('RELEASE_PROVIDER_ADAPTER_UNAVAILABLE');
    adapter.validate(operation.intent.provider_request);
    return adapter;
  }
  async observation(operation, result) {
    const data = {
      ...result,
      operation_id: operation.id,
      manifest_digest: operation.intent.manifest_digest,
    };
    const receipt = await providerCall(this.client, 'record_provider_observation', [
      ...this.args(),
      operation.id,
      data,
      this.actor,
    ]);
    if (data.terminal === true) {
      return call(this.client, 'resolve_external', [
        ...this.args(),
        operation.id,
        data.outcome,
        { ...data, receipt_refs: [`release-provider-observation:${receipt.event_id}`] },
        this.actor,
      ]);
    }
    if (operation.status !== 'UNKNOWN')
      await call(this.client, 'mark_unknown', [
        ...this.args(),
        operation.id,
        this.actor,
        'Provider operation has no verified terminal outcome',
      ]);
    return { status: 'UNKNOWN', next_check_at: receipt.next_check_at };
  }
  async reconcile(operation, { execute = false } = {}) {
    let result;
    try {
      operation = {
        ...operation,
        ...(await providerCall(this.client, 'provider_operation_context', [
          ...this.args(),
          operation.id,
        ])),
      };
      result =
        operation.intent.adapter === 'component-aggregate'
          ? await new AggregateQualificationRunner(this).tick(operation, { execute })
          : await this.adapter(operation).reconcile(operation.intent.provider_request, operation, {
              execute,
              beforeEffect: () =>
                providerCall(this.client, 'provider_installation', [
                  ...this.args(),
                  ...this.installArgs(),
                  true,
                ]),
            });
      if (
        result.cleanup_required &&
        operation.intent.adapter === 'github-certification' &&
        operation.intent.provider_request.certificate_version === 2
      ) {
        if (!execute)
          return this.observation(operation, {
            terminal: false,
            reason: 'CERTIFICATION_CLEANUP_AWAITS_EXECUTE',
          });
        // The original unresolved operation retains global ownership. A
        // separate immutable dispatch intent permits one cleanup-only run.
        const adapter = this.adapter(operation);
        const original = await adapter.cleanupOriginal(
          operation.intent.provider_request,
          operation
        );
        const recovery = await providerCall(this.client, 'authorize_certification_cleanup', [
          ...this.args(),
          operation.id,
          original,
          ...this.installArgs(),
          this.actor,
        ]);
        if (recovery.may_submit)
          await adapter.submitCleanup(operation.intent.provider_request, operation, recovery);
        result = {
          terminal: false,
          reason: 'CERTIFICATION_CLEANUP_RECOVERY_PENDING',
          recovery_id: recovery.id,
        };
      }
    } catch {
      result = { terminal: false, reason: 'PROVIDER_READBACK_UNAVAILABLE' };
    }
    return this.observation(operation, result);
  }
  async submit(plan, beginFunction = 'begin_provider_plan') {
    // Validation is inert and precedes admission of an external action.
    const adapter = this.adapters[plan.adapter];
    if (!adapter) throw new Error('RELEASE_PROVIDER_ADAPTER_UNAVAILABLE');
    adapter.validate(plan.request);
    const operation = await providerCall(this.client, beginFunction, [
      ...this.args(),
      plan.id,
      ...this.installArgs(),
      this.actor,
    ]);
    if (!operation.may_submit) return this.reconcile(operation);
    let preflight;
    try {
      preflight = await adapter.preflight(plan.request, operation);
    } catch {
      // This process saw the INTENT commit and has never requested submit
      // authorization: no provider mutation was possible from this invocation.
      return this.observation(operation, {
        terminal: true,
        outcome: 'NOT_ACCEPTED',
        accepted: false,
        reason: 'LOCAL_PREFLIGHT_REFUSED_BEFORE_SUBMIT_AUTHORIZATION',
      });
    }
    await providerCall(this.client, 'record_provider_observation', [
      ...this.args(),
      operation.id,
      { operation_id: operation.id, terminal: false, phase: 'PREFLIGHT', ...preflight },
      this.actor,
    ]);
    // The fresh owner/deadline/installed-code checks occur AFTER all network
    // preflight reads. A paused predecessor cannot cross this gate after takeover.
    const authorization = await providerCall(this.client, 'authorize_provider_submit', [
      ...this.args(),
      operation.id,
      ...this.installArgs(),
      this.actor,
    ]);
    if (!authorization.may_submit) return this.reconcile(operation);
    let result;
    try {
      result = await adapter.submit(plan.request, operation);
    } catch {
      result = { terminal: false, reason: 'PROVIDER_SUBMIT_RESPONSE_LOST' };
    }
    return this.observation(operation, result);
  }
  async tick({ mode = 'OBSERVE', now = Date.now() } = {}) {
    if (!['OBSERVE', 'RECONCILE', 'EXECUTE'].includes(mode))
      throw new Error('RELEASE_PROVIDER_MODE_INVALID');
    const snapshot = await this.snapshot();
    if (mode === 'OBSERVE') return { state: 'OBSERVE', snapshot };
    // Even readback requires the exact installed scope/identity; it cannot
    // accidentally use an interactive account or a candidate's credentials.
    await providerCall(this.client, 'provider_installation', [
      ...this.args(),
      ...this.installArgs(),
      false,
    ]);
    if (snapshot.external) {
      if (!this.adapters[snapshot.external.intent.adapter])
        return { state: 'EXTERNAL_ADAPTER_UNAVAILABLE' };
      if (snapshot.observation?.data.terminal) {
        const data = snapshot.observation.data;
        return call(this.client, 'resolve_external', [
          ...this.args(),
          snapshot.external.id,
          data.outcome,
          {
            ...data,
            receipt_refs: [`release-provider-observation:${snapshot.observation.event_id}`],
          },
          this.actor,
        ]);
      }
      if (
        snapshot.observation &&
        !snapshot.observation.next_check_at &&
        snapshot.readback_remaining <= 0
      )
        return { state: 'UNKNOWN_READBACK_BUDGET_EXHAUSTED' };
      if (Date.parse(snapshot.observation?.next_check_at) > now)
        return { state: 'WAITING_READBACK', next_check_at: snapshot.observation.next_check_at };
      return this.reconcile(
        {
          ...snapshot.external,
          previous_observation: snapshot.observation?.data,
        },
        { execute: mode === 'EXECUTE' }
      );
    }
    if (mode === 'EXECUTE' && snapshot.plan && !snapshot.controller.reconciliation_required)
      return this.submit(snapshot.plan);
    return {
      state: snapshot.controller.reconciliation_required
        ? 'FRESH_RECONCILIATION_REQUIRED'
        : 'NO_QUALIFIED_PROVIDER_PLAN',
    };
  }
}
