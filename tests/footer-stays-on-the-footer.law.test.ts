/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW — NOTHING THAT CAN CONTAIN THE BOTTOM NAV MAY BE AN ACCIDENTAL SCROLLER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan has now reported this same bug three times, in these words:
 *
 *   2026-08-24  "THE FOOTER NEEDS TO ACTUALLY BE ATTACHED TO THE BOTTOM"
 *   2026-08-25  "on safari on player accounts, the footer doesn't stay on the
 *                footer, it moves around"
 *   2026-08-29  "THE FOOTER IS COMING UP ON MOBILE AND ISN'T STAYING LOCKED TO
 *                THE FOOTER"
 *
 * Every time it was the same single declaration, on a different element:
 *
 *     overflow-x: hidden;
 *
 * CSS Overflow 3: when one axis is a non-visible value and the other is
 * `visible`, the `visible` one COMPUTES TO `auto`. So that one line silently
 * makes the element a scroll container on BOTH axes. WebKit then resolves
 * `position: fixed` descendants against the nearest scrolling ancestor instead
 * of the viewport, so ClubBottomNav gets pinned to the bottom of a 25,000px
 * scroll box and rides up the page over the content.
 *
 * Chrome does not do this. That is the whole reason it keeps coming back: it
 * cannot be seen in review, in a desktop browser, or in jsdom. It can only be
 * seen on Dan's iPhone, after it ships.
 *
 * `clip` is the one non-visible value the spec exempts from the promotion
 * (`visible` stays `visible` when its partner is `clip`), so the sideways
 * clipping these rules actually want is kept and the element stops being a
 * scrollport. `hidden` stays as the line before it, as the fallback for
 * anything older than Safari 16 / Chrome 90.
 *
 * WHAT IS STILL ALLOWED
 * A rule that ALSO declares `overflow-y` (or shorthand `overflow`) is a
 * deliberate scroller — `.multi-table-page__lobby-tab` is the real one — and is
 * exempt. The ban is on the accidental kind, where nobody asked for a scroll
 * container and one appeared anyway.
 *
 * Static read of the source on purpose: jsdom has no layout engine, so the only
 * honest way to test a WebKit containing-block rule is to pin the declaration
 * that causes it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '..');

/**
 * Every sheet in the app.
 *
 * Widened from `src/pages` + `src/styles` + `src/components/layouts` on
 * 2026-08-29, the same day the narrow version shipped. The narrow scope was
 * drawn around "things that are ancestors of the bottom nav today", and within
 * hours it had already missed one: `.lobby-table-wrap` in
 * src/components/lobby/LobbyTable.css.
 *
 * That one happened to be harmless. The point is that the scope was a judgement
 * about the component tree, and the component tree moves — a wrapper that is
 * not an ancestor of the nav today is one refactor away from being one, and
 * this bug is invisible in Chrome, invisible in jsdom, and only shows up on a
 * phone after it ships. Cheaper to ban the declaration everywhere.
 */
const SCOPES = [join(ROOT, 'src')];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function sheets(): string[] {
  return SCOPES.flatMap(walk).filter((f) => f.endsWith('.css'));
}

interface Offence {
  file: string;
  selector: string;
}

/**
 * Naive brace matcher. These are flat stylesheets — the only nesting is media
 * queries, whose blocks contain further `{...}` and are therefore skipped by
 * the innermost-block regex, leaving exactly the declaration blocks we want.
 */
function offencesIn(file: string): Offence[] {
  const src = readFileSync(file, 'utf8');
  const found: Offence[] = [];
  for (const match of src.matchAll(/\{[^{}]*\}/g)) {
    const block = match[0];
    if (!/^[ \t]*overflow-x:\s*hidden;\s*$/m.test(block)) continue;
    if (/overflow-x:\s*clip/.test(block)) continue; // paired, correct
    if (/overflow-y\s*:/.test(block)) continue; // a deliberate scroller
    if (/(^|[\s;{])overflow\s*:/.test(block)) continue; // shorthand, deliberate
    const before = src.slice(0, match.index ?? 0);
    const selector = (before.split(/[}{]/).pop() || '').trim().replace(/\s+/g, ' ').slice(-90);
    found.push({ file: file.replace(`${ROOT}/`, ''), selector });
  }
  return found;
}

describe('the footer stays on the footer', () => {
  it('no rule anywhere in src sets overflow-x: hidden without pairing it with clip', () => {
    const offences = sheets().flatMap(offencesIn);
    expect(
      offences,
      offences.length
        ? `These rules make their element an accidental scroll container, which is how the ` +
            `fixed ClubBottomNav comes unstuck from the bottom of the screen on iOS. Add ` +
            `\`overflow-x: clip;\` on the line after \`overflow-x: hidden;\`, or declare an ` +
            `explicit overflow-y if the element really is meant to scroll:\n` +
            offences.map((o) => `  ${o.file}  {${o.selector}}`).join('\n')
        : ''
    ).toEqual([]);
  });

  it('body is clipped, not hidden, in both sheets that style it', () => {
    for (const sheet of ['src/styles/design-system.css', 'src/styles/club-engine.css']) {
      const src = readFileSync(join(ROOT, sheet), 'utf8');
      const body = src.match(/\nbody\s*\{[^}]*\}/);
      expect(body, `${sheet} no longer has a body rule`).toBeTruthy();
      expect(body![0], `${sheet} body must pair overflow-x: hidden with clip`).toMatch(
        /overflow-x:\s*clip/
      );
    }
  });

  it('ClubBottomNav is still the fixed bar this law is about', () => {
    const css = readFileSync(join(ROOT, 'src/components/club/ClubBottomNav.module.css'), 'utf8');
    expect(css).toMatch(/position:\s*fixed/);
    expect(css).toMatch(/top:\s*auto/);
    expect(css).toMatch(/right:\s*0/);
    expect(css).toMatch(/bottom:\s*0/);
    expect(css).toMatch(/left:\s*0/);
    expect(css).toMatch(/width:\s*100%/);
    expect(css).toMatch(/max-width:\s*100vw/);
    expect(css).toMatch(/transform:\s*none/);
    expect(css).toMatch(/translate:\s*none/);
    expect(css).toMatch(/transition:\s*none/);
    expect(css).toMatch(/animation:\s*none/);
  });
});
