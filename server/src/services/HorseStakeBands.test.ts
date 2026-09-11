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
  applyStakeBandSupply,
  clearHorseStakeBands,
  clearStakeBandSupply,
  effectiveStakeBandFor,
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
    // The gate also takes the TABLE'S HOST since 2026-09-11: a band is only
    // meaningful against the ladder that host actually deals, and the platform
    // ladder is the union of two hosts that deal different things.
    expect(src).toContain('!stakeBandAllows(');
    expect(src).toContain("String((table as { club_id?: string | null }).club_id ?? '')");
    const filterAt = src.indexOf('!stakeBandAllows(');
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
    /* 2026-09-05: the rescue reaches to `sittable`, which is candidateHorses
       narrowed by the sit verdict for a cluster table and candidateHorses
       itself otherwise - still band-filtered, still never validHorses. */
    expect(src).toContain('let sittable = candidateHorses;');
    expect(src).toContain(
      'if (pool.length < emptySeats.length && humanNeedsRescue) pool = sittable;'
    );
    expect(src).not.toContain('humanNeedsRescue) pool = validHorses');
    expect(src).not.toContain('humanNeedsRescue) pool = candidateHorses');
  });

  it('the loader hydrates bands from the same page scan as lanes', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./HorseLaneLoader.ts', import.meta.url).pathname, 'utf8');
    expect(src).toContain('setHorseStakeBands(bandRows)');
    expect(src).toContain('fn_assign_horse_stake_bands');
  });
});

/**
 * A BAND WITH NO GAME IN IT (2026-09-05).
 *
 * `fn_assign_horse_stake_bands` ranks the fleet by bb/100 and never asks which
 * games exist. Measured on 2026-09-05: 100 horses held 'high' and there was
 * not one enabled game with bb > 6 on the platform - an operator had closed
 * all six high games (5/10 NLH Classic/Action/Madness, 5/10 PLO4 Classic,
 * 10/20 NLH, 25/50 NLH) at 16:47 the previous day. `stakeBandAllows` is a hard
 * gate, so those 100 horses could sit nowhere at all.
 *
 * The engine's answer is a SEATING fallback, downward only, with the stored
 * band left exactly as the merit run wrote it.
 */
describe('a band with no enabled game seats one band down, and never one band up', () => {
  beforeEach(() => {
    clearStakeBandSupply();
    // The loader MERGES, and earlier cases in this file have loaded bands, so
    // start from an empty fleet: the fallback COUNT is part of what is pinned.
    clearHorseStakeBands();
    setHorseStakeBands([
      { id: 'nosebleed', stakeBand: 'high' },
      { id: 'midstakes', stakeBand: 'mid' },
      { id: 'regular', stakeBand: 'low' },
      { id: 'grinder', stakeBand: 'micro' },
    ]);
  });

  it('a high horse with no high game seats in mid', () => {
    const report = applyStakeBandSupply(['micro', 'low', 'mid']);
    expect(report.missing).toEqual(['high']);
    expect(report.fallbacks).toBe(1);
    expect(effectiveStakeBandFor('nosebleed')).toBe('mid');
    expect(stakeBandAllows('nosebleed', 4)).toBe(true); // 2.00/4.00
    // And still nowhere near a micro game: the drop is one rung, not a reset.
    expect(stakeBandAllows('nosebleed', 0.2)).toBe(false);
  });

  it('the same horse with a high game open stays high', () => {
    applyStakeBandSupply(['micro', 'low', 'mid', 'high']);
    expect(effectiveStakeBandFor('nosebleed')).toBe('high');
    expect(stakeBandAllows('nosebleed', 10)).toBe(true);
    expect(stakeBandAllows('nosebleed', 4)).toBe(false);
  });

  it('it drops past an empty rung to the highest band that does have a game', () => {
    applyStakeBandSupply(['micro', 'low']);
    expect(effectiveStakeBandFor('nosebleed')).toBe('low');
    expect(effectiveStakeBandFor('midstakes')).toBe('low');
  });

  it('a micro horse is never promoted, however empty the floor below it is', () => {
    const report = applyStakeBandSupply(['mid']);
    expect(effectiveStakeBandFor('grinder')).toBe('micro');
    expect(stakeBandAllows('grinder', 4)).toBe(false);
    expect(stakeBandAllows('grinder', 0.1)).toBe(true);
    // It is reported as unserved, but it is not counted as a fallback: it did
    // not move, and the log line counts horses that moved.
    expect(report.missing).toContain('micro');
    // Only the high horse moves: it drops to mid. The low horse has nothing
    // below it either (micro has no game) and stays put, and micro cannot be
    // promoted. One horse moved, so the log line says one.
    expect(report.fallbacks).toBe(1);
  });

  it('an empty table list changes nothing - an unread floor is not an empty one', () => {
    applyStakeBandSupply(['micro', 'low', 'mid']);
    expect(effectiveStakeBandFor('nosebleed')).toBe('mid');
    const report = applyStakeBandSupply([]);
    expect(report).toEqual({ missing: [], fallbacks: 0 });
    expect(effectiveStakeBandFor('nosebleed')).toBe('high');
    expect(stakeBandAllows('nosebleed', 10)).toBe(true);
  });

  it('the stored band is a merit record and is never rewritten by the fallback', () => {
    applyStakeBandSupply(['micro', 'low', 'mid']);
    expect(effectiveStakeBandFor('nosebleed')).toBe('mid');
    expect(stakeBandFor('nosebleed')).toBe('high');
    expect(assignedStakeBandCount()).toBe(4);
  });

  it('the fleet publishes the supply from the tables it already read, and says so once', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./HorseFleetManager.ts', import.meta.url).pathname, 'utf8');
    // Derived from the cycle's own table list; no second query.
    expect(src).toContain('const bandsWithAGame = new Set<HorseStakeBand>();');
    expect(src).toContain('const band = stakeBandForBigBlind(Number(t.big_blind));');
    expect(src).toContain('bandsWithAGame.add(band);');
    // AND PER HOST (2026-09-11): the same scan, keyed by the table's club, so
    // a Deep Stack 25/50 game stops telling a Midway horse that 'high' has a
    // game it could never sit at.
    expect(src).toContain('const bandsWithAGameByHost = new Map<string, Set<HorseStakeBand>>();');
    expect(src).toContain('hostBands.add(band);');
    expect(src).toContain(
      'const bandSupply = applyStakeBandSupply(bandsWithAGame, bandsWithAGameByHost);'
    );
    expect(src).toContain('[HorseFleet] band supply: no enabled game in band(s) ');
    expect(src).toContain('horse(s) seat one band down');
    // A table the seeding loop would refuse is not supply.
    expect(src).toContain('if (isTableOfDisabledGame(t, disabledGameIds)) continue;');
  });
});
