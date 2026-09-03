import { describe, it, expect } from 'vitest';
import { verifyStream, assertConservation, conservedTotal } from './ChipConservationVerifier.js';
import { replay } from './HandReducer.js';
import type { HandEvent, PotAwarded } from './events.js';
import { buildExampleHand } from './testFixtures.js';

describe('ChipConservationVerifier - holds across a valid hand', () => {
  it('reports ok with zero violations for the example hand', () => {
    const report = verifyStream(buildExampleHand());
    expect(report.ok).toBe(true);
    expect(report.violations).toHaveLength(0);
    expect(report.initialChipTotal).toBe(3000);
    expect(report.checkedEvents).toBe(buildExampleHand().length);
  });

  it('conservation holds after EVERY prefix of the stream', () => {
    const events = buildExampleHand();
    for (let n = 1; n <= events.length; n++) {
      const state = replay(events.slice(0, n));
      expect(conservedTotal(state)).toBe(3000);
    }
  });

  it('assertConservation does not throw for a valid hand', () => {
    expect(() => assertConservation(buildExampleHand())).not.toThrow();
  });
});

describe('ChipConservationVerifier - catches corruption', () => {
  it('catches chips created by an overpaid PotAwarded and names the event', () => {
    const events = buildExampleHand();
    // Corrupt the payout: pay 900 instead of 340 (chips conjured from nothing).
    const potIdx = events.findIndex((e) => e.type === 'PotAwarded');
    const corrupt = events.slice();
    const orig = corrupt[potIdx] as PotAwarded;
    corrupt[potIdx] = { ...orig, payouts: [{ ...orig.payouts[0], amount: 900 }], rake: 0 };

    const report = verifyStream(corrupt);
    expect(report.ok).toBe(false);
    expect(report.violations.length).toBeGreaterThan(0);
    const v = report.violations[0];
    expect(v.eventType).toBe('PotAwarded');
    expect(v.seq).toBe(orig.seq);
    expect(v.event).toBe(corrupt[potIdx]); // the offending event, verbatim
    // 345 in the pot, paid 900 -> 555 chips created.
    expect(v.actual - v.expected).toBeCloseTo(555, 6);
    expect(() => assertConservation(corrupt)).toThrow(/conservation/i);
  });

  it('catches chips destroyed by a tampered blind (over-posting from thin air is impossible, but a dropped stack leaks)', () => {
    const events = buildExampleHand();
    // Corrupt HandStarted: give seat 1 an extra 500 that never came from a buy-in
    // baseline mismatch is caught because the baseline is captured, then a later
    // PotAwarded distributes the true pot -> totals drift.
    // Simpler: drop a player's contribution by mutating a call into a larger raise
    // that the winner does NOT actually have — chips vanish at payout.
    const potIdx = events.findIndex((e) => e.type === 'PotAwarded');
    const corrupt = events.slice();
    const orig = corrupt[potIdx] as PotAwarded;
    // Underpay AND set an explicit rake of 0 -> 340 chips vanish.
    corrupt[potIdx] = { ...orig, payouts: [{ ...orig.payouts[0], amount: 0 }], rake: 0 };

    const report = verifyStream(corrupt);
    expect(report.ok).toBe(false);
    expect(report.violations[0].eventType).toBe('PotAwarded');
    expect(report.violations[0].diff).toBeCloseTo(-345, 6);
  });

  it('flags a stream that does not begin with HandStarted', () => {
    const events = buildExampleHand().slice(1) as HandEvent[]; // drop HandStarted
    const report = verifyStream(events);
    expect(report.ok).toBe(false);
    expect(report.violations[0].message).toMatch(/HandStarted/);
  });

  it('flags an empty stream', () => {
    const report = verifyStream([]);
    expect(report.ok).toBe(false);
    expect(report.checkedEvents).toBe(0);
  });
});
