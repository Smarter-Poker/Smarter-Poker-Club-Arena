import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const m = vi.hoisted(() => ({ rpc: vi.fn(), reply: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: m.rpc } }));
import {
  readCaptureEvidencePage as read,
  CAPTURE_EVIDENCE_LIMITS,
} from './HorseCaptureEvidence.js';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const request = { actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', fromMs: 1000, throughMs: 1065 };
const actorKey = hash(JSON.stringify(['adaptive-actor-v1', request.actorId]));
const requestKey = hash(['horse-source-request-v1', request.actorId, 1000, 1065].join('|'));
const revision = 'f'.repeat(64);
function row(n: number) {
  const fromMs = 1000 + n,
    throughMs = fromMs + 1,
    sourceDigest = hash(`source-${n}`);
  const sourceWitness = JSON.stringify([
    1,
    actorKey,
    fromMs,
    throughMs,
    2000,
    '100:102:101',
    1,
    42,
    sourceDigest,
    'retained_committed_roster_rows',
    'atomic_hand_receipts',
  ]);
  return {
    fromMs,
    throughMs,
    segment: n + 1,
    capturedObservations: (n + 1) * 2,
    batchKey: hash(['adaptive-journal-v1', actorKey, sourceDigest, fromMs, throughMs].join('|')),
    batchDigest: hash(`batch-${n}`),
    observations: 2,
    sourceWitness,
    sourceWitnessDigest: hash(sourceWitness),
    journalReceipt: 'matched',
    queueState: 'completed',
  };
}
function page(after = 0) {
  return {
    version: 1,
    status: 'snapshot',
    requestKey,
    actorKey,
    fromMs: 1000,
    throughMs: 1065,
    requestState: 'captured',
    capturedThroughMs: 1065,
    segments: 65,
    observations: 130,
    revision,
    pageFromMs: 1000 + after,
    afterSegment: after,
    afterObservations: after * 2,
    hasMore: after === 0,
    readAtMs: 3000,
    sourceCoverage: 'not_established',
    rows: Array.from({ length: after === 0 ? 64 : 1 }, (_, n) => row(after + n)),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  m.rpc.mockImplementation((_name, params) => ({
    abortSignal(signal: AbortSignal) {
      expect(signal).toBeInstanceOf(AbortSignal);
      return m.reply(params);
    },
  }));
  m.reply.mockImplementation(async (p) => ({
    error: null,
    data: page(p.p_after_from_ms === null ? 0 : 64),
  }));
});
describe('bounded original capture evidence recovery', () => {
  it('recovers 65 immutable witnesses over two bounded pages, without claiming complete coverage', async () => {
    const a = await read(request);
    expect(a.status).toBe('snapshot');
    if (a.status !== 'snapshot') return;
    expect(a.rows).toHaveLength(64);
    expect(a.nextCursor).toEqual({
      afterFromMs: 1063,
      throughMs: 1064,
      segment: 64,
      observations: 128,
      revision,
    });
    const b = await read(request, a.nextCursor!);
    expect(b.status).toBe('snapshot');
    if (b.status !== 'snapshot') return;
    expect(b.rows).toHaveLength(1);
    expect(b.nextCursor).toBeNull();
    expect(b.rows[0].source?.snapshotId).toBe('100:102:101');
    expect(b.sourceCoverage).toBe('not_established');
    expect(b).not.toHaveProperty('complete');
    for (const value of [a, a.rows, a.rows[0], a.rows[0].source, a.nextCursor])
      expect(Object.isFrozen(value)).toBe(true);
    expect(m.rpc.mock.calls.map((c) => c[0])).toEqual(
      Array(2).fill('fn_horse_observation_capture_evidence')
    );
    expect(m.rpc.mock.calls[1][1]).toMatchObject({
      p_actor: request.actorId,
      p_after_from_ms: 1063,
      p_revision: revision,
    });
  });
  it('holds the exact request and cursor across caller mutation while awaiting I/O', async () => {
    const r = { ...request },
      cursor = { afterFromMs: 1063, throughMs: 1064, segment: 64, observations: 128, revision };
    m.reply.mockImplementationOnce(async () => {
      r.actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      cursor.segment = 2;
      return { data: page(64), error: null };
    });
    expect((await read(r, cursor)).status).toBe('snapshot');
    expect(m.rpc.mock.calls[0][1].p_actor).toBe(request.actorId);
  });
  it.each(['queued', 'leased', 'gap'])(
    'reports retained partial %s evidence without closing the request',
    async (state) => {
      const p = page();
      Object.assign(p, {
        requestState: state,
        segments: 1,
        observations: 2,
        capturedThroughMs: 1001,
        hasMore: false,
        rows: [row(0)],
      });
      m.reply.mockResolvedValueOnce({ data: p });
      const r = await read(request);
      expect(r.status).toBe('snapshot');
      if (r.status === 'snapshot') {
        expect(r.requestState).toBe(state);
        expect(r.nextCursor).toBeNull();
        expect(r.sourceCoverage).toBe('not_established');
      }
    }
  );
  it('recovers an unfinished empty request and historical clock rollback without fabricating source metadata', async () => {
    const p = page();
    Object.assign(p, {
      requestState: 'queued',
      segments: 0,
      observations: 0,
      capturedThroughMs: 1000,
      hasMore: false,
      rows: [],
    });
    m.reply.mockResolvedValueOnce({ data: p });
    expect((await read(request)).status).toBe('snapshot');
    const rollback = page();
    rollback.readAtMs = 1500;
    m.reply.mockResolvedValueOnce({ data: rollback });
    expect((await read(request)).status).toBe('snapshot');
  });
  it.each(['missing', 'payload_missing', 'matched'])(
    'keeps %s journal evidence distinct from source and queue evidence',
    async (state) => {
      const p = page();
      p.rows[0].journalReceipt = state;
      p.rows[0].queueState = 'quarantined';
      Object.assign(p.rows[0], { sourceWitness: null, sourceWitnessDigest: null });
      m.reply.mockResolvedValueOnce({ data: p });
      const r = await read(request);
      expect(r.status).toBe('snapshot');
      if (r.status === 'snapshot')
        expect(r.rows[0]).toMatchObject({
          source: null,
          journalReceipt: state,
          queueState: 'quarantined',
        });
    }
  );
  it.each([
    'requestKey',
    'actorKey',
    'fromMs',
    'throughMs',
    'revision',
    'sourceCoverage',
    'pageFromMs',
    'afterSegment',
    'afterObservations',
    'hasMore',
    'readAtMs',
  ])('rejects malformed root %s', async (key) => {
    const p = page();
    Object.assign(p, { [key]: 'wrong' });
    m.reply.mockResolvedValueOnce({ data: p });
    expect((await read(request)).status).toBe('unavailable');
  });
  it.each([
    'fromMs',
    'throughMs',
    'segment',
    'capturedObservations',
    'observations',
    'batchDigest',
  ])('detects a missing or inconsistent slice %s', async (key) => {
    const p = page();
    Object.assign(p.rows[10], { [key]: -1 });
    m.reply.mockResolvedValueOnce({ data: p });
    expect(await read(request)).toEqual({ status: 'unavailable', reason: 'evidence_gap' });
  });
  it.each(['journalReceipt', 'queueState'])('refuses conflicting %s', async (key) => {
    const p = page();
    Object.assign(p.rows[0], { [key]: 'conflict' });
    m.reply.mockResolvedValueOnce({ data: p });
    expect(await read(request)).toEqual({
      status: 'unavailable',
      reason: 'journal_receipt_conflict',
    });
  });
  it.each(['digest', 'format', 'scope', 'batch', 'missing_half', 'oversized', 'noncanonical'])(
    'refuses invalid original witness: %s',
    async (defect) => {
      const p = page(),
        r = p.rows[0];
      if (defect === 'digest') r.sourceWitnessDigest = 'e'.repeat(64);
      if (defect === 'format') {
        r.sourceWitness = '{}';
        r.sourceWitnessDigest = hash(r.sourceWitness);
      }
      if (defect === 'scope') {
        const a = JSON.parse(r.sourceWitness);
        a[1] = 'e'.repeat(64);
        r.sourceWitness = JSON.stringify(a);
        r.sourceWitnessDigest = hash(r.sourceWitness);
      }
      if (defect === 'batch') r.batchKey = 'e'.repeat(64);
      if (defect === 'missing_half') Object.assign(r, { sourceWitness: null });
      if (defect === 'oversized') {
        r.sourceWitness = ' '.repeat(8193);
        r.sourceWitnessDigest = hash(r.sourceWitness);
      }
      if (defect === 'noncanonical') {
        r.sourceWitness = ' ' + r.sourceWitness;
        r.sourceWitnessDigest = hash(r.sourceWitness);
      }
      m.reply.mockResolvedValueOnce({ data: p });
      expect(await read(request)).toEqual({
        status: 'unavailable',
        reason: 'invalid_source_witness',
      });
    }
  );
  it.each([
    'request_changed',
    'cursor_lost',
    'legacy_request_without_slices',
    'request_not_found',
    'evidence_budget_exceeded',
  ])('preserves explicit server refusal %s', async (reason) => {
    m.reply.mockResolvedValueOnce({ data: { version: 1, status: 'unavailable', reason } });
    expect(await read(request)).toEqual({ status: 'unavailable', reason });
  });
  it('refuses page overflow, truncated final evidence, revision drift, oversized replies and transport errors', async () => {
    const overflow = page();
    overflow.rows.push(row(64));
    m.reply.mockResolvedValueOnce({ data: overflow });
    expect((await read(request)).status).toBe('unavailable');
    const missing = page(64);
    missing.rows = [];
    m.reply.mockResolvedValueOnce({ data: missing });
    expect(
      (
        await read(request, {
          afterFromMs: 1063,
          throughMs: 1064,
          segment: 64,
          observations: 128,
          revision,
        })
      ).status
    ).toBe('unavailable');
    m.reply.mockResolvedValueOnce({ data: page(64) });
    expect(
      (
        await read(request, {
          afterFromMs: 1063,
          throughMs: 1064,
          segment: 64,
          observations: 128,
          revision: 'e'.repeat(64),
        })
      ).status
    ).toBe('unavailable');
    m.reply.mockResolvedValueOnce({
      data: { ...page(), extra: 'x'.repeat(CAPTURE_EVIDENCE_LIMITS.bytes) },
    });
    expect((await read(request)).status).toBe('unavailable');
    m.reply.mockResolvedValueOnce({ error: { message: 'offline' } });
    expect(await read(request)).toEqual({ status: 'unavailable', reason: 'read_unavailable' });
    m.reply.mockRejectedValueOnce(Error('timeout'));
    expect((await read(request)).status).toBe('unavailable');
  });
  it.each([
    { actorId: 'bad' },
    { fromMs: -1 },
    { throughMs: 1000 },
    { throughMs: 21601001 },
    { throughMs: Number.MAX_SAFE_INTEGER + 1 },
  ])('refuses invalid input before I/O: %j', async (patch) => {
    expect((await read({ ...request, ...patch })).status).toBe('unavailable');
    expect(m.rpc).not.toHaveBeenCalled();
  });
});
