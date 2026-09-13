import { describe, expect, it } from 'vitest';
import { buildTournamentConfig } from '@/lib/tournamentFromTableConfig';
import { tournamentService } from '@/services/TournamentService';

// Entirely synthetic test input. No captured configuration, user data, network
// call, or configuration export is used by this test.
const input = {
  name: 'Synthetic Free Buy option check',
  gameMode: 'Freezeout',
  buyIn: 0,
  startingChips: 1000,
  isSpins: false,
  sngPlayerCount: 3,
  maxPlayersRange: [2, 100],
  minPlayers: 2,
  koBounty: 0,
  numberOfRebuysReentries: 0,
  addOnMultiplier: 0,
  lateRegistrationLevel: 6,
  blindsUpMinutes: 5,
  startTime: new Date('2030-01-01T18:00:00.000Z'),
  blindStructure: [{ level: 1, smallBlind: 10, bigBlind: 20, ante: 0, duration: 5 }],
  payoutStructure: [{ place: 1, percentage: 100 }],
} as unknown as Parameters<typeof buildTournamentConfig>[0];

describe('Phase Three enabled Free Buy creation options', () => {
  it('preserves free entry and paid purchases while transmitting both enabled settings', () => {
    const mapped = buildTournamentConfig(input);
    expect(mapped).not.toBeNull();
    expect(mapped.buyIn).toBe(0);
    expect(mapped.isRebuy).toBe(true);
    expect(mapped.rebuyCost).toBe(1);
    expect(mapped.addOnAvailable).toBe(true);
    expect(mapped.addOnCost).toBe(1);
    expect.soft(mapped.freeBuy).toBe(true);
    expect.soft(mapped.addOnFromStart).toBe(true);
    const rpc = tournamentService.buildRpcConfig(mapped);
    expect(rpc.buyIn).toBe(0);
    expect(rpc.rebuyCost).toBe(1);
    expect(rpc.addOnCost).toBe(1);
    expect.soft(rpc.freeBuy).toBe(true);
    expect.soft(rpc.addOnFromStart).toBe(true);
  });
});

describe('paid depth reaches the authoritative creation and schedule payload', () => {
  it.each([10, 15, 20] as const)(
    'transmits selected %i percent without rewriting the pool',
    (payoutPercent) => {
      const mapped = buildTournamentConfig(input);
      const base = tournamentService.buildRpcConfig(mapped);
      const withDepth = tournamentService.buildRpcConfig({ ...mapped, payoutPercent });
      expect(withDepth).toEqual({ ...base, payoutPercent });
    }
  );
  it('leaves the server default intact when not selected', () => {
    expect(tournamentService.buildRpcConfig(buildTournamentConfig(input))).not.toHaveProperty(
      'payoutPercent'
    );
  });
});
