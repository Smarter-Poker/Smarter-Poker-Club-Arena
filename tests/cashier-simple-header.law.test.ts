import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Dan 2026-10-16, on the Simple Cashier header: no "Live Ledger" pill, no
// "Simple Cashier" caption, a much larger club logo with "Choose" as a
// dropdown, no "Balances Synchronized" line, and Request Cash Out as a real
// button rather than a line of text.
const page = readFileSync('src/pages/CashierTradePage.tsx', 'utf8');
const css = readFileSync('src/pages/CashierTradePage.module.css', 'utf8');
const PLATE = 'public/images/cashier-actions/cashier-request-cashout-plate-v1.png';

describe('the Simple Cashier header', () => {
  it('prints no Live Ledger pill, and still says Locked when offline', () => {
    expect(page).not.toContain("'Live Ledger'");
    expect(page).toContain("pill={isOnline ? undefined : 'Locked'}");
  });

  it('carries no Simple Cashier caption', () => {
    expect(page).not.toContain("'Simple Cashier'");
    expect(page).toContain('{advanced ? <span>Advanced Cashier</span>');
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

  it('puts Request Cash Out on its own painted plate', () => {
    expect(page).toMatch(/className=\{styles\.cashoutButton\}[\s\S]{0,120}Request Cash Out/);
    expect(css).toContain("url('/images/cashier-actions/cashier-request-cashout-plate-v1.png')");
    expect(css).toMatch(/\.cashoutButton \{[^}]*aspect-ratio: 401 \/ 155;/);
    expect(existsSync(PLATE)).toBe(true);
    const png = readFileSync(PLATE);
    expect(png.readUInt32BE(16)).toBe(401);
    expect(png.readUInt32BE(20)).toBe(155);
  });
});
