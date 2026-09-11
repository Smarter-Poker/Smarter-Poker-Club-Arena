import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAINTENANCE_THAW_STEPS,
  runMaintenanceThawV3,
  type MaintenanceThawRequest,
} from './maintenanceThawV3.js';
const request: MaintenanceThawRequest = {
  announcedAt: Date.parse('2026-09-11T12:53:00Z'),
  freezeStartedAt: Date.parse('2026-09-11T12:55:00Z'),
  frozenSeconds: 300,
  ownershipToken: 'a3090000-0000-4000-8000-000000000001',
  thawedBy: 'test',
};
function response(patch: Record<string, unknown> = {}) {
  return {
    ok: true,
    complete: true,
    released: true,
    abandoned: false,
    retryable: false,
    reason: 'thaw_complete_release_scheduled',
    freeze_started_at: new Date(request.freezeStartedAt).toISOString(),
    ownership_token: request.ownershipToken,
    credited_through_at: '2026-09-11T13:00:08.000Z',
    effective_frozen_seconds: 308,
    shifted: {
      ...Object.fromEntries(MAINTENANCE_THAW_STEPS.map((step) => [step, 0])),
      complete: true,
    },
    ...patch,
  };
}
const signal = () => new AbortController().signal;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('current maintenance thaw v3 request and release certificate', () => {
  it('sends all five exact arguments and returns the future certificate without calling it a local release', async () => {
    const call = vi.fn(async () => response());
    const release = await runMaintenanceThawV3(request, call, { signal: signal() });
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith({
      p_announced_at: '2026-09-11T12:53:00.000Z',
      p_freeze_started: '2026-09-11T12:55:00.000Z',
      p_frozen_seconds: 300,
      p_ownership_token: request.ownershipToken,
      p_thawed_by: 'test',
    });
    expect(release.creditedThroughAt).toBe(Date.parse('2026-09-11T13:00:08Z'));
    expect(release.effectiveFrozenSeconds).toBe(308);
  });
  it('honors not-due retry hints, then checkpoints before accepting a complete release', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          complete: false,
          released: false,
          retryable: true,
          reason: 'maintenance_break_not_due',
          retry_after_ms: 2000,
        })
      )
      .mockResolvedValueOnce(
        response({
          complete: false,
          released: false,
          retryable: true,
          reason: 'thaw_tail_checkpointed',
          retry_after_ms: 0,
        })
      )
      .mockResolvedValue(response());
    const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
    await runMaintenanceThawV3(request, call, { signal: signal(), sleep });
    expect(sleep.mock.calls.map((args) => args[0])).toEqual([2000, 250]);
    expect(call.mock.calls.every((args) => args[0] === call.mock.calls[0][0])).toBe(true);
  });
  it('recovers an exact already-committed release after a lost response', async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue(response({ reason: 'release_receipt_recovered' }));
    await expect(
      runMaintenanceThawV3(request, call, { signal: signal(), sleep: async () => {} })
    ).resolves.toMatchObject({
      ownershipToken: request.ownershipToken,
      effectiveFrozenSeconds: 308,
    });
    expect(call.mock.calls[0][0]).toBe(call.mock.calls[1][0]);
  });
  it.each([
    ['missing release', { released: false }],
    ['wrong owner', { ownership_token: 'a3090000-0000-4000-8000-000000000002' }],
    ['wrong freeze', { freeze_started_at: '2026-09-11T12:54:00Z' }],
    ['missing endpoint', { credited_through_at: null }],
    ['inconsistent credit', { effective_frozen_seconds: 300 }],
    ['aggregate-only legacy response', { reason: 'already_thawed', shifted: { complete: true } }],
    ['missing step', { shifted: { complete: true } }],
    ['abandoned', { abandoned: true }],
  ])('refuses %s without a fallback request', async (_name, patch) => {
    const call = vi.fn(async () => response(patch));
    await expect(runMaintenanceThawV3(request, call, { signal: signal() })).rejects.toMatchObject({
      retryable: false,
    });
    expect(call).toHaveBeenCalledOnce();
  });
  it.each(['maintenance_ownership_changed', 'legacy_inflight_thaw_requires_quiescent_cutover'])(
    'retains explicit refusal %s without retrying the legacy bridge',
    async (reason) => {
      const call = vi.fn(async () => ({ ok: false, complete: false, reason }));
      await expect(runMaintenanceThawV3(request, call, { signal: signal() })).rejects.toThrow(
        reason
      );
      expect(call).toHaveBeenCalledOnce();
    }
  );
  it('returns a retryable attempt failure without pretending incomplete work released the break', async () => {
    const call = vi.fn(async () =>
      response({
        complete: false,
        released: false,
        retryable: true,
        reason: 'thaw_checkpointed',
        retry_after_ms: 0,
      })
    );
    await expect(
      runMaintenanceThawV3(request, call, { signal: signal(), sleep: async () => {}, maxCalls: 2 })
    ).rejects.toMatchObject({ retryable: true });
    expect(call).toHaveBeenCalledTimes(2);
  });
  it('aborts a not-due wait immediately and never issues the next request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const call = vi.fn(async () =>
      response({
        complete: false,
        released: false,
        retryable: true,
        reason: 'maintenance_break_not_due',
        retry_after_ms: 180000,
      })
    );
    const pending = runMaintenanceThawV3(request, call, { signal: controller.signal });
    const result = expect(pending).rejects.toThrow('old lifecycle stopped');
    await Promise.resolve();
    controller.abort(new Error('old lifecycle stopped'));
    await result;
    await vi.advanceTimersByTimeAsync(180000);
    expect(call).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refuses a delayed complete response after lifecycle cancellation', async () => {
    const controller = new AbortController();
    let finish!: (result: unknown) => void;
    const call = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = runMaintenanceThawV3(request, call, { signal: controller.signal });
    const result = expect(pending).rejects.toThrow('old owner');
    controller.abort(new Error('old owner'));
    finish(response());
    await result;
  });
});
