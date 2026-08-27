/**
 * 2026-08-27 — the card whose tail never ran.
 *
 * The 23-matchup card completed FOUR matchups inside the 90-minute budget,
 * every night, in list order - so the four oldest matchups were re-measured
 * repeatedly while every V15-V18 layer went unmeasured. The fix is daily
 * rotation; these pin that the rotation is deterministic, total, and
 * eventually covers every matchup.
 */
import { describe, it, expect } from 'vitest';
import { LEAGUE_MATCHUPS } from './HorseLeague.js';

/** The rotation the runner applies (mirrored here so the property is pinned
 *  even though runLeague itself needs a live engine). */
function cardFor(date: string): typeof LEAGUE_MATCHUPS {
  const dayIndex = Math.floor(Date.parse(date) / 86_400_000);
  const n = LEAGUE_MATCHUPS.length;
  const rotateBy = ((dayIndex % n) + n) % n;
  return LEAGUE_MATCHUPS.slice(rotateBy).concat(LEAGUE_MATCHUPS.slice(0, rotateBy));
}

describe('league card rotation', () => {
  it('is deterministic for a given date', () => {
    expect(cardFor('2026-08-27').map((m) => m.name)).toEqual(
      cardFor('2026-08-27').map((m) => m.name)
    );
  });

  it('rotates the head from day to day', () => {
    const a = cardFor('2026-08-27')[0].name;
    const b = cardFor('2026-08-28')[0].name;
    expect(a).not.toBe(b);
  });

  it('never drops or duplicates a matchup', () => {
    const card = cardFor('2026-09-14');
    expect(card).toHaveLength(LEAGUE_MATCHUPS.length);
    expect(new Set(card.map((m) => m.name)).size).toBe(LEAGUE_MATCHUPS.length);
  });

  it('every matchup leads the card within one full cycle', () => {
    const leaders = new Set<string>();
    const start = Date.parse('2026-09-01T00:00:00Z');
    for (let d = 0; d < LEAGUE_MATCHUPS.length; d++) {
      leaders.add(cardFor(new Date(start + d * 86_400_000).toISOString().slice(0, 10))[0].name);
    }
    // Each day's leader is distinct, so a full cycle reaches all of them:
    // no matchup can be permanently starved by the budget.
    expect(leaders.size).toBe(LEAGUE_MATCHUPS.length);
  });

  it('the card still contains the layers this session shipped', () => {
    const names = LEAGUE_MATCHUPS.map((m) => m.name);
    for (const required of [
      'plo6_v15_discipline',
      'v16_deep_reads',
      'v17_positional',
      'v18_squeeze_response',
    ]) {
      expect(names).toContain(required);
    }
  });
});
