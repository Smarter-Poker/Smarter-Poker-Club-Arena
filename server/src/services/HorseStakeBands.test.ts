/**
 * EVERY HORSE PLAYS ONE STAKE (Dan 2026-08-29, binding).
 *
 * "A HORSE PLAYING 5/10 OR 10/25 SHOULD NEVER BE SEEN ON A 50 CENT ONE DOLLAR
 *  GAME OR 1/2 DOLLAR GAME, THAT JUST LOOKS SUSPICIOUS."
 *
 * The measurement that prompted this: over 48 hours, 64 of 210 seated horses
 * played more than one stake level. `yankee` sat at 0.10/0.20 AND 25.00/50.00.
 *
 * Every case below is that rule, or a way the rule could be quietly lost.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  stakeBandForBigBlind,
  stakeBandFor,
  stakeBandAllows,
  setHorseStakeBands,
  assignedStakeBandCount,
  type HorseStakeBand,
} from './HorseBehavior.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('stakeBandForBigBlind - the real stake ladder, with nothing straddling an edge', () => {
  const cases: Array<[number, HorseStakeBand]> = [
    [0.1, 'micro'], // 0.05/0.10
    [0.2, 'micro'], // 0.10/0.20
    [0.5, 'micro'], // 0.25/0.50
    [1, 'low'], // 0.50/1.00
    [2, 'low'], // 1.00/2.00
    [4, 'mid'], // 2.00/4.00
    [5, 'mid'], // 2.00/5.00  — the fleet's own second config
    [6, 'mid'], // 3.00/6.00
    [10, 'high'], // 5.00/10.00
    [25, 'high'], // 10.00/25.00
    [50, 'high'], // 25.00/50.00
  ];

  for (const [bb, band] of cases) {
    it(`big blind ${bb} is ${band}`, () => {
      expect(stakeBandForBigBlind(bb)).toBe(band);
    });
  }

  it('never throws on a missing or nonsense big blind - an unreadable table is not a licence to seat anyone', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const band = stakeBandForBigBlind(bad);
      expect(['micro', 'low', 'mid', 'high']).toContain(band);
    }
  });
});

describe('stakeBandAllows - the rule itself', () => {
  beforeEach(() => {
    setHorseStakeBands([
      { id: 'nosebleed', stakeBand: 'high' },
      { id: 'grinder', stakeBand: 'micro' },
      { id: 'regular', stakeBand: 'low' },
      { id: 'midstakes', stakeBand: 'mid' },
    ]);
  });

  it('THE HEADLINE: a 10/25 horse may not sit in a 0.50/1 game', () => {
    expect(stakeBandAllows('nosebleed', 25)).toBe(true);
    expect(stakeBandAllows('nosebleed', 1)).toBe(false);
    expect(stakeBandAllows('nosebleed', 2)).toBe(false);
    expect(stakeBandAllows('nosebleed', 0.2)).toBe(false);
  });

  it('and the reverse - a micro grinder does not appear at 25/50', () => {
    expect(stakeBandAllows('grinder', 0.2)).toBe(true);
    expect(stakeBandAllows('grinder', 50)).toBe(false);
  });

  it('reproduces the exact yankee case: 0.10/0.20 and 25.00/50.00 cannot both be allowed', () => {
    for (const id of ['nosebleed', 'grinder', 'regular', 'midstakes']) {
      const both = stakeBandAllows(id, 0.2) && stakeBandAllows(id, 50);
      expect(both).toBe(false);
    }
  });

  it('within a band a horse still moves freely - 2/4 and 3/6 are the same game to a mid regular', () => {
    expect(stakeBandAllows('midstakes', 4)).toBe(true);
    expect(stakeBandAllows('midstakes', 5)).toBe(true);
    expect(stakeBandAllows('midstakes', 6)).toBe(true);
  });

  it('exactly one band accepts any given table, so no horse is dual-eligible', () => {
    const ids = ['nosebleed', 'grinder', 'regular', 'midstakes'];
    for (const bb of [0.1, 0.5, 1, 2, 4, 6, 10, 50]) {
      expect(ids.filter((id) => stakeBandAllows(id, bb)).length).toBe(1);
    }
  });
});

describe('assignment beats the hash, and the hash still covers a brand-new horse', () => {
  it('an assigned band wins over the fallback', () => {
    const id = uuid(1);
    setHorseStakeBands([{ id, stakeBand: 'high' }]);
    expect(stakeBandFor(id)).toBe('high');
    setHorseStakeBands([{ id, stakeBand: 'micro' }]);
    expect(stakeBandFor(id)).toBe('micro');
  });

  it('rejects garbage rather than storing it - a bad value must fall back, not become a band', () => {
    const id = uuid(2);
    setHorseStakeBands([{ id, stakeBand: 'high' }]);
    const before = assignedStakeBandCount();
    const applied = setHorseStakeBands([
      { id: uuid(3), stakeBand: 'nosebleed' },
      { id: uuid(4), stakeBand: '' },
      { id: uuid(5), stakeBand: null },
      { id: '', stakeBand: 'low' },
    ]);
    expect(applied).toBe(0);
    expect(assignedStakeBandCount()).toBe(before);
    expect(stakeBandFor(id)).toBe('high');
  });

  /**
   * A BAND IS EARNED (Dan 2026-08-29): micro = worst performers, low = second
   * worst, mid = good winners, high = the best. So an unproven horse cannot be
   * hashed into a band — a band is a claim about results and it has none.
   */
  it('a horse with no record starts at the BOTTOM, never at a hashed band', () => {
    for (let i = 0; i < 500; i++) {
      expect(stakeBandFor(`brand-new-${i}`)).toBe('micro');
    }
  });

  it('no unranked horse can reach the high band by luck of its uuid', () => {
    const seen = new Set<HorseStakeBand>();
    for (let i = 0; i < 4000; i++) seen.add(stakeBandFor(`fallback-${i}`));
    // Exactly one outcome. Seating an unproven player in the 25/50 game on the
    // strength of its id is the arbitrary assignment this replaced.
    expect([...seen]).toEqual(['micro']);
  });
});

