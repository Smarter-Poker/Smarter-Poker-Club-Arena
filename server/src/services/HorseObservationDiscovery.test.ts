import { createHash } from 'node:crypto';
import { beforeEach, describe, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ rpc: vi.fn(), reply: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: m.rpc } }));
import {
  discoverObservationRequests as discover,
  pruneObservationDiscovery as prune,
} from './HorseObservationDiscovery.js';
import { parseDiscoveryReceipt } from './horseAdaptiveJournal/discoveryReceipt.js';
const receipt = () => ({
  version: 1,
  status: 'source_recorded',
  epochKey: createHash('sha256').update('horse-discovery-v1|1000|2000').digest('hex'),
  fromMs: 1000,
  throughMs: 2000,
  cursorMs: 1000,
  sliceThroughMs: 2000,
  state: 'pending',
  segments: 1,
  actors: 0,
  skippedEpochs: 0,
  retainedGaps: 0,
  reason: null,
  sourceCoverage: 'not_established',
});
beforeEach(() => {
  vi.clearAllMocks();
  m.rpc.mockImplementation(() => ({
    abortSignal: (signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return m.reply();
    },
  }));
  m.reply.mockResolvedValue({ data: receipt(), error: null });
});
describe('automatic observation discovery boundary', () => {
  it('accepts a durable bounded receipt but never claims observation coverage', async () => {
    const input = receipt();
    m.reply.mockResolvedValue({ data: input, error: null });
    const result = await discover();
    expect(result).toMatchObject({ status: 'source_recorded', sourceCoverage: 'not_established' });
    input.actors = 999;
    expect(result).toHaveProperty('actors', 0);
    expect(Object.isFrozen(result)).toBe(true);
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(m.rpc).toHaveBeenCalledWith('fn_discover_horse_observation_requests');
  });
  it.each([
    { version: 2 },
    { epochKey: 'f'.repeat(64) },
    { fromMs: -1 },
    { throughMs: 21601001 },
    { cursorMs: 2001 },
    { sliceThroughMs: 999 },
    { segments: 2049 },
    { actors: 8193 },
    { skippedEpochs: 0.1 },
    { sourceCoverage: 'complete' },
    { status: 'discovered' },
    { state: 'discovered' },
    { reason: { toString: () => 'backoff' } },
    { status: 'deferred', reason: 'invented' },
    { status: 'gap', state: 'gap', reason: 'invented' },
    { privateCards: ['As', 'Ad'] },
    { actors: 1, segments: 0 },
    { retainedGaps: 129 },
  ])(
    'refuses malformed or expanded receipts without guessing a successful write: %j',
    async (patch) => {
      m.reply.mockResolvedValue({ data: { ...receipt(), ...patch }, error: null });
      expect(await discover()).toEqual({ status: 'unknown' });
    }
  );
  it('requires terminal bounds and retains explicit source gaps', () => {
    expect(
      parseDiscoveryReceipt({
        ...receipt(),
        status: 'discovered',
        state: 'discovered',
        cursorMs: 2000,
      })
    ).toHaveProperty('status', 'discovered');
    expect(
      parseDiscoveryReceipt({
        ...receipt(),
        status: 'gap',
        state: 'gap',
        reason: 'source_expired',
        retainedGaps: 1,
      })
    ).toHaveProperty('status', 'gap');
  });
  it('an idle intake still reports unresolved retained gaps', () => {
    expect(parseDiscoveryReceipt({ version: 1, status: 'idle', retainedGaps: 3 })).toEqual({
      status: 'idle',
      retainedGaps: 3,
    });
    expect(parseDiscoveryReceipt({ version: 1, status: 'idle' })).toEqual({ status: 'unknown' });
  });
  it('keeps a lost committed reply unknown and lets the database resume on the next single call', async () => {
    m.reply.mockRejectedValueOnce(Error('lost committed reply'));
    expect(await discover()).toEqual({ status: 'unknown' });
    expect(m.rpc).toHaveBeenCalledTimes(1);
    expect(await discover()).toHaveProperty('status', 'source_recorded');
    expect(m.rpc).toHaveBeenCalledTimes(2);
  });
  it.each([
    null,
    { version: 1, status: 'idle', actors: 0 },
    { version: 1, status: 'unavailable', reason: 'bad' },
  ])('refuses invalid short receipts %j', async (data) => {
    m.reply.mockResolvedValue({ data, error: null });
    expect(await discover()).toEqual({ status: 'unknown' });
  });
  it.each([
    { epochs: 2, members: 0, segments: 0 },
    { epochs: 0, members: 513, segments: 0 },
    { epochs: 0, members: 0, segments: 129 },
    { epochs: 0, members: -1, segments: 0 },
  ])('requires bounded retention counts %j', async (counts) => {
    m.reply.mockResolvedValue({ data: { version: 1, status: 'pruned', ...counts }, error: null });
    expect(await prune()).toEqual({ status: 'unknown' });
  });
  it('retention does not fabricate counts after transport uncertainty', async () => {
    m.reply
      .mockResolvedValueOnce({
        data: { version: 1, status: 'pruned', epochs: 1, members: 512, segments: 128 },
        error: null,
      })
      .mockResolvedValueOnce({ error: Error('lost') });
    expect(await prune()).toEqual({ status: 'pruned', epochs: 1, members: 512, segments: 128 });
    expect(await prune()).toEqual({ status: 'unknown' });
  });
});
