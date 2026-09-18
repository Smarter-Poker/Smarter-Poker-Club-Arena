import { afterEach, describe, expect, it, vi } from 'vitest';
import { tournamentService, type TournamentConfig } from '../../src/services/TournamentService';
import { tournamentScheduleService } from '../../src/services/TournamentScheduleService';
import { supabase } from '../../src/lib/supabase';
import { BLIND_STRUCTURES, newTournamentPlayingLevels } from '../../src/config/blindStructures';

afterEach(() => vi.restoreAllMocks());

const draft: TournamentConfig = {
  name: 'Unlimited Field',
  type: 'mtt',
  buyIn: 20,
  rake: 2,
  startingStack: 10000,
  maxPlayers: null,
  minPlayers: 3,
  tableSize: 6,
  blindStructure: newTournamentPlayingLevels(BLIND_STRUCTURES.regular),
  payoutStructure: [{ place: 1, percentage: 100 }],
  payoutPercent: 15,
  lateRegistrationLevels: 6,
  isRebuy: false,
  addOnAvailable: false,
};

describe('unlimited MTT creation and saved schedules', () => {
  it.each(['mtt', 'satellite', 'bounty', 'progressive_bounty', 'mystery_bounty'] as const)(
    'removes every legacy numeric cap from %s payloads',
    (type) => {
      for (const maxPlayers of [null, 0, 2, 100, 1000000]) {
        const config = Object.freeze({ ...draft, type, maxPlayers });
        const payload = tournamentService.buildRpcConfig(config);
        expect(payload.maxPlayers).toBeNull();
        expect(payload.tableSize).toBe(6);
        expect(payload.minPlayers).toBe(3);
        expect(payload.payoutPercent).toBe(15);
        expect(payload.buyIn).toBe(20);
        expect(config.maxPlayers).toBe(maxPlayers);
      }
    }
  );

  it.each(['sng', 'spin'] as const)('retains the fixed %s field', (type) => {
    const payload = tournamentService.buildRpcConfig({ ...draft, type, maxPlayers: 3 });
    expect(payload.maxPlayers).toBe(3);
  });

  it.each([null, 0, 2, 100])('validates the full MTT ladder with obsolete cap %s', (maxPlayers) => {
    expect(() =>
      tournamentService.buildRpcConfig({
        ...draft,
        maxPlayers,
        blindStructure: [],
      })
    ).toThrow('Invalid tournament blind structure');
  });

  it('cannot route a target-linked satellite through the old two-seat bypass', () => {
    expect(() =>
      tournamentService.buildRpcConfig({
        ...draft,
        type: 'sng',
        maxPlayers: 2,
        satelliteTarget: { tournamentId: 'target', seatsAwarded: 1 },
        blindStructure: [],
      })
    ).toThrow('Invalid tournament blind structure');
  });

  it('converts a valid saved two-seat satellite to the uncapped registration contract', () => {
    const payload = tournamentService.buildRpcConfig({
      ...draft,
      type: 'sng',
      maxPlayers: 2,
      satelliteTarget: { tournamentId: 'target', seatsAwarded: 1 },
    });
    expect(payload).toMatchObject({
      type: 'satellite',
      maxPlayers: null,
      satelliteTargetId: 'target',
    });
  });

  it.each(['bounty', 'progressive_bounty', 'mystery_bounty'] as const)(
    'refuses a %s feeder instead of dropping its payout authority',
    (type) => {
      expect(() =>
        tournamentService.buildRpcConfig({
          ...draft,
          type,
          satelliteTarget: { tournamentId: 'target', seatsAwarded: 1 },
        })
      ).toThrow('Satellites cannot combine ticket prizes with bounty or Spin payouts');
    }
  );

  it.each(['mtt', 'satellite'] as const)(
    'refuses hidden payout configuration on a plain %s feeder',
    (type) => {
      const config = {
        ...draft,
        type,
        satelliteTarget: { tournamentId: 'target', seatsAwarded: 1 },
      };
      expect(() =>
        tournamentService.buildRpcConfig({
          ...config,
          bountyConfig: { bountyType: 'fixed', baseBounty: 10 },
        })
      ).toThrow('Satellites cannot combine ticket prizes with bounty or Spin payouts');
      expect(() =>
        tournamentService.buildRpcConfig({
          ...config,
          spinConfig: { possibleMultipliers: [{ multiplier: 2, probability: 100 }] },
        })
      ).toThrow('Satellites cannot combine ticket prizes with bounty or Spin payouts');
    }
  );

  it('removes both spellings from stale schedule drafts without mutating the draft', async () => {
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { ok: true, schedule_id: 'schedule' },
      error: null,
    } as never);
    const config = Object.freeze({
      type: 'satellite',
      maxPlayers: 2,
      max_players: 2,
      minPlayers: 3,
    });
    await tournamentScheduleService.upsert({
      clubId: 'club',
      name: 'Satellite',
      daysOfWeek: [1],
      startTimesUtc: ['18:00'],
      config,
    });
    expect(rpc).toHaveBeenCalledWith(
      'fn_upsert_tournament_schedule',
      expect.objectContaining({
        p_schedule: expect.objectContaining({
          config: { type: 'satellite', maxPlayers: null, max_players: null, minPlayers: 3 },
        }),
      })
    );
    expect(config).toEqual({ type: 'satellite', maxPlayers: 2, max_players: 2, minPlayers: 3 });
  });

  it('normalizes an old SNG satellite schedule in the serializer spelling', async () => {
    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { ok: true, schedule_id: 'schedule' },
      error: null,
    } as never);
    const config = Object.freeze({ type: 'sng', satelliteTargetId: 'target', maxPlayers: 2 });
    await tournamentScheduleService.upsert({
      clubId: 'club',
      name: 'Satellite',
      daysOfWeek: [1],
      startTimesUtc: ['18:00'],
      config,
    });
    expect(rpc).toHaveBeenCalledWith(
      'fn_upsert_tournament_schedule',
      expect.objectContaining({
        p_schedule: expect.objectContaining({
          config: expect.objectContaining({
            satelliteTargetId: 'target',
            maxPlayers: null,
            max_players: null,
          }),
        }),
      })
    );
    expect(config.maxPlayers).toBe(2);
  });

  it.each([undefined, null, 'unknown-v9'])(
    'refuses a waitlist write when the persisted format is %s',
    async (format_contract) => {
      vi.spyOn(tournamentService, 'getTournament').mockResolvedValue({
        id: 'unknown',
        tournament_type: 'SNG',
        variant: 'sng',
        max_players: 2,
        format_contract,
      } as never);
      const from = vi.spyOn(supabase, 'from');
      await expect(tournamentService.joinTournamentWaitlist('unknown', 'player')).rejects.toThrow(
        'TOURNAMENT_FORMAT_CONTRACT_INVALID'
      );
      expect(from).not.toHaveBeenCalled();
    }
  );

  it('does not place an MTT in a waitlist for a nonexistent entry ceiling', async () => {
    vi.spyOn(tournamentService, 'getTournament').mockResolvedValue({
      id: 'mtt',
      tournament_type: 'MTT',
      variant: 'freezeout',
      max_players: 2,
      format_contract: 'mtt-v1',
    } as never);
    const from = vi.spyOn(supabase, 'from');
    await expect(tournamentService.joinTournamentWaitlist('mtt', 'player')).rejects.toThrow(
      'Register Directly For This Tournament'
    );
    expect(from).not.toHaveBeenCalled();
  });
});
