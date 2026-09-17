import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  HorseBrainTelemetryPublisher,
  type HorseBrainTelemetryCapture,
} from './HorseBrainTelemetryPublisher.js';

const source = 'c'.repeat(40);
const batch = (): HorseBrainTelemetryCapture => ({
  fires: [{ feature: 'phase15_execution_intended', fires: 2 }],
  latency: [
    { scope: 'phase8', samples: 2, totalMs: 3, maxMs: 2, buckets: [1, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
  ],
});
const ack = (payload: string, status = 'recorded') => ({
  data: {
    version: 1,
    status,
    batchId: JSON.parse(payload).batchId,
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
  },
  error: null,
});
function harness() {
  let time = new Date('2026-09-14T23:59:59.000Z');
  const capture = vi.fn(batch);
  const send = vi.fn(async (payload: string): Promise<any> => ack(payload));
  const getRelease = vi.fn((): string | null => source);
  const publisher = new HorseBrainTelemetryPublisher({
    capture,
    send,
    sourceRelease: getRelease,
    now: () => time,
  });
  return {
    publisher,
    capture,
    send,
    getRelease,
    setTime: (value: string) => {
      time = new Date(value);
    },
  };
}
describe('Horse Brain atomic telemetry publisher', () => {
  it('sends counters and latency in one exact source-bound batch', async () => {
    const h = harness();
    expect(await h.publisher.flush()).toBe('recorded');
    const first = JSON.parse(h.send.mock.calls[0][0]);
    expect(first).toMatchObject({
      version: 1,
      sequence: 1,
      sourceRelease: source,
      day: '2026-09-14',
      collectedAt: '2026-09-14T23:59:59.000Z',
      ...batch(),
    });
    expect(first.batchId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.workerId).not.toBe(first.batchId);
    await h.publisher.flush();
    const second = JSON.parse(h.send.mock.calls[1][0]);
    expect(second.workerId).toBe(first.workerId);
    expect(second.batchId).not.toBe(first.batchId);
    expect(second.sequence).toBe(2);
  });
  it('retains an uncertain write across midnight without recapturing or double-adding', async () => {
    const h = harness();
    const stored = new Set<string>();
    let total = 0;
    h.send.mockImplementation(async (payload) => {
      if (stored.has(payload)) return ack(payload, 'replayed');
      stored.add(payload);
      total += JSON.parse(payload).fires[0].fires;
      return { data: null, error: { message: 'ack lost' } };
    });
    await expect(h.publisher.flush()).rejects.toThrow('unconfirmed');
    h.setTime('2026-09-15T00:00:01.000Z');
    expect(await h.publisher.flush()).toBe('replayed');
    expect(h.capture).toHaveBeenCalledOnce();
    expect(h.send.mock.calls[1][0]).toBe(h.send.mock.calls[0][0]);
    expect(JSON.parse(h.send.mock.calls[1][0]).day).toBe('2026-09-14');
    expect(total).toBe(2);
  });
  it('retains bytes after a thrown transport failure and leaves new data for a later batch', async () => {
    const h = harness();
    const captured = batch();
    h.capture.mockReturnValueOnce(captured);
    h.send.mockRejectedValueOnce(Error('transport unavailable'));
    await expect(h.publisher.flush()).rejects.toThrow('transport unavailable');
    captured.fires[0].fires = 999;
    h.getRelease.mockReturnValue('d'.repeat(40));
    await h.publisher.flush();
    expect(h.send.mock.calls[1][0]).toBe(h.send.mock.calls[0][0]);
    expect(h.capture).toHaveBeenCalledOnce();
    await h.publisher.flush();
    expect(JSON.parse(h.send.mock.calls[2][0])).toMatchObject({
      sequence: 2,
      sourceRelease: 'd'.repeat(40),
    });
  });
  it.each(['null', 'array', 'version', 'status', 'batchId', 'digest'])(
    'does not discard a batch on an invalid %s acknowledgement',
    async (fault) => {
      const h = harness();
      h.send.mockImplementationOnce(async (payload) => {
        const reply = ack(payload) as any;
        if (fault === 'null') reply.data = null;
        if (fault === 'array') reply.data = [];
        if (fault === 'version') reply.data.version = 2;
        if (fault === 'status') reply.data.status = 'ok';
        if (fault === 'batchId') reply.data.batchId = 'other';
        if (fault === 'digest') reply.data.payloadSha256 = '0'.repeat(64);
        return reply;
      });
      await expect(h.publisher.flush()).rejects.toThrow('acknowledgement invalid');
      await h.publisher.flush();
      expect(h.send.mock.calls[1][0]).toBe(h.send.mock.calls[0][0]);
      expect(h.capture).toHaveBeenCalledOnce();
    }
  );
  it('coalesces concurrent flushes without draining a second batch', async () => {
    const h = harness();
    let finish!: (value: any) => void;
    h.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = h.publisher.flush(),
      second = h.publisher.flush();
    expect(first).toBe(second);
    expect(h.capture).toHaveBeenCalledOnce();
    finish(ack(h.send.mock.calls[0][0]));
    await first;
    await h.publisher.flush();
    expect(h.capture).toHaveBeenCalledTimes(2);
  });
  it.each([null, 'shortsha', 'z'.repeat(40)])(
    'keeps unknown release %s explicitly null',
    async (release) => {
      const h = harness();
      h.getRelease.mockReturnValue(release);
      await h.publisher.flush();
      expect(JSON.parse(h.send.mock.calls[0][0]).sourceRelease).toBeNull();
    }
  );
  it('does not allocate or send an empty batch', async () => {
    const h = harness();
    h.capture.mockReturnValueOnce({ fires: [], latency: [] });
    expect(await h.publisher.flush()).toBe('idle');
    expect(h.send).not.toHaveBeenCalled();
    await h.publisher.flush();
    expect(JSON.parse(h.send.mock.calls[0][0]).sequence).toBe(1);
  });
  it('retires only an explicit database expiry refusal, then accepts a fresh batch', async () => {
    const h = harness();
    h.send.mockResolvedValueOnce({
      data: null,
      error: { code: 'P0001', message: 'HORSE_FLUSH_EXPIRED' },
    });
    expect(await h.publisher.flush()).toBe('expired');
    expect(await h.publisher.flush()).toBe('recorded');
    expect(JSON.parse(h.send.mock.calls[1][0]).sequence).toBe(2);
  });
  it('does not treat an ambiguous expiry-looking message as confirmed refusal', async () => {
    const h = harness();
    h.send.mockResolvedValueOnce({ data: null, error: { message: 'HORSE_FLUSH_EXPIRED' } });
    await expect(h.publisher.flush()).rejects.toThrow('unconfirmed');
    await h.publisher.flush();
    expect(h.send.mock.calls[1][0]).toBe(h.send.mock.calls[0][0]);
  });
});
