import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A mystery chest shows the amount the wallet receives, to the cent.
 *
 * The private tap path already divided AFTER rounding (Math.round(cents) / 100).
 * The table broadcast and the reconnect restore divided BEFORE rounding
 * (Math.round(cents / 100)), so a 426-cent chest opened as "4" while the
 * wallet was credited 4.26, and the broadcast then overwrote the correct
 * figure the tap had just shown. Measured on production 2026-10-04: chests
 * of 4.26, 4.27, 7.10, 8.50 and 3.30.
 */
describe('a mystery chest opens to the cent', () => {
  const source = readFileSync(resolve(__dirname, '../src/pages/TablePage.tsx'), 'utf8');

  it('never rounds a chest amount to whole chips', () => {
    expect(source).not.toMatch(/Math\.round\(\s*cents\s*\/\s*100\s*\)/);
    expect(source).not.toMatch(/Math\.round\(\s*[a-z]\.amountCents\s*\/\s*100\s*\)/);
  });

  it('converts cents on every chest path the same way', () => {
    expect(source.match(/Math\.round\(cents\) \/ 100/g)?.length).toBe(2);
    expect(source).toContain('Math.round(b.amountCents) / 100');
    expect(source).toContain('Math.round(r.amountCents) / 100');
    expect(source).toContain('Math.round(res.amount_cents!) / 100');
  });

  it('keeps 426 cents as 4.26', () => {
    expect(Math.round(426) / 100).toBe(4.26);
    expect(Math.round(426 / 100)).toBe(4);
  });
});
