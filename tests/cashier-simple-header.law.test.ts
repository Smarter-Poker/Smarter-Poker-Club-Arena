import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Dan 2026-10-16, on the Simple Cashier header: no "Live Ledger" pill, no
// "Simple Cashier" caption, a much larger club logo with "Choose" as a
// dropdown, no "Balances Synchronized" line, and Request Cash Out as a real
// button rather than a line of text.
const page = readFileSync('src/pages/CashierTradePage.tsx', 'utf8');
const css = readFileSync('src/pages/CashierTradePage.module.css', 'utf8');

describe('the Simple Cashier header', () => {
  it('prints no Live Ledger pill, and still says Locked when offline', () => {
    expect(page).not.toContain("'Live Ledger'");
    expect(page).toContain("pill={isOnline ? undefined : 'Locked'}");
  });

  it('carries no Simple Cashier caption or toolbar row, and keeps the Advanced switch beside the club', () => {
    expect(page).not.toContain("'Simple Cashier'");
    expect(page).toMatch(/\{advanced && \(\s*<div className=\{styles\.modeToolbar\}>/);
    expect(page).toContain('{!advanced && modeToggle}');
  });

  it('keeps a healthy sync status for assistive technology only, and shows every other state', () => {
    expect(page).toMatch(
      /cashierSyncMessage === 'Balances Synchronized' \? 'sr-only' : styles\.simpleStatus/
    );
  });

  it('leads with a large club logo and a Choose dropdown chevron', () => {
    expect(css).toMatch(/\.page \.header \.entityLogo \{\s*width: 72px;\s*height: 72px;/);
    expect(page).toContain('className={styles.entityChevron}');
    expect(page).toContain('styles.entityCaretOpen');
  });

  it('frames Request Cash Out in the same painted frame as the action dock', () => {
    expect(page).toMatch(/className=\{styles\.cashoutButton\}[\s\S]{0,120}Request Cash Out/);
    const rule = css.slice(
      css.indexOf('.cashoutButton {'),
      css.indexOf('}', css.indexOf('.cashoutButton {'))
    );
    expect(rule).toContain("url('/images/cashier-actions/cashier-action-dock-v1.png')");
    expect(rule).toContain('aspect-ratio: 1916 / 334;');
    expect(rule).toContain('width: 300px;');
  });

  it("prints the viewer's own club balance inside Request Cash Out", () => {
    expect(page).toContain('aria-describedby="cashier-cashout-balance"');
    expect(page).toMatch(
      /id="cashier-cashout-balance"[\s\S]{0,200}\$\{formatWalletChips\(myBalance\)\} Chips/
    );
  });

  it('centres the dock selection line in its frame', () => {
    expect(css).toMatch(
      /\.page\.simple \.actionBar \.selBar \{\s*position: relative;\s*justify-content: center;/
    );
  });

  it('prints Choose and Advanced in white, and the cashout words in the roster meta ink', () => {
    expect(page).not.toMatch(/styles\.entityCaretOpen : ''\} sc-label sc-ink--blue/);
    expect(css).toMatch(/\.entityCaret \{[^}]*color: var\(--ink-white\);/);
    expect(css).toMatch(/\.page\.simple \.header \.modeToggle \{[^}]*color: var\(--ink-white\);/);
    expect(css).toMatch(/\.cashoutLabel,\s*\.cashoutBalance \{[^}]*color: var\(--ink-muted\);/);
  });
});
