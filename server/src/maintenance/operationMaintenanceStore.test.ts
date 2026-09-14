import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ maintenanceSupabase: { rpc }, supabase: {} }));
vi.mock('../services/supabase/dataActorContext.js', () => ({
  bindToProcessRoot: (call: unknown) => call,
}));
import {
  createOperationMaintenanceStore,
  parseOperationSnapshot,
} from './operationMaintenanceStore.js';

const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const start = Date.parse('2026-09-11T12:34:00.123Z');
const at = (n: number) => new Date(start + n).toISOString();
const groups = [[id(11), id(10)], [id(12)]];
function response(phase = 'release_authorized') {
  return {
    policy_version: 2,
    activation_receipt: id(5),
    observed_at: at(800000),
    operation: {
      policy_version: 2,
      operation_id: id(1),
      release_id: id(2),
      interval_id: id(3),
      ownership_token: id(4),
      generation: 2,
      phase,
      scope: { type: 'platform' },
      freeze_started_at: at(0),
      target_at: at(300000),
      forward_deadline_at: at(1200000),
      deadline_at: at(1800000),
      observed_at: at(800000),
      release_receipt: id(7) as string | null,
      reason: 'Engine maintenance',
      global_tail: null as Record<string, unknown> | null,
      resume_waves: groups.map((table_ids, index) => ({
        index,
        table_ids,
        receipt_id: null as string | null,
        credited_through_at: null as string | null,
        resumed_at: null as string | null,
      })),
    },
  };
}
const state = () => parseOperationSnapshot(response()).operation!;
function acknowledged() {
  const r = response('releasing');
  Object.assign(r.operation.resume_waves[0], {
    receipt_id: id(20),
    credited_through_at: at(500000),
    resumed_at: at(500010),
  });
  return r;
}
function completed() {
  const r = response('resumed');
  for (const w of r.operation.resume_waves)
    Object.assign(w, {
      receipt_id: id(20 + w.index),
      credited_through_at: at(500000),
      resumed_at: at(500010),
    });
  r.operation.global_tail = {
    checkpoint_id: id(90),
    checkpoint_no: 1,
    credited_through_at: at(799999),
    remaining: 0,
    receipt_id: id(91),
    receipt_ownership_token: id(4),
    receipt_generation: 2,
    certified_at: at(799000),
    target_count: 14,
    target_digest: 'a'.repeat(64),
    status: 'released',
  };
  return r;
}
const answer = (data: unknown) => rpc.mockResolvedValueOnce({ data, error: null });
beforeEach(() => rpc.mockReset());

