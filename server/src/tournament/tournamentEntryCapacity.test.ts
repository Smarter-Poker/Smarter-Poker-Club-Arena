import { describe, expect, it } from 'vitest';
import {
  isTournamentEntryFull,
  isUnlimitedMtt,
  normalizeTournamentMaxPlayers,
} from './tournamentEntryCapacity.js';

describe('MTT entry fields have no maximum', () => {
  it.each(['MTT', 'XMTT', 'SATELLITE', 'freezeout', 'bounty', 'progressive',
    'progressive_bounty', 'pko', 'mystery', 'mystery_bounty', 'rebuy', 'reentry', 'mtt_freezeout', 'mtt_free_buy', 'mtt_rebuy', 'mtt_reentry'])(
    '%s ignores every historical numeric cap', (type) => {
      for (const maxPlayers of [null, 2, 100, 10000]) {
        const row = { type, maxPlayers };
        expect(isUnlimitedMtt(row)).toBe(true);
        expect(normalizeTournamentMaxPlayers(row)).toBeNull();
        expect(isTournamentEntryFull(row, 10001)).toBe(false);
      }
    }
  );
  it('treats an old two-seat SNG-shaped satellite as an unlimited satellite', () => {
    const row = { tournament_type: 'SATELLITE', variant: 'sng', max_players: 2 };
    expect(isUnlimitedMtt(row)).toBe(true);
    expect(normalizeTournamentMaxPlayers(row)).toBeNull();
    expect(isTournamentEntryFull(row, 2)).toBe(false);
  });
  it.each([
    { satellite_target_id: 'target' },
    { satelliteTargetId: 'target' },
    { satellite_target: 'target' },
    { satelliteTarget: { tournamentId: 'target', seatsAwarded: 1 } },
  ])('recognizes linked satellites before old fixed labels (%j)', (target) => {
    expect(isUnlimitedMtt({ type: 'SPIN', variant: 'spin', maxPlayers: 3, ...target })).toBe(true);
  });
  it.each([null, '', '   ', {}, { seatsAwarded: 1 }, { tournamentId: '' }])(
    'does not invent a satellite target from %j', (satelliteTarget) => {
      expect(isUnlimitedMtt({ type: 'SNG', maxPlayers: 2, satelliteTarget })).toBe(false);
    }
  );
  it('recognizes a historical MTT variant when its type was absent', () => {
    expect(isUnlimitedMtt({ tournament_type: null, variant: 'mtt', max_players: 2 })).toBe(true);
  });
  it.each([['SNG', 2], ['SNG', 6], ['SPIN', 3]] as const)(
    '%s keeps its %i-seat field', (type, maxPlayers) => {
      const row = { type, maxPlayers };
      expect(isUnlimitedMtt(row)).toBe(false);
      expect(normalizeTournamentMaxPlayers(row)).toBe(maxPlayers);
      expect(isTournamentEntryFull(row, maxPlayers - 1)).toBe(false);
      expect(isTournamentEntryFull(row, maxPlayers)).toBe(true);
    }
  );
  it('does not classify unknown shapes or physical table capacity as unlimited MTTs', () => {
    expect(isUnlimitedMtt({ max_players: 9 })).toBe(false);
    expect(isUnlimitedMtt({ type: 'unknown', max_players: null })).toBe(false);
    expect(isTournamentEntryFull({ type: 'SNG', max_players: null }, 0)).toBe(true);
  });
});
