/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MTT TICKER MUST NOT LAND ON THE TABLE TAB BAR (2026-08-23)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Reported as "multi table functionality isn't working - when you click the +
 * button to add a second, 3rd or 4th game, it doesn't create the action box".
 *
 * The "+" was fine. `.mtt-ticker` is fixed, 34px tall, z-index 9400, and
 * positioned at `top: headerBottom`. That measurement only ever looked for
 * `#global-header` / `header`. Inside /table/* neither exists — TablePage is
 * fixed to the whole viewport and its top chrome is `.table-tab-bar` — so the
 * measurement returned 0 and the strip covered the tab bar, whose stacking
 * tops out at z-index 200. Every tap on "+" hit `.mtt-ticker__track` and
 * opened the tournament lobby instead.
 *
 * This pins the measurement rule itself: the ticker starts below the LOWEST
 * visible piece of top chrome, whichever route supplied it. The geometry lives
 * in one small pure function so it can be asserted without mounting the whole
 * table, and the component imports the same function it is tested through.
 */

import { describe, it, expect } from 'vitest';
import {
  measureTopChromeBottom,
  TOP_CHROME_SELECTORS,
} from '../../src/components/tournament/topChrome';

/** A stand-in for a rendered element: only the geometry the rule reads. */
function el(height: number, top = 0, visible = true) {
  return {
    getClientRects: () => (visible ? [{}] : []),
    getBoundingClientRect: () => ({ top, bottom: top + height, height }),
  } as unknown as Element;
}

function lookup(map: Record<string, Element | null>) {
  return (sel: string) => map[sel] ?? null;
}

describe('MTT ticker top-chrome measurement', () => {
  it('includes the multi-table tab bar, not just the global header', () => {
    // This is the exact regression: no header anywhere, tab bar 48px tall.
    expect(TOP_CHROME_SELECTORS).toContain('.table-tab-bar');

    const bottom = measureTopChromeBottom(
      lookup({ '#global-header': null, header: null, '.table-tab-bar': el(48) })
    );

    // 0 here is the bug — the ticker would sit across the "+".
    expect(bottom).toBe(48);
  });

  it('starts below the lowest chrome when several are on screen', () => {
    const bottom = measureTopChromeBottom(
      lookup({
        '#global-header': el(56),
        header: el(56),
        '.table-tab-bar': el(48, 56), // stacked under the header
      })
    );
    expect(bottom).toBe(104);
  });

  it('ignores a collapsed tab bar so other routes still get top: 0', () => {
    // Off /table/* the persistent layer is display:none — no client rects.
    const bottom = measureTopChromeBottom(
      lookup({ '#global-header': null, header: null, '.table-tab-bar': el(48, 0, false) })
    );
    expect(bottom).toBe(0);
  });

  it('ignores a zero-height element rather than anchoring to it', () => {
    const bottom = measureTopChromeBottom(
      lookup({ '#global-header': el(0), header: null, '.table-tab-bar': el(48) })
    );
    expect(bottom).toBe(48);
  });

  it('returns 0 when there is no top chrome at all', () => {
    expect(measureTopChromeBottom(lookup({}))).toBe(0);
  });

  it('never returns a negative offset', () => {
    // A bar scrolled above the fold must not pull the ticker off-screen.
    const bottom = measureTopChromeBottom(lookup({ '.table-tab-bar': el(48, -100) }));
    expect(bottom).toBe(0);
  });
});
