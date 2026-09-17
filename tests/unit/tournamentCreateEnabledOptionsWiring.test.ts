import { describe, expect, it } from 'vitest';
import { buildTournamentConfig } from '@/lib/tournamentFromTableConfig';
import { tournamentService } from '@/services/TournamentService';

// Entirely synthetic test input. No captured configuration, user data, network
// call, or configuration export is used by this test.
const input = {
  name: 'Synthetic Free Buy option check',
  gameMode: 'mtt',
  buyIn: 0,
  startingChips: 1000,
  isSpins: false,
  sngPlayerCount: 3,
  maxPlayersRange: 100,
  minPlayers: 2,
  koBounty: false,
  numberOfRebuysReentries: 0,
  addOnMultiplier: 0,
  lateRegistrationLevel: 6,
  blindsUpMinutes: 5,
  startTime: '2030-01-01T18:00:00.000Z',
  blindStructure: 'standard',
  payoutStructure: 'payout1',
} satisfies Parameters<typeof buildTournamentConfig>[0];

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
  it('persists the actual manual selection instead of the unrelated server default', () => {
    expect(
      tournamentService.buildRpcConfig(
        buildTournamentConfig({ ...input, payoutStructure: 'payout3' })
      )
    ).toHaveProperty('payoutPercent', 15);
  });
});
