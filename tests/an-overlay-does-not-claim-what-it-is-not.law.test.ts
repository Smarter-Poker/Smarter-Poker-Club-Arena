/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AN OVERLAY DOES NOT CLAIM WHAT IT IS NOT — LAW (2026-09-01)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two ARIA claims that made things worse than saying nothing.
 *
 * THE WHEEL WAS NOT A DIALOG. `role="dialog" aria-modal="true"` with no
 * focusable control, no focus move and no dismiss. `aria-modal` tells
 * assistive tech to ignore EVERYTHING outside the element, so a screen reader
 * announced "Spin Multiplier Draw, dialog" and then hid the rest of the table
 * for the whole hold — in exchange for an overlay the player cannot interact
 * with at all. A focus trap would be the fix if there were anything to focus.
 * There is not, so it stops claiming to be a dialog and the meaning is carried
 * by the live region.
 *
 * THE ODDS GRID WAS NOT A TABLE. `role="table"` over plain divs with no
 * `role="row"` and no `role="cell"` beneath it: a screen reader announced a
 * table and found nothing in it. An incomplete ARIA table is worse than none.
 *
 * A SHORT VIEWPORT MUST NOT CLIP OR TRAP. `SpinWheel.css` had zero
 * height-based media queries while `.sw__tree` is pinned at `top: -132px`, so
 * on a 375px-high landscape phone the 3-2-1 the sequence is built around
 * rendered off screen. And `.seat-buyin-confirm` was a fixed centred flex box
 * with no `overflow-y`, so on the same screen the confirm button sat below the
 * fold, unreachable — the player could see the buy-in and not take it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('an overlay does not claim what it is not', () => {
  const wheel = read('src/components/tournament/SpinWheel.tsx');
  const wheelCss = read('src/components/tournament/SpinWheel.css');
  const table = read('src/pages/TablePage.tsx');
  const tableCss = read('src/pages/TablePage.css');
  const code = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('the wheel no longer claims to be a modal dialog', () => {
    const src = code(wheel);
    expect(src).not.toContain('aria-modal');
    expect(src).not.toContain('role="dialog"');
    // The meaning it does carry stays: the live region is the whole point.
    expect(wheel).toContain('role="status"');
    expect(wheel).toContain('aria-live="polite"');
    expect(wheel).toContain('aria-label="Spin Multiplier Draw"');
  });

  it('the odds grid no longer claims to be a table', () => {
    expect(code(table)).not.toContain('role="table"');
  });

  it('a short viewport does not clip the reveal', () => {
    expect(wheelCss).toContain('@media (max-height: 560px)');
    expect(wheelCss).toContain('@media (max-height: 440px)');
    // The tree is what was clipped; it must be one of the things that moves.
    const short = wheelCss.slice(wheelCss.indexOf('@media (max-height: 560px)'));
    expect(short).toContain('.sw__tree');
  });

  it('the buy-in sheet holds focus, since it claims aria-modal', () => {
    const trap = read('src/hooks/useFocusTrap.ts');
    // The whole contract, not a third of it: first focus in, Tab wrapping
    // both ways, focus restored on close. A partial trap is its own bug.
    expect(trap).toContain('first.focus()');
    expect(trap).toContain('e.shiftKey');
    expect(trap).toContain('lastItem.focus()');
    expect(trap).toContain('firstItem.focus()');
    expect(trap).toContain('document.contains(restore)');
    // Wired to the sheet, and only while it is open.
    expect(table).toContain('ref={seatBuyInTrapRef}');
    expect(table).toContain('useFocusTrap(!!seatFirstBuyIn && seatFirstConfirm !== null)');
    // The hook must NOT close on Escape: only the caller knows that closing
    // is refused while a debit is in flight.
    expect(trap).not.toContain("'Escape'");
  });

  it('the buy-in sheet can always reach its own button', () => {
    const sheet = tableCss.slice(
      tableCss.indexOf('.seat-buyin-confirm {'),
      tableCss.indexOf('.seat-buyin-confirm__backdrop')
    );
    expect(sheet).toContain('overflow-y: auto');
  });
});
