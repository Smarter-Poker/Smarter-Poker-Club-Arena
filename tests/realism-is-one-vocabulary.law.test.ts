import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * #SMARTERCASINOREALISM IS ONE VOCABULARY (Dan, 2026-09-05, BINDING)
 *
 * Dan: "improve every layer of the UI all of its pages, sub pages, buttons
 * frames, graphics and everything and anything else using #SmarterCasinoRealism."
 *
 * WHY THIS IS A LAW AND NOT A PREFERENCE
 *
 * Four surfaces had already been given the realism treatment before today -
 * the wallet, the cashier trade page, the hand-history panel, the replay - and
 * every one of them declared its own private copy of the palette. That is how
 * the Rewards Circuit came to light its live metrics #3aa8ff on the promotions
 * page and #00d4ff on the wallet: two pages in the same family, one tab apart,
 * glowing a different colour, each individually "correct".
 *
 * With 568 stylesheets under src/, the only version of this that survives is a
 * single vocabulary pages draw from. So the tokens live once, on :root in
 * club-engine.css - the sheet main.tsx actually loads - and this law pins that
 * they exist, that they are in the loaded sheet, and that the shared surfaces
 * consume them instead of restating hexes.
 *
 * WHAT THIS LAW DELIBERATELY DOES NOT CLAIM
 *
 * It does not claim every page is realism-styled. Measured on production
 * 2026-09-05 by walking ten live routes (592 buttons, 142 links rendered): the
 * global primitives .btn/.card/.badge render essentially never, because the app
 * is CSS Modules end to end. There is no single file that restyles every page,
 * and a test asserting otherwise would be pinning a fiction.
 */

const ROOT = resolve(__dirname, '..');
const ENGINE = readFileSync(resolve(ROOT, 'src/styles/club-engine.css'), 'utf8');
const MAIN = readFileSync(resolve(ROOT, 'src/main.tsx'), 'utf8');
const REWARDS = readFileSync(
  resolve(ROOT, 'src/components/rewards/RewardsSurfaceHeader.module.css'),
  'utf8'
);

/** The colours the whole system is allowed to be built from. */
const PALETTE = [
  '--realism-obsidian',
  '--realism-carbon',
  '--realism-panel',
  '--realism-gunmetal',
  '--realism-chrome',
  '--realism-cyan',
  '--realism-gold',
  '--realism-green',
];

describe('the realism vocabulary is defined once, in the sheet that is actually loaded', () => {
  it('main.tsx imports club-engine.css', () => {
    // design-system.css and design-tokens.css both define tokens and NEITHER is
    // imported by main.tsx. A token sheet nobody loads is a decoy, and this repo
    // already has two. The realism tokens do not become a third.
    expect(MAIN).toContain("import './styles/club-engine.css'");
  });

  it('club-engine.css defines every realism colour token', () => {
    for (const token of PALETTE) {
      expect(ENGINE, `${token} is missing`).toContain(`${token}:`);
    }
  });

  it('the three light effects a machined surface is built from are tokens too', () => {
    // A bevel or a cavity re-typed per page drifts exactly like a colour does.
    expect(ENGINE).toContain('--realism-bevel:');
    expect(ENGINE).toContain('--realism-cavity:');
    expect(ENGINE).toContain('--realism-lift:');
  });

  it('the block says plainly that it is not an app-wide restyle', () => {
    // The measurement that corrected the premise stays next to the code, so the
    // next agent does not re-derive "one edit changes every page" from grep.
    expect(ENGINE).toContain('WHAT THIS BLOCK DOES *NOT* DO');
    expect(ENGINE).toContain('CSS Modules end to end');
  });
});

