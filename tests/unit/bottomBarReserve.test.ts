/**
 * The action bar must never sit on top of the hero's chips or the previous-hand
 * card again.
 *
 * Dan 2026-08-23 reported these as two separate bugs - "the bottom bar is
 * covering the hero's box so they cant see how many chips they have" and "the
 * previous hand buttons are missing" - and they were one cause. The action
 * panel is `position: fixed`, so nothing below it reserves space automatically,
 * and two rules reserved space for it BY HAND with two different numbers:
 *
 *     .table-container   104px
 *     .table-hud__lower  112px   "clears the collapsed 3-button action bar"
 *
 * That second comment states the failure as if it were the spec. Collapsed is
 * the only state where the number holds; open the raise slider and the panel is
 * taller than both, so the previous-hand card is covered (never removed) and the
 * hero's name plate goes under with it.
 *
 * These tests pin the MECHANISM - the reserve is measured from the panel - not
 * a particular pixel value, because a pixel value is precisely what failed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const TABLE_CSS = read('src/pages/TablePage.css');
const HUD_CSS = read('src/components/table/TableHUD.css');
const TABLE_TSX = read('src/pages/TablePage.tsx');

/** Every rule that reserves room for the fixed action bar. */
const RESERVE_RULES: Array<[string, string]> = [
  ['TablePage.css', TABLE_CSS],
  ['TableHUD.css', HUD_CSS],
];

describe('the fixed action bar cannot cover the hero plate or the HUD', () => {
  it('publishes the panel height as --sp-action-h from a real measurement', () => {
    // A ResizeObserver on the panel itself. Anything else is a guess wearing a
    // variable's name.
    expect(TABLE_TSX).toContain('actionPanelRef');
    expect(TABLE_TSX).toContain("root.style.setProperty('--sp-action-h'");
    expect(TABLE_TSX).toMatch(/ro\.observe\(el\)/);
    // The ref must actually be attached to the wrapper, or the observer watches
    // nothing and every reserve silently falls back to its default.
    expect(TABLE_TSX).toContain('className="action-panel-wrapper" ref={actionPanelRef}');
  });

  it('reserves space by reading that measurement, in both places', () => {
    for (const [name, css] of RESERVE_RULES) {
      expect(css, `${name} must read --sp-action-h`).toContain('var(--sp-action-h');
    }
  });

  it('never hardcodes the old 104px / 112px action-bar reserve, at any breakpoint', () => {
    // The responsive blocks carried their own copies. A hardcoded value inside a
    // media query undoes the fix on exactly the narrow screens where the hero
    // plate has least room - which is where it was reported.
    for (const [name, css] of RESERVE_RULES) {
      const offenders = css
        .split('\n')
        .filter((l) => /calc\(\s*(104|112)px\s*\+\s*env\(safe-area-inset-bottom/.test(l));
      expect(offenders, `${name} still hardcodes an action-bar reserve`).toEqual([]);
    }
  });

  it('reserves MORE than the panel height, because the hero plate hangs below the scaler', () => {
    // The hero avatar's centre sits on the scaler's bottom edge, so half the
    // avatar plus the whole name-and-stack box is outside the scaler. Reserving
    // only the panel's height still slides that box under the bar.
    expect(TABLE_CSS).toContain('var(--sp-hero-clear');
  });

  it('actually DECLARES --sp-hero-clear, rather than relying on a fallback', () => {
    // Asserting only that `var(--sp-hero-clear` appears is a test that passes on
    // a variable nothing assigns: an unassigned custom property silently
    // resolves to its fallback, so the layout looks right while the value lives
    // in three separate fallback slots and cannot be changed in one place.
    // Match a real declaration, not a read.
    const declared = TABLE_CSS.split('\n').filter((l) => /^\s*--sp-hero-clear\s*:/.test(l));
    expect(declared.length, '--sp-hero-clear is read but never declared').toBeGreaterThan(0);
  });
});
