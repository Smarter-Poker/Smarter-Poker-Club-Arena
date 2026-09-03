/**
 * A THREE-HANDED HYPER NEVER TAKES THE :55 BREAK (2026-08-27).
 *
 * `tournaments.synchronized_breaks` defaults to TRUE and no Spin writer has
 * ever set it otherwise: all 28,788 Spin rows on the platform carried TRUE, and
 * 68 of them were stamped with `break_started_at` inside the :55 window across
 * 2026-08-27/28 — several stopped before finishing level 1 on a format whose
 * levels are three minutes.
 *
 * The rule now lives in one place and the FORMAT wins over the column, so a
 * writer that leaves the default alone cannot break a Spin.
 */
import { describe, it, expect } from 'vitest';
import { isShortFormat, mayTakeSynchronizedBreak } from './breakEligibility.js';

describe('the format is read from either column', () => {
  it('recognizes a Spin by tournament_type or by variant', () => {
    expect(isShortFormat('SPIN', null)).toBe(true);
    expect(isShortFormat(null, 'spin')).toBe(true);
    expect(isShortFormat('spin', undefined)).toBe(true); // case-insensitive
    expect(isShortFormat(undefined, 'SPIN')).toBe(true);
  });

  it('recognizes an SNG the same way', () => {
    expect(isShortFormat('SNG', null)).toBe(true);
    expect(isShortFormat(null, 'sng')).toBe(true);
  });

  it('leaves MTT and XMTT alone', () => {
    expect(isShortFormat('MTT', 'nlh')).toBe(false);
    expect(isShortFormat('XMTT', null)).toBe(false);
    expect(isShortFormat(null, null)).toBe(false);
  });
});

describe('a Spin never breaks, whatever the row says', () => {
  it('refuses even with synchronized_breaks explicitly true', () => {
    // This is the exact shape of all 28,788 Spin rows on the platform.
    expect(
      mayTakeSynchronizedBreak({
        tournament_type: 'SPIN',
        variant: 'spin',
        synchronized_breaks: true,
      })
    ).toBe(false);
  });

  it('refuses an SNG on the same grounds', () => {
    expect(mayTakeSynchronizedBreak({ tournament_type: 'SNG', synchronized_breaks: true })).toBe(
      false
    );
  });
});

describe('an MTT still decides for itself', () => {
  it('breaks by default', () => {
    expect(mayTakeSynchronizedBreak({ tournament_type: 'MTT' })).toBe(true);
    expect(mayTakeSynchronizedBreak({ tournament_type: 'MTT', synchronized_breaks: true })).toBe(
      true
    );
  });

  it('honors an explicit opt-out (2026-08-22 parity)', () => {
    expect(mayTakeSynchronizedBreak({ tournament_type: 'MTT', synchronized_breaks: false })).toBe(
      false
    );
  });

  it('a null column is not an opt-out', () => {
    expect(mayTakeSynchronizedBreak({ tournament_type: 'MTT', synchronized_breaks: null })).toBe(
      true
    );
  });
});

describe('an unreadable row is treated as an ordinary MTT', () => {
  it('because a missed break costs synchrony, and a wrong break costs the game', () => {
    expect(mayTakeSynchronizedBreak(null)).toBe(true);
    expect(mayTakeSynchronizedBreak(undefined)).toBe(true);
    expect(mayTakeSynchronizedBreak({})).toBe(true);
  });
});
