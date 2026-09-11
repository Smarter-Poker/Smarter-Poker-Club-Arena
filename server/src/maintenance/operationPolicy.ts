import source from './operationPolicy.json' with { type: 'json' };
import { createHash } from 'node:crypto';

/** These are supported values, not activation authority. Only the installed
 * database certificate switches the runtime out of the legacy schedule. */
export interface OperationMaintenancePolicy {
  version: 2;
  releasePolicy: 'prelaunch_serial';
  maximumActiveReleases: 1;
  platformHourlyPause: false;
  lastHandNoticeMs: number;
  normalTargetMs: number;
  plannedHoldMs: number;
  recoveryReserveMs: number;
  forwardWorkMs: number;
  postResumeObservationMs: number;
  qualificationMs: number;
  deadlineAction: 'RECOVERY_REQUIRED';
  reopeningAuthority: 'durable_release_and_thaw';
  activationRequires: readonly string[];
}

export function validateOperationPolicy(value: unknown): OperationMaintenancePolicy {
  const p = value as OperationMaintenancePolicy;
  const durations = [
    p?.lastHandNoticeMs,
    p?.normalTargetMs,
    p?.plannedHoldMs,
    p?.recoveryReserveMs,
    p?.forwardWorkMs,
    p?.postResumeObservationMs,
    p?.qualificationMs,
  ];
  if (
    p?.version !== 2 ||
    p.releasePolicy !== 'prelaunch_serial' ||
    p.maximumActiveReleases !== 1 ||
    p.platformHourlyPause !== false ||
    p.deadlineAction !== 'RECOVERY_REQUIRED' ||
    p.reopeningAuthority !== 'durable_release_and_thaw' ||
    durations.some((n) => !Number.isSafeInteger(n) || n <= 0) ||
    p.forwardWorkMs + p.recoveryReserveMs !== p.plannedHoldMs ||
    p.normalTargetMs > p.forwardWorkMs ||
    p.lastHandNoticeMs >= p.forwardWorkMs ||
    !Array.isArray(p.activationRequires) ||
    p.activationRequires.length !== 6 ||
    new Set(p.activationRequires).size !== 6 ||
    ['database', 'engine', 'client', 'controller', 'host_cutover', 'retained_recovery'].some(
      (component) => !p.activationRequires.includes(component)
    )
  ) {
    throw new Error('maintenance_policy_invalid');
  }
  return Object.freeze({ ...p, activationRequires: Object.freeze([...p.activationRequires]) });
}

export const operationMaintenancePolicy = validateOperationPolicy(source);
export const operationMaintenancePolicyDigest = createHash('sha256')
  .update(JSON.stringify(source, null, 2) + '\n')
  .digest('hex');

export type OperationMaintenancePhase =
  | 'last_hand'
  | 'draining'
  | 'ready'
  | 'applying'
  | 'recovering'
  | 'recovery_required'
  | 'release_authorized'
  | 'releasing'
  | 'resumed';

export interface OperationWaveState {
  index: number;
  tableIds: readonly string[];
  receiptId: string | null;
  creditedThroughAt: number | null;
  resumedAt: number | null;
}

export interface OperationGlobalTail {
  checkpointId: string;
  checkpointNo: number;
  creditedThroughAt: number;
  remaining: number;
  receiptId: string | null;
  receiptOwnershipToken: string | null;
  receiptGeneration: number | null;
  certifiedAt: number | null;
  targetCount: number | null;
  targetDigest: string | null;
  status: 'pending' | 'certified' | 'released';
}

/** Parsed from the database, never from an engine event or caller-supplied
 * configuration. Controller ownership and engine adoption are separate. */
