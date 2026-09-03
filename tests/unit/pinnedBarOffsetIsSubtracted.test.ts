/**
 * The global header alone owns viewport y=0. When table tabs are present, their
 * persistent action bar is fixed to the measured bottom edge of that header.
 * An in-flow AppLayout spacer reserves the action bar's 48px height without
 * padding the body, moving the header, or making a 100dvh shell overflow.
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
const HEADER_HEIGHT = '--ca-global-header-height';

describe('the global header owns viewport y=0', () => {
  const multi = strip(read('pages/MultiTablePage.css'));
  const header = read('components/navigation/GlobalHeader.tsx');
  const headerCss = strip(read('components/navigation/GlobalHeader.module.css'));

  it('positions the action bar at the measured bottom of GlobalHeader', () => {
    const pinned = ruleBody(multi, '.multi-table-page__tab-bar-wrapper--pinned');
    /* Header height PLUS the MTT ticker, which took the band directly under
       the header on 2026-08-30 (Dan: "THE 'ACTION TAB' SHOULD NEVER BE ABOVE
       IT"). `--mtt-ticker-h` is absent with no ticker on screen, so this is
       still the header's measured bottom edge on a quiet schedule. */
    expect(pinned).toMatch(
      new RegExp(
        `top:\\s*calc\\(\\s*var\\(\\s*${HEADER_HEIGHT}\\s*,\\s*0px\\s*\\)\\s*\\+\\s*var\\(\\s*--mtt-ticker-h\\s*,\\s*0px\\s*\\)\\s*\\)`
      )
    );
    expect(pinned).toMatch(/padding-top:\s*0/);
    expect(header).toMatch(new RegExp(`root\\.style\\.setProperty\\(\\s*['"]${HEADER_HEIGHT}['"]`));
    expect(header).toContain('new ResizeObserver(publishHeight)');
  });

  it('keeps GlobalHeader above the persistent action bar', () => {
    const headerRule = ruleBody(headerCss, '.header');
    const pinned = ruleBody(multi, '.multi-table-page__tab-bar-wrapper--pinned');
    const headerLayer = Number(headerRule.match(/z-index:\s*(\d+)/)?.[1]);
    const pinnedLayer = Number(pinned.match(/z-index:\s*(\d+)/)?.[1]);

    expect(headerLayer).toBeGreaterThan(pinnedLayer);
  });

  it('publishes the action bar height without padding the body', () => {
    const body = ruleBody(multi, "body[data-ca-pinned-bar='1']");
    /* 48px of bar, plus the ticker above it (2026-08-30): content has to clear
       BOTH fixed strips or the first rows of the lobby end up underneath them.
       Still exactly 48px whenever no ticker is on screen. */
    expect(body).toMatch(/--ca-pinned-bar-offset:\s*calc\(48px \+ var\(--mtt-ticker-h, 0px\)\)/);
    expect(body).not.toMatch(/padding-top\s*:/);
  });

  it('spends that height in flow immediately after GlobalHeader', () => {
    const layout = read('components/layouts/AppLayout.tsx');
    const css = strip(read('components/layouts/AppLayout.module.css'));
    const active = ruleBody(css, ":global(body[data-ca-pinned-bar='1']) .pinnedActionBarClearance");
    expect(layout.indexOf('<GlobalHeader />')).toBeLessThan(
      layout.indexOf('styles.pinnedActionBarClearance')
    );
    expect(active).toMatch(new RegExp(`height:\\s*var\\(\\s*${OFFSET}`));
  });
});

describe('full-height shells remain one viewport because body is not padded', () => {
  const sheets = ['styles/globals.css', 'styles/club-engine.css'] as const;

  for (const sheet of sheets) {
    it(`${sheet} keeps #root at the visible viewport`, () => {
      const body = ruleBody(strip(read(sheet)), '#root');
      expect(body).toMatch(/min-height:\s*100dvh/);
      expect(body).not.toContain(OFFSET);
      expect(body).toContain('min-height: 100vh;');
    });
  }

  it('the app layout agrees with the roots it sits in', () => {
    const body = ruleBody(strip(read('components/layouts/AppLayout.module.css')), '.layout');
    expect(body).toMatch(/min-height:\s*100dvh/);
    expect(body).not.toContain(OFFSET);
  });
});
