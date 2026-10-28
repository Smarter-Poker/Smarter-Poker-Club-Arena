import { TournamentManagerBase } from './TournamentManagerBase.js';
import { describe, expect, it } from 'vitest';
import {
  isFixedSngSatellite,
  isUnlimitedMtt,
  normalizeTournamentMaxPlayers,
} from './tournamentEntryCapacity.js';
const field = (seats: number) => ({
  tournament_type: 'SNG',
  variant: 'sng',
  max_players: seats,
  min_players: seats,
  table_size: seats,
  satellite_target_id: 'target',
  satellite_seats: 2,
});
describe('fixed field satellite contract', () => {
  it.each([6, 9])('keeps the paid %s-player field finite', (seats) => {
    expect(isFixedSngSatellite(field(seats))).toBe(true);
    expect(isUnlimitedMtt(field(seats))).toBe(false);
    expect(normalizeTournamentMaxPlayers(field(seats))).toBe(seats);
  });
  it.each([2, 3, 5, 7, 8, 10])(
    'does not grant a fixed satellite exception to %s seats',
    (seats) => {
      expect(isUnlimitedMtt(field(seats))).toBe(true);
    }
  );
  it.each(['min_players', 'table_size', 'satellite_seats'])(
    'refuses a contradictory %s contract',
    (key) => {
      expect(isUnlimitedMtt({ ...field(9), [key]: 3 })).toBe(true);
    }
  );
  it('refuses contradictory target pointers', () => {
    expect(isFixedSngSatellite({ ...field(9), satellite_target: 'another-target' })).toBe(false);
  });
  it('does not convert a scheduled satellite or an ordinary SNG', () => {
    expect(isUnlimitedMtt({ ...field(9), tournament_type: 'MTT' })).toBe(true);
    expect(isFixedSngSatellite({ ...field(9), satellite_target_id: undefined })).toBe(false);
  });
});

describe('fixed SNG uses the qualifier completion owner', () => {
  it('permits only the recorded exact field alongside the existing MTT cohort', () => {
    const manager = Object.create(TournamentManagerBase.prototype) as any;
    manager.tournamentCache = { ...field(9), format_contract: 'sng-v1' };
    expect(manager.isCohortSatellite()).toBe(true);
    manager.tournamentCache.table_size = 8;
    expect(manager.isCohortSatellite()).toBe(false);
    manager.tournamentCache = { satellite_target_id: 'target', format_contract: 'mtt-v2' };
    expect(manager.isCohortSatellite()).toBe(true);
  });
});
