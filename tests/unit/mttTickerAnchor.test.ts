/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TICKER OWNS THE BAND UNDER THE GLOBAL HEADER (2026-08-30)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * HISTORY, because this file has now pinned both answers to the same collision
 * and the second only makes sense against the first.
 *
 * 2026-08-23. Reported as "multi table functionality isn't working - when you
 * click the + button to add a second, 3rd or 4th game, it doesn't create the
 * action box". The "+" was fine. `.mtt-ticker` is fixed, 34px tall, z-index
 * 9400, positioned at `top: headerBottom`, and that measurement only looked for
 * `#global-header` / `header`. Inside /table/* neither exists, so it returned 0
 * and the strip covered a tab bar whose stacking tops out at 200. Every tap on
 * "+" hit `.mtt-ticker__track`. The fix measured the tab bar too and pushed the
 * TICKER below it.
 *
 * 2026-08-30. Dan, with a screenshot of the club lobby: "THE TICKER MUST ALWAYS
 * BE AT THE VERY TOP OF THE PAGE, DIRECTLY UNDER THE GLOBAL HEADER, THE 'ACTION
 * TAB' SHOULD NEVER BE ABOVE IT." Pushing the ticker down is precisely what put
 * the action tab above it. The collision is solved the other way round now: the
 * ticker anchors to the global header alone, and the TAB BAR starts below the
 * ticker by reading `--mtt-ticker-h`.
 *
 * The "+" is safer under the new rule than the old one. Before, it depended on
 * a measurement finding a bar that mounts late; now the two are never in the
 * same pixels on any route at all.
 *
 * These pin both halves: the measurement (pure geometry, asserted without
 * mounting anything) and the offset that moves the bar out of the way.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  measureTopChromeBottom,
  TOP_CHROME_SELECTORS,
} from '../../src/components/tournament/topChrome';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const MULTI_TABLE_CSS = read('src/pages/MultiTablePage.css');
const TAB_BAR_CSS = read('src/components/table/TableTabBar.css');
const TABLE_PAGE_CSS = read('src/pages/TablePage.css');
const TICKER = read('src/components/tournament/TournamentStartingTicker.tsx');

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
  it('anchors to the global header and NOT to the action tab bar', () => {
    // The whole of Dan's 2026-08-30 note. If `.table-tab-bar` is measured, the
    // ticker is pushed below it and the action tab is on top - the screenshot.
    expect(TOP_CHROME_SELECTORS).not.toContain('.table-tab-bar');
    expect(TOP_CHROME_SELECTORS).toContain('#global-header');

    const bottom = measureTopChromeBottom(
      lookup({ '#global-header': el(56), header: null, '.table-tab-bar': el(48, 56) })
    );
    // 104 would be "below the tab bar". The ticker starts at the header's edge.
    expect(bottom).toBe(56);
  });

  it('starts at the top of the viewport where there is no global header', () => {
    // /table/* - TablePage is fixed to the whole viewport and has no header.
    // The tab bar is not consulted any more, so this is 0 by design, and the
    // "+" is protected by the bar's own offset rather than by this number.
    const bottom = measureTopChromeBottom(
      lookup({ '#global-header': null, header: null, '.table-tab-bar': el(48) })
    );
    expect(bottom).toBe(0);
  });

  it('takes the lowest edge when both header selectors are on screen', () => {
    const bottom = measureTopChromeBottom(lookup({ '#global-header': el(56), header: el(72) }));
    expect(bottom).toBe(72);
  });

  it('ignores a collapsed header rather than anchoring to it', () => {
    // getClientRects() is empty for display:none.
    expect(measureTopChromeBottom(lookup({ '#global-header': el(56, 0, false) }))).toBe(0);
  });

  it('ignores a zero-height element rather than anchoring to it', () => {
    expect(measureTopChromeBottom(lookup({ '#global-header': el(0), header: el(56) }))).toBe(56);
  });

  it('returns 0 when there is no top chrome at all', () => {
    expect(measureTopChromeBottom(lookup({}))).toBe(0);
  });

  it('never returns a negative offset', () => {
    // A header scrolled above the fold must not pull the ticker off-screen.
    expect(measureTopChromeBottom(lookup({ '#global-header': el(56, -100) }))).toBe(0);
  });
});

describe('the action tab starts below the ticker, never above it', () => {
  it('the ticker publishes its own height for the bar to start below', () => {
    // A fixed element moves nothing on its own. This is the whole mechanism.
    expect(TICKER).toMatch(/setProperty\('--mtt-ticker-h'/);
    // REMOVED, not zeroed, when no bar is up - so the `var(..., 0px)` fallback
    // in the stylesheets is what applies on a quiet schedule.
    expect(TICKER).toMatch(/removeProperty\('--mtt-ticker-h'\)/);
  });

  it('the in-flow bar on /table/* is pushed down by the ticker height', () => {
    expect(MULTI_TABLE_CSS).toMatch(/margin-top:\s*var\(--mtt-ticker-h,\s*0px\)/);
  });

  it('the pinned bar starts below header + ticker, and does not double it', () => {
    expect(MULTI_TABLE_CSS).toMatch(
      /top:\s*calc\(\s*var\(--ca-global-header-height,\s*0px\)\s*\+\s*var\(--mtt-ticker-h,\s*0px\)\s*\)/
    );
    // The fixed copy takes its offset from `top`; a margin would apply twice.
    const pinnedAt = MULTI_TABLE_CSS.indexOf('.multi-table-page__tab-bar-wrapper--pinned {');
    expect(pinnedAt).toBeGreaterThan(-1);
    const pinned = MULTI_TABLE_CSS.slice(pinnedAt, MULTI_TABLE_CSS.indexOf('\n}', pinnedAt));
    expect(pinned).toMatch(/margin-top:\s*0/);
  });

  it('page content clears both bars, not just the pinned one', () => {
    // Content spends --ca-pinned-bar-offset as in-flow clearance (AppLayout).
    // Without the ticker term the first rows of the lobby sit under the strip.
    expect(MULTI_TABLE_CSS).toMatch(
      /--ca-pinned-bar-offset:\s*calc\(48px\s*\+\s*var\(--mtt-ticker-h,\s*0px\)\)/
    );
  });

  it('the felt is NOT resized by the ticker, whatever the tab bar does', () => {
    // The obvious move - subtract --mtt-ticker-h from --sp-page-h too, since
    // the strip does take a band off the viewport - is a bug, and it was
    // written and reverted in this same change. That property is written by
    // JavaScript and the ticker arrives MID-HAND, so it would rescale the
    // felt, the seat ring, the pot and every chip the moment an MTT entered
    // its five-minute window. See tests/unit/feltReserveIsStatic.test.ts,
    // which refuses exactly this and prescribes the answer: reserve in CSS,
    // let what varies OVERLAY the felt. The tab bar moves; the felt does not.
    const embedded = TABLE_PAGE_CSS.match(/--sp-page-h:[^;]*;/g) || [];
    expect(embedded.length).toBeGreaterThanOrEqual(4);
    for (const decl of embedded) {
      expect(decl, `--sp-page-h must not depend on the ticker: ${decl}`).not.toMatch(
        /--mtt-ticker-h/
      );
    }
  });

  it('the notch is paid once at EVERY breakpoint, not just above 480px', () => {
    /* 2026-08-30 audit. The base rule was moved to
       `var(--sp-tabbar-inset, env(...))` so whichever strip touches y=0 pays
       the notch - and the <=480px override was left on the raw env(), so the
       double-inset survived on exactly the screens that have a notch. 375px is
       the design width; the fix applied everywhere it did not matter. */
    const insetRules =
      TAB_BAR_CSS.replace(/\/\*[\s\S]*?\*\//g, '').match(
        /padding-top:\s*calc\([^;]*safe-area-inset-top[^;]*\)/g
      ) || [];
    expect(insetRules.length).toBeGreaterThanOrEqual(2);
    for (const rule of insetRules) {
      expect(rule, `every padding-top must read the property: ${rule}`).toMatch(
        /var\(--sp-tabbar-inset,\s*env\(safe-area-inset-top/
      );
    }
  });

  it('the pinned bar does not pay a notch the global header already paid', () => {
    /* GlobalHeader.module.css pads by env(safe-area-inset-top) and
       GlobalHeader.tsx publishes getBoundingClientRect().height, so
       --ca-global-header-height ALREADY contains the inset. The pinned wrapper
       zeroed its own padding for that reason but the strip inside it kept
       paying env() itself - ~47px of dead black above the bar in the lobby on
       a notched iPhone. Scoped to the pinned wrapper: the in-flow bar on
       /table/* still pays the notch when nothing above it has. */
    const pinnedAt = MULTI_TABLE_CSS.indexOf('.multi-table-page__tab-bar-wrapper--pinned {');
    const pinned = MULTI_TABLE_CSS.slice(pinnedAt, MULTI_TABLE_CSS.indexOf('\n}', pinnedAt));
    expect(pinned).toMatch(/--sp-tabbar-inset:\s*0px/);
  });

  it('the banner and the wordmark share one anchor, so multi-board moves both', () => {
    /* The banner was pinned to a literal 52% while `[data-boards]` moved the
       masthead to 72% / 84%. On a run-it-twice or bomb-pot table it floated a
       third of the felt above the mark it sits on, into the board stack. */
    expect(TABLE_PAGE_CSS).toMatch(/--sp-brand-top:\s*58%/);
    expect(TABLE_PAGE_CSS).toMatch(/top:\s*var\(--sp-brand-top,\s*58%\)/);
    // The overrides move the SHARED property, not the wordmark's own top.
    expect(TABLE_PAGE_CSS).toMatch(
      /\.table-page\[data-boards='2'\] \.table-surface \{\s*--sp-brand-top:\s*72%/
    );
    expect(TABLE_PAGE_CSS).toMatch(
      /\.table-page\[data-boards='3'\] \.table-surface \{\s*--sp-brand-top:\s*84%/
    );
    // And nothing sets the wordmark's `top` directly any more, which is how
    // the two drifted apart in the first place.
    expect(TABLE_PAGE_CSS).not.toMatch(/\.table-brand \{[^}]*top:\s*\d+%/);
  });

  it('the notch is paid once, by whichever strip touches y = 0', () => {
    // The ticker pays env(safe-area-inset-top) only when it is topmost, and
    // zeroes the bar's inset when it does. Paying twice is a ~47px dead band
    // on notched iPhones, which this pairing has produced once already.
    expect(TAB_BAR_CSS).toMatch(
      /padding-top:\s*calc\(6px \+ var\(--sp-tabbar-inset,\s*env\(safe-area-inset-top, 0\)\)\)/
    );
    expect(TICKER).toMatch(/setProperty\('--sp-tabbar-inset', '0px'\)/);
  });
});

