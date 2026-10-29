import { describe, it, expect } from 'vitest';
import { tournamentPaidPlaces } from '../../src/lib/tournamentPaidPlaces';

const ladder = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    place: index + 1,
    percentage: 100 / count,
  }));
describe('tournament paid finishing places', () => {
  it.each([1, 3, 11, 29])('reads %i actual finalized places from the canonical ladder', (count) => {
    expect(
      tournamentPaidPlaces({ prize_pool_finalized: true, payout_structure: ladder(count) })
    ).toBe(count);
    expect(
      tournamentPaidPlaces({
        prize_pool_finalized: true,
        payout_structure: JSON.stringify(ladder(count)),
      })
    ).toBe(count);
  });
  it('omits unfinalized, incomplete, malformed or nonpositive awards rather than guessing', () => {
    for (const payout_structure of [
      null,
      [],
      'invalid',
      [{ place: 1, percentage: 0 }],
      [
        { place: 1, percentage: 50 },
        { place: 3, percentage: 50 },
      ],
    ])
      expect(tournamentPaidPlaces({ prize_pool_finalized: true, payout_structure })).toBeNull();
    expect(
      tournamentPaidPlaces({ prize_pool_finalized: false, payout_structure: ladder(11) })
    ).toBeNull();
  });
  it('uses a drawn Spin tier and refuses an unavailable satellite entitlement', () => {
    expect(
      tournamentPaidPlaces({
        tournament_type: 'SPIN',
        spin_multiplier: 2,
        payout_structure: ladder(11),
      })
    ).toBe(1);
    expect(
      tournamentPaidPlaces({
        tournament_type: 'SPIN',
        spin_multiplier: null,
        payout_structure: ladder(11),
      })
    ).toBeNull();
    expect(
      tournamentPaidPlaces({
        tournament_type: 'SATELLITE',
        prize_pool_finalized: true,
        payout_structure: ladder(11),
      })
    ).toBeNull();
  });
});
