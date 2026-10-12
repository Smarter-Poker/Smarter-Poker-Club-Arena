import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { outcomeNeedsReceiptCheck } from '../src/components/wallet/CashoutReceiptChecks';
import { CashoutOutcomeUnknownError, CashoutRefusedError } from '../src/services/CashoutService';

/**
 * Cashier screens, residual launch fixes (2026-10-11), each pinned where it
 * lives. Every case fails against main as it stood before the fix.
 */
const read = (path: string) => readFileSync(path, 'utf8');
const context = {
  kind: 'cashout_approve',
  clubId: '11111111-1111-4111-8111-111111111111',
  actorId: '22222222-2222-4222-8222-222222222222',
  generation: 1,
  opId: '33333333-3333-4333-8333-333333333333',
  dispatched: true,
} as never;

describe('a definitive cashout refusal is not also an unconfirmed outcome (B-3/B-4)', () => {
  it('keeps the receipt check for a lost answer and drops it for a refusal', () => {
    expect(
      outcomeNeedsReceiptCheck(new CashoutRefusedError('Not Enough Chips', '23514', null, context))
    ).toBe(false);
    expect(outcomeNeedsReceiptCheck(new CashoutOutcomeUnknownError('Lost', context))).toBe(true);
    expect(outcomeNeedsReceiptCheck(new TypeError('Failed to fetch'))).toBe(true);
  });

  it.each([
    'src/components/agent/AgentCashoutPanel.tsx',
    'src/components/wallet/CashoutRequestModal.tsx',
    'src/pages/AgentDashboardPage.tsx',
  ])('%s retains a receipt check only when the outcome needs one', (file) => {
    const source = read(file);
    const retain = source.indexOf('receiptChecks.retain(');
    expect(retain).toBeGreaterThan(-1);
    const guard = source.slice(Math.max(0, retain - 200), retain);
    expect(guard).toContain('outcomeNeedsReceiptCheck(err)');
  });
});

describe('the in-table top-up sheet can re-read an unread balance (B-1)', () => {
  it('passes the balance retry to CashierModal as it does to the buy-in sheet', () => {
    const layer = read('src/components/table/TableModalsLayer.tsx');
    const sheet = layer.slice(layer.indexOf('<CashierModal'), layer.indexOf('<BuyInModal'));
    expect(sheet).toContain('onRetryBalance={onRetryAccountBalance}');
  });
});

describe('/wallet shows every tab at phone width (B-3)', () => {
  it('shares the strip equally under 640px instead of overflowing a hidden scroller', () => {
    const css = read('src/pages/PlayerWalletPage.css');
    const phone = css.slice(css.indexOf('@media (max-width: 640px)'));
    const rule = phone.slice(phone.indexOf('.wallet-tabs button {'));
    expect(rule.slice(0, rule.indexOf('}'))).toMatch(/flex: 1 1 0;[\s\S]*min-width: 0;/);
  });
});

describe('44px across on the cashier controls measured narrower at 393 (B-3)', () => {
  it.each([
    ['src/components/union/UnionWalletModal.css', '.uwm-tab {', 'min-width: 44px;'],
    ['src/components/union/UnionWalletModal.css', '.uwm-kind {', 'min-width: 44px;'],
    ['src/components/union/UnionWalletModal.css', '.uwm-input.uwm-input {', 'min-height: 44px;'],
    ['src/components/wallet/CashoutRequestModal.css', '.cro-preset {', 'min-width: 44px;'],
    ['src/pages/HomePage.module.css', '.cashierSwitchStatus button {', 'min-width: 44px;'],
  ])('%s %s carries %s', (file, selector, declaration) => {
    const css = read(file);
    const start = css.indexOf(selector);
    expect(start).toBeGreaterThan(-1);
    expect(css.slice(start, css.indexOf('}', start))).toContain(declaration);
  });
});
