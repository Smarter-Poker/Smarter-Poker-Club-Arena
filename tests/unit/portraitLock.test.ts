/**
 * THE PORTRAIT LOCK MAY NEVER REACH A DEVICE THAT CANNOT ROTATE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28: "lock it, portrait mode only." The table is a 605/1000
 * portrait oval sized from leftover height, so a phone in landscape renders a
 * 96px felt (measured, scripts/dev/measure-felt.mjs) and is shown a rotate
 * prompt instead.
 *
 * THE FAILURE THIS FILE EXISTS FOR is the obvious over-reach: every desktop is
 * landscape too. `@media (orientation: landscape)` on its own would cover every
 * desktop player's screen with an un-dismissable instruction to turn a phone
 * they are not holding, on a viewport where the table works fine. There is no
 * dismiss button by design, so that regression is not a cosmetic one — it locks
 * every desktop player out of the product until a deploy reverses it.
 *
 * Interaction media is what separates the two, and it is asserted here rather
 * than trusted: `(hover: none) and (pointer: coarse)` is true only where the
 * primary pointer is a finger and nothing can hover. A desktop is fine/hover. A
 * touchscreen laptop is ALSO fine/hover, because its primary pointer is the
 * trackpad, which is why this is the right test and a width breakpoint is not.
 *
 * These are source assertions, not render assertions, on purpose: jsdom
 * evaluates no media queries at all, so a render test would pass against a rule
 * that catches every desktop on Earth.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const CSS = read('src/components/table/PortraitLock.css');
const TSX = read('src/components/table/PortraitLock.tsx');
const LAYER = read('src/components/table/PersistentTableLayer.tsx');

/** Block comments quote the rules they explain, so strip before matching. */
const cssNoComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the portrait lock cannot reach a device that has no portrait', () => {
  it('hides by default and reveals only inside a media query', () => {
    // The base rule must be `display: none`. If the overlay defaulted to
    // visible and a media query hid it, then every environment that does not
    // match ANY query - a print stylesheet, an unsupported browser, a crawler -
    // would render the lock over the table.
    const base = cssNoComments.match(/(^|\})\s*\.portrait-lock\s*\{([^}]*)\}/);
    expect(base, 'the base .portrait-lock rule went missing').toBeTruthy();
    expect(base![2], 'the lock must be hidden until a media query reveals it').toMatch(
      /display:\s*none/
    );
  });

  it('requires a TOUCH-PRIMARY device, not merely a landscape viewport', () => {
    const queries = [...cssNoComments.matchAll(/@media([^{]+)\{[^{}]*\.portrait-lock\s*\{/g)].map(
      (m) => m[1].replace(/\s+/g, ' ').trim()
    );

    expect(
      queries.length,
      'no @media rule shows .portrait-lock - the overlay can never appear'
    ).toBeGreaterThan(0);

    for (const q of queries) {
      expect(q, `"${q}" must be scoped to landscape`).toMatch(/orientation:\s*landscape/);
      expect(
        q,
        `"${q}" shows the rotate prompt without testing for a touch device. ` +
          'Every desktop is landscape and none of them can rotate: this would cover ' +
          'every desktop player with an un-dismissable instruction to turn their phone.'
      ).toMatch(/hover:\s*none/);
      expect(q, `"${q}" must also require a coarse primary pointer`).toMatch(/pointer:\s*coarse/);
    }
  });

  it('is mounted by the one layer that exists exactly once', () => {
    /* MultiTablePage keeps up to four TablePages mounted simultaneously (an
       inactive slot is only `pointer-events: none`), so a lock rendered inside
       a table would paint four stacked full-screen overlays and fire four
       orientation-lock requests. PersistentTableLayer is mounted once beside
       <Routes> and already knows whether a table is on screen. */
    expect(LAYER, 'PersistentTableLayer must render the lock').toMatch(/<PortraitLock\b/);
    expect(LAYER, 'the lock must be gated on the table route, not shown over the lobby').toMatch(
      /<PortraitLock\s+active=\{onTableRoute\}/
    );

    for (const file of ['src/pages/TablePage.tsx', 'src/pages/MultiTablePage.tsx']) {
      expect(
        read(file),
        `${file} renders PortraitLock. Up to four of these are mounted at once - ` +
          'it belongs in PersistentTableLayer, which is mounted once.'
      ).not.toMatch(/<PortraitLock\b/);
    }
  });

  it('never blocks on the orientation API, which normally fails', () => {
    /* screen.orientation.lock() rejects outside fullscreen and does not exist on
       iOS Safari at all. Those are the EXPECTED paths, not errors, and the
       overlay is the mechanism that actually holds - so an unhandled rejection
       here would turn the normal case into a console error on every table
       open, and a throw would take the layer's error boundary with it. */
    expect(TSX, 'the orientation lock attempt must swallow its rejection').toMatch(
      /\.lock\?\.\('portrait'\)\.catch\(/
    );
    expect(TSX, 'unlock() must be guarded too - it throws where lock() rejects').toMatch(
      /try\s*\{[\s\S]{0,120}unlock/
    );
  });

  it('decides visibility in CSS, so uncovering the felt is not a React commit', () => {
    /* A player who rotates mid-hand is on a clock: the server is authoritative,
       the other players are waiting, and nothing here can pause their turn
       timer. The cost of covering the felt is measured in folded hands, so the
       UNCOVERING has to be a style recalculation rather than a state update -
       and a resize/orientation listener above four mounted tables is also a
       re-render burst during exactly the gesture that must stay smooth. */
    expect(
      TSX,
      'the lock must not drive its own visibility from JS - no resize or ' +
        'orientationchange listener, and no matchMedia state'
    ).not.toMatch(/addEventListener\(\s*['"`](resize|orientationchange)|matchMedia/);
  });

  it('says the hands are still live, because they are', () => {
    // Stated unconditionally: turn state lives in MultiTablePage, below this
    // layer. A sentence that is true in every case beats lifting state through
    // the component whose entire job is to never unmount.
    expect(TSX).toMatch(/Your Hands Are Still Live/);
  });
});
