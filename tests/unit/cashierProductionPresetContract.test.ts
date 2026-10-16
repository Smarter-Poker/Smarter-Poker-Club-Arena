import { describe, expect, it, vi } from 'vitest';

vi.mock('@playwright/test', async () => ({ expect: (await import('vitest')).expect }));
import {
  expectCashierAmountPresets,
  expectCompactCashierFigure,
} from '../e2e/support/cashierProductionCertification';

describe('production Cashier amount preset certificate', () => {
  it.each(['Max', 'MAX', 'max'])('validates the rendered %s command separately', (command) => {
    expect(() => expectCashierAmountPresets(['100', '500', '1K', '5K', command])).not.toThrow();
  });
  it.each([
    [],
    ['MAX'],
    ['100', '500', '1K', '5K'],
    ['100', '500', '1K', '5K', 'MAX', 'Max'],
    ['100', '500', '1K', 'MAX'],
    ['100', '500', '1K', '1K', 'MAX'],
    ['100.00', '500', '1K', '5K', 'MAX'],
    ['100', '500', '1000', '5K', 'MAX'],
    ['100', '500', '1K', '5K', 'Maximum'],
    ['100', '500', '1K', '5K', 'MAX 100'],
  ])('rejects missing, duplicate, malformed or unknown presets: %j', (...values) => {
    expect(() => expectCashierAmountPresets(values)).toThrow();
  });
  it('does not permit commands in the numeric compact oracle', () => {
    expect(() => expectCompactCashierFigure('MAX', 'Amount')).toThrow();
    expect(() => expectCompactCashierFigure('1,000.00', 'Amount')).toThrow();
  });
});
