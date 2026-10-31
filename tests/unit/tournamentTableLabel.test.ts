import { describe, expect, it } from 'vitest';
import { tournamentTableLabel } from '../../src/utils/tournamentTableLabel';

describe('persisted tournament table identity', () => {
  it('reads only explicit table numbers and preserves a final table name', () => {
    expect(tournamentTableLabel('Friday Fight Night PKO - Table 4')).toBe('Table 4');
    expect(tournamentTableLabel('Event - Day 2 Table #12')).toBe('Table 12');
    expect(tournamentTableLabel('Event - Final Table')).toBe('Final Table');
  });
  it('never mistakes a buy-in, missing name or invalid number for a table', () => {
    for (const name of [null, '', 'PLO4 Heads-Up 100', 'Table 0', 'Table 9007199254740992']) {
      expect(tournamentTableLabel(name)).toBeNull();
    }
  });
});
