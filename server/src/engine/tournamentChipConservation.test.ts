import { describe, expect, it } from 'vitest';
import { checkTournamentChipConservation } from './tournamentChipConservation.js';

const dealt = (entries: Array<[string, number]>) => new Map(entries);

describe('checkTournamentChipConservation', () => {
  it('passes a conserved hand: the dealt players hold exactly what they were dealt', () => {
    const v = checkTournamentChipConservation({
      dealt: dealt([
        ['a', 1000],
        ['b', 1000],
        ['c', 1000],
      ]),
      settled: [
        { user_id: 'a', stack: 0 },
        { user_id: 'b', stack: 1527 },
        { user_id: 'c', stack: 1473 },
      ],
      rake: 0,
    });
    expect(v).toEqual({ ok: true, dealtTotal: 3000, settledTotal: 3000, delta: 0, missing: [] });
  });

  it('refuses a minted hand and says by how much', () => {
    // the 0573b719 record: 3000 dealt, 4000 on the felt afterwards
    const v = checkTournamentChipConservation({
      dealt: dealt([
        ['a', 0],
        ['b', 1527],
        ['c', 1473],
      ]),
      settled: [
        { user_id: 'a', stack: 1000 },
        { user_id: 'b', stack: 1497 },
        { user_id: 'c', stack: 1503 },
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.delta).toBe(1000);
  });

  it('refuses a destroyed hand (negative delta)', () => {
    const v = checkTournamentChipConservation({
      dealt: dealt([
        ['a', 500],
        ['b', 500],
      ]),
      settled: [
        { user_id: 'a', stack: 300 },
        { user_id: 'b', stack: 430 },
      ],
    });
    expect(v.ok).toBe(false);
    expect(v.delta).toBe(-270);
  });

  it('ignores players who were not dealt in (a seat taken mid-hand)', () => {
    const v = checkTournamentChipConservation({
      dealt: dealt([
        ['a', 500],
        ['b', 500],
      ]),
      settled: [
        { user_id: 'a', stack: 700 },
        { user_id: 'b', stack: 300 },
        { user_id: 'late', stack: 1000 },
      ],
    });
    expect(v.ok).toBe(true);
    expect(v.settledTotal).toBe(1000);
  });

  it('refuses when a dealt player has no settled stack at all', () => {
    const v = checkTournamentChipConservation({
      dealt: dealt([
        ['a', 500],
        ['b', 500],
      ]),
      settled: [{ user_id: 'a', stack: 1000 }],
    });
    // the totals happen to match, and the hand is still a hole in the record
    expect(v.delta).toBe(0);
    expect(v.missing).toEqual(['b']);
    expect(v.ok).toBe(false);
  });

  it('accounts for declared rake, so a raked variant would still conserve', () => {
    const v = checkTournamentChipConservation({
      dealt: dealt([
        ['a', 100],
        ['b', 100],
      ]),
      settled: [
        { user_id: 'a', stack: 150 },
        { user_id: 'b', stack: 45 },
      ],
      rake: 5,
    });
    expect(v.ok).toBe(true);
  });

  it('is exact to the cent and tolerant of float noise', () => {
    const v = checkTournamentChipConservation({
      dealt: dealt([
        ['a', 0.1],
        ['b', 0.2],
      ]),
      settled: [
        { user_id: 'a', stack: 0.3 },
        { user_id: 'b', stack: 0 },
      ],
    });
    expect(v.ok).toBe(true);
  });
});
