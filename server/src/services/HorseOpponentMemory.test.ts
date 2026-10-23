import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshExploitCounters } from '../engine/HorseOpponentExploit.js';
import type { LiveHorseDecisionSnapshot } from '../engine/horseDecision/protocol.js';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn(), from: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('./errorReporter.js', () => ({ reportError: mocks.report }));
import {
  createOpponentMemorySchemaProbe,
  createDecisionOpponentProfileReader,
  readHorseOpponentProfiles,
} from './HorseOpponentMemory.js';
const uid = '90000000-0000-4000-8000-000000000001';
const row = () => ({
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
beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.report.mockReset();
  mocks.rpc.mockImplementation(() => ({
    abortSignal: async () => ({ data: [row()], error: null }),
  }));
});
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
  it('never presents an incomplete or mismatched receipt as a restored profile', async () => {
    mocks.rpc.mockImplementation(() => ({
      abortSignal: async () => ({ data: [{ ...row(), variant: 'plo4' }], error: null }),
    }));
    await expect(readHorseOpponentProfiles([uid], 'plo5', 'cash', 'short')).rejects.toThrow(
      /receipt incomplete/
    );
    mocks.rpc.mockImplementation(() => ({ abortSignal: async () => ({ data: [], error: null }) }));
    await expect(readHorseOpponentProfiles([uid], 'plo5', 'cash', 'short')).rejects.toThrow(
      /receipt incomplete/
    );
  });
  it('reports a failed read, does not cache failure, and accepts a later direct request', async () => {
    const read = createDecisionOpponentProfileReader(async () => 'installed');
    mocks.rpc.mockImplementationOnce(() => ({
      abortSignal: async () => ({ data: null, error: { code: '57014' } }),
    }));
    expect(await read(request())).toEqual([]);
    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(await read(request())).toEqual([row()]);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
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
