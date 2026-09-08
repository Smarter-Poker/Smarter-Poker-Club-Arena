import { describe, expect, it } from 'vitest';
import { publicTournamentTableFormat } from './liveTableFormat.js';

describe('public live-table format classification', () => {
  it('treats either historical Spin marker as authoritative', () => {
    expect(publicTournamentTableFormat({ tournament_type: 'spin' })).toBe('spin');
    expect(publicTournamentTableFormat({ variant: 'SPIN', tournament_type: 'MTT' })).toBe('spin');
  });

  it('classifies every Sit & Go spelling and legacy heads-up row', () => {
    expect(publicTournamentTableFormat({ tournament_type: 'sng' })).toBe('sng');
    expect(publicTournamentTableFormat({ variant: 'SNG', tournament_type: 'SATELLITE' })).toBe(
      'sng'
    );
    expect(publicTournamentTableFormat({ tournament_type: 'MTT', max_players: 2 })).toBe('sng');
  });

  it('keeps ordinary and multi-table satellite tournaments in the MTT lane', () => {
    expect(publicTournamentTableFormat({ tournament_type: 'MTT', max_players: 140 })).toBe('mtt');
    expect(
      publicTournamentTableFormat({ tournament_type: 'SATELLITE', variant: 'satellite' })
    ).toBe('mtt');
  });

  it('does not let malformed seat counts turn an unknown tournament into SNG', () => {
    expect(publicTournamentTableFormat({ max_players: 0 })).toBe('mtt');
    expect(publicTournamentTableFormat({ max_players: 'not-a-number' })).toBe('mtt');
  });
});
