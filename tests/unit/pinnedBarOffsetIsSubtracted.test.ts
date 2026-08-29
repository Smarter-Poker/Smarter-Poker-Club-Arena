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

/** The declarations of the first rule whose selector matches. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(selector + ' {');
  expect(at, `${selector} not found`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

const OFFSET = '--ca-pinned-bar-offset';

describe('the pinned bar publishes its offset as a variable', () => {
  const multi = strip(read('pages/MultiTablePage.css'));

  it('declares the custom property on the body it pads', () => {
    const body = ruleBody(multi, "body[data-ca-pinned-bar='1']");
    expect(body).toContain(`${OFFSET}: calc(48px + env(safe-area-inset-top, 0px))`);
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
      expect(body).toContain(`calc(100dvh - var(${OFFSET}, 0px))`);
      // A bare `100dvh` alongside it would win or lose by source order; the
      // only bare one allowed is the pre-dvh `100vh` fallback.
      expect(body).not.toMatch(/min-height:\s*100dvh\s*;/);
      expect(body).toContain('min-height: 100vh;');
    });
  }

  it('the app layout agrees with the root it sits in', () => {
    // `.layout` is the flex child of `#root`. Left at a bare `100dvh` it would
    // overflow a correctly-shortened root by exactly the offset again.
    const body = ruleBody(strip(read('components/layouts/AppLayout.module.css')), '.layout');
    expect(body).toContain(`calc(100dvh - var(${OFFSET}, 0px))`);
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
      expect(body).toContain(`var(${OFFSET}, 0px)`);
    }
  });
});
