import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Locator } from '@playwright/test';
import { formatWalletChips } from '../../src/utils/format';

// Exercise the maintained format assertions without starting Playwright's
// runner/transform service inside the unit runner. Browser locator checks run
// in the existing hosted Cashier certificate.
vi.mock('@playwright/test', async () => ({ expect: (await import('vitest')).expect }));
import {
  expectCashierAmountPresets as certifyPresets,
  expectCashierWalletFigure as certifyWallet,
  cashierRosterWalletValue,
} from '../e2e/support/cashierProductionCertification';

describe('production Cashier roster balance selection', () => {
  function locatorFor(elements: Element[]): Locator {
    return {
      locator: (selector: string) =>
        locatorFor(
          elements.flatMap((element) =>
            selector === '..' ? [element.parentElement!] : [...element.querySelectorAll(selector)]
          )
        ),
      first: () => locatorFor(elements.slice(0, 1)),
      textContent: async () => {
        expect(elements).toHaveLength(1);
        return elements[0].textContent;
      },
    } as unknown as Locator;
  }

  it.each(['1,234.56', 'Unavailable'])(
    'reads the player value beside its label, preserving validation for %s',
    async (figure) => {
      const roster = document.createElement('div');
      roster.innerHTML = `<span><span>Agent Wallet</span><strong>99.00</strong></span><span><span>Player Wallet</span><strong>${figure}</strong></span>`;
      const label = [...roster.querySelectorAll('span')].find(
        (element) => element.textContent === 'Player Wallet'
      )!;
      const selected = await cashierRosterWalletValue(locatorFor([label])).textContent();
      expect(selected).toBe(figure);
      if (figure === 'Unavailable')
        expect(() => certifyWallet(selected!, 'Player Wallet')).toThrow();
      else expect(() => certifyWallet(selected!, 'Player Wallet')).not.toThrow();
    }
  );

  it('uses the maintained locator in the production certificate', () => {
    const source = readFileSync(resolve(__dirname, '../e2e/production-cashier.spec.ts'), 'utf8');
    expect(source).toContain('cashierRosterWalletValue(rosterWalletLabels.nth(index))');
  });
});

describe('production Cashier wallet certificate', () => {
  it.each([
    '0.00',
    '12.50',
    '1,234.56',
    '999,999.99',
    '1,000,000.00',
    '-1,234.50',
    '1,000,000.01',
    '1,250,000.00',
    '5,533,125.65',
    '79,345,678.12',
    '1,000,000,000.00',
    '-1,250,000.50',
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
    '1M',
    '1.2M',
    '999.9M',
    '1B',
    '12.5B',
    '+12.50',
    '-',
    'Unavailable',
    'No Agent Float Yet',
    '',
  ])('rejects the malformed or unverified chip wallet figure %s', (value) =>
    expect(() => certifyWallet(value, 'Wallet')).toThrow()
  );
  it.each([
    [1_000_000.01, '1,000,000.01'],
    [5_533_125.65, '5,533,125.65'],
    [79_345_678.12, '79,345,678.12'],
    [1_000_000_000, '1,000,000,000.00'],
    [-1_250_000.5, '-1,250,000.50'],
  ])('agrees with the exact wallet formatter for %s', (amount, expected) => {
    expect(formatWalletChips(Number(amount))).toBe(expected);
    expect(() => certifyWallet(String(expected), 'Wallet')).not.toThrow();
  });

  it('checks Downline Holdings as an exact wallet balance', () => {
    const source = readFileSync(resolve(__dirname, '../e2e/production-cashier.spec.ts'), 'utf8');
    expect(source).toContain(
      "await expectCashierWalletBalance(aggregates.nth(1), 'Downline Holdings')"
    );
  });

  it('refuses a syntactically grouped amount that is not finite', () => {
    const overflow = `${'999,'.repeat(110)}999.00`;
    expect(() => certifyWallet(overflow, 'Wallet')).toThrow();
  });

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
