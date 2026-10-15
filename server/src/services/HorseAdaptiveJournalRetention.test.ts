import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADAPTIVE_RETENTION_TIMEOUT_MS,
  pruneAdaptiveJournal,
} from './HorseAdaptiveJournalRetention.js';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), reply: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: mocks.rpc } }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockReturnValue({ abortSignal: mocks.reply });
  mocks.reply.mockResolvedValue({
    data: { version: 1, status: 'pruned', completedWork: 100, batches: 100, observations: 1000 },
    error: null,
  });
});
describe('bounded journal retention receipt', () => {
  it('gives a full grouped pass its own transport ceiling below the 8 s service_role statement timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await pruneAdaptiveJournal();
    expect(timeout).toHaveBeenCalledWith(ADAPTIVE_RETENTION_TIMEOUT_MS);
    expect(ADAPTIVE_RETENTION_TIMEOUT_MS).toBe(7500);
    expect(ADAPTIVE_RETENTION_TIMEOUT_MS).toBeGreaterThan(5000);
    expect(ADAPTIVE_RETENTION_TIMEOUT_MS).toBeLessThan(8000);
    timeout.mockRestore();
  });
  it('accepts only one bounded pass without claiming completeness', async () => {
    expect(await pruneAdaptiveJournal()).toEqual({
      status: 'pruned',
      completedWork: 100,
      batches: 100,
      observations: 1000,
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('fn_prune_horse_adaptive_journal');
    expect(mocks.reply.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });
  it.each([
    { completedWork: 101 },
    { batches: 101 },
    { observations: 1001 },
    { observations: -1 },
    { batches: 0.5 },
    { completedWork: '1' },
    { status: 'done' },
    { version: 2 },
    { observations: undefined },
  ])('does not trust a malformed committed reply: %j', async (change) => {
    mocks.reply.mockResolvedValue({
      data: {
        version: 1,
        status: 'pruned',
        completedWork: 0,
        batches: 0,
        observations: 0,
        ...change,
      },
      error: null,
    });
    expect(await pruneAdaptiveJournal()).toEqual({ status: 'unknown' });
  });
  it('preserves non-waiting capacity contention without a retry loop', async () => {
    mocks.reply.mockResolvedValue({
      data: { version: 1, status: 'unavailable', reason: 'capacity_busy' },
      error: null,
    });
    expect(await pruneAdaptiveJournal()).toEqual({
      status: 'unavailable',
      reason: 'capacity_busy',
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it('keeps versioned raw-row counts exact and reports the bounded hand/statistic limits', async () => {
    mocks.reply.mockResolvedValue({
      data: {
        version: 2,
        status: 'pruned',
        completedWork: 0,
        batches: 0,
        observations: 4096,
        retiredHands: 1,
        statisticsExpired: 1000,
        membershipsRegistered: 25,
        membershipPending: true,
      },
      error: null,
    });
    expect(await pruneAdaptiveJournal()).toEqual({
      status: 'pruned',
      completedWork: 0,
      batches: 0,
      observations: 4096,
      retiredHands: 1,
      statisticsExpired: 1000,
      membershipsRegistered: 25,
      membershipPending: true,
    });
    mocks.reply.mockResolvedValue({
      data: {
        version: 2,
        status: 'pruned',
        completedWork: 0,
        batches: 0,
        observations: 4096,
        retiredHands: 26,
        statisticsExpired: 0,
        membershipsRegistered: 0,
        membershipPending: false,
      },
      error: null,
    });
    expect(await pruneAdaptiveJournal()).toEqual({ status: 'unknown' });
  });
  const v3 = () => ({
    version: 3,
    status: 'pruned',
    completedWork: 0,
    batches: 0,
    observations: 250 * 4096,
    retiredHands: 250,
    statisticsExpired: 1000,
    membershipsRegistered: 250,
    membershipPending: true,
    handsScanned: 250,
    retirementPending: true,
    budgetReached: true,
  });
  it('accepts the larger bounded original pass and explicit continuation flags', async () => {
    mocks.reply.mockResolvedValue({ data: v3(), error: null });
    const { version, ...expected } = v3();
    expect(await pruneAdaptiveJournal()).toEqual(expected);
  });
  it.each([
    { retiredHands: 251 },
    { handsScanned: 251 },
    { handsScanned: 0 },
    { membershipsRegistered: 251 },
    { observations: 250 * 4096 + 1 },
    { retirementPending: undefined },
    { budgetReached: 'true' },
    { membershipPending: undefined },
    { statisticsExpired: 1001 },
  ])('refuses an invalid v3 bound or missing continuation witness: %j', async (change) => {
    mocks.reply.mockResolvedValue({ data: { ...v3(), ...change }, error: null });
    expect(await pruneAdaptiveJournal()).toEqual({ status: 'unknown' });
  });
  it.each(['error', 'throw'])('keeps a lost committed reply unknown: %s', async (mode) => {
    if (mode === 'error')
      mocks.reply.mockResolvedValue({ data: null, error: new Error('lost reply') });
    else mocks.reply.mockRejectedValue(new Error('lost reply'));
    expect(await pruneAdaptiveJournal()).toEqual({ status: 'unknown' });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
