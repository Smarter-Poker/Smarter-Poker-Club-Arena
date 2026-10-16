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
    expect(batchVerdictFor('short', 2)).toBe('Insufficient Chips In The Funding Wallet');
  });

  it('reads a funded wallet as covering, and counts the recipients in the verdict', () => {
    expect(fundingCoverage('11', 10.2)).toBe('covers');
    expect(fundingCoverage('1.2K', 10.2)).toBe('covers');
    expect(fundingCoverage('3.2M', 10.2)).toBe('covers');
    expect(batchVerdictFor('covers', 2)).toBe('2 Recipients Ready For Server Verification');
  });

  it('names an unreadable agent wallet and refuses to guess on a straddling figure', () => {
    expect(fundingCoverage('--', 10.2)).toBe('unreadable');
    expect(batchVerdictFor('unreadable', 2)).toBe('Agent Wallet Could Not Be Verified');
    // "10" is anything in [10, 11): it may or may not cover 10.20.
    expect(fundingCoverage('10', 10.2)).toBe('unknown');
    expect(batchVerdictFor('unknown', 2)).toBeNull();
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
    const page = readFileSync(resolve(root, 'src/pages/CashierTradePage.tsx'), 'utf8');
    const row = page.slice(
      page.indexOf('function CashierWalletRow('),
      page.indexOf('function CashierWalletRow(') + 900
    );
    expect(row).toContain('aria-label={label}');
    expect(row.match(/<strong/g)?.length).toBe(1);
    expect(row).toContain("balance === null ? '-' : compactChips(balance)");
  });
});
