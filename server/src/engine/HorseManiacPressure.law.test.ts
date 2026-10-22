/**
 * LAW: horses read a maniac in real time, call it off by arithmetic, and never
 * raise a hand they will fold to it.
 *
 * Dan (2026-10-22), verbatim: "IF A PLAYER IS MOVING ALL IN ON EVERY HAND THE
 * HORSES NEED TO RECOGNIZE THIS IN REAL TIME AND ADJUST THERE STRATEGY TO
 * CHANGE FOR THIS AND CALL OFF LIGHTER AND NOT RAISE A HAND WITH THE
 * INTENTION OF FOLDING. SAME GOES IN PLO WHEN AN AGGRESSIVE PLAYER IS PLAYING
 * 75% + VPIP AND POTTING AND RAISING EVERY HAND, THIS NEEDS TO BE ACCOUNTED
 * FOR AND THE STRATEGY ADJUSTED FOR ALL GAMES, LEVELS AND STAKES."
 *
 * Real HandController hands, five live horses against one seat that either
 * shoves every hand preflop or pots every street (HorseManiacPressure
 * .test-support). Measured on main before this law (same seeds, 200 hands):
 *   - NLH cash shover: 30% of shoves called; hands as good as K9o folded
 *     heads-up getting even money against any two cards;
 *   - NLH cash potter: 38% of the hands a horse raised ended with that horse
 *     folding to the re-raise (70 of 73 of them preflop: the 5-bet branch
 *     folded everything under a fixed premium bar);
 *   - heads-up postflop against the potter, 58% (PLO4) and 68% (NLH) of the
 *     folds held more than the price plus five points of equity.
 * Each pin below is one of those, with the margin the Monte Carlo needs.
 */
import { describe, expect, it } from 'vitest';
import {
  MANIAC_MIN_RAISE_WIDTH,
  maniacBehindOpenBar,
  maniacRaiseWidth,
  reRaiseLineWidth,
  strengthBarForTopShare,
  type OpponentExploitRead,
} from './HorseOpponentExploit.js';
import { playManiacPressure } from './HorseManiacPressure.test-support.js';

const HANDS = 120;

function readWith(
  stats: Partial<Record<string, { engaged: 'high' | 'low' | null; mean: number }>>
) {
  const base = { engaged: null, mean: 0.2, excess: 0, lower: 0, upper: 1 };
  const all = [
    'vpip',
    'pfr',
    'rfi',
    'threeBet',
    'foldTo3Bet',
    'betCheckedTo',
    'foldToBet',
    'riverCall',
  ].map((k) => [k, { ...base, ...(stats[k] ?? {}) }]);
  return { stats: Object.fromEntries(all) } as unknown as OpponentExploitRead;
}

describe('maniac pressure: who is a maniac', () => {
  it('is nobody without a read, and nobody whose raising is inside maniac width', () => {
    expect(maniacRaiseWidth(null)).toBeNull();
    expect(maniacRaiseWidth(readWith({ pfr: { engaged: 'high', mean: 0.3 } }))).toBeNull();
    expect(
      maniacRaiseWidth(readWith({ pfr: { engaged: 'high', mean: MANIAC_MIN_RAISE_WIDTH } }))
    ).toBeCloseTo(MANIAC_MIN_RAISE_WIDTH, 6);
  });
  it('reads a shover (pfr near 1, no 3-bet sample) and a re-raiser alike', () => {
    expect(maniacRaiseWidth(readWith({ pfr: { engaged: 'high', mean: 0.95 } }))).toBeCloseTo(
      0.95,
      6
    );
    expect(maniacRaiseWidth(readWith({ threeBet: { engaged: 'high', mean: 0.6 } }))).toBeCloseTo(
      0.6,
      6
    );
  });
  it('keeps a maniac 4-bet as wide as its 3-bet, a horse-like one at half', () => {
    expect(reRaiseLineWidth(1, 3)).toBeCloseTo(1, 6);
    expect(reRaiseLineWidth(0.3, 3)).toBeCloseTo(0.195, 6);
    expect(reRaiseLineWidth(0.6, 2)).toBe(0.6);
  });
  it('opens only what continues against the maniac: half its width in hold em', () => {
    expect(maniacBehindOpenBar(1, false)).toBe(strengthBarForTopShare(0.5));
    expect(maniacBehindOpenBar(1, true)).toBe(strengthBarForTopShare(0.7));
  });
});

describe('against a seat that shoves every hand (NLH, 6-max)', () => {
  const cash = playManiacPressure('nlh', 'cash', 'jammer', HANDS);
  const mtt = playManiacPressure('nlh', 'tournament', 'jammer', HANDS);

  it('recognises it in real time: the read is live within the first eight hands', () => {
    expect(cash.engagedFrom).not.toBeNull();
    expect(cash.engagedFrom!).toBeLessThanOrEqual(8);
    expect(mtt.engagedFrom!).toBeLessThanOrEqual(8);
  });

  it('calls it off by arithmetic: no first-in fold with real equity over the price (cash)', () => {
    expect(cash.jamFoldsAlone.length).toBeGreaterThan(20);
    const bad = cash.jamFoldsAlone.filter((f) => f.equity > f.price + 0.06);
    expect(bad).toEqual([]);
  });

  it('calls a meaningful share of shoves, not the old 30%', () => {
    const rate = cash.vsJam.call / (cash.vsJam.call + cash.vsJam.fold);
    expect(rate).toBeGreaterThan(0.38);
  });

  it('does not open hands it then folds to the shove', () => {
    expect(cash.raiseThenFold / Math.max(1, cash.horseAggressedHands)).toBeLessThan(0.05);
    expect(mtt.raiseThenFold / Math.max(1, mtt.horseAggressedHands)).toBeLessThan(0.05);
  });
});

describe('against a seat that pots every street', () => {
  const nlh = playManiacPressure('nlh', 'cash', 'potter', HANDS);
  const plo = playManiacPressure('plo4', 'cash', 'potter', HANDS);

  it('recognises it in real time in hold em and in Omaha', () => {
    expect(nlh.engagedFrom!).toBeLessThanOrEqual(8);
    expect(plo.engagedFrom!).toBeLessThanOrEqual(8);
  });

  it('never raises preflop to fold preflop to the re-raise', () => {
    expect(nlh.rtfByStreet['preflop->preflop'] ?? 0).toBeLessThanOrEqual(3);
    expect(plo.rtfByStreet['preflop->preflop'] ?? 0).toBeLessThanOrEqual(3);
    expect(nlh.raiseThenFold / Math.max(1, nlh.horseAggressedHands)).toBeLessThan(0.1);
  });

  it('calls its postflop bets down by equity: no heads-up fold well over the price', () => {
    for (const t of [nlh, plo]) {
      expect(t.postflopCalls).toBeGreaterThan(20);
      const bad = t.postflopFolds.filter((f) => f.equity > f.price + 0.12);
      expect(bad).toEqual([]);
    }
  });
});
