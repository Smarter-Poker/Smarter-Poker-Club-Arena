/**
 * ═══════════════════════════════════════════════════════════════════════════
 * VARIANT SCALE PARITY — every game is played on the same yardstick
 * (Dan 2026-08-30: "CHECK FOR THIS BUG EVERYWHERE ELSE AS WELL, FOR ALL GAME
 * VARIATIONS AND STAKES")
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE BUG CLASS. `decidePreflopV7`'s thresholds are PERCENTILE-INTENT: a bar
 * at t(0.62) means "roughly the top slice of the range", not "an absolute
 * score of 0.62". Every variant has its own scoring function with its own
 * distribution. Feed a bar calibrated on one distribution a score drawn from
 * another and the bar silently means something different — with no error, no
 * warning, and no test failure.
 *
 * It shipped in BOTH directions. Measured through the real decide(), the
 * identical spot, 300 deals per cell:
 *
 *     variant      median | opens | facing a pot raise
 *     nlh          0.232  |  22%  | fold 48%      <- the reference
 *     plo4         0.240  |   4%  | fold 64%, RAISE 0%   <- compressed
 *     short_deck   0.420  |  40%  | fold 23%             <- inflated
 *     pineapple    0.493  |  51%  | fold 15%             <- inflated
 *
 * PLO could not reach a raise bar at all (Dan's live report). Short deck and
 * pineapple cleared every bar far too easily, because a 36-card deck and a
 * three-card hand make every hand better in ABSOLUTE terms — which the score
 * functions correctly say, and which a percentile-intent bar must not be
 * asked to interpret.
 *
 * THE CONTRACT THIS FILE ENFORCES: every variant's preflop strength is
 * mapped onto the hold'em scale by quantile before it reaches a threshold.
 * Variant intent lives in the V8 style overlay in HorseLogic (Omaha tightens
 * and trims slowplay; short deck trims bluffs), where it is explicit and
 * reviewable — never in an uncorrected scoring range.
 *
 * These are PARITY assertions, not frozen frequencies: they compare each
 * variant against hold'em in the same spot, so a future retune of the bars
 * moves them all together and this file keeps meaning the same thing.
 */
import { describe, it, expect } from 'vitest';
import { HorseLogic } from './HorseLogic.js';
import { variantInfo } from './HorseEval.js';
import type { Card, SeatPlayer } from '../types.js';

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const C = (r: string, s: string): Card => ({ rank: r, suit: s }) as Card;
const FULL_RANKS = '23456789TJQKA'.split('');
const SHORT_RANKS = '6789TJQKA'.split('');

/** Every live variant and the number of hole cards it deals. */
const LIVE_VARIANTS: Array<[string, number]> = [
  ['nlh', 2],
  ['plo4', 4],
  ['plo5', 5],
  ['plo6', 6],
  ['plo8', 4],
  ['short_deck', 2],
  ['pineapple', 3],
];

function deckFor(variant: string): Card[] {
  const ranks = variantInfo(variant).isShortDeck ? SHORT_RANKS : FULL_RANKS;
  const d: Card[] = [];
  for (const r of ranks) for (const s of SUITS) d.push(C(r, s));
  return d;
}

function makeDealer(seed: number, variant: string) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  return (n: number): Card[] => {
    const d = deckFor(variant);
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [d[i], d[j]] = [d[j], d[i]];
    }
    return d.slice(0, n);
  };
}

/** Preflop strength exactly as the engine computes it. */
function strengthDistribution(variant: string, holes: number) {
  const deal = makeDealer(4242, variant);
  const a: number[] = [];
  for (let i = 0; i < 400; i++) {
    a.push(HorseLogic.calculateHandStrength(deal(holes), [], 'preflop', variant));
  }
  a.sort((x, y) => x - y);
  return { median: a[200], p75: a[300], max: a[399] };
}

/**
 * Action mix in one fixed spot. `bb` scales the whole table so the same spot
 * can be replayed at micro and at high stakes.
 */
