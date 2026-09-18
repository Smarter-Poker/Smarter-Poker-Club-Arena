import { describe, expect, it } from 'vitest';
import { rakeRateFor } from './buyIn.js';

describe('new entry quotes keep MTTs distinct from purchased fixed formats', () => {
  it.each(['MTT', 'XMTT', 'SATELLITE', 'progressive', 'mystery'])(
    'quotes %s at the MTT rate despite an obsolete cap',
    (tournamentType) => {
      expect(rakeRateFor({ tournamentType, maxPlayers: 2 })).toBe(0.1);
    }
  );
  it.each(['satelliteTargetId', 'satellite_target_id', 'satellite_target', 'satelliteTarget'])(
    'recognizes the linked target spelling %s before a stale fixed label',
    (field) => {
      expect(
        rakeRateFor({
          tournamentType: 'SNG',
          maxPlayers: 2,
          [field]: field === 'satelliteTarget' ? { tournamentId: 'target' } : 'target',
        })
      ).toBe(0.1);
    }
  );
  it('keeps genuine fixed quote rates', () => {
    expect(rakeRateFor({ tournamentType: 'SNG', maxPlayers: 2 })).toBe(0.05);
    expect(rakeRateFor({ tournamentType: 'SNG', maxPlayers: 6 })).toBe(0.1);
    expect(rakeRateFor({ tournamentType: 'SPIN', maxPlayers: 3 })).toBe(0);
  });
});