describe('the 19-page Rewards Circuit header draws from the vocabulary', () => {
  it('is tagged, so realism coverage can be counted honestly', () => {
    expect(REWARDS).toContain('#SMARTERCASINOREALISM');
  });

  it('lights its live metrics from the shared cyan, not a private hex', () => {
    // The exact drift this closed: #3aa8ff here against #00d4ff on the wallet.
    expect(REWARDS).toContain('var(--realism-cyan');
    expect(REWARDS).not.toMatch(/background:\s*#3aa8ff/);
    expect(REWARDS).not.toMatch(/color:\s*#6ebcff/);
  });

  it('carries the machined frame: a lit top edge over a cavity', () => {
    expect(REWARDS).toContain('var(--realism-bevel');
    expect(REWARDS).toContain('var(--realism-cavity');
  });

  it('every token it reads carries the previous literal as a fallback', () => {
    // The header must survive being rendered without the global sheet - a
    // storybook, a test harness, a lazily loaded island. A bare var() with no
    // fallback would render it transparent and borderless there.
    const vars = REWARDS.match(/var\(--realism-[a-z-]+[^)]*\)/g) ?? [];
    expect(vars.length).toBeGreaterThan(8);
    for (const v of vars) {
      expect(v, `${v} has no fallback`).toContain(',');
    }
  });
});

describe('the realism layer obeys the laws that outrank it', () => {
  const BLOCK = ENGINE.slice(ENGINE.indexOf('#SMARTERCASINOREALISM'));

  it('adds no hover rule (no-hover-effects.law)', () => {
    // Prose naming the law is fine; a SELECTOR is not.
    expect(BLOCK).not.toMatch(/^[^\n]*[.:#[][^\n]*:hover[^\n]*\{/m);
    expect(REWARDS).not.toMatch(/^[^\n]*[.:#[][^\n]*:hover[^\n]*\{/m);
  });

  it('puts interaction feedback in :active, which fires on touch', () => {
    expect(BLOCK).toContain('.btn:active:not(:disabled)');
  });

  it('collapses motion under reduced motion but keeps the material', () => {
    expect(BLOCK).toContain('@media (prefers-reduced-motion: reduce)');
    // The shimmer stops; what it falls back to is still a realism token, so a
    // reduced-motion player sees the same object, held still.
    expect(BLOCK).toContain('background: var(--realism-panel)');
  });

  it('never repaints the body, which Dan set to solid black', () => {
    expect(BLOCK).not.toMatch(/^\s*body\s*\{/m);
  });

  it('contains NO universal selector, because one of them broke ten approved looks', () => {
    /*
     * The most expensive thing learned building this layer, so it is a pin
     * rather than a paragraph.
     *
     * It shipped with `* { scrollbar-color }`, four `*::-webkit-scrollbar*`
     * rules and a `:focus-visible` outline override - "chrome no module owns,
     * so styling it globally is free". CSS Beat E2E disagreed: "all ten
     * coordinated looks retain their mobile, tablet, light, dark, and
     * final-table visuals" went red, and that spec compares THIRTY committed
     * screenshots at maxDiffPixelRatio 0.02. ThemeSettingsModal.css carries 32
     * overflow declarations, so a universal scrollbar width changed layout
     * geometry inside every one of its scroll containers.
     *
     * Authorship was not a guess: main was green and the FIRST commit of this
     * layer was red, carrying only this sheet, one module header and a CI
     * script. By elimination the studio uses none of .card/.btn/.badge/
     * .skeleton - its markup is BEM (`theme-asset__tier-badge`,
     * `studio-game-preview__*`) - so the universal selectors were the only
     * rules here that could reach it.
     *
     * A local A/B could NOT reproduce it, which is worth knowing too: macOS
     * draws overlay scrollbars that take no layout space, so the spec passes
     * both ways on a Mac and only Linux CI shows the shift. Reasoning about
     * blast radius is not a substitute for the pixel baseline.
     *
     * Realism is OPT-IN. A page asks for it by reading --realism-*.
     */
    const universal = BLOCK.split('\n').filter((line) => /^\s*\*(::?[a-z-]+)*\s*[,{]/.test(line));
    expect(
      universal,
      `universal selector(s) in the realism layer: ${universal.join(' | ')}`
    ).toEqual([]);
    expect(BLOCK).not.toMatch(/^\s*:focus-visible\s*\{/m);
  });
});
