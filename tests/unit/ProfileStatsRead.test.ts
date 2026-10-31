import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import { readSeparatedProfileStats } from '../../src/services/ProfileStatsRead';

beforeEach(() => {
  rpc.mockReset();
});
describe('separated profile read', () => {
  it('keeps cash behavior and tournament hands in independent blocks', async () => {
    rpc.mockImplementation(async (_name, args) => ({
      data: {
        scope: { game_mode: args.p_game_mode, target_user_id: 'self' },
        overall: {
          total_hands: args.p_game_mode === 'cash' ? 10 : 1000,
          tourney_hands: args.p_game_mode === 'cash' ? 0 : 1000,
        },
        tournaments: { entries: args.p_game_mode === 'cash' ? 0 : 5 },
      },
      error: null,
    }));
    const read = await readSeparatedProfileStats('self');
    expect(read.error).toBeNull();
    expect(read.data.overall.total_hands).toBe(10);
    expect(read.data.tournament_overall.tourney_hands).toBe(1000);
    expect(read.data.tournaments.entries).toBe(5);
    expect(rpc.mock.calls.map((call) => call[1].p_game_mode)).toEqual(['cash', 'tournament']);
  });
  it('refuses a successful response from the wrong mode', async () => {
    rpc.mockResolvedValue({
      data: { scope: { game_mode: 'cash', target_user_id: 'self' } },
      error: null,
    });
    const read = await readSeparatedProfileStats('self');
    expect(read.data).toBeNull();
    expect(read.error).toBeTruthy();
  });
  it('preserves an error rather than fabricating an empty tournament record', async () => {
    const error = { message: 'read failed' };
    rpc
      .mockResolvedValueOnce({ data: {}, error: null })
      .mockResolvedValueOnce({ data: null, error });
    expect(await readSeparatedProfileStats('self')).toEqual({ data: null, error });
  });
});
