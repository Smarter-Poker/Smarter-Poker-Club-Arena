import { maintenanceSupabase, supabase } from '../services/supabase.js';
import { bindToProcessRoot } from '../services/supabase/dataActorContext.js';
import {
  operationMaintenancePolicyDigest,
  validateOperationState,
  type OperationMaintenanceSnapshot,
  type OperationMaintenanceState,
} from './operationPolicy.js';
import type { OperationMaintenanceStore } from './OperationMaintenanceRuntime.js';

// Explicit names are consumed by the deployment engine-door inventory.
const operationStateRpcName = 'fn_engine_maintenance_operation';
const claimOperationRpcName = 'fn_claim_engine_maintenance_operation';
const readyOperationRpcName = 'fn_engine_maintenance_ready';
const recoveryOperationRpcName = 'fn_engine_maintenance_recovery';
const authorizeWaveRpcName = 'fn_authorize_engine_maintenance_wave';
const acknowledgeWaveRpcName = 'fn_ack_engine_maintenance_wave';
const completeOperationRpcName = 'fn_ack_engine_maintenance_resumed';

function instant(value: unknown): number {
  const n = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(n)) throw new Error('maintenance_operation_timestamp_invalid');
  return n;
}

/** A required lower boundary must never move earlier when encoded in JS ms. */
function notBefore(value: unknown): number {
  const parsed = instant(value);
  const fraction = (value as string).match(/\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/i)?.[1];
  return fraction && /[1-9]/.test(fraction.slice(3)) ? parsed + 1 : parsed;
}

export function parseOperationSnapshot(input: unknown): OperationMaintenanceSnapshot {
  const value = input as Record<string, any>;
  if (!value || ![1, 2].includes(value.policy_version))
    throw new Error('maintenance_operation_snapshot_invalid');
  const observedAt = instant(value.observed_at);
  const row = value.operation;
  let operation: OperationMaintenanceState | null = null;
  if (row) {
    operation = validateOperationState({
      policyVersion: row.policy_version,
      operationId: row.operation_id,
      releaseId: row.release_id,
      intervalId: row.interval_id,
      ownershipToken: row.ownership_token,
      generation: Number(row.generation),
      phase: row.phase,
      scope:
        row.scope?.type === 'tables'
          ? { type: 'tables', tableIds: row.scope.table_ids }
          : row.scope,
      freezeStartedAt: instant(row.freeze_started_at),
      targetAt: instant(row.target_at),
      forwardDeadlineAt: instant(row.forward_deadline_at),
      deadlineAt: instant(row.deadline_at),
      observedAt: instant(row.observed_at),
      releaseReceipt: row.release_receipt ?? null,
      reason: row.reason,
      globalTail: row.global_tail
        ? {
            checkpointId: row.global_tail.checkpoint_id,
            checkpointNo: Number(row.global_tail.checkpoint_no),
            creditedThroughAt: notBefore(row.global_tail.credited_through_at),
            remaining: Number(row.global_tail.remaining),
            receiptId: row.global_tail.receipt_id ?? null,
            receiptOwnershipToken: row.global_tail.receipt_ownership_token ?? null,
            receiptGeneration:
              row.global_tail.receipt_generation === null
                ? null
                : Number(row.global_tail.receipt_generation),
            certifiedAt: row.global_tail.certified_at
              ? instant(row.global_tail.certified_at)
              : null,
            targetCount:
              row.global_tail.target_count === null ? null : Number(row.global_tail.target_count),
            targetDigest: row.global_tail.target_digest ?? null,
            status: row.global_tail.status,
          }
        : null,
      resumeWaves: Array.isArray(row.resume_waves)
        ? row.resume_waves.map((w: any) => ({
            index: w.index,
            tableIds: w.table_ids,
            receiptId: w.receipt_id ?? null,
            creditedThroughAt: w.credited_through_at ? notBefore(w.credited_through_at) : null,
            resumedAt: w.resumed_at ? instant(w.resumed_at) : null,
          }))
        : row.resume_waves,
    });
  }
  return {
    policyVersion: value.policy_version,
    activationReceipt: value.activation_receipt ?? null,
    observedAt,
    operation,
  };
}

