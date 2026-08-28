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
 * These tests pin the MECHANISM, not a particular pixel value, because a pixel
 * value is precisely what failed.
 *
 * ─── 2026-08-27: THE MECHANISM CHANGED, AND THIS FILE CHANGED WITH IT ───────
 *
 * The mechanism used to be "the reserve is MEASURED from the panel", and these
 * tests asserted the ResizeObserver, the ref and the `var(--sp-action-h)` reads.
 * That mechanism was itself the next bug. Dan, same day: "the Club Arena game
 * table is doing this weird thing where the screen is moving in and out
 * constantly ... it's happening on all tables."
 *
 * `--sp-table-bottom` is not a padding. `.table-scaler` derives its WIDTH from
 * the height left over, so every pixel of that reserve rescales the whole felt.
 * The measured box changes height several times in every hand — it collapses to
 * 1px when the hero has no action, drops to the 22px spectator line, stands back
 * up on the hero's turn, and grows again when Show Hand enters it at showdown —
 * so the felt swung 606x1002 to 664x1098 on a desktop, with no transition, over
 * and over.
 *
 * The reserve is a DECLARED CONSTANT now (`--sp-action-reserve`, TablePage.css),
 * and it restates the same floor the wrapper's own min-height stands on, so the
 * 2026-08-23 bug these tests were written for still cannot come back: the
 * reserve is >= the bar at every breakpoint, in every state. What it can no
 * longer do is move.
 *
 * `tests/unit/feltReserveIsStatic.test.ts` is the guard for the new failure —
 * it proves no property the felt's geometry depends on is written from JS.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const TABLE_CSS = read('src/pages/TablePage.css');
const HUD_CSS = read('src/components/table/TableHUD.css');
const ACTION_CSS = read('src/components/table/ActionPanel.css');
const TABLE_TSX = read('src/pages/TablePage.tsx');

/** Every rule that reserves room for the fixed action bar. */
const RESERVE_RULES: Array<[string, string]> = [
  ['TablePage.css', TABLE_CSS],
  ['TableHUD.css', HUD_CSS],
];

describe('the fixed action bar cannot cover the hero plate or the HUD', () => {
  it('declares the reserve in CSS, and never measures the bar to get it', () => {
    // The two heights that box can stand at, each declared once, next to the
    // rule that produces it (ActionPanel.css).
    expect(ACTION_CSS).toMatch(/^\s*--sp-bottom-row-h\s*:/m);
    expect(ACTION_CSS).toMatch(/^\s*--sp-spectator-line-h\s*:/m);
    // ...and restated as a reserve on .table-page, in both seating states.
    expect(TABLE_CSS).toMatch(/^\s*--sp-action-reserve\s*:/m);
    expect(TABLE_CSS).toContain("table-page[data-hero='false']");

    // No measurement of the wrapper reaches CSS, by any route.
    expect(TABLE_TSX).not.toContain('actionPanelRef');
    expect(TABLE_TSX).not.toContain("setProperty('--sp-action-h'");
    expect(TABLE_TSX).not.toContain('ref={actionPanelRef}');
  });

  it('reserves space by reading that constant, in every place that reserves', () => {
    for (const [name, css] of RESERVE_RULES) {
      expect(css, `${name} must read --sp-action-reserve`).toContain('var(--sp-action-reserve');
      expect(css, `${name} must not read the deleted --sp-action-h`).not.toContain(
        'var(--sp-action-h'
      );
    }
  });

  it('reserves at least as much as the bar can occupy, so the plate cannot be covered', () => {
    // The 2026-08-23 bug in one line: the reserve has to restate the bar's own
    // floor, not a number somebody typed next to it. Both sides read
    // --sp-bottom-row-h, so a breakpoint that changes the bar changes the
    // reserve in the same step.
    const reserve = TABLE_CSS.split('\n')
      .join(' ')
      .match(/--sp-action-reserve:\s*calc\([^;]*\);/);
    expect(reserve, '--sp-action-reserve is not declared as a calc()').not.toBeNull();
    expect(reserve![0]).toContain('--sp-bottom-row-h');
    expect(reserve![0]).toContain('env(safe-area-inset-bottom');
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
