/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A FULL VIEWPORT INSIDE A PADDED BODY IS TALLER THAN THE SCREEN
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * When the pinned table bar is up, `body[data-ca-pinned-bar='1']` takes
 * `48px + env(safe-area-inset-top)` of `padding-top` so the bar covers nothing.
 * `#root` then asked for `min-height: 100dvh` — a WHOLE viewport — inside a body
 * that had already spent 48px of it. 48 + 812 = 860.
 *
 * Measured on production at 375x812 with the bar up:
 *
 *     body          860px      viewport 812px      overflow 48px
 *
 * So every page in Club Arena scrolled 48px it did not have to, and on the
 * tournament page that is 48px taken off a content column already tight enough
 * that the entries list sits near its floor.
 *
 * The offset was ALREADY meant to be a variable. MultiTablePage.css says, above
 * the rule: "Set as a variable on <body> by MultiTablePage so a single number
 * drives both the offset and any page that wants to know." It was a literal, so
 * nothing could read it and nothing did. Making it a real custom property is
 * the whole fix; `#root` subtracts it, with a `0px` fallback so a page rendered
 * without the bar is untouched.
 *
 * Verified on the same live page after the change: body 812px, overflow 0,
 * `documentElement.scrollHeight` no longer exceeds the viewport, and the
 * entries list is unchanged at 150px and still not propped by its floor.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
/** Comments quote the old rule; assertions read declarations only. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The declarations of the first rule whose selector matches, with runs of
 * whitespace collapsed.
 *
 * COLLAPSED, because Prettier decides where the line breaks go and it is not
 * the author. This test passed locally and failed in CI on exactly one of the
 * three rules: the `club-engine.css` line carried a trailing comment, which
 * pushed it past the print width, so the pre-commit hook rewrote it as
 *
 *     min-height: calc(
 *       100dvh - var(--ca-pinned-bar-offset, 0px)
 *     ); /* ... *\/
 *
 * and a single-line `toContain` no longer matched. The identical declaration in
 * `globals.css` has no trailing comment, stayed on one line, and passed — which
 * is what made the failure look like a real difference between the two files.
 *
 * An assertion about a CSS declaration has no business caring where the line
 * breaks fall. (CLAUDE.md already warns that Prettier runs on commit and that
 * what lands can differ cosmetically from what you wrote.)
 */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(selector + ' {');
  expect(at, `${selector} not found`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at)).replace(/\s+/g, ' ');
}

const OFFSET = '--ca-pinned-bar-offset';

/**
 * `calc(100dvh - var(--ca-pinned-bar-offset, 0px))`, however Prettier chose to
 * lay it out. Collapsing whitespace was not enough on its own: a wrapped
 * `calc(\n  100dvh` collapses to `calc( 100dvh`, with a space inside the
 * parenthesis that a literal string still misses. Match the declaration, not
 * its typography.
 */
const SUBTRACTS_OFFSET = /calc\(\s*100dvh\s*-\s*var\(\s*--ca-pinned-bar-offset\s*,\s*0px\s*\)\s*\)/;

describe('the pinned bar publishes its offset as a variable', () => {
  const multi = strip(read('pages/MultiTablePage.css'));

  it('declares the custom property on the body it pads', () => {
    const body = ruleBody(multi, "body[data-ca-pinned-bar='1']");
    expect(body).toMatch(
      /--ca-pinned-bar-offset:\s*calc\(\s*48px\s*\+\s*env\(\s*safe-area-inset-top\s*,\s*0px\s*\)\s*\)/
    );
  });

  it('drives its own padding from that variable, so the two cannot drift', () => {
    // A literal here and a variable elsewhere is two numbers pretending to be
    // one, which is what the file's comment was already warning against.
    const body = ruleBody(multi, "body[data-ca-pinned-bar='1']");
    expect(body).toMatch(new RegExp(`padding-top:\\s*var\\(${OFFSET}\\)`));
  });
});

describe('every full-height shell subtracts it', () => {
  // Both stylesheets define #root; whichever loads last wins, so both must
  // agree or the bug comes back through the other one.
  const sheets = ['styles/globals.css', 'styles/club-engine.css'] as const;

  for (const sheet of sheets) {
    it(`${sheet} sizes #root against the viewport MINUS the offset`, () => {
      const body = ruleBody(strip(read(sheet)), '#root');
      expect(body).toMatch(SUBTRACTS_OFFSET);
      // A bare `100dvh` alongside it would win or lose by source order; the
      // only bare one allowed is the pre-dvh `100vh` fallback.
      expect(body).not.toMatch(/min-height: 100dvh ?;/);
      expect(body).toContain('min-height: 100vh;');
    });
  }

  it('the app layout agrees with the root it sits in', () => {
    // `.layout` is the flex child of `#root`. Left at a bare `100dvh` it would
    // overflow a correctly-shortened root by exactly the offset again.
    const body = ruleBody(strip(read('components/layouts/AppLayout.module.css')), '.layout');
    expect(body).toMatch(SUBTRACTS_OFFSET);
  });

  it('falls back to 0px so a page without the bar is unchanged', () => {
    // The regression risk of this fix is that it shortens pages that never had
    // the padding. The fallback is what prevents that, in every rule.
    const all = [
      ruleBody(strip(read('styles/globals.css')), '#root'),
      ruleBody(strip(read('styles/club-engine.css')), '#root'),
      ruleBody(strip(read('components/layouts/AppLayout.module.css')), '.layout'),
    ];
    for (const body of all) {
      expect(body).toMatch(new RegExp(`var\\(\\s*${OFFSET}\\s*,\\s*0px\\s*\\)`));
    }
  });
});
