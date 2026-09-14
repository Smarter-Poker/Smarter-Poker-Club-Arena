import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
const m = vi.hoisted(() => ({ rpc: vi.fn(), reply: vi.fn(), read: vi.fn(), prepare: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: m.rpc } }));
vi.mock('./HorseCommittedObservationSnapshot.js', () => ({
  readCommittedObservationSnapshot: m.read,
}));
vi.mock('./HorseAdaptiveObservationJournal.js', () => ({ prepareAdaptiveJournalBatch: m.prepare }));
import {
  admitObservationCapture as admit,
  processObservationCapture as processOne,
  pruneObservationCaptures as prune,
} from './HorseObservationCapture.js';
const request = { actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', fromMs: 1000, throughMs: 2000 };
const key = createHash('sha256')
  .update(['horse-source-request-v1', request.actorId, 1000, 2000].join('|'))
  .digest('hex');
const batch = {
  status: 'prepared',
  payload: 'fixture',
  batchKey: 'b'.repeat(64),
  batchDigest: 'c'.repeat(64),
  observations: 12,
};
beforeEach(() => {
  vi.clearAllMocks();
  m.rpc.mockImplementation((name, p) => ({
    abortSignal: (signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return m.reply(name, p);
    },
  }));
  m.reply.mockImplementation(async (name, p) => ({
    error: null,
    data:
      name === 'fn_claim_horse_observation_capture'
        ? {
            version: 1,
            status: 'claimed',
            requestKey: key,
            leaseToken: p.p_lease_token,
            ...request,
          }
        : name === 'fn_admit_horse_observation_capture'
          ? { version: 1, status: 'durable', requestKey: key, state: 'queued' }
          : { ...batch, version: 1, requestKey: key, status: 'admitted' },
  }));
  m.read.mockResolvedValue({ status: 'snapshot' });
  m.prepare.mockReturnValue(batch);
});
describe('durable observation acquisition client', () => {
  it('durably admits before any source read and freezes its returned identity', async () => {
    const r = await admit(request);
    expect(r).toEqual({ status: 'durable', requestKey: key, state: 'queued' });
    expect(Object.isFrozen(r)).toBe(true);
    expect(m.read).not.toHaveBeenCalled();
  });
  it('captures input scope before a mutable caller changes it', async () => {
    const r = { ...request };
    m.reply.mockImplementationOnce(async () => {
      r.actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      return {
        error: null,
        data: { version: 1, status: 'durable', requestKey: key, state: 'queued' },
      };
    });
    expect((await admit(r)).status).toBe('durable');
    expect(m.rpc.mock.calls[0][1].p_actor).toBe(request.actorId);
  });
  it('keeps lost admission acknowledgment unknown', async () => {
    m.reply.mockRejectedValueOnce(Error('reply lost'));
    expect(await admit(request)).toEqual({ status: 'unknown', requestKey: key });
  });
  it('rejects invalid scope before I/O', async () => {
    expect((await admit({ ...request, throughMs: request.fromMs })).status).toBe('unavailable');
    expect(m.rpc).not.toHaveBeenCalled();
  });
  it('acquires the claimed original window and requires exact queued-payload admission', async () => {
    expect(await processOne()).toEqual({ status: 'admitted', requestKey: key });
    expect(m.read).toHaveBeenCalledWith(request);
    expect(m.rpc.mock.calls.map((c) => c[0])).toEqual([
      'fn_claim_horse_observation_capture',
      'fn_finish_horse_observation_capture',
    ]);
    expect(m.rpc.mock.calls[1][1]).toMatchObject({
      p_request_key: key,
      p_payload: batch.payload,
      p_reason: null,
    });
  });
  it.each(['key', 'token', 'scope'])(
    'refuses mismatched claim %s before source I/O',
    async (defect) => {
      m.reply.mockImplementationOnce(async (_n, p) => ({
        error: null,
        data: {
          version: 1,
          status: 'claimed',
          requestKey: defect === 'key' ? 'd'.repeat(64) : key,
          leaseToken: defect === 'token' ? 'wrong' : p.p_lease_token,
          ...request,
          throughMs: defect === 'scope' ? 3000 : 2000,
        },
      }));
      expect((await processOne()).status).toBe('unavailable');
      expect(m.read).not.toHaveBeenCalled();
      expect(m.rpc).toHaveBeenCalledTimes(1);
    }
  );
  it.each(['hash', 'key', 'count', 'lost'])(
    'keeps incorrect or lost admission %s unknown',
    async (defect) => {
      const original = m.reply.getMockImplementation()!;
      m.reply.mockImplementation(async (n, p) => {
        if (n.includes('claim')) return original(n, p);
        if (defect === 'lost') throw Error('lost');
        return {
          error: null,
          data: {
            version: 1,
            status: 'admitted',
            requestKey: key,
            batchKey: defect === 'key' ? 'd'.repeat(64) : batch.batchKey,
            batchDigest: defect === 'hash' ? 'd'.repeat(64) : batch.batchDigest,
            observations: defect === 'count' ? 0 : 12,
          },
        };
      });
      expect((await processOne()).status).toBe('unknown');
    }
  );
  it.each(['source_unavailable', 'atomic_receipt_missing', 'invalid_source'])(
    'transport/receipt uncertainty %s does not become a permanent gap',
    async (reason) => {
      m.read.mockResolvedValue({ status: 'unavailable', reason });
      const original = m.reply.getMockImplementation()!;
      m.reply.mockImplementation(async (n, p) =>
        n.includes('claim')
          ? original(n, p)
          : {
              error: null,
              data: {
                version: 1,
                status: 'deferred',
                requestKey: key,
                reason: 'source_unavailable',
              },
            }
      );
      expect((await processOne()).status).toBe('deferred');
      expect(m.rpc.mock.calls[1][1]).toMatchObject({
        p_payload: null,
        p_reason: 'source_unavailable',
      });
    }
  );
  it('records an oversized source as an explicit gap without truncating it', async () => {
    m.read.mockResolvedValue({ status: 'unavailable', reason: 'hand_budget_exceeded' });
    const original = m.reply.getMockImplementation()!;
    m.reply.mockImplementation(async (n, p) =>
      n.includes('claim')
        ? original(n, p)
        : {
            error: null,
            data: { version: 1, status: 'gap', requestKey: key, reason: 'source_budget_exceeded' },
          }
    );
    expect((await processOne()).status).toBe('gap');
    expect(m.prepare).not.toHaveBeenCalled();
  });
  it('does not read source for idle or expired-gap claims', async () => {
    m.reply.mockResolvedValueOnce({ error: null, data: { version: 1, status: 'idle' } });
    expect(await processOne()).toEqual({ status: 'idle' });
    m.reply.mockResolvedValueOnce({
      error: null,
      data: { version: 1, status: 'gap', requestKey: key, reason: 'source_expired' },
    });
    expect((await processOne()).status).toBe('gap');
    expect(m.read).not.toHaveBeenCalled();
  });
  it('retains queue backpressure and lease loss without reporting journal completion', async () => {
    const original = m.reply.getMockImplementation()!;
    m.reply.mockImplementation(async (n, p) =>
      n.includes('claim')
        ? original(n, p)
        : {
            error: null,
            data: { version: 1, status: 'deferred', requestKey: key, reason: 'queue_full' },
          }
    );
    expect((await processOne()).status).toBe('deferred');
    m.reply.mockImplementation(async (n, p) =>
      n.includes('claim')
        ? original(n, p)
        : { error: null, data: { version: 1, status: 'lease_lost', requestKey: key } }
    );
    expect((await processOne()).status).toBe('lease_lost');
  });
  it('accepts only bounded known capture retention results', async () => {
    m.reply.mockResolvedValueOnce({
      error: null,
      data: { version: 1, status: 'pruned', requests: 100 },
    });
    expect(await prune()).toEqual({ status: 'pruned', requests: 100 });
    m.reply.mockResolvedValueOnce({
      error: null,
      data: { version: 1, status: 'pruned', requests: 101 },
    });
    expect(await prune()).toEqual({ status: 'unknown' });
  });
});

describe('sequential capture slices retain the original request', () => {
  const install = (claimPatch: Record<string, unknown>, finishReply: Record<string, unknown>) => {
    m.reply.mockImplementation(async (name, p) => ({
      error: null,
      data:
        name === 'fn_claim_horse_observation_capture'
          ? {
              version: 1,
              status: 'claimed',
              requestKey: key,
              leaseToken: p.p_lease_token,
              ...request,
              sliceFromMs: 1000,
              sliceThroughMs: 1500,
              ...claimPatch,
            }
          : { version: 1, requestKey: key, ...finishReply },
    }));
  };
  const progress = {
    ...batch,
    status: 'continued',
    sliceFromMs: 1000,
    sliceThroughMs: 1500,
    nextFromMs: 1500,
    nextThroughMs: 2000,
    segments: 1,
    capturedObservations: 12,
  };

  it('reads only the claimed slice and acknowledges partial progress without completing the request', async () => {
    install({}, progress);
    expect(await processOne()).toEqual({ status: 'continued', requestKey: key });
    expect(m.read).toHaveBeenCalledWith({ ...request, throughMs: 1500 });
    expect(m.rpc.mock.calls[1][1].p_request_key).toBe(key);
    expect(m.rpc).toHaveBeenCalledTimes(2);
  });

  it('validates the final recovered request against the final exact batch', async () => {
    install(
      { sliceFromMs: 1500, sliceThroughMs: 2000 },
      {
        ...progress,
        status: 'captured',
        sliceFromMs: 1500,
        sliceThroughMs: 2000,
        nextFromMs: 2000,
        nextThroughMs: 2000,
        segments: 2,
        capturedObservations: 24,
      }
    );
    expect(await processOne()).toEqual({ status: 'captured', requestKey: key });
  });

  it.each([
    { sliceFromMs: undefined },
    { sliceThroughMs: undefined },
    { sliceFromMs: 999 },
    { sliceThroughMs: 2001 },
    { sliceFromMs: 1500 },
    { sliceFromMs: 1000.5 },
  ])('refuses incomplete or escaped slice bounds before source I/O: %j', async (patch) => {
    install(patch, progress);
    expect((await processOne()).status).toBe('unavailable');
    expect(m.read).not.toHaveBeenCalled();
    expect(m.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'admitted' },
    { status: 'captured' },
    { sliceFromMs: 1001 },
    { nextFromMs: 1499 },
    { nextThroughMs: 2001 },
    { segments: 0 },
    { segments: 2049 },
    { capturedObservations: 11 },
    { capturedObservations: 20001 },
    { batchDigest: 'd'.repeat(64) },
  ])('keeps contradictory slice acknowledgment unknown: %j', async (patch) => {
    install({}, { ...progress, ...patch });
    expect((await processOne()).status).toBe('unknown');
  });

  it('accepts refinement only for the exact midpoint of a confirmed source-budget failure', async () => {
    install({}, { status: 'refined', nextFromMs: 1000, nextThroughMs: 1250 });
    m.read.mockResolvedValue({ status: 'unavailable', reason: 'hand_budget_exceeded' });
    expect((await processOne()).status).toBe('refined');
    m.read.mockResolvedValue({ status: 'unavailable', reason: 'transport_error' });
    expect((await processOne()).status).toBe('unknown');
    m.read.mockResolvedValue({ status: 'unavailable', reason: 'hand_budget_exceeded' });
    install({}, { status: 'refined', nextFromMs: 1001, nextThroughMs: 1250 });
    expect((await processOne()).status).toBe('unknown');
  });

  it('refines an oversized encoded journal batch without declaring source corruption', async () => {
    install({}, { status: 'refined', nextFromMs: 1000, nextThroughMs: 1250 });
    m.prepare.mockReturnValue({ status: 'unavailable', reason: 'batch_budget_exceeded' });
    expect((await processOne()).status).toBe('refined');
    expect(m.rpc.mock.calls[1][1].p_reason).toBe('source_budget_exceeded');
  });

  it('recognizes the retained segment-budget gap and validates recovered admission receipts', async () => {
    m.reply.mockResolvedValueOnce({
      data: { version: 1, status: 'gap', requestKey: key, reason: 'segment_budget_exceeded' },
      error: null,
    });
    expect((await processOne()).status).toBe('gap');
    m.reply.mockResolvedValueOnce({
      data: {
        version: 1,
        status: 'durable',
        requestKey: key,
        state: 'captured',
        segments: 2,
        capturedObservations: 24,
      },
      error: null,
    });
    expect((await admit(request)).status).toBe('durable');
    m.reply.mockResolvedValueOnce({
      data: {
        version: 1,
        status: 'durable',
        requestKey: key,
        state: 'captured',
        segments: 1,
        capturedObservations: 24,
      },
      error: null,
    });
    expect((await admit(request)).status).toBe('unknown');
  });
});
