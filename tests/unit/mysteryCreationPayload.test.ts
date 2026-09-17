import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '../../src/lib/supabase';
import { mysteryBountyCreationColumns } from '../../server/src/domain/mysteryBountyCreation';
vi.mock('../../src/services/GameAccessService', () => ({
  fetchGameCreationAccess: async () => ({ allowed: true }),
}));
vi.mock('../../src/utils/clubIdResolver', () => ({
  resolveClubUUID: async (value: string) => value,
}));
afterEach(() => vi.restoreAllMocks());
beforeEach(() => vi.clearAllMocks());
import { tournamentService, type TournamentConfig } from '../../src/services/TournamentService';
const base = {
  name: 'Synthetic mystery creation',
  type: 'mystery_bounty',
  gameVariant: 'nlh',
  buyIn: 10,
  rake: 10,
  startingStack: 10000,
  maxPlayers: 100,
  minPlayers: 3,
  blindStructure: [{ level: 1, smallBlind: 25, bigBlind: 50, ante: 0, durationMinutes: 10 }],
  payoutStructure: [{ place: 1, percentage: 100 }],
} as TournamentConfig;
describe('manual and saved schedule mystery contract', () => {
  it('carries chosen options on the atomic creation request', () => {
    const options = {
      mysteryBountyProfile: 'balanced',
      mysteryBountyActivation: 'percent_field',
      mysteryBountyActivationValue: 18,
      mysteryBountyPoolPercent: 80,
      mysteryBountyTopPercent: 15,
    } as const;
    expect(tournamentService.buildRpcConfig({ ...base, ...options })).toMatchObject(options);
  });
  it('makes default terms explicit without changing the entry allocation', () => {
    expect(tournamentService.buildRpcConfig(base)).toMatchObject({
      mysteryBountyProfile: 'classic',
      mysteryBountyActivation: 'at_the_money',
      mysteryBountyActivationValue: null,
      mysteryBountyPoolPercent: 50,
      mysteryBountyTopPercent: 20,
    });
  });

  it.each(['confirmed', 'missing', 'changed'] as const)(
    'uses one creator request with a %s configuration receipt',
    async (mode) => {
      const expected = mysteryBountyCreationColumns(base);
      const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
        data: {
          success: true,
          tournament_id: 'event',
          ...(mode === 'missing'
            ? {}
            : {
                mystery_config:
                  mode === 'changed' ? { ...expected, mystery_bounty_top_percent: 25 } : expected,
              }),
        },
        error: null,
      } as never);
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => ({ data: { id: 'event', ...expected }, error: null })),
      };
      vi.spyOn(supabase, 'from').mockReturnValue(chain as never);
      if (mode === 'confirmed')
        await expect(tournamentService.createTournament('club', base)).resolves.toMatchObject(
          expected
        );
      else
        await expect(tournamentService.createTournament('club', base)).rejects.toThrow(
          'tournament was created'
        );
      // The caller must not create again or apply configuration in a second request.
      expect(rpc.mock.calls.filter(([name]) => name === 'fn_create_tournament')).toHaveLength(1);
      expect(rpc.mock.calls.some(([name]) => name === 'fn_apply_mystery_bounty_config')).toBe(
        false
      );
      expect(rpc).toHaveBeenCalledWith('fn_create_tournament', {
        p_club_id: 'club',
        p_config: expect.objectContaining({ mysteryBountyProfile: 'classic' }),
      });
    }
  );
});
