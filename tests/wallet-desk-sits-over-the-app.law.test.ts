import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/*
 * THE WALLET DESK SITS OVER THE WHOLE APP (2026-10-17).
 *
 * Shipped in #7169, the union desk opened UNDER the lobby's fixed bottom nav
 * and the global header: `.wdesk` said z-index 1300, but it was rendered
 * inside the lobby's stacking context, so the nav (1000) and header (390) on
 * the page painted over it and the dock's Pull Back / Ledger / Send Out could
 * not be tapped on a phone. The render harness had no nav, so nothing caught
 * it. This law pins the three things that make it impossible again.
 */
const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const zOf = (css: string, selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  const rule = css.slice(start, css.indexOf('}', start));
  const m = /z-index:\s*(\d+)/.exec(rule);
  expect(m, `${selector} has a z-index`).not.toBeNull();
  return Number(m![1]);
};

describe('the wallet desk sits over the whole app', () => {
  it('portals both desks to <body>, out of any host page stacking context', () => {
    for (const file of [
      'src/components/union/UnionWalletModal.tsx',
      'src/components/wallet/DiamondWalletModal.tsx',
    ]) {
      const src = read(file);
      expect(src, file).toContain("import { createPortal } from 'react-dom';");
      expect(src, file).toMatch(/return createPortal\(/);
      expect(src, file).toMatch(/,\s*document\.body\s*\);\s*\}/);
    }
  });

  it('layers the desk above the header, bottom nav, ticker and menu, below toasts', () => {
    const desk = zOf(read('src/components/wallet/WalletDesk.css'), '.wdesk');
    const header = zOf(read('src/components/navigation/GlobalHeader.module.css'), '.header');
    const nav = zOf(read('src/components/club/ClubBottomNav.module.css'), '.bottomNav');
    const menu = read('src/components/navigation/HamburgerMenu.module.css');
    const menuTop = Math.max(...[...menu.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1])));
    const toast = Number(/z-index:\s*(\d+)/.exec(read('src/components/common/Toast.css'))![1]);
    expect(desk).toBeGreaterThan(header);
    expect(desk).toBeGreaterThan(nav);
    expect(desk).toBeGreaterThan(menuTop);
    expect(desk).toBeLessThan(toast);
  });

  it('makes the covered desk inert while a sheet is over it', () => {
    const desk = read('src/components/wallet/WalletDesk.tsx');
    expect(desk).toMatch(/className="wdesk__scroll"[^>]*inert=\{covered\}/);
    expect(desk).toMatch(/className="wdesk__dock"[^>]*inert=\{covered\}/);
    expect(desk).toContain('const covered = Boolean(sheet);');
  });

  it('pages the Diamond history on a unique order instead of stopping at 50', () => {
    const src = read('src/components/wallet/DiamondWalletModal.tsx');
    // A tuple cursor keeps the unique order stable when newer receipts arrive.
    expect(src).toMatch(
      /\.order\('created_at', \{ ascending: false \}\)\s*\.order\('id', \{ ascending: false \}\)/
    );
    expect(src).toContain(
      'created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})'
    );
    expect(src).toContain('query.limit(TX_LIMIT)');
    expect(src).toContain('cursor.owner !== user.id');
    expect(src).toContain('Load Older Diamonds');
    expect(src).toContain('Could Not Load Older Diamonds.');
    expect(src).not.toMatch(/\.range\(/);
  });
});