describe('the shipped wiring - the rule is worthless if the seater does not consult it', () => {
  it('HorseFleetManager filters candidates by stake band before selecting', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./HorseFleetManager.ts', import.meta.url).pathname, 'utf8');
    // The call must be in the candidate filter, which is the only place that
    // runs before the weighted pick. Sizing a buy-in from the blinds - which
    // the file already did - never influenced WHICH horse was chosen.
    expect(src).toContain('stakeBandAllows(h.id, table.big_blind)');
    const filterAt = src.indexOf('stakeBandAllows(h.id, table.big_blind)');
    const pickAt = src.indexOf('const weighted = pool');
    expect(filterAt).toBeGreaterThan(0);
    expect(filterAt).toBeLessThan(pickAt);
  });

  it('the human-rescue fallback widens the HOUR, never the band', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./HorseFleetManager.ts', import.meta.url).pathname, 'utf8');
    // `pool = candidateHorses` is the rescue path. candidateHorses is already
    // band-filtered, so the rescue can pull an off-hours horse of the RIGHT
    // stake and never a nosebleed regular into a micro game. If someone ever
    // makes the rescue reach past candidateHorses, this pin is the alarm.
    expect(src).toContain(
      'if (pool.length < emptySeats.length && humanNeedsRescue) pool = candidateHorses;'
    );
    expect(src).not.toContain('humanNeedsRescue) pool = validHorses');
  });

  it('the loader hydrates bands from the same page scan as lanes', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./HorseLaneLoader.ts', import.meta.url).pathname, 'utf8');
    expect(src).toContain('setHorseStakeBands(bandRows)');
    expect(src).toContain('fn_assign_horse_stake_bands');
  });
});
