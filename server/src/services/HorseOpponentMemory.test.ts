import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DurableOpponentProfile } from '../engine/HorseOpponentMemory.js';
import { freshExploitCounters } from '../engine/HorseOpponentExploit.js';
import type { LiveHorseDecisionSnapshot } from '../engine/horseDecision/protocol.js';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn(), from: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('./errorReporter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./errorReporter.js')>()),
  reportError: mocks.report,
}));
import {
  createOpponentMemorySchemaProbe,
  createOpponentMemoryReadAdmission,
  createOpponentMemoryProfileCache,
  createDecisionOpponentProfileReader,
  readHorseOpponentProfiles,
  readExistingHorseOpponentDonors,
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
  it('a profile awaiting its legacy back-fill is still evidence (2026-10-24)', async () => {
    // Replaces 'leaving cold actors explicitly uninitialized': on 2026-10-24
    // 5,965 profiles (730 with 240+ own hands, 24 human players) waited on a
    // one-at-a-time back-fill while every read dropped them, so horses met
    // those players with no read. Their counters are exact since the memory
    // began; the back-fill only adds older, lower-weighted hands.
    const cold = '90000000-0000-4000-8000-000000000002';
    const awaiting = { ...row(), user_id: cold, initialized: false, observed_hands: 300 };
    mocks.rpc.mockImplementation(() => ({
      abortSignal: async () => ({ data: [row(), awaiting], error: null }),
    }));
    const out = await readHorseOpponentProfiles([uid, cold], 'plo5', 'cash', 'short');
    expect(out).toEqual([row(), awaiting]);
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
  it('never regresses observed hands or crosses game context; a back-fill supersedes', () => {
    const cache = createOpponentMemoryProfileCache();
    cache.remember([{ ...row(), observed_hands: 20 }]);
    cache.remember([{ ...row(), observed_hands: 10 }]);
    expect(cache.read([uid], 'plo5', 'cash', 'short')[0].observed_hands).toBe(20);
    expect(cache.read([uid], 'plo4', 'cash', 'short')).toEqual([]);
    const other = { ...row(), user_id: '90000000-0000-4000-8000-000000000098', initialized: false };
    cache.remember([other]);
    expect(cache.read([other.user_id], 'plo5', 'cash', 'short')).toEqual([other]);
    // The same hands, now back-filled, replace the awaiting version...
    const filled = { ...other, initialized: true, counters: { ...other.counters, hands: 5 } };
    cache.remember([filled]);
    expect(cache.read([other.user_id], 'plo5', 'cash', 'short')).toEqual([filled]);
    // ...and an older awaiting snapshot never regresses it.
    cache.remember([other]);
    expect(cache.read([other.user_id], 'plo5', 'cash', 'short')).toEqual([filled]);
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

describe('the cost of every opponent read is a number (2026-10-24)', () => {
  it('buckets latency and names each failure kind', async () => {
    const { opponentMemoryLatencyBucket: b, opponentMemoryFailureFeature: f } =
      await import('./HorseOpponentMemory.js');
    expect(b(10)).toBe('horse_opponent_memory_read_ms_le50');
    expect(b(50)).toBe('horse_opponent_memory_read_ms_le50');
    expect(b(51)).toBe('horse_opponent_memory_read_ms_le100');
    expect(b(400)).toBe('horse_opponent_memory_read_ms_le500');
    expect(b(1400)).toBe('horse_opponent_memory_read_ms_gt1000');
    expect(b(NaN)).toBe('horse_opponent_memory_read_ms_unknown');
    expect(f(new Error('opponent memory unavailable: busy'))).toBe(
      'horse_opponent_memory_read_busy'
    );
    expect(f(new Error('opponent memory unavailable: 57014'))).toBe(
      'horse_opponent_memory_read_timeout'
    );
    expect(f(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(
      'horse_opponent_memory_read_timeout'
    );
    expect(f(new Error('opponent memory receipt incomplete'))).toBe(
      'horse_opponent_memory_read_incomplete'
    );
    expect(f(new Error('opponent memory unavailable: 42501'))).toBe(
      'horse_opponent_memory_read_failed'
    );
  });

  it('files every read outcome into the horse telemetry the flush publishes', async () => {
    const telemetry = await import('../engine/BrainTelemetry.js');
    telemetry.enableBrainTelemetry();
    telemetry.drainFires();
    const ids = ['90000000-0000-4000-8000-0000000000a1'];
    mocks.rpc.mockImplementationOnce(() => ({
      abortSignal: async () => ({ data: [], error: null }),
    }));
    await readHorseOpponentProfiles(ids, 'nlh', 'cash', 'full');
    mocks.rpc.mockImplementationOnce(() => ({
      abortSignal: async () => ({ data: null, error: { code: '57014' } }),
    }));
    await expect(readHorseOpponentProfiles(ids, 'nlh', 'cash', 'short')).rejects.toThrow();
    const fired = new Map(telemetry.drainFires().map((r) => [r.feature, r.fires]));
    expect(fired.get('horse_opponent_memory_read_ok')).toBe(1);
    expect(fired.get('horse_opponent_memory_read_timeout')).toBe(1);
    expect(
      [...fired.keys()].filter((k) => k.startsWith('horse_opponent_memory_read_ms_')).length
    ).toBe(1);
  });
});

describe('donor reads have their own admission', () => {
  it('a failed exact read does not turn the next donor read away as busy', async () => {
    const id = '90000000-0000-4000-8000-0000000000d1';
    mocks.rpc.mockImplementation(() => ({
      abortSignal: async () => ({ data: null, error: { code: 'XX000' } }),
    }));
    await expect(readHorseOpponentProfiles([id], 'plo5', 'cash', 'short')).rejects.toThrow(
      'opponent memory unavailable'
    );
    // The exact gate is now closed for its 1.5 second budget.
    await expect(readHorseOpponentProfiles([id], 'plo5', 'cash', 'short')).rejects.toThrow('busy');
    const donor = { ...row(), user_id: id, size: 'full' as const };
    const abortSignal = vi.fn(async () => ({ data: [donor], error: null }));
    const chain = {
      select: () => chain,
      in: () => chain,
      eq: () => chain,
      limit: () => ({ abortSignal }),
    };
    mocks.from.mockReturnValue(chain);
    expect(await readExistingHorseOpponentDonors([id], 'plo5', 'cash', 'short')).toMatchObject([
      { user_id: id, size: 'full' },
    ]);
    expect(abortSignal).toHaveBeenCalledTimes(1);
  });
});
