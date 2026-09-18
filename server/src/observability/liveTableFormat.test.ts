import { describe, expect, it } from 'vitest';
import { publicTournamentTableFormat } from './liveTableFormat.js';

describe('public live-table format uses recorded authority', () => {
  it.each([
    ['spin-v1', 'spin'],
    ['sng-v1', 'sng'],
    ['seat-first-satellite-v1', 'sng'],
    ['mtt-v1', 'mtt'],
    ['mtt-v2', 'mtt'],
  ])('%s is %s despite obsolete labels and numeric caps', (format_contract, expected) => {
    expect(
      publicTournamentTableFormat({
        format_contract,
        tournament_type: 'MTT',
        variant: 'spin',
        max_players: 2,
      })
    ).toBe(expected);
  });
  it.each([undefined, null, '', 'unknown'])(
    'refuses an unproved recorded format %s',
    (format_contract) => {
      expect(() =>
        publicTournamentTableFormat({ format_contract, tournament_type: 'MTT', max_players: 100 })
      ).toThrow('TOURNAMENT_FORMAT_CONTRACT_INVALID');
    }
  );
});
