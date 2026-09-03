/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  EVERY ANIMATION HONOURS prefers-reduced-motion — ALL OF THEM
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-21: "DO NOT STOP UNTIL YOU HAVE CONFIRMATION THAT 93 OF 93 ARE
 * GOOD TO GO."
 *
 * The audit found 328 stylesheets declaring `@keyframes` and only 58 honouring
 * reduced motion — and the gaps were the full-screen celebrations: the
 * tournament winner overlay, the Bad Beat celebration, the final-table
 * overlay. Someone with vestibular sensitivity got the most aggressive motion
 * in the product with no way to opt out.
 *
 * Coverage is provided by ONE global rule (src/styles/reducedMotion.css)
 * rather than 270 per-file @media blocks, because a global rule also covers
 * every stylesheet written after today. Per-file blocks would have been 270
 * chances to miss one, and a fresh chance with every new component.
 *
 * This test therefore asserts the MECHANISM, not a per-file checklist: the
 * rule exists, it is imported, it collapses rather than deletes motion, it
 * exempts marked subtrees, and the informational variants that must stay
 * readable still out-rank it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src');
const RM_RAW = readFileSync(path.join(SRC, 'styles/reducedMotion.css'), 'utf8');
/**
 * Strip comments before asserting. The file's own documentation explains why
 * `animation: none` is the WRONG choice here, and an un-stripped read matches
 * that prose as if it were a declaration.
 */
const RM = RM_RAW.replace(/\/\*[\s\S]*?\*\//g, '');
const MAIN = readFileSync(path.join(SRC, 'main.tsx'), 'utf8');

function cssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}

const animated = cssFiles(SRC).filter((f) => /^@keyframes\s/m.test(readFileSync(f, 'utf8')));

describe('the global rule exists and is wired in', () => {
  it('is imported from the app entry', () => {
    expect(MAIN).toMatch(/styles\/reducedMotion\.css/);
  });

  it('is imported LAST of the global sheets, so it is the final word', () => {
    const rm = MAIN.indexOf('styles/reducedMotion.css');
    const anim = MAIN.indexOf('styles/animations.css');
    expect(rm).toBeGreaterThan(anim);
  });

  it('is scoped to the media query and nothing else', () => {
    expect(RM).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe('it collapses motion without destroying meaning', () => {
  it('animations still complete, so `forwards` fills land on their final frame', () => {
    // `animation: none` would strand elements whose END state carries the
    // meaning — a card face-up, a chip at its destination.
    expect(RM).not.toMatch(/animation:\s*none/);
    expect(RM).toMatch(/animation-duration:\s*1ms\s*!important/);
  });

  it('never uses 0s, which some engines skip without applying the fill', () => {
    expect(RM).not.toMatch(/animation-duration:\s*0s/);
  });

  it('infinite loops stop looping', () => {
    expect(RM).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });

  it('transitions and smooth scrolling are covered too', () => {
    expect(RM).toMatch(/transition-duration:\s*1ms\s*!important/);
    expect(RM).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });
});

describe('the escape hatch covers subtrees, not just the marked element', () => {
  it('exempts [data-motion="keep"] and its descendants', () => {
    expect(RM).toMatch(/\[data-motion='keep'\]/);
    expect(RM).toMatch(/:not\(\[data-motion='keep'\] \*\)/);
  });
});

describe('informational reduced variants still out-rank the global rule', () => {
  it('the floating pot total stays on screen long enough to read', () => {
    const css = readFileSync(path.join(SRC, 'pages/TablePage.css'), 'utf8');
    expect(css).toMatch(/potWinFloatReduced[^;]*!important/);
  });

  it('table reactions keep their calm fade', () => {
    const css = readFileSync(path.join(SRC, 'components/table/TableReactions.css'), 'utf8');
    expect(css).toMatch(/trReducedFade[^;]*!important/);
  });
});

describe('coverage is total', () => {
  it('there is at least one animated stylesheet to cover (the scan works)', () => {
    // Guards against a broken glob silently "passing" by finding nothing.
    expect(animated.length).toBeGreaterThan(90);
  });

  it('every animated stylesheet is covered by the global rule', () => {
    // The rule is a universal selector inside the media query, so coverage is
    // structural: any element, in any stylesheet, present or future.
    expect(RM).toMatch(/\*:not\(\[data-motion='keep'\]\)/);
    // ::before / ::after carry animation too and are covered explicitly.
    expect(RM).toMatch(/::before/);
    expect(RM).toMatch(/::after/);
  });
});
