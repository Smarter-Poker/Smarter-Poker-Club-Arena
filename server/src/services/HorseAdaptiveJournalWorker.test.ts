import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HorseAdaptiveJournalWorker } from './HorseAdaptiveJournalWorker.js';
class Child extends EventEmitter {
  postMessage = vi.fn();
  terminate = vi.fn(async () => {
    this.emit('exit', 1);
    return 1;
  });
}
let children: Child[], service: HorseAdaptiveJournalWorker;
beforeEach(() => {
  vi.useFakeTimers();
  children = [];
  service = new HorseAdaptiveJournalWorker(() => {
    const c = new Child();
    children.push(c);
    return c;
  });
});
afterEach(async () => {
  const stopped = service.stop().catch(() => undefined);
  await vi.advanceTimersByTimeAsync(20001);
  await stopped;
  vi.useRealTimers();
});
const ready = (c: Child) => c.emit('message', { type: 'READY' });
describe('journal worker lifecycle owner', () => {
  it('keeps discovery separate from capture and journal completions and strips malformed discovery data', () => {
    service.start();
    ready(children[0]);
    for (const discovery of [
      { version: 1, status: 'idle', retainedGaps: 0 },
      { version: 1, status: 'idle', privateCards: ['As', 'Ad'] },
    ]) {
      children[0].emit('message', { type: 'CYCLE_STARTED' });
      children[0].emit('message', {
        type: 'CYCLE_COMPLETED',
        work: 'skipped',
        retention: 'skipped',
        discovery,
      });
    }
    expect(service.status()).toMatchObject({
      phase: 'ready',
      cycles: 2,
      completed: 0,
      capturesAdmitted: 0,
      lastDiscovery: { status: 'unknown' },
      uncertain: 1,
      discoveryReceivedAt: Date.now(),
    });
    expect(JSON.stringify(service.status())).not.toContain('privateCards');
  });
  it('rejects discovery mislabeled as journal completion', () => {
    service.start();
    ready(children[0]);
    children[0].emit('message', { type: 'CYCLE_STARTED' });
    children[0].emit('message', {
      type: 'CYCLE_COMPLETED',
      work: 'completed',
      retention: 'skipped',
      discovery: { version: 1, status: 'idle' },
    });
    expect(service.status().completed).toBe(0);
    expect(service.status().phase).not.toBe('ready');
  });
  it('counts source admissions separately from journal completions and retains explicit gaps', () => {
    service.start();
    ready(children[0]);
    for (const acquisition of ['admitted', 'refined', 'continued', 'captured', 'gap', 'unknown']) {
      children[0].emit('message', { type: 'CYCLE_STARTED' });
      children[0].emit('message', {
        type: 'CYCLE_COMPLETED',
        work: 'skipped',
        retention: 'skipped',
        acquisition,
        actorId: 'must-not-leave-worker',
      });
    }
    expect(service.status()).toMatchObject({
      completed: 0,
      capturesAdmitted: 1,
      capturesRefined: 1,
      captureSlicesContinued: 1,
      capturesRecovered: 1,
      captureGaps: 1,
      uncertain: 1,
      lastCapture: 'unknown',
    });
    expect(JSON.stringify(service.status())).not.toContain('must-not-leave-worker');
  });
  it('rejects an acquisition result mislabeled as journal completion', () => {
    service.start();
    ready(children[0]);
    children[0].emit('message', { type: 'CYCLE_STARTED' });
    children[0].emit('message', {
      type: 'CYCLE_COMPLETED',
      work: 'completed',
      retention: 'skipped',
      acquisition: 'admitted',
    });
    expect(service.status().completed).toBe(0);
    expect(service.status().phase).not.toBe('ready');
  });
  it('reports only validated queue aggregates and expires stale samples while the worker stays responsive', async () => {
    service.start();
    ready(children[0]);
    children[0].emit('message', { type: 'CYCLE_STARTED' });
    children[0].emit('message', {
      type: 'QUEUE_HEALTH',
      value: {
        version: 1,
        status: 'snapshot',
        sampledAtMs: Date.now(),
        unfinished: 0,
        queued: 0,
        leased: 0,
        quarantined: 0,
        ready: 0,
        expiredLeases: 0,
        bufferedBytes: 0,
        oldestWorkAgeMs: 0,
        maxAttempts: 0,
        payload: 'private',
      },
    });
    children[0].emit('message', {
      type: 'CAPTURE_HEALTH',
      value: {
        version: 1,
        status: 'snapshot',
        sampledAtMs: Date.now(),
        unfinished: 1,
        queued: 0,
        leased: 0,
        gaps: 1,
        ready: 0,
        expiredLeases: 0,
        oldestWorkAgeMs: 1000,
        maxAttempts: 1,
        actorId: 'private-capture-identity',
      },
    });
    children[0].emit('message', { type: 'CYCLE_COMPLETED', work: 'idle', retention: 'pruned' });
    expect(service.status().queueHealth.status).toBe('snapshot');
    expect(service.status().captureQueueHealth).toMatchObject({ status: 'snapshot', gaps: 1 });
    expect(JSON.stringify(service.status())).not.toContain('private');
    for (let n = 0; n < 16; n++) {
      children[0].emit('message', { type: 'HEARTBEAT' });
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(service.status().phase).toBe('ready');
    expect(service.status().queueHealth).toEqual({ status: 'unknown' });
    expect(service.status().captureQueueHealth).toEqual({ status: 'unknown' });
  });
  it('starts one generation and exposes only validated aggregate status', async () => {
    expect(service.start()).toBe(true);
    expect(service.start()).toBe(true);
    expect(children).toHaveLength(1);
    ready(children[0]);
    children[0].emit('message', { type: 'CYCLE_STARTED' });
    children[0].emit('message', {
      type: 'CYCLE_COMPLETED',
      work: 'completed',
      retention: 'pruned',
      payload: 'private',
    });
    expect(service.status()).toMatchObject({
      phase: 'ready',
      cycles: 1,
      completed: 1,
      activeSince: null,
    });
    expect(JSON.stringify(service.status())).not.toContain('private');
    expect(Object.isFrozen(service.status())).toBe(true);
  });
  it('does not treat startup heartbeats as a ready worker', async () => {
    service.start();
    await vi.advanceTimersByTimeAsync(5000);
    children[0].emit('message', { type: 'HEARTBEAT' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(children[0].terminate).toHaveBeenCalledTimes(1);
    expect(service.status().phase).toBe('recovering');
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(2);
  });
  it('limits a stuck active cycle even while heartbeats continue', async () => {
    service.start();
    ready(children[0]);
    children[0].emit('message', { type: 'CYCLE_STARTED' });
    for (let n = 0; n < 6; n++) {
      children[0].emit('message', { type: 'HEARTBEAT' });
      await vi.advanceTimersByTimeAsync(5000);
    }
    expect(children[0].terminate).toHaveBeenCalledTimes(1);
    expect(service.status().phase).toBe('recovering');
  });
  it('does not start a replacement until the old worker terminates and ignores late messages', async () => {
    service.start();
    ready(children[0]);
    let release!: (n: number) => void;
    children[0].terminate.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    children[0].emit('error', Error('failed'));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4000);
    expect(children).toHaveLength(1);
    release(1);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(children).toHaveLength(2);
    ready(children[1]);
    children[0].emit('message', { type: 'FAILED' });
    expect(service.status().phase).toBe('ready');
  });
  it('has only three automatic restarts per hour', async () => {
    service.start();
    for (const delay of [1000, 5000, 30000]) {
      children.at(-1)!.emit('error', Error('failed'));
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(children).toHaveLength(4);
    children.at(-1)!.emit('error', Error('failed'));
    await vi.advanceTimersByTimeAsync(120000);
    expect(children).toHaveLength(4);
    expect(service.status()).toMatchObject({ phase: 'failed', restarts: 3 });
  });
  it('cancels pending replacement on stop', async () => {
    service.start();
    children[0].emit('error', Error('failed'));
    await Promise.resolve();
    await Promise.resolve();
    await service.stop();
    await vi.advanceTimersByTimeAsync(120000);
    expect(children).toHaveLength(1);
    expect(service.status().phase).toBe('stopped');
  });
  it('stopping during startup prevents ready from reviving the generation and waits for exit', async () => {
    service.start();
    const a = service.stop();
    expect(service.stop()).toBe(a);
    expect(service.start()).toBe(false);
    ready(children[0]);
    expect(service.status().phase).toBe('stopping');
    expect(children[0].postMessage).toHaveBeenCalledWith({ type: 'STOP' });
    children[0].emit('exit', 0);
    await a;
    expect(children[0].terminate).not.toHaveBeenCalled();
    expect(service.status().phase).toBe('stopped');
  });
  it('terminates an unresponsive stop after20s without releasing ownership earlier', async () => {
    service.start();
    const a = service.stop();
    await vi.advanceTimersByTimeAsync(19999);
    expect(children[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await a;
    expect(children[0].terminate).toHaveBeenCalledTimes(1);
    expect(service.status().phase).toBe('stopped');
  });
  it('a failed termination cannot certify stop or start another worker', async () => {
    service.start();
    children[0].terminate.mockRejectedValue(Error('still owned'));
    const a = service.stop();
    const rejected = expect(a).rejects.toThrow('still owned');
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    expect(service.status().phase).toBe('failed');
    expect(service.start()).toBe(false);
  });
  it('rejects malformed completion rather than accepting a forged count', async () => {
    service.start();
    ready(children[0]);
    children[0].emit('message', { type: 'CYCLE_STARTED' });
    children[0].emit('message', {
      type: 'CYCLE_COMPLETED',
      work: 'some-secret-string',
      retention: 'pruned',
    });
    await Promise.resolve();
    expect(service.status().cycles).toBe(0);
    expect(children[0].terminate).toHaveBeenCalledTimes(1);
  });
});
