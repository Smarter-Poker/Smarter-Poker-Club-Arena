/**
 * BARS STACK ON THE FOOTER'S LIVE HEIGHT (Dan 2026-09-04, binding)
 *
 * "THE FOOTER IS SUPPOSED TO DISAPPEAR... BUT WHAT I WANT IS FOR THE BOX
 * ABOVE IT TO 'SNAP LOCK TO THE FOOTER' WHEN THE FOOTER DISAPPEARS BELOW IT."
 *
 * useHideFooterOnScroll drops the footer off the bottom edge with
 * translateY(100%) - instantly, by law. Every fixed bar that stacked on the
 * footer sat on a CSS constant equal to the footer's DESIGNED height, which
 * does not move, so the bar hung a footer's height above the edge with page
 * rows showing through the gap (the cashier's Claim Back / Send Ticket /
 * Send Out bar was the one Dan photographed; the table-config Save/Start
 * footer and the club-settings unsaved/conflict bars had the same gap).
 *
 * The rule: the footer PUBLISHES the height it occupies right now;
 * --bottom-nav-stack-base IS that number; bars stack on the base and never
 * on the designed clearance. Page content keeps padding with the clearance -
 * content must not jump when the footer slides.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.css')) out.push(p);
  }
  return out;
}

describe('bars stack on the footer live height', () => {
  it('the footer publishes the height it occupies: measured while shown, 0px while hidden or gone', () => {
    const nav = read('src/components/club/ClubBottomNav.tsx');
    expect(nav).toContain("export const BOTTOM_CHROME_HEIGHT_VAR = '--ca-bottom-chrome-h'");
    expect(nav).toContain("hidden ? '0px' : `${el.offsetHeight}px`");
    // Unmount clears it, so a route with no footer reads 0 rather than the
    // last value the previous route left behind.
    expect(nav).toContain("style.setProperty(BOTTOM_CHROME_HEIGHT_VAR, '0px')");
    expect(nav).toContain('usePublishBottomChromeHeight(navRef, hidden)');
    // Same frame as the footer, no easing: "real time instant change".
    expect(nav).not.toMatch(/^\s*transition\s*:/m);
  });

  it('the stacking base IS the live height, and clearance stays the designed reserve', () => {
    const globals = read('src/styles/globals.css');
    expect(globals).toMatch(/--bottom-nav-stack-base:\s*var\(\s*--ca-bottom-chrome-h,/);
    expect(globals).toContain(
      '--bottom-nav-clearance: calc(var(--bottom-nav-height) + env(safe-area-inset-bottom, 0px))'
    );
    const engine = read('src/styles/club-engine.css');
    expect(engine).toContain(
      '--bottom-nav-stack-base: var(--ca-bottom-chrome-h, var(--bottom-nav-clearance))'
    );
  });

  it('no bar positions its bottom on the designed clearance', () => {
    // `bottom: var(--bottom-nav-clearance)` on a fixed or sticky bar is the
    // exact shape of the gap. Padding with the clearance is fine and expected.
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, 'src'))) {
      const css = readFileSync(file, 'utf8');
      const hits = css.match(/^\s*bottom:\s*(calc\(\s*)?var\(--bottom-nav-clearance[^;]*;/gm);
      if (hits)
        offenders.push(`${file.replace(ROOT + '/', '')}: ${hits.map((h) => h.trim()).join(' | ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the four bars that stack on the footer stack on the base', () => {
    expect(read('src/pages/CashierTradePage.module.css')).toContain(
      'bottom: var(--bottom-nav-stack-base, 86px);'
    );
    expect(read('src/pages/TableConfigPage.css')).toContain(
      'bottom: var(--bottom-nav-stack-base, 74px);'
    );
    const settings = read('src/pages/ClubSettingsPage.css');
    expect(settings).toContain('bottom: calc(var(--bottom-nav-stack-base, 74px) + 8px);');
    expect(settings).toContain('bottom: calc(var(--bottom-nav-stack-base, 74px) + 82px);');
  });
});
