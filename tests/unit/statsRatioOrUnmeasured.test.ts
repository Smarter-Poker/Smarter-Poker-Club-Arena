/**
 * A RATE OVER AN EMPTY SAMPLE IS NOT A ZERO (Stats contract truth, 2026-09-20).
 *
 * ca_player_stats_overview_v2 writes 0 for every rate whose denominator was
 * empty (`CASE WHEN cash_hands > 0 THEN ... ELSE 0 END`), and the Stats page
 * printed those zeros as results: "0.00" BB/100 for a player with no cash
 * hands, "0.0%" showdown wins for a player who never reached one.
 * `ratioOrUnmeasured` is the one place that tells the two apart. These pin
 * its contract; the tab and hero render tests pin that it is actually used.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  NOT_YET_MEASURED,
  SCOPE_ALL_GAMES,
  SCOPE_CASH,
  ratioOrUnmeasured,
} from '../../src/pages/stats/format';
import { formatPopupText } from '../../src/utils/popupStyle';

const twoDp = (v: number) => v.toFixed(2);

describe('ratioOrUnmeasured', () => {
  it('says Not Yet Measured when the sample is empty, without calling the formatter', () => {
    const format = vi.fn(twoDp);
    expect(ratioOrUnmeasured(0, 0, format)).toBe(NOT_YET_MEASURED);
    expect(format).not.toHaveBeenCalled();
  });

  it('treats a negative or non-finite sample as empty rather than printing a number', () => {
    expect(ratioOrUnmeasured(12.5, -1, twoDp)).toBe(NOT_YET_MEASURED);
    expect(ratioOrUnmeasured(12.5, Number.NaN, twoDp)).toBe(NOT_YET_MEASURED);
    expect(ratioOrUnmeasured(12.5, Number.POSITIVE_INFINITY, twoDp)).toBe(NOT_YET_MEASURED);
  });

  it('refuses a non-finite ratio even over a real sample (0 / 0 computed eagerly)', () => {
    expect(ratioOrUnmeasured(Number.NaN, 40, twoDp)).toBe(NOT_YET_MEASURED);
    expect(ratioOrUnmeasured(Number.POSITIVE_INFINITY, 40, twoDp)).toBe(NOT_YET_MEASURED);
  });

  it('prints a real zero when the sample is real: zero over 400 hands IS a measurement', () => {
    expect(ratioOrUnmeasured(0, 400, twoDp)).toBe('0.00');
  });

  it('formats a measured ratio, negative results included', () => {
    expect(ratioOrUnmeasured(-22.5, 18_000, twoDp)).toBe('-22.50');
    expect(ratioOrUnmeasured(35.8, 1_200, (v) => `${v.toFixed(1)}%`)).toBe('35.8%');
  });
});

describe('the words the page prints', () => {
  it('Not Yet Measured is Title Case, plain ASCII, and carries no dash or glyph', () => {
    for (const phrase of [NOT_YET_MEASURED, SCOPE_CASH, SCOPE_ALL_GAMES]) {
      expect(phrase).toBe(formatPopupText(phrase));
      expect(phrase).toMatch(/^[A-Z][a-z]*( [A-Z][a-z]*)*$/);
      expect(phrase).toMatch(/^[\x20-\x7e]+$/);
      expect(phrase).not.toMatch(/--|[\u2013\u2014]/);
    }
    expect(NOT_YET_MEASURED).toBe('Not Yet Measured');
    expect(SCOPE_CASH).toBe('Cash');
    expect(SCOPE_ALL_GAMES).toBe('All Games');
  });
});
