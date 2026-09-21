import { describe, it, expect } from 'vitest';
import {
  cashAccountingBatchSize,
  BATCH_BUDGET_FRACTION,
  PER_ITEM_MS,
  MIN_BATCH,
  MAX_BATCH,
} from './cashAccountingBatchBudget.js';

describe('the cash accounting batch is derived from the budget that binds', () => {
  it('fits inside the client budget at the measured per-item cost', () => {
    // The incident: 150 x 290ms = 43.5s against a 15s client timeout.
    const n = cashAccountingBatchSize(15_000);
    expect(n * PER_ITEM_MS).toBeLessThan(15_000);
    expect(n).toBeLessThan(150);
    expect(n).toBeGreaterThan(1);
  });

  it('leaves headroom rather than filling the whole budget', () => {
    const n = cashAccountingBatchSize(15_000);
    expect(n * PER_ITEM_MS).toBeLessThanOrEqual(15_000 * BATCH_BUDGET_FRACTION);
  });

  it('grows when the client is given a longer budget', () => {
    expect(cashAccountingBatchSize(50_000)).toBeGreaterThan(cashAccountingBatchSize(15_000));
  });

  it('shrinks when an item gets more expensive', () => {
    // Exactly what migration 20260917181100 did to this path.
    expect(cashAccountingBatchSize(15_000, 900)).toBeLessThan(cashAccountingBatchSize(15_000, 290));
  });

  it('reads an unreadable budget as the SMALLEST batch, never the largest', () => {
    // CLAUDE.md 10.86 rule 1: "I could not tell" must not be coerced into good news.
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(cashAccountingBatchSize(bad)).toBe(MIN_BATCH);
      expect(cashAccountingBatchSize(15_000, bad)).toBe(MIN_BATCH);
    }
  });

  it('never returns less than one item or more than the ceiling', () => {
    expect(cashAccountingBatchSize(1)).toBe(MIN_BATCH);
    expect(cashAccountingBatchSize(10_000_000)).toBe(MAX_BATCH);
  });
});