describe('operation write acknowledgments', () => {
  it('exposes every actual support RPC to the deployment engine-door scanner', async () => {
    const scanner = await import(
      new URL('../../../scripts/ci/check-engine-doors-exist.mjs', import.meta.url).href
    );
    const source = readFileSync(new URL('./operationMaintenanceStore.ts', import.meta.url), 'utf8');
    expect([...scanner.doorsIn(source)].sort()).toEqual(
      [
        'fn_engine_maintenance_operation',
        'fn_claim_engine_maintenance_operation',
        'fn_engine_maintenance_ready',
        'fn_engine_maintenance_recovery',
        'fn_authorize_engine_maintenance_wave',
        'fn_ack_engine_maintenance_wave',
        'fn_ack_engine_maintenance_resumed',
      ].sort()
    );
  });
  it.each([
    'operation_id',
    'release_id',
    'interval_id',
    'ownership_token',
    'release_receipt',
    'generation',
  ])('refuses changed %s before returning physical resume authority', async (field) => {
    const r = acknowledged();
    r.operation.resume_waves[0].resumed_at = null;
    (r.operation as Record<string, unknown>)[field] = field === 'generation' ? 3 : id(80);
    answer(r);
    await expect(
      createOperationMaintenanceStore().releaseOperationWave(state(), 0, groups[0])
    ).rejects.toThrow('write_identity_changed');
  });
  it.each(['ready', 'release_authorized', 'recovering', 'recovery_required', 'resumed'])(
    'refuses %s before returning physical resume authority',
    async (phase) => {
      const r = acknowledged();
      r.operation.phase = phase;
      r.operation.resume_waves[0].resumed_at = null;
      answer(r);
      await expect(
        createOperationMaintenanceStore().releaseOperationWave(state(), 0, groups[0])
      ).rejects.toThrow(/authorization_incomplete|global_release_receipt_missing/);
    }
  );
  it('requires the exact ordered and still-unresumed wave before physical resume', async () => {
    const r = acknowledged();
    r.operation.resume_waves[0].resumed_at = null;
    answer(r);
    await expect(
      createOperationMaintenanceStore().releaseOperationWave(state(), 0, groups[0])
    ).resolves.toMatchObject({ tableIds: groups[0], receiptId: id(20) });
    const reordered = structuredClone(r);
    reordered.operation.resume_waves[0].table_ids = [...groups[0]].reverse();
    answer(reordered);
    await expect(
      createOperationMaintenanceStore().releaseOperationWave(state(), 0, groups[0])
    ).rejects.toThrow(/authorization_incomplete|global_release_receipt_missing/);
    answer(acknowledged());
    await expect(
      createOperationMaintenanceStore().releaseOperationWave(state(), 0, groups[0])
    ).rejects.toThrow(/authorization_incomplete|global_release_receipt_missing/);
  });
  it('rounds a fractional credited lower boundary upward without changing the accepted resume time', () => {
    const r = acknowledged();
    r.operation.resume_waves[0].credited_through_at = at(500000).replace('Z', '501Z');
    const wave = parseOperationSnapshot(r).operation!.resumeWaves[0];
    expect(wave.creditedThroughAt).toBe(start + 500001);
    expect(wave.resumedAt).toBe(start + 500010);
  });
  it('accepts the exact persisted wave and forwards its original order and accepted timestamp', async () => {
    answer(acknowledged());
    await createOperationMaintenanceStore().acknowledgeOperationWave(
      state(),
      0,
      id(20),
      groups[0],
      start + 500010.9
    );
    expect(rpc).toHaveBeenCalledWith('fn_ack_engine_maintenance_wave', {
      p_interval_id: id(3),
      p_ownership_token: id(4),
      p_wave_index: 0,
      p_receipt_id: id(20),
      p_resumed_table_ids: groups[0],
      p_resumed_at: at(500010),
    });
  });
  it.each([
    'operation_id',
    'release_id',
    'interval_id',
    'ownership_token',
    'release_receipt',
  ] as const)('refuses changed %s', async (field) => {
    const r = acknowledged();
    r.operation[field] = id(80);
    answer(r);
    await expect(
      createOperationMaintenanceStore().acknowledgeOperationWave(
        state(),
        0,
        id(20),
        groups[0],
        start + 500010
      )
    ).rejects.toThrow('write_identity_changed');
  });
  it('refuses a different generation', async () => {
    const r = acknowledged();
    r.operation.generation++;
    answer(r);
    await expect(
      createOperationMaintenanceStore().acknowledgeOperationWave(
        state(),
        0,
        id(20),
        groups[0],
        start + 500010
      )
    ).rejects.toThrow('write_identity_changed');
  });
  it.each(['recovery_required', 'recovering', 'release_authorized'])(
    'refuses %s even without an RPC error',
    async (phase) => {
      const r = acknowledged();
      r.operation.phase = phase;
      answer(r);
      await expect(
        createOperationMaintenanceStore().acknowledgeOperationWave(
          state(),
          0,
          id(20),
          groups[0],
          start + 500010
        )
      ).rejects.toThrow('acknowledgment_incomplete');
    }
  );
  it.each(['receipt', 'order', 'timestamp', 'unacknowledged'])(
    'refuses a different %s',
    async (kind) => {
      const r = acknowledged(),
        w = r.operation.resume_waves[0];
      if (kind === 'receipt') w.receipt_id = id(80);
      if (kind === 'order') w.table_ids = [...w.table_ids].reverse();
      if (kind === 'timestamp') w.resumed_at = at(500011);
      if (kind === 'unacknowledged') w.resumed_at = null;
      answer(r);
      await expect(
        createOperationMaintenanceStore().acknowledgeOperationWave(
          state(),
          0,
          id(20),
          groups[0],
          start + 500010
        )
      ).rejects.toThrow('acknowledgment_incomplete');
    }
  );
  it('requires full resumed state with every exact receipt and durable table plan', async () => {
    answer(completed());
    await createOperationMaintenanceStore().completeOperationResume(state(), [id(20), id(21)]);
    const pending = completed();
    pending.operation.phase = 'releasing';
    pending.operation.global_tail = null;
    answer(pending);
    await expect(
      createOperationMaintenanceStore().completeOperationResume(state(), [id(20), id(21)])
    ).rejects.toThrow('full_resume_acknowledgment_incomplete');
    const wrong = completed();
    wrong.operation.resume_waves[1].receipt_id = id(80);
    answer(wrong);
    await expect(
      createOperationMaintenanceStore().completeOperationResume(state(), [id(20), id(21)])
    ).rejects.toThrow('full_resume_acknowledgment_incomplete');
    const reordered = completed();
    reordered.operation.resume_waves[0].table_ids = [...groups[0]].reverse();
    answer(reordered);
    await expect(
      createOperationMaintenanceStore().completeOperationResume(state(), [id(20), id(21)])
    ).rejects.toThrow('full_resume_acknowledgment_incomplete');
  });
  it('retries only the explicit prewrite future-time refusal with identical ACK arguments', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'MAINTENANCE_ACTUAL_RESUME_TIME_IN_FUTURE' },
    });
    answer(acknowledged());
    await createOperationMaintenanceStore().acknowledgeOperationWave(
      state(),
      0,
      id(20),
      groups[0],
      start + 500010
    );
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });
  it.each(['network response unknown', 'MAINTENANCE_ACTUAL_RESUME_TIME_INVALID'])(
    'does not retry %s as a clock catch-up',
    async (message) => {
      rpc.mockResolvedValue({ data: null, error: { message } });
      await expect(
        createOperationMaintenanceStore().acknowledgeOperationWave(
          state(),
          0,
          id(20),
          groups[0],
          start + 500010
        )
      ).rejects.toThrow(message);
      expect(rpc).toHaveBeenCalledTimes(1);
    }
  );
  it('bounds repeated future-time refusals without inventing a new timestamp', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'MAINTENANCE_ACTUAL_RESUME_TIME_IN_FUTURE' },
    });
    await expect(
      createOperationMaintenanceStore().acknowledgeOperationWave(
        state(),
        0,
        id(20),
        groups[0],
        start + 500010
      )
    ).rejects.toThrow('IN_FUTURE');
    expect(rpc).toHaveBeenCalledTimes(4);
    expect(
      rpc.mock.calls.every((call) => JSON.stringify(call) === JSON.stringify(rpc.mock.calls[0]))
    ).toBe(true);
  });
  it('accepts durable partial global progress without treating it as full release', async () => {
    const pending = completed();
    pending.operation.phase = 'releasing';
    pending.operation.global_tail = {
      checkpoint_id: id(90),
      checkpoint_no: 1,
      credited_through_at: at(805000),
      remaining: 301,
      receipt_id: null,
      receipt_ownership_token: null,
      receipt_generation: null,
      certified_at: null,
      target_count: null,
      target_digest: null,
      status: 'pending',
    };
    answer(pending);
    const progress = await createOperationMaintenanceStore().completeOperationResume(state(), [
      id(20),
      id(21),
    ]);
    expect(progress.phase).toBe('releasing');
    expect(progress.globalTail).toMatchObject({
      remaining: 301,
      receiptId: null,
      status: 'pending',
    });
  });
  it.each(['remaining', 'target_digest', 'receipt_generation'])(
    'refuses a malformed global certificate %s',
    async (field) => {
      const invalid = completed();
      invalid.operation.global_tail![field] =
        field === 'remaining' ? 1 : field === 'receipt_generation' ? 3 : 'not-a-digest';
      answer(invalid);
      await expect(
        createOperationMaintenanceStore().completeOperationResume(state(), [id(20), id(21)])
      ).rejects.toThrow('global_tail_invalid');
    }
  );
  it('requires a persisted ready phase and exact complete ordered wave plan', async () => {
    const initial = response('last_hand');
    initial.operation.release_receipt = null;
    const s = parseOperationSnapshot(initial).operation!;
    const ready = response('ready');
    ready.operation.release_receipt = null;
    answer(ready);
    await createOperationMaintenanceStore().reportOperationReady(s, groups.flat(), groups);
    const pending = structuredClone(ready);
    pending.operation.phase = 'draining';
    answer(pending);
    await expect(
      createOperationMaintenanceStore().reportOperationReady(s, groups.flat(), groups)
    ).rejects.toThrow('readiness_acknowledgment_incomplete');
    const changed = structuredClone(ready);
    changed.operation.resume_waves[0].table_ids = [...groups[0]].reverse();
    answer(changed);
    await expect(
      createOperationMaintenanceStore().reportOperationReady(s, groups.flat(), groups)
    ).rejects.toThrow('readiness_acknowledgment_incomplete');
  });
});