describe('the club arena background is one black', () => {
  it('the action tab area is solid black, not a translucent gradient', () => {
    // Dan 2026-08-30: "SOLID BLACK AND ALL THE SAME COLOR. (INCLUDING THE
    // ACTION TAB AREA.)" Alpha is the tell: a translucent strip takes its
    // colour from whatever is behind it and can never match a flat page.
    const barAt = TAB_BAR_CSS.indexOf('.table-tab-bar {');
    const bar = TAB_BAR_CSS.slice(barAt, TAB_BAR_CSS.indexOf('\n}', barAt));
    expect(bar).toMatch(/background:\s*#000/);
    expect(bar).not.toMatch(/rgba\(/);
    expect(bar).not.toMatch(/backdrop-filter/);

    // The base rule, not the media-query override of the same selector that
    // appears earlier in the file (hence the leading newline).
    const wrapAt = MULTI_TABLE_CSS.indexOf('\n.multi-table-page__tab-bar-wrapper {');
    const wrap = MULTI_TABLE_CSS.slice(wrapAt, MULTI_TABLE_CSS.indexOf('\n}', wrapAt));
    expect(wrap).toMatch(/background:\s*#000/);
    expect(wrap).not.toMatch(/backdrop-filter/);
  });

  it('every page GROUND is the same black, not four near-blacks', () => {
    // Dan 2026-08-30, round 2. These are grounds - the shell behind the felt,
    // the three full-bleed states that replace it, and the lobby strip holding
    // the club card and wallet. Not raised surfaces: `.lobby-club`, the tiles
    // and the panels keep their own colours, which is what a raised surface is
    // FOR. #0a0c12 and #02060b are invisible on their own and obviously a
    // different black once everything around them is #000.
    // Comments stripped: the rule explains which black it replaced, by value.
    expect(MULTI_TABLE_CSS.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#0a0c12/);
    const lobby = read('src/pages/ClubHomePage.css');
    const topAt = lobby.indexOf('.lobby-top {');
    expect(topAt).toBeGreaterThan(-1);
    const top = lobby.slice(topAt, lobby.indexOf('\n}', topAt));
    expect(top).toMatch(/background:\s*#000/);
    // And no white seam between the strip and the page under it.
    expect(top).not.toMatch(/border-bottom:[^;]*rgba\(255/);
    // The 1px stays DECLARED: it is part of this rule's height, and the
    // "1 pixel under the ticker" geometry was measured with it in place.
    expect(top).toMatch(/border-bottom:\s*1px solid #000/);
  });

  it('the dead route-art machinery is deleted, not left running into nothing', () => {
    // The classifier picked a PNG for a pseudo-element that no longer exists.
    // Left in place it computes an answer nobody reads on every navigation,
    // and the next reader has to prove it is dead before touching it.
    // Comments stripped first: the file DESCRIBES what it used to do, by name,
    // and a naive grep would fail on the explanation of the deletion.
    const layout = read('src/components/layouts/AppLayout.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(layout).not.toMatch(/ROUTE_ART/);
    expect(layout).not.toMatch(/getCasinoZone/);
    expect(layout).not.toMatch(/--casino-route-art/);
    expect(layout).not.toMatch(/data-casino-zone/);
    // The shell class itself stays - it still carries the typography, focus
    // and table rules the pages depend on.
    expect(layout).toMatch(/styles\.casinoStage/);
  });

  it('the route shell carries no artwork or side borders', () => {
    // "YOU CAN SEE SOME OLD BORDER IMAGES ON THE SIDES" - the route art bled
    // in from the right edge of .casinoStage, with inset highlights down both
    // sides and a blue hairline across the top.
    const shell = read('src/components/layouts/AppLayout.module.css');
    expect(shell).not.toMatch(/bg-vault/);
    expect(shell).not.toMatch(/var\(--casino-route-art\)/);
    expect(shell).not.toMatch(/\.casinoStage::(before|after)\s*\{/);
    const stageAt = shell.indexOf('.casinoStage {');
    const stage = shell.slice(stageAt, shell.indexOf('\n}', stageAt));
    expect(stage).toMatch(/background:\s*#000/);
    expect(stage).not.toMatch(/box-shadow/);
  });

  it('the page ground is #000, not one of the near-blacks beside it', () => {
    // club-engine.css owns the live body rule; globals.css and
    // design-system.css are not imported by main.tsx.
    const engine = read('src/styles/club-engine.css');
    const bodyAt = engine.indexOf('body {');
    const body = engine.slice(bodyAt, engine.indexOf('\n}', bodyAt));
    expect(body).toMatch(/background:\s*#000/);
    expect(body).not.toMatch(/background:\s*var\(--club-black\)/);
  });
});
