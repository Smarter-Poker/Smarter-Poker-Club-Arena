import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocked = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn() }));
vi.mock('./supabase/client.js', () => ({ supabase: { rpc: mocked.rpc } }));
vi.mock('./errorReporter.js', () => ({ reportError: mocked.report }));
const ack = (payload: string, status = 'recorded') => ({
  data: {
    version: 1,
    status,
    batchId: JSON.parse(payload).batchId,
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
  },
  error: null,
});
let stop: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('GIT_COMMIT_SHA', 'c'.repeat(40));
  vi.stubEnv('BRAIN_TELEMETRY_ENABLED', 'true');
  mocked.rpc.mockReset();
  mocked.report.mockReset();
  mocked.rpc.mockImplementation((_name, args) => ({
    abortSignal: () => Promise.resolve(ack(args.p_payload)),
  }));
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
async function start() {
  const service = await import('./BrainTelemetryFlush.js');
  const telemetry = await import('../engine/BrainTelemetry.js');
  stop = service.stopBrainTelemetryFlush;
  service.startBrainTelemetryFlush();
  return { service, telemetry };
}
describe('actual Horse telemetry flush service', () => {
  it('atomically flushes both streams and retries the exact batch while new counts accumulate', async () => {
    const { service, telemetry } = await start();
    service.startBrainTelemetryFlush();
    mocked.rpc.mockImplementationOnce((_name, _args) => ({
      abortSignal: () => Promise.resolve({ data: null, error: { message: 'ack lost' } }),
    }));
    telemetry.noteFire('phase15_execution_intended');
    telemetry.noteDecisionMs('nlh', 2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocked.rpc).toHaveBeenCalledOnce();
    expect(mocked.rpc.mock.calls[0][0]).toBe('fn_horse_brain_flush_receipt');
    const original = mocked.rpc.mock.calls[0][1].p_payload;
    const first = JSON.parse(original);
    expect(first.sourceRelease).toBe('c'.repeat(40));
    expect(first.fires).toContainEqual({ feature: 'phase15_execution_intended', fires: 1 });
    expect(first.latency).toEqual(
      expect.arrayContaining([expect.objectContaining({ scope: 'nlh', samples: 1 })])
    );
    telemetry.noteFire('new_counter');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocked.rpc.mock.calls[1][1].p_payload).toBe(original);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(JSON.parse(mocked.rpc.mock.calls[2][1].p_payload).fires).toEqual([
      { feature: 'new_counter', fires: 1 },
    ]);
    expect(mocked.report).toHaveBeenCalledOnce();
  });
  it('drains the in-flight request on stop and cannot start a second write until it settles', async () => {
    const { service, telemetry } = await start();
    let finish!: (value: any) => void;
    mocked.rpc.mockImplementationOnce(() => ({
      abortSignal: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    }));
    telemetry.noteFire('before_stop');
    await vi.advanceTimersByTimeAsync(60_000);
    const firstStop = service.stopBrainTelemetryFlush();
    expect(service.stopBrainTelemetryFlush()).toBe(firstStop);
    service.startBrainTelemetryFlush();
    telemetry.noteFire('after_restart');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocked.rpc).toHaveBeenCalledOnce();
    finish(ack(mocked.rpc.mock.calls[0][1].p_payload));
    await firstStop;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocked.rpc).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocked.rpc.mock.calls[1][1].p_payload).fires).toEqual([
      { feature: 'after_restart', fires: 1 },
    ]);
  });
  it('makes an explicitly expired batch visible instead of silently counting it as written', async () => {
    const { telemetry } = await start();
    mocked.rpc.mockImplementationOnce(() => ({
      abortSignal: () =>
        Promise.resolve({ data: null, error: { code: 'P0001', message: 'HORSE_FLUSH_EXPIRED' } }),
    }));
    telemetry.noteFire('expired_counter');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocked.report).toHaveBeenCalledWith(expect.any(Error), 'BrainTelemetryFlush.expired');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(JSON.parse(mocked.rpc.mock.calls[1][1].p_payload).fires).toEqual([
      { feature: 'phase15_telemetry_batch_expired', fires: 1 },
    ]);
  });
  it('does not write empty batches or schedule writes after stopping', async () => {
    const { service, telemetry } = await start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocked.rpc).not.toHaveBeenCalled();
    await service.stopBrainTelemetryFlush();
    telemetry.noteFire('still_unflushed');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocked.rpc).not.toHaveBeenCalled();
  });
});