export interface OperationMaintenanceState {
  policyVersion: 2;
  operationId: string;
  releaseId: string;
  intervalId: string;
  ownershipToken: string;
  generation: number;
  phase: OperationMaintenancePhase;
  scope: { type: 'platform' } | { type: 'tables'; tableIds: readonly string[] };
  freezeStartedAt: number;
  targetAt: number;
  forwardDeadlineAt: number;
  deadlineAt: number;
  observedAt: number;
  releaseReceipt: string | null;
  reason: string;
  resumeWaves: readonly OperationWaveState[];
  globalTail?: OperationGlobalTail | null;
}

export interface OperationMaintenanceSnapshot {
  policyVersion: 1 | 2;
  activationReceipt: string | null;
  observedAt: number;
  operation: OperationMaintenanceState | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const phases = new Set<OperationMaintenancePhase>([
  'last_hand',
  'draining',
  'ready',
  'applying',
  'recovering',
  'recovery_required',
  'release_authorized',
  'releasing',
  'resumed',
]);

export function validateOperationState(value: unknown): OperationMaintenanceState {
  const s = value as OperationMaintenanceState;
  const policy = operationMaintenancePolicy;
  if (
    s?.policyVersion !== policy.version ||
    [s.operationId, s.releaseId, s.intervalId, s.ownershipToken].some(
      (id) => typeof id !== 'string' || !UUID.test(id)
    ) ||
    !Number.isSafeInteger(s.generation) ||
    s.generation < 1 ||
    !phases.has(s.phase) ||
    [s.freezeStartedAt, s.targetAt, s.forwardDeadlineAt, s.deadlineAt, s.observedAt].some(
      (n) => !Number.isFinite(n) || n <= 0
    ) ||
    s.targetAt !== s.freezeStartedAt + policy.normalTargetMs ||
    s.forwardDeadlineAt !== s.freezeStartedAt + policy.forwardWorkMs ||
    s.deadlineAt !== s.freezeStartedAt + policy.plannedHoldMs ||
    s.observedAt < s.freezeStartedAt ||
    typeof s.reason !== 'string' ||
    !Array.isArray(s.resumeWaves) ||
    (s.releaseReceipt !== null &&
      (typeof s.releaseReceipt !== 'string' || !UUID.test(s.releaseReceipt))) ||
    (['release_authorized', 'releasing', 'resumed'].includes(s.phase) && !s.releaseReceipt) ||
    !s.scope ||
    !['platform', 'tables'].includes(s.scope.type) ||
    (s.scope.type === 'tables' &&
      (!Array.isArray(s.scope.tableIds) ||
        s.scope.tableIds.length < 1 ||
        s.scope.tableIds.length > 10000 ||
        new Set(s.scope.tableIds).size !== s.scope.tableIds.length ||
        s.scope.tableIds.some((id) => typeof id !== 'string' || !UUID.test(id))))
  ) {
    throw new Error('maintenance_operation_state_invalid');
  }
  const waveTables = new Set<string>();
  const indices = new Set<number>();
  for (const wave of s.resumeWaves) {
    if (
      !Number.isSafeInteger(wave.index) ||
      wave.index < 0 ||
      indices.has(wave.index) ||
      !Array.isArray(wave.tableIds) ||
      wave.tableIds.length === 0 ||
      wave.tableIds.some((id: string) => !UUID.test(id) || waveTables.has(id)) ||
      new Set(wave.tableIds).size !== wave.tableIds.length ||
      (wave.receiptId !== null && !UUID.test(wave.receiptId)) ||
      (wave.creditedThroughAt !== null &&
        (!Number.isFinite(wave.creditedThroughAt) || wave.creditedThroughAt < s.freezeStartedAt)) ||
      (wave.resumedAt !== null &&
        (!wave.receiptId ||
          wave.creditedThroughAt === null ||
          wave.resumedAt < wave.creditedThroughAt))
    ) {
      throw new Error('maintenance_wave_state_invalid');
    }
    indices.add(wave.index);
    wave.tableIds.forEach((id: string) => waveTables.add(id));
  }
  const global = s.globalTail;
  if (s.phase === 'resumed' && !global?.receiptId)
    throw new Error('maintenance_global_release_receipt_missing');
  if (
    global &&
    (!UUID.test(global.checkpointId) ||
      !Number.isSafeInteger(global.checkpointNo) ||
      global.checkpointNo < 1 ||
      global.checkpointNo > 8 ||
      !Number.isFinite(global.creditedThroughAt) ||
      global.creditedThroughAt <= s.freezeStartedAt ||
      !Number.isSafeInteger(global.remaining) ||
      global.remaining < 0 ||
      !['pending', 'certified', 'released'].includes(global.status) ||
      (global.receiptId === null
        ? global.status !== 'pending' ||
          global.receiptOwnershipToken !== null ||
          global.receiptGeneration !== null ||
          global.certifiedAt !== null ||
          global.targetCount !== null ||
          global.targetDigest !== null
        : !UUID.test(global.receiptId) ||
          !UUID.test(global.receiptOwnershipToken ?? '') ||
          !Number.isSafeInteger(global.receiptGeneration) ||
          global.receiptGeneration! < 1 ||
          global.receiptGeneration! > s.generation ||
          (global.receiptGeneration === s.generation &&
            global.receiptOwnershipToken !== s.ownershipToken) ||
          !Number.isFinite(global.certifiedAt) ||
          global.certifiedAt! >= global.creditedThroughAt ||
          !Number.isSafeInteger(global.targetCount) ||
          global.targetCount! < 0 ||
          !/^[a-f0-9]{64}$/.test(global.targetDigest ?? '') ||
          global.remaining !== 0 ||
          global.status === 'pending' ||
          s.resumeWaves.some((w) => w.resumedAt === null)))
  ) {
    throw new Error('maintenance_global_tail_invalid');
  }
  return Object.freeze({
    ...s,
    globalTail: global ? Object.freeze({ ...global }) : null,
    scope:
      s.scope.type === 'platform'
        ? Object.freeze({ type: 'platform' as const })
        : Object.freeze({
            type: 'tables' as const,
            tableIds: Object.freeze([...s.scope.tableIds]),
          }),
    resumeWaves: Object.freeze(
      s.resumeWaves.map((w) => Object.freeze({ ...w, tableIds: Object.freeze([...w.tableIds]) }))
    ),
  });
}

/** Local monotonic time may tighten a durable deadline; wall-clock changes
 * and process adoption can never extend the stored continuous hold. */
export class OperationHoldClock {
  private readonly anchoredAt: number;
  private readonly databaseAt: number;
  constructor(
    readonly state: OperationMaintenanceState,
    private readonly monotonicNow: () => number
  ) {
    validateOperationState(state);
    this.anchoredAt = monotonicNow();
    this.databaseAt = state.observedAt;
    if (!Number.isFinite(this.anchoredAt)) throw new Error('maintenance_monotonic_clock_invalid');
  }
  now(): number {
    const elapsed = this.monotonicNow() - this.anchoredAt;
    if (!Number.isFinite(elapsed) || elapsed < 0)
      throw new Error('maintenance_monotonic_clock_regressed');
    return this.databaseAt + elapsed;
  }
  decision(
    stepMs: number,
    recoveryMs: number,
    marginMs: number
  ): 'forward' | 'recover' | 'recovery_required' {
    if ([stepMs, recoveryMs, marginMs].some((n) => !Number.isSafeInteger(n) || n < 0)) {
      throw new Error('maintenance_step_estimate_invalid');
    }
    const now = this.now();
    if (now >= this.state.deadlineAt) return 'recovery_required';
    if (now >= this.state.forwardDeadlineAt) return 'recover';
    const reserve = Math.max(operationMaintenancePolicy.recoveryReserveMs, recoveryMs);
    if (
      now + stepMs + marginMs > this.state.forwardDeadlineAt ||
      now + stepMs + reserve + marginMs > this.state.deadlineAt
    )
      return 'recover';
    return 'forward';
  }
}
