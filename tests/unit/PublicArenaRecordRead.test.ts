import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import { readSeparatedPublicArenaRecord } from '../../src/services/PublicArenaRecordRead';

beforeEach(() => {
  rpc.mockReset();
});
describe('public player record mode separation', () => {
  it('never weights cash tendencies with tournament hands', async () => {
    rpc.mockImplementation(async (_name, args) => ({
      data: {
        contract_version: 2,
        scope: {
          target_user_id: 'target',
          game_mode: args.p_game_mode,
          asset: 'chips',
          visibility: 'public',
        },
        rows:
          args.p_game_mode === 'cash'
            ? [{ hands_played: 10, vpip: 20, pfr: 10, tournaments_played: 0, tournaments_won: 0 }]
            : [
                {
                  hands_played: 1000,
                  vpip: 90,
                  pfr: 80,
                  tournaments_played: 3,
                  tournaments_won: 1,
                },
              ],
      },
      error: null,
    }));
    expect(await readSeparatedPublicArenaRecord('target')).toMatchObject({
      hands: 10,
      vpip: 20,
      pfr: 10,
      tournamentsPlayed: 3,
      tournamentsWon: 1,
    });
  });
  it('rejects the wrong user or mode even after a successful transport', async () => {
    rpc.mockResolvedValue({
      data: {
        contract_version: 2,
        scope: { target_user_id: 'other', game_mode: 'cash', asset: 'chips', visibility: 'public' },
        rows: [],
      },
      error: null,
    });
    await expect(readSeparatedPublicArenaRecord('target')).rejects.toThrow(
      'Scope Could Not Be Verified'
    );
  });
  it('preserves a failed optional read rather than inventing zero statistics', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('unavailable') });
    await expect(readSeparatedPublicArenaRecord('target')).rejects.toThrow('unavailable');
  });
});
