/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MULTIWAY VALUE BARS — the scale bug on the opponent-count axis
 * (Dan 2026-08-30: "verify everything is working ... for ALL GAMES AND
 * SCENARIOS")
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every sweep before this one was HEADS-UP. Multiway postflop was the least
 * verified path in the engine, and it was broken.
 *
 * decidePostflop's VALUE-BET bars are absolute equity numbers calibrated on
 * the heads-up equity distribution (`equity >= 0.8 + mw` and friends). But
 * `equity` is computed against min(oppCount, 4) opponents, and that
 * distribution collapses as opponents are added. Measured over 250 random
 * NLH flops per row:
 *
 *     opps  median   %>=0.80   mw     effective bar   % clearing it
 *      1     0.473      9%     0.00       0.80             9%
 *      2     0.280      2%     0.03       0.83             2%
 *      4     0.154      0%     0.09       0.89             0%
 *
 * The bar meant "top ~9% of hands" heads-up and "nothing at all" four ways,
 * and `mw` pushed it UP on a distribution that had already collapsed DOWN.
 *
 * Live consequence, measured through the real decide(), c-bet frequency
 * with the betting lead:
 *
 *     variant      1opp   2opp   4opp        4opp AFTER
 *     nlh           71%    24%     2%   ->      18%
 *     plo4          71%    24%     2%   ->      14%
 *     plo6          72%    26%     3%   ->      12%
 *     short_deck    70%    24%     1%   ->       9%
 *     pineapple     79%    24%     4%   ->      19%
 *
 * A fleet that never bets multiway is exploitable and visibly robotic — the
 * same shape of defect as the PLO preflop report, in a place nobody had
 * looked.
 *
 * THE CONTRACT: a value bar is a PERCENTILE of hand strength, so it is
 * translated to the equity that sits at that percentile for the actual
 * opponent count. `mw` then supplies the intended extra multiway tightening
 * on top of a scale-neutral bar. The CALLING side still compares raw equity
 * to pot odds — a probability against a probability — and must never be
 * normalised, or every call is mispriced.
 */
import { describe, it, expect } from 'vitest';
import { multiwayValueBar } from './HorseEval.js';

describe('multiwayValueBar', () => {
  it('leaves heads-up play EXACTLY as it was', () => {
    for (const bar of [0.52, 0.62, 0.8]) {
      expect(multiwayValueBar(bar, 1)).toBe(bar);
    }
  });

  it('lowers the bar as opponents are added, because the equity scale collapses', () => {
    const hu = 0.8;
    const b2 = multiwayValueBar(hu, 2);
    const b3 = multiwayValueBar(hu, 3);
    const b4 = multiwayValueBar(hu, 4);
    expect(b2).toBeLessThan(hu);
    expect(b3).toBeLessThan(b2);
    expect(b4).toBeLessThan(b3);
    // It must not collapse to nothing either — four-handed a "monster" is
    // still a strong hand, just on a scale whose median is 0.154.
    expect(b4).toBeGreaterThan(0.25);
  });

  it('is monotonic in the bar itself at every opponent count', () => {
    for (const n of [1, 2, 3, 4]) {
      expect(multiwayValueBar(0.52, n)).toBeLessThan(multiwayValueBar(0.62, n));
      expect(multiwayValueBar(0.62, n)).toBeLessThan(multiwayValueBar(0.8, n));
    }
  });

  it('clamps beyond four opponents rather than extrapolating off the table', () => {
    expect(multiwayValueBar(0.8, 9)).toBe(multiwayValueBar(0.8, 4));
    expect(multiwayValueBar(0.8, 0)).toBe(multiwayValueBar(0.8, 1));
  });

  it('preserves the percentile it was calibrated to mean', () => {
    // 0.8 sits near the 91st percentile heads-up. Whatever the bar becomes
    // for 4 opponents, it must sit near the same percentile of THAT
    // distribution — which is what makes "top ~9% of hands" survive the
    // change in opponent count.
    const b4 = multiwayValueBar(0.8, 4);
    // From the measured 4-opponent deciles, the 90th percentile is 0.422
    // and the 100th is 0.897; 0.8's HU percentile lands between them.
    expect(b4).toBeGreaterThan(0.42);
    expect(b4).toBeLessThan(0.9);
  });
});
