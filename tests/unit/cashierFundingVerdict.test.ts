import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compactChips } from '../../src/utils/format';
import {
  batchVerdictFor,
  fundingCoverage,
  printedFundingFigure,
} from '../e2e/support/cashierFundingVerdict';

describe('the production cashier canary derives the batch verdict from the printed funding wallet', () => {
  it('reads the maintained unfunded identity as short of a 10.20 batch', () => {
    expect(fundingCoverage('0', 10.2)).toBe('short');
    expect(batchVerdictFor('short')).toBe('Insufficient Chips In The Funding Wallet');
  });

  it.each([
    ['0.00', 10.2, 'short'],
    ['10.19', 10.2, 'short'],
    ['10.20', 10.2, 'covers'],
    ['10.21', 10.2, 'covers'],
    ['1,234.56', 1234.56, 'covers'],
    ['1,234.56', 1234.57, 'short'],
    ['-10.20', 0, 'short'],
  ] as const)('reads exact wallet %s against %s as %s', (figure, total, expected) => {
    expect(fundingCoverage(figure, total)).toBe(expected);
  });

  it.each(['1234.56', '12,34.56', '10.200', '0.30000000000000004', '12.5', '01.00'])(
    'refuses a malformed exact wallet figure %s',
    (figure) => expect(fundingCoverage(figure, 10.2)).toBe('unknown')
  );

  it('does not decide exact coverage against an unreadable total', () => {
    expect(fundingCoverage('10.20', Number.NaN)).toBe('unknown');
    expect(fundingCoverage('10.20', Number.POSITIVE_INFINITY)).toBe('unknown');
  });

  it('reads a funded wallet as covering without inventing a success status', () => {
    expect(fundingCoverage('11', 10.2)).toBe('covers');
    expect(fundingCoverage('1.2K', 10.2)).toBe('covers');
    expect(fundingCoverage('3.2M', 10.2)).toBe('covers');
    expect(batchVerdictFor('covers')).toBe('');
  });

  it('names an unreadable agent wallet and refuses to guess on a straddling figure', () => {
    expect(fundingCoverage('--', 10.2)).toBe('unreadable');
    expect(batchVerdictFor('unreadable')).toBe('Selected Wallet Could Not Be Verified');
    // "10" is anything in [10, 11): it may or may not cover 10.20.
    expect(fundingCoverage('10', 10.2)).toBe('unknown');
    expect(batchVerdictFor('unknown')).toBeNull();
    expect(fundingCoverage('ten', 10.2)).toBe('unknown');
  });

  it('agrees with compactChips on both sides of the boundary', () => {
    for (const held of [0, 0.5, 9.99, 11, 10.2 + 1, 999.99, 1000, 1290, 3_226_000]) {
      const coverage = fundingCoverage(compactChips(held), 10.2);
      if (coverage === 'unknown') continue;
      expect(coverage === 'covers').toBe(held >= 10.2);
    }
    expect(fundingCoverage(compactChips(9.99), 10.2)).toBe('short');
    expect(fundingCoverage(compactChips(1290), 10.2)).toBe('covers');
  });

  // Post-Deploy E2E, 2026-10-15: every run failed "the printed From Your Agent
  // Wallet figure \"\" cannot decide". The canary matched label-then-figure on
  // the dialog's innerText, but the painted label is uppercase and flush
  // against its figure, so the match found nothing. The figure is read from the
  // row's own value element, and the row's "-" for an unread wallet is an
  // unreadable wallet, not an undecidable figure.
  it('reads the figure from the painted row value, including its unread hyphen', () => {
    expect(printedFundingFigure([' 1.2K '])).toBe('1.2K');
    expect(printedFundingFigure([])).toBe('');
    expect(printedFundingFigure(['1', '2'])).toBe('');
    expect(fundingCoverage(printedFundingFigure(['-']), 10.2)).toBe('unreadable');
    expect(fundingCoverage(printedFundingFigure([compactChips(0)]), 10.2)).toBe('short');
  });

  it('keeps the canary on the row element, and the row printing one figure', () => {
    const root = resolve(__dirname, '../..');
    const spec = readFileSync(resolve(root, 'tests/e2e/production-cashier.spec.ts'), 'utf8');
    const verdictReader = spec.slice(
      spec.indexOf('async function expectBatchVerdictFromFunding'),
      spec.indexOf('async function uncheckEveryRecipient')
    );
    expect(verdictReader).toContain("getByRole('region', { name: fundingLabel, exact: true })");
    expect(verdictReader).not.toMatch(/innerText\(\)/);
    expect(verdictReader).toContain("dialog.locator('#cashier-amount-validation')");
    expect(verdictReader).toContain("toHaveAttribute('role', 'status')");
    expect(verdictReader).toContain("getByRole('button', { name: 'Confirm', exact: true })");
    const page = readFileSync(resolve(root, 'src/pages/CashierTradePage.tsx'), 'utf8');
    const row = page.slice(
      page.indexOf('function CashierWalletRow('),
      page.indexOf('function CashierWalletRow(') + 900
    );
    expect(row).toContain('aria-label={label}');
    expect(row.match(/<CashierFrameBalance/g)?.length).toBe(1);
    const balance = readFileSync(
      resolve(root, 'src/components/wallet/CashierFrameBalance.tsx'),
      'utf8'
    );
    expect(balance.match(/<strong/g)?.length).toBe(1);
    expect(row).toContain("balance === null ? '-' : formatWalletChips(balance)");
  });
});