function actionMix(variant: string, holes: number, facing: boolean, bb = 2) {
  const deal = makeDealer(facing ? 2718 : 31337, variant);
  const t: Record<string, number> = {};
  const u = bb / 2; // the reference spot is written in units of a 2-chip BB
  for (let i = 0; i < 240; i++) {
    const cards = deal(holes);
    const hero = (facing
      ? {
          seat: 3,
          user_id: `g${i}`,
          stack: 48 * u,
          bet: 2 * u,
          is_folded: false,
          is_sitting_out: false,
          cards,
        }
      : {
          seat: 1,
          user_id: `h${i}`,
          stack: 49 * u,
          bet: 1 * u,
          is_folded: false,
          is_sitting_out: false,
          cards,
        }) as unknown as SeatPlayer;
    const gs = facing
      ? {
          players: [
            hero,
            { seat: 1, user_id: 'human', stack: 43 * u, bet: 7 * u, is_folded: false, cards: [] },
            { seat: 2, user_id: 'other', stack: 49 * u, bet: 1 * u, is_folded: true, cards: [] },
          ],
          communityCards: [],
          pot: 10 * u,
          currentBet: 7 * u,
          minRaise: 5 * u,
          stage: 'preflop',
          gameVariant: variant,
          bigBlind: bb,
          smallBlind: bb / 2,
          dealerSeat: 1,
          actionHistory: [
            {
              stage: 'preflop',
              seat: 1,
              userId: 'human',
              action: 'raise',
              amount: 7 * u,
              isFullRaise: true,
            },
          ],
        }
      : {
          players: [
            hero,
            { seat: 2, user_id: 'human', stack: 48 * u, bet: 2 * u, is_folded: false, cards: [] },
            { seat: 3, user_id: 'other', stack: 50 * u, bet: 0, is_folded: false, cards: [] },
          ],
          communityCards: [],
          pot: 3 * u,
          currentBet: 2 * u,
          minRaise: 2 * u,
          stage: 'preflop',
          gameVariant: variant,
          bigBlind: bb,
          smallBlind: bb / 2,
          dealerSeat: 1,
          actionHistory: [],
        };
    const d = HorseLogic.decide(hero, gs as never, 'balanced');
    t[d.action] = (t[d.action] || 0) + 1;
  }
  return {
    raise: ((t.raise ?? 0) + (t.all_in ?? 0)) / 240,
    call: (t.call ?? 0) / 240,
    fold: (t.fold ?? 0) / 240,
  };
}

describe("every live variant is scored on the hold'em scale", () => {
  const nlh = strengthDistribution('nlh', 2);

  for (const [variant, holes] of LIVE_VARIANTS) {
    it(`${variant}: strength distribution matches hold'em's shape`, () => {
      const d = strengthDistribution(variant, holes);
      // The median is the tell. Before the fix: plo4 0.240 against bars built
      // for a range topping out at 1.0; short_deck 0.420; pineapple 0.493.
      expect(d.median, `${variant} median ${d.median} vs nlh ${nlh.median}`).toBeGreaterThan(
        nlh.median - 0.1
      );
      expect(d.median, `${variant} median ${d.median} vs nlh ${nlh.median}`).toBeLessThan(
        nlh.median + 0.1
      );
      // The top of the range must actually REACH the high bars, or no raise
      // threshold is attainable — this is precisely what broke PLO.
      expect(d.max, `${variant} max ${d.max}`).toBeGreaterThan(0.9);
    });
  }
});

describe("every live variant plays in the same league as hold'em", () => {
  const nlhOpen = actionMix('nlh', 2, false);
  const nlhFacing = actionMix('nlh', 2, true);

  for (const [variant, holes] of LIVE_VARIANTS) {
    it(`${variant}: opens a comparable range`, () => {
      const m = actionMix(variant, holes, false);
      // Before the fix: plo4 opened 4% and pineapple 51% against nlh's 22%.
      expect(m.raise, `${variant} opens ${(m.raise * 100).toFixed(0)}%`).toBeGreaterThan(
        nlhOpen.raise * 0.5
      );
      expect(m.raise, `${variant} opens ${(m.raise * 100).toFixed(0)}%`).toBeLessThan(
        nlhOpen.raise * 1.8
      );
    });

    it(`${variant}: neither refuses to 3-bet nor refuses to fold`, () => {
      const m = actionMix(variant, holes, true);
      // Before: plo4 raised 0% (the stuck valve Dan reported) and pineapple
      // folded 15% against nlh's 48%.
      expect(m.raise, `${variant} 3-bets ${(m.raise * 100).toFixed(0)}%`).toBeGreaterThan(0.03);
      expect(m.fold, `${variant} folds ${(m.fold * 100).toFixed(0)}%`).toBeGreaterThan(
        nlhFacing.fold * 0.5
      );
      expect(m.fold, `${variant} folds ${(m.fold * 100).toFixed(0)}%`).toBeLessThan(
        Math.min(0.95, nlhFacing.fold * 1.8)
      );
    });
  }
});

/**
 * STAKES. The scoring functions do not read the blind level, but the sizing
 * path does — chipStep() snaps to whole chips in cash games, and a micro
 * blind makes every legal raise land on a coarse grid. If that grid ever
 * swallowed the raise, the fleet would look "stuck" at one stake and fine at
 * another, which is the hardest kind of report to act on.
 */
describe('behaviour does not change with the stake', () => {
  const STAKES = [0.1, 0.5, 2, 100, 10000];
  for (const [variant, holes] of LIVE_VARIANTS) {
    it(`${variant}: opening frequency is stable from micro to high`, () => {
      const rates = STAKES.map((bb) => actionMix(variant, holes, false, bb).raise);
      const lo = Math.min(...rates);
      const hi = Math.max(...rates);
      expect(
        hi - lo,
        `${variant} open rates across stakes: ${rates.map((r) => (r * 100).toFixed(0) + '%').join(', ')}`
      ).toBeLessThan(0.15);
    });

    it(`${variant}: every decision stays legal at every stake`, () => {
      for (const bb of STAKES) {
        const m = actionMix(variant, holes, true, bb);
        const total = m.raise + m.call + m.fold;
        // A decision that fell through to an illegal action would show up as
        // mass going missing from these three buckets.
        expect(total, `${variant} @ bb=${bb} accounted ${total}`).toBeGreaterThan(0.98);
      }
    });
  }
});