export function createOperationMaintenanceStore(version?: string): OperationMaintenanceStore {
  const call = bindToProcessRoot(async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await maintenanceSupabase.rpc(name, args);
    if (error) throw new Error(error.message);
    return parseOperationSnapshot(data);
  });
  const identity = (s: OperationMaintenanceState) => ({
    p_interval_id: s.intervalId,
    p_ownership_token: s.ownershipToken,
  });
  const owned = (
    s: OperationMaintenanceState,
    result: OperationMaintenanceSnapshot
  ): OperationMaintenanceState => {
    const op = result.operation;
    if (
      result.policyVersion !== 2 ||
      !result.activationReceipt ||
      !op ||
      op.operationId !== s.operationId ||
      op.releaseId !== s.releaseId ||
      op.intervalId !== s.intervalId ||
      op.ownershipToken !== s.ownershipToken ||
      op.generation !== s.generation ||
      op.freezeStartedAt !== s.freezeStartedAt ||
      op.targetAt !== s.targetAt ||
      op.forwardDeadlineAt !== s.forwardDeadlineAt ||
      op.deadlineAt !== s.deadlineAt ||
      op.releaseReceipt !== s.releaseReceipt ||
      JSON.stringify(op.scope) !== JSON.stringify(s.scope)
    ) {
      throw new Error('maintenance_operation_write_identity_changed');
    }
    return op;
  };
  const sameIds = (actual: readonly string[], expected: readonly string[]) =>
    JSON.stringify(actual) === JSON.stringify(expected);
  return {
    loadOperation: (known) => call(operationStateRpcName, { p_known_interval_id: known ?? null }),
    claimOperation: (s, token) =>
      call(claimOperationRpcName, {
        p_interval_id: s.intervalId,
        p_expected_ownership_token: s.ownershipToken,
        p_new_ownership_token: token,
        p_declared_by: version ?? null,
      }),
    watchOperations: (changed) => {
      const channel = supabase
        .channel('engine-operation-maintenance')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'engine_maintenance_operation_signal' },
          changed
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
            changed();
        });
      return async () => {
        await supabase.removeChannel(channel);
      };
    },
    reportOperationReady: async (s, ids, waves) => {
      const result = await call(readyOperationRpcName, {
        ...identity(s),
        p_table_ids: [...ids],
        p_proof: {
          policy_version: 2,
          policy_digest: operationMaintenancePolicyDigest,
          runtime_version: version ?? null,
          between_hands: true,
          parked: true,
          pending_mutations: 0,
          resume_wave_table_ids: waves,
        },
      });
      const op = owned(s, result);
      if (
        op.phase !== 'ready' ||
        op.resumeWaves.length !== waves.length ||
        !sameIds([...waves.flat()].sort(), [...ids].sort()) ||
        op.resumeWaves.some(
          (w, index) =>
            w.index !== index ||
            !sameIds(w.tableIds, waves[index]) ||
            w.receiptId !== null ||
            w.resumedAt !== null ||
            w.creditedThroughAt !== null
        )
      ) {
        throw new Error('maintenance_readiness_acknowledgment_incomplete');
      }
    },
    reportOperationRecovery: async (s, reason) => {
      await call(recoveryOperationRpcName, { ...identity(s), p_reason: reason });
    },
    releaseOperationWave: async (s, index, ids) => {
      const result = await call(authorizeWaveRpcName, {
        ...identity(s),
        p_wave_index: index,
        p_table_ids: [...ids],
      });
      const operation = owned(s, result);
      const wave = operation.resumeWaves.find((w) => w.index === index);
      if (
        operation.phase !== 'releasing' ||
        !wave?.receiptId ||
        wave.creditedThroughAt === null ||
        wave.resumedAt !== null ||
        !sameIds(wave.tableIds, ids)
      ) {
        throw new Error('maintenance_wave_authorization_incomplete');
      }
      return {
        receiptId: wave.receiptId,
        intervalId: operation.intervalId,
        ownershipToken: operation.ownershipToken,
        tableIds: wave.tableIds,
        creditedThroughAt: wave.creditedThroughAt,
      };
    },
    acknowledgeOperationWave: async (s, index, receipt, ids, resumedAt) => {
      const acceptedAt = new Date(resumedAt).toISOString();
      const args = Object.freeze({
        ...identity(s),
        p_wave_index: index,
        p_receipt_id: receipt,
        p_resumed_table_ids: [...ids],
        p_resumed_at: acceptedAt,
      });
      let result: OperationMaintenanceSnapshot | undefined;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          result = await call(acknowledgeWaveRpcName, args);
          break;
        } catch (error) {
          // This exact SQL error occurs before a suffix write. No transport
          // error, malformed proof or unknown acknowledgment is retryable here.
          if (
            !(error instanceof Error) ||
            error.message !== 'MAINTENANCE_ACTUAL_RESUME_TIME_IN_FUTURE' ||
            attempt === 3
          )
            throw error;
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
      }
      if (!result) throw new Error('maintenance_wave_acknowledgment_missing');
      const op = owned(s, result),
        wave = op.resumeWaves.find((w) => w.index === index);
      if (
        !['releasing', 'resumed'].includes(op.phase) ||
        !wave ||
        wave.receiptId !== receipt ||
        !sameIds(wave.tableIds, ids) ||
        wave.resumedAt !== Date.parse(acceptedAt) ||
        wave.creditedThroughAt === null ||
        wave.resumedAt < wave.creditedThroughAt
      ) {
        throw new Error('maintenance_wave_acknowledgment_incomplete');
      }
    },
    completeOperationResume: async (s, receipts) => {
      const result = await call(completeOperationRpcName, {
        ...identity(s),
        p_wave_receipts: [...receipts],
      });
      const op = owned(s, result);
      if (
        !['releasing', 'resumed'].includes(op.phase) ||
        !op.globalTail ||
        (op.phase === 'resumed' &&
          (!op.globalTail.receiptId || op.globalTail.status !== 'released')) ||
        op.resumeWaves.some((w) => !w.receiptId || w.resumedAt === null) ||
        !sameIds(op.resumeWaves.map((w) => w.receiptId!).sort(), [...receipts].sort()) ||
        op.resumeWaves.length !== s.resumeWaves.length ||
        op.resumeWaves.some(
          (w, index) =>
            w.index !== s.resumeWaves[index].index ||
            !sameIds(w.tableIds, s.resumeWaves[index].tableIds)
        )
      ) {
        throw new Error('maintenance_full_resume_acknowledgment_incomplete');
      }
      return op;
    },
  };
}
