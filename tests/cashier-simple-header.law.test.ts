import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Dan 2026-10-16, on the Simple Cashier header: no "Live Ledger" pill, no
// "Simple Cashier" caption, a much larger club logo with "Choose" as a
// dropdown, no "Balances Synchronized" line, and Request Cash Out as a real
// button rather than a line of text.
const page = readFileSync('src/pages/CashierTradePage.tsx', 'utf8');
const css = readFileSync('src/pages/CashierTradePage.module.css', 'utf8');
const PILL = 'public/images/cashier-actions/cashier-request-cashout-pill-v1.png';

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

  it('puts Request Cash Out on a compact lit pill cut from the approved header pill', () => {
    expect(page).toMatch(/className=\{styles\.cashoutButton\}[\s\S]{0,120}Request Cash Out/);
    expect(css).toContain("url('/images/cashier-actions/cashier-request-cashout-pill-v1.png')");
    expect(css).toMatch(/\.cashoutButton \{[^}]*width: 220px;[^}]*aspect-ratio: 470 \/ 108;/);
    expect(existsSync(PILL)).toBe(true);
    const png = readFileSync(PILL);
    expect(png.readUInt32BE(16)).toBe(470);
    expect(png.readUInt32BE(20)).toBe(108);
  });
});
