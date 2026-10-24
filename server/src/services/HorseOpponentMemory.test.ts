import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableOpponentProfile } from '../engine/HorseOpponentMemory.js';
import { freshExploitCounters } from '../engine/HorseOpponentExploit.js';
import type { LiveHorseDecisionSnapshot } from '../engine/horseDecision/protocol.js';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn(), from: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('./errorReporter.js', () => ({ reportError: mocks.report }));
import {
  createOpponentMemorySchemaProbe,
  createOpponentMemoryReadAdmission,
  createOpponentMemoryProfileCache,
  createDecisionOpponentProfileReader,
  readHorseOpponentProfiles,
} from './HorseOpponentMemory.js';
const uid = '90000000-0000-4000-8000-000000000001';
const row = (): DurableOpponentProfile => ({
  user_id: uid,
  variant: 'plo5',
  mode: 'cash',
  size: 'short',
  initialized: true,
  observed_hands: 8,
  counters: freshExploitCounters(),
});
function request(fence = 'table:1:1:lease:turn', variant = 'plo5') {
  return {
    fence,
    gameState: { gameVariant: variant, players: [{ user_id: uid }], dealtSeatIds: [1, 2, 3] },
  } as unknown as LiveHorseDecisionSnapshot;
}
let testClock = Date.now();
beforeEach(() => {
  vi.useFakeTimers();
  testClock += 5000;
  vi.setSystemTime(testClock);
  mocks.rpc.mockReset();
  mocks.report.mockReset();
  mocks.rpc.mockImplementation(() => ({
    abortSignal: async () => ({ data: [row()], error: null }),
  }));
});
afterEach(() => vi.useRealTimers());
describe('opponent memory request receipts', () => {
  it('distinguishes installed, absent and unreadable schema without repeated probes', async () => {
    const abortSignal = vi.fn(async () => ({ data: [], error: null as unknown }));
    mocks.from.mockReturnValue({ select: () => ({ limit: () => ({ abortSignal }) }) });
    const ready = createOpponentMemorySchemaProbe();
    expect(await ready()).toBe('installed');
    expect(await ready()).toBe('installed');
    expect(abortSignal).toHaveBeenCalledTimes(1);
    abortSignal.mockResolvedValueOnce({ data: [], error: { code: '42P01' } });
    expect(await createOpponentMemorySchemaProbe()()).toBe('unavailable');
    abortSignal.mockResolvedValueOnce({ data: [], error: { code: '42501' } });
    expect(await createOpponentMemorySchemaProbe()()).toBe('unknown');
  });

  it('recovers a missing startup schema on a later original request without polling', async () => {
    let time = 0;
    const abortSignal = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: 'PGRST205' } })
      .mockResolvedValue({ data: [], error: null });
    mocks.from.mockReturnValue({ select: () => ({ limit: () => ({ abortSignal }) }) });
    const probe = createOpponentMemorySchemaProbe(() => time);
    const read = createDecisionOpponentProfileReader(probe);
    expect(await read(request())).toBeUndefined();
    time = 59_999;
    expect(await read(request())).toBeUndefined();
    expect(abortSignal).toHaveBeenCalledTimes(1);
    time = 60_000;
    expect(await Promise.all([read(request()), read(request())])).toEqual([[row()], [row()]]);
    expect(abortSignal).toHaveBeenCalledTimes(2);
    time = 180_000;
    expect(await probe()).toBe('installed');
    expect(abortSignal).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent reads for a hand and refreshes for the next hand', async () => {
    const read = createDecisionOpponentProfileReader(async () => 'installed');
    const [a, b] = await Promise.all([read(request()), read(request('table:1:3:lease:other'))]);
    expect(a).toEqual(b);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    await read(request('table:2:1:lease:turn'));
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenLastCalledWith('fn_horse_exploit_profiles_read', {
      p_user_ids: [uid],
      p_variant: 'plo5',
      p_mode: 'cash',
      p_size: 'short',
    });
  });
  it('rejects mismatched receipts and permits absent cold profiles', async () => {
    mocks.rpc.mockImplementation(() => ({
      abortSignal: async () => ({ data: [{ ...row(), variant: 'plo4' }], error: null }),
    }));
    await expect(
      readHorseOpponentProfiles(['90000000-0000-4000-8000-000000000099'], 'plo5', 'cash', 'short')
    ).rejects.toThrow(/receipt incomplete/);
    vi.advanceTimersByTime(1500);
    mocks.rpc.mockImplementation(() => ({ abortSignal: async () => ({ data: [], error: null }) }));
    expect(
      await readHorseOpponentProfiles(
        ['90000000-0000-4000-8000-000000000099'],
        'plo5',
        'cash',
        'short'
      )
    ).toEqual([]);
  });
  it('retains a failed hand receipt instead of retrying on every street', async () => {
    await readHorseOpponentProfiles([uid], 'plo5', 'cash', 'short');
    mocks.rpc.mockClear();
    mocks.report.mockClear();
    const read = createDecisionOpponentProfileReader(async () => 'installed');
    mocks.rpc.mockImplementationOnce(() => ({
      abortSignal: async () => ({ data: null, error: { code: '57014' } }),
    }));
    expect(await read(request())).toEqual([row()]);
    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(await read(request())).toEqual([row()]);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it('separates variants and cash/tournament context in its cache', async () => {
    const read = createDecisionOpponentProfileReader(async () => 'installed');
    await read(request());
    mocks.rpc.mockImplementation(() => ({
      abortSignal: async () => ({ data: [{ ...row(), variant: 'plo4' }], error: null }),
    }));
    expect(await read(request(undefined, 'plo4'))).toMatchObject([{ variant: 'plo4' }]);
    const tournament = request();
    tournament.gameState.gameMode = 'tournament';
    mocks.rpc.mockImplementation(() => ({
      abortSignal: async () => ({ data: [{ ...row(), mode: 'tournament' }], error: null }),
    }));
    expect(await read(tournament)).toMatchObject([{ mode: 'tournament' }]);
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });
});

