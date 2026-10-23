import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshExploitCounters } from '../engine/HorseOpponentExploit.js';
import type { LiveHorseDecisionSnapshot } from '../engine/horseDecision/protocol.js';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('./errorReporter.js', () => ({ reportError: mocks.report }));
import {
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
  it('deduplicates concurrent reads for a hand and refreshes for the next hand', async () => {
    const read = createDecisionOpponentProfileReader();
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
    const read = createDecisionOpponentProfileReader();
    mocks.rpc.mockImplementationOnce(() => ({
      abortSignal: async () => ({ data: null, error: { code: '57014' } }),
    }));
    expect(await read(request())).toEqual([]);
    expect(mocks.report).toHaveBeenCalledTimes(1);
    expect(await read(request())).toEqual([row()]);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
  it('separates variants and cash/tournament context in its cache', async () => {
    const read = createDecisionOpponentProfileReader();
    await read(request());
    mocks.rpc.mockImplementation(() => ({
      abortSignal: async () => ({ data: [{ ...row(), variant: 'plo4' }], error: null }),
    }));
    expect((await read(request(undefined, 'plo4')))[0].variant).toBe('plo4');
    const tournament = request();
    tournament.gameState.gameMode = 'tournament';
    mocks.rpc.mockImplementation(() => ({
      abortSignal: async () => ({ data: [{ ...row(), mode: 'tournament' }], error: null }),
    }));
    expect((await read(tournament))[0].mode).toBe('tournament');
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });
});
