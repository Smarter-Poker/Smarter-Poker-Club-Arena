import { describe, expect, it, vi } from 'vitest';

// Exercise the maintained format assertions without starting Playwright's
// runner/transform service inside the unit runner. Browser locator checks run
// in the existing hosted Cashier certificate.
vi.mock('@playwright/test', async () => ({ expect: (await import('vitest')).expect }));
import {
  expectCashierAmountPresets as certifyPresets,
  expectCashierWalletFigure as certifyWallet,
} from '../e2e/support/cashierProductionCertification';

describe('production Cashier wallet certificate', () => {
  it.each([
    '0.00',
    '12.50',
    '1,234.56',
    '999,999.99',
    '1,000,000.00',
    '-1,234.50',
    '1M',
    '1.2M',
    '999.9M',
    '1B',
    '12.5B',
  ])('accepts the approved chip wallet figure %s', (value) =>
    expect(() => certifyWallet(value, 'Wallet')).not.toThrow()
  );

  it.each([
    '0',
    '12',
    '12.5',
    '12.345',
    '0.30000000000000004',
    '1234.56',
    '12,34.56',
    '1,23,456.78',
    '01.00',
    '1K',
    '1.2K',
    '1.0M',
    '0.9M',
    '1,000,000.01',
    '+12.50',
    '-',
    'Unavailable',
    'No Agent Float Yet',
    '',
  ])('rejects the malformed or unverified chip wallet figure %s', (value) =>
    expect(() => certifyWallet(value, 'Wallet')).toThrow()
  );
  it('permits only the documented absent Agent Float state when explicitly requested', () => {
    const options = { allowAbsentAgentFloat: true };
    expect(() =>
      certifyWallet('No Agent Float Yet', 'Agent Wallet', 'chips', options)
    ).not.toThrow();
    for (const value of ['Unavailable', '-', '...', '12.5']) {
      expect(() => certifyWallet(value, 'Agent Wallet', 'chips', options)).toThrow();
    }
  });

  it.each(['0', '12', '1,234', '999,999', '1M', '1.2M', '1B'])(
    'preserves whole Diamond wallet counts: %s',
    (value) => expect(() => certifyWallet(value, 'Diamonds', 'diamonds')).not.toThrow()
  );

  it.each(['0.00', '12.50', '1234', '12,34', '1K', '1,000,000', '-'])(
    'rejects a malformed or fractional Diamond count: %s',
    (value) => expect(() => certifyWallet(value, 'Diamonds', 'diamonds')).toThrow()
  );
});

describe('production Cashier amount presets', () => {
  it.each(['Max', 'MAX', 'max', '  MAX  '])(
    'distinguishes the rendered %s action from compact numeric presets',
    (action) => {
      expect(() => certifyPresets(['100', '1K', '12.5K', action])).not.toThrow();
    }
  );

  it.each([
    { labels: [] },
    { labels: ['MAX'] },
    { labels: ['100', '1K'] },
    { labels: ['100', 'Max', 'MAX'] },
  ])('refuses a missing amount or missing/duplicate MAX action: $labels', ({ labels }) => {
    expect(() => certifyPresets(labels)).toThrow();
  });

  it.each(['100.00', '1,00', '1.23K', 'Unavailable', 'MAX 100', ''])(
    'still refuses each malformed numeric preset: %s',
    (amount) => {
      expect(() => certifyPresets(['MAX', '100', amount])).toThrow();
    }
  );
});
