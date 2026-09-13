import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

const CASHIER_SURFACES = [
  'src/pages/CashierTradePage.tsx',
  'src/pages/CashierPage.tsx',
  'src/components/wallet/WalletCashierModal.tsx',
  'src/components/wallet/PlayerWalletModal.tsx',
  'src/components/wallet/CashoutRequestModal.tsx',
  'src/components/wallet/ChipMintModal.tsx',
  'src/components/table/CashierModal.tsx',
  'src/components/union/UnionWalletModal.tsx',
];

describe('#ClubArenaConsole is the Cashier visual authority', () => {
  it.each(CASHIER_SURFACES)('%s renders the approved Cashier console', (path) => {
    const source = read(path);
    expect(source).toContain('CashierConsoleSurface');
    expect(source).toContain('<CashierConsoleSurface');
  });

  it('uses the approved painted master instead of a CSS-built substitute', () => {
    const source = read('src/components/cashier/CashierConsoleSurface.tsx');
    const style = read('src/components/cashier/CashierConsoleSurface.css');

    expect(source).toContain('<SpadeConsole');
    expect(source).not.toMatch(/<img|<svg|borderRadius|linear-gradient|radial-gradient/);
    expect(style).not.toMatch(/border-radius|linear-gradient|radial-gradient/);
    expect(style).toContain('.cashier-console__glass');
    expect(style).not.toMatch(/background(?:-image)?:/);
  });

  it('removes the retired vault picture and flat close glyphs from Cashier surfaces', () => {
    const source = CASHIER_SURFACES.map(read).join('\n');
    expect(source).not.toContain('cashier-vault-hero');
    expect(source).not.toContain('&times;');
    expect(source).not.toContain('>×<');
  });

  it('keeps both routed Cashier pages behind the console authority', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('path="clubs/:clubId/cashier"');
    expect(app).toContain('path="clubs/:clubId/cashier-classic"');
    expect(read('src/pages/CashierTradePage.tsx')).toContain('title="Cashier"');
    expect(read('src/pages/CashierPage.tsx')).toContain('title="Cashier"');
  });

  it('puts every Trade Cashier dialog on the painted authority', () => {
    const trade = read('src/pages/CashierTradePage.tsx');
    expect(trade.match(/<CashierConsoleSurface/g)).toHaveLength(5);
    for (const title of ['Transaction Receipt', 'Request Chips', 'Send Out', 'Claim Back']) {
      expect(trade).toContain(title);
    }
  });

  it('does not replace the master rails while flattening legacy content', () => {
    const tradeCss = read('src/pages/CashierTradePage.module.css');
    const classicCss = read('src/pages/CashierPage.module.css');
    expect(tradeCss).toContain(':not(:global(.sc__head))');
    expect(tradeCss).toContain(':global(.sc__body)');
    expect(classicCss).toContain(':global(.sc__foot)');
  });

  it('recognises the shared Cashier chassis in the console inventory', () => {
    const scanner = read('.claude/skills/club-arena-console/scripts/find-generic-surfaces.mjs');
    expect(scanner).toContain('CashierConsoleSurface');
  });
});