describe('process-wide memory admission', () => {
  it('bounds requests at eight without queueing and admits after completion', async () => {
    const admit = createOpponentMemoryReadAdmission();
    let finish!: (value: number) => void;
    const first = admit(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        })
    );
    const others = Array.from({ length: 7 }, () => admit(() => first));
    const other = vi.fn(async () => 2);
    await expect(admit(other)).rejects.toThrow('busy');
    expect(other).not.toHaveBeenCalled();
    finish(1);
    expect(await first).toBe(1);
    await Promise.all(others);
    expect(await admit(other)).toBe(2);
  });
  it('does not retry an unknown canceled outcome until a later request after the budget', async () => {
    let now = 0;
    const admit = createOpponentMemoryReadAdmission(() => now);
    await expect(
      admit(async () => {
        throw new Error('AbortError');
      })
    ).rejects.toThrow('AbortError');
    const next = vi.fn(async () => 3);
    now = 1499;
    await expect(admit(next)).rejects.toThrow('busy');
    expect(next).not.toHaveBeenCalled();
    now = 1500;
    expect(await admit(next)).toBe(3);
  });
});

describe('bounded partial memory restoration', () => {
  it('preserves known profiles while leaving cold actors explicitly uninitialized', async () => {
    const cold = '90000000-0000-4000-8000-000000000002';
    mocks.rpc.mockImplementation(() => ({
      abortSignal: async () => ({
        data: [row()],
        error: null,
      }),
    }));
    expect(await readHorseOpponentProfiles([uid, cold], 'plo5', 'cash', 'short')).toEqual([row()]);
    mocks.rpc.mockImplementation(() => ({
      abortSignal: async () => ({
        data: [row(), { ...row(), user_id: cold, initialized: false }],
        error: null,
      }),
    }));
    expect(await readHorseOpponentProfiles([uid, cold], 'plo5', 'cash', 'short')).toEqual([row()]);
  });
  it('does not launch a read for an already canceled caller', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readHorseOpponentProfiles([uid], 'plo5', 'cash', 'short', controller.signal)
    ).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('cancels waiting on an unresolved schema without launching database work', async () => {
    const controller = new AbortController();
    const read = createDecisionOpponentProfileReader(() => new Promise(() => {}));
    const pending = read(request(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe('last validated memory snapshots', () => {
  it('never regresses observed hands or crosses game context or caches uninitialized rows', () => {
    const cache = createOpponentMemoryProfileCache();
    cache.remember([{ ...row(), observed_hands: 20 }]);
    cache.remember([{ ...row(), observed_hands: 10 }]);
    expect(cache.read([uid], 'plo5', 'cash', 'short')[0].observed_hands).toBe(20);
    expect(cache.read([uid], 'plo4', 'cash', 'short')).toEqual([]);
    const other = { ...row(), user_id: '90000000-0000-4000-8000-000000000098', initialized: false };
    cache.remember([other]);
    expect(cache.read([other.user_id], 'plo5', 'cash', 'short')).toEqual([]);
  });
});

it('allows a ready receipt while one cold request is still outstanding', async () => {
  const admit = createOpponentMemoryReadAdmission();
  let finish!: () => void;
  const cold = admit(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  expect(await admit(async () => [row()])).toEqual([row()]);
  finish();
  await cold;
});

it('reuses a profile learned after a hand failure without retrying that failed hand', async () => {
  const other = '90000000-0000-4000-8000-000000000095';
  const snapshot = request();
  snapshot.gameState.players[0].user_id = other;
  const read = createDecisionOpponentProfileReader(async () => 'installed');
  mocks.rpc.mockImplementationOnce(() => ({
    abortSignal: async () => ({ data: null, error: { code: '57014' } }),
  }));
  expect(await read(snapshot)).toEqual([]);
  vi.advanceTimersByTime(1500);
  mocks.rpc.mockImplementation(() => ({
    abortSignal: async () => ({ data: [{ ...row(), user_id: other }], error: null }),
  }));
  await readHorseOpponentProfiles([other], 'plo5', 'cash', 'short');
  expect(await read(snapshot)).toEqual([{ ...row(), user_id: other }]);
  expect(mocks.rpc).toHaveBeenCalledTimes(2);
});
