/**
 * WIN-P8 (2026-10-08): Phase 8 decides whether to leave the baseline by the
 * paired difference of the two actions' utilities on the same outcome
 * samples, future-hand draws and ICM trials. Before this, it compared two
 * separate 99.9% intervals; on the production engine host the continuation
 * preferred another action on 3,053 of 3,663 fired decisions and kept the
 * baseline on every one of them, so its utility never chose an action.
 */
import { describe, expect, it } from 'vitest';
import {
  continuationSeparatesFromBaseline,
  type PairedContinuationSide,
} from './HorseTournamentUtility.js';

const side = (
  action: PairedContinuationSide['ledger']['action'],
  sampleUtility: number[],
  estimateError = 0
): PairedContinuationSide => ({ ledger: { action }, sampleUtility, estimateError });
const uniform = (n: number) => ({
  weights: Array.from({ length: n }, () => 1 / n),
  effectiveSamples: n,
});
// Large swings shared by both actions (the same board, the same rollout).
const shared = Array.from({ length: 16 }, (_, i) => (i % 2 ? 40 : -40) + i * 3);

describe('Phase 8 paired continuation change test', () => {
  it('separates a consistent per-sample gain hidden inside large shared variation', () => {
    const kept = side('bet', shared);
    const chosen = side(
      'check',
      shared.map((u) => u + 1)
    );
    expect(
      continuationSeparatesFromBaseline({ equityStandardError: 0 }, chosen, kept, uniform(16), 1)
    ).toBe(true);
  });

  it('keeps the baseline when the paired difference is noise', () => {
    const kept = side('bet', shared);
    const chosen = side(
      'check',
      shared.map((u, i) => u + (i % 2 ? 6 : -5))
    );
    expect(
      continuationSeparatesFromBaseline({ equityStandardError: 0 }, chosen, kept, uniform(16), 1)
    ).toBe(false);
  });

  it('charges both sides’ estimate error in full', () => {
    const kept = side('bet', shared, 0.6);
    const chosen = side(
      'check',
      shared.map((u) => u + 1),
      0.6
    );
    expect(
      continuationSeparatesFromBaseline({ equityStandardError: 0 }, chosen, kept, uniform(16), 1)
    ).toBe(false);
    const clear = side(
      'check',
      shared.map((u) => u + 1.5),
      0.6
    );
    expect(
      continuationSeparatesFromBaseline({ equityStandardError: 0 }, clear, kept, uniform(16), 1)
    ).toBe(true);
  });

  it('charges the equity sampling error only when exactly one side folds', () => {
    const kept = side('call', shared);
    const fold = side(
      'fold',
      shared.map((u) => u + 2)
    );
    const raise = side(
      'raise',
      shared.map((u) => u + 2)
    );
    // 0.01 equity standard error is 1 pool point at payout weight 1; 3.291 > 2.
    expect(
      continuationSeparatesFromBaseline({ equityStandardError: 0.01 }, fold, kept, uniform(16), 1)
    ).toBe(false);
    expect(
      continuationSeparatesFromBaseline({ equityStandardError: 0.01 }, raise, kept, uniform(16), 1)
    ).toBe(true);
  });

  it('uses the calibrated weights and ignores zero-weight samples', () => {
    const weights = Array.from({ length: 16 }, (_, i) => (i < 8 ? 1 / 8 : 0));
    const kept = side('bet', shared);
    // Only the zero-weight half disagrees; the weighted half gains exactly 1.
    const chosen = side(
      'check',
      shared.map((u, i) => (i < 8 ? u + 1 : u - 500))
    );
    expect(
      continuationSeparatesFromBaseline(
        { equityStandardError: 0 },
        chosen,
        kept,
        { weights, effectiveSamples: 8 },
        1
      )
    ).toBe(true);
  });

  it('never separates on a non-finite difference', () => {
    const kept = side('bet', shared);
    const chosen = side(
      'check',
      shared.map((u, i) => (i === 3 ? Number.NaN : u + 1))
    );
    expect(
      continuationSeparatesFromBaseline({ equityStandardError: 0 }, chosen, kept, uniform(16), 1)
    ).toBe(false);
  });
});
